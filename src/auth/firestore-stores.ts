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
import { logger } from '../utils/logger.js';

function stripUndefined<T>(value: T): T {
 if (value === null || value === undefined) return value;
 if (Array.isArray(value)) {
  return value.map((v) => stripUndefined(v)) as unknown as T;
 }
 if (value instanceof Date || value instanceof Timestamp) {
  return value;
 }
 if (typeof value === 'object') {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
   if (v === undefined) continue;
   out[k] = stripUndefined(v);
  }
  return out as T;
 }
 return value;
}
function toDate(val: unknown): Date | undefined {
 if (val instanceof Date) return val;
 if (val && typeof val === 'object' && 'toDate' in val) {
  const method = (val as { toDate: unknown }).toDate;
  if (typeof method === 'function') {
   const res = method.call(val);
   if (res instanceof Date) return res;
  }
 }
 return undefined;
}

function delay(ms: number): Promise<void> {
 return new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
 });
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
// FirestoreTokenStore
// ---------------------------------------------------------------------------

export class FirestoreTokenStore {
 private cache = new Map<string, StoredToken>();
 private refreshCache = new Map<string, string>(); // refreshToken -> accessToken
 private readonly db: Firestore;
 private readonly collection: string;
 private readonly refreshCollection: string;

 constructor(opts: { collection?: string; projectId?: string; db?: Firestore } = {}) {
  const defaultCollection = process.env.MCP_READ_ONLY === 'true'
   ? 'readonly_mcp_tokens'
   : 'mcp_tokens';
  this.collection = opts.collection ?? defaultCollection;
  this.refreshCollection = `${this.collection}_refresh`;
  this.db = opts.db ?? new Firestore({
   projectId: opts.projectId,
   ignoreUndefinedProperties: true,
  });
  logger.info('Firestore token store initialized', {
   collection: this.collection,
   projectId: opts.projectId,
  });
 }

 clearCache(): void {
  this.cache.clear();
  this.refreshCache.clear();
 }

 async get(accessToken: string): Promise<StoredToken | undefined> {
  const hit = this.cache.get(accessToken);
  if (hit) return hit;
  const snap = await this.db.collection(this.collection).doc(accessToken).get();
  if (!snap.exists) return undefined;
  const data = snap.data() as StoredToken;
  const convertedDate = toDate(data.ttlAt);
  if (convertedDate) {
   data.ttlAt = convertedDate;
  }
  this.cache.set(accessToken, data);
  this.refreshCache.set(data.refreshToken, accessToken);
  return data;
 }

 async getByRefreshToken(refreshToken: string): Promise<StoredToken | undefined> {
  const cachedAccess = this.refreshCache.get(refreshToken);
  if (cachedAccess) {
   const hit = this.cache.get(cachedAccess);
   if (hit) return hit;
  }
  const ptr = await this.db.collection(this.refreshCollection).doc(refreshToken).get();
  if (!ptr.exists) return undefined;
  const { accessToken } = ptr.data() as { accessToken: string };
  return this.get(accessToken);
 }

 async set(token: StoredToken): Promise<void> {
  const batch = this.db.batch();
  batch.set(this.db.collection(this.collection).doc(token.accessToken), stripUndefined(token));
  batch.set(this.db.collection(this.refreshCollection).doc(token.refreshToken), {
   accessToken: token.accessToken,
  });
  await batch.commit();
  this.cache.set(token.accessToken, token);
  this.refreshCache.set(token.refreshToken, token.accessToken);
 }

 async update(accessToken: string, patch: Partial<StoredToken>): Promise<StoredToken | undefined> {
  const existing = await this.get(accessToken);
  if (!existing) return undefined;
  const updated: StoredToken = { ...existing, ...patch };

  const batch = this.db.batch();
  batch.set(this.db.collection(this.collection).doc(updated.accessToken), stripUndefined(updated));
  if (patch.refreshToken && patch.refreshToken !== existing.refreshToken) {
   batch.delete(this.db.collection(this.refreshCollection).doc(existing.refreshToken));
   this.refreshCache.delete(existing.refreshToken);
  }
  batch.set(this.db.collection(this.refreshCollection).doc(updated.refreshToken), {
   accessToken: updated.accessToken,
  });
  await batch.commit();

  this.cache.set(updated.accessToken, updated);
  this.refreshCache.set(updated.refreshToken, updated.accessToken);
  return updated;
 }

 async delete(accessToken: string): Promise<void> {
  const existing = this.cache.get(accessToken) ?? (await this.get(accessToken));
  if (!existing) return;
  const batch = this.db.batch();
  batch.delete(this.db.collection(this.collection).doc(accessToken));
  batch.delete(this.db.collection(this.refreshCollection).doc(existing.refreshToken));
  await batch.commit();
  this.cache.delete(accessToken);
  this.refreshCache.delete(existing.refreshToken);
 }

