import { describe, expect, it } from 'vitest';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { NetSapiensAuthProvider } from '../../auth/netsapiens-auth-provider.js';
import { deriveStoreKey } from '../codec.js';
import { createMemoryStore } from '../memory.js';

const SERVER_BASE_URL = 'https://mcp.example.com';
const CLIENT_ID = 'client-1';

describe('auth code round trip through the atomic exchange', () => {
  it('keeps PKCE, resource, scopes, and nsTokens expires_in and scope, and the exchanged session expires from expires_in', async () => {
    const store = createMemoryStore({ namespace: 'authcode_roundtrip', key: deriveStoreKey('a'.repeat(32)) });
    const provider = new NetSapiensAuthProvider({
      platforms: [{ id: 'default', label: 'Default', apiUrl: 'https://netsapiens.example.com' }],
      nsApiUrl: 'https://netsapiens.example.com',
      store,
      serverBaseUrl: SERVER_BASE_URL,
    });

    const resource = new URL(`${SERVER_BASE_URL}/mcp`);
    const code = 'code-roundtrip-1';
    await store.authCodes.put(code, {
      pending: {
        clientId: CLIENT_ID,
        codeChallenge: 'chal-roundtrip',
        redirectUri: 'http://localhost/callback',
        createdAt: Date.now(),
        state: 'state-roundtrip',
        scopes: ['mcp:read'],
        resource,
      },
      nsTokens: {
        access_token: 'ns-access-roundtrip',
        refresh_token: 'ns-refresh-roundtrip',
        expires_in: 3600,
        username: 'alice@domain.com',
        nsUserRole: 'Reseller',
        scope: 'user-scope',
        nsApiUrl: 'https://netsapiens.example.com',
      },
      serverBaseUrl: SERVER_BASE_URL,
      extra: { tenant: 'acme' },
    });

    const expected = { serverBaseUrl: SERVER_BASE_URL, clientId: CLIENT_ID };
    expect(await store.authCodes.getChallenge(code, expected)).toBe('chal-roundtrip');

    const entry = await store.authCodes.getEntry(code, expected);
    expect(entry?.data.pending.resource).toBeInstanceOf(URL);
    expect(entry?.data.pending.resource?.href).toBe(resource.href);
    expect(entry?.data.pending.scopes).toEqual(['mcp:read']);
    expect(entry?.data.nsTokens.expires_in).toBe(3600);
    expect(entry?.data.nsTokens.scope).toBe('user-scope');

    const client = { client_id: CLIENT_ID, redirect_uris: ['http://localhost/callback'] } as unknown as OAuthClientInformationFull;
    const before = Date.now();
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    const after = Date.now();

    const session = await store.sessions.get(tokens.access_token);
    expect(session?.nsRefreshToken).toBe('ns-refresh-roundtrip');
    expect(session?.nsExpiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(session?.nsExpiresAt).toBeLessThanOrEqual(after + 3600 * 1000);

    expect(await store.authCodes.getEntry(code, expected)).toBeUndefined();
  });
});
