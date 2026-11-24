import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { AccessUnavailableCause } from '../access/enforcer.js';
import type { RegistryResponse } from '../access/registry-client.js';
import { captureLogs, closeHarnesses, startHarness, toolTraffic, type Harness } from './support/access-harness.js';
import { REDIRECT, SUBJECT, policy, wireDecision, type Answer } from './support/access-registry-fake.js';
import {
  openLoginPage,
  postTokenLogin,
  refreshGrant,
  registerPublicClient,
  signInFull,
  type HttpApp,
  type SignedInTokens,
} from './support/http-session.js';

/** Stands in for any registry-supplied text. A test asserts it never reaches a log line. */
const MARKER = 'REGISTRY-BODY-MARKER-9c1e';
const UNAVAILABLE_COPY = 'Sign-in is temporarily unavailable. Try again in a few minutes.';
const PAST_WINDOW_MS = 601_000;

function allow(): Answer {
  return { decision: 'allow', revision: 'rev-1', policy: policy() };
}

async function attemptLogin(h: Harness, nsToken: string) {
  const clientId = await registerPublicClient(h.app, REDIRECT);
  const authState = await openLoginPage(h.app, clientId, REDIRECT);
  return postTokenLogin(h.app, authState, h.fake.origin, nsToken);
}

function toolsList(app: HttpApp, token: string) {
  return request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Authorization', `Bearer ${token}`)
    .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
}

/** One way the registry can fail to give a usable decision, and what the logs must say about it. */
interface CauseRow {
  readonly name: string;
  readonly cause: AccessUnavailableCause;
  readonly reason: 'registry_unavailable' | 'registry_error' | 'policy_invalid';
  /** What every registry request answers with. Absent for the outage row. */
  readonly response?: RegistryResponse;
  /**
   * True for the row where the enforcer itself reports outage. The real client always names a class, so this row takes
   * the enforcer's outage path through the gate in the test instead.
   */
  readonly outage?: true;
}

const DENY_WITH_CRITICAL = JSON.stringify({
  version: 1,
  decision: 'deny',
  reason: 'subject_not_enabled',
  revision: '0',
  ttlSeconds: 60,
  critical: [MARKER],
});

const BAD_POLICY = JSON.stringify(
  wireDecision({
    decision: 'allow',
    revision: 'rev-bad',
    policy: policy({ tools: { allow: ['@curated'], deny: [`@${MARKER}`] } }),
  }),
);

const ROWS: readonly CauseRow[] = [
  { name: 'timeout', cause: 'timeout', reason: 'registry_unavailable', response: { kind: 'failure', errorClass: 'timeout' } },
  { name: 'network failure', cause: 'network', reason: 'registry_unavailable', response: { kind: 'failure', errorClass: 'network' } },
  {
    name: 'HTTP 404',
    cause: 'http_status',
    reason: 'registry_error',
    response: { kind: 'failure', errorClass: 'http_status', httpStatus: 404 },
  },
  { name: 'HTTP 401', cause: 'auth', reason: 'registry_error', response: { kind: 'failure', errorClass: 'auth', httpStatus: 401 } },
  { name: 'body that is not JSON', cause: 'contract', reason: 'registry_error', response: { kind: 'text', body: `not json ${MARKER}` } },
  {
    name: 'body of another wire version',
    cause: 'contract',
    reason: 'registry_error',
    response: { kind: 'text', body: JSON.stringify({ version: 2, revision: MARKER }) },
  },
  {
    name: 'body over 64 KiB',
    cause: 'contract',
    reason: 'registry_error',
    response: { kind: 'text', body: `${MARKER}${'x'.repeat(64 * 1024)}` },
  },
  { name: 'deny with a critical member', cause: 'critical', reason: 'registry_error', response: { kind: 'text', body: DENY_WITH_CRITICAL } },
  {
    name: 'allow whose policy the compiler rejects',
    cause: 'policy_invalid',
    reason: 'policy_invalid',
    response: { kind: 'text', body: BAD_POLICY },
  },
  { name: 'client reports no class', cause: 'outage', reason: 'registry_unavailable', outage: true },
];

describe('an unavailable registry: cause, log fields and behavior', () => {
  afterEach(async () => {
    await closeHarnesses();
    vi.restoreAllMocks();
  });

  it.each(ROWS)('$name: sign-in is refused, an existing session passes, and the logs name $cause', async (row) => {
    const logs = captureLogs();
    const gate = { outage: false };
    const h = await startHarness({
      wrapAccess: (access) => ({
        identityFromAuthInfo: access.identityFromAuthInfo,
        evaluate: async (who, options) => (gate.outage ? { kind: 'unavailable', cause: 'outage' } : access.evaluate(who, options)),
      }),
    });
    h.registry.set(SUBJECT, allow());
    const alice: SignedInTokens = await signInFull(h.app, h.fake.origin, 'tok-alice', REDIRECT);
    expect(h.authCodePuts).toHaveBeenCalledTimes(1);

    // The registry now fails the way the row describes. Bob was never decided, so nothing is cached for him.
    if (row.response !== undefined) h.registry.response = row.response;
    gate.outage = row.outage === true;

    const refused = await attemptLogin(h, 'tok-bob');
    expect(refused.status).toBe(503);
    expect(refused.text).toContain(UNAVAILABLE_COPY);
    expect(h.authCodePuts).toHaveBeenCalledTimes(1);
    expect(toolTraffic(h.fake)).toEqual([]);
    expect(logs.events('Access sign-in')).toContainEqual(
      expect.objectContaining({ outcome: 'unavailable', cause: row.cause, reason: row.reason }),
    );

    // Past the last-known-good window the existing session still authenticates and refreshes.
    h.clock.advance(PAST_WINDOW_MS);
    expect((await toolsList(h.app, alice.accessToken)).status).toBe(200);
    expect((await refreshGrant(h.app, alice.clientId, alice.refreshToken)).status).toBe(200);
    expect(logs.events('Access session')).toContainEqual(
      expect.objectContaining({ outcome: 'unavailable_pass', cause: row.cause, reason: row.reason }),
    );

    // No log line carries a registry body or a token.
    expect(logs.everything()).not.toContain(MARKER);
    expect(logs.everything()).not.toContain('tok-alice');
    expect(logs.everything()).not.toContain('tok-bob');
  });

  it('logs a deny reason that is not a plain label as unrecognised, never as the registry text', async () => {
    const logs = captureLogs();
    const h = await startHarness();
    h.registry.set(SUBJECT, { decision: 'deny', reason: `tok-alice ${MARKER}` });

    const refused = await attemptLogin(h, 'tok-alice');

    expect(refused.status).toBe(403);
    expect(logs.events('Access sign-in')).toContainEqual(expect.objectContaining({ outcome: 'deny', reason: 'unrecognised' }));
    expect(logs.everything()).not.toContain(MARKER);
    expect(logs.everything()).not.toContain('tok-alice');
  });
});
