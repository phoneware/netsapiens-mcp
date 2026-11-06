import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { FieldValue, type DocumentReference, type Firestore } from '@google-cloud/firestore';
import {
  CutoverFenceError,
  CutoverRefusedError,
  UpstreamRevokedError,
  UpstreamUnavailableError,
  UpstreamRequestRejectedError,
  classifyUpstreamTokenResponse,
  kitCodeOf,
} from './errors.js';
import { docId } from './firestore-ledger.js';
import type { UpstreamCompletion } from './ledger.js';
import { stripUndefined } from './strip-undefined.js';
import {
  type CutoverFenceConfig,
  checkMutationGuardInTransaction,
  normalizeFenceConfig,
  requireFenceKey,
  assertOperationKey,
  startMonotonicTimer,
  claimUpstreamGrantInTransaction,
  canonicalJsonStringify,
  getCutoverFenceDocRef,
  getCutoverOperationDocRef,
  readCutoverFenceInTransaction,
  releaseLegacyOperation,
  type GuardMutationResult,
  type LegacyOperationContext,
  type LegacyOperationRecord,
  requestOperationContext,
} from './cutover-fence.js';

export type AmbiguousGrantReasonCode =
  | 'upstream_timeout'
  | 'upstream_transport_error'
  | 'local_commit_failure'
  | 'remote_grant_in_flight';

export interface StoredUpstreamRecord<G> {
  grant: G;
  expiresAt?: number;
  grantVersion?: number;
  version?: number;
  familyGeneration?: number;
  leaseExpiresAt?: number | null;
  operationId?: string | null;
  leaseUntil?: number;
  leaseOwner?: string;
  ambiguousOutcome?: boolean | null;
  ambiguousRemoteOutcome?: boolean | null;
  ambiguousReason?: AmbiguousGrantReasonCode | null;
  ambiguousAt?: number | null;
  ambiguousOperationId?: string | null;
  updatedAt?: number;
}

export function assertGrantNotPending(record: StoredUpstreamRecord<unknown> | undefined): void {
  if (record && (record.leaseOwner != null || record.leaseUntil != null || record.leaseExpiresAt != null ||
    record.operationId != null || record.ambiguousOperationId != null || record.ambiguousOutcome || record.ambiguousRemoteOutcome)) {
    throw new UpstreamUnavailableError('Upstream grant has a pending or ambiguous claim');
  }
}

function mergedGrantValue(previous: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || patch instanceof Date) return patch;
  const entries = Object.entries(patch);
  if (!entries.length) return {};
  const base = previous && typeof previous === 'object' && !Array.isArray(previous) && !(previous instanceof Date)
    ? { ...previous } : {};
  for (const [key, value] of entries) {
    if (value !== undefined) {
      const existing = Object.prototype.hasOwnProperty.call(base, key)
        ? (base as Record<string, unknown>)[key] : undefined;
      (base as Record<string, unknown>)[key] = mergedGrantValue(existing, value);
    }
  }
  return base;
}

/** Keep the version stable for an identical grant and advance it for replacement. */
export function nextGrantVersion<G>(current: StoredUpstreamRecord<G> | undefined, grant: G): number {
  const previous = current?.grantVersion ?? current?.version ?? 1;
  if (!Number.isSafeInteger(previous) || previous < 1) throw new CutoverFenceError('Upstream grant version is invalid');
  const changed = current !== undefined &&
    canonicalJsonStringify(stripUndefined(current.grant)) !==
    canonicalJsonStringify(mergedGrantValue(current.grant, stripUndefined(grant)));
  const next = previous + (changed ? 1 : 0);
  if (!Number.isSafeInteger(next)) throw new CutoverFenceError('Upstream grant version is invalid');
  return next;
}


export type EnsureFreshResult<G> = Readonly<{
  grant: G;
  completion: UpstreamCompletion | null;
}>;

export class RefreshSupersededError extends Error { }

export interface EnsureFreshOptions {
  force?: boolean;
  skewMs?: number;
  leaseMs?: number;
  waitMs?: number;
  pollIntervalMs?: number;
  now?: number;
  expectedRefresh?: { ref: DocumentReference; clientId: string };
  expectedAccess?: { ref: DocumentReference; familyId: string };
}

