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
import { StoreUnavailableError, CutoverFenceError, CutoverRefusedError, kitCodeOf } from './errors.js';
import { stripUndefined } from './strip-undefined.js';
import {
  type CutoverFenceConfig,
  checkMutationGuardInTransaction,
  getCutoverFenceRecord,
  getCutoverOperationDocRef,
  readCutoverFenceInTransaction,
  type GuardMutationResult,
  type LegacyOperationContext,
  type LegacyOperationRecord,
  requestOperationContext,
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

  async issue(
    token: T,
    options?: { operation?: LegacyOperationContext; completeOperation?: boolean },
  ): Promise<T> {
    try {
      const familyId = token.refreshFamilyId ?? randomUUID();
      const stored: T = { ...token, refreshFamilyId: familyId };
      const extras = this.accessDocExtras ? this.accessDocExtras(stored) : {};
      const accessPayload = stripUndefined({ ...stored, ...extras });

      if (this.fence?.enforce) {
        const op = options?.operation ?? requestOperationContext.getStore();
        if (!op) {
          throw new CutoverFenceError(
            `Durable operation context is required for fence-enforced issue in namespace ${this.fence.namespace}`,
          );
        }
        await this.db.runTransaction(async (transaction: Transaction) => {
          const guard = await checkMutationGuardInTransaction(transaction, {
            db: this.db,
            namespace: this.fence!.namespace,
            operation: op,
            completeOperation: options?.completeOperation,
            now: this.nowProvider,
          });
          guard.bufferCompletion(this.nowProvider());
          transaction.set(this.accessCol().doc(docId(stored.accessToken)), accessPayload);
          transaction.set(
            this.refreshCol().doc(docId(stored.refreshToken)),
            stripUndefined({
              status: 'active',
              familyId,
              token: stored,
            }),
          );
          transaction.set(
            this.familyCol().doc(docId(familyId)),
            stripUndefined({
              id: familyId,
              currentAccessToken: stored.accessToken,
              currentRefreshToken: stored.refreshToken,
              retiredRefreshFingerprints: [],
              updatedAt: this.nowProvider(),
            }),
          );
          if (this.legacy?.toUpstream && this.legacy?.upstreamCollection) {
            const upstreamData = this.legacy.toUpstream(stored as unknown as Record<string, unknown>);
            if (upstreamData) {
              const upstreamRef = this.db.collection(this.legacy.upstreamCollection).doc(docId(familyId));
              const upstreamPayload = stripUndefined({
                ...upstreamData,
                updatedAt: this.nowProvider(),
              });
              transaction.set(upstreamRef, upstreamPayload);
            }
          }
        });
        return stored;
      }

      const batch = this.db.batch();
      batch.set(this.accessCol().doc(docId(stored.accessToken)), accessPayload);
      batch.set(
        this.refreshCol().doc(docId(stored.refreshToken)),
        stripUndefined({
          status: 'active',
          familyId,
          token: stored,
        }),
      );
      batch.set(
        this.familyCol().doc(docId(familyId)),
        stripUndefined({
          id: familyId,
          currentAccessToken: stored.accessToken,
          currentRefreshToken: stored.refreshToken,
          retiredRefreshFingerprints: [],
          updatedAt: this.nowProvider(),
        }),
      );
      if (this.legacy?.toUpstream && this.legacy?.upstreamCollection) {
        const upstreamData = this.legacy.toUpstream(stored as unknown as Record<string, unknown>);
        if (upstreamData) {
          const upstreamRef = this.db.collection(this.legacy.upstreamCollection).doc(docId(familyId));
          const upstreamPayload = stripUndefined({
            ...upstreamData,
            updatedAt: this.nowProvider(),
          });
          batch.set(upstreamRef, upstreamPayload);
        }
      }

      await batch.commit();
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
        const op = options?.operation ?? requestOperationContext.getStore();
        if (!op) {
          throw new CutoverFenceError(
            `Durable operation context is required for fence-enforced getByAccessToken in namespace ${this.fence.namespace}`,
          );
        }

        return await this.db.runTransaction(async (transaction: Transaction) => {
          const control = await readCutoverFenceInTransaction(transaction, this.db, this.fence!.namespace);
          if (control.state !== 'legacy_open') {
            if (
              control.state === 'closing' &&
              op &&
              op.epoch === control.epoch
            ) {
              const opRef = getCutoverOperationDocRef(this.db, this.fence!.namespace, op.id);
              const opSnap = await transaction.get(opRef);
              if (!opSnap.exists) {
                throw new CutoverFenceError(
                  `Durable operation record missing in closing: ${op.id}`,
                );
              }
              const opData = opSnap.data() as LegacyOperationRecord;
              if (opData.epoch !== control.epoch) {
                throw new CutoverFenceError(
                  `Operation epoch mismatch in closing: expected ${control.epoch}, got ${opData.epoch}`,
                );
              }
              if (opData.phase !== 'admitted' && opData.phase !== 'upstream_pending') {
                throw new CutoverFenceError(
                  `Operation in closing is in phase ${opData.phase}; lookup refused`,
                );
              }
            } else {
              throw new CutoverRefusedError(
                `Cutover state is ${control.state}; access token lookup refused for namespace ${this.fence!.namespace}`,
                { cutoverState: control.state, epoch: control.epoch },
              );
            }
          }

          const snap = await transaction.get(this.accessCol().doc(docId(accessToken)));
          if (!snap.exists) return undefined;
          const data = snap.data() as Record<string, unknown>;

          if (!data.refreshFamilyId && (this.legacy?.embeddedRefreshQuery || this.legacy?.pointerDocs)) {
            return await this.adoptLegacyEmbeddedDocInTransaction(transaction, data, { operation: op });
          }
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
        const op = options?.operation ?? requestOperationContext.getStore();
        return await this.db.runTransaction(async (transaction: Transaction) => {
          const control = await readCutoverFenceInTransaction(transaction, this.db, this.fence!.namespace);
          if (control.state !== 'legacy_open') {
            if (
              control.state === 'closing' &&
              op &&
              op.epoch === control.epoch
            ) {
              const opRef = getCutoverOperationDocRef(this.db, this.fence!.namespace, op.id);
              const opSnap = await transaction.get(opRef);
              if (!opSnap.exists) {
                throw new CutoverFenceError(
                  `Durable operation record missing in closing: ${op.id}`,
                );
              }
              const opData = opSnap.data() as LegacyOperationRecord;
              if (opData.epoch !== control.epoch) {
                throw new CutoverFenceError(
                  `Operation epoch mismatch in closing: expected ${control.epoch}, got ${opData.epoch}`,
                );
              }
              if (opData.phase !== 'admitted' && opData.phase !== 'upstream_pending') {
                throw new CutoverFenceError(
                  `Operation in closing is in phase ${opData.phase}; lookup refused`,
                );
              }
            } else {
              throw new CutoverRefusedError(
                `Cutover state is ${control.state}; refresh lookup refused for namespace ${this.fence!.namespace}`,
                { cutoverState: control.state, epoch: control.epoch },
              );
            }
          }
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
                    { operation: op },
                  );
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

            const fingerprint = refreshFingerprint(refreshToken);
            const retiredMatch = await transaction.get(
              this.familyCol()
                .where('retiredRefreshFingerprints', 'array-contains', fingerprint)
                .limit(1),
            );
            if (!retiredMatch.empty) {
              if (!op) {
                throw new CutoverFenceError(
                  `Durable operation context is required for retired replay revocation during lookupRefresh in namespace ${this.fence!.namespace}`,
                );
              }
              const retiredGuard = await checkMutationGuardInTransaction(transaction, {
                db: this.db,
                namespace: this.fence!.namespace,
                operation: op,
                completeOperation: true,
                now: this.nowProvider,
              });
              const familyDoc = retiredMatch.docs[0]!;
              const family = familyDoc.data() as StoredRefreshFamily;
              retiredGuard.bufferCompletion(now);
              this.deleteFamilyInTransaction(transaction, familyDoc.ref, family);
              return { status: 'replay', familyId: familyDoc.id };
            }
            return { status: 'missing' };
          }

          const raw = snap.data() as StoredRefreshRecord<T> | LegacyRefreshPointer;

          if (!('status' in raw)) {
            const legacyAccessSnap = await transaction.get(
              this.accessCol().doc(docId(raw.accessToken)),
            );
            if (!legacyAccessSnap.exists) return { status: 'missing' };
            const rawAccess = legacyAccessSnap.data() as Record<string, unknown>;
            const adopted = await this.adoptLegacyEmbeddedDocInTransaction(
              transaction,
              rawAccess,
              { operation: options?.operation },
            );
            if (!adopted) return { status: 'missing' };
            if (expectedClientId && adopted.clientId !== expectedClientId) {
              return { status: 'missing' };
            }
            return { status: 'active', token: adopted, familyId: adopted.refreshFamilyId! };
          }

          const oldRecord = raw as StoredRefreshRecord<T>;
          if (expectedClientId && oldRecord.token.clientId !== expectedClientId) {
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
                return {
                  status: 'retry',
                  token: successorRecord.token,
                  familyId: raw.familyId,
                };
              }
            }

            if (!op) {
              throw new CutoverFenceError(
                `Durable operation context is required for consumed replay revocation during lookupRefresh in namespace ${this.fence!.namespace}`,
              );
            }
            const replayGuard = await checkMutationGuardInTransaction(transaction, {
              db: this.db,
              namespace: this.fence!.namespace,
              operation: op,
              completeOperation: true,
              now: this.nowProvider,
            });
            if (family) {
              replayGuard.bufferCompletion(now);
              this.deleteFamilyInTransaction(transaction, familyRef, family);
            }
            return { status: 'replay', familyId: raw.familyId };
          }

          return { status: 'active', token: raw.token, familyId: raw.familyId };
        });
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
    options?: { operation?: LegacyOperationContext; completeOperation?: boolean },
  ): Promise<RefreshRotationResult<T>> {
    try {
      const oldRef = this.refreshCol().doc(docId(oldRefreshToken));

      const result = await this.db.runTransaction(async (transaction: Transaction) => {
        let guard: GuardMutationResult | undefined;
        if (this.fence?.enforce) {
          const op = options?.operation ?? requestOperationContext.getStore();
          guard = await checkMutationGuardInTransaction(transaction, {
            db: this.db,
            namespace: this.fence.namespace,
            operation: op,
            completeOperation: options?.completeOperation,
            now: this.nowProvider,
          });
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
            guard?.bufferCompletion(now);
            this.deleteFamilyInTransaction(transaction, familyDoc.ref, family);
            return { status: 'replay' } as const;
          }
          return { status: 'missing' } as const;
        }

        let raw = oldSnap.data() as StoredRefreshRecord<T> | LegacyRefreshPointer;
        if (!('status' in raw)) {
          const legacyAccessSnap = await transaction.get(
            this.accessCol().doc(docId(raw.accessToken)),
          );
          if (!legacyAccessSnap.exists) return { status: 'missing' } as const;
          const rawAccess = legacyAccessSnap.data() as Record<string, unknown>;
          const tokenObj = (this.legacy?.toToken ? this.legacy.toToken(rawAccess) : rawAccess) as unknown as T;
          if (!tokenObj.accessToken || !tokenObj.refreshToken) {
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
              return { status: 'retry', token: successorRecord.token } as const;
            }
          }

          guard?.bufferCompletion(now);
          this.deleteFamilyInTransaction(transaction, familyRef, family);
          return { status: 'replay' } as const;
        }

        // Active refresh token: perform rotation
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

        const stored: T = { ...replacement, refreshFamilyId: oldRecord.familyId };
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
        transaction.set(familyRef, stripUndefined({
          id: oldRecord.familyId,
          currentAccessToken: stored.accessToken,
          currentRefreshToken: stored.refreshToken,
          previousAccessToken: oldRecord.token.accessToken,
          previousRefreshToken: oldRefreshToken,
          retiredRefreshFingerprints: boundedRetired,
          updatedAt: now,
        }));
        if (this.legacy?.toUpstream && this.legacy?.upstreamCollection) {
          const upstreamData = this.legacy.toUpstream(stored as unknown as Record<string, unknown>);
          if (upstreamData) {
            const upstreamRef = this.db.collection(this.legacy.upstreamCollection).doc(docId(oldRecord.familyId));
            const upstreamPayload = stripUndefined({
              ...upstreamData,
              updatedAt: now,
            });
            transaction.set(upstreamRef, upstreamPayload, { merge: true });
          }
        }

        return { status: 'claimed', token: stored } as const;
      });

      return result;
    } catch (err) {
      this.wrapError(err);
    }
  }

  async revokeFamily(familyId: string, options?: { operation?: LegacyOperationContext }): Promise<void> {
    try {
      const op = options?.operation ?? requestOperationContext.getStore();
      if (this.fence?.enforce && !op) {
        throw new CutoverFenceError(
          `Durable operation context is required for fence-enforced revokeFamily in namespace ${this.fence.namespace}`,
        );
      }
      const familyRef = this.familyCol().doc(docId(familyId));
      await this.db.runTransaction(async (transaction: Transaction) => {
        let guard: GuardMutationResult | undefined;
        if (this.fence?.enforce && op) {
          guard = await checkMutationGuardInTransaction(transaction, {
            db: this.db,
            namespace: this.fence.namespace,
            operation: op,
            now: this.nowProvider,
          });
        }
        const familySnap = await transaction.get(familyRef);
        if (!familySnap.exists) {
          guard?.bufferCompletion(this.nowProvider());
          return;
        }
        const family = familySnap.data() as StoredRefreshFamily;
        guard?.bufferCompletion(this.nowProvider());
        this.deleteFamilyInTransaction(transaction, familyRef, family);
      });
    } catch (err) {
      this.wrapError(err);
    }
  }

  async revokeByToken(token: string, options?: { operation?: LegacyOperationContext }): Promise<void> {
    try {
      const op = options?.operation ?? requestOperationContext.getStore();
      if (this.fence?.enforce && !op) {
        throw new CutoverFenceError(
          `Durable operation context is required for fence-enforced revokeByToken in namespace ${this.fence.namespace}`,
        );
      }
      const accessRef = this.accessCol().doc(docId(token));
      const refreshRef = this.refreshCol().doc(docId(token));

      await this.db.runTransaction(async (transaction: Transaction) => {
        let guard: GuardMutationResult | undefined;
        if (this.fence?.enforce && op) {
          guard = await checkMutationGuardInTransaction(transaction, {
            db: this.db,
            namespace: this.fence.namespace,
            operation: op,
            now: this.nowProvider,
          });
        }

        const accessSnap = await transaction.get(accessRef);
        if (accessSnap.exists) {
          const data = accessSnap.data() as Record<string, unknown>;
          if (typeof data.refreshFamilyId === 'string') {
            const familyRef = this.familyCol().doc(docId(data.refreshFamilyId));
            const familySnap = await transaction.get(familyRef);
            guard?.bufferCompletion(this.nowProvider());
            if (familySnap.exists) {
              this.deleteFamilyInTransaction(
                transaction,
                familyRef,
                familySnap.data() as StoredRefreshFamily,
              );
            }
          } else {
            guard?.bufferCompletion(this.nowProvider());
            transaction.delete(accessRef);
          }
          return;
        }

        const refreshSnap = await transaction.get(refreshRef);
        if (refreshSnap.exists) {
          const raw = refreshSnap.data() as Record<string, unknown>;
          if (typeof raw.familyId === 'string') {
            const familyRef = this.familyCol().doc(docId(raw.familyId));
            const familySnap = await transaction.get(familyRef);
            guard?.bufferCompletion(this.nowProvider());
            if (familySnap.exists) {
              this.deleteFamilyInTransaction(
                transaction,
                familyRef,
                familySnap.data() as StoredRefreshFamily,
              );
            }
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
          guard?.bufferCompletion(this.nowProvider());
          this.deleteFamilyInTransaction(
            transaction,
            familyDoc.ref,
            familyDoc.data() as StoredRefreshFamily,
          );
          return;
        }

        guard?.bufferCompletion(this.nowProvider());
      });
    } catch (err) {
      this.wrapError(err);
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
    for (const linkedCol of this.linkedFamilyCollections) {
      transaction.delete(this.db.collection(linkedCol).doc(docId(family.id)));
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
      return await this.adoptLegacyEmbeddedDocInTransaction(transaction, raw, options);
    });
  }

  private async adoptLegacyEmbeddedDocInTransaction(
    transaction: Transaction,
    raw: Record<string, unknown>,
    options?: { operation?: LegacyOperationContext },
  ): Promise<T | undefined> {
    let guard: GuardMutationResult | undefined;
    const op = options?.operation ?? requestOperationContext.getStore();
    if (this.fence?.enforce) {
      guard = await checkMutationGuardInTransaction(transaction, {
        db: this.db,
        namespace: this.fence.namespace,
        operation: op,
        completeOperation: false,
        now: this.nowProvider,
      });
    }

    const tokenObj = (this.legacy?.toToken ? this.legacy.toToken(raw) : raw) as unknown as T;
    if (!tokenObj.accessToken || !tokenObj.refreshToken) {
      return undefined;
    }

    const accessRef = this.accessCol().doc(docId(tokenObj.accessToken));
    const accessSnap = await transaction.get(accessRef);
    if (!accessSnap.exists) return undefined;

    const currentData = accessSnap.data() as Record<string, unknown>;
    if (currentData.refreshFamilyId) {
      return (this.legacy?.toToken ? this.legacy.toToken(currentData) : currentData) as unknown as T;
    }

    const familyId = randomUUID();
    const freshToken = (this.legacy?.toToken ? this.legacy.toToken(currentData) : currentData) as unknown as T;
    const migrated: T = { ...freshToken, refreshFamilyId: familyId };
    const extras = this.accessDocExtras ? this.accessDocExtras(migrated) : {};

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

    return migrated;
  }
}
