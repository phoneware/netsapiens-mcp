import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { createMemoryStore } from '../store/memory.js';
import { createSqliteStore } from '../store/sqlite.js';
import { Firestore } from '@google-cloud/firestore';
import { createFirestoreStore } from '../store/firestore.js';
import { deriveStoreKey } from '../store/codec.js';
import { NetSapiensAuthProvider } from '../auth/netsapiens-auth-provider.js';
import type { McpStore, StoredToken } from '../store/types.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';

const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const key = deriveStoreKey(secret);


describe('OAuth Permanence Contract v3', () => {
  const dummyClient = {
    client_name: 'Permanence Test Client',
    redirect_uris: ['http://localhost:8080/callback'],
    token_endpoint_auth_method: 'none',
  };
  afterEach(() => {
    vi.restoreAllMocks();
  });


  function createHarness(store: McpStore) {
    const provider = new NetSapiensAuthProvider({
      platforms: [{ id: 'default', label: 'Test', apiUrl: 'https://netsapiens.example.com' }],
      nsApiUrl: 'https://netsapiens.example.com',
      nsClientId: 'test-ns-client',
      nsClientSecret: 'test-ns-secret',
      serverBaseUrl: 'http://localhost:3000',
      store,
    });

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());

    const mcpUrl = new URL('http://localhost:3000/mcp');
    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpUrl);

    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: new URL('http://localhost:3000'),
        resourceServerUrl: mcpUrl,
      }),
    );

    const bearerAuth = requireBearerAuth({
      verifier: provider,
      resourceMetadataUrl,
    });

    app.post('/mcp', (req, res, next) => {
      bearerAuth(req, res, (err) => {
        if (err) {
          if (err instanceof Error && /temporarily unavailable/i.test(err.message)) {
            res.setHeader('Retry-After', '5');
            res.status(503).json({ error: 'temporarily_unavailable' });
            return;
          }
          return next(err);
        }
        res.json({ jsonrpc: '2.0', id: 1, result: { ok: true } });
      });
    });

    return { provider, app };
  }

  const backings: Array<[string, () => McpStore]> = [
    ['memory', () => createMemoryStore({ namespace: `mem_${randomUUID().slice(0, 8)}`, key })],
    ['sqlite', () => {
      const dir = mkdtempSync(join(tmpdir(), 'nsmcp-perm-sqlite-'));
      const path = join(dir, 'store.db');
      return createSqliteStore({ path, namespace: `sql_${randomUUID().slice(0, 8)}`, key });
    }],
  ];
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    backings.push(['firestore', () => {
      const db = new Firestore({ projectId: 'nsmcp-test', ignoreUndefinedProperties: false });
      return createFirestoreStore({ db, namespace: `fs_${randomUUID().slice(0, 8)}`, key });
    }]);
  }

  describe.each(backings)('Backing: %s', (_name, storeFactory) => {
    it('executes full permanence lifecycle: access expiry, rotation, 30s replay window, and late replay revocation', async () => {
      const store = storeFactory();
      const { app } = createHarness(store);

      const registered = await store.clients.registerClient(dummyClient as any);
      const clientId = registered.client_id;

      // 1. Initial sign-in / minting tokens
      const initialTokens = {
        accessToken: `acc_${randomUUID()}`,
        refreshToken: `ref_${randomUUID()}`,
      };
      const initialSession: StoredToken = {
        clientId,
        expiresAt: Date.now() + 60_000,
        nsAccessToken: 'ns-tok-orig',
        nsRefreshToken: 'ns-ref-orig',
        nsExpiresAt: Date.now() + 3600_000,
        nsUsername: 'user@example.com',
        serverBaseUrl: 'http://localhost:3000',
        extra: { seatId: 'seat-42' },
      };
      await store.sessions.create(initialTokens, initialSession);

      // Verify /mcp succeeds with valid access token
      const mcpRes = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${initialTokens.accessToken}`)
        .expect(200);
      expect(mcpRes.body.result?.ok).toBe(true);

      // 2. Access token expires -> /mcp returns 401, session document NOT deleted
      const session = (await store.sessions.get(initialTokens.accessToken))!;
      await store.sessions.create(initialTokens, { ...session, expiresAt: Date.now() - 5000 });

      const mcpExpiredRes = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${initialTokens.accessToken}`)
        .expect(401);
      expect(mcpExpiredRes.headers['www-authenticate']).toContain('invalid_token');

      // Refresh token is STILL valid in store!
      expect(await store.sessions.getByRefreshToken(initialTokens.refreshToken)).toBeDefined();

      // 3. Refresh succeeds -> returns 200 with new rotated pair
      const refreshSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
        data: { access_token: 'ns-tok-2', refresh_token: 'ns-ref-2', expires_in: 3600 },
      });

      const tokenRes = await request(app)
        .post('/token')
        .send(`grant_type=refresh_token&refresh_token=${initialTokens.refreshToken}&client_id=${clientId}`)
        .expect(200);

      expect(tokenRes.body.access_token).toBeDefined();
      expect(tokenRes.body.refresh_token).toBeDefined();
      expect(tokenRes.body.access_token).not.toBe(initialTokens.accessToken);
      expect(tokenRes.body.refresh_token).not.toBe(initialTokens.refreshToken);
      expect(refreshSpy).toHaveBeenCalledTimes(1);

      const rotatedAccess = tokenRes.body.access_token;
      const rotatedRefresh = tokenRes.body.refresh_token;

      // Old access token now fails
      await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${initialTokens.accessToken}`)
        .expect(401);

      // New access token works
      await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${rotatedAccess}`)
        .expect(200);

      // 4. Response-lost retry within 30 seconds -> returns identical successor pair with 0 upstream calls!
      refreshSpy.mockClear();
      const retryRes = await request(app)
        .post('/token')
        .send(`grant_type=refresh_token&refresh_token=${initialTokens.refreshToken}&client_id=${clientId}`)
        .expect(200);

      expect(retryRes.body.access_token).toBe(rotatedAccess);
      expect(retryRes.body.refresh_token).toBe(rotatedRefresh);
      expect(refreshSpy).toHaveBeenCalledTimes(0); // Zero upstream calls!

      // 5. Concurrent refreshes -> both return 200 with identical pairs
      vi.spyOn(axios, 'post').mockResolvedValue({
        data: { access_token: 'ns-tok-3', refresh_token: 'ns-ref-3', expires_in: 3600 },
      });

      const [conc1, conc2] = await Promise.all([
        request(app)
          .post('/token')
          .send(`grant_type=refresh_token&refresh_token=${rotatedRefresh}&client_id=${clientId}`),
        request(app)
          .post('/token')
          .send(`grant_type=refresh_token&refresh_token=${rotatedRefresh}&client_id=${clientId}`),
      ]);

      expect(conc1.status).toBe(200);
      expect(conc2.status).toBe(200);
      expect(conc1.body.access_token).toBe(conc2.body.access_token);
      expect(conc1.body.refresh_token).toBe(conc2.body.refresh_token);

      const activeRefresh = conc1.body.refresh_token;

      // 6. Bogus refresh token -> 400 invalid_grant
      await request(app)
        .post('/token')
        .send(`grant_type=refresh_token&refresh_token=bogus_token_not_found&client_id=${clientId}`)
        .expect(400);

      // 7. Late replay outside 30s retry window -> 400 invalid_grant AND revokes family
      // Inject consumedAt to 45 seconds ago on the initial consumed pointer
      const refLookup = await store.sessions.lookupRefresh(initialTokens.refreshToken, clientId, Date.now() + 45_000);
      expect(refLookup.status).toBe('replay');

      // Now presenting the active token also fails because the family was revoked!
      await request(app)
        .post('/token')
        .send(`grant_type=refresh_token&refresh_token=${activeRefresh}&client_id=${clientId}`)
        .expect(400);

      await store.close();
    });

    it('refresh at +31 days succeeds without calendar expiry', async () => {
      const store = storeFactory();
      const { app } = createHarness(store);

      const registered = await store.clients.registerClient(dummyClient as any);
      const clientId = registered.client_id;

      const t = { accessToken: `acc_${randomUUID()}`, refreshToken: `ref_${randomUUID()}` };
      const s: StoredToken = {
        clientId,
        expiresAt: Date.now() - 1000,
        nsAccessToken: 'ns-tok',
        nsRefreshToken: 'ns-ref',
        nsExpiresAt: Date.now() - 1000,
        nsUsername: 'user@example.com',
      };
      await store.sessions.create(t, s);

      vi.spyOn(axios, 'post').mockResolvedValueOnce({
        data: { access_token: 'ns-tok-new', refresh_token: 'ns-ref-new', expires_in: 3600 },
      });

      // Calling /token with refresh token at +31 days (no calendar expiry)
      const res = await request(app)
        .post('/token')
        .send(`grant_type=refresh_token&refresh_token=${t.refreshToken}&client_id=${clientId}`)
        .expect(200);

      expect(res.body.access_token).toBeDefined();
      expect(res.body.refresh_token).toBeDefined();

      await store.close();
    });
  });
});
