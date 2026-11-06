import { randomUUID } from 'node:crypto';
import type {
  CollectionReference,
  DocumentReference,
  Firestore,
  Transaction,
} from '@google-cloud/firestore';
import {
  DEFAULT_ACCESS_TOKEN_TTL_MS,
  MAX_RETIRED_REFRESH_FINGERPRINTS,
  REFRESH_RETRY_WINDOW_MS,
  refreshFingerprint,
  type BaseStoredToken,
  type RefreshLookupResult,
  type RefreshRotationResult,
  type StoredRefreshFamily,
  type StoredRefreshRecord,
  type TokenLedger,
} from './ledger.js';
import type { UpstreamCompletionReceipt } from './bound-fenced-runtime.js';
import { StoreUnavailableError, CutoverFenceError, kitCodeOf } from './errors.js';
import { assertGrantWritable, nextGrantVersion, type StoredUpstreamRecord } from './upstream-grant.js';
import { stripUndefined } from './strip-undefined.js';
import {
  type CutoverFenceConfig,
  checkMutationGuardInTransaction,
  requireFenceIdentityKey,
  startMonotonicTimer,
  type MonotonicTimer,
  getCutoverFenceRecord,
  type GuardMutationResult,
  type LegacyOperationContext,
} from './cutover-fence.js';
export function docId(raw: string): string {
  return raw.replace(/[\/.]/g, '_');
}

export interface FirestoreTokenLedgerOptions<T extends BaseStoredToken> {
  db: Firestore;
  collection: string;
  refreshCollection?: string;
  familyCollection?: string;
  linkedFamilyCollections?: string[];
  accessDocExtras?: (token: T) => Record<string, unknown>;
  mapCommittedGrant?: (token: T, grant: unknown) => T;
  legacy?: {
    pointerDocs?: boolean;
    embeddedRefreshQuery?: boolean;
    toToken?: (raw: Record<string, unknown>) => T;
    toUpstream?: (raw: Record<string, unknown>) => Record<string, unknown> | undefined;
    upstreamCollection?: string;
  };
  now?: () => number;
  fence?: CutoverFenceConfig;
}

type LegacyRefreshPointer = { accessToken: string };

export class FirestoreTokenLedger<T extends BaseStoredToken> implements TokenLedger<T> {
  private readonly db: Firestore;
  private readonly collection: string;
  private readonly refreshCollection: string;
  private readonly familyCollection: string;
  private readonly linkedFamilyCollections: string[];
  private readonly accessDocExtras?: (token: T) => Record<string, unknown>;
  private readonly mapCommittedGrant?: (token: T, grant: unknown) => T;
  private readonly legacy?: FirestoreTokenLedgerOptions<T>['legacy'];
  private readonly nowProvider: () => number;
  private readonly fence?: CutoverFenceConfig;

  constructor(opts: FirestoreTokenLedgerOptions<T>) {
    this.db = opts.db;
    this.collection = opts.collection;
    this.refreshCollection = opts.refreshCollection ?? `${this.collection}_refresh`;
    this.familyCollection = opts.familyCollection ?? `${this.collection}_refresh_families`;
    this.linkedFamilyCollections = opts.linkedFamilyCollections ?? [];
    this.accessDocExtras = opts.accessDocExtras;
    this.mapCommittedGrant = opts.mapCommittedGrant;
    this.legacy = opts.legacy;
    this.nowProvider = opts.now ?? Date.now;
    this.fence = opts.fence;
  }

  private wrapError(err: unknown): never {
    if (kitCodeOf(err)) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new StoreUnavailableError(message, { cause: err });
  }

  private accessCol(): CollectionReference {
    return this.db.collection(this.collection);
  }

  private refreshCol(): CollectionReference {
    return this.db.collection(this.refreshCollection);
  }

  private familyCol(): CollectionReference {
    return this.db.collection(this.familyCollection);
  }
  private async readIssueState(transaction: Transaction, token: T, familyId: string) {
    const access = await transaction.get(this.accessCol().doc(docId(token.accessToken)));
    const refresh = await transaction.get(this.refreshCol().doc(docId(token.refreshToken)));
    const families = new Set<string>([familyId]);
    const accessFamily = access.data()?.refreshFamilyId;
    const refreshData = refresh.data();
    if (typeof accessFamily === 'string') families.add(accessFamily);
    if (typeof refreshData?.familyId === 'string') families.add(refreshData.familyId);
    if (typeof refreshData?.accessToken === 'string') {
      const pointer = await transaction.get(this.accessCol().doc(docId(refreshData.accessToken)));
      const pointerFamily = pointer.data()?.refreshFamilyId;
      if (typeof pointerFamily === 'string') families.add(pointerFamily);
    }
    const collections = new Set(this.linkedFamilyCollections);
    if (this.legacy?.upstreamCollection) collections.add(this.legacy.upstreamCollection);
    if (this.fence?.enforce) collections.add(`${this.fence.namespace}_tokens_upstream`);
    for (const id of families) {
      for (const collection of collections) {
        const held = await transaction.get(this.db.collection(collection).doc(docId(id)));
        assertGrantWritable(held.data() as StoredUpstreamRecord<unknown> | undefined);
      }
    }
    const family = await transaction.get(this.familyCol().doc(docId(familyId)));
    const generation = family.data()?.generation ?? 1;
    if (!Number.isSafeInteger(generation) || generation < 1) throw new CutoverFenceError('Family generation is invalid');
    const upstream = this.legacy?.upstreamCollection
      ? (await transaction.get(this.db.collection(this.legacy.upstreamCollection).doc(docId(familyId)))).data() as StoredUpstreamRecord<unknown> | undefined
      : undefined;
    return { generation, upstream };
  }

