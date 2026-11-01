import { describe, it, vi } from 'vitest';
import type { Server as HttpServer } from 'node:http';
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
          const { promise, resolve } = Promise.withResolvers<void>();
          server.close(() => resolve());
          await promise;
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
      vi.setSystemTime(now);
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
          const { promise, resolve } = Promise.withResolvers<void>();
          server.close(() => resolve());
          await promise;
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
      vi.setSystemTime(now);
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
          const { promise, resolve } = Promise.withResolvers<void>();
          server.close(() => resolve());
          await promise;
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
      vi.setSystemTime(now);
    },
    getNow: () => virtualNow,
    supportsAdoption: false,
    supportsRegistration: true,
  };
}

describe('OAuth Permanence Contract (Memory)', () => {
  it('passes the C10 permanence contract against Memory token ledger', async () => {
    vi.useFakeTimers();
    try {
      const harness = createMemoryHarness();
      await runPermanenceContract(harness);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('OAuth Permanence Contract (Fake Firestore)', () => {
  it('passes the C10 permanence contract against Fake Firestore', async () => {
    vi.useFakeTimers();
    try {
      const harness = createFakeFirestoreHarness();
      await runPermanenceContract(harness);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.skipIf(!emulatorRunning)('OAuth Permanence Contract (Firestore Emulator)', () => {
  it('passes the C10 permanence contract against Firestore Emulator', async () => {
    vi.useFakeTimers();
    try {
      const harness = createEmulatorHarness();
      await runPermanenceContract(harness);
    } finally {
      vi.useRealTimers();
    }
  });
});
