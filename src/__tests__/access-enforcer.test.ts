import { describe, expect, it } from 'vitest';
import { createAccessEnforcer, type AccessUnavailableCause } from '../access/enforcer.js';
import type { RegistryResponse, RegistryResult } from '../access/registry-client.js';
import {
  FakeClock,
  FakeRegistry,
  OTHER_REDIRECT,
  PLATFORM,
  REDIRECT,
  SUBJECT,
  TENANT,
  identity,
  policy,
  registryConfig,
  wireDecision,
} from './support/access-registry-fake.js';

function enforcerFor(registry: FakeRegistry, clock: FakeClock, maxStaleSeconds = 600) {
  return createAccessEnforcer(registryConfig(maxStaleSeconds), {
    fetchDecision: registry.fetchDecision,
    now: clock.monotonic,
    wallNow: clock.wall,
  });
}

describe('createAccessEnforcer: decisions', () => {
  it('turns an allow into a compiled policy for the revision the registry sent', async () => {
    const registry = new FakeRegistry();
    const clock = new FakeClock();
    registry.set(SUBJECT, { decision: 'allow', revision: 'rev-1', policy: policy() });

    const view = await enforcerFor(registry, clock).evaluate(identity());

    expect(view.kind).toBe('allow');
    if (view.kind !== 'allow') throw new Error('unreachable');
    expect(view.policy.revision).toBe('rev-1');
    expect(view.policy.access).toBe('read');
    expect(view.policy.allowsRedirect(REDIRECT)).toBe(true);
    expect(view.policy.allowsRedirect(OTHER_REDIRECT)).toBe(false);
  });

  it('turns a deny into a deny that carries the registry reason', async () => {
    const registry = new FakeRegistry();
    registry.set(SUBJECT, { decision: 'deny', reason: 'subject_not_enabled' });

    const view = await enforcerFor(registry, new FakeClock()).evaluate(identity());

    expect(view).toEqual({ kind: 'deny', reason: 'subject_not_enabled' });
  });

  it('keeps an unknown deny reason as a deny', async () => {
    const registry = new FakeRegistry();
    registry.set(SUBJECT, { decision: 'deny', reason: 'something_new' });

    const view = await enforcerFor(registry, new FakeClock()).evaluate(identity());

    expect(view).toEqual({ kind: 'deny', reason: 'something_new' });
  });

  it('asks the registry about the identity, and about a named foreign tenant with the home subject', async () => {
    const registry = new FakeRegistry();
    const enforcer = enforcerFor(registry, new FakeClock());

    await enforcer.evaluate(identity());
    await enforcer.evaluate(identity(), { foreignTenant: 'other.example.com' });

    expect(registry.seen[0]).toEqual({
      connector: 'netsapiens-mcp',
      platform: PLATFORM,
      tenant: TENANT,
      subject: SUBJECT,
      role: 'Office Manager',
      tier: 'domain_admin',
    });
    expect(registry.seen[1]).toMatchObject({ tenant: 'other.example.com', subject: SUBJECT });
  });
});

describe('createAccessEnforcer: fail closed', () => {
  it('is unavailable with the network cause when the registry fails and nothing is cached', async () => {
    const registry = new FakeRegistry();
    registry.response = { kind: 'failure', errorClass: 'network' };

    const view = await enforcerFor(registry, new FakeClock()).evaluate(identity());

    expect(view).toEqual({ kind: 'unavailable', cause: 'network' });
  });

  it('serves the last known good decision inside the window, and is unavailable after it', async () => {
    const registry = new FakeRegistry();
    const clock = new FakeClock();
    const enforcer = enforcerFor(registry, clock, 600);
    registry.set(SUBJECT, { decision: 'allow', revision: 'rev-1', policy: policy() });
    expect((await enforcer.evaluate(identity())).kind).toBe('allow');

    registry.response = { kind: 'failure', errorClass: 'network' };
    clock.advance(599_000);
    expect((await enforcer.evaluate(identity())).kind).toBe('allow');

    clock.advance(2_000);
    expect(await enforcer.evaluate(identity())).toEqual({ kind: 'unavailable', cause: 'network' });
  });

  it('is unavailable with the network cause, and does not throw, when the transport throws', async () => {
    const enforcer = createAccessEnforcer(registryConfig(), {
      fetchDecision: async () => {
        throw new Error('socket exploded');
      },
    });

    await expect(enforcer.evaluate(identity())).resolves.toEqual({ kind: 'unavailable', cause: 'network' });
  });

  it('is unavailable with the policy_invalid cause when the policy cannot be enforced as written', async () => {
    const registry = new FakeRegistry();
    registry.set(SUBJECT, {
      decision: 'allow',
      revision: 'rev-bad',
      policy: policy({ tools: { allow: ['@curated'], deny: ['@no-such-group'] } }),
    });

    const view = await enforcerFor(registry, new FakeClock()).evaluate(identity());

    expect(view).toEqual({ kind: 'unavailable', cause: 'policy_invalid' });
  });
});