  async issue(
    token: T,
    options?: { operation?: LegacyOperationContext; completeOperation?: boolean },
  ): Promise<T> {
    try {
      const familyId = token.refreshFamilyId ?? randomUUID();
      const stored: T = { ...token, refreshFamilyId: familyId };
      const extras = this.accessDocExtras ? this.accessDocExtras(stored) : {};
      const accessPayload = stripUndefined({ ...stored, ...extras });

      const op = options?.operation;
      if (this.fence?.enforce && !op) {
        throw new CutoverFenceError(
          `Durable operation context is required for fence-enforced issueInitial in namespace ${this.fence.namespace}`,
        );
      }
      const run = async () => {
        let onCommitCallback: (() => void) | undefined;
        await this.db.runTransaction(async (transaction: Transaction) => {
          const timer = startMonotonicTimer();
          const guard = this.fence?.enforce && op
            ? await checkMutationGuardInTransaction(transaction, {
              db: this.db, namespace: this.fence.namespace, operation: op,
              identityKey: requireFenceIdentityKey(this.fence), completeOperation: options?.completeOperation,
              now: this.nowProvider, timer,
            })
            : undefined;
          const { generation, upstream } = await this.readIssueState(transaction, stored, familyId);
          const upstreamData = this.legacy?.upstreamCollection
            ? this.legacy.toUpstream?.(accessPayload)
            : undefined;
          const grantVersion = upstreamData
            ? nextGrantVersion(upstream, upstreamData.grant)
            : upstream?.grantVersion ?? upstream?.version ?? 1;
          if (!Number.isSafeInteger(grantVersion) || grantVersion < 1) throw new CutoverFenceError('Upstream grant version is invalid');
          guard?.assertPreWrite();
          guard?.bufferCompletion(this.nowProvider());
          onCommitCallback = guard?.onCommit;
          transaction.set(this.accessCol().doc(docId(stored.accessToken)), accessPayload);
          transaction.set(this.refreshCol().doc(docId(stored.refreshToken)), stripUndefined({ status: 'active', familyId, token: stored }));
          transaction.set(this.familyCol().doc(docId(familyId)), stripUndefined({
            id: familyId, generation, currentAccessToken: stored.accessToken, currentRefreshToken: stored.refreshToken,
            retiredRefreshFingerprints: [], updatedAt: this.nowProvider(),
          }));
          if (upstreamData && this.legacy?.upstreamCollection) {
            transaction.set(this.db.collection(this.legacy.upstreamCollection).doc(docId(familyId)), stripUndefined({
              ...upstreamData, grantVersion, familyGeneration: generation, updatedAt: this.nowProvider(),
            }), { merge: true });
          }
          guard?.assertPreReturn();
        });
        onCommitCallback?.();
      };
      if (op?.trackWriter) await op.trackWriter(run);
      else await run();
      return stored;
    } catch (err) {
      this.wrapError(err);
    }
  }

  async getByAccessToken(
    accessToken: string,
    options?: { operation?: LegacyOperationContext },
  ): Promise<T | undefined> {
    try {
      if (this.fence?.enforce) {
        if (!options?.operation) {
          throw new CutoverFenceError(
            `Durable operation context is required for fence-enforced getByAccessToken in namespace ${this.fence.namespace}`,
          );
        }
        const operation = options.operation;

        return await this.db.runTransaction(async (transaction: Transaction) => {
          const timer = startMonotonicTimer();
          await checkMutationGuardInTransaction(transaction, {
            db: this.db, namespace: this.fence!.namespace, operation,
            identityKey: requireFenceIdentityKey(this.fence),
            completeOperation: false, timer,
          });

          const snap = await transaction.get(this.accessCol().doc(docId(accessToken)));
          if (!snap.exists) {
            timer.assertUnderDeadline('getByAccessToken preReturn missing');
            return undefined;
          }
          const data = snap.data() as Record<string, unknown>;

          if (!data.refreshFamilyId && (this.legacy?.embeddedRefreshQuery || this.legacy?.pointerDocs)) {
            return await this.adoptLegacyEmbeddedDocInTransaction(transaction, data, { operation: options.operation, timer });
          }
          timer.assertUnderDeadline('getByAccessToken preReturn active');
          return (this.legacy?.toToken ? this.legacy.toToken(data) : data) as unknown as T;
        });
      }
      const snap = await this.accessCol().doc(docId(accessToken)).get();
      if (!snap.exists) return undefined;
      const data = snap.data() as Record<string, unknown>;

      if (!data.refreshFamilyId && (this.legacy?.embeddedRefreshQuery || this.legacy?.pointerDocs)) {
        return await this.adoptLegacyEmbeddedDoc(data);
      }
      return (this.legacy?.toToken ? this.legacy.toToken(data) : data) as unknown as T;
    } catch (err) {
      this.wrapError(err);
    }
  }

  async getByRefreshToken(
    refreshToken: string,
    options?: { operation?: LegacyOperationContext },
  ): Promise<T | undefined> {
    try {
      const res = await this.lookupRefresh(refreshToken, undefined, undefined, options);
      if (res.status === 'active' || res.status === 'retry') {
        return res.token;
      }
      return undefined;
    } catch (err) {
      this.wrapError(err);
    }
  }

