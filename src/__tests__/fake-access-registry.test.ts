/**
 * The fake access registry (scripts/fake-access-registry.mjs) is the test double for the e2e registry leg. These tests
 * hold it to wire contract v1, so a leg failure is never caused by the double answering something the contract forbids.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRegistryDecisionText } from '../access/contract.js';
import {
  allowDecision,
  denyDecision,
  fault,
  policy,
  startFakeAccessRegistry,
} from '../../scripts/fake-access-registry.mjs';

/** The surface of scripts/fake-access-registry.mjs that these tests use. */
interface FakeAccessRegistry {
  readonly origin: string;
  readonly url: string;
  readonly requests: ReadonlyArray<{
    readonly method: string;
    readonly path: string;
    readonly outcome?: string;
    readonly status?: number;
    readonly authorized?: boolean;
    readonly ifNoneMatch?: string | null;
    readonly connector?: string;
    readonly tenant?: string;
    readonly subject?: string;
    readonly role?: string;
    readonly tier?: string;
  }>;
  setDecision(tenant: string, subject: string, spec: unknown): void;
  clearDecision(tenant: string, subject: string): void;
  setFault(tenant: string, subject: string, spec: unknown | null): void;
  setLatency(ms: number): void;
  setBearer(token: string | null): void;
  close(): Promise<void>;
}

function decisionUrl(registry: FakeAccessRegistry, query: Record<string, string>): string {
  const params = new URLSearchParams({
    connector: 'netsapiens-mcp',
    platform: 'https://pbx.example.test',
    role: 'Office Manager',
    tier: 'domain_admin',
    ...query,
  });
  return `${registry.origin}/v1/decision?${params.toString()}`;
}

