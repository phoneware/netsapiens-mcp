/**
 * Firestore-backed stores for tokens, OAuth clients, and authorization codes.
 *
 * Persists state across container restarts and Cloud Run instances.
 *
 * Collections:
 * - tokens: default mcp_tokens (or readonly_mcp_tokens)
 * - token refresh pointers: default mcp_tokens_refresh
 * - OAuth clients: default mcp_oauth_clients
 * - Authorization codes: default mcp_auth_codes
 */

import { Firestore, Timestamp } from '@google-cloud/firestore';
import { randomBytes, randomUUID } from 'node:crypto';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { TemporarilyUnavailableError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { StoredToken } from './token-store.js';
import type { PendingAuthorization, NsTokenResponse, AuthCodeData } from './types.js';
import { FirestoreTokenLedger, docId, type FirestoreTokenLedgerOptions } from './kit/firestore-ledger.js';
import type { RefreshLookupResult, RefreshRotationResult, StoredRefreshFamily } from './kit/ledger.js';
import type { UpstreamCompletion } from './legacy-kit/ledger.js';
import { FirestoreUpstreamGrantStore, assertGrantWritable as assertGrantNotPending, nextGrantVersion, type AmbiguousGrantReasonCode, type StoredUpstreamRecord } from './kit/upstream-grant.js';
import { FirestoreUpstreamGrantStore as UnfencedGrantStore, RefreshSupersededError, type EnsureFreshResult } from './legacy-kit/upstream-grant.js';
import { FirestoreTokenLedger as UnfencedLedger } from './legacy-kit/firestore-ledger.js';
import { createBoundFencedRuntime, type UpstreamCompletionReceipt } from './kit/bound-fenced-runtime.js';
import { stripUndefined } from './kit/strip-undefined.js';
import { CutoverFenceError, UpstreamUnavailableError, UpstreamRevokedError, kitCodeOf } from './kit/errors.js';
import { UpstreamTimeoutError, UpstreamGrantRejectedError } from './netsapiens-auth-provider.js';
import {
  type CutoverFenceConfig,
  type LegacyOperationContext,
  withLegacyOperation,
 normalizeFenceConfig,
 requireFenceKey,
 assertOperationKey,
 startMonotonicTimer,
  checkMutationGuardInTransaction,
  type GuardMutationResult,
  requestOperationContext,
  type SupportedCutoverNamespace,
} from './kit/cutover-fence.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { logger } from '../utils/logger.js';

function detectNamespace(collection: string): SupportedCutoverNamespace {
  if (collection.startsWith('readonly_mcp')) return 'readonly_mcp';
  if (collection.startsWith('pwmcp')) return 'pwmcp';
  return 'mcp';
}

function toDate(val: unknown): Date | undefined {
  if (!val) return undefined;
  if (val instanceof Date) return val;
  if (val && typeof val === 'object' && 'toDate' in val && typeof (val as { toDate: () => unknown }).toDate === 'function') {
    const res = (val as { toDate: () => unknown }).toDate();
    if (res instanceof Date) return res;
  }
  return undefined;
}

function cleanDoc<T>(value: T): T {
 if (value === null || value === undefined) return value;
 if (Array.isArray(value)) {
    return value.map((v) => cleanDoc(v)) as unknown as T;
 }
 if (value instanceof Date || value instanceof Timestamp) {
  return value;
 }
 if (typeof value === 'object') {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = cleanDoc(v);
      }
  }
  return out as T;
 }
 return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export class RetryableRefreshError extends Error {
 constructor(message = 'Timed out waiting for upstream token refresh') {
  super(message);
  this.name = 'RetryableRefreshError';
 }
}
export class LeaseLostError extends Error {
 constructor(message = 'Refresh lease expired or owned by another instance') {
  super(message);
  this.name = 'LeaseLostError';
 }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NsUpstreamGrant {
 nsAccessToken: string;
 nsRefreshToken?: string;
 nsExpiresAt?: number;
 nsUsername?: string;
 nsUserRole?: string;
 nsApiUrl?: string;
}
interface BoundRuntime {
  grants: {
    ensureFresh(familyId: string, options: { operation: LegacyOperationContext; target: { kind: 'rotate'; refreshToken: string; clientId: string } | { kind: 'access_update'; accessToken: string }; force?: boolean; now?: number; waitMs?: number; pollIntervalMs?: number; leaseMs?: number }): Promise<{ grant: NsUpstreamGrant; completion: UpstreamCompletionReceipt | null }>;
    finalizeAccess(receipt: UpstreamCompletionReceipt, operation: LegacyOperationContext): Promise<StoredToken>;
  };
  ledger: {
    rotate(oldRefreshToken: string, replacement: StoredToken, clientId: string, now?: number, options?: { operation?: LegacyOperationContext; upstreamCompletion?: UpstreamCompletionReceipt | null }): Promise<RefreshRotationResult<StoredToken>>;
  };
}


// ---------------------------------------------------------------------------
// FirestoreTokenStore
// ---------------------------------------------------------------------------

export interface FirestoreTokenStoreOptions {
  collection?: string;
  projectId?: string;
  db?: Firestore;
  now?: () => number;
  fence?: CutoverFenceConfig;
  refreshUpstream?: (grant: NsUpstreamGrant) => Promise<{ grant: NsUpstreamGrant; expiresAt?: number }>;
}

export class FirestoreTokenStore extends FirestoreTokenLedger<StoredToken> {
  private readonly upstreamStore: FirestoreUpstreamGrantStore<NsUpstreamGrant>;
  private readonly unfencedGrantStore?: UnfencedGrantStore<NsUpstreamGrant>;
  private readonly unfencedLedger?: UnfencedLedger<StoredToken>;
  private readonly boundRuntime?: BoundRuntime;
  private readonly localNow: () => number;
  private readonly rawDb: Firestore;
  private readonly tokensCollection: string;
  private readonly refreshColName: string;
  readonly fenceConfig?: CutoverFenceConfig;