  async lookupRefresh(
    refreshToken: string,
    expectedClientId?: string,
    now: number = this.nowProvider(),
    options?: { operation?: LegacyOperationContext },
  ): Promise<RefreshLookupResult<T>> {
    try {
      if (this.fence?.enforce) {
        if (!options?.operation) {
          throw new CutoverFenceError(
            `Durable operation context is required for consumed replay revocation during lookupRefresh in namespace ${this.fence.namespace}`,
          );
        }
        const operation = options.operation;
        let commitReplay: (() => void) | undefined;
        const lookupResult = await this.db.runTransaction(async (transaction: Transaction): Promise<RefreshLookupResult<T>> => {
          const timer = startMonotonicTimer();
          await checkMutationGuardInTransaction(transaction, {
            db: this.db, namespace: this.fence!.namespace, operation,
            identityKey: requireFenceIdentityKey(this.fence),
            completeOperation: false, timer,
          });
          const refreshRef = this.refreshCol().doc(docId(refreshToken));
          const snap = await transaction.get(refreshRef);

          if (!snap.exists) {
            if (this.legacy?.embeddedRefreshQuery) {
              const legacyMatch = await transaction.get(
                this.accessCol()
                  .where('refreshToken', '==', refreshToken)
                  .limit(1),
              );
              if (!legacyMatch.empty) {
                const rawDoc = legacyMatch.docs[0]!.data() as Record<string, unknown>;
                if (!rawDoc.refreshFamilyId) {
                  const adopted = await this.adoptLegacyEmbeddedDocInTransaction(
                    transaction,
                    rawDoc,
                    { operation: options.operation, timer },
                  );
                  if (adopted) {
                    if (expectedClientId && adopted.clientId !== expectedClientId) {
                      timer.assertUnderDeadline('lookupRefresh preReturn clientId mismatch');
                      return { status: 'missing' as const };
                    }
                    timer.assertUnderDeadline('lookupRefresh preReturn active');
                    return {
                      status: 'active' as const,
                      token: adopted,
                      familyId: adopted.refreshFamilyId!,
                    };
                  }
                }
              }
            }
            const fingerprint = refreshFingerprint(refreshToken);
            const retiredMatch = await transaction.get(
              this.familyCol()
                .where('retiredRefreshFingerprints', 'array-contains', fingerprint)
                .limit(1),
            );
            if (!retiredMatch.empty) {
              if (!options?.operation) {
                throw new CutoverFenceError(
                  `Durable operation context is required for retired replay revocation during lookupRefresh in namespace ${this.fence!.namespace}`,
                );
              }
              const retiredGuard = await checkMutationGuardInTransaction(transaction, {
                db: this.db,
                namespace: this.fence!.namespace,
                operation: options.operation,
                identityKey: requireFenceIdentityKey(this.fence),
                completeOperation: true,
                now: this.nowProvider,
                timer,
              });
              const familyDoc = retiredMatch.docs[0]!;
              const family = familyDoc.data() as StoredRefreshFamily;
              retiredGuard.assertPreWrite();
              await this.assertFamilyHasNoLiveClaim(transaction, familyDoc.ref);
              retiredGuard.bufferCompletion(now);
              commitReplay = retiredGuard.onCommit;
              this.deleteFamilyInTransaction(transaction, familyDoc.ref, family);
              retiredGuard.assertPreReturn();
              return { status: 'replay', familyId: familyDoc.id };
            }
            timer.assertUnderDeadline('lookupRefresh preReturn missing');
            return { status: 'missing' as const };
          }
          const raw = snap.data() as StoredRefreshRecord<T> | LegacyRefreshPointer;

          if (!('status' in raw)) {
            const legacyAccessSnap = await transaction.get(
              this.accessCol().doc(docId(raw.accessToken)),
            );
            if (!legacyAccessSnap.exists) {
              timer.assertUnderDeadline('lookupRefresh preReturn missing legacyAccess');
              return { status: 'missing' };
            }
            const rawAccess = legacyAccessSnap.data() as Record<string, unknown>;
            const adopted = await this.adoptLegacyEmbeddedDocInTransaction(
              transaction,
              rawAccess,
              { operation: options?.operation, timer },
            );
            if (!adopted) {
              timer.assertUnderDeadline('lookupRefresh preReturn missing adopted');
              return { status: 'missing' };
            }
            if (expectedClientId && adopted.clientId !== expectedClientId) {
              timer.assertUnderDeadline('lookupRefresh preReturn clientId mismatch');
              return { status: 'missing' };
            }
            timer.assertUnderDeadline('lookupRefresh preReturn active adopted');
            return { status: 'active', token: adopted, familyId: adopted.refreshFamilyId! };
          }

          const oldRecord = raw as StoredRefreshRecord<T>;
          if (expectedClientId && oldRecord.token.clientId !== expectedClientId) {
            timer.assertUnderDeadline('lookupRefresh preReturn expectedClientId mismatch');
            return { status: 'missing' };
          }

          const familyRef = this.familyCol().doc(docId(oldRecord.familyId));
          const familySnap = await transaction.get(familyRef);
          const family = familySnap.exists
            ? (familySnap.data() as StoredRefreshFamily)
            : undefined;

          if (oldRecord.status === 'consumed') {
            const successorSnap = oldRecord.successorRefreshToken
              ? await transaction.get(
                this.refreshCol().doc(docId(oldRecord.successorRefreshToken)),
              )
              : undefined;
            const withinRetryWindow =
              oldRecord.consumedAt !== undefined && now - oldRecord.consumedAt <= REFRESH_RETRY_WINDOW_MS;

            if (
              withinRetryWindow &&
              family?.previousRefreshToken === refreshToken &&
              successorSnap?.exists
            ) {
              const successorRecord = successorSnap.data() as StoredRefreshRecord<T>;
              if (
                successorRecord.status === 'active' &&
                (!expectedClientId || successorRecord.token.clientId === expectedClientId)
              ) {
                timer.assertUnderDeadline('lookupRefresh preReturn retry');
                return {
                  status: 'retry' as const,
                  token: successorRecord.token,
                  familyId: raw.familyId,
                };
              }
            }
            if (!options?.operation) {
              throw new CutoverFenceError(
                `Durable operation context is required for consumed replay revocation during lookupRefresh in namespace ${this.fence!.namespace}`,
              );
            }
            const replayGuard = await checkMutationGuardInTransaction(transaction, {
              db: this.db,
              namespace: this.fence!.namespace,
              operation: options.operation,
              identityKey: requireFenceIdentityKey(this.fence),
              completeOperation: true,
              now: this.nowProvider,
              timer,
            });
            if (family) {
              replayGuard.assertPreWrite();
              await this.assertFamilyHasNoLiveClaim(transaction, familyRef);
              replayGuard.bufferCompletion(now);
              commitReplay = replayGuard.onCommit;
              this.deleteFamilyInTransaction(transaction, familyRef, family);
              replayGuard.assertPreReturn();
            }
            timer.assertUnderDeadline('lookupRefresh preReturn replay');
            return { status: 'replay' as const, familyId: raw.familyId };
          }

          timer.assertUnderDeadline('lookupRefresh preReturn active');
          return { status: 'active' as const, token: raw.token, familyId: raw.familyId };
        });
        if (commitReplay) {
          commitReplay();
        }
        return lookupResult;
      }

      const refreshRef = this.refreshCol().doc(docId(refreshToken));
      const snap = await refreshRef.get();

      if (!snap.exists) {
        if (this.legacy?.embeddedRefreshQuery) {
          const legacyMatch = await this.accessCol()
            .where('refreshToken', '==', refreshToken)
            .limit(1)
            .get();
          if (!legacyMatch.empty) {
            const rawDoc = legacyMatch.docs[0]!.data() as Record<string, unknown>;
            if (!rawDoc.refreshFamilyId) {
              const adopted = await this.adoptLegacyEmbeddedDoc(rawDoc);
              if (adopted) {
                if (expectedClientId && adopted.clientId !== expectedClientId) {
                  return { status: 'missing' };
                }
                return {
                  status: 'active',
                  token: adopted,
                  familyId: adopted.refreshFamilyId!,
                };
              }
            }
          }
        }
        const retiredMatch = await this.findFamilyByRetiredFingerprint(refreshToken);
        if (retiredMatch) {
          await this.revokeFamily(retiredMatch, options);
          return { status: 'replay', familyId: retiredMatch };
        }
        return { status: 'missing' };
      }

      const raw = snap.data() as StoredRefreshRecord<T> | LegacyRefreshPointer;

      if (!('status' in raw)) {
        const legacyAccessSnap = await this.accessCol().doc(docId(raw.accessToken)).get();
        if (!legacyAccessSnap.exists) return { status: 'missing' };
        const rawAccess = legacyAccessSnap.data() as Record<string, unknown>;
        const adopted = await this.adoptLegacyEmbeddedDoc(rawAccess);
        if (!adopted) return { status: 'missing' };
        if (expectedClientId && adopted.clientId !== expectedClientId) {
          return { status: 'missing' };
        }
        return { status: 'active', token: adopted, familyId: adopted.refreshFamilyId! };
      }

      if (expectedClientId && raw.token.clientId !== expectedClientId) {
        return { status: 'missing' };
      }

      const familySnap = await this.familyCol().doc(docId(raw.familyId)).get();
      const family = familySnap.exists
        ? (familySnap.data() as StoredRefreshFamily)
        : undefined;

      if (raw.status === 'consumed') {
        const successorSnap = raw.successorRefreshToken
          ? await this.refreshCol().doc(docId(raw.successorRefreshToken)).get()
          : undefined;
        const withinRetryWindow =
          raw.consumedAt !== undefined && now - raw.consumedAt <= REFRESH_RETRY_WINDOW_MS;

        if (
          withinRetryWindow &&
          family?.previousRefreshToken === refreshToken &&
          successorSnap?.exists
        ) {
          const successorRecord = successorSnap.data() as StoredRefreshRecord<T>;
          if (
            successorRecord.status === 'active' &&
            (!expectedClientId || successorRecord.token.clientId === expectedClientId)
          ) {
            return {
              status: 'retry',
              token: successorRecord.token,
              familyId: raw.familyId,
            };
          }
        }

        await this.revokeFamily(raw.familyId, options);
        return { status: 'replay', familyId: raw.familyId };
      }

      return { status: 'active', token: raw.token, familyId: raw.familyId };
    } catch (err) {
      this.wrapError(err);
    }
  }

