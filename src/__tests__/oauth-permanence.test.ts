import { describe, it, expect, vi } from 'vitest';
import { TemporarilyUnavailableError, InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Server as HttpServer } from 'node:http';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { InternalAxiosRequestConfig } from 'axios';
import axios from 'axios';
import { Firestore } from '@google-cloud/firestore';
import { createApp } from '../http-server.js';
import { runPermanenceContract, type PermanenceHarness } from './test-support/permanence-contract.js';
import { FakeFirestore } from './test-support/fake-firestore.js';
import { FirestoreTokenStore, FirestoreClientsStore, FirestoreAuthCodeStore } from '../auth/firestore-stores.js';
import { TokenStore } from '../auth/token-store.js';
import { NetSapiensAuthProvider } from '../auth/netsapiens-auth-provider.js';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface MemoryHarnessBacking {
  tokenStore: TokenStore;
  clientsStore: any;
  authCodeStore: any;
}

interface FakeFirestoreBacking {
  fakeDb: FakeFirestore;
}

interface EmulatorBacking {
  db: Firestore;
  collection: string;
}

function createMemoryHarness(): PermanenceHarness<MemoryHarnessBacking> {
  const openServers: HttpServer[] = [];
  let virtualNow = Date.now();

  return {
    name: 'NetSapiens MCP (Memory)',
    newBacking: async () => {
      const storePath = join(tmpdir(), `perm-mem-${randomBytes(6).toString('hex')}.json`);
      const tokenStore = new TokenStore(storePath);
      return {
        tokenStore,
        clientsStore: undefined,
        authCodeStore: undefined,
      };
    },
    createInstance: async (backing) => {
      process.env.MCP_TRANSPORT = 'http';
      process.env.MCP_BASE_URL = 'http://localhost';
      process.env.NETSAPIENS_API_URL = 'https://ns.example.com';
      process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'op-client-id';
      process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'op-client-secret';
      process.env.MCP_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
      process.env.MCP_TOKEN_LIFETIME_HOURS = '1';
      delete process.env.MCP_PERSISTENCE;

      const authProvider = new NetSapiensAuthProvider({
        nsApiUrl: 'https://ns.example.com',
        nsClientId: 'op-client-id',
        nsClientSecret: 'op-client-secret',
        tokenStore: backing.tokenStore,
        clientsStore: backing.clientsStore,
        authCodeStore: backing.authCodeStore,
        tokenLifetimeSec: 3600,
        serverBaseUrl: 'http://localhost',
        now: () => virtualNow,
      });
      if (!backing.clientsStore) {
        backing.clientsStore = authProvider.clientsStore;
      }

      const created = createApp(authProvider);
      const server = created.app.listen(0);
      openServers.push(server);
      const port = (server.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}`;
      created.baseUrl.href = url;

      return {
        url,
        close: async () => {
          await new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          });
        },
      };
    },
    signIn: async (instanceUrl) => {
      vi.spyOn(axios, 'post').mockImplementation(async (url: string) => {
        if (url.includes('/ns-api/v2/tokens')) {
          return {
            data: {
              access_token: 'mock-ns-access-token',
              refresh_token: 'mock-ns-refresh-token',
              expires_in: 3600,
            },
            status: 200,
            statusText: 'OK',
            headers: {},
            config: {} as unknown as InternalAxiosRequestConfig,
          };
        }
        return {
          data: {},
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as unknown as InternalAxiosRequestConfig,
        };
      });

      vi.spyOn(axios, 'get').mockImplementation(async () => {
        return {
          data: {
            'user-scope': 'Reseller',
            user: 'alice',
            domain: 'example.com',
            email: 'alice@example.com',
            'name-full-name': 'Alice User',
          },
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as unknown as InternalAxiosRequestConfig,
        };
      });

      const regRes = await fetch(`${instanceUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'permanence-test-client',
          redirect_uris: ['http://127.0.0.1:9099/callback'],
          token_endpoint_auth_method: 'none',
        }),
      });
      const reg = (await regRes.json()) as { client_id: string; client_secret?: string };

      const authRes = await fetch(
        `${instanceUrl}/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=http://127.0.0.1:9099/callback&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256`,
      );
      const authHtml = await authRes.text();
      const authStateMatch = authHtml.match(/name="auth_state"\s+value="([^"]+)"/);
      const authState = authStateMatch ? authStateMatch[1] : '';

      const loginParams = new URLSearchParams({
        username: 'alice@example.com',
        password: 'password123',
        auth_state: authState,
      });

      const loginRes = await fetch(`${instanceUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: loginParams.toString(),
        redirect: 'manual',
      });

      const location = loginRes.headers.get('location') || '';
      const code = new URL(location, 'http://127.0.0.1:9099').searchParams.get('code') || '';

      const tokenParams = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        client_id: reg.client_id,
        redirect_uri: 'http://127.0.0.1:9099/callback',
      });
      if (reg.client_secret) {
        tokenParams.set('client_secret', reg.client_secret);
      }

      const tokenRes = await fetch(`${instanceUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenParams.toString(),
      });
      const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string; expires_in: number };

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        clientId: reg.client_id,
        expiresIn: tokens.expires_in,
      };
    },
    setNow: (now: number) => {
      virtualNow = now;
    },
    getNow: () => virtualNow,
    supportsAdoption: true,
    supportsRegistration: true,
  };
}

