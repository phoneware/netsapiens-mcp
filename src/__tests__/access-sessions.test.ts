import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { AccessPolicyV1 } from '../access/contract.js';
import { deriveStoreKey } from '../store/codec.js';
import { createMemoryStore } from '../store/memory.js';
import { NS_SECRET, closeHarnesses, startFakeNs, startHarness, type FakeNs } from './support/access-harness.js';
import { OTHER_REDIRECT, REDIRECT, SUBJECT, TENANT, policy, type Answer } from './support/access-registry-fake.js';
import {
  bodyString,
  openLoginPage,
  postTokenLogin,
  refreshGrant,
  registerPublicClient,
  signIn,
  signInFull,
  type HttpApp,
} from './support/http-session.js';

const TOOLS_LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0' } },
};
/** Longer than the 60 second decision TTL the fake registry answers with. */
const PAST_TTL_MS = 61_000;
const DENIED: Answer = { decision: 'deny', reason: 'subject_not_enabled' };

function allow(patch: Partial<AccessPolicyV1> = {}, revision = 'rev-1'): Answer {
  return { decision: 'allow', revision, policy: policy(patch) };
}

/** An MCP request with the bearer, and the session header when there is one. */
function mcp(app: HttpApp, token: string, body: object = TOOLS_LIST, sessionId?: string) {
  const req = request(app).post('/mcp').set('Accept', 'application/json, text/event-stream').set('Authorization', `Bearer ${token}`);
  return (sessionId === undefined ? req : req.set('mcp-session-id', sessionId)).send(body);
}

/** NetSapiens requests made after the first `mark` requests, excluding the identity lookups a token check makes. */
function toolTrafficSince(fake: FakeNs, mark: number): string[] {
  return fake.requests
    .slice(mark)
    .map((entry) => entry.path)
    .filter((path) => path !== '/ns-api/v2/domains/~/users/~' && path !== '/ns-api/v2/apikeys/~');
}

afterEach(async () => {
  await closeHarnesses();
});