  async rotate(
    oldRefreshToken: string,
    replacement: T,
    expectedClientId: string,
    now: number = this.nowProvider(),
    options?: { operation?: LegacyOperationContext; completeOperation?: boolean; upstreamCompletion?: UpstreamCompletionReceipt | null },
  ): Promise<RefreshRotationResult<T>> {
    try {
      if (options?.upstreamCompletion != null) {
        throw new CutoverFenceError('Upstream completion requires the paired bound runtime');
      }
      const oldRef = this.refreshCol().doc(docId(oldRefreshToken));

      let onCommitCallback: (() => void) | undefined;
      const result = await this.db.runTransaction(async (transaction: Transaction) => {
        const timer = startMonotonicTimer();
        let guard: GuardMutationResult | undefined;
        if (this.fence?.enforce) {
          if (!options?.operation) {
            throw new CutoverFenceError(
              `Durable operation context is required for fence-enforced rotate in namespace ${this.fence.namespace}`,
            );
          }
          const op = options.operation;
          guard = await checkMutationGuardInTransaction(transaction, {
            db: this.db,
            namespace: this.fence.namespace,
            operation: op,
            identityKey: requireFenceIdentityKey(this.fence),
            completeOperation: options?.completeOperation,
            now: this.nowProvider,
            timer,
          });
          onCommitCallback = guard.onCommit;
        }
        let oldSnap = await transaction.get(oldRef);
        let adoptedDocToWrite:
          | {
            accessRef: DocumentReference;
            accessPayload: Record<string, unknown>;
            refreshRef: DocumentReference;
            refreshPayload: Record<string, unknown>;
            familyRef: DocumentReference;
            familyPayload: Record<string, unknown>;
            upstreamRef?: DocumentReference;
            upstreamPayload?: Record<string, unknown>;
          }
          | undefined;

        if (!oldSnap.exists && this.legacy?.embeddedRefreshQuery) {
          const legacyMatch = await transaction.get(
            this.accessCol()
              .where('refreshToken', '==', oldRefreshToken)
              .limit(1),
          );
          if (!legacyMatch.empty) {
            const rawAccess = legacyMatch.docs[0]!.data() as Record<string, unknown>;
            if (!rawAccess.refreshFamilyId) {
              const tokenObj = (this.legacy?.toToken ? this.legacy.toToken(rawAccess) : rawAccess) as unknown as T;
              if (tokenObj.accessToken && tokenObj.refreshToken) {
                const familyId = randomUUID();
                const migrated: T = { ...tokenObj, refreshFamilyId: familyId };
                const extras = this.accessDocExtras ? this.accessDocExtras(migrated) : {};
                const accessPayload = stripUndefined({ ...migrated, ...extras });
                const refreshPayload = stripUndefined({
                  status: 'active',
                  familyId,
                  token: migrated,
                });
                const familyPayload = stripUndefined({
                  id: familyId,
                  currentAccessToken: migrated.accessToken,
                  currentRefreshToken: migrated.refreshToken,
                  retiredRefreshFingerprints: [],
                  updatedAt: now,
                });
                let upstreamPayload: Record<string, unknown> | undefined;
                let upstreamRef: DocumentReference | undefined;
                if (this.legacy?.toUpstream && this.legacy?.upstreamCollection) {
                  const upstreamData = this.legacy.toUpstream(rawAccess);
                  if (upstreamData) {
                    upstreamRef = this.db.collection(this.legacy.upstreamCollection).doc(docId(familyId));
                    upstreamPayload = stripUndefined({
                      ...upstreamData,
                      updatedAt: now,
                    });
                  }
                }
                adoptedDocToWrite = {
                  accessRef: this.accessCol().doc(docId(migrated.accessToken)),
                  accessPayload,
                  refreshRef: this.refreshCol().doc(docId(migrated.refreshToken)),
                  refreshPayload,
                  familyRef: this.familyCol().doc(docId(familyId)),
                  familyPayload,
                  upstreamRef,
                  upstreamPayload,
                };
                oldSnap = {
                  exists: true,
                  data: () => refreshPayload,
                } as unknown as typeof oldSnap;
              }
            }
          }
        }

        if (!oldSnap.exists) {
          const fingerprint = refreshFingerprint(oldRefreshToken);
          const retiredMatches = await transaction.get(
            this.familyCol()
              .where('retiredRefreshFingerprints', 'array-contains', fingerprint)
              .limit(1),
          );
          if (!retiredMatches.empty) {
            const familyDoc = retiredMatches.docs[0]!;
            const family = familyDoc.data() as StoredRefreshFamily;
            guard?.assertPreWrite();
            await this.assertFamilyHasNoLiveClaim(transaction, familyDoc.ref);
            guard?.bufferCompletion(now);
            this.deleteFamilyInTransaction(transaction, familyDoc.ref, family);
            guard?.assertPreReturn();
            return { status: 'replay' } as const;
          }
          guard?.assertPreWrite();
          guard?.bufferCompletion(now);
          guard?.assertPreReturn();
          return { status: 'missing' } as const;
        }

        let raw = oldSnap.data() as StoredRefreshRecord<T> | LegacyRefreshPointer;
        if (!('status' in raw)) {
          const legacyAccessSnap = await transaction.get(
            this.accessCol().doc(docId(raw.accessToken)),
          );
          if (!legacyAccessSnap.exists) {
            guard?.assertPreWrite();
            guard?.bufferCompletion(now);
            guard?.assertPreReturn();
            return { status: 'missing' } as const;
          }
          const rawAccess = legacyAccessSnap.data() as Record<string, unknown>;
          const tokenObj = (this.legacy?.toToken ? this.legacy.toToken(rawAccess) : rawAccess) as unknown as T;
          if (!tokenObj.accessToken || !tokenObj.refreshToken) {
            guard?.assertPreWrite();
            guard?.bufferCompletion(now);
            guard?.assertPreReturn();
            return { status: 'missing' } as const;
          }
          const familyId = typeof rawAccess.refreshFamilyId === 'string' ? rawAccess.refreshFamilyId : randomUUID();
          const migrated: T = { ...tokenObj, refreshFamilyId: familyId };
          const extras = this.accessDocExtras ? this.accessDocExtras(migrated) : {};
          const accessPayload = stripUndefined({ ...migrated, ...extras });
          const refreshPayload = stripUndefined({
            status: 'active',
            familyId,
            token: migrated,
          });
          const familyPayload = stripUndefined({
            id: familyId,
            currentAccessToken: migrated.accessToken,
            currentRefreshToken: migrated.refreshToken,
            retiredRefreshFingerprints: [],
            updatedAt: now,
          });
          let upstreamPayload: Record<string, unknown> | undefined;
          let upstreamRef: DocumentReference | undefined;
          if (this.legacy?.toUpstream && this.legacy?.upstreamCollection) {
            const upstreamData = this.legacy.toUpstream(rawAccess);
            if (upstreamData) {
              upstreamRef = this.db.collection(this.legacy.upstreamCollection).doc(docId(familyId));
              upstreamPayload = stripUndefined({
                ...upstreamData,
                updatedAt: now,
              });
            }
          }
          adoptedDocToWrite = {
            accessRef: this.accessCol().doc(docId(migrated.accessToken)),
            accessPayload,
            refreshRef: this.refreshCol().doc(docId(migrated.refreshToken)),
            refreshPayload,
            familyRef: this.familyCol().doc(docId(familyId)),
            familyPayload,
            upstreamRef,
            upstreamPayload,
          };
          raw = refreshPayload as StoredRefreshRecord<T>;
        }

        const oldRecord = raw as StoredRefreshRecord<T>;
        if (oldRecord.token.clientId !== expectedClientId) {
          guard?.assertPreWrite();
          guard?.bufferCompletion(now);
          guard?.assertPreReturn();
          return { status: 'missing' } as const;
        }

        const familyRef = this.familyCol().doc(docId(oldRecord.familyId));
        const familySnap = await transaction.get(familyRef);
        const family: StoredRefreshFamily = familySnap.exists
          ? {
            ...(familySnap.data() as StoredRefreshFamily),
            retiredRefreshFingerprints:
              (familySnap.data() as StoredRefreshFamily).retiredRefreshFingerprints ?? [],
          }
          : {
            id: oldRecord.familyId,
            currentAccessToken: oldRecord.token.accessToken,
            currentRefreshToken: oldRefreshToken,
            retiredRefreshFingerprints: [],
          };

        if (oldRecord.status === 'consumed') {
          const successor = oldRecord.successorRefreshToken
            ? await transaction.get(
              this.refreshCol().doc(docId(oldRecord.successorRefreshToken)),
            )
            : undefined;

          const withinRetryWindow =
            oldRecord.consumedAt !== undefined && now - oldRecord.consumedAt <= REFRESH_RETRY_WINDOW_MS;

          if (
            withinRetryWindow &&
            family.previousRefreshToken === oldRefreshToken &&
            successor?.exists
          ) {
            const successorRecord = successor.data() as StoredRefreshRecord<T>;
            if (
              successorRecord.status === 'active' &&
              successorRecord.token.clientId === expectedClientId
            ) {
              guard?.assertPreWrite();
              guard?.bufferCompletion(now);
              guard?.assertPreReturn();
              return { status: 'retry', token: successorRecord.token } as const;
            }
          }

          guard?.assertPreWrite();
          await this.assertFamilyHasNoLiveClaim(transaction, familyRef);
          guard?.bufferCompletion(now);
          this.deleteFamilyInTransaction(transaction, familyRef, family);
          guard?.assertPreReturn();
          return { status: 'replay' } as const;
        }

        // Active refresh token: perform rotation
        await this.assertFamilyHasNoLiveClaim(transaction, familyRef);
        let effectiveReplacement = replacement;
        if (this.mapCommittedGrant) {
          const upstreamRef = this.db.collection(`${this.collection}_upstream`).doc(docId(oldRecord.familyId));
          const upstream = await transaction.get(upstreamRef);
          const grant = upstream.exists
            ? upstream.data()?.grant
            : adoptedDocToWrite?.upstreamRef?.path === upstreamRef.path
              ? adoptedDocToWrite.upstreamPayload?.grant
              : undefined;
          if (!grant) throw new CutoverFenceError('Committed upstream grant is missing');
          effectiveReplacement = this.mapCommittedGrant({ ...replacement }, grant);
          if (effectiveReplacement.clientId !== replacement.clientId ||
              effectiveReplacement.accessToken !== replacement.accessToken ||
              effectiveReplacement.refreshToken !== replacement.refreshToken) {
            throw new CutoverFenceError('Grant mapping changed token identity');
          }
        }
        guard?.assertPreWrite();
        guard?.bufferCompletion(now);
        if (adoptedDocToWrite) {
          transaction.set(adoptedDocToWrite.accessRef, adoptedDocToWrite.accessPayload);
          transaction.set(adoptedDocToWrite.refreshRef, adoptedDocToWrite.refreshPayload);
          transaction.set(adoptedDocToWrite.familyRef, adoptedDocToWrite.familyPayload);
          if (adoptedDocToWrite.upstreamRef && adoptedDocToWrite.upstreamPayload) {
            transaction.set(adoptedDocToWrite.upstreamRef, adoptedDocToWrite.upstreamPayload);
          }
        }

        const retired = [...family.retiredRefreshFingerprints];
        if (family.previousRefreshToken) {
          retired.push(refreshFingerprint(family.previousRefreshToken));
          transaction.delete(this.refreshCol().doc(docId(family.previousRefreshToken)));
        }
        const boundedRetired = [
          ...new Set(retired.slice(-MAX_RETIRED_REFRESH_FINGERPRINTS)),
        ];

        if (family.previousAccessToken) {
          transaction.delete(this.accessCol().doc(docId(family.previousAccessToken)));
        }
        transaction.delete(this.accessCol().doc(docId(oldRecord.token.accessToken)));

        const stored: T = { ...effectiveReplacement, refreshFamilyId: oldRecord.familyId };
        const extras = this.accessDocExtras ? this.accessDocExtras(stored) : {};
        const accessPayload = stripUndefined({ ...stored, ...extras });

        transaction.set(oldRef, stripUndefined({
          ...oldRecord,
          status: 'consumed',
          successorRefreshToken: stored.refreshToken,
          consumedAt: now,
        }));
        transaction.set(this.accessCol().doc(docId(stored.accessToken)), accessPayload);
        transaction.set(this.refreshCol().doc(docId(stored.refreshToken)), stripUndefined({
          status: 'active',
          familyId: oldRecord.familyId,
          token: stored,
        }));
        const nextGeneration = (typeof family.generation === 'number' ? family.generation : 1) + 1;
        transaction.set(familyRef, stripUndefined({
          id: oldRecord.familyId,
          generation: nextGeneration,
          currentAccessToken: stored.accessToken,
          currentRefreshToken: stored.refreshToken,
          previousAccessToken: oldRecord.token.accessToken,
          previousRefreshToken: oldRefreshToken,
          retiredRefreshFingerprints: boundedRetired,
          updatedAt: now,
        }));

        guard?.assertPreReturn();
        return { status: 'claimed', token: stored } as const;
      });

      if (onCommitCallback) {
        onCommitCallback();
      }
      return result;
    } catch (err) {
      this.wrapError(err);
    }
  }