export interface UpstreamGrantStore<G> {
  put(
    familyId: string,
    grant: G,
    expiresAt?: number,
    options?: { operation?: LegacyOperationContext; completeOperation?: boolean },
  ): Promise<void>;
  get(familyId: string): Promise<StoredUpstreamRecord<G> | undefined>;
  delete(familyId: string, options?: { operation?: LegacyOperationContext }): Promise<void>;
  ensureFresh(
    familyId: string,
    refresh: (currentGrant: G) => Promise<{ grant: G; expiresAt?: number }>,
    options?: EnsureFreshOptions & { operation?: LegacyOperationContext; completeOperation?: boolean },
  ): Promise<EnsureFreshResult<G>>;
  reconcileAmbiguousGrant?(
    familyId: string,
    grant: G,
    expiresAt: number | undefined,
    options: { operationId: string; operation?: LegacyOperationContext },
  ): Promise<void>;
}

export class MemoryUpstreamGrantStore<G> implements UpstreamGrantStore<G> {
  private readonly records = new Map<string, StoredUpstreamRecord<G>>();
  private readonly nowProvider: () => number;

  constructor(opts?: { now?: () => number }) {
    this.nowProvider = opts?.now ?? Date.now;
  }

  async put(familyId: string, grant: G, expiresAt?: number): Promise<void> {
    this.records.set(familyId, {
      grant,
      expiresAt,
      updatedAt: this.nowProvider(),
    });
  }

  async get(familyId: string): Promise<StoredUpstreamRecord<G> | undefined> {
    return this.records.get(familyId);
  }

  async delete(familyId: string): Promise<void> {
    this.records.delete(familyId);
  }

  async ensureFresh(
    familyId: string,
    refresh: (currentGrant: G) => Promise<{ grant: G; expiresAt?: number }>,
    options?: EnsureFreshOptions,
  ): Promise<EnsureFreshResult<G>> {
    const record = this.records.get(familyId);
    if (!record) {
      throw new UpstreamRevokedError('No upstream grant found for session');
    }

    const now = options?.now ?? this.nowProvider();
    const skewMs = options?.skewMs ?? 300_000;
    const force = options?.force ?? false;

    const isExpiring = !record.expiresAt || record.expiresAt - skewMs <= now;
    if (!force && !isExpiring) {
      return { grant: record.grant, completion: null };
    }

    try {
      const refreshed = await refresh(record.grant);
      this.records.set(familyId, {
        grant: refreshed.grant,
        expiresAt: refreshed.expiresAt,
        updatedAt: now,
      });
      return { grant: refreshed.grant, completion: null };
    } catch (err) {
      if (kitCodeOf(err)) throw err;
      const classification = classifyUpstreamTokenResponse(
        0,
        err instanceof Error ? err.message : String(err),
      );
      if (classification === 'definitive') {
        this.records.delete(familyId);
        throw new UpstreamRevokedError(err instanceof Error ? err.message : String(err));
      }
      if (record.expiresAt && record.expiresAt > now) {
        return { grant: record.grant, completion: null };
      }
      throw new UpstreamUnavailableError(err instanceof Error ? err.message : String(err));
    }
  }
}

export interface FirestoreUpstreamGrantStoreOptions {
  db: Firestore;
  collection: string;
  now?: () => number;
  fence?: CutoverFenceConfig;
}

export class FirestoreUpstreamGrantStore<G> implements UpstreamGrantStore<G> {
  private readonly db: Firestore;
  private readonly collection: string;
  private readonly nowProvider: () => number;
  private readonly fence?: CutoverFenceConfig;

  constructor(opts: FirestoreUpstreamGrantStoreOptions) {
    this.db = opts.db;
    this.collection = opts.collection;
    this.nowProvider = opts.now ?? Date.now;
    this.fence = normalizeFenceConfig(opts.fence);
  }