describe('fake access registry', () => {
  let registry: FakeAccessRegistry;

  beforeEach(async () => {
    registry = (await startFakeAccessRegistry()) as FakeAccessRegistry;
  });

  afterEach(async () => {
    await registry.close();
  });

  const ask = (query: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(decisionUrl(registry, query), { headers: { Accept: 'application/json', ...headers } });

  const alice = { tenant: 'example.com', subject: 'alice@example.com' };

  it('answers tenant_not_enrolled for a key with no decision, and the body is contract-valid', async () => {
    const res = await ask(alice);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"0"');
    const parsed = parseRegistryDecisionText(await res.text());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.decision).toMatchObject({ decision: 'deny', reason: 'tenant_not_enrolled', revision: '0' });
  });

  it('serves a per-subject allow with its policy, ETag and revision, and the body parses as an allow', async () => {
    registry.setDecision(alice.tenant, alice.subject, allowDecision({ revision: 'rev-7', policy: policy({ access: 'read' }) }));
    const res = await ask(alice);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"rev-7"');
    const parsed = parseRegistryDecisionText(await res.text());
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.decision.decision === 'allow') {
      expect(parsed.decision.policy.access).toBe('read');
      expect(parsed.decision.revision).toBe('rev-7');
    } else {
      throw new Error('expected an allow decision');
    }
  });

  it('lets a per-subject decision override the tenant default, and falls back to the default for other subjects', async () => {
    registry.setDecision(alice.tenant, '*', denyDecision({ reason: 'subject_not_enabled', revision: 'tenant-1' }));
    registry.setDecision(alice.tenant, alice.subject, allowDecision({ revision: 'alice-1' }));
    const allowed = await (await ask(alice)).text();
    expect(JSON.parse(allowed).decision).toBe('allow');
    const other = await (await ask({ tenant: 'example.com', subject: 'bob@example.com' })).text();
    expect(JSON.parse(other)).toMatchObject({ decision: 'deny', reason: 'subject_not_enabled', revision: 'tenant-1' });
  });

  it('answers 304 with the same ETag when If-None-Match names the current revision, and 200 when it names an old one', async () => {
    registry.setDecision(alice.tenant, alice.subject, allowDecision({ revision: 'rev-2' }));
    const current = await ask(alice, { 'If-None-Match': '"rev-2"' });
    expect(current.status).toBe(304);
    expect(current.headers.get('etag')).toBe('"rev-2"');
    expect(await current.text()).toBe('');
    const stale = await ask(alice, { 'If-None-Match': '"rev-1"' });
    expect(stale.status).toBe(200);
  });

  it('changes the ETag when the revision changes, so the old If-None-Match no longer confirms the answer', async () => {
    registry.setDecision(alice.tenant, alice.subject, allowDecision({ revision: 'rev-2' }));
    registry.setDecision(alice.tenant, alice.subject, denyDecision({ reason: 'subject_not_enabled', revision: 'rev-3' }));
    const res = await ask(alice, { 'If-None-Match': '"rev-2"' });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"rev-3"');
    expect(JSON.parse(await res.text())).toMatchObject({ decision: 'deny', revision: 'rev-3' });
  });

  it('refuses a missing or wrong bearer token with 401 when a bearer is required, and accepts the right one', async () => {
    registry.setBearer('right-token');
    expect((await ask(alice)).status).toBe(401);
    expect((await ask(alice, { Authorization: 'Bearer wrong-token' })).status).toBe(401);
    expect((await ask(alice, { Authorization: 'Bearer right-token' })).status).toBe(200);
    const outcomes = registry.requests.map((entry) => [entry.outcome, entry.authorized]);
    expect(outcomes).toEqual([
      ['unauthorized', false],
      ['unauthorized', false],
      ['deny', true],
    ]);
  });

  it('does not log the bearer token, even when the request presents it correctly', async () => {
    registry.setBearer('a-secret-token-value');
    await ask(alice, { Authorization: 'Bearer ' + 'a-secret-token-value' });
    expect(JSON.stringify(registry.requests)).not.toContain('a-secret-token-value');
  });

  it('refuses a request without a tier, with an unknown tier, or on a path other than the decision path', async () => {
    const withoutTier = `${registry.origin}/v1/decision?connector=netsapiens-mcp&platform=https%3A%2F%2Fpbx.example.test&tenant=example.com&subject=alice%40example.com&role=x`;
    expect((await fetch(withoutTier)).status).toBe(400);
    expect((await ask({ ...alice, tier: 'superuser' })).status).toBe(400);
    expect((await fetch(`${registry.origin}/v2/decision`)).status).toBe(404);
    expect((await fetch(decisionUrl(registry, alice), { method: 'POST' })).status).toBe(405);
  });

  it('adds latency before answering when latency is set', async () => {
    // The latency is real delay by design: the fake holds the socket for the configured time, and fake timers cannot
    // reach the server's socket. The assertion is a lower bound, so it cannot pass by being fast.
    registry.setLatency(150);
    const started = Date.now();
    expect((await ask(alice)).status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it('answers a status fault with that status and no decision', async () => {
    registry.setFault(alice.tenant, alice.subject, fault('status', { status: 503 }));
    const res = await ask(alice);
    expect(res.status).toBe(503);
    expect(JSON.parse(await res.text())).toEqual({ error: 'fault' });
  });

  it('answers a garbage fault with a 200 body that is not JSON, which the parser refuses as invalid_json', async () => {
    registry.setFault(alice.tenant, alice.subject, fault('garbage'));
    const res = await ask(alice);
    expect(res.status).toBe(200);
    const parsed = parseRegistryDecisionText(await res.text());
    expect(parsed).toMatchObject({ ok: false, errorClass: 'invalid_json' });
  });

  it('answers a double-encoded fault whose JSON is a string, which the parser refuses as contract', async () => {
    registry.setFault(alice.tenant, alice.subject, fault('double', { base: allowDecision().body }));
    const parsed = parseRegistryDecisionText(await (await ask(alice)).text());
    expect(parsed).toMatchObject({ ok: false, errorClass: 'contract' });
  });

  it('answers a critical fault with a member the parser refuses as critical', async () => {
    registry.setFault(alice.tenant, alice.subject, fault('critical'));
    const parsed = parseRegistryDecisionText(await (await ask(alice)).text());
    expect(parsed).toMatchObject({ ok: false, errorClass: 'critical' });
  });

  it('answers an oversize fault with a body over 64 KiB and a matching Content-Length', async () => {
    registry.setFault(alice.tenant, alice.subject, fault('oversize'));
    const res = await ask(alice);
    const body = await res.text();
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(64 * 1024);
    expect(Number(res.headers.get('content-length'))).toBe(Buffer.byteLength(body, 'utf8'));
  });

  it('answers a redirect fault with a 302 and the location it was given, which the client never follows', async () => {
    registry.setFault(alice.tenant, alice.subject, fault('redirect', { location: 'https://elsewhere.example.test/x' }));
    const res = await fetch(decisionUrl(registry, alice), { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://elsewhere.example.test/x');
  });

  it('answers a hang fault with no response, so only the client gives up', async () => {
    registry.setFault(alice.tenant, alice.subject, fault('hang'));
    const controller = new AbortController();
    const pendingRequest = fetch(decisionUrl(registry, alice), { signal: controller.signal });
    // Wait for the server to record the hang, then abort the client: the condition is awaited, not guessed.
    await vi.waitFor(() => expect(registry.requests.some((entry) => entry.outcome === 'fault:hang')).toBe(true));
    controller.abort();
    await expect(pendingRequest).rejects.toThrow();
  });

  it('gives a fault precedence over a decision, and restores the decision when the fault is cleared', async () => {
    registry.setDecision(alice.tenant, alice.subject, allowDecision());
    registry.setFault(alice.tenant, alice.subject, fault('status', { status: 500 }));
    expect((await ask(alice)).status).toBe(500);
    registry.setFault(alice.tenant, alice.subject, null);
    expect(JSON.parse(await (await ask(alice)).text()).decision).toBe('allow');
  });

  it('logs every request with its key fields, its If-None-Match and its outcome', async () => {
    registry.setDecision(alice.tenant, alice.subject, allowDecision({ revision: 'rev-9' }));
    await ask(alice, { 'If-None-Match': '"rev-9"' });
    const entry = registry.requests.at(-1);
    expect(entry).toMatchObject({
      method: 'GET',
      path: '/v1/decision',
      connector: 'netsapiens-mcp',
      tenant: 'example.com',
      subject: 'alice@example.com',
      role: 'Office Manager',
      tier: 'domain_admin',
      ifNoneMatch: '"rev-9"',
      outcome: 'not_modified',
      status: 304,
    });
  });

  it('merges a policy override member by member, so a test names only what it changes', () => {
    const merged = policy({ tools: { deny: ['find_user'] }, content: { transcript: 'deny' } });
    expect(merged.tools).toEqual({ allow: ['*'], deny: ['find_user'] });
    expect(merged.content.transcript).toBe('deny');
    expect(merged.content.call_recording).toBe('allow');
    expect(merged.access).toBe('write');
  });

  it('allowAll answers allow for every key that has no fault, and a fault still wins over it', async () => {
    const open = (await startFakeAccessRegistry({ allowAll: true })) as FakeAccessRegistry;
    try {
      open.setDecision(alice.tenant, alice.subject, denyDecision({ reason: 'subject_not_enabled' }));
      const allowed = await fetch(decisionUrl(open, alice), { headers: { Accept: 'application/json' } });
      expect(allowed.status).toBe(200);
      const parsed = parseRegistryDecisionText(await allowed.text());
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.decision).toMatchObject({ decision: 'allow', revision: 'rev-1' });
      open.setFault(alice.tenant, alice.subject, fault('status', { status: 503 }));
      const faulted = await fetch(decisionUrl(open, alice), { headers: { Accept: 'application/json' } });
      expect(faulted.status).toBe(503);
    } finally {
      await open.close();
    }
  });
});
