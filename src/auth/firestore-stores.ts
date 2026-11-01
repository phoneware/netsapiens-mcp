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
import { FirestoreTokenLedger } from './kit/firestore-ledger.js';
import { stripUndefined } from './kit/strip-undefined.js';
import { logger } from '../utils/logger.js';

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

export class FirestoreTokenStore extends FirestoreTokenLedger<StoredToken> {
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

 async update(accessToken: string, patch: Partial<StoredToken>): Promise<StoredToken | undefined> {
  const existing = await this.get(accessToken);
  if (!existing) return undefined;
  const updated: StoredToken = { ...existing, ...patch };
    await (this as unknown as { accessCol: () => { doc: (id: string) => { set: (d: unknown, opt?: unknown) => Promise<unknown> } } }).accessCol().doc(accessToken).set(stripUndefined(updated), { merge: true });
  return updated;
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
