import { describe, it, expect, vi } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { NetSapiensAuthProvider } from '../auth/netsapiens-auth-provider.js';
import type { StoredToken, AuthHooks, RenderPagesOptions } from '../auth/types.js';

describe('NetSapiensAuthProvider auth hooks & pages', () => {
  const dummyClient = {
    client_id: 'test-client',
    redirect_uris: ['http://localhost:8080/callback'],
    token_endpoint_auth_method: 'none',
  };

  function createProvider(options: {
    hooks?: AuthHooks;
    renderPages?: RenderPagesOptions;
  } = {}) {
    return new NetSapiensAuthProvider({
      platforms: [{ id: 'default', label: 'Test', apiUrl: 'https://netsapiens.example.com' }],
      nsApiUrl: 'https://netsapiens.example.com',
      nsClientId: 'test-ns-client',
      nsClientSecret: 'test-ns-secret',
      serverBaseUrl: 'http://localhost:3000',
      hooks: options.hooks,
      renderPages: options.renderPages,
    });
  }

  function mockResponse() {
    let html = '';
    let status = 200;
    let redirectUrl = '';
    const res = {
      status: vi.fn((s: number) => {
        status = s;
        return res;
      }),
      set: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn((body: string) => {
        html = body;
        return res;
      }),
      redirect: vi.fn((url: string) => {
        redirectUrl = url;
        return res;
      }),
      getHtml: () => html,
      getStatus: () => status,
      getRedirectUrl: () => redirectUrl,
    };
    return res;
  }

  it('no hooks: login and verify behaviour is unchanged', async () => {
    const provider = createProvider();

    (provider as unknown as { nsPasswordGrant: unknown }).nsPasswordGrant = vi.fn().mockResolvedValue({
      kind: 'tokens',
      tokens: {
        access_token: 'ns-tok-123',
        expires_in: 3600,
        username: 'alice@domain.com',
      },
    });
    (provider as unknown as { detectNsUserInfo: unknown }).detectNsUserInfo = vi.fn().mockResolvedValue({
      user: 'alice',
      domain: 'domain.com',
      scope: 'Office Manager',
      role: 'domain_admin',
      displayName: 'Alice Test',
      email: 'alice@domain.com',
    });

    // 1. Authorize GET to get signed state
    const authRes = mockResponse();
    await provider.authorize(
      dummyClient as unknown as import('@modelcontextprotocol/sdk/shared/auth.js').OAuthClientInformationFull,
      {
        codeChallenge: 'test-challenge',
        redirectUri: 'http://localhost:8080/callback',
        state: 'xyz',
      } as unknown as import('@modelcontextprotocol/sdk/server/auth/provider.js').AuthorizationParams,
      authRes as unknown as Response,
    );
    const m = authRes.getHtml().match(/name="auth_state" value="([^"]+)"/);
    expect(m).toBeTruthy();
    const authState = m![1];

    // 2. Login POST without hooks -> redirects with code
    const loginRes = mockResponse();
    const loginReq = {
      body: { auth_state: authState },
      headers: {},
    } as unknown as Request;

    await provider.handleLogin(loginReq, loginRes as unknown as Response, 'alice@domain.com', 'password123');
    const redirectUrl = loginRes.getRedirectUrl();
    expect(redirectUrl).toContain('http://localhost:8080/callback?code=');
    expect(redirectUrl).toContain('&state=xyz');

    const code = new URL(redirectUrl).searchParams.get('code')!;
    const tokens = await provider.exchangeAuthorizationCode(
      dummyClient as unknown as import('@modelcontextprotocol/sdk/shared/auth.js').OAuthClientInformationFull,
      code,
    );
    expect(tokens.access_token).toBeTruthy();

    // 3. Verify access token returns auth info without governance
    const authInfo = await provider.verifyAccessToken(tokens.access_token);
    expect(authInfo.token).toBe(tokens.access_token);
    expect(authInfo.extra?.nsUsername).toBe('alice@domain.com');
    expect(authInfo.extra?.governance).toBeUndefined();
  });

  it('onLogin deny: issues no authorization code and returns 403 HTML', async () => {
    let hookRan = false;
    const provider = createProvider({
      hooks: {
        async onLogin(input) {
          hookRan = true;
          expect(input.who.user).toBe('bob');
          expect(input.who.domain).toBe('revoked.com');
          expect(input.tier).toBe('user');
          return {
            kind: 'deny',
            status: 403,
            html: '<h1>Access Denied: AI Connector Disabled</h1>',
          };
        },
        async onVerify() {
          return {};
        },
      },
    });

    (provider as unknown as { nsPasswordGrant: unknown }).nsPasswordGrant = vi.fn().mockResolvedValue({
      kind: 'tokens',
      tokens: { access_token: 'ns-tok-bob', expires_in: 3600, username: 'bob@revoked.com' },
    });
    (provider as unknown as { detectNsUserInfo: unknown }).detectNsUserInfo = vi.fn().mockResolvedValue({
      user: 'bob',
      domain: 'revoked.com',
      scope: 'Basic User',
      role: 'user',
      displayName: 'Bob User',
      email: 'bob@revoked.com',
    });

    const authRes = mockResponse();
    await provider.authorize(
      dummyClient as unknown as import('@modelcontextprotocol/sdk/shared/auth.js').OAuthClientInformationFull,
      { codeChallenge: 'c1', redirectUri: 'http://localhost:8080/cb' } as unknown as import('@modelcontextprotocol/sdk/server/auth/provider.js').AuthorizationParams,
      authRes as unknown as Response,
    );
    const authState = authRes.getHtml().match(/name="auth_state" value="([^"]+)"/)![1];

    const loginRes = mockResponse();
    await provider.handleLogin(
      { body: { auth_state: authState }, headers: {} } as unknown as Request,
      loginRes as unknown as Response,
      'bob@revoked.com',
      'secret',
    );

    expect(hookRan).toBe(true);
    expect(loginRes.redirect).not.toHaveBeenCalled();
    expect(loginRes.getStatus()).toBe(403);
    expect(loginRes.getHtml()).toBe('<h1>Access Denied: AI Connector Disabled</h1>');
  });

  it('onLogin continue: persists tokenExtra onto StoredToken.extra', async () => {
    const provider = createProvider({
      hooks: {
        async onLogin() {
          return {
            kind: 'continue',
            tokenExtra: {
              seatId: 'seat-456',
              domainPolicy: 'active',
            },
          };
        },
        async onVerify() {
          return {};
        },
      },
    });

    (provider as unknown as { nsPasswordGrant: unknown }).nsPasswordGrant = vi.fn().mockResolvedValue({
      kind: 'tokens',
      tokens: { access_token: 'ns-tok-carol', expires_in: 3600, username: 'carol@domain.com' },
    });
    (provider as unknown as { detectNsUserInfo: unknown }).detectNsUserInfo = vi.fn().mockResolvedValue({
      user: 'carol',
      domain: 'domain.com',
      scope: 'Office Manager',
      role: 'domain_admin',
      displayName: 'Carol',
      email: 'carol@domain.com',
    });

    const authRes = mockResponse();
    await provider.authorize(
      dummyClient as unknown as import('@modelcontextprotocol/sdk/shared/auth.js').OAuthClientInformationFull,
      { codeChallenge: 'c2', redirectUri: 'http://localhost:8080/cb' } as unknown as import('@modelcontextprotocol/sdk/server/auth/provider.js').AuthorizationParams,
      authRes as unknown as Response,
    );
    const authState = authRes.getHtml().match(/name="auth_state" value="([^"]+)"/)![1];

    const loginRes = mockResponse();
    await provider.handleLogin(
      { body: { auth_state: authState }, headers: {} } as unknown as Request,
      loginRes as unknown as Response,
      'carol@domain.com',
      'secret',
    );

    const code = new URL(loginRes.getRedirectUrl()).searchParams.get('code')!;
    const tokens = await provider.exchangeAuthorizationCode(
      dummyClient as unknown as import('@modelcontextprotocol/sdk/shared/auth.js').OAuthClientInformationFull,
      code,
    );

    const stored = await (provider as unknown as { tokenStore: { get: (t: string) => Promise<StoredToken> } }).tokenStore.get(tokens.access_token);
    expect(stored.extra).toEqual({
      seatId: 'seat-456',
      domainPolicy: 'active',
    });
    expect(stored.ttlAt).toBeInstanceOf(Date);
  });

  it('onLogin interstitial and resumeLogin: renders interstitial with resumeToken and completes flow', async () => {
    const provider = createProvider({
      hooks: {
        async onLogin() {
          return {
            kind: 'interstitial',
            html: '<form action="/enroll"><input type="hidden" name="resume_token" value="{{RESUME_TOKEN}}"><button>Turn On</button></form>',
          };
        },
        async onVerify() {
          return {};
        },
      },
    });

    (provider as unknown as { nsPasswordGrant: unknown }).nsPasswordGrant = vi.fn().mockResolvedValue({
      kind: 'tokens',
      tokens: { access_token: 'ns-tok-dan', expires_in: 3600, username: 'dan@domain.com' },
    });
    (provider as unknown as { detectNsUserInfo: unknown }).detectNsUserInfo = vi.fn().mockResolvedValue({
      user: 'dan',
      domain: 'domain.com',
      scope: 'Office Manager',
      role: 'domain_admin',
      displayName: 'Dan',
      email: 'dan@domain.com',
    });

    const authRes = mockResponse();
    await provider.authorize(
      dummyClient as unknown as import('@modelcontextprotocol/sdk/shared/auth.js').OAuthClientInformationFull,
      { codeChallenge: 'c3', redirectUri: 'http://localhost:8080/cb' } as unknown as import('@modelcontextprotocol/sdk/server/auth/provider.js').AuthorizationParams,
      authRes as unknown as Response,
    );
    const authState = authRes.getHtml().match(/name="auth_state" value="([^"]+)"/)![1];

    const loginRes = mockResponse();
    await provider.handleLogin(
      { body: { auth_state: authState }, headers: {} } as unknown as Request,
      loginRes as unknown as Response,
      'dan@domain.com',
      'secret',
    );

    const interstitialHtml = loginRes.getHtml();
    expect(interstitialHtml).toContain('<form action="/enroll">');
    const resumeTokenMatch = interstitialHtml.match(/name="resume_token" value="([^"]+)"/);
    expect(resumeTokenMatch).toBeTruthy();
    const resumeToken = resumeTokenMatch![1];

    const resumeRes = mockResponse();
    await provider.resumeLogin(resumeRes as unknown as Response, resumeToken, { enrolledVia: 'self' });
    const redirectUrl = resumeRes.getRedirectUrl();
    expect(redirectUrl).toContain('http://localhost:8080/cb?code=');

    // Second post of the same resume token must be refused!
    const replayRes = mockResponse();
    await provider.resumeLogin(replayRes as unknown as Response, resumeToken, { enrolledVia: 'replay' });
    expect(replayRes.getStatus()).toBe(400);
    expect(replayRes.getRedirectUrl()).toBe('');

    // Continuation re-encoded with padded base64 must also be refused after first use
    const parts = resumeToken.split('.');
    const paddedResumeToken = `${parts[0]}.${parts[1]}.${parts[2]}==`;
    const replayPaddedRes = mockResponse();
    await provider.resumeLogin(replayPaddedRes as unknown as Response, paddedResumeToken, { enrolledVia: 'replay-padded' });
    expect(replayPaddedRes.getStatus()).toBe(400);
    expect(replayPaddedRes.getRedirectUrl()).toBe('');

    const code = new URL(redirectUrl).searchParams.get('code')!;
    const tokens = await provider.exchangeAuthorizationCode(
      dummyClient as unknown as import('@modelcontextprotocol/sdk/shared/auth.js').OAuthClientInformationFull,
      code,
    );
    const stored = await (provider as unknown as { tokenStore: { get: (t: string) => Promise<StoredToken> } }).tokenStore.get(tokens.access_token);
    expect(stored.extra).toEqual({ enrolledVia: 'self' });
  });

  it('onVerify throwing gives 401 with WWW-Authenticate header via bearerAuth middleware', async () => {
    const provider = createProvider({
      hooks: {
        async onLogin() {
          return { kind: 'continue', tokenExtra: {} };
        },
        async onVerify(stored) {
          if (stored.nsUsername === 'revoked@domain.com') {
            throw new InvalidTokenError('Seat has been revoked by office manager');
          }
          return { seatValid: true };
        },
      },
    });

    const revokedToken: StoredToken = {
      accessToken: 'mcp-bearer-revoked',
      refreshToken: 'refresh-revoked',
      clientId: 'test-client',
      expiresAt: Date.now() + 3600_000,
      nsAccessToken: 'ns-tok',
      nsUsername: 'revoked@domain.com',
      nsUserRole: 'domain_admin',
      serverBaseUrl: 'http://localhost:3000',
    };
    await (provider as unknown as { tokenStore: { set: (t: StoredToken) => Promise<void> } }).tokenStore.set(revokedToken);

    const app = express();
    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL('http://localhost:3000/mcp'));
    const bearerAuth = requireBearerAuth({
      verifier: provider,
      resourceMetadataUrl,
    });

    app.post('/mcp', bearerAuth, (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer mcp-bearer-revoked')
      .expect(401);

    expect(res.headers['www-authenticate']).toContain('Bearer');
    expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
  });

  it('renderPages overrides custom login, mfa, and error HTML', async () => {
    const provider = createProvider({
      renderPages: {
        login: () => '<div>CUSTOM LOGIN</div>',
        mfa: () => '<div>CUSTOM MFA</div>',
        error: ({ message }) => `<div>CUSTOM ERROR: ${message}</div>`,
      },
    });

    const res = mockResponse();
    await provider.authorize(
      dummyClient as unknown as import('@modelcontextprotocol/sdk/shared/auth.js').OAuthClientInformationFull,
      { codeChallenge: 'c', redirectUri: 'http://localhost:8080' } as unknown as import('@modelcontextprotocol/sdk/server/auth/provider.js').AuthorizationParams,
      res as unknown as Response,
    );
    expect(res.getHtml()).toBe('<div>CUSTOM LOGIN</div>');
  });

  it('token sign-in as an Office Manager reaches onLogin with scope Office Manager', async () => {
    let capturedScope: string | undefined;
    let capturedUser: string | undefined;
    const provider = createProvider({
      hooks: {
        async onLogin(input) {
          capturedScope = input.who.scope;
          capturedUser = input.who.user;
          return { kind: 'continue', tokenExtra: {} };
        },
        async onVerify() {
          return {};
        },
      },
    });

    (provider as unknown as { validateNsToken: unknown }).validateNsToken = vi.fn().mockResolvedValue({
      username: '1013@acme.com',
      userRole: 'domain_admin',
      scope: 'Office Manager',
      expiresIn: 3600,
      user: '1013',
      domain: 'acme.com',
    });

    const authRes = mockResponse();
    await provider.authorize(
      dummyClient as unknown as import('@modelcontextprotocol/sdk/shared/auth.js').OAuthClientInformationFull,
      { codeChallenge: 'c-token', redirectUri: 'http://localhost:8080/cb' } as unknown as import('@modelcontextprotocol/sdk/server/auth/provider.js').AuthorizationParams,
      authRes as unknown as Response,
    );
    const authState = authRes.getHtml().match(/name="auth_state" value="([^"]+)"/)![1];

    const loginRes = mockResponse();
    await provider.handleTokenLogin(
      { body: { auth_state: authState }, headers: {} } as unknown as Request,
      loginRes as unknown as Response,
      'https://netsapiens.example.com',
      'ns-office-manager-token',
    );

    expect(capturedScope).toBe('Office Manager');
    expect(capturedUser).toBe('1013');
  });
});
