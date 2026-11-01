// Copied from @phoneware/mcp-oauth-kit 1.0.0 (phoneware/monorepo packages/mcp-oauth-kit/src/upstream-grant.ts at 4ea97b0d2599a3372ea37b47977333c2827c443c). Edit the canonical file, then re-copy.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Firestore } from '@google-cloud/firestore';
import {
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
  type GuardMutationResult,
  type LegacyOperationContext,
} from './cutover-fence.js';

export interface StoredUpstreamRecord<G> {
  grant: G;
  expiresAt?: number;
  leaseUntil?: number;
  leaseOwner?: string;
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
  put(familyId: string, grant: G, expiresAt?: number): Promise<void>;
  get(familyId: string): Promise<StoredUpstreamRecord<G> | undefined>;
  delete(familyId: string): Promise<void>;
  ensureFresh(
    familyId: string,
    refresh: (currentGrant: G) => Promise<{ grant: G; expiresAt?: number }>,
    options?: EnsureFreshOptions,
  ): Promise<G>;
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
    options?: { operation?: LegacyOperationContext },
  ): Promise<void> {
    const docRef = this.db.collection(this.collection).doc(docId(familyId));
    if (this.fence?.enforce) {
      await this.db.runTransaction(async (transaction) => {
        const guard = await checkMutationGuardInTransaction(transaction, {
          db: this.db,
          namespace: this.fence!.namespace,
          operation: options?.operation,
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
      await this.db.runTransaction(async (transaction) => {
        const guard = await checkMutationGuardInTransaction(transaction, {
          db: this.db,
          namespace: this.fence!.namespace,
          operation: options?.operation,
          now: this.nowProvider,
        });
        guard.bufferCompletion(this.nowProvider());
        transaction.delete(docRef);
      });
      return;
    }

    await docRef.delete();
  }

  async ensureFresh(
    familyId: string,
    refresh: (currentGrant: G) => Promise<{ grant: G; expiresAt?: number }>,
    options?: EnsureFreshOptions & { operation?: LegacyOperationContext },
  ): Promise<G> {
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
      const isExpiring = !current.expiresAt || current.expiresAt - skewMs <= now;

      if (!force && !isExpiring) {
        return { status: 'fresh' as const, grant: current.grant };
      }

      const activeLease = current.leaseUntil && current.leaseUntil > now;
      if (activeLease) {
        return { status: 'leased' as const, current };
      }

      transaction.set(
        docRef,
        stripUndefined({
          ...current,
          leaseUntil: now + leaseMs,
          leaseOwner,
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
        const refreshedCommitted =
          !checkData.leaseUntil || (checkData.expiresAt && checkData.expiresAt - skewMs > Date.now());
        if (refreshedCommitted) {
          return checkData.grant;
        }
      }

      const fallbackSnap = await docRef.get();
      if (fallbackSnap.exists) {
        const fallbackData = fallbackSnap.data() as StoredUpstreamRecord<G>;
        if (fallbackData.expiresAt && fallbackData.expiresAt > now) {
          return fallbackData.grant;
        }
      }
      throw new UpstreamUnavailableError('Timed out waiting for upstream token refresh');
    }

    // claimResult.status === 'claimed': instance holds the lease
    try {
      const refreshed = await refresh(claimResult.grant);
      const commitNow = options?.now ?? this.nowProvider();

      await this.db.runTransaction(async (transaction) => {
        let guard: GuardMutationResult | undefined;
        if (this.fence?.enforce) {
          guard = await checkMutationGuardInTransaction(transaction, {
            db: this.db,
            namespace: this.fence.namespace,
            operation: options?.operation,
            now: this.nowProvider,
            completeOperation: true,
          });
        }

        const snap = await transaction.get(docRef);
        if (!snap.exists) {
          throw new UpstreamRevokedError('Grant document deleted during refresh');
        }
        const current = snap.data() as StoredUpstreamRecord<G>;
        if (current.leaseOwner && current.leaseOwner !== leaseOwner) {
          throw new UpstreamUnavailableError('Lease owner changed during refresh');
        }

        guard?.bufferCompletion(commitNow);
        transaction.set(
          docRef,
          stripUndefined({
            grant: refreshed.grant,
            expiresAt: refreshed.expiresAt,
            leaseUntil: null,
            leaseOwner: null,
            updatedAt: commitNow,
          }),
          { merge: true },
        );
      });

      return refreshed.grant;
    } catch (err) {
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
      if (kitCodeOf(err)) throw err;

      const classification = classifyUpstreamTokenResponse(
        0,
        err instanceof Error ? err.message : String(err),
      );
      if (classification === 'definitive') {
        await this.delete(familyId, options);
        throw new UpstreamRevokedError(err instanceof Error ? err.message : String(err));
      }

      const snap = await docRef.get();
      if (snap.exists) {
        const data = snap.data() as StoredUpstreamRecord<G>;
        if (data.expiresAt && data.expiresAt > now) {
          return data.grant;
        }
      }

      throw new UpstreamUnavailableError(err instanceof Error ? err.message : String(err));
    }
  }
}