  async put(
    familyId: string,
    grant: G,
    expiresAt?: number,
    options?: { operation?: LegacyOperationContext; completeOperation?: boolean },
  ): Promise<void> {
    const docRef = this.db.collection(this.collection).doc(docId(familyId));
    if (this.fence?.enforce) {
      const op = options?.operation ?? requestOperationContext.getStore();
      assertOperationKey(this.fence, op);
      if (!op) {
        throw new CutoverFenceError(
          `Durable operation context is required for fence-enforced put in namespace ${this.fence.namespace}`,
        );
      }
      let guardResult: GuardMutationResult | undefined;
      const runPutTx = async () => {
        await this.db.runTransaction(async (transaction) => {
          const timer = startMonotonicTimer();
          const guard = await checkMutationGuardInTransaction(transaction, {
            db: this.db,
            namespace: this.fence!.namespace,
            operation: op,
            identityKey: requireFenceKey(this.fence!),
            timer,
            completeOperation: options?.completeOperation,
            now: this.nowProvider,
          });
          guardResult = guard;
          const current = await transaction.get(docRef);
          const previous = current.data() as StoredUpstreamRecord<G> | undefined;
          assertGrantNotPending(previous);
          const grantVersion = nextGrantVersion(previous, grant);
          guard.bufferCompletion(this.nowProvider());
          transaction.set(
            docRef,
            stripUndefined({
              grant,
              expiresAt,
              grantVersion,
              updatedAt: this.nowProvider(),
            }),
            { merge: true },
          );
          guard.assertPreReturn();
        });
      };
      if (op?.trackWriter) {
        await op.trackWriter(runPutTx);
      } else {
        await runPutTx();
      }
      guardResult?.onCommit();
      return;
    }

    await this.db.runTransaction(async (transaction) => {
      const current = await transaction.get(docRef);
      const previous = current.data() as StoredUpstreamRecord<G> | undefined;
      assertGrantNotPending(previous);
      const grantVersion = nextGrantVersion(previous, grant);
      transaction.set(docRef, stripUndefined({ grant, grantVersion, expiresAt, updatedAt: this.nowProvider() }), { merge: true });
    });
  }

  async get(familyId: string): Promise<StoredUpstreamRecord<G> | undefined> {
    const snap = await this.db.collection(this.collection).doc(docId(familyId)).get();
    return snap.exists ? (snap.data() as StoredUpstreamRecord<G>) : undefined;
  }

  async delete(
    familyId: string,
    options?: { operation?: LegacyOperationContext },
  ): Promise<void> {
    const docRef = this.db.collection(this.collection).doc(docId(familyId));
    if (this.fence?.enforce) {
      const op = options?.operation ?? requestOperationContext.getStore();
      assertOperationKey(this.fence, op);
      if (!op) {
        throw new CutoverFenceError(
          `Durable operation context is required for fence-enforced delete in namespace ${this.fence.namespace}`,
        );
      }
      let guardResult: GuardMutationResult | undefined;
      const runDeleteTx = async () => {
        await this.db.runTransaction(async (transaction) => {
          const timer = startMonotonicTimer();
          const guard = await checkMutationGuardInTransaction(transaction, {
            db: this.db,
            namespace: this.fence!.namespace,
            operation: op,
            identityKey: requireFenceKey(this.fence!),
            timer,
            now: this.nowProvider,
          });
          guardResult = guard;
          const current = await transaction.get(docRef);
          assertGrantNotPending(current.data() as StoredUpstreamRecord<G> | undefined);
          guard.assertPreWrite();
          transaction.delete(docRef);
          guard.assertPreReturn();
        });
      };
      if (op?.trackWriter) {
        await op.trackWriter(runDeleteTx);
      } else {
        await runDeleteTx();
      }
      guardResult?.onCommit();
      return;
    }

    await this.db.runTransaction(async (transaction) => {
      const current = await transaction.get(docRef);
      assertGrantNotPending(current.data() as StoredUpstreamRecord<G> | undefined);
      transaction.delete(docRef);
    });
  }