 async deleteByRefreshToken(refreshToken: string): Promise<void> {
  const accessToken = this.refreshCache.get(refreshToken)
   ?? ((await this.db.collection(this.refreshCollection).doc(refreshToken).get()).data() as { accessToken?: string } | undefined)?.accessToken;
  if (!accessToken) return;
  await this.delete(accessToken);
 }

 /**
  * Cross-instance single-flight NS token refresh using a Firestore transaction.
  *
  * Multiple instances verifying the same expiring NS token coordinate on the token
  * document. Exactly one instance performs the upstream refresh, while concurrent
  * instances wait and read the refreshed token once committed.
  */
 async refreshNsToken(
  accessToken: string,
  doRefresh: (stored: StoredToken) => Promise<{ access_token: string; refresh_token?: string; expires_in?: number }>,
  opts?: { maxWaitMs?: number; pollIntervalMs?: number; leaseDurationMs?: number },
 ): Promise<StoredToken> {
  const docRef = this.db.collection(this.collection).doc(accessToken);
  const MAX_WAIT_MS = opts?.maxWaitMs ?? 15_000;
  const POLL_INTERVAL_MS = opts?.pollIntervalMs ?? 150;
  const LEASE_DURATION_MS = opts?.leaseDurationMs ?? 15_000;
  const startTime = Date.now();
  const NS_REFRESH_SKEW_MS = 60_000;

  while (Date.now() - startTime < MAX_WAIT_MS) {
   let shouldRefresh = false;
   let tokenToRefresh: StoredToken | undefined;
   let currentLeaseOwner: string | undefined;

   await this.db.runTransaction(async (transaction) => {
    const snap = await transaction.get(docRef);
    if (!snap.exists) {
     throw new Error('Token document not found');
    }
    const data = snap.data() as StoredToken & { refreshLockUntil?: number; refreshLockOwner?: string };
    const convertedDate = toDate(data.ttlAt);
    if (convertedDate) {
     data.ttlAt = convertedDate;
    }
    const now = Date.now();
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
    if (tokenToRefresh && (!tokenToRefresh.nsExpiresAt || Date.now() <= tokenToRefresh.nsExpiresAt - NS_REFRESH_SKEW_MS)) {
     this.cache.set(accessToken, tokenToRefresh);
     if (tokenToRefresh.refreshToken) {
      this.refreshCache.set(tokenToRefresh.refreshToken, accessToken);
     }
     return tokenToRefresh;
    }
    await delay(POLL_INTERVAL_MS);
    continue;
   }

   try {
    const refreshed = await doRefresh(tokenToRefresh!);
    const updatedNsExpiresAt = refreshed.expires_in
     ? Date.now() + refreshed.expires_in * 1000
     : undefined;
    const newRefreshToken = refreshed.refresh_token ?? tokenToRefresh!.nsRefreshToken;

    let resultToken: StoredToken | undefined;
    await this.db.runTransaction(async (transaction) => {
     const snap = await transaction.get(docRef);
     if (!snap.exists) {
      throw new Error('Token document was deleted/revoked during refresh');
     }
     const current = snap.data() as StoredToken & { refreshLockOwner?: string };
     if (current.refreshLockOwner !== currentLeaseOwner) {
      logger.warn('Refresh lease expired or owned by another instance, aborting late completion', {
       expectedOwner: currentLeaseOwner,
       actualOwner: current.refreshLockOwner,
      });
      throw new LeaseLostError('Refresh lease expired or owned by another instance');
     }
     const updated: StoredToken = {
      ...current,
      nsAccessToken: refreshed.access_token,
      nsRefreshToken: newRefreshToken,
      nsExpiresAt: updatedNsExpiresAt,
     };
     delete (updated as unknown as Record<string, unknown>).refreshLockUntil;
     delete (updated as unknown as Record<string, unknown>).refreshLockOwner;

     transaction.set(docRef, stripUndefined(updated));
     resultToken = updated;
    });

    this.cache.set(accessToken, resultToken!);
    return resultToken!;
   } catch (err) {
    this.cache.delete(accessToken);
    if (currentLeaseOwner) {
     await this.db.runTransaction(async (transaction) => {
      const snap = await transaction.get(docRef);
      if (!snap.exists) return;
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
   const isExpiring = data.nsExpiresAt && Date.now() > data.nsExpiresAt - NS_REFRESH_SKEW_MS;
   if (!isExpiring) {
    this.cache.set(accessToken, data);
    return data;
   }
  }
  throw new RetryableRefreshError('Timed out waiting for upstream token refresh');
 }

 get size(): number {
  return this.cache.size;
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
  client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
 ): Promise<OAuthClientInformationFull> {
  const clientId = randomUUID();
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