describe('registry sessions (E2 and E3)', () => {
  it('refuses a session made before the registry: /mcp answers 401, refresh answers invalid_grant, and the family is gone', async () => {
    const fake = await startFakeNs();
    const store = createMemoryStore({ namespace: 'test', key: deriveStoreKey(NS_SECRET) });
    try {
      const before = await startHarness({ registry: false, fake, store });
      const tokens = await signInFull(before.app, fake.origin, 'tok-alice', REDIRECT);
      await before.close();

      const after = await startHarness({ fake, store });
      after.registry.set(SUBJECT, allow());
      expect((await mcp(after.app, tokens.accessToken)).status).toBe(401);

      const refused = await refreshGrant(after.app, tokens.clientId, tokens.refreshToken);
      expect(refused.status).toBe(400);
      expect(bodyString(refused.body, 'error')).toBe('invalid_grant');
      expect((await refreshGrant(after.app, tokens.clientId, tokens.refreshToken)).status).toBe(400);
      expect((await mcp(after.app, tokens.accessToken)).status).toBe(401);

      const fresh = await signIn(after.app, fake.origin, 'tok-alice', REDIRECT);
      expect((await mcp(after.app, fresh)).status).not.toBe(401);
    } finally {
      await closeHarnesses();
      await store.close();
      await fake.close();
    }
  });

  it('answers 401 on the next request once the tenant is denied, without reaching NetSapiens', async () => {
    const h = await startHarness();
    h.registry.set(SUBJECT, allow());
    const token = await signIn(h.app, h.fake.origin, 'tok-alice', REDIRECT);
    expect((await mcp(h.app, token)).status).not.toBe(401);

    h.registry.set(SUBJECT, DENIED);
    h.clock.advance(PAST_TTL_MS);
    const mark = h.fake.requests.length;
    expect((await mcp(h.app, token)).status).toBe(401);
    expect(toolTrafficSince(h.fake, mark)).toEqual([]);
  });

  it('answers 401 on the next request once the AI app is no longer approved for the session', async () => {
    const h = await startHarness();
    h.registry.set(SUBJECT, allow());
    const token = await signIn(h.app, h.fake.origin, 'tok-alice', REDIRECT);
    expect((await mcp(h.app, token)).status).not.toBe(401);

    h.registry.set(SUBJECT, allow({ platforms: [OTHER_REDIRECT] }, 'rev-2'));
    h.clock.advance(PAST_TTL_MS);
    expect((await mcp(h.app, token)).status).toBe(401);
  });

  it('revokes the family when a refresh finds the tenant denied', async () => {
    const h = await startHarness();
    h.registry.set(SUBJECT, allow());
    const tokens = await signInFull(h.app, h.fake.origin, 'tok-alice', REDIRECT);

    h.registry.set(SUBJECT, DENIED);
    h.clock.advance(PAST_TTL_MS);
    const refused = await refreshGrant(h.app, tokens.clientId, tokens.refreshToken);

    expect(refused.status).toBe(400);
    expect(bodyString(refused.body, 'error')).toBe('invalid_grant');
    expect((await mcp(h.app, tokens.accessToken)).status).toBe(401);
    expect((await refreshGrant(h.app, tokens.clientId, tokens.refreshToken)).status).toBe(400);
  });

  it('keeps sessions signed in through an outage: last known good inside the window, then unavailable past it', async () => {
    const h = await startHarness({ maxStaleSeconds: 600 });
    h.registry.set(SUBJECT, allow());
    const tokens = await signInFull(h.app, h.fake.origin, 'tok-alice', REDIRECT);
    h.registry.down = true;

    h.clock.advance(PAST_TTL_MS);
    expect((await mcp(h.app, tokens.accessToken)).status).not.toBe(401);

    h.clock.advance(600_000);
    expect((await mcp(h.app, tokens.accessToken)).status).not.toBe(401);
    const refreshed = await refreshGrant(h.app, tokens.clientId, tokens.refreshToken).expect(200);
    expect((await mcp(h.app, bodyString(refreshed.body, 'access_token'))).status).not.toBe(401);

    const clientId = await registerPublicClient(h.app, REDIRECT);
    const authState = await openLoginPage(h.app, clientId, REDIRECT);
    expect((await postTokenLogin(h.app, authState, h.fake.origin, 'tok-alice')).status).toBe(503);
  });

  it('answers 404 when a stateful session is presented by a different subject', async () => {
    let presentedSubject: string | undefined;
    const h = await startHarness({
      stateless: false,
      wrapAccess: (access) => ({
        evaluate: access.evaluate,
        identityFromAuthInfo(extra) {
          const identity = access.identityFromAuthInfo(extra);
          return identity !== undefined && presentedSubject !== undefined ? { ...identity, subject: presentedSubject } : identity;
        },
      }),
    });
    h.registry.set(TENANT, allow());
    const token = await signIn(h.app, h.fake.origin, 'tok-alice', REDIRECT);
    const init = await mcp(h.app, token, INITIALIZE).expect(200);
    const sessionId = init.headers['mcp-session-id'] as string;
    expect(sessionId).toBeTruthy();
    expect((await mcp(h.app, token, TOOLS_LIST, sessionId)).status).toBe(200);

    presentedSubject = 'mallory@domain.com';
    expect((await mcp(h.app, token, TOOLS_LIST, sessionId)).status).toBe(404);
    expect(
      (await request(h.app).get('/mcp').set('Accept', 'text/event-stream').set('Authorization', `Bearer ${token}`).set('mcp-session-id', sessionId)).status,
    ).toBe(404);
    expect(
      (await request(h.app).delete('/mcp').set('Authorization', `Bearer ${token}`).set('mcp-session-id', sessionId)).status,
    ).toBe(404);
  });
});