  async revokeFamily(familyId: string, options?: { operation?: LegacyOperationContext }): Promise<void> {
    try {
      if (this.fence?.enforce && !options?.operation) {
        throw new CutoverFenceError(
          `Durable operation context is required for fence-enforced revokeFamily in namespace ${this.fence.namespace}`,
        );
      }
      const operation = options?.operation;
      const familyRef = this.familyCol().doc(docId(familyId));
      let onCommitCallback: (() => void) | undefined;
      await this.db.runTransaction(async (transaction: Transaction) => {
        const timer = startMonotonicTimer();
        let guard: GuardMutationResult | undefined;
        if (this.fence?.enforce) {
          if (!operation) throw new CutoverFenceError('Durable operation context is required');
          guard = await checkMutationGuardInTransaction(transaction, {
            db: this.db,
            namespace: this.fence.namespace,
            operation,
            identityKey: requireFenceIdentityKey(this.fence),
            now: this.nowProvider,
            timer,
          });
          onCommitCallback = guard.onCommit;
        }
        const familySnap = await transaction.get(familyRef);
        if (!familySnap.exists) {
          guard?.assertPreWrite();
          guard?.bufferCompletion(this.nowProvider());
          guard?.assertPreReturn();
          return;
        }
        const family = familySnap.data() as StoredRefreshFamily;
        guard?.assertPreWrite();
        await this.assertFamilyHasNoLiveClaim(transaction, familyRef);
        guard?.bufferCompletion(this.nowProvider());
        this.deleteFamilyInTransaction(transaction, familyRef, family);
        guard?.assertPreReturn();
      });
      if (onCommitCallback) {
        onCommitCallback();
      }
    } catch (err) {
      this.wrapError(err);
    }
  }

