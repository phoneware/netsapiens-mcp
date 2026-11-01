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
import type { StoredToken } from './token-store.js';
import type { PendingAuthorization, NsTokenResponse, AuthCodeData } from './types.js';
import { FirestoreTokenLedger, docId } from './kit/firestore-ledger.js';
import { FirestoreUpstreamGrantStore } from './kit/upstream-grant.js';
import { stripUndefined } from './kit/strip-undefined.js';
import { logger } from '../utils/logger.js';

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

export class FirestoreTokenStore extends FirestoreTokenLedger<StoredToken> {
 private readonly upstreamStore: FirestoreUpstreamGrantStore<NsUpstreamGrant>;
 private readonly localNow: () => number;
 private readonly rawDb: Firestore;
 private readonly tokensCollection: string;
 private readonly refreshColName: string;
 constructor(opts: { collection?: string; projectId?: string; db?: Firestore; now?: () => number } = {}) {
  const defaultCollection = process.env.MCP_READ_ONLY === 'true'
   ? 'readonly_mcp_tokens'
   : 'mcp_tokens';
    const collection = opts.collection ?? defaultCollection;
    const db = opts.db ?? new Firestore({
   projectId: opts.projectId,
   ignoreUndefinedProperties: true,
  });

    super({
      db,
      collection,
      refreshCollection: `${collection}_refresh`,
      familyCollection: `${collection}_refresh_families`,
      linkedFamilyCollections: [`${collection}_upstream`],
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
    this.upstreamStore = new FirestoreUpstreamGrantStore<NsUpstreamGrant>({
      db,
      collection: `${collection}_upstream`,
      now: opts.now,
    });
    this.localNow = opts.now ?? Date.now;
  logger.info('Firestore token store initialized', {
      collection,
   projectId: opts.projectId,
  });
 }

  // Backwards compatibility methods
 async get(accessToken: string): Promise<StoredToken | undefined> {
    return this.getByAccessToken(accessToken);
 }

 async getByRefreshToken(refreshToken: string): Promise<StoredToken | undefined> {
    const res = await this.lookupRefresh(refreshToken);
    if (res.status === 'active' || res.status === 'retry') {
      return res.token;
  }
    return undefined;
 }

 async set(token: StoredToken): Promise<void> {
    await this.issue(token);
 }

 override async issue(token: StoredToken): Promise<StoredToken> {
    const issued = await super.issue(token);
    if (token.nsAccessToken && issued.refreshFamilyId) {
      await this.upstreamStore.put(
        issued.refreshFamilyId,
        {
          nsAccessToken: token.nsAccessToken,
          nsRefreshToken: token.nsRefreshToken,
          nsExpiresAt: token.nsExpiresAt,
          nsUsername: token.nsUsername,
          nsUserRole: token.nsUserRole,
          nsApiUrl: token.nsApiUrl,
        },
        token.nsExpiresAt,
      );
    }
    return issued;
 }

 override async rotate(
    oldRefreshToken: string,
    replacement: StoredToken,
    expectedClientId: string,
    now?: number,
  ) {
    const res = await super.rotate(oldRefreshToken, replacement, expectedClientId, now);
    if (res.status === 'claimed' && res.token.refreshFamilyId && replacement.nsAccessToken) {
      await this.upstreamStore.put(
        res.token.refreshFamilyId,
        {
          nsAccessToken: replacement.nsAccessToken,
          nsRefreshToken: replacement.nsRefreshToken,
          nsExpiresAt: replacement.nsExpiresAt,
          nsUsername: replacement.nsUsername,
          nsUserRole: replacement.nsUserRole,
          nsApiUrl: replacement.nsApiUrl,
        },
        replacement.nsExpiresAt,
      );
    }
    return res;
 }

 override async getByAccessToken(accessToken: string): Promise<StoredToken | undefined> {
    const token = await super.getByAccessToken(accessToken);
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

 async update(accessToken: string, patch: Partial<StoredToken>): Promise<StoredToken | undefined> {
  const existing = await this.get(accessToken);
  if (!existing) return undefined;
  const updated: StoredToken = { ...existing, ...patch };
  await this.rawDb.collection(this.tokensCollection).doc(docId(accessToken)).set(stripUndefined(updated), { merge: true });
  if (patch.refreshToken && patch.refreshToken !== existing.refreshToken) {
    const familyId = updated.refreshFamilyId ?? existing.refreshFamilyId ?? randomUUID();
    await this.rawDb.collection(this.refreshColName).doc(docId(existing.refreshToken)).delete().catch(() => {});
    await this.rawDb.collection(this.refreshColName).doc(docId(patch.refreshToken)).set(stripUndefined({
      status: 'active',
      familyId,
      token: updated,
    }));
  }
  return updated;
 }

 async refreshNsToken(
  accessToken: string,
  doRefresh: (stored: StoredToken) => Promise<{ access_token: string; refresh_token?: string; expires_in?: number }>,
  opts?: { maxWaitMs?: number; pollIntervalMs?: number; leaseDurationMs?: number },
 ): Promise<StoredToken> {
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
     delete (updated as unknown as Record<string, unknown>).refreshLockOwner;
          transaction.set(docRef, cleanDoc(updated));
     resultToken = updated;
    });

        if (resultToken?.refreshFamilyId) {
          await this.upstreamStore.put(
            resultToken.refreshFamilyId,
            {
              nsAccessToken: refreshed.access_token,
              nsRefreshToken: newRefreshToken,
              nsExpiresAt: updatedNsExpiresAt,
              nsUsername: resultToken.nsUsername,
              nsUserRole: resultToken.nsUserRole,
              nsApiUrl: resultToken.nsApiUrl,
            },
            updatedNsExpiresAt,
          );
        }

    return resultToken!;
   } catch (err) {
    if (currentLeaseOwner) {
          await this.rawDb.runTransaction(async (transaction) => {
      const snap = await transaction.get(docRef);
      const current = snap.data() as StoredToken & { refreshLockOwner?: string };
      if (current.refreshLockOwner === currentLeaseOwner) {
       transaction.update(docRef, {
        refreshLockUntil: null,
        refreshLockOwner: null,
       });
      }
     }).catch(() => { });
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

 async delete(accessToken: string): Promise<void> {
    await this.revokeByToken(accessToken);
 }

 async deleteByRefreshToken(refreshToken: string): Promise<void> {
    await this.revokeByToken(refreshToken);
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

 constructor(opts: { collection?: string; projectId?: string; db?: Firestore } = {}) {
  this.collection = opts.collection ?? 'mcp_oauth_clients';
  this.db = opts.db ?? new Firestore({
   projectId: opts.projectId,
   ignoreUndefinedProperties: true,
  });
  logger.info('Firestore clients store initialized', { collection: this.collection });
 }

 async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
  const hit = this.cache.get(clientId);
  if (hit) return hit;
  const snap = await this.db.collection(this.collection).doc(clientId).get();
  if (!snap.exists) return undefined;
  const client = snap.data() as OAuthClientInformationFull;
  this.cache.set(clientId, client);
  return client;
 }

 async registerClient(
  client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'> & { client_id?: string },
 ): Promise<OAuthClientInformationFull> {
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
  try {
   await this.db.collection(this.collection).doc(clientId).set(stripUndefined(full));
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

 constructor(opts: { collection?: string; projectId?: string; db?: Firestore } = {}) {
  this.collection = opts.collection ?? 'mcp_auth_codes';
  this.db = opts.db ?? new Firestore({
   projectId: opts.projectId,
   ignoreUndefinedProperties: true,
  });
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
 ): Promise<void> {
  const expiresAt = data.expiresAt ?? Date.now() + 5 * 60 * 1000;
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
  await this.db.collection(this.collection).doc(code).set(stripUndefined(docData));
 }

 async getChallenge(
  code: string,
  expected?: { serverBaseUrl?: string; clientId?: string },
 ): Promise<string | undefined> {
  const snap = await this.db.collection(this.collection).doc(code).get();
  if (!snap.exists) return undefined;
  const data = snap.data() as AuthCodeData;
  if (data.used || Date.now() > data.expiresAt) return undefined;
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
 ): Promise<{ pending: PendingAuthorization; nsTokens: NsTokenResponse; extra?: Record<string, string> } | undefined> {
  const docRef = this.db.collection(this.collection).doc(code);
  return await this.db.runTransaction(async (transaction) => {
   const snap = await transaction.get(docRef);
   if (!snap.exists) return undefined;
   const data = snap.data() as AuthCodeData;
   if (data.used || Date.now() > data.expiresAt) {
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
   transaction.delete(docRef);
   return {
    pending: data.pending,
    nsTokens: data.nsTokens,
    extra: data.extra,
   };
  });
 }
}
