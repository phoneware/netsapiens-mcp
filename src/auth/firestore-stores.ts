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
import { FirestoreTokenLedger, docId } from './kit/firestore-ledger.js';
import type { RefreshRotationResult } from './kit/ledger.js';
import { FirestoreUpstreamGrantStore } from './kit/upstream-grant.js';
import { stripUndefined } from './kit/strip-undefined.js';
import { UpstreamUnavailableError } from './kit/errors.js';
import { UpstreamTimeoutError } from './netsapiens-auth-provider.js';
import {
  type CutoverFenceConfig,
  type LegacyOperationContext,
  withLegacyOperation,
  checkMutationGuardInTransaction,
  type GuardMutationResult,
  requestOperationContext,
  type SupportedCutoverNamespace,
} from './kit/cutover-fence.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { logger } from '../utils/logger.js';

function detectNamespace(collection: string): string {
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

// ---------------------------------------------------------------------------
// FirestoreTokenStore
// ---------------------------------------------------------------------------

export interface FirestoreTokenStoreOptions {
  collection?: string;
  projectId?: string;
  db?: Firestore;
  now?: () => number;
  fence?: CutoverFenceConfig;
}

export class FirestoreTokenStore extends FirestoreTokenLedger<StoredToken> {
  private readonly upstreamStore: FirestoreUpstreamGrantStore<NsUpstreamGrant>;
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
    const fenceConfig: CutoverFenceConfig | undefined = opts.fence;

    super({
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
    });

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

  get fenceNamespace(): string {
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
    return options?.operation ?? requestOperationContext.getStore();
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

  async set(token: StoredToken, options?: { operation?: LegacyOperationContext }): Promise<void> {
    await this.issue(token, options);
  }

  override async issue(token: StoredToken, options?: { operation?: LegacyOperationContext }): Promise<StoredToken> {
    const op = this.resolveOp(options);
    if (this.fenceConfig?.enforce && !op) {
      return await withLegacyOperation(
        { db: this.rawDb, namespace: this.fenceNamespace as SupportedCutoverNamespace, kind: 'issue', now: this.localNow },
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
    options?: { operation?: LegacyOperationContext },
  ): Promise<RefreshRotationResult<StoredToken>> {
    const op = this.resolveOp(options);
    if (this.fenceConfig?.enforce && !op) {
      return await withLegacyOperation(
        { db: this.rawDb, namespace: this.fenceNamespace as SupportedCutoverNamespace, kind: 'rotate', now: this.localNow },
        async (opCtx) => this.rotate(oldRefreshToken, replacement, expectedClientId, now, { operation: opCtx }),
      );
    }
    return super.rotate(oldRefreshToken, replacement, expectedClientId, now, { operation: op });
  }

  override async getByAccessToken(
    accessToken: string,
    options?: { operation?: LegacyOperationContext },
  ): Promise<StoredToken | undefined> {
    const op = this.resolveOp(options);
    if (this.fenceConfig?.enforce && !op) {
      return await withLegacyOperation(
        { db: this.rawDb, namespace: this.fenceNamespace as SupportedCutoverNamespace, kind: 'read', now: this.localNow },
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
        { db: this.rawDb, namespace: this.fenceNamespace as SupportedCutoverNamespace, kind: 'update', now: this.localNow },
        async (opCtx) => this.update(accessToken, patch, { operation: opCtx }),
      );
    }
    const accessRef = this.accessDocRef(accessToken);
    return await this.rawDb.runTransaction(async (transaction) => {
      let guard: GuardMutationResult | undefined;
      const fence = this.fenceConfig;
      if (fence && fence.enforce) {
        guard = await checkMutationGuardInTransaction(transaction, {
          db: this.rawDb,
          namespace: fence.namespace,
          operation: op,
          now: this.localNow,
        });
      }
      const accessSnap = await transaction.get(accessRef);
      if (!accessSnap.exists) return undefined;
      const existing = accessSnap.data() as StoredToken;
      const updated: StoredToken = { ...existing, ...patch };
      const now = this.localNow();

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

      if (updated.refreshFamilyId && (patch.nsAccessToken || patch.nsRefreshToken || patch.nsExpiresAt)) {
        const upstreamRef = this.upstreamDocRef(updated.refreshFamilyId);
        transaction.set(upstreamRef, stripUndefined({
          grant: {
            nsAccessToken: updated.nsAccessToken,
            nsRefreshToken: updated.nsRefreshToken,
            nsExpiresAt: updated.nsExpiresAt,
            nsUsername: updated.nsUsername,
            nsUserRole: updated.nsUserRole,
            nsApiUrl: updated.nsApiUrl,
          },
          expiresAt: updated.nsExpiresAt,
          updatedAt: now,
        }), { merge: true });
      }

      return updated;
    });
  }

 async refreshNsToken(
  accessToken: string,
  doRefresh: (stored: StoredToken) => Promise<{ access_token: string; refresh_token?: string; expires_in?: number }>,
  opts?: { maxWaitMs?: number; pollIntervalMs?: number; leaseDurationMs?: number; operation?: LegacyOperationContext },
 ): Promise<StoredToken> {
  const op = this.resolveOp(opts);
  if (this.fenceConfig?.enforce && !op) {
    return await withLegacyOperation(
      { db: this.rawDb, namespace: this.fenceNamespace as SupportedCutoverNamespace, kind: 'upstream_refresh', now: this.localNow },
      async (opCtx) => this.refreshNsToken(accessToken, doRefresh, { ...opts, operation: opCtx }),
    );
  }
  const docRef = this.rawDb.collection(this.tokensCollection).doc(docId(accessToken));
  const MAX_WAIT_MS = opts?.maxWaitMs ?? 15_000;
  const POLL_INTERVAL_MS = opts?.pollIntervalMs ?? 150;
  const LEASE_DURATION_MS = opts?.leaseDurationMs ?? 15_000;
  const startTime = Date.now();
  const NS_REFRESH_SKEW_MS = 60_000;

  while (Date.now() - startTime < MAX_WAIT_MS) {
   let shouldRefresh = false;
   let tokenToRefresh: StoredToken | undefined;
   let currentLeaseOwner: string | undefined;
   await this.rawDb.runTransaction(async (transaction) => {
    let guard: GuardMutationResult | undefined;
    const fence = this.fenceConfig;
    if (fence && fence.enforce) {
      guard = await checkMutationGuardInTransaction(transaction, {
        db: this.rawDb,
        namespace: fence.namespace,
        operation: op,
        now: this.localNow,
        completeOperation: false,
      });
    }
    const snap = await transaction.get(docRef);
    if (!snap.exists) {
     throw new Error('Token document not found');
    }
    const data = snap.data() as StoredToken & { refreshLockUntil?: number; refreshLockOwner?: string };
    const convertedDate = toDate(data.ttlAt);
    if (convertedDate) {
     data.ttlAt = convertedDate;
    }
        const now = this.localNow();
    if (data.ambiguousRemoteOutcome) {
     throw new UpstreamUnavailableError('Cannot refresh: prior remote grant outcome is ambiguous and pending reconciliation');
    }
    const isExpiring = data.nsExpiresAt && now > data.nsExpiresAt - NS_REFRESH_SKEW_MS;
    if (!isExpiring) {
     tokenToRefresh = data;
     shouldRefresh = false;
     return;
    }

    if (data.refreshLockUntil && data.refreshLockUntil > now && data.refreshLockOwner) {
     shouldRefresh = false;
     return;
    }

    shouldRefresh = true;
    tokenToRefresh = data;
    currentLeaseOwner = randomUUID();
    transaction.update(docRef, {
     refreshLockUntil: now + LEASE_DURATION_MS,
     refreshLockOwner: currentLeaseOwner,
    });
   });

   if (!shouldRefresh) {
        if (tokenToRefresh && (!tokenToRefresh.nsExpiresAt || this.localNow() <= tokenToRefresh.nsExpiresAt - NS_REFRESH_SKEW_MS)) {
     return tokenToRefresh;
    }
    await delay(POLL_INTERVAL_MS);
    continue;
   }

   try {
    const refreshed = await doRefresh(tokenToRefresh!);
    const updatedNsExpiresAt = refreshed.expires_in
          ? this.localNow() + refreshed.expires_in * 1000
     : undefined;
    const newRefreshToken = refreshed.refresh_token ?? tokenToRefresh!.nsRefreshToken;
    let resultToken: StoredToken | undefined;
        await this.rawDb.runTransaction(async (transaction) => {
     let guard: GuardMutationResult | undefined;
     const fence = this.fenceConfig;
     if (fence && fence.enforce) {
       guard = await checkMutationGuardInTransaction(transaction, {
         db: this.rawDb,
         namespace: fence.namespace,
         operation: opts?.operation,
         now: this.localNow,
         completeOperation: true,
       });
     }
     const snap = await transaction.get(docRef);
     if (!snap.exists) {
      throw new Error('Token document was deleted/revoked during refresh');
     }
          const current = snap.data() as StoredToken & { refreshLockOwner?: string; refreshLockUntil?: number };
          const now = this.localNow();
     if (current.refreshLockOwner !== currentLeaseOwner) {
      logger.warn('Refresh lease expired or owned by another instance, aborting late completion', {
       expectedOwner: currentLeaseOwner,
       actualOwner: current.refreshLockOwner,
      });
      throw new LeaseLostError('Refresh lease expired or owned by another instance');
          }
          if (current.refreshLockUntil && current.refreshLockUntil < now) {
            throw new LeaseLostError('Refresh lease expired before refresh completed');
     }
     const updated: StoredToken = {
      ...current,
      nsAccessToken: refreshed.access_token,
      nsRefreshToken: newRefreshToken,
      nsExpiresAt: updatedNsExpiresAt,
     };
     delete (updated as unknown as Record<string, unknown>).refreshLockUntil;
     delete (updated as unknown as Record<string, unknown>).refreshLockUntil;
     delete (updated as unknown as Record<string, unknown>).refreshLockOwner;
     delete (updated as unknown as Record<string, unknown>).ambiguousRemoteOutcome;
     guard?.bufferCompletion(now);
     transaction.set(docRef, cleanDoc(updated));
     if (updated.refreshFamilyId) {
       const upstreamRef = this.upstreamDocRef(updated.refreshFamilyId);
       transaction.set(
         upstreamRef,
         stripUndefined({
           grant: {
             nsAccessToken: refreshed.access_token,
             nsRefreshToken: newRefreshToken,
             nsExpiresAt: updatedNsExpiresAt,
             nsUsername: updated.nsUsername,
             nsUserRole: updated.nsUserRole,
             nsApiUrl: updated.nsApiUrl,
           },
           expiresAt: updatedNsExpiresAt,
           leaseUntil: null,
           leaseOwner: null,
           updatedAt: now,
         }),
         { merge: true },
       );
     }
     resultToken = updated;
    });

    return resultToken!;
   } catch (err) {
    const isTimeout =
      err instanceof UpstreamTimeoutError ||
      (err && typeof err === 'object' && 'code' in err && ((err as { code: unknown }).code === 'ETIMEDOUT' || (err as { code: unknown }).code === 'ECONNABORTED')) ||
      (err && typeof err === 'object' && 'name' in err && (err as { name: unknown }).name === 'UpstreamTimeoutError') ||
      (err instanceof Error && err.message.toLowerCase().includes('timeout'));

    if (isTimeout) {
      opts?.operation?.markAmbiguousRemoteOutcome(err instanceof Error ? err.message : String(err));
      await this.rawDb.runTransaction(async (transaction) => {
        const snap = await transaction.get(docRef);
        if (snap.exists) {
          const current = snap.data() as StoredToken;
          transaction.set(docRef, { ambiguousRemoteOutcome: true }, { merge: true });
          if (current.refreshFamilyId) {
            transaction.set(
              this.upstreamDocRef(current.refreshFamilyId),
              {
                ambiguousOutcome: true,
                ambiguousReason: 'Timeout during refresh',
                ambiguousAt: this.localNow(),
              },
              { merge: true },
            );
          }
        }
      }).catch(() => {});
    } else if (currentLeaseOwner) {
      await this.rawDb.runTransaction(async (transaction) => {
        const snap = await transaction.get(docRef);
        if (snap.exists) {
          const current = snap.data() as StoredToken & { refreshLockOwner?: string };
          if (current.refreshLockOwner === currentLeaseOwner) {
            transaction.update(docRef, {
              refreshLockUntil: null,
              refreshLockOwner: null,
            });
          }
        }
      }).catch(() => {});
    }
    throw err;
   }
  }

  const snap = await docRef.get();
  if (snap.exists) {
   const data = snap.data() as StoredToken;
      const isExpiring = data.nsExpiresAt && this.localNow() > data.nsExpiresAt - NS_REFRESH_SKEW_MS;
   if (!isExpiring) {
    return data;
   }
  }
  throw new RetryableRefreshError('Timed out waiting for upstream token refresh');
 }

 async delete(accessToken: string, options?: { operation?: LegacyOperationContext }): Promise<void> {
    const op = this.resolveOp(options);
    if (this.fenceConfig?.enforce && !op) {
      return await withLegacyOperation(
        { db: this.rawDb, namespace: this.fenceNamespace as SupportedCutoverNamespace, kind: 'delete', now: this.localNow },
        async (opCtx) => this.delete(accessToken, { operation: opCtx }),
      );
    }
    await this.revokeByToken(accessToken, { operation: op });
 }

 async deleteByRefreshToken(refreshToken: string, options?: { operation?: LegacyOperationContext }): Promise<void> {
    const op = this.resolveOp(options);
    if (this.fenceConfig?.enforce && !op) {
      return await withLegacyOperation(
        { db: this.rawDb, namespace: this.fenceNamespace as SupportedCutoverNamespace, kind: 'delete', now: this.localNow },
        async (opCtx) => this.deleteByRefreshToken(refreshToken, { operation: opCtx }),
      );
    }
    await this.revokeByToken(refreshToken, { operation: op });
 }

 override async revokeFamily(familyId: string, options?: { operation?: LegacyOperationContext }): Promise<void> {
    const op = this.resolveOp(options);
    if (this.fenceConfig?.enforce && !op) {
      return await withLegacyOperation(
        { db: this.rawDb, namespace: this.fenceNamespace as SupportedCutoverNamespace, kind: 'revocation', now: this.localNow },
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
  this.fenceConfig = opts.fence;
  logger.info('Firestore clients store initialized', { collection: this.collection });
 }

 async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
  const hit = this.cache.get(clientId);
  if (hit) return hit;
  try {
  const snap = await this.db.collection(this.collection).doc(clientId).get();
  if (!snap.exists) return undefined;
  const client = snap.data() as OAuthClientInformationFull;
  this.cache.set(clientId, client);
  return client;
  } catch (err: unknown) {
   if (err instanceof TemporarilyUnavailableError) throw err;
   throw new TemporarilyUnavailableError('Client store temporarily unavailable');
  }
 }

 async registerClient(
  client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'> & { client_id?: string },
  options?: { operation?: LegacyOperationContext },
 ): Promise<OAuthClientInformationFull> {
  const op = options?.operation ?? requestOperationContext.getStore();
  if (this.fenceConfig?.enforce && !op) {
   return await withLegacyOperation(
    { db: this.db, namespace: this.fenceConfig.namespace, kind: 'register_client' },
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
   await this.db.runTransaction(async (transaction) => {
    let guard: GuardMutationResult | undefined;
    const fence = this.fenceConfig;
    if (fence && fence.enforce) {
      guard = await checkMutationGuardInTransaction(transaction, {
        db: this.db,
        namespace: fence.namespace,
        operation: op,
      });
    }
    guard?.bufferCompletion();
    transaction.set(docRef, stripUndefined(full));
   });
   this.cache.set(clientId, full);
   return full;
  } catch (err: unknown) {
   const e = err as { message?: string; code?: unknown; details?: unknown };
   logger.error('FirestoreClientsStore.registerClient failed', {
    error: e?.message ?? String(err),
    code: e?.code,
    details: e?.details,
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
  this.fenceConfig = opts.fence;
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
  if (this.fenceConfig?.enforce && !op) {
   return await withLegacyOperation(
    { db: this.db, namespace: this.fenceConfig.namespace, kind: 'auth_code' },
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
  await this.db.runTransaction(async (transaction) => {
    let guard: GuardMutationResult | undefined;
    const fence = this.fenceConfig;
    if (fence && fence.enforce) {
      guard = await checkMutationGuardInTransaction(transaction, {
        db: this.db,
        namespace: fence.namespace,
        operation: op,
        completeOperation: options?.completeOperation !== false,
      });
    }
    transaction.set(docRef, stripUndefined(docData));
  });
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
    logger.warn('Auth code challenge rejected: serverBaseUrl mismatch (cross-server auth code)', {
     codeServer: data.serverBaseUrl,
     expectedServer: expected?.serverBaseUrl,
    });
    return undefined;
   }
  }
  const codeClientId = data.clientId ?? data.pending?.clientId;
  if (expected?.clientId && codeClientId && codeClientId !== expected.clientId) {
   logger.warn('Auth code challenge rejected: clientId mismatch', {
    codeClientId,
    expectedClientId: expected.clientId,
   });
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
  const docRef = this.db.collection(this.collection).doc(code);
  return await this.db.runTransaction(async (transaction) => {
   let guard: GuardMutationResult | undefined;
   const fence = this.fenceConfig;
   if (fence && fence.enforce) {
     guard = await checkMutationGuardInTransaction(transaction, {
       db: this.db,
       namespace: fence.namespace,
       operation: op,
       completeOperation: false,
     });
   }
   const snap = await transaction.get(docRef);
   if (!snap.exists) return undefined;
   const data = snap.data() as AuthCodeData;
   if (data.used || this.localNow() > data.expiresAt) {
    return undefined;
   }
   if (data.serverBaseUrl || expected?.serverBaseUrl) {
    if (!data.serverBaseUrl || !expected?.serverBaseUrl || data.serverBaseUrl.toLowerCase() !== expected.serverBaseUrl.toLowerCase()) {
     logger.warn('Auth code redemption rejected: serverBaseUrl mismatch (cross-server auth code)', {
      codeServer: data.serverBaseUrl,
      expectedServer: expected?.serverBaseUrl,
     });
     return undefined;
    }
   }
   const codeClientId = data.clientId ?? data.pending?.clientId;
   if (expected?.clientId && codeClientId && codeClientId !== expected.clientId) {
    logger.warn('Auth code redemption rejected: clientId mismatch', {
     codeClientId,
     expectedClientId: expected.clientId,
    });
    return undefined;
   }
   guard?.bufferCompletion();
   transaction.delete(docRef);
   return {
    pending: data.pending,
    nsTokens: data.nsTokens,
    extra: data.extra,
   };
  });
 }

 async redeemAndIssue(
  code: string,
  tokenStore: FirestoreTokenStore,
  expected: { serverBaseUrl?: string; clientId?: string; tokenLifetimeSec: number },
  options?: { operation?: LegacyOperationContext },
 ): Promise<{ tokens: OAuthTokens } | undefined> {
  const op = options?.operation ?? requestOperationContext.getStore();
  const codeRef = this.db.collection(this.collection).doc(code);
  return await this.db.runTransaction(async (transaction) => {
   let guard: GuardMutationResult | undefined;
   const fence = this.fenceConfig;
   if (fence && fence.enforce) {
     guard = await checkMutationGuardInTransaction(transaction, {
       db: this.db,
       namespace: fence.namespace,
       operation: op,
       completeOperation: true,
     });
   }
   const snap = await transaction.get(codeRef);
   if (!snap.exists) return undefined;
   const data = snap.data() as AuthCodeData;
   if (data.used || Date.now() > data.expiresAt) {
    return undefined;
   }
   if (data.serverBaseUrl || expected?.serverBaseUrl) {
    if (!data.serverBaseUrl || !expected?.serverBaseUrl || data.serverBaseUrl.toLowerCase() !== expected.serverBaseUrl.toLowerCase()) {
     return undefined;
    }
   }
   const codeClientId = data.clientId ?? data.pending?.clientId;
   if (expected?.clientId && codeClientId && codeClientId !== expected.clientId) {
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

   return {
     tokens: {
       access_token: accessToken,
       token_type: 'Bearer',
       expires_in: expected.tokenLifetimeSec,
       refresh_token: refreshToken,
     },
   };
  });
 }
}
