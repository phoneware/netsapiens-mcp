/**
 * A programmable access registry for tests. It speaks registry wire contract v1 (docs/access-registry.md, "Request",
 * "Decision response" and "Status handling") on a loopback port, so the packaged connector can be driven end to end.
 *
 * Decisions are keyed by (tenant, subject). A subject of "*" sets a tenant default. A key with nothing set answers
 * tenant_not_enrolled, which is the registry's own answer for a domain it does not serve.
 *
 * A fault replaces the answer for one (tenant, subject) key. Latency and the bearer check apply to every key. The
 * faults are an HTTP status, a hang, a body that is not JSON, a body that is a JSON string (a body encoded twice), a
 * critical member, an oversize body and a redirect. Nothing is simulated beyond the contract: the connector does the
 * checks, and this server only answers.
 *
 * `allowAll` answers allow with the default policy for every key that has no fault. It is the positive control for the
 * e2e registry leg: a leg that still passes when every decision is allow is not proving refusals.
 *
 * Every request is appended to `requests`, rejected ones included, with the outcome it was given. Bodies and bearer
 * tokens are not logged.
 */
import * as http from 'node:http';

export const DECISION_PATH = '/v1/decision';
export const DEFAULT_CONNECTOR = 'netsapiens-mcp';
/** One byte over the 64 KiB limit the connector reads. */
const OVERSIZE_BYTES = 64 * 1024 + 1;
const TIERS = new Set(['system_admin', 'reseller', 'domain_admin', 'user']);
const CONTENT_KINDS = ['call_recording', 'transcript', 'voicemail', 'sms_text', 'ai_summary', 'fax_page'];

/**
 * A complete policy. The defaults allow every tool and every content kind, write access, and every redirect. Override
 * any member. `tools` and `content` merge member by member, so a test names only what it changes.
 */
export function policy(overrides = {}) {
  const content = Object.fromEntries(CONTENT_KINDS.map((kind) => [kind, 'allow']));
  return {
    access: 'write',
    unclassifiedOutput: 'allow',
    platforms: ['*'],
    ...overrides,
    tools: { allow: ['*'], deny: [], ...(overrides.tools ?? {}) },
    content: { ...content, ...(overrides.content ?? {}) },
  };
}

/** An allow decision. The connector clamps ttlSeconds to 5 to 300, so a test that must see a change soon uses 5. */
export function allowDecision({ policy: body = policy(), revision = 'rev-1', ttlSeconds = 60, critical } = {}) {
  return {
    kind: 'decision',
    body: { version: 1, decision: 'allow', revision, ttlSeconds, policy: body, ...(critical ? { critical } : {}) },
  };
}

/** A deny decision. Any reason string is a deny, so a test may use a reason the connector does not name. */
export function denyDecision({ reason = 'tenant_not_enrolled', revision = '0', ttlSeconds = 60 } = {}) {
  return { kind: 'decision', body: { version: 1, decision: 'deny', reason, revision, ttlSeconds } };
}

/**
 * A fault for one key. Kinds: status (an HTTP status with no decision), hang (no answer until the server closes),
 * garbage (a 200 whose body is not JSON), double (a 200 whose JSON is a string that holds decision JSON), critical (a
 * valid allow that names a member the connector does not understand), oversize (a 200 larger than the 64 KiB limit)
 * and redirect (a 302 to `location`).
 */
export function fault(kind, options = {}) {
  return { kind: 'fault', fault: kind, ...options };
}

function keyOf(tenant, subject) {
  return `${tenant.toLowerCase()}\u0000${subject.toLowerCase()}`;
}

function etagOf(revision) {
  return `"${revision}"`;
}

/** The revision an If-None-Match header names, without its quotes or weak prefix. */
function revisionOfIfNoneMatch(header) {
  if (typeof header !== 'string') return undefined;
  return header.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
}

/**
 * Starts the fake registry on a loopback port.
 *
 * @param {{ bearer?: string | null, latencyMs?: number, hostname?: string, allowAll?: boolean }} [options]
 *   bearer: the token every request must present, or null to accept any request.
 *   latencyMs: a delay before every answer.
 *   allowAll: answer allow with the default policy for every key that has no fault.
 */