  constructor(opts: FirestoreTokenStoreOptions = {}) {
    const defaultCollection = process.env.MCP_READ_ONLY === 'true'
      ? 'readonly_mcp_tokens'
      : 'mcp_tokens';
    const collection = opts.collection ?? defaultCollection;
    const db = opts.db ?? new Firestore({
      projectId: opts.projectId,
      ignoreUndefinedProperties: true,
    });
  const fenceConfig: CutoverFenceConfig | undefined = normalizeFenceConfig(opts.fence);

    const ledgerOptions: FirestoreTokenLedgerOptions<StoredToken> = {
      db,
      collection,
      refreshCollection: `${collection}_refresh`,
      familyCollection: `${collection}_refresh_families`,
      linkedFamilyCollections: [`${collection}_upstream`],
      fence: fenceConfig,
      accessDocExtras: (token) => {
        const ttlAt = token.ttlAt ?? new Date(token.expiresAt + 30 * 24 * 60 * 60 * 1000);
        return { ttlAt };
      },
      legacy: {
        pointerDocs: true,
        embeddedRefreshQuery: true,
        toToken: (raw) => raw as unknown as StoredToken,
        toUpstream: (raw) => {
          if (raw.nsAccessToken) {
            return {
              grant: {
                nsAccessToken: raw.nsAccessToken,
                nsRefreshToken: raw.nsRefreshToken,
                nsExpiresAt: raw.nsExpiresAt,
                nsUsername: raw.nsUsername,
                nsUserRole: raw.nsUserRole,
                nsApiUrl: raw.nsApiUrl,
              },
              expiresAt: typeof raw.nsExpiresAt === 'number' ? raw.nsExpiresAt : undefined,
            };
          }
          return undefined;
        },
        upstreamCollection: `${collection}_upstream`,
      },
      now: opts.now,
    };
    super(ledgerOptions);

    this.rawDb = db;
    this.tokensCollection = collection;
    this.refreshColName = `${collection}_refresh`;
    this.fenceConfig = fenceConfig;
    this.upstreamStore = new FirestoreUpstreamGrantStore<NsUpstreamGrant>({
      db,
      collection: `${collection}_upstream`,
      now: opts.now,
      fence: fenceConfig,
    });
    if (!fenceConfig?.enforce) {
      this.unfencedGrantStore = new UnfencedGrantStore({ db, collection: `${collection}_upstream`, now: opts.now, fence: fenceConfig });
      this.unfencedLedger = new UnfencedLedger(ledgerOptions);
    }
    if (fenceConfig?.enforce) {
      if (!opts.refreshUpstream) throw new CutoverFenceError('Fenced token store requires a startup-bound upstream transport');
      const validateGrant = (value: unknown): NsUpstreamGrant => {
        if (!value || typeof value !== 'object') throw new UpstreamUnavailableError('Invalid upstream grant');
        const grant = value as NsUpstreamGrant;
        if (typeof grant.nsAccessToken !== 'string' || !grant.nsAccessToken.trim() ||
            (grant.nsRefreshToken !== undefined && (typeof grant.nsRefreshToken !== 'string' || !grant.nsRefreshToken.trim())) ||
            (grant.nsExpiresAt !== undefined && (!Number.isFinite(grant.nsExpiresAt) || grant.nsExpiresAt <= 0))) {
          throw new UpstreamUnavailableError('Invalid upstream grant');
        }
        return grant;
      };
      this.boundRuntime = createBoundFencedRuntime<NsUpstreamGrant, StoredToken>({
        db, fence: fenceConfig, ledger: ledgerOptions,
        refresh: opts.refreshUpstream,
        validateGrant,
        applyGrant: (token, grant) => ({ ...token, ...grant }),
        now: opts.now,
      });
    }
    this.localNow = opts.now ?? Date.now;
    logger.info('Firestore token store initialized', {
      collection,
      projectId: opts.projectId,
    });
  }
  get localNowProvider(): () => number {
    return this.localNow;
  }


  get dbInstance(): Firestore {
    return this.rawDb;
  }

 get fenceNamespace(): SupportedCutoverNamespace {
    return this.fenceConfig?.namespace ?? detectNamespace(this.tokensCollection);
  }

  accessDocRef(accessToken: string) {
    return this.rawDb.collection(this.tokensCollection).doc(docId(accessToken));
  }

  refreshDocRef(refreshToken: string) {
    return this.rawDb.collection(this.refreshColName).doc(docId(refreshToken));
  }

  familyDocRef(familyId: string) {
    return this.rawDb.collection(`${this.tokensCollection}_refresh_families`).doc(docId(familyId));
  }

  upstreamDocRef(familyId: string) {
    return this.rawDb.collection(`${this.tokensCollection}_upstream`).doc(docId(familyId));
  }

  private resolveOp(options?: { operation?: LegacyOperationContext }): LegacyOperationContext | undefined {
    const op = options?.operation ?? requestOperationContext.getStore();
  assertOperationKey(this.fenceConfig, op);
    if (op && op.isCompleted()) {
   throw new CutoverFenceError('Completed operation context cannot be reused');
    }
    return op;
  }
  async ensureBoundRotation(familyId: string, refreshToken: string, clientId: string, operation: LegacyOperationContext) {
    if (!this.boundRuntime) throw new CutoverFenceError('Bound runtime is unavailable');
    return this.boundRuntime.grants.ensureFresh(familyId, {
      operation, target: { kind: 'rotate', refreshToken, clientId }, force: true, now: this.localNow(),
    });
  }

  async rotateBound(oldRefreshToken: string, replacement: StoredToken, clientId: string, operation: LegacyOperationContext, completion: UpstreamCompletionReceipt | null) {
    if (!this.boundRuntime) throw new CutoverFenceError('Bound runtime is unavailable');
    return this.boundRuntime.ledger.rotate(oldRefreshToken, replacement, clientId, this.localNow(), {
      operation, upstreamCompletion: completion,
    });
  }


  // Backwards compatibility methods
  async get(accessToken: string, options?: { operation?: LegacyOperationContext }): Promise<StoredToken | undefined> {
    return this.getByAccessToken(accessToken, options);
  }

