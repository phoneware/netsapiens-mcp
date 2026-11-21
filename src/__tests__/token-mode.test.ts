import { afterAll, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import type { Request, Response } from 'express';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { parseAuthMode } from '../auth/auth-mode.js';
import { NetSapiensAuthProvider } from '../auth/netsapiens-auth-provider.js';
import { createMemoryStore } from '../store/memory.js';
import { deriveStoreKey } from '../store/codec.js';

const home = mkdtempSync(join(tmpdir(), 'nsmcp-token-mode-test-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const client = {
  client_id: 'test-client',
  redirect_uris: ['http://localhost:8080/callback'],
  token_endpoint_auth_method: 'none',
} as unknown as OAuthClientInformationFull;

function tokenProvider() {
  const store = createMemoryStore({ namespace: 'test', key: deriveStoreKey('0123456789abcdef0123456789abcdef') });
  return new NetSapiensAuthProvider({
    authMode: 'token',
    platforms: [{ id: 'default', label: 'MCU', apiUrl: 'https://mars.example.com' }],
    nsApiUrl: 'https://mars.example.com',
    serverBaseUrl: 'http://localhost:3000',
    store,
  });
}

function mockResponse() {
  let html = '';
  let redirectUrl = '';
  const res = {
    status: vi.fn(() => res),
    set: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    send: vi.fn((body: string) => { html = body; return res; }),
    redirect: vi.fn((url: string) => { redirectUrl = url; return res; }),
    getHtml: () => html,
    getRedirectUrl: () => redirectUrl,
  };
  return res;
}

async function startAuthorization(provider: NetSapiensAuthProvider) {
  const res = mockResponse();
  await provider.authorize(
    client,
    { codeChallenge: 'c', redirectUri: 'http://localhost:8080/callback', state: 'xyz' } as unknown as AuthorizationParams,
    res as unknown as Response,
  );
  return { html: res.getHtml(), authState: res.getHtml().match(/name="auth_state" value="([^"]+)"/)![1] };
}

const validKey = { username: '1013@acme.com', userRole: 'domain_admin', scope: 'Office Manager', user: '1013', domain: 'acme.com' };

async function signInWithKey(provider: NetSapiensAuthProvider) {
  (provider as unknown as { validateNsToken: unknown }).validateNsToken = vi.fn().mockResolvedValue(validKey);
  const { authState } = await startAuthorization(provider);
  const res = mockResponse();
  await provider.handleTokenLogin(
    { body: { auth_state: authState }, headers: {} } as unknown as Request,
    res as unknown as Response,
    'https://mars.example.com',
    'user-api-key',
  );
  const code = new URL(res.getRedirectUrl()).searchParams.get('code')!;
  return provider.exchangeAuthorizationCode(client, code);
}

describe('NETSAPIENS_AUTH_MODE parsing', () => {
  it('defaults to oauth and accepts only oauth or token', () => {
    expect(parseAuthMode(undefined)).toBe('oauth');
    expect(parseAuthMode('  ')).toBe('oauth');
    expect(parseAuthMode('token')).toBe('token');
    expect(parseAuthMode(' OAuth ')).toBe('oauth');
    expect(() => parseAuthMode('password')).toThrow('ConfigError: NETSAPIENS_AUTH_MODE must be oauth or token, got "password"');
  });
});

describe('token mode provider', () => {
  it('never sends an OAuth grant without a client: token mode has none, oauth mode must be given one', async () => {
    const store = createMemoryStore({ namespace: 'test', key: deriveStoreKey('0123456789abcdef0123456789abcdef') });
    const options = { platforms: [{ id: 'default', label: 'X', apiUrl: 'https://mars.example.com' }], nsApiUrl: 'https://mars.example.com', store };
    const grants = [
      (provider: NetSapiensAuthProvider) => (provider as unknown as { nsPasswordGrant(u: string, p: string): Promise<unknown> }).nsPasswordGrant('a', 'b'),
      (provider: NetSapiensAuthProvider) => (provider as unknown as { nsRefreshGrant(t: string): Promise<unknown> }).nsRefreshGrant('r'),
    ];
    for (const grant of grants) {
      await expect(grant(tokenProvider())).rejects.toThrow('NetSapiens OAuth client is not configured');
      await expect(grant(new NetSapiensAuthProvider(options))).rejects.toThrow('NetSapiens OAuth client is not configured');
    }
  });

  it('shows only the key form, with no password form or tab', async () => {
    const { html } = await startAuthorization(tokenProvider());
    expect(html).toContain('id="token-form"');
    expect(html).toContain('NetSapiens Token or API Key');
    expect(html).not.toContain('id="password-form"');
    expect(html).not.toContain('name="username"');
    expect(html).not.toContain('<button type="button" class="tab-btn');
  });

  it('refuses a password sign-in without contacting NetSapiens', async () => {
    const provider = tokenProvider();
    const passwordGrant = vi.fn();
    (provider as unknown as { nsPasswordGrant: unknown }).nsPasswordGrant = passwordGrant;
    const { authState } = await startAuthorization(provider);
    const res = mockResponse();
    await provider.handleLogin({ body: { auth_state: authState }, headers: {} } as unknown as Request, res as unknown as Response, 'alice@acme.com', 'pw');
    expect(passwordGrant).not.toHaveBeenCalled();
    expect(res.getRedirectUrl()).toBe('');
    expect(res.getHtml()).toContain('Password sign-in is not enabled on this server');
  });

  it('refuses the MFA step', async () => {
    const provider = tokenProvider();
    const res = mockResponse();
    await provider.handleMfa({ body: {}, headers: {} } as unknown as Request, res as unknown as Response, '123456');
    expect(res.getHtml()).toContain('MFA sign-in is not enabled on this server');
  });

  it('signs a user in with their own key and keeps the key as the upstream credential', async () => {
    const provider = tokenProvider();
    const tokens = await signInWithKey(provider);
    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.extra?.nsAccessToken).toBe('user-api-key');
    expect(info.extra?.nsUsername).toBe('1013@acme.com');
    expect(info.extra?.nsApiUrl).toBe('https://mars.example.com');
  });

  it('renews the MCP session while NetSapiens still accepts the key', async () => {
    const provider = tokenProvider();
    const tokens = await signInWithKey(provider);
    const validate = vi.fn().mockResolvedValue(validKey);
    (provider as unknown as { validateNsToken: unknown }).validateNsToken = validate;
    const refreshed = await provider.exchangeRefreshToken(client, tokens.refresh_token!);
    expect(validate).toHaveBeenCalledWith('https://mars.example.com', 'user-api-key');
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    const info = await provider.verifyAccessToken(refreshed.access_token);
    expect(info.extra?.nsAccessToken).toBe('user-api-key');
  });

  it('ends the session when NetSapiens rejects the key at refresh', async () => {
    const provider = tokenProvider();
    const tokens = await signInWithKey(provider);
    (provider as unknown as { validateNsToken: unknown }).validateNsToken = vi.fn().mockRejectedValue(new Error('401 Unauthorized: Invalid NetSapiens API key.'));
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow('NetSapiens no longer accepts this key');
    // The family is revoked, so the same refresh token never works again.
    (provider as unknown as { validateNsToken: unknown }).validateNsToken = vi.fn().mockResolvedValue(validKey);
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow();
  });

  it('keeps the session and asks to retry when NetSapiens cannot be reached at refresh', async () => {
    const provider = tokenProvider();
    const tokens = await signInWithKey(provider);
    (provider as unknown as { validateNsToken: unknown }).validateNsToken = vi.fn().mockRejectedValue(new Error('Token validation failed: connect ETIMEDOUT'));
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow('please retry');
    (provider as unknown as { validateNsToken: unknown }).validateNsToken = vi.fn().mockResolvedValue(validKey);
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).resolves.toBeTruthy();
  });
});