function createFakeFirestoreHarness(): PermanenceHarness<FakeFirestoreBacking> {
  const openServers: HttpServer[] = [];
  let virtualNow = Date.now();

  return {
    name: 'NetSapiens MCP (Fake Firestore)',
    newBacking: async () => ({
      fakeDb: new FakeFirestore(),
    }),
    createInstance: async (backing) => {
      process.env.MCP_TRANSPORT = 'http';
      process.env.MCP_BASE_URL = 'http://localhost';
      process.env.NETSAPIENS_API_URL = 'https://ns.example.com';
      process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'op-client-id';
      process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'op-client-secret';
      process.env.MCP_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
      process.env.MCP_TOKEN_LIFETIME_HOURS = '1';
      process.env.MCP_PERSISTENCE = 'firestore';
      process.env.GOOGLE_CLOUD_PROJECT = 'test-project';

      const tokenStore = new FirestoreTokenStore({
        db: backing.fakeDb as unknown as Firestore,
        collection: 'test_tokens',
        now: () => virtualNow,
      });

      const authProvider = new NetSapiensAuthProvider({
        nsApiUrl: 'https://ns.example.com',
        nsClientId: 'op-client-id',
        nsClientSecret: 'op-client-secret',
        tokenStore,
        firestore: backing.fakeDb as unknown as Firestore,
        tokenLifetimeSec: 3600,
        serverBaseUrl: 'http://localhost',
        now: () => virtualNow,
      });

      const created = createApp(authProvider);
      const server = created.app.listen(0);
      openServers.push(server);
      const port = (server.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}`;
      created.baseUrl.href = url;

      return {
        url,
        close: async () => {
          await new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          });
        },
      };
    },
    signIn: async (instanceUrl) => {
      vi.spyOn(axios, 'post').mockImplementation(async (url: string) => {
        if (url.includes('/ns-api/v2/tokens')) {
          return {
            data: {
              access_token: 'mock-ns-access-token',
              refresh_token: 'mock-ns-refresh-token',
              expires_in: 3600,
            },
            status: 200,
            statusText: 'OK',
            headers: {},
            config: {} as unknown as InternalAxiosRequestConfig,
          };
        }
        return {
          data: {},
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as unknown as InternalAxiosRequestConfig,
        };
      });

      vi.spyOn(axios, 'get').mockImplementation(async () => {
        return {
          data: {
            'user-scope': 'Reseller',
            user: 'alice',
            domain: 'example.com',
            email: 'alice@example.com',
            'name-full-name': 'Alice User',
          },
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as unknown as InternalAxiosRequestConfig,
        };
      });

      const regRes = await fetch(`${instanceUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'permanence-test-client',
          redirect_uris: ['http://127.0.0.1:9099/callback'],
          token_endpoint_auth_method: 'none',
        }),
      });
      const reg = (await regRes.json()) as { client_id: string; client_secret?: string };

      const authRes = await fetch(
        `${instanceUrl}/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=http://127.0.0.1:9099/callback&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256`,
      );
      const authHtml = await authRes.text();
      const authStateMatch = authHtml.match(/name="auth_state"\s+value="([^"]+)"/);
      const authState = authStateMatch ? authStateMatch[1] : '';

      const loginParams = new URLSearchParams({
        username: 'alice@example.com',
        password: 'password123',
        auth_state: authState,
      });

      const loginRes = await fetch(`${instanceUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: loginParams.toString(),
        redirect: 'manual',
      });

      const location = loginRes.headers.get('location') || '';
      const code = new URL(location, 'http://127.0.0.1:9099').searchParams.get('code') || '';

      const tokenParams = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        client_id: reg.client_id,
        redirect_uri: 'http://127.0.0.1:9099/callback',
      });
      if (reg.client_secret) {
        tokenParams.set('client_secret', reg.client_secret);
      }

      const tokenRes = await fetch(`${instanceUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenParams.toString(),
      });
      const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string; expires_in: number };

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        clientId: reg.client_id,
        expiresIn: tokens.expires_in,
      };
    },
    setNow: (now: number) => {
      virtualNow = now;
    },
    getNow: () => virtualNow,
    setStoreOutage: async (backing, active) => {
      backing.fakeDb.setOutage(active);
    },
    supportsAdoption: false,
    supportsRegistration: true,
  };
}