  async getByRefreshToken(refreshToken: string, options?: { operation?: LegacyOperationContext }): Promise<StoredToken | undefined> {
    const op = this.resolveOp(options);
    const res = await this.lookupRefresh(refreshToken, undefined, this.localNow(), { operation: op });
    if (res.status === 'active' || res.status === 'retry') {
      return res.token;
    }
    return undefined;
  }

 override async lookupRefresh(
  refreshToken: string,
  expectedClientId?: string,
  now?: number,
  options?: { operation?: LegacyOperationContext },
 ): Promise<RefreshLookupResult<StoredToken>> {
  const op = this.resolveOp(options);
  if (this.fenceConfig?.enforce && !op) {
   return withLegacyOperation(
    { db: this.rawDb, namespace: this.fenceNamespace, identityKey: requireFenceKey(this.fenceConfig), kind: 'read', now: this.localNow },
    (ctx) => super.lookupRefresh(refreshToken, expectedClientId, now, { operation: ctx }),
   );
  }
  return super.lookupRefresh(refreshToken, expectedClientId, now, { operation: op });
 }

  async set(token: StoredToken, options?: { operation?: LegacyOperationContext }): Promise<void> {
    await this.issue(token, options);
  }

  override async issue(token: StoredToken, options?: { operation?: LegacyOperationContext }): Promise<StoredToken> {
    const op = this.resolveOp(options);
    if (this.fenceConfig?.enforce && !op) {
      return await withLegacyOperation(
    { db: this.rawDb, namespace: this.fenceNamespace, identityKey: requireFenceKey(this.fenceConfig), kind: 'issue', now: this.localNow },
        async (opCtx) => this.issue(token, { operation: opCtx }),
      );
    }
    return super.issue(token, { operation: op });
  }

  override async rotate(
    oldRefreshToken: string,
    replacement: StoredToken,
    expectedClientId: string,
    now?: number,
  options?: { operation?: LegacyOperationContext; upstreamCompletion?: UpstreamCompletionReceipt | null },
  ): Promise<RefreshRotationResult<StoredToken>> {
    if (options?.upstreamCompletion) {
      throw new CutoverFenceError('Upstream completion requires the paired bound runtime');
    }
    const op = this.resolveOp(options);
    if (this.fenceConfig?.enforce && !op) {
      return await withLegacyOperation(
    { db: this.rawDb, namespace: this.fenceNamespace, identityKey: requireFenceKey(this.fenceConfig), kind: 'rotate', now: this.localNow },
    async (opCtx) => this.rotate(oldRefreshToken, replacement, expectedClientId, now, { ...options, operation: opCtx }),
      );
    }
  return super.rotate(oldRefreshToken, replacement, expectedClientId, now, { ...options, operation: op });
  }

  async rotateUnfenced(oldRefreshToken: string, replacement: StoredToken, clientId: string, now: number, completion: UpstreamCompletion | null, operation?: LegacyOperationContext) {
    if (this.fenceConfig?.enforce || !this.unfencedLedger) throw new CutoverFenceError('Unfenced ledger adapter cannot run with fence enforcement');
    return this.unfencedLedger.rotate(oldRefreshToken, replacement, clientId, now, { operation, upstreamCompletion: completion, useCurrentUpstream: true });
  }

  async ensureUnfencedRotation(familyId: string, refresh: (grant: NsUpstreamGrant) => Promise<{ grant: NsUpstreamGrant; expiresAt?: number }>, refreshToken: string, clientId: string, operation?: LegacyOperationContext) {
    if (this.fenceConfig?.enforce || !this.unfencedGrantStore) throw new CutoverFenceError('Unfenced grant adapter cannot run with fence enforcement');
    return this.unfencedGrantStore.ensureFresh(familyId, refresh, {
      operation, now: this.localNow(), force: true, completeOperation: false,
      expectedRefresh: { ref: this.refreshDocRef(refreshToken), clientId },
    });
  }

  override async getByAccessToken(
    accessToken: string,
    options?: { operation?: LegacyOperationContext },
  ): Promise<StoredToken | undefined> {
    const op = this.resolveOp(options);
    if (this.fenceConfig?.enforce && !op) {
      return await withLegacyOperation(
    { db: this.rawDb, namespace: this.fenceNamespace, identityKey: requireFenceKey(this.fenceConfig), kind: 'read', now: this.localNow },
        async (opCtx) => this.getByAccessToken(accessToken, { operation: opCtx }),
      );
    }
    const token = await super.getByAccessToken(accessToken, { operation: op });
    if (!token) return undefined;
    if (token.ttlAt) {
      const converted = toDate(token.ttlAt);
      if (converted) token.ttlAt = converted;
    }
    if (token.refreshFamilyId) {
      const up = await this.upstreamStore.get(token.refreshFamilyId);
   if (up?.leaseOwner || up?.leaseUntil || up?.leaseExpiresAt || up?.operationId || up?.ambiguousOutcome || up?.ambiguousRemoteOutcome || up?.ambiguousOperationId) return token;
      if (up?.grant) {
        return {
          ...token,
          nsAccessToken: up.grant.nsAccessToken ?? token.nsAccessToken,
          nsRefreshToken: up.grant.nsRefreshToken ?? token.nsRefreshToken,
          nsExpiresAt: up.expiresAt ?? up.grant.nsExpiresAt ?? token.nsExpiresAt,
          nsUsername: up.grant.nsUsername ?? token.nsUsername,
          nsUserRole: up.grant.nsUserRole ?? token.nsUserRole,
          nsApiUrl: up.grant.nsApiUrl ?? token.nsApiUrl,
        };
      }
    }
    return token;
 }