/** Each way the registry can answer something other than a usable decision, with the cause the view must carry. */
const CAUSES: ReadonlyArray<{ readonly name: string; readonly response: RegistryResponse; readonly cause: AccessUnavailableCause }> = [
  { name: 'a timeout', response: { kind: 'failure', errorClass: 'timeout' }, cause: 'timeout' },
  { name: 'a network failure', response: { kind: 'failure', errorClass: 'network' }, cause: 'network' },
  { name: 'an HTTP 404', response: { kind: 'failure', errorClass: 'http_status', httpStatus: 404 }, cause: 'http_status' },
  { name: 'an HTTP 401', response: { kind: 'failure', errorClass: 'auth', httpStatus: 401 }, cause: 'auth' },
  { name: 'a body that is not JSON', response: { kind: 'text', body: 'not json' }, cause: 'contract' },
  {
    name: 'a decision of another wire version',
    response: { kind: 'text', body: JSON.stringify({ version: 2, decision: 'deny', reason: 'x', revision: '0', ttlSeconds: 60 }) },
    cause: 'contract',
  },
  {
    name: 'a deny with ttlSeconds 0',
    response: {
      kind: 'text',
      body: JSON.stringify({ version: 1, decision: 'deny', reason: 'subject_not_enabled', revision: '0', ttlSeconds: 0 }),
    },
    cause: 'contract',
  },
  { name: 'a body over 64 KiB', response: { kind: 'text', body: 'x'.repeat(64 * 1024 + 1) }, cause: 'contract' },
  {
    name: 'a deny with a critical member',
    response: {
      kind: 'text',
      body: JSON.stringify({ version: 1, decision: 'deny', reason: 'subject_not_enabled', revision: '0', ttlSeconds: 60, critical: ['new-rule'] }),
    },
    cause: 'critical',
  },
  {
    name: 'an allow whose policy names an unknown group',
    response: {
      kind: 'text',
      body: JSON.stringify(
        wireDecision({ decision: 'allow', revision: 'rev-bad', policy: policy({ tools: { allow: ['@curated'], deny: ['@no-such-group'] } }) }),
      ),
    },
    cause: 'policy_invalid',
  },
];

describe('createAccessEnforcer: causes', () => {
  it.each(CAUSES)('reports $cause for $name', async ({ response, cause }) => {
    const registry = new FakeRegistry();
    registry.response = response;

    const view = await enforcerFor(registry, new FakeClock()).evaluate(identity());

    expect(view).toEqual({ kind: 'unavailable', cause });
  });

  it('reports outage when the client reports unavailable without a class', async () => {
    const client = { decide: async (): Promise<RegistryResult> => ({ source: 'unavailable' }) };
    const enforcer = createAccessEnforcer(registryConfig(), { client });

    expect(await enforcer.evaluate(identity())).toEqual({ kind: 'unavailable', cause: 'outage' });
  });

  it('reports outage, and does not throw, when the client call itself throws', async () => {
    const client = {
      decide: async (): Promise<RegistryResult> => {
        throw new Error('client broke');
      },
    };
    const enforcer = createAccessEnforcer(registryConfig(), { client });

    await expect(enforcer.evaluate(identity())).resolves.toEqual({ kind: 'unavailable', cause: 'outage' });
  });

  it('reports no cause on an allow or a deny', async () => {
    const registry = new FakeRegistry();
    registry.set(SUBJECT, { decision: 'deny', reason: 'subject_not_enabled' });

    const view = await enforcerFor(registry, new FakeClock()).evaluate(identity());

    expect(view).not.toHaveProperty('cause');
  });
});

