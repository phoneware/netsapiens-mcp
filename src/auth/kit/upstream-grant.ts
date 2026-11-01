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
import {
  type CutoverFenceConfig,
  checkMutationGuardInTransaction,
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
  leaseUntil?: number;
  leaseOwner?: string;
  ambiguousOutcome?: boolean | null;
  ambiguousReason?: AmbiguousGrantReasonCode | null;
  ambiguousAt?: number | null;
  ambiguousOperationId?: string | null;
  updatedAt?: number;
}

export interface EnsureFreshOptions {
  force?: boolean;
  skewMs?: number;
  leaseMs?: number;
  waitMs?: number;
  pollIntervalMs?: number;
  now?: number;
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
      const op = options?.operation ?? requestOperationContext.getStore();
      if (!op) {
        throw new CutoverFenceError(
          `Durable operation context is required for fence-enforced put in namespace ${this.fence.namespace}`,
        );
      }
      await this.db.runTransaction(async (transaction) => {
        const guard = await checkMutationGuardInTransaction(transaction, {
          db: this.db,
          namespace: this.fence!.namespace,
          operation: op,
          completeOperation: options?.completeOperation,
          now: this.nowProvider,
        });
        guard.bufferCompletion(this.nowProvider());
        transaction.set(
          docRef,
          stripUndefined({
            grant,
            expiresAt,
            updatedAt: this.nowProvider(),
          }),
          { merge: true },
        );
      });
      return;
    }

    await docRef.set(
      stripUndefined({
        grant,
        expiresAt,
        updatedAt: this.nowProvider(),
      }),
      { merge: true },
    );
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
      if (!op) {
        throw new CutoverFenceError(
          `Durable operation context is required for fence-enforced delete in namespace ${this.fence.namespace}`,
        );
      }
      await this.db.runTransaction(async (transaction) => {
        const guard = await checkMutationGuardInTransaction(transaction, {
          db: this.db,
          namespace: this.fence!.namespace,
          operation: op,
          now: this.nowProvider,
        });
        transaction.delete(docRef);
      });
      return;
    }

    await docRef.delete();
  }

  async ensureFresh(
    familyId: string,
    refresh: (currentGrant: G) => Promise<{ grant: G; expiresAt?: number }>,
    options?: EnsureFreshOptions & { operation?: LegacyOperationContext; completeOperation?: boolean },
  ): Promise<G> {
    const op = options?.operation ?? requestOperationContext.getStore();
    if (this.fence?.enforce && !op) {
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
      let guard: GuardMutationResult | undefined;
      if (this.fence?.enforce) {
        guard = await checkMutationGuardInTransaction(transaction, {
          db: this.db,
          namespace: this.fence.namespace,
          operation: options?.operation,
          now: this.nowProvider,
          completeOperation: false,
        });
      }
      const snap = await transaction.get(docRef);
      if (!snap.exists) {
        throw new UpstreamRevokedError('No upstream grant found for session');
      }

      const current = snap.data() as StoredUpstreamRecord<G>;

      if (current.ambiguousOutcome) {
        throw new UpstreamUnavailableError(
          `Upstream grant has an unresolved ambiguous outcome: ${current.ambiguousReason ?? 'pending reconciliation'}`,
        );
      }

      const activeLease = current.leaseUntil && current.leaseUntil > now;
      if (activeLease) {
        return { status: 'leased' as const, current };
      }

      if (this.fence?.enforce && current.ambiguousOperationId) {
        const priorOpRef = getCutoverOperationDocRef(this.db, this.fence.namespace, current.ambiguousOperationId);
        const priorOpSnap = await transaction.get(priorOpRef);
        if (!priorOpSnap.exists) {
          throw new CutoverFenceError(
            'Upstream grant references missing ambiguous operation; fail closed',
          );
        }
        const priorOp = priorOpSnap.data() as LegacyOperationRecord;
        if (priorOp.phase !== 'completed' && priorOp.phase !== 'failed') {
          throw new UpstreamUnavailableError(
            `Upstream grant is locked by in-flight or unresolved operation in phase ${priorOp.phase}`,
          );
        }
      }
      const isExpiring = !current.expiresAt || current.expiresAt - skewMs <= now;
      if (!force && !isExpiring) {
        return { status: 'fresh' as const, grant: current.grant };
      }

      const op = options?.operation ?? requestOperationContext.getStore();
      if (this.fence?.enforce && op) {
        const opRef = getCutoverOperationDocRef(this.db, this.fence.namespace, op.id);
        transaction.set(
          opRef,
          { phase: 'upstream_pending', familyId, updatedAt: now },
          { merge: true },
        );
        op.markAmbiguousRemoteOutcome('remote_grant_in_flight');
      }

      transaction.set(
        docRef,
        stripUndefined({
          ...current,
          leaseUntil: now + leaseMs,
          leaseOwner,
          ambiguousOperationId: this.fence?.enforce && op ? op.id : undefined,
          updatedAt: now,
        }),
        { merge: true },
      );

      return { status: 'claimed' as const, grant: current.grant };
    });

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
        if (checkData.ambiguousOutcome) {
          throw new UpstreamUnavailableError(
            `Upstream grant has an unresolved ambiguous outcome: ${checkData.ambiguousReason ?? 'pending reconciliation'}`,
          );
        }
        const refreshedCommitted = !checkData.leaseUntil;
        if (refreshedCommitted) {
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
        await this.db.runTransaction(async (transaction) => {
          const snap = await transaction.get(docRef);
          if (snap.exists) {
            const current = snap.data() as StoredUpstreamRecord<G>;
            if (current.leaseOwner === leaseOwner) {
              transaction.delete(docRef);
            }
          }
        }).catch(() => {});


        if (err instanceof UpstreamRevokedError) {
          throw err;
        }
        throw new UpstreamRevokedError(err instanceof Error ? err.message : String(err));
      }

      const reasonCode: AmbiguousGrantReasonCode =
        (err instanceof Error && /timeout|timed out|econnreset|econnrefused|408|504/i.test(err.message))
          ? 'upstream_timeout'
          : 'upstream_transport_error';

      const op = options?.operation ?? requestOperationContext.getStore();
      if (this.fence?.enforce && op) {
        op.markAmbiguousRemoteOutcome(reasonCode);
        const opRef = getCutoverOperationDocRef(this.db, this.fence.namespace, op.id);
        await this.db.runTransaction(async (transaction) => {
          transaction.set(
            opRef,
            {
              phase: 'upstream_pending',
              ambiguousRemoteOutcome: true,
              familyId,
              updatedAt: this.nowProvider(),
            },
            { merge: true },
          );
          transaction.set(
            docRef,
            {
              ambiguousOutcome: true,
              ambiguousReason: reasonCode,
              ambiguousAt: this.nowProvider(),
              ambiguousOperationId: op.id,
            },
            { merge: true },
          );
        }).catch(() => {});
      }

      if (!this.fence?.enforce || !op) {
        await this.db.runTransaction(async (transaction) => {
          const snap = await transaction.get(docRef);
          if (snap.exists) {
            const current = snap.data() as StoredUpstreamRecord<G>;
            if (current.leaseOwner === leaseOwner) {
              transaction.set(
                docRef,
                {
                  leaseUntil: null,
                  leaseOwner: null,
                },
                { merge: true },
              );
            }
          }
        }).catch(() => {});
      }

      const snap = await docRef.get();
      if (snap.exists) {
        const data = snap.data() as StoredUpstreamRecord<G>;
        if (!data.ambiguousOutcome && data.expiresAt && data.expiresAt > now) {
          return data.grant;
        }
      }

      if (err instanceof UpstreamUnavailableError) {
        throw err;
      }
      throw new UpstreamUnavailableError(err instanceof Error ? err.message : String(err));
    }

    // Remote grant succeeded! Commit locally:
    const commitNow = options?.now ?? this.nowProvider();
    try {
      await this.db.runTransaction(async (transaction) => {
        let guard: GuardMutationResult | undefined;
        if (this.fence?.enforce) {
          const op = options?.operation ?? requestOperationContext.getStore();
          guard = await checkMutationGuardInTransaction(transaction, {
            db: this.db,
            namespace: this.fence.namespace,
            operation: op,
            now: this.nowProvider,
            completeOperation: options?.completeOperation ?? true,
          });
        }

        const snap = await transaction.get(docRef);
        if (!snap.exists) {
          throw new UpstreamRevokedError('Grant document deleted during refresh');
        }
        const current = snap.data() as StoredUpstreamRecord<G>;
        if (!current.leaseOwner || current.leaseOwner !== leaseOwner) {
          throw new UpstreamUnavailableError('Lease owner changed during refresh');
        }

        const isTerminal = options?.completeOperation !== false;
        if (isTerminal) {
          guard?.bufferCompletion(commitNow);
        }
        transaction.set(
          docRef,
          stripUndefined({
            grant: refreshed.grant,
            expiresAt: refreshed.expiresAt,
            leaseUntil: isTerminal ? null : (now + leaseMs),
            leaseOwner: isTerminal ? null : leaseOwner,
            ambiguousOutcome: null,
            ambiguousReason: null,
            ambiguousAt: null,
            ambiguousOperationId: isTerminal ? null : op?.id,
            updatedAt: commitNow,
          }),
          { merge: true },
        );
      });

      return refreshed.grant;
    } catch (err) {
      const op = options?.operation ?? requestOperationContext.getStore();
      if (this.fence?.enforce && op) {
        op.markAmbiguousRemoteOutcome('local_commit_failure');
        const opRef = getCutoverOperationDocRef(this.db, this.fence.namespace, op.id);
        await this.db.runTransaction(async (transaction) => {
          transaction.set(
            opRef,
            {
              phase: 'upstream_pending',
              ambiguousRemoteOutcome: true,
              familyId,
              updatedAt: this.nowProvider(),
            },
            { merge: true },
          );
          transaction.set(
            docRef,
            {
              ambiguousOutcome: true,
              ambiguousReason: 'local_commit_failure',
              ambiguousAt: this.nowProvider(),
              ambiguousOperationId: op.id,
            },
            { merge: true },
          );
        }).catch(() => {});
      }
      throw err;
    }
  }

  async reconcileAmbiguousGrant(
    familyId: string,
    grant: G | null,
    expiresAt: number | undefined,
    options: { operationId: string; operation?: LegacyOperationContext; outcome?: 'success' | 'failure' },
  ): Promise<void> {
    const docRef = this.db.collection(this.collection).doc(docId(familyId));
    const now = this.nowProvider();

    if (!options?.operationId) {
      throw new CutoverFenceError('Cannot reconcile grant: options.operationId is required');
    }
    await this.db.runTransaction(async (transaction) => {
      const grantSnap = await transaction.get(docRef);
      if (!grantSnap.exists) {
        throw new CutoverFenceError('Cannot reconcile grant: document does not exist');
      }
      const currentGrant = grantSnap.data() as StoredUpstreamRecord<G>;
      if (!currentGrant.ambiguousOutcome) {
        throw new CutoverFenceError('Cannot reconcile grant: grant does not have an ambiguous outcome');
      }

      if (currentGrant.ambiguousOperationId && options.operationId !== currentGrant.ambiguousOperationId) {
        throw new CutoverFenceError('Cannot reconcile grant: operationId mismatch');
      }

      if (this.fence?.enforce) {
        const controlRef = getCutoverFenceDocRef(this.db, this.fence.namespace);
        const control = await readCutoverFenceInTransaction(transaction, this.db, this.fence.namespace);
        if (['migrating', 'v3_ready', 'v3_active'].includes(control.state)) {
          throw new CutoverRefusedError(
            `Cannot reconcile legacy upstream grant: cutover state is ${control.state}`,
            { cutoverState: control.state, epoch: control.epoch },
          );
        }

        const opRef = getCutoverOperationDocRef(this.db, this.fence.namespace, options.operationId);
        const opSnap = await transaction.get(opRef);
        if (!opSnap.exists) {
          throw new CutoverFenceError(`Ambiguous operation record missing: ${options.operationId}`);
        }
        const opData = opSnap.data() as LegacyOperationRecord;
        if (opData.familyId && opData.familyId !== familyId) {
          throw new CutoverFenceError(
            `Operation family mismatch: expected ${familyId}, got ${opData.familyId}`,
          );
        }
        if (!opData.ambiguousRemoteOutcome && opData.phase !== 'upstream_pending') {
          throw new CutoverFenceError(`Operation ${options.operationId} is not ambiguous or pending`);
        }

        const isFailure = options?.outcome === 'failure' || grant === null;
        const resolvedPhase = isFailure ? 'failed' : 'completed';
        transaction.set(
          opRef,
          {
            phase: resolvedPhase,
            ambiguousRemoteOutcome: false,
            updatedAt: now,
          },
          { merge: true },
        );
        if (control.activeOperations <= 0) {
          throw new CutoverFenceError(
            `Active operations underflow on reconciliation for namespace ${this.fence.namespace}: count is ${control.activeOperations}`,
          );
        }
        transaction.set(
          controlRef,
          {
            activeOperations: control.activeOperations - 1,
            updatedAt: now,
          },
          { merge: true },
        );
      }

      const isFailure = options?.outcome === 'failure' || grant === null;
      if (isFailure) {
        transaction.set(
          docRef,
          {
            leaseUntil: null,
            leaseOwner: null,
            ambiguousOutcome: null,
            ambiguousReason: null,
            ambiguousAt: null,
            ambiguousOperationId: null,
            updatedAt: now,
          },
          { merge: true },
        );
      } else {
        transaction.set(
          docRef,
          stripUndefined({
            grant,
            expiresAt,
            leaseUntil: null,
            leaseOwner: null,
            ambiguousOutcome: null,
            ambiguousReason: null,
            ambiguousAt: null,
            ambiguousOperationId: null,
            updatedAt: now,
          }),
          { merge: true },
        );
      }
    });
  }
}
