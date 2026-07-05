/**
 * End-to-end tests for the NetSapiens HTTP auth flow using supertest.
 * Boots a real Express app via createApp(), mocks the NS token endpoint
 * with axios, and walks the OAuth flow including MFA, public-client DCR,
 * cookie-based pending state, and transparent NS refresh.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import axios from 'axios';
import { createHash, randomBytes } from 'node:crypto';

vi.mock('axios');
const mockedAxios = axios as unknown as {
  post: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  isAxiosError: (err: unknown) => boolean;
};

mockedAxios.create = vi.fn(() => ({
  interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  request: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
})) as unknown as typeof mockedAxios.create;
mockedAxios.isAxiosError = () => false;

const NS_TOKEN_URL = 'https://ns.example.com/ns-api/v2/tokens';
const NS_USER_URL = 'https://ns.example.com/ns-api/v2/domains/~/users/~';

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function importApp() {
  // Re-import after env vars are set so loadConfig picks them up.
  vi.resetModules();
  process.env.MCP_TRANSPORT = 'http';
  process.env.MCP_BASE_URL = 'http://localhost';
  process.env.NETSAPIENS_API_URL = 'https://ns.example.com';
  process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'op-client-id';
  process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'op-client-secret';
  process.env.MCP_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
  delete process.env.MCP_PERSISTENCE;
  const mod = await import('../http-server.js');
  return mod.createApp();
}

describe('OAuth flow (end-to-end)', () => {
  beforeEach(() => {
    mockedAxios.post = vi.fn();
    mockedAxios.get = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('serves OAuth discovery and PRM at both standard and compat paths', async () => {
    const { app } = await importApp();

    const asMeta = await request(app).get('/.well-known/oauth-authorization-server').expect(200);
    expect(asMeta.body.issuer).toBeTruthy();
    expect(asMeta.body.token_endpoint).toContain('/token');

    const prmStandard = await request(app).get('/.well-known/oauth-protected-resource/mcp').expect(200);
    expect(prmStandard.body.resource).toContain('/mcp');

    const prmCompat = await request(app).get('/.well-known/oauth-protected-resource').expect(200);
    expect(prmCompat.body.resource).toContain('/mcp');
    expect(prmCompat.body.authorization_servers[0]).toBeTruthy();
  });

  it('rejects /mcp without a bearer token', async () => {
    const { app } = await importApp();
    await request(app).post('/mcp').send({ jsonrpc: '2.0', method: 'ping', id: 1 }).expect(401);
  });

  it('returns 401 with a WWW-Authenticate challenge (not 500) for an unknown bearer', async () => {
    const { app } = await importApp();
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ jsonrpc: '2.0', method: 'ping', id: 1 });

    // The 401 + challenge is what tells an MCP client to refresh or
    // re-authenticate. A plain Error from verifyAccessToken becomes a 500
    // the client can't act on.
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('invalid_token');
    expect(res.headers['www-authenticate']).toContain('resource_metadata');
  });

  it('returns invalid_grant (not 500) for an unknown refresh token at /token', async () => {
    const { app } = await importApp();
    const reg = await request(app)
      .post('/register')
      .send({ redirect_uris: ['http://localhost/cb'], client_name: 'grant-error-test' })
      .expect(201);

    const res = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'refresh_token',
        refresh_token: 'unknown-refresh-token',
        client_id: reg.body.client_id,
        client_secret: reg.body.client_secret,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  describe('bearer token lifetime', () => {
    it('issues a 7-day bearer by default (no MCP_TOKEN_LIFETIME_HOURS set)', async () => {
      delete process.env.MCP_TOKEN_LIFETIME_HOURS;
      const { app } = await importApp();

      const reg = await request(app)
        .post('/register')
        .send({ redirect_uris: ['http://localhost/cb'], client_name: 'lifetime-default' })
        .expect(201);

      const verifier = randomBytes(32).toString('base64url');
      const auth = await request(app)
        .get('/authorize')
        .query({
          response_type: 'code',
          client_id: reg.body.client_id,
          redirect_uri: 'http://localhost/cb',
          code_challenge: pkceChallenge(verifier),
          code_challenge_method: 'S256',
        })
        .expect(200);
      const pendingCookie = (auth.headers['set-cookie'] as unknown as string[])
        .find((c) => c.startsWith('mcp_pending_auth='))!.split(';')[0];

      mockedAxios.post = vi.fn().mockResolvedValueOnce({
        data: { access_token: 'ns', refresh_token: 'nsr', expires_in: 3600 },
      });
      mockedAxios.get = vi.fn().mockResolvedValueOnce({ data: { 'user-scope': 'Reseller' } });

      const login = await request(app)
        .post('/login')
        .set('Cookie', pendingCookie)
        .type('form')
        .send({ username: 'alice', password: 'pw' })
        .expect(302);
      const code = new URL(login.headers.location as string).searchParams.get('code')!;

      const tokenResp = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: reg.body.client_id,
          client_secret: reg.body.client_secret,
          redirect_uri: 'http://localhost/cb',
        })
        .expect(200);

      // 7 days = 604800 seconds; tolerate ±1s round-trip jitter from the bridge.
      expect(tokenResp.body.expires_in).toBeGreaterThanOrEqual(604_799);
      expect(tokenResp.body.expires_in).toBeLessThanOrEqual(604_801);
      expect(tokenResp.body.refresh_token).toBeTruthy();
    });

    it('honors MCP_TOKEN_LIFETIME_HOURS', async () => {
      process.env.MCP_TOKEN_LIFETIME_HOURS = '24'; // 1 day
      const { app } = await importApp();
      delete process.env.MCP_TOKEN_LIFETIME_HOURS;

      const reg = await request(app)
        .post('/register')
        .send({ redirect_uris: ['http://localhost/cb'], client_name: 'lifetime-custom' })
        .expect(201);

      const verifier = randomBytes(32).toString('base64url');
      const auth = await request(app)
        .get('/authorize')
        .query({
          response_type: 'code',
          client_id: reg.body.client_id,
          redirect_uri: 'http://localhost/cb',
          code_challenge: pkceChallenge(verifier),
          code_challenge_method: 'S256',
        })
        .expect(200);
      const pendingCookie = (auth.headers['set-cookie'] as unknown as string[])
        .find((c) => c.startsWith('mcp_pending_auth='))!.split(';')[0];

      mockedAxios.post = vi.fn().mockResolvedValueOnce({
        data: { access_token: 'ns', refresh_token: 'nsr', expires_in: 3600 },
      });
      mockedAxios.get = vi.fn().mockResolvedValueOnce({ data: { 'user-scope': 'Reseller' } });

      const login = await request(app)
        .post('/login')
        .set('Cookie', pendingCookie)
        .type('form')
        .send({ username: 'alice', password: 'pw' })
        .expect(302);
      const code = new URL(login.headers.location as string).searchParams.get('code')!;

      const tokenResp = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: reg.body.client_id,
          client_secret: reg.body.client_secret,
          redirect_uri: 'http://localhost/cb',
        })
        .expect(200);

      // 24 hours = 86400 seconds
      expect(tokenResp.body.expires_in).toBe(86_400);
    });
  });

  describe('Dynamic Client Registration', () => {
    it('issues a client_secret for confidential clients (default)', async () => {
      const { app } = await importApp();
      const r = await request(app)
        .post('/register')
        .send({ redirect_uris: ['https://example.com/cb'], client_name: 'Test' })
        .expect(201);
      expect(r.body.client_id).toBeTruthy();
      expect(r.body.client_secret).toBeTruthy();
    });

    it('omits client_secret for public clients (token_endpoint_auth_method=none)', async () => {
      const { app } = await importApp();
      const r = await request(app)
        .post('/register')
        .send({
          redirect_uris: ['https://chatgpt.com/cb'],
          client_name: 'Public Client',
          token_endpoint_auth_method: 'none',
        })
        .expect(201);
      expect(r.body.client_id).toBeTruthy();
      expect(r.body.client_secret).toBeUndefined();
    });
  });

  describe('login → token (no MFA)', () => {
    it('walks /authorize → /login → /token and issues bearer + refresh', async () => {
      const { app } = await importApp();

      const reg = await request(app)
        .post('/register')
        .send({ redirect_uris: ['http://localhost/callback'], client_name: 'E2E' })
        .expect(201);
      const { client_id, client_secret } = reg.body;

      const verifier = randomBytes(32).toString('base64url');
      const challenge = pkceChallenge(verifier);

      const authResp = await request(app)
        .get('/authorize')
        .query({
          response_type: 'code',
          client_id,
          redirect_uri: 'http://localhost/callback',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state: 'xyz',
        })
        .expect(200);

      // Pending-auth cookie must be set
      const cookies = (authResp.headers['set-cookie'] || []) as unknown as string[];
      const pendingCookie = cookies.find((c) => c.startsWith('mcp_pending_auth='));
      expect(pendingCookie).toBeTruthy();

      // Mock NS password grant (no MFA challenge) + user role detection
      mockedAxios.post = vi.fn().mockResolvedValueOnce({
        data: { access_token: 'ns-access', refresh_token: 'ns-refresh', expires_in: 3600 },
      });
      mockedAxios.get = vi.fn().mockResolvedValueOnce({ data: { 'user-scope': 'Reseller' } });

      const cookieHeader = pendingCookie!.split(';')[0];

      const loginResp = await request(app)
        .post('/login')
        .set('Cookie', cookieHeader)
        .type('form')
        .send({ username: 'alice', password: 'hunter2' })
        .expect(302);

      const location = loginResp.headers.location as string;
      expect(location).toContain('http://localhost/callback?');
      const params = new URL(location).searchParams;
      const code = params.get('code')!;
      expect(code).toBeTruthy();
      expect(params.get('state')).toBe('xyz');

      const tokenResp = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id,
          client_secret,
          redirect_uri: 'http://localhost/callback',
        })
        .expect(200);

      expect(tokenResp.body.access_token).toBeTruthy();
      expect(tokenResp.body.refresh_token).toBeTruthy();
      expect(tokenResp.body.token_type).toBe('Bearer');

      // Verify NS was called with v2 JSON shape
      const nsCall = (mockedAxios.post as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(nsCall[0]).toBe(NS_TOKEN_URL);
      expect(nsCall[1]).toMatchObject({
        grant_type: 'password',
        client_id: 'op-client-id',
        client_secret: 'op-client-secret',
        username: 'alice',
        password: 'hunter2',
      });
    });

    it('surfaces NS error messages in the login error page on failed grant', async () => {
      const { app } = await importApp();
      const reg = await request(app)
        .post('/register')
        .send({ redirect_uris: ['http://localhost/cb'], client_name: 't' })
        .expect(201);
      const verifier = randomBytes(32).toString('base64url');
      const auth = await request(app)
        .get('/authorize')
        .query({
          response_type: 'code',
          client_id: reg.body.client_id,
          redirect_uri: 'http://localhost/cb',
          code_challenge: pkceChallenge(verifier),
          code_challenge_method: 'S256',
        })
        .expect(200);
      const cookies = (auth.headers['set-cookie'] || []) as unknown as string[];
      const cookie = cookies.find((c) => c.startsWith('mcp_pending_auth=')).split(';')[0];

      mockedAxios.post = vi.fn().mockRejectedValueOnce({
        response: { status: 403, data: { code: 403, message: 'Invalid User Login' } },
      });

      const r = await request(app)
        .post('/login')
        .set('Cookie', cookie)
        .type('form')
        .send({ username: 'x', password: 'y' })
        .expect(200);
      expect(r.text).toContain('Invalid User Login');
    });

    it('shows expired-session page when the pending cookie is missing', async () => {
      const { app } = await importApp();
      const r = await request(app)
        .post('/login')
        .type('form')
        .send({ username: 'a', password: 'b' });
      // No pending cookie → friendly expiry page (HTTP 440)
      expect([200, 440]).toContain(r.status);
      expect(r.text).toMatch(/session has expired|reconnect/i);
    });
  });

  describe('MFA flow', () => {
    it('renders MFA page when NS returns mfa_type, then completes via grant_type=mfa', async () => {
      const { app } = await importApp();
      const reg = await request(app)
        .post('/register')
        .send({ redirect_uris: ['http://localhost/cb'], client_name: 'mfa-test' })
        .expect(201);

      const verifier = randomBytes(32).toString('base64url');
      const auth = await request(app)
        .get('/authorize')
        .query({
          response_type: 'code',
          client_id: reg.body.client_id,
          redirect_uri: 'http://localhost/cb',
          code_challenge: pkceChallenge(verifier),
          code_challenge_method: 'S256',
        })
        .expect(200);
      const cookies = (auth.headers['set-cookie'] || []) as unknown as string[];
      const pendingCookie = cookies.find((c) => c.startsWith('mcp_pending_auth=')).split(';')[0];

      // First NS call: password grant returns MFA challenge
      mockedAxios.post = vi.fn()
        .mockResolvedValueOnce({
          data: {
            access_token: 'partial-token',
            mfa_type: 'authenticator',
            mfa_vendor: 'google',
            ns_id_type: 'subscriber',
          },
        })
        // Second NS call: MFA grant succeeds
        .mockResolvedValueOnce({
          data: { access_token: 'final-ns', refresh_token: 'final-refresh', expires_in: 3600 },
        });
      mockedAxios.get = vi.fn().mockResolvedValueOnce({ data: { 'user-scope': 'Basic User' } });

      const mfaResp = await request(app)
        .post('/login')
        .set('Cookie', pendingCookie)
        .type('form')
        .send({ username: 'alice', password: 'hunter2' })
        .expect(200);

      const mfaCookies = (mfaResp.headers['set-cookie'] || []) as unknown as string[];
      const mfaCookie = mfaCookies.find((c) => c.startsWith('mcp_mfa_challenge=')).split(';')[0];
      expect(mfaCookie).toBeTruthy();
      expect(mfaResp.text).toMatch(/Authentication Code/i);
      expect(mfaResp.text).toMatch(/google/i);

      const finalize = await request(app)
        .post('/mfa')
        .set('Cookie', mfaCookie)
        .type('form')
        .send({ passcode: '123456' })
        .expect(302);

      expect(finalize.headers.location).toContain('http://localhost/cb?code=');

      // Verify the second NS call used grant_type=mfa with the partial token
      const mfaCall = (mockedAxios.post as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(mfaCall[0]).toBe(NS_TOKEN_URL);
      expect(mfaCall[1]).toMatchObject({
        grant_type: 'mfa',
        passcode: '123456',
        mfa_type: 'authenticator',
        mfa_vendor: 'google',
        ns_id_type: 'subscriber',
        access_token: 'partial-token',
      });
    });

    it('rejects an invalid passcode with the MFA error page', async () => {
      const { app } = await importApp();
      const reg = await request(app)
        .post('/register')
        .send({ redirect_uris: ['http://localhost/cb'], client_name: 't' })
        .expect(201);
      const verifier = randomBytes(32).toString('base64url');
      const auth = await request(app)
        .get('/authorize')
        .query({
          response_type: 'code',
          client_id: reg.body.client_id,
          redirect_uri: 'http://localhost/cb',
          code_challenge: pkceChallenge(verifier),
          code_challenge_method: 'S256',
        })
        .expect(200);
      const pendingCookie = (auth.headers['set-cookie'] as unknown as string[])
        .find((c) => c.startsWith('mcp_pending_auth='))!.split(';')[0];

      mockedAxios.post = vi.fn()
        .mockResolvedValueOnce({
          data: { access_token: 'partial', mfa_type: 'authenticator', mfa_vendor: 'google' },
        })
        .mockRejectedValueOnce({
          response: { status: 401, data: { message: 'Invalid passcode' } },
        });

      const mfaPage = await request(app)
        .post('/login')
        .set('Cookie', pendingCookie)
        .type('form')
        .send({ username: 'alice', password: 'pw' })
        .expect(200);
      const mfaCookie = (mfaPage.headers['set-cookie'] as unknown as string[])
        .find((c) => c.startsWith('mcp_mfa_challenge='))!.split(';')[0];

      const bad = await request(app)
        .post('/mfa')
        .set('Cookie', mfaCookie)
        .type('form')
        .send({ passcode: '000000' })
        .expect(200);
      expect(bad.text).toMatch(/Invalid|expired|passcode/i);
    });
  });

  describe('transparent NS token refresh', () => {
    it('refreshes the upstream NS token when it is within the skew window', async () => {
      const { app } = await importApp();
      const reg = await request(app)
        .post('/register')
        .send({ redirect_uris: ['http://localhost/cb'], client_name: 'refresh-test' })
        .expect(201);
      const verifier = randomBytes(32).toString('base64url');
      const auth = await request(app)
        .get('/authorize')
        .query({
          response_type: 'code',
          client_id: reg.body.client_id,
          redirect_uri: 'http://localhost/cb',
          code_challenge: pkceChallenge(verifier),
          code_challenge_method: 'S256',
        })
        .expect(200);
      const pendingCookie = (auth.headers['set-cookie'] as unknown as string[])
        .find((c) => c.startsWith('mcp_pending_auth='))!.split(';')[0];

      // NS password grant returns a token that's ALREADY expired so
      // verifyAccessToken will trigger an immediate refresh.
      mockedAxios.post = vi.fn()
        .mockResolvedValueOnce({
          data: { access_token: 'old-ns', refresh_token: 'ns-refresh', expires_in: 1 },
        });
      mockedAxios.get = vi.fn().mockResolvedValue({ data: { 'user-scope': 'Reseller' } });

      const login = await request(app)
        .post('/login')
        .set('Cookie', pendingCookie)
        .type('form')
        .send({ username: 'alice', password: 'pw' })
        .expect(302);
      const code = new URL(login.headers.location as string).searchParams.get('code')!;

      const tokenResp = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: reg.body.client_id,
          client_secret: reg.body.client_secret,
          redirect_uri: 'http://localhost/cb',
        })
        .expect(200);
      const mcpBearer = tokenResp.body.access_token;
      expect(mcpBearer).toBeTruthy();

      // Wait long enough that the 1-second NS token is in the skew window
      await new Promise((r) => setTimeout(r, 50));

      // Queue the refresh response
      mockedAxios.post = vi.fn().mockResolvedValueOnce({
        data: { access_token: 'fresh-ns', refresh_token: 'ns-refresh-2', expires_in: 3600 },
      });

      // Hit /mcp with our bearer — server should silently refresh the NS token
      await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${mcpBearer}`)
        .send({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });

      const refreshCall = (mockedAxios.post as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(refreshCall?.[0]).toBe(NS_TOKEN_URL);
      expect(refreshCall?.[1]).toMatchObject({
        grant_type: 'refresh_token',
        refresh_token: 'ns-refresh',
      });
    });

    it('propagates a mid-session NS refresh into the live session client', async () => {
      // Capture the request interceptor of every NetSapiensClient built while
      // this test runs, so we can see which bearer the session's client would
      // put on its next NS API call.
      const interceptors: Array<(cfg: { headers: Record<string, string> }) => Promise<{ headers: Record<string, string> }>> = [];
      const origCreate = mockedAxios.create;
      mockedAxios.create = vi.fn(() => ({
        interceptors: {
          request: { use: vi.fn((fn: (cfg: unknown) => unknown) => { interceptors.push(fn as never); }) },
          response: { use: vi.fn() },
        },
        request: vi.fn(),
        get: vi.fn(),
        post: vi.fn(),
      })) as unknown as typeof mockedAxios.create;

      try {
        const { app } = await importApp();
        const reg = await request(app)
          .post('/register')
          .send({ redirect_uris: ['http://localhost/cb'], client_name: 'propagate-test' })
          .expect(201);
        const verifier = randomBytes(32).toString('base64url');
        const auth = await request(app)
          .get('/authorize')
          .query({
            response_type: 'code',
            client_id: reg.body.client_id,
            redirect_uri: 'http://localhost/cb',
            code_challenge: pkceChallenge(verifier),
            code_challenge_method: 'S256',
          })
          .expect(200);
        const pendingCookie = (auth.headers['set-cookie'] as unknown as string[])
          .find((c) => c.startsWith('mcp_pending_auth='))!.split(';')[0];

        // NS token with a 1s lifetime sits inside the 60s refresh-skew window
        // from the moment it's issued, so EVERY /mcp request triggers a
        // transparent refresh — no clock manipulation needed.
        mockedAxios.post = vi.fn().mockResolvedValueOnce({
          data: { access_token: 'ns-1', refresh_token: 'nsr-1', expires_in: 1 },
        });
        mockedAxios.get = vi.fn().mockResolvedValue({ data: { 'user-scope': 'Reseller' } });

        const login = await request(app)
          .post('/login')
          .set('Cookie', pendingCookie)
          .type('form')
          .send({ username: 'alice', password: 'pw' })
          .expect(302);
        const code = new URL(login.headers.location as string).searchParams.get('code')!;

        const tokenResp = await request(app)
          .post('/token')
          .type('form')
          .send({
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            client_id: reg.body.client_id,
            client_secret: reg.body.client_secret,
            redirect_uri: 'http://localhost/cb',
          })
          .expect(200);
        const mcpBearer = tokenResp.body.access_token;

        await new Promise((r) => setTimeout(r, 5));

        // Refresh #1 fires while verifying the initialize request; refresh #2
        // fires on the follow-up request. Both mint tokens that are again
        // inside the skew window.
        mockedAxios.post = vi.fn()
          .mockResolvedValueOnce({
            data: { access_token: 'ns-2', refresh_token: 'nsr-2', expires_in: 1 },
          })
          .mockResolvedValueOnce({
            data: { access_token: 'ns-3', refresh_token: 'nsr-3', expires_in: 1 },
          });

        const init = await request(app)
          .post('/mcp')
          .set('Authorization', `Bearer ${mcpBearer}`)
          .set('Accept', 'application/json, text/event-stream')
          .send({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
        const sessionId = init.headers['mcp-session-id'] as string;
        expect(sessionId).toBeTruthy();

        // The session's client was built with ns-2 (refreshed during initialize).
        const sessionClientInterceptor = interceptors[interceptors.length - 1];
        let cfg = await sessionClientInterceptor({ headers: {} });
        expect(cfg.headers.Authorization).toBe('Bearer ns-2');

        // The follow-up request refreshes ns-2 → ns-3 in the token store. The
        // live session client must pick that up, or every NS API call for the
        // rest of the session runs with a token NS has already invalidated.
        await request(app)
          .post('/mcp')
          .set('Authorization', `Bearer ${mcpBearer}`)
          .set('mcp-session-id', sessionId)
          .set('Accept', 'application/json, text/event-stream')
          .send({ jsonrpc: '2.0', method: 'tools/list', id: 2 });

        cfg = await sessionClientInterceptor({ headers: {} });
        expect(cfg.headers.Authorization).toBe('Bearer ns-3');
      } finally {
        mockedAxios.create = origCreate;
      }
    });
  });
});