const emulatorRunning = !!process.env.FIRESTORE_EMULATOR_HOST;

function createEmulatorHarness(): PermanenceHarness<EmulatorBacking> {
  const openServers: HttpServer[] = [];
  let virtualNow = Date.now();

  return {
    name: 'NetSapiens MCP (Emulator)',
    newBacking: async () => {
      const db = new Firestore({
        projectId: process.env.GOOGLE_CLOUD_PROJECT || 'firestore-test',
        ignoreUndefinedProperties: true,
      });
      return {
        db,
        collection: `perm_tokens_${randomBytes(4).toString('hex')}`,
      };
    },
    createInstance: async (backing) => {
      process.env.MCP_TRANSPORT = 'http';
      process.env.MCP_BASE_URL = 'http://localhost';
      process.env.NETSAPIENS_API_URL = 'https://ns.example.com';
      process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'op-client-id';
      process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'op-client-secret';
      process.env.MCP_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
      process.env.MCP_TOKEN_LIFETIME_HOURS = '1';
      process.env.MCP_PERSISTENCE = 'firestore';

      const tokenStore = new FirestoreTokenStore({
        db: backing.db,
        collection: backing.collection,
        now: () => virtualNow,
      });

      const authProvider = new NetSapiensAuthProvider({
        nsApiUrl: 'https://ns.example.com',
        nsClientId: 'op-client-id',
        nsClientSecret: 'op-client-secret',
        tokenStore,
        firestore: backing.db,
        tokenLifetimeSec: 3600,
        serverBaseUrl: 'http://localhost',
        now: () => virtualNow,
      });

      const created = createApp(authProvider);
      const server = created.app.listen(0);
      openServers.push(server);
      const port = (server.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}`;
      created.baseUrl.href = url;

      return {
        url,
        close: async () => {
          await new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          });
        },
      };
    },
    signIn: async (instanceUrl) => {
      vi.spyOn(axios, 'post').mockImplementation(async (url: string) => {
        if (url.includes('/ns-api/v2/tokens')) {
          return {
            data: {
              access_token: 'mock-ns-access-token',
              refresh_token: 'mock-ns-refresh-token',
              expires_in: 3600,
            },
            status: 200,
            statusText: 'OK',
            headers: {},
            config: {} as unknown as InternalAxiosRequestConfig,
          };
        }
        return {
          data: {},
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as unknown as InternalAxiosRequestConfig,
        };
      });

      vi.spyOn(axios, 'get').mockImplementation(async () => {
        return {
          data: {
            'user-scope': 'Reseller',
            user: 'alice',
            domain: 'example.com',
            email: 'alice@example.com',
            'name-full-name': 'Alice User',
          },
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as unknown as InternalAxiosRequestConfig,
        };
      });

      const regRes = await fetch(`${instanceUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'permanence-test-client',
          redirect_uris: ['http://127.0.0.1:9099/callback'],
          token_endpoint_auth_method: 'none',
        }),
      });
      const reg = (await regRes.json()) as { client_id: string; client_secret?: string };

      const authRes = await fetch(
        `${instanceUrl}/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=http://127.0.0.1:9099/callback&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256`,
      );
      const authHtml = await authRes.text();
      const authStateMatch = authHtml.match(/name="auth_state"\s+value="([^"]+)"/);
      const authState = authStateMatch ? authStateMatch[1] : '';

      const loginParams = new URLSearchParams({
        username: 'alice@example.com',
        password: 'password123',
        auth_state: authState,
      });

      const loginRes = await fetch(`${instanceUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: loginParams.toString(),
        redirect: 'manual',
      });

      const location = loginRes.headers.get('location') || '';
      const code = new URL(location, 'http://127.0.0.1:9099').searchParams.get('code') || '';

      const tokenParams = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        client_id: reg.client_id,
        redirect_uri: 'http://127.0.0.1:9099/callback',
      });
      if (reg.client_secret) {
        tokenParams.set('client_secret', reg.client_secret);
      }

      const tokenRes = await fetch(`${instanceUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenParams.toString(),
      });
      const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string; expires_in: number };

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        clientId: reg.client_id,
        expiresIn: tokens.expires_in,
      };
    },
    setNow: (now: number) => {
      virtualNow = now;
    },
    getNow: () => virtualNow,
    supportsAdoption: false,
    supportsRegistration: true,
  };
}

