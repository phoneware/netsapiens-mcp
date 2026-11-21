import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../http-server.js';
import { createMemoryStore } from '../store/memory.js';
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