  async update(
    accessToken: string,
    patch: Partial<StoredToken>,
    options?: { operation?: LegacyOperationContext },
  ): Promise<StoredToken | undefined> {
    const op = this.resolveOp(options);
    if (this.fenceConfig?.enforce && !op) {
      return await withLegacyOperation(
    { db: this.rawDb, namespace: this.fenceNamespace, identityKey: requireFenceKey(this.fenceConfig), kind: 'update', now: this.localNow },
        async (opCtx) => this.update(accessToken, patch, { operation: opCtx }),
      );
    }
    const accessRef = this.accessDocRef(accessToken);
    let guardResult: GuardMutationResult | undefined;
    const runTx = async () => {
      return await this.rawDb.runTransaction(async (transaction) => {
    const timer = startMonotonicTimer();
        let guard: GuardMutationResult | undefined;
        const fence = this.fenceConfig;
        if (fence && fence.enforce) {
     if (!op) throw new CutoverFenceError('Durable operation context is required');
          guard = await checkMutationGuardInTransaction(transaction, {
            db: this.rawDb,
            namespace: fence.namespace,
            operation: op,
      identityKey: requireFenceKey(fence),
      timer,
            now: this.localNow,
          });
          guardResult = guard;
        }
        const accessSnap = await transaction.get(accessRef);
    if (!accessSnap.exists) { guard?.assertPreReturn(); return undefined; }
      const existing = accessSnap.data() as StoredToken;
      const updated: StoredToken = { ...existing, ...patch };
      const now = this.localNow();
    const families = new Set([existing.refreshFamilyId, updated.refreshFamilyId].filter((id): id is string => !!id));
    if (patch.refreshToken && patch.refreshToken !== existing.refreshToken) {
     const replacementSnap = await transaction.get(this.refreshDocRef(patch.refreshToken));
     const replacement = replacementSnap.data();
     if (typeof replacement?.familyId === 'string') families.add(replacement.familyId);
     if (typeof replacement?.accessToken === 'string') {
      const pointerSnap = await transaction.get(this.accessDocRef(replacement.accessToken));
      const owner = pointerSnap.data()?.refreshFamilyId;
      if (typeof owner === 'string') families.add(owner);
     }
    }
    const upstreamByFamily = new Map<string, StoredUpstreamRecord<NsUpstreamGrant> | undefined>();
    for (const familyId of families) {
     const upstreamSnap = await transaction.get(this.upstreamDocRef(familyId));
     const upstream = upstreamSnap.data() as StoredUpstreamRecord<NsUpstreamGrant> | undefined;
     assertGrantNotPending(upstream);
     upstreamByFamily.set(familyId, upstream);
    }
    const shouldWriteUpstream = updated.refreshFamilyId && (patch.nsAccessToken || patch.nsRefreshToken || patch.nsExpiresAt);
    const grantPatch = stripUndefined({
     nsAccessToken: updated.nsAccessToken,
     nsRefreshToken: updated.nsRefreshToken,
     nsExpiresAt: updated.nsExpiresAt,
     nsUsername: updated.nsUsername,
     nsUserRole: updated.nsUserRole,
     nsApiUrl: updated.nsApiUrl,
    });
    const currentUpstream = updated.refreshFamilyId ? upstreamByFamily.get(updated.refreshFamilyId) : undefined;
    const grantVersion = shouldWriteUpstream
     ? nextGrantVersion(currentUpstream, { ...currentUpstream?.grant, ...grantPatch })
     : undefined;

      guard?.bufferCompletion(now);
      transaction.set(accessRef, stripUndefined(cleanDoc(updated)), { merge: true });

      if (patch.refreshToken && patch.refreshToken !== existing.refreshToken) {
        const familyId = updated.refreshFamilyId ?? existing.refreshFamilyId ?? randomUUID();
        const oldRefreshRef = this.refreshDocRef(existing.refreshToken);
        const newRefreshRef = this.refreshDocRef(patch.refreshToken);
        transaction.delete(oldRefreshRef);
        transaction.set(newRefreshRef, stripUndefined({
          status: 'active',
          familyId,
          token: updated,
        }));
      }

    if (updated.refreshFamilyId && shouldWriteUpstream) {
        const upstreamRef = this.upstreamDocRef(updated.refreshFamilyId);
        transaction.set(upstreamRef, stripUndefined({
      grant: grantPatch,
      grantVersion,
          expiresAt: updated.nsExpiresAt,
          updatedAt: now,
        }), { merge: true });
      }

    guard?.assertPreReturn();
        return updated;
      });
    };
    const result = op?.trackWriter ? await op.trackWriter(runTx) : await runTx();
  guardResult?.onCommit();
    return result;
  }

