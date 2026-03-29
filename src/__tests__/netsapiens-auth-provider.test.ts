import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

import { NetSapiensAuthProvider } from '../auth/netsapiens-auth-provider.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDir = mkdtempSync(join(tmpdir(), 'auth-provider-test-'));
let testCounter = 0;

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createProvider() {
  testCounter++;
  return new NetSapiensAuthProvider({
    nsApiUrl: 'https://ns.example.com',
    nsClientId: 'ns-cid',
    nsClientSecret: 'ns-secret',
    tokenLifetimeSec: 3600,
    tokenStorePath: join(tempDir, `tokens-${testCounter}.json`),
  });
}

function mockNsTokenResponse(overrides?: Record<string, unknown>) {
  return {
    data: {
      access_token: 'ns-access-xyz',
      refresh_token: 'ns-refresh-xyz',
      expires_in: 3600,
      ...overrides,
    },
  };
}

/** Simulate the authorize → handleLogin → exchangeAuthorizationCode flow */
async function runFullLoginFlow(provider: NetSapiensAuthProvider) {
  // 1. Start authorization — capture the auth_id from the login page URL
  let loginUrl = '';
  const mockRes: any = {
    status: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    send: vi.fn((html: string) => {
      const match = html.match(/action="([^"]+)"/);
      loginUrl = match?.[1] ?? '';
    }),
    redirect: vi.fn(),
  };

  const client = {
    client_id: 'test-client-id',
    redirect_uris: [new URL('http://localhost/callback')],
  } as any;

  await provider.authorize(client, {
    codeChallenge: 'test-challenge-abc',
    redirectUri: 'http://localhost/callback',
    state: 'test-state',
  }, mockRes);

  const authIdMatch = loginUrl.match(/auth_id=([^&]+)/);
  const authId = authIdMatch?.[1] ?? '';
  expect(authId).toBeTruthy();

  // 2. Handle login — NS password grant succeeds
  mockedAxios.post.mockResolvedValueOnce(mockNsTokenResponse());

  const loginRes: any = {
    status: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    send: vi.fn(),
    redirect: vi.fn(),
  };

  await provider.handleLogin(authId, 'testuser', 'testpass', loginRes);

  // Should redirect with code + state
  expect(loginRes.redirect).toHaveBeenCalled();
  const redirectUrl = new URL(loginRes.redirect.mock.calls[0][0]);
  const code = redirectUrl.searchParams.get('code')!;
  const state = redirectUrl.searchParams.get('state');
  expect(code).toBeTruthy();
  expect(state).toBe('test-state');

  // 3. Exchange code for tokens
  const tokens = await provider.exchangeAuthorizationCode(client, code);

  return { tokens, code };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NetSapiensAuthProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ----- Clients store -----

  describe('clientsStore', () => {
    it('supports dynamic client registration', () => {
      const provider = createProvider();
      const store = provider.clientsStore;

      const registered = store.registerClient!({
        redirect_uris: [new URL('http://localhost/callback')],
        client_name: 'Test Client',
      } as any);

      expect(registered.client_id).toBeTruthy();
      expect(registered.client_secret).toBeTruthy();
      expect(store.getClient(registered.client_id)).toEqual(registered);
    });

    it('returns undefined for unknown client IDs', () => {
      const provider = createProvider();
      expect(provider.clientsStore.getClient('nonexistent')).toBeUndefined();
    });
  });

  // ----- authorize -----

  describe('authorize()', () => {
    it('renders a login page with a form posting to /login?auth_id=...', async () => {
      const provider = createProvider();
      const mockRes: any = {
        status: vi.fn().mockReturnThis(),
        type: vi.fn().mockReturnThis(),
        send: vi.fn(),
      };

      await provider.authorize(
        { client_id: 'c1', redirect_uris: [new URL('http://localhost/cb')] } as any,
        { codeChallenge: 'challenge', redirectUri: 'http://localhost/cb' },
        mockRes,
      );

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.type).toHaveBeenCalledWith('html');
      const html = mockRes.send.mock.calls[0][0] as string;
      expect(html).toContain('Sign In');
      expect(html).toContain('/login?auth_id=');
      expect(html).toContain('name="username"');
      expect(html).toContain('name="password"');
    });
  });

  // ----- handleLogin -----

  describe('handleLogin()', () => {
    it('returns error page for expired/unknown auth_id', async () => {
      const provider = createProvider();
      const mockRes: any = {
        status: vi.fn().mockReturnThis(),
        type: vi.fn().mockReturnThis(),
        send: vi.fn(),
      };

      await provider.handleLogin('nonexistent-id', 'user', 'pass', mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      const html = mockRes.send.mock.calls[0][0] as string;
      expect(html).toContain('Session expired');
    });

    it('returns error page when NS password grant fails', async () => {
      const provider = createProvider();

      // Start authorization first to get a valid auth_id
      let authId = '';
      const authorizeRes: any = {
        status: vi.fn().mockReturnThis(),
        type: vi.fn().mockReturnThis(),
        send: vi.fn((html: string) => {
          const match = html.match(/auth_id=([^&"]+)/);
          authId = match?.[1] ?? '';
        }),
      };

      await provider.authorize(
        { client_id: 'c1', redirect_uris: [new URL('http://localhost/cb')] } as any,
        { codeChallenge: 'ch', redirectUri: 'http://localhost/cb' },
        authorizeRes,
      );

      // Mock NS returning 401
      mockedAxios.post.mockRejectedValueOnce(new Error('Request failed with status code 401'));

      const loginRes: any = {
        status: vi.fn().mockReturnThis(),
        type: vi.fn().mockReturnThis(),
        send: vi.fn(),
      };

      await provider.handleLogin(authId, 'baduser', 'badpass', loginRes);

      expect(loginRes.status).toHaveBeenCalledWith(200);
      const html = loginRes.send.mock.calls[0][0] as string;
      expect(html).toContain('Invalid username or password');
    });

    it('redirects with authorization code on successful login', async () => {
      const provider = createProvider();
      const { tokens } = await runFullLoginFlow(provider);

      expect(tokens.access_token).toBeTruthy();
      expect(tokens.token_type).toBe('Bearer');
      expect(tokens.expires_in).toBe(3600);
      expect(tokens.refresh_token).toBeTruthy();
    });
  });

  // ----- Full flow -----

  describe('full authorization code flow', () => {
    it('issues tokens that can be verified', async () => {
      const provider = createProvider();
      const { tokens } = await runFullLoginFlow(provider);

      const authInfo = await provider.verifyAccessToken(tokens.access_token);

      expect(authInfo.token).toBe(tokens.access_token);
      expect(authInfo.clientId).toBe('test-client-id');
      expect(authInfo.extra?.nsAccessToken).toBe('ns-access-xyz');
      expect(authInfo.extra?.nsUsername).toBe('testuser');
    });

    it('returns the correct code challenge', async () => {
      const provider = createProvider();

      // Start auth
      let authId = '';
      const authorizeRes: any = {
        status: vi.fn().mockReturnThis(),
        type: vi.fn().mockReturnThis(),
        send: vi.fn((html: string) => {
          const match = html.match(/auth_id=([^&"]+)/);
          authId = match?.[1] ?? '';
        }),
      };

      await provider.authorize(
        { client_id: 'c1', redirect_uris: [new URL('http://localhost/cb')] } as any,
        { codeChallenge: 'my-challenge', redirectUri: 'http://localhost/cb' },
        authorizeRes,
      );

      mockedAxios.post.mockResolvedValueOnce(mockNsTokenResponse());

      const loginRes: any = { redirect: vi.fn() };
      await provider.handleLogin(authId, 'user', 'pass', loginRes);

      const code = new URL(loginRes.redirect.mock.calls[0][0]).searchParams.get('code')!;
      const challenge = await provider.challengeForAuthorizationCode({} as any, code);

      expect(challenge).toBe('my-challenge');
    });

    it('rejects a code that has already been exchanged', async () => {
      const provider = createProvider();

      // Do the full flow to consume the code
      let authId = '';
      const authorizeRes: any = {
        status: vi.fn().mockReturnThis(),
        type: vi.fn().mockReturnThis(),
        send: vi.fn((html: string) => {
          const match = html.match(/auth_id=([^&"]+)/);
          authId = match?.[1] ?? '';
        }),
      };

      await provider.authorize(
        { client_id: 'c1', redirect_uris: [new URL('http://localhost/cb')] } as any,
        { codeChallenge: 'ch', redirectUri: 'http://localhost/cb' },
        authorizeRes,
      );

      mockedAxios.post.mockResolvedValueOnce(mockNsTokenResponse());

      const loginRes: any = { redirect: vi.fn() };
      await provider.handleLogin(authId, 'user', 'pass', loginRes);
      const code = new URL(loginRes.redirect.mock.calls[0][0]).searchParams.get('code')!;

      // First exchange succeeds
      await provider.exchangeAuthorizationCode({} as any, code);

      // Second exchange should fail
      await expect(
        provider.exchangeAuthorizationCode({} as any, code),
      ).rejects.toThrow('Invalid authorization code');
    });
  });

  // ----- Token verification -----

  describe('verifyAccessToken()', () => {
    it('rejects unknown tokens', async () => {
      const provider = createProvider();

      await expect(provider.verifyAccessToken('bogus')).rejects.toThrow('Invalid access token');
    });
  });

  // ----- Refresh -----

  describe('exchangeRefreshToken()', () => {
    it('issues new tokens using the NS refresh token', async () => {
      const provider = createProvider();
      const { tokens } = await runFullLoginFlow(provider);

      // Mock the NS refresh grant
      mockedAxios.post.mockResolvedValueOnce(mockNsTokenResponse({
        access_token: 'ns-access-refreshed',
        refresh_token: 'ns-refresh-refreshed',
      }));

      const newTokens = await provider.exchangeRefreshToken(
        {} as any,
        tokens.refresh_token!,
      );

      expect(newTokens.access_token).toBeTruthy();
      expect(newTokens.access_token).not.toBe(tokens.access_token);

      // Old token should be invalid
      await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();

      // New token should be valid
      const authInfo = await provider.verifyAccessToken(newTokens.access_token);
      expect(authInfo.extra?.nsAccessToken).toBe('ns-access-refreshed');
    });

    it('rejects unknown refresh tokens', async () => {
      const provider = createProvider();

      await expect(
        provider.exchangeRefreshToken({} as any, 'bogus-refresh'),
      ).rejects.toThrow('Invalid refresh token');
    });
  });

  // ----- Revocation -----

  describe('revokeToken()', () => {
    it('revokes an access token', async () => {
      const provider = createProvider();
      const { tokens } = await runFullLoginFlow(provider);

      await provider.revokeToken!({} as any, { token: tokens.access_token });

      await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
    });

    it('revokes a refresh token and invalidates the access token', async () => {
      const provider = createProvider();
      const { tokens } = await runFullLoginFlow(provider);

      await provider.revokeToken!({} as any, { token: tokens.refresh_token! });

      await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
    });

    it('does nothing for unknown tokens', async () => {
      const provider = createProvider();

      // Should not throw
      await provider.revokeToken!({} as any, { token: 'nonexistent' });
    });
  });

  // ----- NS password grant call -----

  describe('upstream NS API calls', () => {
    it('sends correct password grant parameters to NS', async () => {
      const provider = createProvider();

      // Start auth
      let authId = '';
      const authorizeRes: any = {
        status: vi.fn().mockReturnThis(),
        type: vi.fn().mockReturnThis(),
        send: vi.fn((html: string) => {
          const match = html.match(/auth_id=([^&"]+)/);
          authId = match?.[1] ?? '';
        }),
      };

      await provider.authorize(
        { client_id: 'c1', redirect_uris: [new URL('http://localhost/cb')] } as any,
        { codeChallenge: 'ch', redirectUri: 'http://localhost/cb' },
        authorizeRes,
      );

      mockedAxios.post.mockResolvedValueOnce(mockNsTokenResponse());

      const loginRes: any = { redirect: vi.fn() };
      await provider.handleLogin(authId, 'myuser', 'mypass', loginRes);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://ns.example.com/ns-api/oauth2/token/',
        expect.stringContaining('grant_type=password'),
        expect.objectContaining({ headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }),
      );

      const body = mockedAxios.post.mock.calls[0][1] as string;
      expect(body).toContain('client_id=ns-cid');
      expect(body).toContain('client_secret=ns-secret');
      expect(body).toContain('username=myuser');
      expect(body).toContain('password=mypass');
    });
  });
});