  async revokeByToken(token: string, options?: { operation?: LegacyOperationContext }): Promise<void> {
    try {
      if (this.fence?.enforce && !options?.operation) {
        throw new CutoverFenceError(
          `Durable operation context is required for fence-enforced revokeByToken in namespace ${this.fence.namespace}`,
        );
      }
      const operation = options?.operation;
      const accessRef = this.accessCol().doc(docId(token));
      const refreshRef = this.refreshCol().doc(docId(token));

      let onCommitCallback: (() => void) | undefined;
      await this.db.runTransaction(async (transaction: Transaction) => {
        const timer = startMonotonicTimer();
        let guard: GuardMutationResult | undefined;
        if (this.fence?.enforce) {
          if (!operation) throw new CutoverFenceError('Durable operation context is required');
          guard = await checkMutationGuardInTransaction(transaction, {
            db: this.db,
            namespace: this.fence.namespace,
            operation,
            identityKey: requireFenceIdentityKey(this.fence),
            now: this.nowProvider,
            timer,
          });
          onCommitCallback = guard.onCommit;
        }
        const accessSnap = await transaction.get(accessRef);
        if (accessSnap.exists) {
          const data = accessSnap.data() as Record<string, unknown>;
          if (typeof data.refreshFamilyId === 'string') {
            const familyRef = this.familyCol().doc(docId(data.refreshFamilyId));
            const familySnap = await transaction.get(familyRef);
            guard?.assertPreWrite();
            await this.assertFamilyHasNoLiveClaim(transaction, familyRef);
            guard?.bufferCompletion(this.nowProvider());
            if (familySnap.exists) {
              this.deleteFamilyInTransaction(
                transaction,
                familyRef,
                familySnap.data() as StoredRefreshFamily,
              );
            }
          } else {
            guard?.assertPreWrite();
            guard?.bufferCompletion(this.nowProvider());
            transaction.delete(accessRef);
          }
          guard?.assertPreReturn();
          return;
        }

        const refreshSnap = await transaction.get(refreshRef);
        if (refreshSnap.exists) {
          const raw = refreshSnap.data() as Record<string, unknown>;
          if (typeof raw.familyId === 'string') {
            const familyRef = this.familyCol().doc(docId(raw.familyId));
            const familySnap = await transaction.get(familyRef);
            guard?.assertPreWrite();
            await this.assertFamilyHasNoLiveClaim(transaction, familyRef);
            guard?.bufferCompletion(this.nowProvider());
            if (familySnap.exists) {
              this.deleteFamilyInTransaction(
                transaction,
                familyRef,
                familySnap.data() as StoredRefreshFamily,
              );
            }
            guard?.assertPreReturn();
            return;
          }
        }

        const fingerprint = refreshFingerprint(token);
        const retiredMatches = await transaction.get(
          this.familyCol()
            .where('retiredRefreshFingerprints', 'array-contains', fingerprint)
            .limit(1),
        );
        if (!retiredMatches.empty) {
          const familyDoc = retiredMatches.docs[0]!;
          guard?.assertPreWrite();
          await this.assertFamilyHasNoLiveClaim(transaction, familyDoc.ref);
          guard?.bufferCompletion(this.nowProvider());
          this.deleteFamilyInTransaction(
            transaction,
            familyDoc.ref,
            familyDoc.data() as StoredRefreshFamily,
          );
          guard?.assertPreReturn();
          return;
        }

        guard?.assertPreWrite();
        guard?.bufferCompletion(this.nowProvider());
        guard?.assertPreReturn();
      });
      if (onCommitCallback) {
        onCommitCallback();
      }
    } catch (err) {
      this.wrapError(err);
    }
  }