async function runLegacyAdoptionTest(db: Firestore): Promise<void> {
  const collection = `mcp_legacy_${randomBytes(4).toString('hex')}`;
  const refreshCollection = `${collection}_refresh`;
  const upstreamCollection = `${collection}_upstream`;

  const tokenStore = new FirestoreTokenStore({
    db,
    collection,
  });

  const authProvider = new NetSapiensAuthProvider({
    nsApiUrl: 'https://ns.example.com',
    nsClientId: 'op-client-id',
    nsClientSecret: 'op-client-secret',
    tokenStore,
    firestore: db,
    tokenLifetimeSec: 3600,
    serverBaseUrl: 'http://localhost',
  });

  // 1. Seed base-format valid token (no refreshFamilyId, pointer doc with only accessToken)
  const validAccess = 'at-base-valid-' + randomBytes(4).toString('hex');
  const validRefresh = 'rt-base-valid-' + randomBytes(4).toString('hex');
  const baseValidToken = {
    accessToken: validAccess,
    refreshToken: validRefresh,
    clientId: 'client-base-1',
    expiresAt: Date.now() + 3600_000,
    nsAccessToken: 'ns-at-valid-1',
    nsRefreshToken: 'ns-rt-valid-1',
    nsExpiresAt: Date.now() + 3600_000,
    nsUsername: 'alice@example.com',
    nsUserRole: 'reseller',
    nsApiUrl: 'https://ns.example.com',
    ttlAt: new Date(Date.now() + 30 * 24 * 3600_000),
  };
  await db.collection(collection).doc(validAccess).set(baseValidToken);
  await db.collection(refreshCollection).doc(validRefresh).set({
    accessToken: validAccess,
  });

  // Verify while valid adopts the document
  const authInfo = await authProvider.verifyAccessToken(validAccess);
  expect(authInfo).toBeDefined();
  expect(authInfo.token).toBe(validAccess);
  expect(authInfo.clientId).toBe('client-base-1');

  // Verify that the document was adopted into a family and upstream record was created in _upstream
  const adoptedAccessSnap = await db.collection(collection).doc(validAccess).get();
  const adoptedData = adoptedAccessSnap.data() as Record<string, unknown>;
  expect(adoptedData.refreshFamilyId).toBeDefined();
  const familyId = String(adoptedData.refreshFamilyId);

  const upstreamSnap = await db.collection(upstreamCollection).doc(familyId).get();
  expect(upstreamSnap.exists).toBe(true);
  const upstreamRecord = upstreamSnap.data() as { grant: { nsAccessToken: string; nsRefreshToken: string; nsUsername: string } };
  expect(upstreamRecord.grant.nsAccessToken).toBe('ns-at-valid-1');
  expect(upstreamRecord.grant.nsRefreshToken).toBe('ns-rt-valid-1');
  expect(upstreamRecord.grant.nsUsername).toBe('alice@example.com');

  // 2. Seed base-format expired token (expired access token, pointer doc)
  const expiredAccess = 'at-base-expired-' + randomBytes(4).toString('hex');
  const expiredRefresh = 'rt-base-expired-' + randomBytes(4).toString('hex');
  const baseExpiredToken = {
    accessToken: expiredAccess,
    refreshToken: expiredRefresh,
    clientId: 'client-base-2',
    expiresAt: Date.now() - 10_000, // expired MCP access token
    nsAccessToken: 'ns-at-expired-2',
    nsRefreshToken: 'ns-rt-expired-2',
    nsExpiresAt: Date.now() - 10_000, // expired NS access token needing NS refresh grant
    nsUsername: 'bob@example.com',
    nsUserRole: 'reseller',
    nsApiUrl: 'https://ns.example.com',
    ttlAt: new Date(Date.now() + 30 * 24 * 3600_000),
  };
  await db.collection(collection).doc(expiredAccess).set(baseExpiredToken);
  await db.collection(refreshCollection).doc(expiredRefresh).set({
    accessToken: expiredAccess,
  });

  // Mock upstream refresh endpoint for NetSapiens
  const postSpy = vi.spyOn(axios, 'post').mockImplementation(async (url: string) => {
    if (url.includes('/ns-api/v2/tokens')) {
      return {
        data: {
          access_token: 'new-ns-access-token-from-refresh',
          refresh_token: 'new-ns-refresh-token-from-refresh',
          expires_in: 3600,
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as unknown as InternalAxiosRequestConfig,
      };
    }
    return { data: {}, status: 200, statusText: 'OK', headers: {}, config: {} as unknown as InternalAxiosRequestConfig };
  });

  // Refresh after expiry adopts and rotates without re-auth
  const clientInfo = { client_id: 'client-base-2' } as unknown as OAuthClientInformationFull;
  const refreshedTokens = await authProvider.exchangeRefreshToken(clientInfo, expiredRefresh);
  expect(refreshedTokens.access_token).toBeDefined();
  expect(refreshedTokens.access_token).not.toBe(expiredAccess);
  expect(refreshedTokens.refresh_token).not.toBe(expiredRefresh);

  // New access token works immediately
  const newAuthInfo = await authProvider.verifyAccessToken(refreshedTokens.access_token);
  expect(newAuthInfo.token).toBe(refreshedTokens.access_token);

  // Upstream grant was moved to _upstream and updated
  const newAccessSnap = await db.collection(collection).doc(refreshedTokens.access_token).get();
  const newAccessData = newAccessSnap.data() as Record<string, unknown>;
  expect(newAccessData.refreshFamilyId).toBeDefined();
  const expiredFamilyId = String(newAccessData.refreshFamilyId);

  const expiredUpstreamSnap = await db.collection(upstreamCollection).doc(expiredFamilyId).get();
  expect(expiredUpstreamSnap.exists).toBe(true);
  const expiredUpstreamData = expiredUpstreamSnap.data() as { grant: { nsAccessToken: string; nsRefreshToken: string } };
  expect(expiredUpstreamData.grant.nsAccessToken).toBe('new-ns-access-token-from-refresh');
  expect(expiredUpstreamData.grant.nsRefreshToken).toBe('new-ns-refresh-token-from-refresh');

  // 3. Seed base-format valid MCP token with an expired NS access token needing NS refresh grant
  const validExpNsAccess = 'at-base-valid-expns-' + randomBytes(4).toString('hex');
  const validExpNsRefresh = 'rt-base-valid-expns-' + randomBytes(4).toString('hex');
  const baseValidExpNsToken = {
    accessToken: validExpNsAccess,
    refreshToken: validExpNsRefresh,
    clientId: 'client-base-3',
    expiresAt: Date.now() + 3600_000, // valid MCP token
    nsAccessToken: 'ns-at-stale-3',
    nsRefreshToken: 'ns-rt-stale-3',
    nsExpiresAt: Date.now() - 10_000, // expired NS access token
    nsUsername: 'carol@example.com',
    nsUserRole: 'reseller',
    nsApiUrl: 'https://ns.example.com',
    ttlAt: new Date(Date.now() + 30 * 24 * 3600_000),
  };
  await db.collection(collection).doc(validExpNsAccess).set(baseValidExpNsToken);
  await db.collection(refreshCollection).doc(validExpNsRefresh).set({
    accessToken: validExpNsAccess,
  });

  // Verify adopts the document and transparently refreshes the expired NS access token
  const validExpAuthInfo = await authProvider.verifyAccessToken(validExpNsAccess);
  expect(validExpAuthInfo).toBeDefined();
  expect(validExpAuthInfo.token).toBe(validExpNsAccess);

  const expNsAccessSnap = await db.collection(collection).doc(validExpNsAccess).get();
  const expNsAccessData = expNsAccessSnap.data() as Record<string, unknown>;
  expect(expNsAccessData.refreshFamilyId).toBeDefined();
  const expNsFamilyId = String(expNsAccessData.refreshFamilyId);

  const expNsUpstreamSnap = await db.collection(upstreamCollection).doc(expNsFamilyId).get();
  expect(expNsUpstreamSnap.exists).toBe(true);
  const expNsUpstreamData = expNsUpstreamSnap.data() as { grant: { nsAccessToken: string; nsRefreshToken: string } };
  expect(expNsUpstreamData.grant.nsAccessToken).toBe('new-ns-access-token-from-refresh');

  postSpy.mockRestore();
}
describe('OAuth Permanence Contract (Memory)', () => {
  it('passes the C10 permanence contract against Memory token ledger', async () => {
    const harness = createMemoryHarness();
    await runPermanenceContract(harness);
  });
});

describe('OAuth Permanence Contract (Fake Firestore)', () => {
  it('passes the C10 permanence contract against Fake Firestore', async () => {
    const harness = createFakeFirestoreHarness();
    await runPermanenceContract(harness);
  });

  it('proves verify while valid and refresh after expiry adopt base-format Firestore documents with NS grant moved to _upstream', async () => {
    const fakeDb = new FakeFirestore();
    await runLegacyAdoptionTest(fakeDb as unknown as Firestore);
  });
});

describe.skipIf(!emulatorRunning)('OAuth Permanence Contract (Firestore Emulator)', () => {
  it('passes the C10 permanence contract against Firestore Emulator', async () => {
    const harness = createEmulatorHarness();
    await runPermanenceContract(harness);
  });

  it('proves verify while valid and refresh after expiry adopt base-format Firestore documents with NS grant moved to _upstream on emulator', async () => {
    const db = new Firestore({
      projectId: process.env.GOOGLE_CLOUD_PROJECT || 'test-project',
      ignoreUndefinedProperties: true,
    });
    await runLegacyAdoptionTest(db);
  });
});

describe('Upstream NS refresh error classification (M5 guard)', () => {
  it('treats 401 from NS refresh as transient: does not revoke session, returns temporarily_unavailable', async () => {
    const fakeDb = new FakeFirestore();
    const tokenStore = new FirestoreTokenStore({
      db: fakeDb as unknown as Firestore,
      collection: 'mcp_m5_tokens',
    });
    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://ns.example.com',
      nsClientId: 'op-client-id',
      nsClientSecret: 'op-client-secret',
      tokenStore,
      firestore: fakeDb as unknown as Firestore,
      tokenLifetimeSec: 3600,
      serverBaseUrl: 'http://localhost',
    });

    const access = 'at-m5-test';
    const refresh = 'rt-m5-test';
    const client_id = 'client-m5';
    await authProvider.tokenStore.set({
      accessToken: access,
      refreshToken: refresh,
      clientId: client_id,
      expiresAt: Date.now() - 1000, // expired
      nsAccessToken: 'old-ns-token',
      nsRefreshToken: 'old-ns-refresh',
      nsExpiresAt: Date.now() - 1000,
      nsUsername: 'test@example.com',
      nsUserRole: 'domain_admin',
      nsApiUrl: 'https://ns.example.com',
    });

    // 1. NS refresh returns 401 (e.g. transient proxy/secret blip)
    const postSpy = vi.spyOn(axios, 'post').mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 401,
        data: { error: 'unauthorized', message: 'Invalid credentials or proxy blip' },
      },
      message: 'Request failed with status code 401',
    });

    const clientInfo = { client_id } as unknown as OAuthClientInformationFull;
    let thrownError: unknown;
    try {
      await authProvider.exchangeRefreshToken(clientInfo, refresh);
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeDefined();
    // Must be TemporarilyUnavailableError, NOT InvalidGrantError
    expect(thrownError).toBeInstanceOf(TemporarilyUnavailableError);

    // Crucial: token/family must NOT be revoked or deleted!
    const lookup = await (tokenStore as unknown as TokenLedger<StoredToken>).lookupRefresh(refresh, client_id);
    expect(lookup.status, 'family must remain intact on transient 401').not.toBe('missing');
    expect(lookup.status, 'family must remain intact on transient 401').not.toBe('replay');

    // 2. When NS recovers, refresh succeeds without re-authenticating
    postSpy.mockResolvedValueOnce({
      data: {
        access_token: 'new-ns-access-after-recovery',
        refresh_token: 'new-ns-refresh-after-recovery',
        expires_in: 3600,
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as unknown as InternalAxiosRequestConfig,
    });

    const recovered = await authProvider.exchangeRefreshToken(clientInfo, refresh);
    expect(recovered.access_token).toBeDefined();

    postSpy.mockRestore();
  });
});