describe('createAccessEnforcer: compiled policies', () => {
  it('compiles a revision once, so the same decision returns the same compiled policy', async () => {
    const registry = new FakeRegistry();
    registry.set(SUBJECT, { decision: 'allow', revision: 'rev-1', policy: policy() });
    const enforcer = enforcerFor(registry, new FakeClock());

    const first = await enforcer.evaluate(identity());
    const second = await enforcer.evaluate(identity());

    expect(first.kind).toBe('allow');
    if (first.kind !== 'allow' || second.kind !== 'allow') throw new Error('unreachable');
    expect(second.policy).toBe(first.policy);
  });

  it('compiles again when a revision comes back with content it did not have before', async () => {
    const registry = new FakeRegistry();
    registry.set('alice@domain.com', { decision: 'allow', revision: 'same', policy: policy({ platforms: [REDIRECT] }) });
    registry.set('bob@domain.com', { decision: 'allow', revision: 'same', policy: policy({ platforms: [OTHER_REDIRECT] }) });
    const enforcer = enforcerFor(registry, new FakeClock());

    const alice = await enforcer.evaluate(identity('alice'));
    const bob = await enforcer.evaluate(identity('bob'));
    const aliceAgain = await enforcer.evaluate(identity('alice'));

    if (alice.kind !== 'allow' || bob.kind !== 'allow' || aliceAgain.kind !== 'allow') throw new Error('unreachable');
    expect(bob.policy.allowsRedirect(OTHER_REDIRECT)).toBe(true);
    expect(bob.policy.allowsRedirect(REDIRECT)).toBe(false);
    expect(aliceAgain.policy.allowsRedirect(REDIRECT)).toBe(true);
    expect(aliceAgain.policy.allowsRedirect(OTHER_REDIRECT)).toBe(false);
  });
});

describe('createAccessEnforcer: identityFromAuthInfo', () => {
  const enforcer = createAccessEnforcer(registryConfig(), { fetchDecision: async () => ({ kind: 'not_modified' }) });
  const complete = {
    nsDomain: ' Domain.COM ',
    nsUser: 'Alice',
    nsScope: 'Office Manager',
    nsApiUrl: 'https://Fake.example.com/some/path',
  };

  it('reads the reserved keys into the same identity sign-in keys on', () => {
    expect(enforcer.identityFromAuthInfo(complete)).toEqual({
      platform: 'https://fake.example.com',
      tenant: 'domain.com',
      user: 'alice',
      subject: 'alice@domain.com',
      role: 'Office Manager',
      tier: 'domain_admin',
    });
  });

  it('accepts an empty scope as an unknown role, which is the least privileged tier', () => {
    expect(enforcer.identityFromAuthInfo({ ...complete, nsScope: '' })).toMatchObject({ role: '', tier: 'user' });
  });

  it('is undefined when the auth info carries no identity at all', () => {
    expect(enforcer.identityFromAuthInfo(undefined)).toBeUndefined();
    expect(enforcer.identityFromAuthInfo({})).toBeUndefined();
  });

  it('is undefined when any reserved key is missing or not a string', () => {
    for (const key of ['nsDomain', 'nsUser', 'nsScope', 'nsApiUrl'] as const) {
      const { [key]: _omitted, ...rest } = complete;
      expect(enforcer.identityFromAuthInfo(rest), `missing ${key}`).toBeUndefined();
      expect(enforcer.identityFromAuthInfo({ ...complete, [key]: 42 }), `numeric ${key}`).toBeUndefined();
    }
  });

  it('is undefined when a name cannot be keyed without changing it', () => {
    expect(enforcer.identityFromAuthInfo({ ...complete, nsUser: 'al@ice' })).toBeUndefined();
    expect(enforcer.identityFromAuthInfo({ ...complete, nsUser: 'ālice' })).toBeUndefined();
    expect(enforcer.identityFromAuthInfo({ ...complete, nsDomain: 'bad domain.com' })).toBeUndefined();
    expect(enforcer.identityFromAuthInfo({ ...complete, nsDomain: '   ' })).toBeUndefined();
  });

  it('is undefined when the platform is not an http origin', () => {
    expect(enforcer.identityFromAuthInfo({ ...complete, nsApiUrl: 'ftp://fake.example.com' })).toBeUndefined();
    expect(enforcer.identityFromAuthInfo({ ...complete, nsApiUrl: 'not a url' })).toBeUndefined();
  });
});