  async ensureFresh(
    familyId: string,
    refresh: (currentGrant: G) => Promise<{ grant: G; expiresAt?: number }>,
    options?: EnsureFreshOptions & { operation?: LegacyOperationContext; completeOperation?: boolean },
  ): Promise<EnsureFreshResult<G>> {
    const op = options?.operation ?? requestOperationContext.getStore();
    assertOperationKey(this.fence, op);
    if (this.fence?.enforce && !op) {
      throw new CutoverFenceError(
        `Durable operation context is required for fence-enforced ensureFresh in namespace ${this.fence.namespace}`,
      );
    }
    if (this.fence?.enforce && this.collection !== `${this.fence.namespace}_tokens_upstream`) {
      throw new CutoverFenceError('Fenced upstream collection does not match the canonical namespace');
    }
    const docRef = this.db.collection(this.collection).doc(docId(familyId));
    const now = options?.now ?? this.nowProvider();
    const skewMs = options?.skewMs ?? 300_000;
    const leaseMs = options?.leaseMs ?? 30_000;
    const waitMs = options?.waitMs ?? 10_000;
    const pollIntervalMs = options?.pollIntervalMs ?? 100;
    const force = options?.force ?? false;
    const leaseOwner = randomUUID();
    const operationId = this.fence?.enforce ? op?.id ?? null : null;

    const runClaimTx = async () => {
      return await this.db.runTransaction(async (transaction) => {
        const timer = startMonotonicTimer();
        let guard: GuardMutationResult | undefined;
        if (this.fence?.enforce) {
          if (!op) throw new CutoverFenceError('Durable operation context is required');
          guard = await checkMutationGuardInTransaction(transaction, {
            db: this.db,
            namespace: this.fence.namespace,
            operation: op,
            identityKey: requireFenceKey(this.fence),
            timer,
            now: this.nowProvider,
            completeOperation: false,
          });
        }
        if (options?.expectedAccess) {
          const accessSnap = await transaction.get(options.expectedAccess.ref);
          const access = accessSnap.data();
          if (!access || access.refreshFamilyId !== options.expectedAccess.familyId || familyId !== options.expectedAccess.familyId) {
            throw new RefreshSupersededError('Access token changed before upstream claim');
          }
        }
        if (options?.expectedRefresh) {
          const refreshSnap = await transaction.get(options.expectedRefresh.ref);
          const refreshRecord = refreshSnap.data();
          if (!refreshRecord || refreshRecord.status !== 'active' ||
            refreshRecord.familyId !== familyId || refreshRecord.token?.clientId !== options.expectedRefresh.clientId) {
            throw new RefreshSupersededError('Refresh token changed before upstream claim');
          }
        }
        const snap = await transaction.get(docRef);
        if (!snap.exists) {
          throw new UpstreamRevokedError('No upstream grant found for session');
        }

        const current = snap.data() as StoredUpstreamRecord<G>;

        if (current.ambiguousOutcome || current.ambiguousRemoteOutcome) {
          throw new UpstreamUnavailableError(
            `Upstream grant has an unresolved ambiguous outcome: ${current.ambiguousReason ?? 'pending reconciliation'}`,
          );
        }

        if (current.leaseOwner) {
          if (!current.leaseUntil || current.leaseUntil <= now) {
            throw new UpstreamUnavailableError('Upstream grant has an unresolved expired lease');
          }
          guard?.assertPreReturn();
          return { status: 'leased' as const, current };
        }

        if (current.ambiguousOperationId || current.operationId || current.leaseUntil || current.leaseExpiresAt) {
          throw new UpstreamUnavailableError('Upstream grant has an unresolved lease binding');
        }
        const isExpiring = !current.expiresAt || current.expiresAt - skewMs <= now;
        if (!force && !isExpiring) {
          guard?.assertPreReturn();
          return { status: 'fresh' as const, grant: current.grant };
        }

        if (this.fence?.enforce && op) {
          const familyRef = this.db.collection(`${this.fence.namespace}_tokens_refresh_families`).doc(familyId);
          const familySnap = await transaction.get(familyRef);
          const family = familySnap.data();
          if (!family) throw new CutoverFenceError('Family record missing for upstream claim');
          const familyGeneration = typeof family.generation === 'number' ? family.generation : 1;
          const grantVersion = typeof current.grantVersion === 'number' ? current.grantVersion : current.version ?? 1;
          const canonicalClaim = await claimUpstreamGrantInTransaction(transaction, this.db, {
            namespace: this.fence.namespace, epoch: op.epoch, familyId, operationId: op.id,
            identityKey: requireFenceKey(this.fence), claimOwner: leaseOwner,
            expectedFamilyGeneration: familyGeneration, expectedGrantVersion: grantVersion,
            expectedKind: op.kind, leaseMs, nowProvider: () => now, timer,
          });
          timer.assertUnderDeadline('upstream claim pre-return');
          return { status: 'claimed' as const, grant: current.grant, canonicalClaim };
        }

        timer.assertUnderDeadline('upstream claim pre-write');
        transaction.set(
          docRef,
          stripUndefined({
            ...current,
            leaseUntil: now + leaseMs,
            leaseOwner,
            ambiguousOperationId: this.fence?.enforce && op ? op.id : undefined,
          }),
          { merge: true },
        );

        timer.assertUnderDeadline('upstream claim pre-return');
        return { status: 'claimed' as const, grant: current.grant, canonicalClaim: undefined };
      });
    };
    const claimResult = op?.trackWriter ? await op.trackWriter(runClaimTx) : await runClaimTx();
    if (claimResult.status === 'claimed' && claimResult.canonicalClaim && op) {
      op.markAmbiguousRemoteOutcome('remote_grant_in_flight');
    }
    if (claimResult.status === 'fresh') {
      return { grant: claimResult.grant, completion: null };
    }

    if (claimResult.status === 'leased') {
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        await sleep(pollIntervalMs);
        const checkSnap = await docRef.get();
        if (!checkSnap.exists) {
          throw new UpstreamRevokedError('Grant document deleted while awaiting refresh');
        }
        const checkData = checkSnap.data() as StoredUpstreamRecord<G>;
        if (checkData.ambiguousOutcome || checkData.ambiguousRemoteOutcome) {
          throw new UpstreamUnavailableError(
            `Upstream grant has an unresolved ambiguous outcome: ${checkData.ambiguousReason ?? 'pending reconciliation'}`,
          );
        }
        const refreshedCommitted = !checkData.leaseOwner && !checkData.leaseUntil && !checkData.leaseExpiresAt && !checkData.operationId && !checkData.ambiguousOperationId;
        if (refreshedCommitted) {
          if ((checkData.updatedAt ?? 0) <= (claimResult.current.updatedAt ?? 0)) {
            throw new UpstreamUnavailableError('Upstream refresh ended without a replacement grant');
          }
          return { grant: checkData.grant, completion: null };
        }
      }

      throw new UpstreamUnavailableError('Timed out waiting for upstream token refresh');
    }