async function runTtlPolicyIsolationTest(db: Firestore, collection: string): Promise<void> {
  const store = new FirestoreTokenStore({
    db,
    collection,
  });

  const now = Date.now();
  const initialToken: StoredToken = {
    accessToken: `access-${randomBytes(4).toString('hex')}`,
    refreshToken: `refresh-${randomBytes(4).toString('hex')}`,
    clientId: 'client-ttl-test',
    expiresAt: now + 3600_000,
    ttlAt: new Date(now + 30 * 24 * 3600_000),
    nsAccessToken: 'ns-acc-1',
    nsRefreshToken: 'ns-ref-1',
    nsExpiresAt: now + 3600_000,
    nsUsername: 'ttl@example.com',
    nsUserRole: 'domain_admin',
    nsApiUrl: 'https://ns.example.com',
  };

  // 1. Issue
  const issued = await store.issue(initialToken);
  expect(issued.refreshFamilyId).toBeDefined();
  const familyId = issued.refreshFamilyId!;

  // Check access doc: MUST have ttlAt
  const accessSnap = await db.collection(collection).doc(issued.accessToken).get();
  expect(accessSnap.exists).toBe(true);
  expect(accessSnap.data()?.ttlAt).toBeDefined();

  // Check refresh doc: MUST NOT have ttlAt
  const refreshSnap = await db.collection(`${collection}_refresh`).doc(issued.refreshToken).get();
  expect(refreshSnap.exists).toBe(true);
  expect(refreshSnap.data()?.ttlAt, `refresh doc in ${collection}_refresh must not have ttlAt`).toBeUndefined();

  // Check refresh family doc: MUST NOT have ttlAt
  const familySnap = await db.collection(`${collection}_refresh_families`).doc(familyId).get();
  expect(familySnap.exists).toBe(true);
  expect(familySnap.data()?.ttlAt, `family doc in ${collection}_refresh_families must not have ttlAt`).toBeUndefined();

  // Check upstream doc: MUST NOT have ttlAt
  const upstreamSnap = await db.collection(`${collection}_upstream`).doc(familyId).get();
  expect(upstreamSnap.exists).toBe(true);
  expect(upstreamSnap.data()?.ttlAt, `upstream doc in ${collection}_upstream must not have ttlAt`).toBeUndefined();

  // 2. Rotate
  const nextToken: StoredToken = {
    accessToken: `access-rot-${randomBytes(4).toString('hex')}`,
    refreshToken: `refresh-rot-${randomBytes(4).toString('hex')}`,
    clientId: 'client-ttl-test',
    expiresAt: now + 7200_000,
    ttlAt: new Date(now + 30 * 24 * 3600_000),
    nsAccessToken: 'ns-acc-2',
    nsRefreshToken: 'ns-ref-2',
    nsExpiresAt: now + 7200_000,
    nsUsername: 'ttl@example.com',
    nsUserRole: 'domain_admin',
    nsApiUrl: 'https://ns.example.com',
  };

  const rot = await store.rotate(issued.refreshToken, nextToken, 'client-ttl-test', now + 1000);
  expect(rot.status).toBe('claimed');

  // Check rotated access doc: MUST have ttlAt
  const rotAccessSnap = await db.collection(collection).doc(nextToken.accessToken).get();
  expect(rotAccessSnap.exists).toBe(true);
  expect(rotAccessSnap.data()?.ttlAt).toBeDefined();

  // Check rotated refresh doc: MUST NOT have ttlAt
  const rotRefreshSnap = await db.collection(`${collection}_refresh`).doc(nextToken.refreshToken).get();
  expect(rotRefreshSnap.exists).toBe(true);
  expect(rotRefreshSnap.data()?.ttlAt, `new refresh doc in ${collection}_refresh must not have ttlAt`).toBeUndefined();

  // Check consumed old refresh doc: MUST NOT have ttlAt
  const oldRefreshSnap = await db.collection(`${collection}_refresh`).doc(issued.refreshToken).get();
  expect(oldRefreshSnap.exists).toBe(true);
  expect(oldRefreshSnap.data()?.ttlAt, `consumed refresh doc in ${collection}_refresh must not have ttlAt`).toBeUndefined();

  // Check family doc after rotation: MUST NOT have ttlAt
  const rotFamilySnap = await db.collection(`${collection}_refresh_families`).doc(familyId).get();
  expect(rotFamilySnap.exists).toBe(true);
  expect(rotFamilySnap.data()?.ttlAt, `family doc after rotation must not have ttlAt`).toBeUndefined();

  // Check upstream doc after rotation: MUST NOT have ttlAt
  const rotUpstreamSnap = await db.collection(`${collection}_upstream`).doc(familyId).get();
  expect(rotUpstreamSnap.exists).toBe(true);
  expect(rotUpstreamSnap.data()?.ttlAt, `upstream doc after rotation must not have ttlAt`).toBeUndefined();
}

describe('TTL Policy Isolation on Subsidiary Collections (Fake Firestore)', () => {
  const collections = ['mcp_tokens', 'readonly_mcp_tokens', 'pwmcp_tokens'];
  for (const col of collections) {
    it(`asserts _refresh, _refresh_families, and _upstream carry NO ttlAt for ${col}`, async () => {
      const fakeDb = new FakeFirestore();
      await runTtlPolicyIsolationTest(fakeDb as unknown as Firestore, col);
    });
  }
});

describe.skipIf(!emulatorRunning)('TTL Policy Isolation on Subsidiary Collections (Firestore Emulator)', () => {
  const collections = ['mcp_tokens', 'readonly_mcp_tokens', 'pwmcp_tokens'];
  for (const col of collections) {
    it(`asserts _refresh, _refresh_families, and _upstream carry NO ttlAt for ${col} on emulator`, async () => {
      const db = new Firestore({
        projectId: process.env.GOOGLE_CLOUD_PROJECT || 'test-project',
        ignoreUndefinedProperties: true,
      });
      await runTtlPolicyIsolationTest(db, col);
    });
  }
});
