import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DocumentReference, Firestore } from '@google-cloud/firestore';
import {
  CutoverFenceError,
  CutoverRefusedError,
  UpstreamRevokedError,
  UpstreamUnavailableError,
  classifyUpstreamTokenResponse,
  kitCodeOf,
} from './errors.js';
import { docId } from './firestore-ledger.js';
import { stripUndefined } from './strip-undefined.js';
import type { StoredRefreshFamily } from './ledger.js';
import {
  type CutoverFenceConfig,
  canonicalJsonStringify,
  checkMutationGuardInTransaction,
  requireFenceIdentityKey,
  claimUpstreamGrantInTransaction,
  getCutoverOperationDocRef,
  startMonotonicTimer,
  type GuardMutationResult,
  type LegacyOperationContext,
} from './cutover-fence.js';

export type AmbiguousGrantReasonCode =
  | 'upstream_timeout'
  | 'upstream_transport_error'
  | 'local_commit_failure'
  | 'remote_grant_in_flight'
  | 'upstream_untrusted_definitive';
function isSameGrant<G>(a: G | undefined, b: G | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  try {
    return canonicalJsonStringify(a) === canonicalJsonStringify(b);
  } catch {
    return false;
  }
}

export interface StoredUpstreamRecord<G> {
  grant: G;
  grantVersion?: number;
  version?: number;
  expiresAt?: number;
  leaseUntil?: number | null;
  leaseExpiresAt?: number | null;
  leaseOwner?: string | null;
  ambiguousOutcome?: boolean | null;
  ambiguousRemoteOutcome?: boolean | null;
  ambiguousReason?: AmbiguousGrantReasonCode | string | null;
  ambiguousAt?: number | null;
  ambiguousOperationId?: string | null;
  operationId?: string | null;
  familyGeneration?: number | null;
  updatedAt?: number;
}

