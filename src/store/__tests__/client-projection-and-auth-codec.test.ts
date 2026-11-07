// Tests for the recent client projection, auth-code row codec, and auth-code expiry fixes (commit 4b128b4).
// Runs on the in-memory store and the real row codec; no emulator and no network.
// UNVERIFIED: written without a run this round (no new runs while core integration is pending).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { NetSapiensAuthProvider } from '../../auth/netsapiens-auth-provider.js';
import { createCodec, deriveStoreKey } from '../codec.js';
import { createMemoryStore } from '../memory.js';
import { encodeAuthCodesRow } from '../row-codec.js';

const SECRET = 'a'.repeat(32);
const SERVER_BASE_URL = 'https://mcp.example.com';
const CLIENT_ID = 'client-projection';

function freshStore(namespace: string) {
  return createMemoryStore({ namespace, key: deriveStoreKey(SECRET) });
}

// Every field that is a storage artifact or a null placeholder must be absent from the projection.
function expectOAuthProjection(client: Record<string, unknown>): void {
  expect(client).not.toHaveProperty('v');
  expect(client).not.toHaveProperty('_mcp_format');
  for (const [key, value] of Object.entries(client)) {
    expect(value, `field ${key} must not be null`).not.toBeNull();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('OAuth client projection (registerClient and getClient agree)', () => {
  it('registers a public client and returns the same projection on lookup', async () => {
    const store = freshStore('client_projection_public');
    const registered = await store.clients.registerClient({
      redirect_uris: ['http://localhost/callback'],
      client_name: 'Public client',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });

    expectOAuthProjection(registered as unknown as Record<string, unknown>);
    expect(registered.client_id).toEqual(expect.any(String));
    expect(registered.client_id_issued_at).toEqual(expect.any(Number));
    expect(registered.token_endpoint_auth_method).toBe('none');

    const fetched = await store.clients.getClient(registered.client_id);
    expect(fetched).toEqual(registered);
  });

  it('registers a confidential client and returns the same projection on lookup', async () => {
    const store = freshStore('client_projection_confidential');
    const registered = await store.clients.registerClient({
      redirect_uris: ['https://app.example.com/callback'],
      client_name: 'Confidential client',
      token_endpoint_auth_method: 'client_secret_basic',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });

    expectOAuthProjection(registered as unknown as Record<string, unknown>);
    expect(registered.token_endpoint_auth_method).toBe('client_secret_basic');
    expect(registered.redirect_uris).toEqual(['https://app.example.com/callback']);

    const fetched = await store.clients.getClient(registered.client_id);
    expect(fetched).toEqual(registered);
    expectOAuthProjection(fetched as unknown as Record<string, unknown>);
  });

  it('returns undefined for an unknown client id', async () => {
    const store = freshStore('client_projection_missing');
    expect(await store.clients.getClient('no-such-client')).toBeUndefined();
  });
});

describe('auth-code row codec (encodeAuthCodesRow)', () => {
  const codec = createCodec(deriveStoreKey(SECRET));
  const resource = 'https://mcp.example.com/mcp';

  function codeData(used?: boolean) {
    return {
      pending: {
        clientId: CLIENT_ID,
        codeChallenge: 'chal-codec',
        redirectUri: 'http://localhost/callback',
        createdAt: 1_000,
        state: 'state-codec',
        scopes: ['mcp:read'],
        resource,
      },
      nsTokens: {
        access_token: 'ns-access-codec',
        refresh_token: 'ns-refresh-codec',
        expires_in: 3600,
        username: 'alice@domain.com',
        scope: 'user-scope',
        nsApiUrl: 'https://netsapiens.example.com',
      },
      clientId: CLIENT_ID,
      serverBaseUrl: SERVER_BASE_URL,
      extra: { tenant: 'acme' },
      ...(used === undefined ? {} : { used }),
    };
  }

  it('produces a v2 row keyed by the code id, with the sealed payload bound to that id', () => {
    const code = 'code-codec-1';
    const now = 1_000;
    const expiresAt = now + 60_000;
    const row = encodeAuthCodesRow(codec, code, codeData(), expiresAt, now);

    expect(row.v).toBe(2);
    expect(row.id).toBe(codec.id('code', code));
    expect(row.expiresAt).toBe(expiresAt);
    expect(row.ttlAt).toEqual(new Date(expiresAt));
    expect(row.used).toBe(false);

    // The sealed payload opens only under its own code id, as additional authenticated data.
    const opened = codec.open<Record<string, any>>(row.sealed, `code:${row.id}`);
    expect(opened?.pending.resource).toBe(resource);
    expect(opened?.pending.codeChallenge).toBe('chal-codec');
    expect(opened?.nsTokens.expires_in).toBe(3600);
    expect(opened?.nsTokens.scope).toBe('user-scope');
    expect(opened?.used).toBe(false);
    expect(codec.open(row.sealed, 'code:some-other-id')).toBeUndefined();
  });

  it('carries used=true into both the row and the sealed payload', () => {
    const row = encodeAuthCodesRow(codec, 'code-codec-used', codeData(true), 61_000, 1_000);

    expect(row.used).toBe(true);
    const opened = codec.open<Record<string, any>>(row.sealed, `code:${row.id}`);
    expect(opened?.used).toBe(true);
  });
});

describe('auth-code expiry', () => {
  it('refuses an expired code at lookup and at exchange', async () => {
    const store = freshStore('authcode_expiry');
    const provider = new NetSapiensAuthProvider({
      platforms: [{ id: 'default', label: 'Default', apiUrl: 'https://netsapiens.example.com' }],
      nsApiUrl: 'https://netsapiens.example.com',
      store,
      serverBaseUrl: SERVER_BASE_URL,
    } as any);

    const code = 'code-expiry-1';
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start);

    await store.authCodes.put(code, {
      pending: {
        clientId: CLIENT_ID,
        codeChallenge: 'chal-expiry',
        redirectUri: 'http://localhost/callback',
        createdAt: start,
        state: 'state-expiry',
        scopes: ['mcp:read'],
        resource: new URL(`${SERVER_BASE_URL}/mcp`),
      },
      nsTokens: {
        access_token: 'ns-access-expiry',
        refresh_token: 'ns-refresh-expiry',
        expires_in: 3600,
        username: 'alice@domain.com',
        nsApiUrl: 'https://netsapiens.example.com',
      },
      serverBaseUrl: SERVER_BASE_URL,
      extra: {},
    } as any);

    const expected = { serverBaseUrl: SERVER_BASE_URL, clientId: CLIENT_ID };
    expect(await store.authCodes.getChallenge(code, expected)).toBe('chal-expiry');

    // Jump far past any code lifetime. The code must no longer resolve.
    vi.setSystemTime(start + 365 * 24 * 3600 * 1000);
    expect(await store.authCodes.getChallenge(code, expected)).toBeUndefined();
    expect(await store.authCodes.getEntry(code, expected)).toBeUndefined();

    const client = { client_id: CLIENT_ID, redirect_uris: ['http://localhost/callback'] } as unknown as OAuthClientInformationFull;
    await expect(provider.exchangeAuthorizationCode(client, code)).rejects.toThrow();
  });
});
