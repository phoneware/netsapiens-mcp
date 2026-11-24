import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { captureLogs, closeHarnesses, startHarness, type Harness } from './support/access-harness.js';
import { REDIRECT, SUBJECT, policy, type Answer } from './support/access-registry-fake.js';
import { bodyString, refreshGrant, registerPublicClient, signInFull, type HttpApp } from './support/http-session.js';

function allow(): Answer {
  return { decision: 'allow', revision: 'rev-1', policy: policy() };
}

function toolsList(app: HttpApp, token: string) {
  return request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Authorization', `Bearer ${token}`)
    .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
}

/**
 * A stored session whose NetSapiens token and stored name belong to bob, while its identity keys name alice. Such a
 * session cannot be minted by this build, but a session stored before the keys were bound could carry it.
 */
async function storeMismatchedSession(h: Harness, clientId: string): Promise<{ accessToken: string; refreshToken: string }> {
  const accessToken = 'mismatched-access-token';
  const refreshToken = 'mismatched-refresh-token';
  await h.store.sessions.create(
    { accessToken, refreshToken },
    {
      clientId,
      expiresAt: Date.now() + 3_600_000,
      nsAccessToken: 'tok-bob',
      nsUsername: 'bob@domain.com',
      nsApiUrl: h.fake.origin,
      serverBaseUrl: 'http://localhost',
      extra: {
        authMethod: 'ns_token',
        authNsTotp: 'false',
        authAt: new Date().toISOString(),
        nsGrantKind: 'oauth',
        nsDomain: 'domain.com',
        nsUser: 'alice',
        nsScope: 'Office Manager',
        authRedirectUri: REDIRECT,
      },
    },
  );
  return { accessToken, refreshToken };
}

describe('the principal a session runs as', () => {
  afterEach(async () => {
    await closeHarnesses();
  });

  it('refuses a session whose identity keys name another account, on /mcp and on refresh', async () => {
    const logs = captureLogs();
    const h = await startHarness();
    h.registry.set('alice@domain.com', allow());
    h.registry.set('bob@domain.com', allow());
    const clientId = await registerPublicClient(h.app, REDIRECT);
    const { accessToken, refreshToken } = await storeMismatchedSession(h, clientId);
    const nsRequestsBefore = h.fake.requests.length;
    const registryRequestsBefore = h.registry.seen.length;

    expect((await toolsList(h.app, accessToken)).status).toBe(401);
    const refused = await refreshGrant(h.app, clientId, refreshToken);
    expect(refused.status).toBe(400);
    expect(bodyString(refused.body, 'error')).toBe('invalid_grant');

    // The family is revoked, so neither token works again.
    expect((await refreshGrant(h.app, clientId, refreshToken)).status).toBe(400);
    expect((await toolsList(h.app, accessToken)).status).toBe(401);

    // Refused before NetSapiens is called and before the registry is asked about anyone.
    expect(h.fake.requests.length).toBe(nsRequestsBefore);
    expect(h.registry.seen.length).toBe(registryRequestsBefore);
    expect(logs.events('Access session')).toContainEqual(
      expect.objectContaining({ outcome: 'reauth_required', reason: 'principal_mismatch', tenant: 'domain.com', subject: 'bob@domain.com' }),
    );
  });

  it('leaves an ordinary session alone, on /mcp and on refresh', async () => {
    const h = await startHarness();
    h.registry.set(SUBJECT, allow());
    const alice = await signInFull(h.app, h.fake.origin, 'tok-alice', REDIRECT);

    expect((await toolsList(h.app, alice.accessToken)).status).toBe(200);
    const refreshed = await refreshGrant(h.app, alice.clientId, alice.refreshToken);
    expect(refreshed.status).toBe(200);
    expect((await toolsList(h.app, bodyString(refreshed.body, 'access_token'))).status).toBe(200);
  });

  it('leaves a session alone when the stored name differs from the registry key only in case', async () => {
    const h = await startHarness();
    h.registry.set('bob@domain.com', allow());
    const mixed = await signInFull(h.app, h.fake.origin, 'tok-mixed', REDIRECT);
    expect((await h.store.sessions.get(mixed.accessToken))?.nsUsername).toBe('Bob@Domain.COM');

    expect((await toolsList(h.app, mixed.accessToken)).status).toBe(200);
    const refreshed = await refreshGrant(h.app, mixed.clientId, mixed.refreshToken);
    expect(refreshed.status).toBe(200);
    expect((await toolsList(h.app, bodyString(refreshed.body, 'access_token'))).status).toBe(200);
  });
});