 async refreshNsToken(
  accessToken: string,
  doRefresh: (stored: StoredToken) => Promise<{ access_token: string; refresh_token?: string; expires_in?: number }>,
  opts?: { maxWaitMs?: number; pollIntervalMs?: number; leaseDurationMs?: number; operation?: LegacyOperationContext; force?: boolean },
 ): Promise<StoredToken> {
  const op = this.resolveOp(opts);
  if (this.fenceConfig?.enforce && !op) {
    return await withLegacyOperation(
    { db: this.rawDb, namespace: this.fenceNamespace, identityKey: requireFenceKey(this.fenceConfig), kind: 'upstream_refresh', now: this.localNow },
      async (opCtx) => this.refreshNsToken(accessToken, doRefresh, { ...opts, operation: opCtx }),
    );
  }

  const stored = await this.getByAccessToken(accessToken, { operation: op });
  if (!stored) {
    throw new Error('Token document not found');
  }
  const familyId = stored.refreshFamilyId;
  if (!familyId) {
    throw new Error('Token document missing refreshFamilyId');
  }
  if (this.boundRuntime) {
    if (!op) throw new CutoverFenceError('Durable operation context is required');
    const fresh = await this.boundRuntime.grants.ensureFresh(familyId, {
      operation: op,
      target: { kind: 'access_update', accessToken },
      force: opts?.force,
      now: this.localNow(),
      leaseMs: opts?.leaseDurationMs,
      waitMs: opts?.maxWaitMs,
      pollIntervalMs: opts?.pollIntervalMs,
    });
    if (fresh.completion) return this.boundRuntime.grants.finalizeAccess(fresh.completion, op);
    return { ...stored, ...fresh.grant };
  }

  let fresh: EnsureFreshResult<NsUpstreamGrant>;
  try {
   if (!this.unfencedGrantStore) throw new CutoverFenceError('Unfenced grant adapter is unavailable');
   fresh = await this.unfencedGrantStore.ensureFresh(
      familyId,
      async (currentGrant: NsUpstreamGrant) => {
        const grantObj = (currentGrant as any)?.grant ?? currentGrant ?? {};
        const authoritativeRefreshToken = grantObj.nsRefreshToken ?? stored.nsRefreshToken;
        const authoritativeApiUrl = grantObj.nsApiUrl ?? stored.nsApiUrl;
        const grantCandidate: StoredToken = {
          ...stored,
          nsAccessToken: grantObj.nsAccessToken ?? stored.nsAccessToken,
          nsRefreshToken: authoritativeRefreshToken,
          nsApiUrl: authoritativeApiUrl,
          nsExpiresAt: grantObj.nsExpiresAt ?? stored.nsExpiresAt,
          nsUsername: grantObj.nsUsername ?? stored.nsUsername,
          nsUserRole: grantObj.nsUserRole ?? stored.nsUserRole,
        };
        const refreshed = await doRefresh(grantCandidate);
        return {
          grant: {
            nsAccessToken: refreshed.access_token,
            nsRefreshToken: refreshed.refresh_token ?? authoritativeRefreshToken,
            nsExpiresAt: refreshed.expires_in ? this.localNow() + refreshed.expires_in * 1000 : undefined,
            nsUsername: stored.nsUsername,
            nsUserRole: stored.nsUserRole,
            nsApiUrl: authoritativeApiUrl,
          },
          expiresAt: refreshed.expires_in ? this.localNow() + refreshed.expires_in * 1000 : undefined,
        };
      },
      {
        operation: op,
        now: this.localNow(),
        leaseMs: opts?.leaseDurationMs ?? 30_000,
        waitMs: opts?.maxWaitMs ?? 15_000,
        pollIntervalMs: opts?.pollIntervalMs ?? 150,
        completeOperation: false,
        force: opts?.force ?? false,
     expectedAccess: { ref: this.accessDocRef(accessToken), familyId },
      },
    );
  } catch (err) {
   if (err instanceof RefreshSupersededError) throw new LeaseLostError(err.message);
    if (err instanceof Error && (err.message.includes('Lease owner changed') || err.message.includes('lease expired') || err instanceof LeaseLostError)) {
      throw new LeaseLostError(err.message);
    }
    throw err;
  }

  const accessRef = this.accessDocRef(accessToken);
  const upstreamRef = this.upstreamDocRef(familyId);
  let guardResult: GuardMutationResult | undefined;
  const runTx = async () => {
    return await this.rawDb.runTransaction(async (transaction) => {
    const timer = startMonotonicTimer();
    let guard: GuardMutationResult | undefined;
    const fence = this.fenceConfig;
    if (fence && fence.enforce) {
     if (!op) throw new CutoverFenceError('Durable operation context is required');
      guard = await checkMutationGuardInTransaction(transaction, {
        db: this.rawDb,
        namespace: fence.namespace,
        operation: op,
      pendingClaim: fresh.completion?.pendingClaim,
      identityKey: requireFenceKey(fence),
      timer,
        now: this.localNow,
        completeOperation: true,
      });
      guardResult = guard;
    }
    const snap = await transaction.get(accessRef);
    const upstreamSnap = await transaction.get(upstreamRef);
    if (!upstreamSnap.exists) throw new LeaseLostError('Upstream grant disappeared during refresh');
    const upstreamRecord = upstreamSnap.data() as StoredUpstreamRecord<NsUpstreamGrant>;
    const receipt = fresh.completion;
    if (receipt) {
     const claim = receipt.pendingClaim;
     if (receipt.familyId !== familyId ||
      upstreamRecord.leaseOwner !== (claim?.ownerStorageId ?? receipt.leaseOwner) ||
      (upstreamRecord.ambiguousOperationId ?? null) !== (claim?.storageId ?? null) ||
      receipt.operationId !== (fence?.enforce ? op?.id ?? null : null) || upstreamRecord.ambiguousOutcome || upstreamRecord.ambiguousRemoteOutcome ||
      (claim && (claim.claimOwner !== receipt.leaseOwner || claim.operationId !== op?.id ||
       upstreamRecord.operationId !== claim.storageId || upstreamRecord.familyGeneration !== claim.familyGeneration ||
       upstreamRecord.grantVersion !== claim.grantVersion || upstreamRecord.leaseUntil !== claim.leaseExpiresAt ||
       upstreamRecord.leaseExpiresAt !== claim.leaseExpiresAt))) {
      throw new LeaseLostError('Upstream refresh claim changed before finalization');
     }
    } else if (upstreamRecord.leaseOwner || upstreamRecord.leaseUntil || upstreamRecord.leaseExpiresAt ||
     upstreamRecord.operationId || upstreamRecord.ambiguousOutcome || upstreamRecord.ambiguousRemoteOutcome || upstreamRecord.ambiguousOperationId) {
     throw new LeaseLostError('Upstream refresh remains pending');
    }
    if (!snap.exists) {
     if (fresh.completion) throw new LeaseLostError('Access token changed during claimed refresh');
      const familySnap = await transaction.get(this.familyDocRef(familyId));
      if (familySnap.exists) {
        const familyData = familySnap.data() as StoredRefreshFamily;
        if (familyData.currentAccessToken) {
          const currentAccessSnap = await transaction.get(this.accessDocRef(familyData.currentAccessToken));
          if (currentAccessSnap.exists) {
            guard?.bufferCompletion(this.localNow());
        guard?.assertPreReturn();
        return { ...(currentAccessSnap.data() as StoredToken), ...upstreamRecord.grant };
          }
        }
      }
      throw new Error('Token document was deleted/revoked during refresh');
    }
    const upstreamGrant = upstreamRecord.grant;
    const current = snap.data() as StoredToken;
    const updated: StoredToken = {
      ...current,
      nsAccessToken: upstreamGrant.nsAccessToken,
      nsRefreshToken: upstreamGrant.nsRefreshToken ?? current.nsRefreshToken,
      nsExpiresAt: upstreamGrant.nsExpiresAt,
    };
    guard?.bufferCompletion(this.localNow());
    transaction.set(accessRef, cleanDoc(updated));
    if (receipt) {
        transaction.set(
          upstreamRef,
          {
            leaseUntil: null,
       leaseExpiresAt: null,
       operationId: null,
            leaseOwner: null,
            ambiguousOutcome: null,
            ambiguousReason: null,
            ambiguousAt: null,
            ambiguousOperationId: null,
       updatedAt: Math.max(this.localNow(), (upstreamRecord.updatedAt ?? 0) + 1),
          },
          { merge: true },
        );
    }
    guard?.assertPreReturn();
    return updated;
    });
  };
  const result = op?.trackWriter ? await op.trackWriter(runTx) : await runTx();
  guardResult?.onCommit();
  if (fresh.completion) op?.clearAmbiguousRemoteOutcome();
  return result;
 }

