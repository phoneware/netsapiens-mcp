import { describe, expect, it } from 'vitest';
import { createAccessEnforcer } from '../access/enforcer.js';
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
  it('is unavailable when the registry fails and nothing is cached', async () => {
    const registry = new FakeRegistry();
    registry.down = true;

    const view = await enforcerFor(registry, new FakeClock()).evaluate(identity());

    expect(view).toEqual({ kind: 'unavailable' });
  });

  it('serves the last known good decision inside the window, and is unavailable after it', async () => {
    const registry = new FakeRegistry();
    const clock = new FakeClock();
    const enforcer = enforcerFor(registry, clock, 600);
    registry.set(SUBJECT, { decision: 'allow', revision: 'rev-1', policy: policy() });
    expect((await enforcer.evaluate(identity())).kind).toBe('allow');

    registry.down = true;
    clock.advance(599_000);
    expect((await enforcer.evaluate(identity())).kind).toBe('allow');

    clock.advance(2_000);
    expect(await enforcer.evaluate(identity())).toEqual({ kind: 'unavailable' });
  });

  it('is unavailable, and does not throw, when the transport throws', async () => {
    const enforcer = createAccessEnforcer(registryConfig(), {
      fetchDecision: async () => {
        throw new Error('socket exploded');
      },
    });

    await expect(enforcer.evaluate(identity())).resolves.toEqual({ kind: 'unavailable' });
  });

  it('is unavailable when the policy cannot be enforced as written', async () => {
    const registry = new FakeRegistry();
    registry.set(SUBJECT, {
      decision: 'allow',
      revision: 'rev-bad',
      policy: policy({ tools: { allow: ['@curated'], deny: ['@no-such-group'] } }),
    });

    const view = await enforcerFor(registry, new FakeClock()).evaluate(identity());

    expect(view).toEqual({ kind: 'unavailable' });
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