    const pendingClaim = claimResult.canonicalClaim;
    // claimResult.status === 'claimed': instance holds the lease
    let refreshed: { grant: G; expiresAt?: number } | undefined;
    try {
      const runRefresh = () => refresh(claimResult.grant);
      refreshed = op?.trackWriter ? await op.trackWriter(runRefresh) : await runRefresh();
    } catch (err) {
      const code = kitCodeOf(err);
      if (code === 'cutover_refused' || code === 'cutover_fence_error') {
        throw err;
      }

      const isDefinitive =
        code === 'upstream_revoked' ||
        (!code && classifyUpstreamTokenResponse(0, err instanceof Error ? err.message : String(err)) === 'definitive');

      if (isDefinitive) {
        if (this.fence?.enforce) {
          op?.markAmbiguousRemoteOutcome('upstream_untrusted_definitive');
          throw new UpstreamUnavailableError('Upstream grant verification remains unresolved');
        }
        const runDefinitiveTx = async () => {
          await this.db.runTransaction(async (transaction) => {
            const snap = await transaction.get(docRef);
            if (snap.exists) {
              const current = snap.data() as StoredUpstreamRecord<G>;
              if (current.leaseOwner === leaseOwner && (current.ambiguousOperationId ?? null) === operationId) {
                transaction.delete(docRef);
              }
            }
          }).catch(() => { });
        };
        if (op?.trackWriter) {
          await op.trackWriter(runDefinitiveTx);
        } else {
          await runDefinitiveTx();
        }


        if (err instanceof UpstreamRevokedError) {
          throw err;
        }
        throw new UpstreamRevokedError(err instanceof Error ? err.message : String(err));
      }

      if (err instanceof UpstreamRequestRejectedError) {
        const release = async () => this.db.runTransaction(async (transaction) => {
          const timer = startMonotonicTimer();
          let guard: GuardMutationResult | undefined;
          if (this.fence?.enforce && op) {
            guard = await checkMutationGuardInTransaction(transaction, {
              db: this.db, namespace: this.fence.namespace, operation: op,
              pendingClaim, timer,
              identityKey: requireFenceKey(this.fence),
              now: this.nowProvider, completeOperation: false,
            });
          }
          const snap = await transaction.get(docRef);
          const current = snap.data() as StoredUpstreamRecord<G> | undefined;
          if (!current || current.leaseOwner !== (pendingClaim?.ownerStorageId ?? leaseOwner) ||
            (current.ambiguousOperationId ?? null) !== (pendingClaim?.storageId ?? operationId) || current.ambiguousOutcome || current.ambiguousRemoteOutcome ||
            (pendingClaim && (current.operationId !== pendingClaim.storageId || current.grantVersion !== pendingClaim.grantVersion ||
              current.familyGeneration !== pendingClaim.familyGeneration || current.leaseExpiresAt !== pendingClaim.leaseExpiresAt))) {
            throw new UpstreamUnavailableError('Upstream claim changed before rejection was recorded');
          }
          guard?.assertPreWrite();
          transaction.set(docRef, { leaseOwner: null, leaseUntil: null, leaseExpiresAt: null, operationId: null, ambiguousOperationId: null }, { merge: true });
          if (pendingClaim && this.fence?.enforce) {
            transaction.set(getCutoverOperationDocRef(this.db, this.fence.namespace, pendingClaim.operationId, requireFenceKey(this.fence)),
              { phase: 'admitted', ambiguousRemoteOutcome: false, familyId: FieldValue.delete(), updatedAt: this.nowProvider() }, { merge: true });
          }
          timer.assertUnderDeadline('upstream rejection pre-return');
        });
        if (op?.trackWriter) await op.trackWriter(release); else await release();
        op?.clearAmbiguousRemoteOutcome();
        throw err;
      }

      const reasonCode: AmbiguousGrantReasonCode =
        (err instanceof Error && /timeout|timed out|econnreset|econnrefused|408|504/i.test(err.message))
          ? 'upstream_timeout'
          : 'upstream_transport_error';

      if (this.fence?.enforce && op) op.markAmbiguousRemoteOutcome(reasonCode);

      const markAmbiguous = async () => this.db.runTransaction(async (transaction) => {
        const timer = startMonotonicTimer();
        let guard: GuardMutationResult | undefined;
        if (this.fence?.enforce && op) {
          guard = await checkMutationGuardInTransaction(transaction, {
            db: this.db, namespace: this.fence.namespace, operation: op,
            pendingClaim, identityKey: requireFenceKey(this.fence), timer,
            now: this.nowProvider, completeOperation: false,
          });
        }
        const snap = await transaction.get(docRef);
        const current = snap.data() as StoredUpstreamRecord<G> | undefined;
        if (!current || current.leaseOwner !== (pendingClaim?.ownerStorageId ?? leaseOwner) ||
          (current.ambiguousOperationId ?? null) !== (pendingClaim?.storageId ?? operationId) ||
          (pendingClaim && (current.operationId !== pendingClaim.storageId ||
            current.familyGeneration !== pendingClaim.familyGeneration || current.grantVersion !== pendingClaim.grantVersion ||
            current.leaseUntil !== pendingClaim.leaseExpiresAt || current.leaseExpiresAt !== pendingClaim.leaseExpiresAt))) {
          throw new UpstreamUnavailableError('Upstream claim changed before ambiguity was recorded');
        }
        guard?.assertPreWrite();
        transaction.set(docRef, { ambiguousOutcome: true, ambiguousReason: reasonCode, ambiguousAt: this.nowProvider() }, { merge: true });
        timer.assertUnderDeadline('upstream ambiguity pre-return');
      });
      try {
        if (op?.trackWriter) await op.trackWriter(markAmbiguous); else await markAmbiguous();
      } catch (markError) {
        throw new UpstreamUnavailableError('Upstream grant outcome is unresolved', { cause: markError });
      }


      if (err instanceof UpstreamUnavailableError) {
        throw err;
      }
      throw new UpstreamUnavailableError(err instanceof Error ? err.message : String(err));
    }
    if (!refreshed) throw new UpstreamUnavailableError('Upstream refresh returned no grant');
    const committedRefresh = refreshed;

