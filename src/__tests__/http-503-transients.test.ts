import { describe, expect, it, vi, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../http-server.js';
import { createMemoryStore } from '../store/memory.js';
import { deriveStoreKey, StoreLockedError, StoreConfigError } from '../store/codec.js';

describe('HTTP 503 Transients & Permanence Middlewares', () => {
  const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const key = deriveStoreKey(secret);

  beforeAll(() => {
    process.env.MCP_TRANSPORT = 'http';
    process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'test-client';
    process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'test-secret';
    process.env.NETSAPIENS_API_URL = 'https://ns.example.com';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function buildTestApp(hookOperationalError = false) {
    const store = createMemoryStore({ namespace: `http_t_${randomUUID().slice(0, 8)}`, key });
    const { app, authProvider } = await createApp({
      store,
      hooks: hookOperationalError
        ? {
            onVerify: async () => {
              throw new Error('Database pool connection timeout');
            },
          }
        : undefined,
    });

    const client = await store.clients.registerClient({
      client_name: 'Test Client',
      redirect_uris: ['http://localhost/cb'],
      token_endpoint_auth_method: 'none',
    } as any);

    const tokens = { accessToken: `acc_${randomUUID()}`, refreshToken: `ref_${randomUUID()}` };
    await store.sessions.create(tokens, {
      clientId: client.client_id,
      expiresAt: Date.now() + 3600_000,
      nsAccessToken: 'ns-acc',
      nsRefreshToken: 'ns-ref',
      nsExpiresAt: Date.now() + 3600_000,
      nsUsername: 'user@example.com',
      nsUserRole: 'admin',
      nsApiUrl: 'https://ns.example.com',
    });

    return { app, store, client, tokens, authProvider };
  }

  it('/mcp sends 401 on missing Authorization header', async () => {
    const { app } = await buildTestApp();
    const res = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Bearer');
  });

  it('/mcp sends 401 on unknown or invalid bearer token', async () => {
    const { app } = await buildTestApp();
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer $$BEARERTOKEN_9QZ19DKAJSLD:L$$')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
  });

  it('/mcp sends 503 Retry-After: 5 on StoreLockedError', async () => {
    const { app, store, tokens } = await buildTestApp();
    vi.spyOn(store.sessions, 'get').mockRejectedValueOnce(new StoreLockedError('Database is locked'));

    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body.error).toBe('temporarily_unavailable');
  });

  it('/mcp sends 503 Retry-After: 5 on StoreConfigError', async () => {
    const { app, store, tokens } = await buildTestApp();
    vi.spyOn(store.sessions, 'get').mockRejectedValueOnce(new StoreConfigError('Store unavailable'));

    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body.error).toBe('temporarily_unavailable');
  });
  it('/mcp sends 503 Retry-After: 5 on raw plain Error (e.g. Firestore connection lost)', async () => {
    const { app, store, tokens } = await buildTestApp();
    vi.spyOn(store.sessions, 'get').mockRejectedValueOnce(new Error('Firestore connection lost'));

    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body.error).toBe('temporarily_unavailable');
  });


  it('/mcp sends 503 Retry-After: 5 when onVerify hook encounters an operational error', async () => {
    const { app, tokens } = await buildTestApp(true); // hook throws operational error

    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body.error).toBe('temporarily_unavailable');
  });

  it('/token sends 400 temporarily_unavailable when store fails during refresh', async () => {
    const { app, store, client, tokens } = await buildTestApp();
    vi.spyOn(store.sessions, 'lookupRefresh').mockRejectedValueOnce(new Error('Firestore connection lost'));

    const res = await request(app)
      .post('/token')
      .send(`grant_type=refresh_token&refresh_token=${tokens.refreshToken}&client_id=${client.client_id}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('temporarily_unavailable');
    expect(res.body.error_description).toContain('Service temporarily unavailable');
  });

  it('/token sends 400 invalid_grant on invalid refresh token', async () => {
    const { app, client } = await buildTestApp();
    const res = await request(app)
      .post('/token')
      .send(`grant_type=refresh_token&refresh_token=not_a_real_token&client_id=${client.client_id}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('/token never logs raw refresh token material on unknown refresh token', async () => {
    const { app, client } = await buildTestApp();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rawSecretToken = 'supersecret_raw_refresh_token_never_log_me';

    const res = await request(app)
      .post('/token')
      .send(`grant_type=refresh_token&refresh_token=${rawSecretToken}&client_id=${client.client_id}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');

    for (const call of warnSpy.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(rawSecretToken);
      expect(serialized).not.toContain(rawSecretToken.slice(0, 8));
      expect(serialized).not.toContain('supersecret');
    }
  });
});
