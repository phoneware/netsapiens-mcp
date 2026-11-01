import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidGrantError, InvalidTokenError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { NetSapiensAuthProvider, UpstreamGrantRejectedError } from '../auth/netsapiens-auth-provider.js';
import { createMemoryStore } from '../store/memory.js';
import { createSqliteStore } from '../store/sqlite.js';
import { deriveStoreKey, LeaseLostError, RetryableRefreshError } from '../store/codec.js';
import type { McpStore, StoredToken } from '../store/types.js';

const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const key = deriveStoreKey(secret);
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const emulatorRunning = !!emulatorHost;

function makeProvider(options: {
  store: McpStore;
  serverBaseUrl?: string;
}) {
  return new NetSapiensAuthProvider({
    platforms: [{ id: 'default', label: 'Default', apiUrl: 'https://netsapiens.example.com' }],
    nsApiUrl: 'https://netsapiens.example.com',
    nsClientId: 'cid',
    nsClientSecret: 'csec',
    serverBaseUrl: options.serverBaseUrl || 'http://localhost:3000',
    store: options.store,
  });
}

function makeApp(provider: NetSapiensAuthProvider) {
  const app = express();
  app.use(express.json());
  const resourceMetadataUrl = new URL('http://localhost:3000/.well-known/oauth-protected-resource');
  app.use('/mcp', requireBearerAuth({ verifier: provider, resourceMetadataUrl }));
  app.post('/mcp', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('NetSapiensAuthProvider store wiring & Contract C1', () => {
  it('throws when constructed without store', () => {
    expect(() => new NetSapiensAuthProvider({
      platforms: [{ id: 'default', label: 'Default', apiUrl: 'https://netsapiens.example.com' }],
      nsApiUrl: 'https://netsapiens.example.com',
      nsClientId: 'cid',
      nsClientSecret: 'csec',
      store: undefined as unknown as McpStore,
    })).toThrow('store is required');
  });

  describe.each([
    ['memory', () => createMemoryStore({ namespace: 'test_c1', key })],
    ['sqlite', () => {
      const dir = mkdtempSync(join(tmpdir(), 'nsmcp-c1-sqlite-'));
      const dbPath = join(dir, 'test.sqlite');
      return createSqliteStore({ path: dbPath, namespace: 'test_c1', key });
    }],
  ])('Contract C1 on %s store', (_backendName, storeFactory) => {
    let store: McpStore;
    let provider: NetSapiensAuthProvider;
    let app: express.Express;

    beforeEach(() => {
      process.env.MCP_SESSION_SECRET = secret;
      store = storeFactory();
      provider = makeProvider({ store });
      app = makeApp(provider);
    });

    afterEach(async () => {
      await store.close();
      vi.restoreAllMocks();
    });

    it('C1.1: unknown bearer returns 401 with exact WWW-Authenticate header', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Authorization', 'Bearer unknown-token');

      expect(res.status).toBe(401);
      const authHeader = res.headers['www-authenticate'];
      expect(authHeader).toBeDefined();
      expect(authHeader).toContain('Bearer error="invalid_token", error_description="Invalid access token"');
    });

    it('C1.5: store error in sessions.get propagates as 500, never 401', async () => {
      vi.spyOn(store.sessions, 'get').mockRejectedValueOnce(new Error('Underlying store failure'));

      const res = await request(app)
        .post('/mcp')
        .set('Authorization', 'Bearer some-token');

      expect(res.status).toBe(500);
      expect(res.headers['www-authenticate']).toBeUndefined();
    });

    it('C1.2: expired MCP bearer returns 401 and deletes the token from store', async () => {
      const token = 'expired-bearer';
      const stored: StoredToken = {
        clientId: 'cid',
        expiresAt: Date.now() - 1000,
        nsAccessToken: 'ns-tok',
        nsUsername: 'alice',
        serverBaseUrl: 'http://localhost:3000',
      };
      await store.sessions.create({ accessToken: token, refreshToken: 'ref-exp' }, stored);

      const res = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
      expect(res.headers['www-authenticate']).toContain('Access token expired');
      expect(await store.sessions.get(token)).toBeUndefined();
    });

    it('C1.2: serverBaseUrl mismatch returns 401 and does not delete the token', async () => {
      const token = 'cross-server-bearer';
      const stored: StoredToken = {
        clientId: 'cid',
        expiresAt: Date.now() + 60_000,
        nsAccessToken: 'ns-tok',
        nsUsername: 'alice',
        serverBaseUrl: 'http://other-server:3000',
      };
      await store.sessions.create({ accessToken: token, refreshToken: 'ref-cross' }, stored);

      const res = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toContain('Access token was issued for a different server');
      expect(await store.sessions.get(token)).toBeDefined();
    });

    it('C1.3: session deleted during upstream refresh gives 401 Invalid access token', async () => {
      const token = 'refresh-delete-bearer';
      const stored: StoredToken = {
        clientId: 'cid',
        expiresAt: Date.now() + 60_000,
        nsAccessToken: 'ns-tok',
        nsRefreshToken: 'ns-ref',
        nsExpiresAt: Date.now() - 1000, // needs upstream refresh
        nsUsername: 'alice',
        serverBaseUrl: 'http://localhost:3000',
      };
      await store.sessions.create({ accessToken: token, refreshToken: 'ref-del' }, stored);

      // Simulate refreshUpstream failing because token was deleted concurrently
      vi.spyOn(store.sessions, 'refreshUpstream').mockImplementationOnce(async () => {
        await store.sessions.delete(token);
        throw new Error('Token doc was deleted/revoked during refresh');
      });

      const res = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toContain('Bearer error="invalid_token", error_description="Invalid access token"');
    });

    it('C1.4: RetryableRefreshError during refresh returns 500', async () => {
      const token = 'retryable-bearer';
      const stored: StoredToken = {
        clientId: 'cid',
        expiresAt: Date.now() + 60_000,
        nsAccessToken: 'ns-tok',
        nsRefreshToken: 'ns-ref',
        nsExpiresAt: Date.now() - 1000,
        nsUsername: 'alice',
        serverBaseUrl: 'http://localhost:3000',
      };
      await store.sessions.create({ accessToken: token, refreshToken: 'ref-ret' }, stored);

      vi.spyOn(store.sessions, 'refreshUpstream').mockRejectedValueOnce(new RetryableRefreshError());

      const res = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
      expect(res.headers['www-authenticate']).toBeUndefined();
      // Token was NOT deleted on retryable error
      expect(await store.sessions.get(token)).toBeDefined();
    });

    it('C1.4: LeaseLostError during refresh returns 500', async () => {
      const token = 'leaselost-bearer';
      const stored: StoredToken = {
        clientId: 'cid',
        expiresAt: Date.now() + 60_000,
        nsAccessToken: 'ns-tok',
        nsRefreshToken: 'ns-ref',
        nsExpiresAt: Date.now() - 1000,
        nsUsername: 'alice',
        serverBaseUrl: 'http://localhost:3000',
      };
      await store.sessions.create({ accessToken: token, refreshToken: 'ref-lease' }, stored);

      vi.spyOn(store.sessions, 'refreshUpstream').mockRejectedValueOnce(new LeaseLostError());

      const res = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
      expect(res.headers['www-authenticate']).toBeUndefined();
      expect(await store.sessions.get(token)).toBeDefined();
    });

    it('UpstreamGrantRejectedError during refresh deletes token and returns 401', async () => {
      const token = 'grant-rejected-bearer';
      const stored: StoredToken = {
        clientId: 'cid',
        expiresAt: Date.now() + 60_000,
        nsAccessToken: 'ns-tok',
        nsRefreshToken: 'ns-ref',
        nsExpiresAt: Date.now() - 1000,
        nsUsername: 'alice',
        serverBaseUrl: 'http://localhost:3000',
      };
      await store.sessions.create({ accessToken: token, refreshToken: 'ref-rej' }, stored);

      vi.spyOn(axios, 'post').mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 400, data: { error: 'invalid_grant', error_description: 'Token revoked' } },
      });

      const res = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toContain('Upstream access token expired and could not be refreshed');
      expect(await store.sessions.get(token)).toBeUndefined();
    });

    it('round-trips auth code creation, challenge verification, and redemption', async () => {
      const client: OAuthClientInformationFull = {
        client_id: 'client-test',
        redirect_uris: ['http://localhost/callback'],
        token_endpoint_auth_method: 'none',
      };

      let redirectUrl = '';
      const mockRes = {
        redirect: (url: string) => { redirectUrl = url; },
      } as unknown as import('express').Response;

      await (provider as unknown as { completeLogin: (...args: unknown[]) => Promise<void> }).completeLogin(
        { clientId: 'client-test', codeChallenge: 'chal-12345', redirectUri: 'http://localhost/callback', createdAt: Date.now() },
        { access_token: 'ns-tok', refresh_token: 'ns-ref-tok', username: 'alice@domain.com', expires_in: 3600 },
        'alice@domain.com',
        mockRes,
        { extraKey: 'extraVal' },
      );

      const code = new URL(redirectUrl).searchParams.get('code');
      expect(code).toBeTruthy();

      const challenge = await provider.challengeForAuthorizationCode(client, code!);
      expect(challenge).toBe('chal-12345');

      const tokens = await provider.exchangeAuthorizationCode(client, code!);
      expect(tokens.access_token).toBeDefined();
      expect(tokens.refresh_token).toBeDefined();

      // Second redemption must fail
      await expect(provider.exchangeAuthorizationCode(client, code!)).rejects.toBeInstanceOf(InvalidGrantError);

      // Verify the minted bearer token succeeds
      const checkRes = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${tokens.access_token}`);
      expect(checkRes.status).toBe(200);

      // Verify refresh_token rotation
      vi.spyOn(axios, 'post').mockResolvedValueOnce({
        data: { access_token: 'ns-new-tok', refresh_token: 'ns-new-ref', expires_in: 3600 },
      });
      const refreshed = await provider.exchangeRefreshToken(client, tokens.refresh_token!);
      expect(refreshed.access_token).toBeDefined();
      expect(refreshed.refresh_token).toBeDefined();
      expect(refreshed.access_token).not.toBe(tokens.access_token);

      // Old bearer token should now be deleted
      const oldBearerRes = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${tokens.access_token}`);
      expect(oldBearerRes.status).toBe(401);

      // Revoking by refresh token removes session
      await provider.revokeToken(client, { token: refreshed.refresh_token! });
      const revokedRes = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${refreshed.access_token}`);
      expect(revokedRes.status).toBe(401);
    });
  });

  describe.skipIf(!emulatorRunning)('Firestore multi-instance coordination (emulator)', () => {
    let store1: McpStore;
    let store2: McpStore;
    let provider1: NetSapiensAuthProvider;
    let provider2: NetSapiensAuthProvider;
    let app2: express.Express;

    beforeAll(async () => {
      process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'nsmcp-st3';
      process.env.MCP_SESSION_SECRET = secret;

      const { Firestore } = await import('@google-cloud/firestore');
      const { createFirestoreStore } = await import('../store/firestore.js');
      const db = new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT, ignoreUndefinedProperties: true });
      const namespace = `fs_${randomBytes(4).toString('hex')}`;

      store1 = createFirestoreStore({ db, namespace, key });
      store2 = createFirestoreStore({ db, namespace, key });

      provider1 = makeProvider({ store: store1 });
      provider2 = makeProvider({ store: store2 });
      app2 = makeApp(provider2);
    });

    afterAll(async () => {
      await store1?.close();
      await store2?.close();
    });

    it('code issued by provider1 is redeemed by provider2 on Firestore', async () => {
      const client: OAuthClientInformationFull = {
        client_id: 'client-multi',
        redirect_uris: ['http://localhost/callback'],
        token_endpoint_auth_method: 'none',
      };

      let redirectUrl = '';
      const mockRes = {
        redirect: (url: string) => { redirectUrl = url; },
      } as unknown as import('express').Response;

      await (provider1 as unknown as { completeLogin: (...args: unknown[]) => Promise<void> }).completeLogin(
        { clientId: 'client-multi', codeChallenge: 'chal-multi', redirectUri: 'http://localhost/callback', createdAt: Date.now() },
        { access_token: 'ns-tok-multi', username: 'multi@domain.com', expires_in: 3600 },
        'multi@domain.com',
        mockRes,
      );

      const code = new URL(redirectUrl).searchParams.get('code')!;
      expect(code).toBeTruthy();

      // Provider 2 verifies challenge and redeems
      const challenge = await provider2.challengeForAuthorizationCode(client, code);
      expect(challenge).toBe('chal-multi');

      const tokens = await provider2.exchangeAuthorizationCode(client, code);
      expect(tokens.access_token).toBeDefined();

      // Provider 2 accepts bearer token issued through exchange
      const res = await request(app2)
        .post('/mcp')
        .set('Authorization', `Bearer ${tokens.access_token}`);
      expect(res.status).toBe(200);
    });

    it('transparent upstream refresh coordinates across instances', async () => {
      const token = 'fs-cross-refresh-token';
      const stored: StoredToken = {
        clientId: 'cid-multi',
        expiresAt: Date.now() + 60_000,
        nsAccessToken: 'ns-initial',
        nsRefreshToken: 'ns-initial-refresh',
        nsExpiresAt: Date.now() - 1000, // expired
        nsUsername: 'multi-user',
        serverBaseUrl: 'http://localhost:3000',
      };
      await store1.sessions.create({ accessToken: token, refreshToken: 'fs-refresh' }, stored);

      vi.spyOn(axios, 'post').mockResolvedValueOnce({
        data: {
          access_token: 'ns-refreshed-token',
          refresh_token: 'ns-refreshed-refresh',
          expires_in: 3600,
        },
      });

      // Provider 2 verifies token and transparently refreshes
      const auth = await provider2.verifyAccessToken(token);
      expect(auth.extra?.nsAccessToken).toBe('ns-refreshed-token');

      // Provider 1 sees the refreshed token
      const fromStore1 = await store1.sessions.get(token);
      expect(fromStore1?.nsAccessToken).toBe('ns-refreshed-token');
    });
  });
});