    // Remote grant succeeded! Commit locally:
    const commitNow = options?.now ?? this.nowProvider();
    try {
      let commitGuard: GuardMutationResult | undefined;
      const runCommitTx = async () => {
        return await this.db.runTransaction(async (transaction) => {
          const timer = startMonotonicTimer();
          let guard: GuardMutationResult | undefined;
          if (this.fence?.enforce) {
            if (!op || !pendingClaim) throw new CutoverFenceError('Complete pending claim is required');
            guard = await checkMutationGuardInTransaction(transaction, {
              db: this.db,
              namespace: this.fence.namespace,
              operation: op,
              pendingClaim, timer,
              identityKey: requireFenceKey(this.fence),
              now: this.nowProvider,
              completeOperation: options?.completeOperation ?? true,
            });
            commitGuard = guard;
          }
          const snap = await transaction.get(docRef);
          if (!snap.exists) {
            throw new UpstreamRevokedError('Grant document deleted during refresh');
          }
          const current = snap.data() as StoredUpstreamRecord<G>;
          if (current.leaseOwner !== (pendingClaim?.ownerStorageId ?? leaseOwner) ||
            (current.ambiguousOperationId ?? null) !== (pendingClaim?.storageId ?? operationId) ||
            current.ambiguousOutcome || current.ambiguousRemoteOutcome || (pendingClaim && (current.operationId !== pendingClaim.storageId ||
              current.familyGeneration !== pendingClaim.familyGeneration || current.grantVersion !== pendingClaim.grantVersion ||
              current.leaseUntil !== pendingClaim.leaseExpiresAt || current.leaseExpiresAt !== pendingClaim.leaseExpiresAt))) {
            throw new UpstreamUnavailableError('Lease owner changed during refresh');
          }

          const nextVersion = nextGrantVersion(current, committedRefresh.grant);
          const isTerminal = options?.completeOperation !== false;
          if (isTerminal) {
            guard?.bufferCompletion(commitNow);
          }
          guard?.assertPreWrite();
          transaction.set(
            docRef,
            stripUndefined({
              grant: committedRefresh.grant,
              expiresAt: committedRefresh.expiresAt,
              leaseUntil: isTerminal ? null : (pendingClaim?.leaseExpiresAt ?? now + leaseMs),
              leaseExpiresAt: isTerminal ? null : pendingClaim?.leaseExpiresAt,
              leaseOwner: isTerminal ? null : (pendingClaim?.ownerStorageId ?? leaseOwner),
              operationId: isTerminal ? null : pendingClaim?.storageId,
              grantVersion: nextVersion,
              ambiguousOutcome: null,
              ambiguousReason: null,
              ambiguousAt: null,
              ambiguousOperationId: isTerminal ? null : (pendingClaim?.storageId ?? operationId),
              updatedAt: Math.max(commitNow, (current.updatedAt ?? 0) + 1),
            }),
            { merge: true },
          );
          timer.assertUnderDeadline('upstream commit pre-return');
          return pendingClaim ? { ...pendingClaim, grantVersion: nextVersion } : undefined;
        });
      };
      const finalizedClaim = op?.trackWriter ? await op.trackWriter(runCommitTx) : await runCommitTx();
      commitGuard?.onCommit();
      if (options?.completeOperation !== false) op?.clearAmbiguousRemoteOutcome();
      return {
        grant: committedRefresh.grant,
        completion: options?.completeOperation === false
          ? finalizedClaim
            ? { familyId, leaseOwner, operationId: finalizedClaim.operationId, pendingClaim: finalizedClaim }
            : { familyId, leaseOwner, operationId: null }
          : null,
      };
    } catch (err) {
      if (this.fence?.enforce && op) op.markAmbiguousRemoteOutcome('local_commit_failure');
      throw err;
    }
  }

  async reconcileAmbiguousGrant(
    _familyId: string,
    _grant: G,
    _expiresAt: number | undefined,
    _options: { operationId: string; operation?: LegacyOperationContext },
  ): Promise<void> {
    throw new CutoverFenceError(
      'Ambiguous upstream grant reconciliation is refused: provider-backed durable evidence mechanism is not available in legacy bridge; ambiguous grants remain permanently held',
    );
  }
}