describe('token mode startup', () => {
  const args = ['--import', 'tsx', 'src/index.ts'];
  const baseEnv = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: home,
    MCP_TRANSPORT: 'http',
    NETSAPIENS_API_URL: 'https://mars.example.com',
    MCP_SESSION_SECRET: 'a'.repeat(32),
    MCP_PERSISTENCE: 'memory',
  };

  it('refuses to start in oauth mode without a client, and says how to run without one', () => {
    const result = spawnSync(process.execPath, args, { env: baseEnv, encoding: 'utf8', timeout: 8000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('NETSAPIENS_OAUTH_CLIENT_ID and NETSAPIENS_OAUTH_CLIENT_SECRET');
    expect(result.stderr).toContain('NETSAPIENS_AUTH_MODE=token');
  });

  it('rejects an unknown mode', () => {
    const result = spawnSync(process.execPath, args, { env: { ...baseEnv, NETSAPIENS_AUTH_MODE: 'password' }, encoding: 'utf8', timeout: 8000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ConfigError: NETSAPIENS_AUTH_MODE must be oauth or token, got "password"');
  });

  it('serves a key-only login page and reports its mode with no OAuth client configured', async () => {
    const socket = createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const address = socket.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const port = address.port;
    socket.close();
    await once(socket, 'close');
    const server = spawn(process.execPath, args, {
      env: { ...baseEnv, NETSAPIENS_AUTH_MODE: 'token', MCP_PORT: String(port), MCP_HOST: '127.0.0.1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    try {
      const url = `http://127.0.0.1:${port}`;
      let health: globalThis.Response | undefined;
      for (let i = 0; i < 100; i++) {
        try { health = await fetch(`${url}/health`); break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
      }
      expect(health?.status).toBe(200);
      const healthBody: { authMode?: unknown; signIn: { mfaReady: boolean } } = await health!.json();
      expect(healthBody.authMode).toBe('token');
      expect(healthBody.signIn.mfaReady).toBe(false);
      const registration = await fetch(`${url}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://localhost/cb'], client_name: 'test', token_endpoint_auth_method: 'none' }) });
      const registered: { client_id: string } = await registration.json();
      const params = new URLSearchParams({ response_type: 'code', client_id: registered.client_id, redirect_uri: 'http://localhost/cb', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' });
      const page = await (await fetch(`${url}/authorize?${params}`)).text();
      expect(page).toContain('id="token-form"');
      expect(page).not.toContain('id="password-form"');
    } finally {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
  });
});