 async delete(accessToken: string, options?: { operation?: LegacyOperationContext }): Promise<void> {
    const op = this.resolveOp(options);
    if (this.fenceConfig?.enforce && !op) {
      return await withLegacyOperation(
    { db: this.rawDb, namespace: this.fenceNamespace, identityKey: requireFenceKey(this.fenceConfig), kind: 'delete', now: this.localNow },
        async (opCtx) => this.delete(accessToken, { operation: opCtx }),
      );
    }
    await this.revokeByToken(accessToken, { operation: op });
 }

 async deleteByRefreshToken(refreshToken: string, options?: { operation?: LegacyOperationContext }): Promise<void> {
    const op = this.resolveOp(options);
    if (this.fenceConfig?.enforce && !op) {
      return await withLegacyOperation(
    { db: this.rawDb, namespace: this.fenceNamespace, identityKey: requireFenceKey(this.fenceConfig), kind: 'delete', now: this.localNow },
        async (opCtx) => this.deleteByRefreshToken(refreshToken, { operation: opCtx }),
      );
    }
    await this.revokeByToken(refreshToken, { operation: op });
 }

 override async revokeFamily(familyId: string, options?: { operation?: LegacyOperationContext }): Promise<void> {
    const op = this.resolveOp(options);
    if (this.fenceConfig?.enforce && !op) {
      return await withLegacyOperation(
    { db: this.rawDb, namespace: this.fenceNamespace, identityKey: requireFenceKey(this.fenceConfig), kind: 'revocation', now: this.localNow },
        async (opCtx) => this.revokeFamily(familyId, { operation: opCtx }),
      );
    }
    return super.revokeFamily(familyId, { operation: op });
 }
  clearCache(): void {
    // No-op: caches removed per C1
 }

 get size(): number {
    return 0;
 }
}

// ---------------------------------------------------------------------------
// FirestoreClientsStore
// ---------------------------------------------------------------------------

export class FirestoreClientsStore implements OAuthRegisteredClientsStore {
 private cache = new Map<string, OAuthClientInformationFull>();
 private readonly db: Firestore;
 private readonly collection: string;
 readonly fenceConfig?: CutoverFenceConfig;

 constructor(opts: { collection?: string; projectId?: string; db?: Firestore; fence?: CutoverFenceConfig } = {}) {
  this.collection = opts.collection ?? 'mcp_oauth_clients';
  this.db = opts.db ?? new Firestore({
   projectId: opts.projectId,
   ignoreUndefinedProperties: true,
  });
  this.fenceConfig = normalizeFenceConfig(opts.fence);
  logger.info('Firestore clients store initialized', { collection: this.collection });
 }

 async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
  const hit = this.cache.get(clientId);
  if (hit) return hit;
  try {
  const snap = await this.db.collection(this.collection).doc(clientId).get();
  if (!snap.exists) return undefined;
  const rawData = snap.data() as Record<string, unknown>;
  if (rawData._mcp_format !== undefined || rawData._targetFormat !== undefined) {
    throw new CutoverFenceError(
      'Client record contains reserved format fields (_mcp_format, _targetFormat); legacy client held as ambiguous',
    );
  }
  const client = rawData as OAuthClientInformationFull;
  this.cache.set(clientId, client);
  return client;
  } catch (err: unknown) {
   if (err instanceof CutoverFenceError) throw err;
   if (err instanceof TemporarilyUnavailableError) throw err;
  }
 }

 async registerClient(
  client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'> & { client_id?: string },
  options?: { operation?: LegacyOperationContext },
 ): Promise<OAuthClientInformationFull> {
  const rawMetadata = client as Record<string, unknown>;
  if (rawMetadata._mcp_format !== undefined || rawMetadata._targetFormat !== undefined) {
    throw new CutoverFenceError(
      'Reserved format fields (_mcp_format, _targetFormat) are forbidden in legacy client registration',
    );
  }
  const op = options?.operation ?? requestOperationContext.getStore();
  assertOperationKey(this.fenceConfig, op);
  if (this.fenceConfig?.enforce && !op) {
   return await withLegacyOperation(
    { db: this.db, namespace: this.fenceConfig.namespace, identityKey: requireFenceKey(this.fenceConfig), kind: 'register_client' },
    async (opCtx) => this.registerClient(client, { operation: opCtx }),
   );
  }
  const clientId = client.client_id ?? randomUUID();
  const authMethod = 'token_endpoint_auth_method' in client && typeof client.token_endpoint_auth_method === 'string'
   ? client.token_endpoint_auth_method
   : undefined;
  const isPublic = authMethod === 'none';
  const full: OAuthClientInformationFull = {
   ...client,
   client_id: clientId,
   client_id_issued_at: Math.floor(Date.now() / 1000),
  };
  if (!isPublic) {
   full.client_secret = randomBytes(32).toString('hex');
  }
  const docRef = this.db.collection(this.collection).doc(clientId);
  try {
   let guardResult: GuardMutationResult | undefined;
   const runTx = async () => {
    await this.db.runTransaction(async (transaction) => {
     const timer = startMonotonicTimer();
     let guard: GuardMutationResult | undefined;
     const fence = this.fenceConfig;
     if (fence && fence.enforce) {
      if (!op) throw new CutoverFenceError('Durable operation context is required');
       guard = await checkMutationGuardInTransaction(transaction, {
         db: this.db,
         namespace: fence.namespace,
         operation: op,
       identityKey: requireFenceKey(fence),
       timer,
       });
      guardResult = guard;
     }
     guard?.bufferCompletion();
     transaction.set(docRef, stripUndefined(full));
     guard?.assertPreReturn();
    });
   };
   if (op?.trackWriter) {
    await op.trackWriter(runTx);
   } else {
    await runTx();
   }
   guardResult?.onCommit();
   this.cache.set(clientId, full);
   return full;
  } catch (err: unknown) {
   const e = err as { message?: string; code?: unknown; details?: unknown };
   logger.error('FirestoreClientsStore.registerClient failed', {
    code: e?.code,
   });
   throw err;
  }
 }
}