  // Refuse family mutations while an upstream grant holds a claim, lease, or ambiguity.
  // Runs in the caller's read phase, before any buffered write.
  private async assertFamilyHasNoLiveClaim(transaction: Transaction, familyRef: DocumentReference): Promise<void> {
    const collections = new Set(this.linkedFamilyCollections);
    if (this.legacy?.upstreamCollection) collections.add(this.legacy.upstreamCollection);
    if (this.fence?.enforce) collections.add(`${this.fence.namespace}_tokens_upstream`);
    for (const collection of collections) {
      const grant = await transaction.get(this.db.collection(collection).doc(familyRef.id));
      assertGrantWritable(grant.data() as StoredUpstreamRecord<unknown> | undefined);
    }
  }

  private deleteFamilyInTransaction(
    transaction: Transaction,
    familyRef: DocumentReference,
    family: StoredRefreshFamily,
  ): void {
    if (family.currentAccessToken) {
      transaction.delete(this.accessCol().doc(docId(family.currentAccessToken)));
    }
    if (family.currentRefreshToken) {
      transaction.delete(this.refreshCol().doc(docId(family.currentRefreshToken)));
    }
    if (family.previousAccessToken) {
      transaction.delete(this.accessCol().doc(docId(family.previousAccessToken)));
    }
    if (family.previousRefreshToken) {
      transaction.delete(this.refreshCol().doc(docId(family.previousRefreshToken)));
    }
    const collections = new Set(this.linkedFamilyCollections);
    if (this.legacy?.upstreamCollection) collections.add(this.legacy.upstreamCollection);
    for (const collection of collections) {
      transaction.delete(this.db.collection(collection).doc(docId(family.id)));
    }
    transaction.delete(familyRef);
  }