export function assertGrantWritable<G>(record: StoredUpstreamRecord<G> | undefined): void {
  if (record && (record.operationId != null || record.ambiguousOperationId != null ||
    record.leaseOwner != null || record.leaseUntil != null || record.leaseExpiresAt != null ||
    record.ambiguousOutcome || record.ambiguousRemoteOutcome)) {
    throw new UpstreamUnavailableError('Upstream grant has an unresolved claim or lease; put refused');
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

export function nextGrantVersion<G>(current: StoredUpstreamRecord<G> | undefined, grant: G): number {
  const previous = current?.grantVersion ?? current?.version ?? 1;
  if (!Number.isSafeInteger(previous) || previous < 1) throw new CutoverFenceError('Upstream grant version is invalid');
  const changed = current !== undefined && !isSameGrant(stripUndefined(current.grant), mergedGrantValue(current.grant, stripUndefined(grant)));
  const next = previous + (changed ? 1 : 0);
  if (!Number.isSafeInteger(next)) throw new CutoverFenceError('Upstream grant version is invalid');
  return next;
}
export class RefreshSupersededError extends Error {
  constructor(message = 'The refresh target is no longer current') {
    super(message);
    this.name = 'RefreshSupersededError';
  }
}


export interface EnsureFreshOptions {
  force?: boolean;
  skewMs?: number;
  leaseMs?: number;
  waitMs?: number;
  pollIntervalMs?: number;
  now?: number;
  expectedFamilyGeneration?: number;
  expectedGrantVersion?: number;
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
  ): Promise<G>;
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
  ): Promise<G> {
    const record = this.records.get(familyId);
    if (!record) {
      throw new UpstreamRevokedError('No upstream grant found for session');
    }

    const now = options?.now ?? this.nowProvider();
    const skewMs = options?.skewMs ?? 300_000;
    const force = options?.force ?? false;

    const isExpiring = !record.expiresAt || record.expiresAt - skewMs <= now;
    if (!force && !isExpiring) {
      return record.grant;
    }

    try {
      const refreshed = await refresh(record.grant);
      this.records.set(familyId, {
        grant: refreshed.grant,
        expiresAt: refreshed.expiresAt,
        updatedAt: now,
      });
      return refreshed.grant;
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
        return record.grant;
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
    this.fence = opts.fence;
  }

  async put(
    familyId: string,
    grant: G,
    expiresAt?: number,
    options?: { operation?: LegacyOperationContext; completeOperation?: boolean },
  ): Promise<void> {
    const docRef = this.db.collection(this.collection).doc(docId(familyId));
    if (this.fence?.enforce) {
      if (!options?.operation) {
        throw new CutoverFenceError(
          `Durable operation context is required for fence-enforced put in namespace ${this.fence.namespace}`,
        );
      }
      const operation = options.operation;
      let onCommitCallback: (() => void) | undefined;
      await this.db.runTransaction(async (transaction) => {
        const timer = startMonotonicTimer();
        const snap = await transaction.get(docRef);
        const currentData = snap.exists ? (snap.data() as StoredUpstreamRecord<G>) : undefined;
        assertGrantWritable(currentData);
        const grantVersion = nextGrantVersion(currentData, grant);
        const guard = await checkMutationGuardInTransaction(transaction, {
          db: this.db,
          namespace: this.fence!.namespace,
          operation,
          identityKey: requireFenceIdentityKey(this.fence),
          completeOperation: options?.completeOperation,
          now: this.nowProvider,
          timer,
        });
        guard.assertPreWrite();
        guard.bufferCompletion(this.nowProvider());
        onCommitCallback = guard.onCommit;
        transaction.set(
          docRef,
          stripUndefined({
            grant,
            grantVersion,
            expiresAt,
            updatedAt: this.nowProvider(),
          }),
          { merge: true },
        );
        guard.assertPreReturn();
      });
      if (onCommitCallback) {
        onCommitCallback();
      }
      return;
    }

    await this.db.runTransaction(async (transaction) => {
      const snap = await transaction.get(docRef);
      const current = snap.exists ? (snap.data() as StoredUpstreamRecord<G>) : undefined;
      assertGrantWritable(current);
      const grantVersion = nextGrantVersion(current, grant);
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
      if (!options?.operation) {
        throw new CutoverFenceError(
          `Durable operation context is required for fence-enforced delete in namespace ${this.fence.namespace}`,
        );
      }
      const operation = options.operation;
      let onCommitCallback: (() => void) | undefined;
      await this.db.runTransaction(async (transaction) => {
        const timer = startMonotonicTimer();
        const guard = await checkMutationGuardInTransaction(transaction, {
          db: this.db,
          namespace: this.fence!.namespace,
          operation,
          identityKey: requireFenceIdentityKey(this.fence),
          now: this.nowProvider,
          timer,
        });
        const grantSnapForDelete = await transaction.get(docRef);
        if (grantSnapForDelete.exists) {
          const held = grantSnapForDelete.data() as StoredUpstreamRecord<G>;
          if (held.operationId != null || held.ambiguousOperationId != null || held.leaseOwner != null ||
            held.leaseUntil != null || held.leaseExpiresAt != null || held.ambiguousOutcome) {
            throw new UpstreamUnavailableError('Upstream grant has a live or pending claim; delete refused');
          }
        }
        guard.assertPreWrite();
        guard.bufferCompletion(this.nowProvider());
        onCommitCallback = guard.onCommit;
        transaction.delete(docRef);
        guard.assertPreReturn();
      });
      if (onCommitCallback) {
        onCommitCallback();
      }
      return;
    }

    await docRef.delete();
  }

  async ensureFresh(
    familyId: string,
    refresh: (currentGrant: G) => Promise<{ grant: G; expiresAt?: number }>,
    options?: EnsureFreshOptions & { operation?: LegacyOperationContext; completeOperation?: boolean },
  ): Promise<G> {
    if (this.fence?.enforce) {
      throw new CutoverFenceError('Fenced refresh requires a setup-bound runtime');
    }
    if (this.fence?.enforce && this.collection !== `${this.fence.namespace}_tokens_upstream`) {
      throw new CutoverFenceError('Fenced upstream collection does not match the canonical namespace');
    }
    if (this.fence?.enforce && !options?.operation) {
      throw new CutoverFenceError(
        `Durable operation context is required for fence-enforced ensureFresh in namespace ${this.fence.namespace}`,
      );
    }
    const docRef = this.db.collection(this.collection).doc(docId(familyId));
    const now = options?.now ?? this.nowProvider();
    const skewMs = options?.skewMs ?? 300_000;
    const leaseMs = options?.leaseMs ?? 30_000;
    const waitMs = options?.waitMs ?? 10_000;
    const pollIntervalMs = options?.pollIntervalMs ?? 100;
    const force = options?.force ?? false;
    const leaseOwner = randomUUID();

    const claimResult = await this.db.runTransaction(async (transaction) => {
      const timer = startMonotonicTimer();
      const snap = await transaction.get(docRef);
      if (!snap.exists) {
        throw new UpstreamRevokedError('No upstream grant found for session');
      }

      const current = snap.data() as StoredUpstreamRecord<G>;
      if (this.fence?.enforce && options?.operation) {
        await checkMutationGuardInTransaction(transaction, {
          db: this.db, namespace: this.fence.namespace, operation: options.operation,
          identityKey: requireFenceIdentityKey(this.fence),
          completeOperation: false, timer,
        });
      }

      if (current.ambiguousOutcome) {
        throw new UpstreamUnavailableError(
          `Upstream grant for family has an unresolved ambiguous outcome: ${current.ambiguousReason ?? 'pending reconciliation'}`,
        );
      }

      if (current.leaseOwner) {
        if (!current.leaseUntil || current.leaseUntil <= now) {
          throw new UpstreamUnavailableError('Upstream grant has an unresolved expired lease');
        }
        timer.assertUnderDeadline('ensureFresh leased preReturn');
        return { status: 'leased' as const, current };
      }
      if (current.operationId != null || current.ambiguousOperationId != null ||
        current.leaseUntil != null || current.leaseExpiresAt != null) {
        throw new UpstreamUnavailableError('Upstream grant has an unresolved claim');
      }
      const isExpiring = !current.expiresAt || current.expiresAt - skewMs <= now;
      if (!force && !isExpiring) {
        timer.assertUnderDeadline('ensureFresh fresh preReturn');
        return { status: 'fresh' as const, grant: current.grant };
      }

      if (this.fence?.enforce && options?.operation) {
        const familyCol = `${this.fence.namespace}_tokens_refresh_families`;
        const familySnap = await transaction.get(this.db.collection(familyCol).doc(docId(familyId)));
        if (!familySnap.exists) {
          throw new CutoverFenceError('Family record missing for claim');
        }
        const famData = familySnap.data();
        if (!famData) throw new CutoverFenceError('Family record data is missing for claim');
        const liveFamilyGen = typeof famData.generation === 'number' ? famData.generation : 1;
        const liveGrantVer = typeof current.grantVersion === 'number'
          ? current.grantVersion
          : (typeof current.version === 'number' ? current.version : 1);

        const expectedFamilyGeneration = options?.expectedFamilyGeneration ?? liveFamilyGen;
        const expectedGrantVersion = options?.expectedGrantVersion ?? liveGrantVer;

        const canonicalClaim = await claimUpstreamGrantInTransaction(transaction, this.db, {
          namespace: this.fence.namespace,
          epoch: options.operation.epoch,
          familyId,
          operationId: options.operation.id,
          identityKey: this.fence.identityKey!,
          claimOwner: leaseOwner,
          expectedFamilyGeneration,
          expectedGrantVersion,
          expectedKind: options.operation.kind,
          leaseMs,
          nowProvider: this.nowProvider,
          timer,
        });
        return { status: 'claimed' as const, grant: current.grant, canonicalClaim };
      }

      timer.assertUnderDeadline('ensureFresh claim preWrite');
      transaction.set(
        docRef,
        stripUndefined({
          ...current,
          leaseUntil: now + leaseMs,
          leaseOwner,
        }),
        { merge: true },
      );
      timer.assertUnderDeadline('ensureFresh claimed preReturn');

      return { status: 'claimed' as const, grant: current.grant, canonicalClaim: undefined };
    });

    if (claimResult.status === 'claimed' && this.fence?.enforce && options?.operation) {
      options.operation.markAmbiguousRemoteOutcome('remote_grant_in_flight');
    }

    if (claimResult.status === 'fresh') {
      return claimResult.grant;
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
        if (checkData.ambiguousOutcome) throw new UpstreamUnavailableError('Upstream grant outcome is unresolved');
        const refreshedCommitted = !checkData.leaseOwner && !checkData.leaseUntil &&
          !checkData.leaseExpiresAt && !checkData.operationId && !checkData.ambiguousOperationId;
        if (refreshedCommitted) {
          if ((checkData.updatedAt ?? 0) <= (claimResult.current.updatedAt ?? 0)) {
            throw new UpstreamUnavailableError('Upstream refresh ended without a replacement grant');
          }
          return checkData.grant;
        }
      }

      throw new UpstreamUnavailableError('Timed out waiting for upstream token refresh');
    }

    // claimResult.status === 'claimed': instance holds the lease
    let refreshed: { grant: G; expiresAt?: number } | undefined;
    try {
      refreshed = await refresh(claimResult.grant);
    } catch (err) {
      const code = kitCodeOf(err);
      if (code === 'cutover_refused' || code === 'cutover_fence_error') {
        throw err;
      }

      const isDefinitive =
        code === 'upstream_revoked' ||
        (!code && classifyUpstreamTokenResponse(0, err instanceof Error ? err.message : String(err)) === 'definitive');

      if (isDefinitive) {
        if (this.fence?.enforce && options?.operation) {
          options.operation.markAmbiguousRemoteOutcome('upstream_untrusted_definitive');
          throw new UpstreamUnavailableError(
            'Upstream grant verification pending; held without trusted revocation evidence',
          );
        }

        await this.db.runTransaction(async (transaction) => {
          const timer = startMonotonicTimer();
          const snap = await transaction.get(docRef);
          if (snap.exists) {
            const current = snap.data() as StoredUpstreamRecord<G>;
            if (current.leaseOwner === leaseOwner) {
              timer.assertUnderDeadline('isDefinitive cleanup preWrite');
              transaction.delete(docRef);
            }
          }
          timer.assertUnderDeadline('isDefinitive cleanup preReturn');
        }).catch(() => { });

        if (err instanceof UpstreamRevokedError) {
          throw err;
        }
        throw new UpstreamRevokedError(err instanceof Error ? err.message : String(err));
      }
      const reasonCode: AmbiguousGrantReasonCode =
        (err instanceof Error && /timeout|timed out|econnreset|econnrefused|408|504/i.test(err.message))
          ? 'upstream_timeout'
          : 'upstream_transport_error';

      if (this.fence?.enforce && options?.operation) {
        const op = options.operation;
        op.markAmbiguousRemoteOutcome(reasonCode);
        try {
          await this.db.runTransaction(async (transaction) => {
            const timer = startMonotonicTimer();
            const claim = claimResult.canonicalClaim;
            if (!claim) throw new CutoverFenceError('Complete pending claim is required');
            const guard = await checkMutationGuardInTransaction(transaction, {
              db: this.db, namespace: this.fence!.namespace, operation: op,
              identityKey: requireFenceIdentityKey(this.fence), pendingClaim: claim,
              timer, completeOperation: false,
            });
            guard.assertPreWrite();
            transaction.set(docRef, {
              ambiguousOutcome: true, ambiguousReason: reasonCode, ambiguousAt: this.nowProvider(),
            }, { merge: true });
            timer.assertUnderDeadline('upstream ambiguity pre-return');
          });
        } catch (markError) {
          throw new UpstreamUnavailableError('Upstream grant outcome is unresolved', { cause: markError });
        }
        throw new UpstreamUnavailableError('Upstream grant outcome is unresolved');
      }


      if (err instanceof UpstreamUnavailableError) {
        throw err;
      }
      throw new UpstreamUnavailableError(err instanceof Error ? err.message : String(err));
    }

    // Remote grant succeeded! Commit locally:
    const commitNow = options?.now ?? this.nowProvider();
    try {
      let onCommitCallback: (() => void) | undefined;
      await this.db.runTransaction(async (transaction) => {
        const timer = startMonotonicTimer();
        let guard: GuardMutationResult | undefined;
        if (this.fence?.enforce) {
          if (!options?.operation) throw new CutoverFenceError('Durable operation context is required');
          guard = await checkMutationGuardInTransaction(transaction, {
            db: this.db,
            namespace: this.fence.namespace,
            operation: options?.operation,
            now: this.nowProvider,
            completeOperation: options?.completeOperation ?? true,
            pendingClaim: claimResult.canonicalClaim,
            identityKey: requireFenceIdentityKey(this.fence),
            timer,
          });
          onCommitCallback = guard.onCommit;
        }
        const snap = await transaction.get(docRef);
        if (!snap.exists) {
          throw new UpstreamRevokedError('Grant document deleted during refresh');
        }
        const current = snap.data() as StoredUpstreamRecord<G>;
        if (!current.leaseOwner || (!this.fence?.enforce && current.leaseOwner !== leaseOwner)) {
          throw new UpstreamUnavailableError('Lease owner changed during refresh');
        }
        if (this.fence?.enforce) {
          const claim = claimResult.canonicalClaim;
          if (!claim || !guard || guard.operation.phase !== 'upstream_pending' ||
            guard.operation.familyId !== familyId || current.ambiguousOutcome ||
            current.leaseOwner !== claim.ownerStorageId ||
            current.operationId !== claim.storageId ||
            current.ambiguousOperationId !== claim.storageId ||
            current.familyGeneration !== claim.familyGeneration ||
            current.grantVersion !== claim.grantVersion ||
            current.leaseUntil !== claim.leaseExpiresAt ||
            current.leaseExpiresAt !== claim.leaseExpiresAt) {
            throw new CutoverFenceError('Upstream claim changed before grant commit');
          }
          const familySnap = await transaction.get(
            this.db.collection(`${this.fence.namespace}_tokens_refresh_families`).doc(docId(familyId)),
          );
          if (!familySnap.exists) throw new CutoverFenceError('Family missing before grant commit');
          const family = familySnap.data() as StoredRefreshFamily;
          if (family.id !== familyId || (family.generation ?? 1) !== claim.familyGeneration ||
            !family.currentRefreshToken) {
            throw new CutoverFenceError('Family changed before grant commit');
          }
          const pointerSnap = await transaction.get(
            this.db.collection(`${this.fence.namespace}_tokens_refresh`).doc(docId(family.currentRefreshToken)),
          );
          const pointer = pointerSnap.data();
          if (!pointerSnap.exists || pointer?.familyId !== familyId || pointer.status !== 'active') {
            throw new CutoverFenceError('Refresh pointer changed before grant commit');
          }
        }

        guard?.assertPreWrite();
        guard?.bufferCompletion(commitNow);
        if (this.fence?.enforce && options?.operation && options.completeOperation === false) {
          transaction.set(getCutoverOperationDocRef(this.db, this.fence.namespace, options.operation.id, this.fence.identityKey!),
            { phase: 'admitted', updatedAt: commitNow }, { merge: true });
        }
        const prevVersion = typeof current.grantVersion === 'number'
          ? current.grantVersion
          : (typeof current.version === 'number' ? current.version : 1);
        const grantChanged = !isSameGrant(current.grant, refreshed.grant);
        const nextGrantVersion = grantChanged ? prevVersion + 1 : prevVersion;
        transaction.set(
          docRef,
          stripUndefined({
            grant: refreshed.grant,
            grantVersion: nextGrantVersion,
            expiresAt: refreshed.expiresAt,
            leaseUntil: null,
            leaseExpiresAt: null,
            leaseOwner: null,
            ambiguousOutcome: null,
            ambiguousReason: null,
            ambiguousAt: null,
            ambiguousOperationId: null,
            operationId: null,
            updatedAt: Math.max(commitNow, (current.updatedAt ?? 0) + 1),
          }),
          { merge: true },
        );
        guard?.assertPreReturn();
      });

      if (onCommitCallback) {
        onCommitCallback();
      }
      options?.operation?.clearAmbiguousRemoteOutcome();
      return refreshed.grant;
    } catch (err) {
      if (this.fence?.enforce && options?.operation) {
        const op = options.operation;
        op.markAmbiguousRemoteOutcome('local_commit_failure');
        // The persisted pending claim is the hold, including when commit
        // acknowledgement was lost. Never recreate or overwrite it blindly.
      }
      throw err;
    }
  }

  async reconcileAmbiguousGrant(
    _familyId: string,
    _grant: G,
    _expiresAt: number | undefined,
    _options: { operationId: string; operation?: LegacyOperationContext },
  ): Promise<void> {
    throw new CutoverFenceError('Ambiguous upstream grant reconciliation requires provider-backed durable evidence');
  }

}
