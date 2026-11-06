import type { Firestore } from '@google-cloud/firestore';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeFirestore } from '../../__tests__/test-support/fake-firestore.js';
import { initializeCutoverFence } from '../kit/cutover-fence.js';
import { FirestoreTokenStore } from '../firestore-stores.js';
import { NetSapiensAuthProvider } from '../netsapiens-auth-provider.js';

const client = { client_id: 'bridge-client' } as OAuthClientInformationFull;
const secret = 'bound-transport-test-secret-at-least-32-characters';
const previousSecret = process.env.MCP_SESSION_SECRET;

beforeEach(() => { process.env.MCP_SESSION_SECRET = secret; });
afterEach(() => {
  if (previousSecret === undefined) delete process.env.MCP_SESSION_SECRET;
  else process.env.MCP_SESSION_SECRET = previousSecret;
  vi.restoreAllMocks();
});

async function fixture() {
  const fake = new FakeFirestore({ ignoreUndefinedProperties: true });
  const db = fake as unknown as Firestore;
  await initializeCutoverFence(db, 'mcp');
  const provider = new NetSapiensAuthProvider({
    nsApiUrl: 'https://netsapiens.example.test',
    nsClientId: 'provider-client',
    nsClientSecret: 'provider-secret',
    firestore: db,
    collections: { tokens: 'mcp_tokens' },
    fence: { namespace: 'mcp', enforce: true },
  });
  // Exercise the provider-created store and its startup-bound transport, not a
  // replacement callback supplied by the test.
  const providerInternals: unknown = provider;
  if (!providerInternals || typeof providerInternals !== 'object' ||
      !('tokenStore' in providerInternals) || !(providerInternals.tokenStore instanceof FirestoreTokenStore)) {
    throw new Error('Provider did not construct a Firestore token store');
  }
  const store = providerInternals.tokenStore;
  const token = await provider.withOperation('issue', operation => store.issue({
    accessToken: 'mcp-access', refreshToken: 'mcp-refresh', clientId: client.client_id,
    expiresAt: Date.now() + 3_600_000,
    nsAccessToken: 'initial-access', nsRefreshToken: 'initial-refresh', nsUsername: 'user',
  }, { operation }));
  if (!token.refreshFamilyId) throw new Error('Issued token has no refresh family');
  const grantRef = store.upstreamDocRef(token.refreshFamilyId);
  return { provider, store, grantRef };
}

function respond(data: Record<string, unknown>) {
  return vi.spyOn(axios, 'post').mockResolvedValue({ data });
}

describe('provider-bound upstream refresh transport', () => {
  it('uses the configured provider transport and commits its result once on retry', async () => {
    const { provider, grantRef } = await fixture();
    const post = respond({ access_token: 'next-access', refresh_token: 'next-refresh', expires_in: 3600 });
    const first = await provider.exchangeRefreshToken(client, 'mcp-refresh');
    expect(first.access_token).toBeTruthy();
    expect(first.refresh_token).toBeTruthy();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toBe('https://netsapiens.example.test/ns-api/v2/tokens');
    expect(post.mock.calls[0]?.[1]).toMatchObject({
      grant_type: 'refresh_token', client_id: 'provider-client', client_secret: 'provider-secret',
      refresh_token: 'initial-refresh',
    });
    expect((await grantRef.get()).data()?.grant).toMatchObject({ nsAccessToken: 'next-access', nsRefreshToken: 'next-refresh' });
    const retry = await provider.exchangeRefreshToken(client, 'mcp-refresh');
    expect(retry.access_token).toBe(first.access_token);
    expect(retry.refresh_token).toBe(first.refresh_token);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('uses the current upstream grant when the provider omits a refresh token', async () => {
    const { provider, grantRef } = await fixture();
    const before = (await grantRef.get()).data();
    if (!before || typeof before.grant !== 'object' || before.grant === null) throw new Error('Missing seeded upstream grant');
    await grantRef.update({ grant: { ...before.grant, nsRefreshToken: 'current-refresh' } });
    const post = respond({ access_token: 'next-access', expires_in: 3600 });
    await provider.exchangeRefreshToken(client, 'mcp-refresh');
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[1]).toMatchObject({ refresh_token: 'current-refresh' });
    expect((await grantRef.get()).data()?.grant).toMatchObject({ nsAccessToken: 'next-access', nsRefreshToken: 'current-refresh' });
  });

  it.each([
    ['missing access token', { refresh_token: 'next-refresh' }],
    ['empty access token', { access_token: '', refresh_token: 'next-refresh' }],
    ['empty refresh token', { access_token: 'next-access', refresh_token: '' }],
  ])('holds the existing grant for %s', async (_name, data) => {
    const { provider, grantRef } = await fixture();
    const oldGrant = (await grantRef.get()).data()?.grant;
    const post = respond(data);
    await expect(provider.exchangeRefreshToken(client, 'mcp-refresh')).rejects.toThrow();
    const record = (await grantRef.get()).data();
    expect(record?.grant).toEqual(oldGrant);
    expect(record).toMatchObject({ ambiguousOutcome: true });
    await expect(provider.exchangeRefreshToken(client, 'mcp-refresh')).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(1);
  });
});