// ---------------------------------------------------------------------------
// FirestoreAuthCodeStore
// ---------------------------------------------------------------------------

export class FirestoreAuthCodeStore {
 private readonly db: Firestore;
 private readonly collection: string;
 readonly fenceConfig?: CutoverFenceConfig;

 private readonly localNow: () => number;

 constructor(opts: { collection?: string; projectId?: string; db?: Firestore; fence?: CutoverFenceConfig; now?: () => number } = {}) {
  this.collection = opts.collection ?? 'mcp_auth_codes';
  this.db = opts.db ?? new Firestore({
   projectId: opts.projectId,
   ignoreUndefinedProperties: true,
  });
  this.fenceConfig = normalizeFenceConfig(opts.fence);
  this.localNow = opts.now ?? Date.now;
  logger.info('Firestore auth code store initialized', { collection: this.collection });
 }

 async set(
  code: string,
  data: {
   pending: PendingAuthorization;
   nsTokens: NsTokenResponse;
   extra?: Record<string, string>;
   expiresAt?: number;
   serverBaseUrl?: string;
   clientId?: string;
  },
  options?: { operation?: LegacyOperationContext; completeOperation?: boolean },
 ): Promise<void> {
  const op = options?.operation ?? requestOperationContext.getStore();
  assertOperationKey(this.fenceConfig, op);
  if (this.fenceConfig?.enforce && !op) {
   return await withLegacyOperation(
    { db: this.db, namespace: this.fenceConfig.namespace, identityKey: requireFenceKey(this.fenceConfig), kind: 'auth_code' },
    async (opCtx) => this.set(code, data, { operation: opCtx, completeOperation: true }),
   );
  }
  const now = this.localNow();
  const expiresAt = data.expiresAt ?? now + 5 * 60 * 1000;
  const docData: AuthCodeData = {
   pending: data.pending,
   nsTokens: data.nsTokens,
   extra: data.extra,
   expiresAt,
   ttlAt: new Date(expiresAt),
   used: false,
   serverBaseUrl: data.serverBaseUrl,
   clientId: data.clientId ?? data.pending.clientId,
  };
  const docRef = this.db.collection(this.collection).doc(code);
  let guardResult: GuardMutationResult | undefined;
  const runTx = async () => {
    await this.db.runTransaction(async (transaction) => {
    const timer = startMonotonicTimer();
      let guard: GuardMutationResult | undefined;
      const fence = this.fenceConfig;
      if (fence && fence.enforce) {
     if (!op) throw new CutoverFenceError('Durable operation context is required');
        guard = await checkMutationGuardInTransaction(transaction, {
          db: this.db,
          namespace: fence.namespace,
          operation: op,
      identityKey: requireFenceKey(fence),
      timer,
          completeOperation: options?.completeOperation !== false,
        });
     guardResult = guard;
      }
      guard?.bufferCompletion(now);
      transaction.set(docRef, stripUndefined(docData));
    guard?.assertPreReturn();
    });
  };
  if (op?.trackWriter) {
    await op.trackWriter(runTx);
  } else {
    await runTx();
  }
  guardResult?.onCommit();
 }

 async getChallenge(
  code: string,
  expected?: { serverBaseUrl?: string; clientId?: string },
 ): Promise<string | undefined> {
  const snap = await this.db.collection(this.collection).doc(code).get();
  if (!snap.exists) return undefined;
  const data = snap.data() as AuthCodeData;
  if (data.used || this.localNow() > data.expiresAt) return undefined;
  if (data.serverBaseUrl || expected?.serverBaseUrl) {
   if (!data.serverBaseUrl || !expected?.serverBaseUrl || data.serverBaseUrl.toLowerCase() !== expected.serverBaseUrl.toLowerCase()) {
    logger.warn('Auth code challenge rejected: serverBaseUrl mismatch');
    return undefined;
   }
  }
  const codeClientId = data.clientId ?? data.pending?.clientId;
  if (expected?.clientId && codeClientId && codeClientId !== expected.clientId) {
   logger.warn('Auth code challenge rejected: clientId mismatch');
   return undefined;
  }
  return data.pending.codeChallenge;
 }