  private async findFamilyByRetiredFingerprint(refreshToken: string): Promise<string | undefined> {
    const fingerprint = refreshFingerprint(refreshToken);
    const matches = await this.familyCol()
      .where('retiredRefreshFingerprints', 'array-contains', fingerprint)
      .limit(1)
      .get();
    if (matches.empty) return undefined;
    return matches.docs[0]!.id;
  }

  private async adoptLegacyEmbeddedDoc(
    raw: Record<string, unknown>,
    options?: { operation?: LegacyOperationContext },
  ): Promise<T | undefined> {
    return await this.db.runTransaction(async (transaction: Transaction) => {
      const timer = startMonotonicTimer();
      return await this.adoptLegacyEmbeddedDocInTransaction(transaction, raw, { ...options, timer });
    });
  }

  private async adoptLegacyEmbeddedDocInTransaction(
    transaction: Transaction,
    raw: Record<string, unknown>,
    options?: { operation?: LegacyOperationContext; timer?: MonotonicTimer },
  ): Promise<T | undefined> {
    let guard: GuardMutationResult | undefined;
    if (this.fence?.enforce) {
      if (!options?.operation) {
        throw new CutoverFenceError(
          `Durable operation context is required for fence-enforced adoptLegacyEmbeddedDoc in namespace ${this.fence.namespace}`,
        );
      }
      const timer = options.timer ?? startMonotonicTimer();
      guard = await checkMutationGuardInTransaction(transaction, {
        db: this.db,
        namespace: this.fence.namespace,
        operation: options.operation,
        identityKey: requireFenceIdentityKey(this.fence),
        completeOperation: false,
        now: this.nowProvider,
        timer,
      });
    }

    const tokenObj = (this.legacy?.toToken ? this.legacy.toToken(raw) : raw) as unknown as T;
    if (!tokenObj.accessToken || !tokenObj.refreshToken) {
      guard?.assertPreReturn();
      return undefined;
    }

    const accessRef = this.accessCol().doc(docId(tokenObj.accessToken));
    const accessSnap = await transaction.get(accessRef);
    if (!accessSnap.exists) {
      guard?.assertPreReturn();
      return undefined;
    }

    const currentData = accessSnap.data() as Record<string, unknown>;
    if (currentData.refreshFamilyId) {
      guard?.assertPreReturn();
      return (this.legacy?.toToken ? this.legacy.toToken(currentData) : currentData) as unknown as T;
    }


    const familyId = randomUUID();
    const freshToken = (this.legacy?.toToken ? this.legacy.toToken(currentData) : currentData) as unknown as T;
    const migrated: T = { ...freshToken, refreshFamilyId: familyId };
    const extras = this.accessDocExtras ? this.accessDocExtras(migrated) : {};

    guard?.assertPreWrite();
    guard?.bufferCompletion(this.nowProvider());
    transaction.set(accessRef, stripUndefined({ ...migrated, ...extras }));
    transaction.set(
      this.refreshCol().doc(docId(migrated.refreshToken)),
      stripUndefined({
        status: 'active',
        familyId,
        token: migrated,
      }),
    );
    transaction.set(
      this.familyCol().doc(docId(familyId)),
      stripUndefined({
        id: familyId,
        generation: 1,
        currentAccessToken: migrated.accessToken,
        currentRefreshToken: migrated.refreshToken,
        retiredRefreshFingerprints: [],
        updatedAt: this.nowProvider(),
      }),
    );

    if (this.legacy?.toUpstream && this.legacy?.upstreamCollection) {
      const upstreamData = this.legacy.toUpstream(currentData);
      if (upstreamData) {
        transaction.set(
          this.db.collection(this.legacy.upstreamCollection).doc(docId(familyId)),
          stripUndefined({
            ...upstreamData,
            updatedAt: this.nowProvider(),
          }),
        );
      }
    }

    guard?.assertPreReturn();
    return migrated;
  }
}
