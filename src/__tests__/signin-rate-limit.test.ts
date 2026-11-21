import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../http-server.js';
import { createMemoryStore, MemoryBackend } from '../store/memory.js';
import { deriveStoreKey } from '../store/codec.js';
import type { McpStore } from '../store/types.js';

const secret = 'signin-limiter-test-secret-0123456789abcdef';
const keys = ['MCP_TRANSPORT', 'MCP_BASE_URL', 'NETSAPIENS_API_URL', 'NETSAPIENS_OAUTH_CLIENT_ID', 'NETSAPIENS_OAUTH_CLIENT_SECRET', 'MCP_SESSION_SECRET', 'MCP_TRUST_PROXY_HOPS'] as const;
let previous: Record<string, string | undefined>;
let store: McpStore;

beforeEach(() => {
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { MCP_TRANSPORT: 'http', MCP_BASE_URL: 'http://localhost', NETSAPIENS_API_URL: 'https://ns.example.com', NETSAPIENS_OAUTH_CLIENT_ID: 'client', NETSAPIENS_OAUTH_CLIENT_SECRET: 'secret', MCP_SESSION_SECRET: secret, MCP_TRUST_PROXY_HOPS: '1' });
  store = createMemoryStore({ namespace: 'limit_test', key: deriveStoreKey(secret) });
});
afterEach(async () => {
  await store.close();
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  vi.restoreAllMocks();
});

describe('shared sign-in limiter', () => {
  it('shares one client budget between apps and leaves other clients independent', async () => {
    const a = await createApp({ store });
    const b = await createApp({ store });
    for (let n = 0; n < 12; n++) {
      await request(n % 2 ? b.app : a.app).post('/mfa').set('X-Forwarded-For', '198.51.100.20').type('form')
        .send({ passcode: '123456', mfa_state: 'invalid' }).expect(n < 10 ? 440 : 429);
    }
    await request(b.app).post('/mfa').set('X-Forwarded-For', '198.51.100.21').type('form')
      .send({ passcode: '123456', mfa_state: 'invalid' }).expect(440);
  });
  it('does not debit for non-POST, subpath or cross-site requests', async () => {
    const app = await createApp({ store });
    const hit = vi.spyOn(store.rateLimits, 'hit');
    for (let n = 0; n < 12; n++) {
      await request(app.app).get('/login').expect(404);
      await request(app.app).post('/login/other').type('form').send({ username: 'u', password: 'p' }).expect(404);
      await request(app.app).post('/login').set('Sec-Fetch-Site', 'cross-site').type('form').send({ username: 'u', password: 'p' }).expect(440);
      await request(app.app).post('/mfa').set('Sec-Fetch-Site', 'cross-site').type('form').send({ passcode: '123456' }).expect(440);
    }
    expect(hit).not.toHaveBeenCalled();
    await request(app.app).post('/mfa').type('form').send({ passcode: '123456', mfa_state: 'invalid' }).expect(440);
    expect(hit).toHaveBeenCalledTimes(1);
  });

  it('rejects cross-site requests before parsing or reading a body, and handles unsupported bodies', async () => {
    const app = await createApp({ store });
    const hit = vi.spyOn(store.rateLimits, 'hit');
    const login = vi.spyOn(app.authProvider, 'handleLogin');
    const token = vi.spyOn(app.authProvider, 'handleTokenLogin');
    const mfa = vi.spyOn(app.authProvider, 'handleMfa');
    const logs = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const route of ['/login', '/mfa']) {
      for (const contentType of [undefined, 'text/plain', 'application/json']) {
        let req = request(app.app).post(route).set('Sec-Fetch-Site', 'cross-site');
        if (contentType) req = req.set('Content-Type', contentType).send(contentType === 'application/json' ? '{bad-json' : 'bad');
        const response = await req.expect(440);
        expect(response.body).toEqual({ error: 'invalid_request' });
        expect(response.headers['cache-control']).toContain('no-store');
      }
    }
    expect(hit).not.toHaveBeenCalled();
    for (const route of ['/login', '/mfa']) {
      const response = await request(app.app).post(route).set('Content-Type', 'text/plain').send('bad').expect(400);
      expect(response.body).toEqual({ error: 'invalid_request' });
    }
    expect(login).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
    expect(mfa).not.toHaveBeenCalled();
    expect(JSON.stringify(logs.mock.calls)).not.toContain('TypeError');
  });

  it('fails closed on malformed decisions and falsy rejections', async () => {
    const app = await createApp({ store });
    const hit = vi.spyOn(store.rateLimits, 'hit');
    const handler = vi.spyOn(app.authProvider, 'handleMfa');
    for (const result of [null, {}, { totalHits: 0, resetAt: Date.now() + 60_000 }, { totalHits: 1, resetAt: NaN }, { totalHits: 1, resetAt: 0 }]) {
      hit.mockResolvedValueOnce(result as never);
      await request(app.app).post('/mfa').type('form').send({ passcode: '123456' }).expect(503);
    }
    for (const error of [undefined, null, false, 0, '']) {
      hit.mockRejectedValueOnce(error);
      await request(app.app).post('/mfa').type('form').send({ passcode: '123456' }).expect(503);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('prunes expired replay markers automatically without removing live markers', async () => {
    vi.useFakeTimers();
    const backend = new MemoryBackend();
    try {
      const now = Date.now();
      await backend.insertResumeIfAbsent({ id: 'expired', consumedAt: now, expiresAt: now + 1 }, now);
      await backend.insertResumeIfAbsent({ id: 'live', consumedAt: now, expiresAt: now + 120_000 }, now);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(backend.state.resumeTokens.has('expired')).toBe(false);
      expect(await backend.insertResumeIfAbsent({ id: 'live', consumedAt: now, expiresAt: now + 180_000 }, Date.now())).toBe(false);
    } finally {
      await backend.close();
      vi.useRealTimers();
    }
  });
  it('refuses both routes with a fixed 503 when the store fails', async () => {
    const app = await createApp({ store });
    vi.spyOn(store.rateLimits, 'hit').mockRejectedValue(new Error('private error detail'));
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const login = vi.spyOn(app.authProvider, 'handleLogin');
    const mfa = vi.spyOn(app.authProvider, 'handleMfa');
    for (const [route, body] of [['/login', { username: 'u', password: 'p' }], ['/mfa', { passcode: '123456' }]] as const) {
      const res = await request(app.app).post(route).set('X-Forwarded-For', '198.51.100.22').type('form').send(body).expect(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body).toEqual({ error: 'temporarily_unavailable', error_description: 'Service temporarily unavailable, please retry' });
    }
    expect(login).not.toHaveBeenCalled();
    expect(mfa).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain('private error detail');
    expect(JSON.stringify(log.mock.calls)).not.toContain('198.51.100.22');
  });
  it('rejects a store without the limiter at startup', async () => {
    const incomplete = { ...store, rateLimits: undefined } as unknown as McpStore;
    await expect(createApp({ store: incomplete })).rejects.toThrow('ConfigError: the store does not implement rateLimits.hit');
  });
});