 async redeem(
  code: string,
  expected?: { serverBaseUrl?: string; clientId?: string },
  options?: { operation?: LegacyOperationContext },
 ): Promise<{ pending: PendingAuthorization; nsTokens: NsTokenResponse; extra?: Record<string, string> } | undefined> {
  const op = options?.operation ?? requestOperationContext.getStore();
  assertOperationKey(this.fenceConfig, op);
  const docRef = this.db.collection(this.collection).doc(code);
  const runTx = async () => {
   return await this.db.runTransaction(async (transaction) => {
    const timer = startMonotonicTimer();
    let guard: GuardMutationResult | undefined;
    const fence = this.fenceConfig;
    if (fence && fence.enforce) {
     if (!op) throw new CutoverFenceError('Durable operation context is required');
      guard = await checkMutationGuardInTransaction(transaction, {
        db: this.db,
        namespace: fence.namespace,
        operation: op,
      identityKey: requireFenceKey(fence),
      timer,
        completeOperation: false,
      });
    }
    const snap = await transaction.get(docRef);
    if (!snap.exists) { guard?.assertPreReturn(); return undefined; }
    const data = snap.data() as AuthCodeData;
    if (data.used || this.localNow() > data.expiresAt) {
     guard?.assertPreReturn();
     return undefined;
    }
    if (data.serverBaseUrl || expected?.serverBaseUrl) {
     if (!data.serverBaseUrl || !expected?.serverBaseUrl || data.serverBaseUrl.toLowerCase() !== expected.serverBaseUrl.toLowerCase()) {
      logger.warn('Auth code redemption rejected: serverBaseUrl mismatch');
      guard?.assertPreReturn();
      return undefined;
     }
    }
    const codeClientId = data.clientId ?? data.pending?.clientId;
    if (expected?.clientId && codeClientId && codeClientId !== expected.clientId) {
     logger.warn('Auth code redemption rejected: clientId mismatch');
     guard?.assertPreReturn();
     return undefined;
    }
    guard?.bufferCompletion();
    transaction.delete(docRef);
    guard?.assertPreReturn();
    return {
     pending: data.pending,
     nsTokens: data.nsTokens,
     extra: data.extra,
    };
   });
  };
  return op?.trackWriter ? await op.trackWriter(runTx) : await runTx();
 }

 async redeemAndIssue(
  code: string,
  tokenStore: FirestoreTokenStore,
  expected: { serverBaseUrl?: string; clientId?: string; tokenLifetimeSec: number },
  options?: { operation?: LegacyOperationContext },
 ): Promise<{ tokens: OAuthTokens } | undefined> {
  const op = options?.operation ?? requestOperationContext.getStore();
  assertOperationKey(this.fenceConfig, op);
  const codeRef = this.db.collection(this.collection).doc(code);
  let guardResult: GuardMutationResult | undefined;
  const runTx = async () => {
   return await this.db.runTransaction(async (transaction) => {
    const timer = startMonotonicTimer();
    let guard: GuardMutationResult | undefined;
    const fence = this.fenceConfig;
    if (fence && fence.enforce) {
     if (!op) throw new CutoverFenceError('Durable operation context is required');
      guard = await checkMutationGuardInTransaction(transaction, {
        db: this.db,
        namespace: fence.namespace,
        operation: op,
      identityKey: requireFenceKey(fence),
      timer,
        completeOperation: true,
      });
      guardResult = guard;
    }
   const snap = await transaction.get(codeRef);
    if (!snap.exists) { guard?.assertPreReturn(); return undefined; }
   const data = snap.data() as AuthCodeData;
   if (data.used || Date.now() > data.expiresAt) {
     guard?.assertPreReturn();
    return undefined;
   }
   if (data.serverBaseUrl || expected?.serverBaseUrl) {
    if (!data.serverBaseUrl || !expected?.serverBaseUrl || data.serverBaseUrl.toLowerCase() !== expected.serverBaseUrl.toLowerCase()) {
      guard?.assertPreReturn();
     return undefined;
    }
   }
   const codeClientId = data.clientId ?? data.pending?.clientId;
   if (expected?.clientId && codeClientId && codeClientId !== expected.clientId) {
     guard?.assertPreReturn();
    return undefined;
   }

   const accessToken = randomBytes(32).toString('hex');
   const refreshToken = randomBytes(32).toString('hex');
   const familyId = randomUUID();
   const now = tokenStore.localNowProvider();
   const expiresAt = now + expected.tokenLifetimeSec * 1000;
   const nsExpiresAt = data.nsTokens.expires_in
     ? now + data.nsTokens.expires_in * 1000
     : undefined;

   const storedToken: StoredToken = {
     accessToken,
     refreshToken,
     refreshFamilyId: familyId,
     clientId: data.clientId ?? data.pending.clientId,
     expiresAt,
     ttlAt: new Date(expiresAt + 30 * 24 * 60 * 60 * 1000),
     extra: data.extra,
     nsAccessToken: data.nsTokens.access_token,
     nsRefreshToken: data.nsTokens.refresh_token,
     nsExpiresAt,
     nsUsername: data.nsTokens.username ?? 'unknown',
     nsUserRole: data.nsTokens.nsUserRole,
     nsApiUrl: data.nsTokens.nsApiUrl,
     serverBaseUrl: expected.serverBaseUrl,
   };

    guard?.assertPreWrite();
   transaction.delete(codeRef);
   transaction.set(tokenStore.accessDocRef(accessToken), stripUndefined(storedToken));
   transaction.set(tokenStore.refreshDocRef(refreshToken), stripUndefined({
     status: 'active',
     familyId,
     token: storedToken,
   }));
   transaction.set(tokenStore.familyDocRef(familyId), stripUndefined({
     id: familyId,
     currentAccessToken: accessToken,
     currentRefreshToken: refreshToken,
     retiredRefreshFingerprints: [],
     updatedAt: now,
   }));
   if (data.nsTokens.access_token) {
     transaction.set(tokenStore.upstreamDocRef(familyId), stripUndefined({
       grant: {
         nsAccessToken: data.nsTokens.access_token,
         nsRefreshToken: data.nsTokens.refresh_token,
         nsExpiresAt,
         nsUsername: data.nsTokens.username,
         nsUserRole: data.nsTokens.nsUserRole,
         nsApiUrl: data.nsTokens.nsApiUrl,
       },
       expiresAt: nsExpiresAt,
       updatedAt: now,
     }));
   }
   guard?.bufferCompletion(now);
    guard?.assertPreReturn();

   return {
     tokens: {
       access_token: accessToken,
       token_type: 'Bearer',
       expires_in: expected.tokenLifetimeSec,
       refresh_token: refreshToken,
     },
   };
  });
 };
 const result = op?.trackWriter ? await op.trackWriter(runTx) : await runTx();
  guardResult?.onCommit();
 return result;
 }
}