export async function startFakeAccessRegistry(options = {}) {
  const hostname = options.hostname ?? '127.0.0.1';
  const state = {
    bearer: options.bearer ?? null,
    latencyMs: options.latencyMs ?? 0,
    allowAll: options.allowAll ?? false,
    decisions: new Map(),
    faults: new Map(),
  };
  const requests = [];
  const pending = new Set();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) send(res, 500, { 'Content-Type': 'application/json' }, JSON.stringify({ error: err.message }));
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || hostname}`);
    const entry = { method: req.method, path: url.pathname, at: Date.now(), outcome: undefined, status: undefined };
    requests.push(entry);
    const finish = (outcome, status, headers, body) => {
      entry.outcome = outcome;
      entry.status = status;
      send(res, status, headers, body);
    };

    if (url.pathname !== DECISION_PATH) {
      return finish('not_found', 404, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'not_found' }));
    }
    if (req.method !== 'GET') {
      return finish('method_not_allowed', 405, { 'Content-Type': 'application/json', Allow: 'GET' }, JSON.stringify({ error: 'method_not_allowed' }));
    }

    entry.authorized = state.bearer === null || req.headers.authorization === `Bearer ${state.bearer}`;
    if (!entry.authorized) {
      return finish('unauthorized', 401, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'unauthorized' }));
    }

    const query = Object.fromEntries(url.searchParams.entries());
    Object.assign(entry, {
      connector: query.connector,
      platform: query.platform,
      tenant: query.tenant,
      subject: query.subject,
      role: query.role,
      tier: query.tier,
    });
    const missing = ['connector', 'platform', 'tenant', 'subject', 'tier'].some((name) => !query[name]);
    if (missing || query.role === undefined || !TIERS.has(query.tier)) {
      return finish('bad_request', 400, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'bad_request' }));
    }

    if (state.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, state.latencyMs));

    const key = keyOf(query.tenant, query.subject);
    const spec = state.faults.get(key) ??
      (state.allowAll ? allowDecision({ ttlSeconds: 5 }) : state.decisions.get(key) ?? state.decisions.get(keyOf(query.tenant, '*')) ?? denyDecision());
    entry.ifNoneMatch = req.headers['if-none-match'] ?? null;

    if (spec.kind === 'fault') return applyFault(spec, entry, res, finish);
    const body = spec.body;
    entry.decision = body.decision;
    entry.reason = body.reason;
    entry.revision = body.revision;
    if (revisionOfIfNoneMatch(req.headers['if-none-match']) === body.revision) {
      return finish('not_modified', 304, { ETag: etagOf(body.revision) }, undefined);
    }
    return finish(body.decision, 200, { 'Content-Type': 'application/json', ETag: etagOf(body.revision) }, JSON.stringify(body));
  }

  function applyFault(spec, entry, res, finish) {
    entry.faultKind = spec.fault;
    switch (spec.fault) {
      case 'status':
        return finish('fault:status', spec.status ?? 500, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'fault' }));
      case 'hang':
        entry.outcome = 'fault:hang';
        pending.add(res);
        res.on('close', () => pending.delete(res));
        return undefined;
      case 'garbage':
        return finish('fault:garbage', 200, { 'Content-Type': 'text/html' }, spec.body ?? '<html>not a decision</html>');
      case 'double': {
        const base = spec.base ?? allowDecision().body;
        return finish('fault:double', 200, { 'Content-Type': 'application/json' }, JSON.stringify(JSON.stringify(base)));
      }
      case 'critical': {
        const base = spec.base ?? allowDecision().body;
        const body = { ...base, critical: spec.members ?? ['future_restriction'] };
        return finish('fault:critical', 200, { 'Content-Type': 'application/json' }, JSON.stringify(body));
      }
      case 'oversize':
        return finish(
          'fault:oversize',
          200,
          { 'Content-Type': 'application/json' },
          `{"version":1,"decision":"deny","reason":"${'x'.repeat(OVERSIZE_BYTES)}","revision":"0","ttlSeconds":60}`,
        );
      case 'redirect':
        return finish('fault:redirect', 302, { Location: spec.location ?? '/', 'Content-Type': 'text/plain' }, '');
      default:
        throw new Error(`unknown fault ${spec.fault}`);
    }
  }

  function send(res, status, headers, body) {
    // A body gets its length up front, so the connector sees the same Content-Length it would for a real registry.
    // A 304 carries no body and no length.
    if (status === 304 || body === undefined) {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    res.writeHead(status, { ...headers, 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  await new Promise((resolve) => server.listen(0, hostname, resolve));
  const origin = `http://${hostname}:${server.address().port}`;

  return {
    origin,
    /** The value for MCP_ACCESS_REGISTRY_URL. The connector appends the decision path. */
    url: origin,
    /** Every request in arrival order, with the outcome the registry gave it. */
    requests,
    /** Sets the answer for a (tenant, subject) pair. A subject of "*" sets the tenant default. */
    setDecision(tenant, subject, spec) {
      state.decisions.set(keyOf(tenant, subject), spec);
    },
    clearDecision(tenant, subject) {
      state.decisions.delete(keyOf(tenant, subject));
    },
    /** Sets a fault for a pair, which answers before any decision for that pair. Pass null to clear it. */
    setFault(tenant, subject, spec) {
      if (spec === null) state.faults.delete(keyOf(tenant, subject));
      else state.faults.set(keyOf(tenant, subject), spec);
    },
    setLatency(ms) {
      state.latencyMs = ms;
    },
    /** Requires this bearer token on every request, or accepts any request when null. */
    setBearer(token) {
      state.bearer = token;
    },
    async close() {
      for (const res of pending) res.destroy();
      pending.clear();
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
