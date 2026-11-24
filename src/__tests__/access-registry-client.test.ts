import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessRegistryAuthConfig, EnabledAccessRegistryConfig } from '../access/config.js';
import {
  createAccessRegistryClient,
  createHttpFetchDecision,
  RegistryClient,
  type FetchLike,
  type RegistryQuery,
} from '../access/registry-client.js';
import { logger } from '../utils/logger.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/access/', import.meta.url));
const BASE = 'https://registry.example.com';
const DECISION_PREFIX = `${BASE}/v1/decision?`;
const METADATA = 'http://metadata.test/computeMetadata/v1/instance/service-accounts/default/identity';
const TOKEN = 'static-token-7f3a9c';
const CONNECTOR = 'netsapiens-mcp';
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const START = 1_700_000_000_000;
const GOOGLE: AccessRegistryAuthConfig = { mode: 'google-id-token', audience: `${BASE}/` };

const QUERY: RegistryQuery = {
  platform: 'https://pbx.example.com',
  tenant: 'example.com',
  subject: '1001@example.com',
  role: 'Office Manager',
  tier: 'domain_admin',
};

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${FIXTURES}${name}`, 'utf8')) as Record<string, unknown>;
}

/** The allow fixture with some members replaced. Its ttlSeconds is 60. */
function allowBody(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...fixture('allow.json'), ...patch };
}

/** The deny fixture with some members replaced. Its ttlSeconds is 60. */
function denyBody(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...fixture('deny.json'), ...patch };
}

function json(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
}

function notModified(): Response {
  return new Response(null, { status: 304 });
}

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** An unsigned token in the shape the metadata service returns, expiring at the given Unix second. */
function identityToken(expSeconds: number): string {
  return `${encodeSegment({ alg: 'RS256' })}.${encodeSegment({ aud: `${BASE}/`, exp: expSeconds })}.c2ln`;
}

function identityTokenWithoutExp(): string {
  return `${encodeSegment({ alg: 'RS256' })}.${encodeSegment({ aud: `${BASE}/` })}.c2ln`;
}

interface Sent {
  readonly raw: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly redirect: unknown;
  readonly signal: AbortSignal;
}

/** One fake network that serves the decision endpoint and the metadata service. Each test sets `respond`. */
class FakeNetwork {
  readonly sent: Sent[] = [];
  respond: (sent: Sent) => Promise<Response> | Response = () => json(200, allowBody());

  readonly fetch: FetchLike = async (raw, init) => {
    const sent: Sent = {
      raw,
      url: new URL(raw),
      headers: { ...(init.headers as Record<string, string>) },
      redirect: init.redirect,
      signal: init.signal as AbortSignal,
    };
    this.sent.push(sent);
    return this.respond(sent);
  };

  decisions(): Sent[] {
    return this.sent.filter((sent) => sent.raw.startsWith(DECISION_PREFIX));
  }

  metadataRequests(): Sent[] {
    return this.sent.filter((sent) => sent.raw.startsWith(METADATA));
  }
}

interface SetupOptions {
  readonly auth?: AccessRegistryAuthConfig;
  readonly timeoutMs?: number;
  readonly maxStaleMs?: number;
  readonly maxEntries?: number;
}

function setup(options: SetupOptions = {}) {
  const clock = { now: START };
  const network = new FakeNetwork();
  const now = () => clock.now;
  const fetchDecision = createHttpFetchDecision({
    baseUrl: BASE,
    auth: options.auth ?? { mode: 'bearer', token: TOKEN },
    fetch: network.fetch,
    metadataUrl: METADATA,
    now,
    timeoutMs: options.timeoutMs,
  });
  const client = new RegistryClient({
    connector: CONNECTOR,
    fetchDecision,
    now,
    timeoutMs: options.timeoutMs,
    maxStaleMs: options.maxStaleMs,
    maxEntries: options.maxEntries,
  });
  return { client, network, clock };
}

/** Holds a fake response until the test opens the gate. */
function gate() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { opened: promise, open: resolve };
}

/** Lets every pending microtask run before the test continues. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface ErrorScenario {
  readonly name: string;
  readonly errorClass: string;
  readonly timeoutMs?: number;
  readonly respond: (sent: Sent) => Promise<Response> | Response;
}

const ERROR_SCENARIOS: readonly ErrorScenario[] = [
  { name: '404', errorClass: 'http_status', respond: () => json(404, 'no such tenant') },
  { name: '401', errorClass: 'auth', respond: () => json(401, 'unauthenticated') },
  { name: '403', errorClass: 'auth', respond: () => json(403, 'forbidden') },
  { name: '500', errorClass: 'http_status', respond: () => json(500, 'boom') },
  {
    name: 'a redirect',
    errorClass: 'http_status',
    respond: () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.com/' } }),
  },
  {
    name: 'a timeout',
    errorClass: 'timeout',
    timeoutMs: 25,
    respond: (sent) =>
      new Promise<Response>((_resolve, reject) => {
        sent.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  },
  { name: 'a network failure', errorClass: 'network', respond: () => Promise.reject(new TypeError('fetch failed')) },
  { name: 'a body that is not JSON', errorClass: 'invalid_json', respond: () => json(200, 'not json {') },
  { name: 'a body that breaks the contract', errorClass: 'contract', respond: () => json(200, allowBody({ version: 2 })) },
  { name: 'a critical member', errorClass: 'critical', respond: () => json(200, allowBody({ critical: ['policy.v2'] })) },
  { name: 'an oversize body', errorClass: 'oversize', respond: () => json(200, { padding: 'x'.repeat(64 * 1024) }) },
];

/** The logs these tests do not assert on are silenced. The logging tests capture them. */
beforeEach(() => {
  vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('registry client: fresh, stale and revalidated answers', () => {
  it('asks the registry once, then answers from the cache while the answer is fresh', async () => {
    const { client, network, clock } = setup();
    network.respond = () => json(200, allowBody());
    const first = await client.decide(QUERY);
    expect(first.source).toBe('fresh');
    expect(first.decision).toEqual(allowBody());
    clock.now += MINUTE - SECOND;
    expect(await client.decide(QUERY)).toMatchObject({ source: 'fresh', decision: { decision: 'allow' } });
    expect(network.decisions()).toHaveLength(1);
  });

  it('revalidates a stale answer with If-None-Match and takes a new 200', async () => {
    const { client, network, clock } = setup();
    network.respond = () => json(200, allowBody({ revision: 'rev-1' }));
    await client.decide(QUERY);
    clock.now += MINUTE + SECOND;
    network.respond = () => json(200, denyBody({ revision: 'rev-2', reason: 'subject_not_enabled' }));
    expect(await client.decide(QUERY)).toMatchObject({
      source: 'revalidated',
      decision: { decision: 'deny', reason: 'subject_not_enabled' },
    });
    expect(network.decisions()[1].headers['If-None-Match']).toBe('"rev-1"');
  });

  it('revalidates a stale answer with a 304, keeps the cached decision, and validates it from that moment', async () => {
    const { client, network, clock } = setup();
    network.respond = () => json(200, allowBody({ revision: 'rev-1' }));
    await client.decide(QUERY);
    clock.now += MINUTE + SECOND;
    network.respond = () => notModified();
    const revalidated = await client.decide(QUERY);
    expect(revalidated.source).toBe('revalidated');
    expect(revalidated.decision).toEqual(allowBody({ revision: 'rev-1' }));
    expect(network.decisions()[1].headers['If-None-Match']).toBe('"rev-1"');
    clock.now += MINUTE - SECOND;
    expect((await client.decide(QUERY)).source).toBe('fresh');
    expect(network.decisions()).toHaveLength(2);
  });

  it.each([
    [1, 5],
    [1000, 300],
  ])('clamps ttlSeconds %i to %i seconds of freshness', async (ttlSeconds, freshSeconds) => {
    const { client, network, clock } = setup();
    network.respond = () => json(200, allowBody({ ttlSeconds }));
    await client.decide(QUERY);
    clock.now += freshSeconds * SECOND - 1;
    expect((await client.decide(QUERY)).source).toBe('fresh');
    expect(network.decisions()).toHaveLength(1);
    clock.now += 1;
    network.respond = () => notModified();
    expect((await client.decide(QUERY)).source).toBe('revalidated');
    expect(network.decisions()).toHaveLength(2);
  });

  it('caches deny decisions like allows', async () => {
    const { client, network } = setup();
    network.respond = () => json(200, denyBody({ reason: 'tenant_not_enrolled' }));
    expect(await client.decide(QUERY)).toMatchObject({ source: 'fresh', decision: { decision: 'deny' } });
    expect(await client.decide(QUERY)).toMatchObject({ source: 'fresh', decision: { decision: 'deny' } });
    expect(network.decisions()).toHaveLength(1);
  });

  it('keeps a deny last known good like an allow', async () => {
    const { client, network, clock } = setup();
    network.respond = () => json(200, denyBody({ reason: 'subject_not_enabled' }));
    await client.decide(QUERY);
    clock.now += MINUTE + SECOND;
    network.respond = () => json(503, 'busy');
    expect(await client.decide(QUERY)).toMatchObject({
      source: 'lkg',
      errorClass: 'http_status',
      decision: { decision: 'deny', reason: 'subject_not_enabled' },
    });
  });

  it('serves last known good inside the window, unavailable at its end, and recovers on the next success', async () => {
    const { client, network, clock } = setup({ maxStaleMs: 600_000 });
    network.respond = () => json(200, allowBody());
    await client.decide(QUERY);
    clock.now = START + 100 * SECOND;
    network.respond = () => json(500, 'boom');
    expect(await client.decide(QUERY)).toEqual({
      source: 'lkg',
      decision: allowBody(),
      errorClass: 'http_status',
    });
    clock.now = START + 600 * SECOND;
    expect(await client.decide(QUERY)).toEqual({ source: 'unavailable', errorClass: 'http_status' });
    network.respond = () => json(200, allowBody());
    expect((await client.decide(QUERY)).source).toBe('fresh');
  });

  it('takes the last-known-good window from the configuration, and a zero window serves nothing stale', async () => {
    const config: EnabledAccessRegistryConfig = {
      enabled: true,
      baseUrl: BASE,
      auth: { mode: 'bearer', token: TOKEN },
      connector: CONNECTOR,
      maxStaleSeconds: 0,
      timeoutMs: 3000,
    };
    const network = new FakeNetwork();
    network.respond = () => json(200, allowBody());
    let now = START;
    const client = createAccessRegistryClient(config, { fetch: network.fetch, now: () => now });
    await client.decide(QUERY);
    now += MINUTE + SECOND;
    network.respond = () => json(500, 'boom');
    expect(await client.decide(QUERY)).toEqual({ source: 'unavailable', errorClass: 'http_status' });
  });
});

describe('registry client: errors are never read as not enrolled', () => {
  it.each(ERROR_SCENARIOS)('$name with no cached answer is unavailable at once', async (scenario) => {
    const { client, network } = setup({ timeoutMs: scenario.timeoutMs });
    network.respond = scenario.respond;
    const result = await client.decide(QUERY);
    expect(result).toEqual({ source: 'unavailable', errorClass: scenario.errorClass });
    expect(result.decision).toBeUndefined();
    expect(network.decisions()).toHaveLength(1);
  });

  it.each(ERROR_SCENARIOS)('$name serves the last known good answer inside the window', async (scenario) => {
    const { client, network, clock } = setup({ timeoutMs: scenario.timeoutMs });
    network.respond = () => json(200, allowBody());
    await client.decide(QUERY);
    clock.now += MINUTE + SECOND;
    network.respond = scenario.respond;
    expect(await client.decide(QUERY)).toMatchObject({
      source: 'lkg',
      errorClass: scenario.errorClass,
      decision: { decision: 'allow' },
    });
  });

  it('treats a 304 that matches no If-None-Match it sent as an error', async () => {
    const { client, network } = setup();
    network.respond = () => notModified();
    expect(await client.decide(QUERY)).toEqual({ source: 'unavailable', errorClass: 'http_status' });
    expect(network.decisions()[0].headers['If-None-Match']).toBeUndefined();
  });

  it('never follows a redirect, so the bearer token goes only to the configured registry', async () => {
    const { client, network } = setup();
    network.respond = () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.com/' } });
    await client.decide(QUERY);
    expect(network.decisions()[0].redirect).toBe('manual');
    expect(network.sent.some((sent) => sent.raw.startsWith('https://elsewhere.example.com'))).toBe(false);
  });

  it('maps 401 and 403 to auth and every other failing status to http_status', async () => {
    const { client, network } = setup();
    network.respond = () => json(403, 'forbidden');
    expect(await client.decide(QUERY)).toEqual({ source: 'unavailable', errorClass: 'auth' });
    network.respond = () => json(404, 'missing');
    expect(await client.decide(QUERY)).toEqual({ source: 'unavailable', errorClass: 'http_status' });
  });

  it('refuses an oversize body that declares its length, without reading it', async () => {
    const { client, network } = setup();
    network.respond = () => new Response('{}', { status: 200, headers: { 'content-length': '70000' } });
    expect(await client.decide(QUERY)).toEqual({ source: 'unavailable', errorClass: 'oversize' });
  });
});

describe('registry client: single flight', () => {
  it('sends one request for concurrent callers on a cold key', async () => {
    const { client, network } = setup();
    const release = gate();
    network.respond = async () => {
      await release.opened;
      return json(200, allowBody());
    };
    const callers = Array.from({ length: 10 }, () => client.decide(QUERY));
    await nextTurn();
    release.open();
    const results = await Promise.all(callers);
    expect(network.decisions()).toHaveLength(1);
    expect(results.map((result) => result.source)).toEqual(Array.from({ length: 10 }, () => 'fresh'));
  });

  it('sends one revalidation for concurrent callers on a stale key', async () => {
    const { client, network, clock } = setup();
    network.respond = () => json(200, allowBody());
    await client.decide(QUERY);
    clock.now += MINUTE + SECOND;
    const release = gate();
    network.respond = async () => {
      await release.opened;
      return notModified();
    };
    const callers = Array.from({ length: 10 }, () => client.decide(QUERY));
    await nextTurn();
    release.open();
    const results = await Promise.all(callers);
    expect(network.decisions()).toHaveLength(2);
    expect(results.every((result) => result.source === 'revalidated' && result.decision?.decision === 'allow')).toBe(true);
  });

  it('evicts the least recently used answer at the cap', async () => {
    const { client, network } = setup({ maxEntries: 2 });
    network.respond = () => json(200, allowBody());
    const forSubject = (subject: string): RegistryQuery => ({ ...QUERY, subject });
    await client.decide(forSubject('a@example.com'));
    await client.decide(forSubject('b@example.com'));
    await client.decide(forSubject('c@example.com'));
    expect(client.cacheSize).toBe(2);
    expect(network.decisions()).toHaveLength(3);
    expect((await client.decide(forSubject('c@example.com'))).source).toBe('fresh');
    expect(network.decisions()).toHaveLength(3);
    expect((await client.decide(forSubject('a@example.com'))).source).toBe('fresh');
    expect(network.decisions()).toHaveLength(4);
    expect(client.cacheSize).toBe(2);
  });
});

describe('registry client: requests and credentials', () => {
  it('sends the bearer token and the percent-encoded query to the decision endpoint', async () => {
    const { client, network } = setup();
    network.respond = () => json(200, allowBody());
    await client.decide(QUERY);
    const [sent] = network.decisions();
    expect(sent.raw).toBe(
      `${DECISION_PREFIX}connector=netsapiens-mcp&platform=https%3A%2F%2Fpbx.example.com&tenant=example.com&subject=1001%40example.com&role=Office%20Manager&tier=domain_admin`,
    );
    expect(sent.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent.headers.Accept).toBe('application/json');
    expect(sent.headers['If-None-Match']).toBeUndefined();
    expect(sent.redirect).toBe('manual');
  });

  it('sends an empty role as an empty value', async () => {
    const { client, network } = setup();
    network.respond = () => json(200, allowBody());
    await client.decide({ ...QUERY, role: '' });
    expect(network.decisions()[0].url.searchParams.get('role')).toBe('');
  });

  it('sends no Authorization header in auth none mode', async () => {
    const network = new FakeNetwork();
    network.respond = () => json(200, allowBody());
    const client = createAccessRegistryClient(
      {
        enabled: true,
        baseUrl: 'http://127.0.0.1:9000',
        auth: { mode: 'none' },
        connector: CONNECTOR,
        maxStaleSeconds: 600,
        timeoutMs: 3000,
      },
      { fetch: network.fetch, now: () => START },
    );
    await client.decide(QUERY);
    expect(network.sent[0].raw.startsWith('http://127.0.0.1:9000/v1/decision?')).toBe(true);
    expect(network.sent[0].headers).not.toHaveProperty('Authorization');
  });

  it('mints the identity token once, reuses it until 300 seconds before expiry, then refreshes it', async () => {
    const { client, network, clock } = setup({ auth: GOOGLE });
    const expSeconds = START / 1000 + 3600;
    const token = identityToken(expSeconds);
    network.respond = (sent) => (sent.raw.startsWith(METADATA) ? new Response(token, { status: 200 }) : json(200, allowBody()));
    for (const subject of ['a@example.com', 'b@example.com', 'c@example.com']) {
      await client.decide({ ...QUERY, subject });
    }
    expect(network.metadataRequests()).toHaveLength(1);
    const [metadata] = network.metadataRequests();
    expect(metadata.headers['Metadata-Flavor']).toBe('Google');
    expect(metadata.raw).toBe(`${METADATA}?audience=${encodeURIComponent(`${BASE}/`)}&format=full`);
    for (const sent of network.decisions()) expect(sent.headers.Authorization).toBe(`Bearer ${token}`);

    clock.now = expSeconds * 1000 - 300_000 - SECOND;
    await client.decide({ ...QUERY, subject: 'd@example.com' });
    expect(network.metadataRequests()).toHaveLength(1);

    clock.now = expSeconds * 1000 - 300_000;
    await client.decide({ ...QUERY, subject: 'e@example.com' });
    expect(network.metadataRequests()).toHaveLength(2);
  });

  it('shares one identity token mint between concurrent callers', async () => {
    const { client, network, clock } = setup({ auth: GOOGLE });
    const token = identityToken(clock.now / 1000 + 3600);
    const release = gate();
    network.respond = async (sent) => {
      if (!sent.raw.startsWith(METADATA)) return json(200, allowBody());
      await release.opened;
      return new Response(token, { status: 200 });
    };
    const callers = ['a', 'b', 'c'].map((name) => client.decide({ ...QUERY, subject: `${name}@example.com` }));
    await nextTurn();
    release.open();
    await Promise.all(callers);
    expect(network.metadataRequests()).toHaveLength(1);
    expect(network.decisions()).toHaveLength(3);
  });

  it.each([
    ['answers 500', () => json(500, 'metadata unavailable')],
    ['answers with something that is not a token', () => new Response('<html>', { status: 200 })],
    ['answers with a token that has no exp claim', () => new Response(identityTokenWithoutExp(), { status: 200 })],
    ['cannot be reached', () => Promise.reject(new TypeError('fetch failed'))],
  ])('maps a metadata request that %s to auth, and sends nothing to the registry', async (_description, metadata) => {
    const { client, network } = setup({ auth: GOOGLE });
    network.respond = (sent) => (sent.raw.startsWith(METADATA) ? metadata() : json(200, allowBody()));
    expect(await client.decide(QUERY)).toEqual({ source: 'unavailable', errorClass: 'auth' });
    expect(network.decisions()).toHaveLength(0);
  });
});

describe('registry client: logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Captures every logger call at every level, whatever level the process is configured for. */
  function captureLogs() {
    const entries: Array<{ level: string; message: string; context: Record<string, unknown> | undefined }> = [];
    const record = (level: string) => (message: string, context?: Record<string, unknown>) => {
      entries.push({ level, message, context });
    };
    vi.spyOn(logger, 'debug').mockImplementation(record('debug'));
    vi.spyOn(logger, 'info').mockImplementation(record('info'));
    vi.spyOn(logger, 'warn').mockImplementation(record('warn'));
    vi.spyOn(logger, 'error').mockImplementation(record('error'));
    return { entries, text: () => JSON.stringify(entries) };
  }

  it('logs no bearer token, no auth header and no response body on any error path', async () => {
    const logs = captureLogs();
    const { client, network, clock } = setup();
    network.respond = () => json(500, 'BODY-MARKER-500');
    await client.decide(QUERY);
    network.respond = () => json(200, 'BODY-MARKER-JSON {');
    await client.decide({ ...QUERY, subject: 'b@example.com' });
    network.respond = () => json(200, allowBody({ version: 2, revision: 'BODY-MARKER-CONTRACT rev' }));
    await client.decide({ ...QUERY, subject: 'c@example.com' });
    network.respond = () => json(200, allowBody({ critical: ['BODY-MARKER-CRITICAL'] }));
    await client.decide({ ...QUERY, subject: 'd@example.com' });
    network.respond = () => json(200, { padding: `BODY-MARKER-OVERSIZE${'x'.repeat(64 * 1024)}` });
    await client.decide({ ...QUERY, subject: 'e@example.com' });
    network.respond = () => json(401, 'BODY-MARKER-AUTH');
    await client.decide({ ...QUERY, subject: 'f@example.com' });
    network.respond = () => json(200, denyBody({ reason: 'BODY-MARKER-REASON with spaces' }));
    await client.decide({ ...QUERY, subject: 'g@example.com' });
    network.respond = () => json(200, allowBody({ revision: 'rev-lkg' }));
    await client.decide({ ...QUERY, subject: 'h@example.com' });
    clock.now += MINUTE + SECOND;
    network.respond = () => json(503, 'BODY-MARKER-503');
    await client.decide({ ...QUERY, subject: 'h@example.com' });

    const text = logs.text();
    expect(text).toContain('Access registry');
    expect(text).toContain('"errorClass":"contract"');
    expect(text).toContain('"source":"lkg"');
    expect(text).toContain('"reason":"unrecognised"');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('Bearer');
    expect(text).not.toContain('BODY-MARKER');
  });

  it('logs no identity token and no metadata response body', async () => {
    const logs = captureLogs();
    const { client, network, clock } = setup({ auth: GOOGLE });
    const token = identityToken(clock.now / 1000 + 3600);
    network.respond = (sent) => (sent.raw.startsWith(METADATA) ? new Response(token, { status: 200 }) : json(200, allowBody()));
    await client.decide(QUERY);

    const failing = setup({ auth: GOOGLE });
    failing.network.respond = (sent) => (sent.raw.startsWith(METADATA) ? json(500, 'BODY-MARKER-META') : json(200, allowBody()));
    await failing.client.decide(QUERY);

    expect(logs.text()).not.toContain(token);
    expect(logs.text()).not.toContain('BODY-MARKER-META');
    expect(logs.text()).toContain('"errorClass":"auth"');
  });

  it('logs each fetch as info with the fields the spec names, and each cache hit as debug', async () => {
    const logs = captureLogs();
    const { client, network } = setup();
    network.respond = () => json(200, denyBody({ reason: 'subject_not_enabled', revision: 'rev-7' }));
    await client.decide(QUERY);
    await client.decide(QUERY);
    const infos = logs.entries.filter((entry) => entry.level === 'info');
    const debugs = logs.entries.filter((entry) => entry.level === 'debug');
    expect(infos).toHaveLength(1);
    expect(debugs).toHaveLength(1);
    expect(infos[0].message).toBe('Access registry');
    expect(infos[0].context).toEqual({
      connector: CONNECTOR,
      platform: QUERY.platform,
      tenant: QUERY.tenant,
      subject: QUERY.subject,
      role: QUERY.role,
      tier: QUERY.tier,
      source: 'fresh',
      decision: 'deny',
      reason: 'subject_not_enabled',
      revision: 'rev-7',
      httpStatus: 200,
      latencyMs: 0,
    });
  });

  it('warns once per key per minute and logs the repeats at debug', async () => {
    const logs = captureLogs();
    const { client, network, clock } = setup();
    network.respond = () => json(500, 'boom');
    await client.decide(QUERY);
    await client.decide(QUERY);
    await client.decide(QUERY);
    expect(logs.entries.filter((entry) => entry.level === 'warn')).toHaveLength(1);
    expect(logs.entries.filter((entry) => entry.level === 'debug')).toHaveLength(2);
    clock.now += MINUTE;
    await client.decide(QUERY);
    expect(logs.entries.filter((entry) => entry.level === 'warn')).toHaveLength(2);
  });
});

describe('registry client: construction', () => {
  it('times out a decision source that never answers and ignores the abort signal', async () => {
    vi.useFakeTimers();
    try {
      const config: EnabledAccessRegistryConfig = {
        enabled: true,
        baseUrl: BASE,
        auth: { mode: 'bearer', token: TOKEN },
        connector: CONNECTOR,
        maxStaleSeconds: 600,
        timeoutMs: 25,
      };
      const stalled = createAccessRegistryClient(config, { fetchDecision: () => new Promise(() => undefined) });
      const pending = stalled.decide(QUERY);
      await vi.advanceTimersByTimeAsync(25);
      expect(await pending).toEqual({ source: 'unavailable', errorClass: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  }, 2_000);
  it('refuses options it cannot run with', () => {
    const fetchDecision = async () => ({ kind: 'not_modified' as const });
    expect(() => new RegistryClient({ connector: CONNECTOR, fetchDecision, timeoutMs: 0 })).toThrow(RangeError);
    expect(() => new RegistryClient({ connector: CONNECTOR, fetchDecision, maxStaleMs: -1 })).toThrow(RangeError);
    expect(() => new RegistryClient({ connector: CONNECTOR, fetchDecision, maxEntries: 0 })).toThrow(RangeError);
  });

  it('lets an embedder supply the decision source, and counts a throw from it as a network error', async () => {
    const config: EnabledAccessRegistryConfig = {
      enabled: true,
      baseUrl: BASE,
      auth: { mode: 'bearer', token: TOKEN },
      connector: 'lab-connector',
      maxStaleSeconds: 600,
      timeoutMs: 3000,
    };
    const embedded = createAccessRegistryClient(config, {
      fetchDecision: async () => ({ kind: 'decision', body: JSON.stringify(allowBody()) }),
    });
    expect(await embedded.decide(QUERY)).toMatchObject({ source: 'fresh', decision: { decision: 'allow' } });
    const broken = createAccessRegistryClient(config, {
      fetchDecision: async () => {
        throw new Error('embedder failure');
      },
    });
    expect(await broken.decide(QUERY)).toEqual({ source: 'unavailable', errorClass: 'network' });
  });

  it('builds the HTTP client from an enabled configuration, with its connector and bearer token', async () => {
    const network = new FakeNetwork();
    network.respond = () => json(200, allowBody());
    const client = createAccessRegistryClient(
      {
        enabled: true,
        baseUrl: BASE,
        auth: { mode: 'bearer', token: TOKEN },
        connector: 'lab-connector',
        maxStaleSeconds: 600,
        timeoutMs: 3000,
      },
      { fetch: network.fetch, now: () => START },
    );
    await client.decide(QUERY);
    expect(network.decisions()[0].url.searchParams.get('connector')).toBe('lab-connector');
    expect(network.decisions()[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});
