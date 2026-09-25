/**
 * End-to-end proof of the GGRM Office Manager fixes (PR #29).
 *
 * Stands up a stub NetSapiens API that answers the way production answered
 * Kevin Johnson (Office Manager at GGRM) on 2026-09-25, runs the REAL MCP
 * server against it, and drives it over HTTP as an MCP client holding an
 * Office Manager bearer. Assertions are on the upstream requests the server
 * actually made, not only on the response bodies.
 *
 * Production symptoms it reproduces on the unfixed server:
 *   find_domain   -> GET /domains                    401 Invalid Scope [APP001]
 *   my_voicemails -> GET /domains/~/users/~/voicemails 404 No Route Found [92]
 *   call_trace    -> GET /sipflow/<id>                404 No Route Found [92]
 *   recent_calls  { extension: "290" } silently answered with the whole domain
 *
 * Usage:
 *   node scripts/ggrm-office-manager-e2e.mjs
 *   SERVER_ROOT=../other-checkout node scripts/ggrm-office-manager-e2e.mjs
 */

import http from 'node:http';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = resolve(process.env.SERVER_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const TRACED_CALL = '0_1815951900@192.168.1.165';
const CORE_SERVER = 'core1-phx.edge.phoneware.cloud';
// A value that must never appear in any server log line.
const SENTINEL = 'SENTINEL-VALUE-4471';
// A second GGRM login with plain Basic User rights, to prove a scope refusal does not sign anyone out.
const BASIC_BEARER = 'ggrm-basic-user-test-token';
const BASIC_NS_TOKEN = 'ns-basic-user-token';

const USER_290_CDRS = [{ 'call-orig-call-id': 'k1' }, { 'call-orig-call-id': 'k2' }];
const DOMAIN_CDRS = Array.from({ length: 25 }, (_, i) => ({
 'call-orig-call-id': i === 7 ? TRACED_CALL : `d${i}`,
 'core-server': CORE_SERVER,
 'call-start-datetime': '2026-09-25T19:10:00Z',
 'call-disconnect-datetime': '2026-09-25T19:14:00Z',
 'is-trace-expected': 'yes',
}));

// --- stub NetSapiens, answering like production does for an Office Manager ---
const upstream = [];
const ns = http.createServer((req, res) => {
 const url = new URL(req.url, 'http://ns');
 const path = decodeURIComponent(url.pathname).replace(/^\/ns-api\/v2/, '');
 upstream.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization });
 const send = (status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
 };
 const noRoute = () => send(404, { code: 404, message: 'No Route Found [92]' });

 if (path === '/domains/~/users/~') return send(200, { 'user-scope': 'Office Manager', user: '290', domain: 'GGRM' });
 if (path === '/domains') return send(401, { code: 401, message: 'Invalid Scope [APP001]' });
 if (path === '/domains/~') return send(200, { domain: 'GGRM', description: 'GGRM Law Firm' });
 if (path === '/domains/~/users') return send(200, [{ user: '290', 'name-first-name': 'Kevin' }]);
 if (path === '/domains/~/users/~/voicemails') return noRoute();
 const vm = path.match(/^\/domains\/~\/users\/~\/voicemails\/(new|save|trash)$/);
 if (vm) return send(200, [{ filename: `${vm[1]}-1.wav`, 'caller-id-number': '5551230000' }]);
 // A plain user asking for someone else's calls: NS refuses the resource, not the session.
 if (path === '/domains/~/users/290/cdrs' && req.headers.authorization === `Bearer ${BASIC_NS_TOKEN}`)
  return send(401, { code: 401, message: 'Invalid Scope [APP001]' });
 if (path === '/domains/~/users/290/cdrs') return send(200, USER_290_CDRS);
 if (path === '/domains/~/users/~/cdrs') return send(200, USER_290_CDRS);
 if (path === '/domains/~/cdrs') return send(200, DOMAIN_CDRS);
 if (path.startsWith('/domains/~/users/~/calls/')) return send(404, { code: 404, message: 'Resource not found.' });
 if (path === '/sipflow') {
  const q = url.searchParams;
  if (!q.get('servers') || !q.get('type')) return send(400, { code: 400, message: 'Missing servers or type' });
  return send(200, { type: q.get('type'), servers: q.get('servers'), data: 'c2lwZmxvdw==' });
 }
 if (path.startsWith('/sipflow/') || path.startsWith('/cradle2grave/')) return noRoute();
 return noRoute();
});
await new Promise((r) => ns.listen(0, '127.0.0.1', r));
const nsUrl = `http://127.0.0.1:${ns.address().port}`;

// --- seed Kevin's Office Manager session, skipping the browser OAuth leg ---
const dir = mkdtempSync(join(tmpdir(), 'ns-mcp-ggrm-e2e-'));
const storePath = join(dir, 'tokens.json');
const BEARER = 'ggrm-office-manager-test-token';
writeFileSync(
 storePath,
 JSON.stringify({
  tokens: {
   [BEARER]: {
    accessToken: BEARER,
    refreshToken: 'rt',
    clientId: 'test-client',
    expiresAt: Date.now() + 3600_000,
    nsAccessToken: 'ns-upstream-token',
    nsExpiresAt: Date.now() + 3600_000,
    nsUsername: '290@GGRM',
    nsUserRole: 'domain_admin',
   },
   [BASIC_BEARER]: {
    accessToken: BASIC_BEARER,
    refreshToken: 'rt-basic',
    clientId: 'test-client',
    expiresAt: Date.now() + 3600_000,
    nsAccessToken: BASIC_NS_TOKEN,
    nsExpiresAt: Date.now() + 3600_000,
    nsUsername: '291@GGRM',
    nsUserRole: 'user',
   },
  },
 }),
);

// --- run the real MCP server from SERVER_ROOT --------------------------------
const port = 41000 + Math.floor(Math.random() * 2000);
const server = spawn('npx', ['tsx', 'bin/server.ts'], {
 cwd: SERVER_ROOT,
 env: {
  ...process.env,
  MCP_TRANSPORT: 'http',
  MCP_PORT: String(port),
  MCP_HOST: '127.0.0.1',
  MCP_BASE_URL: `http://127.0.0.1:${port}`,
  NETSAPIENS_API_URL: nsUrl,
  NETSAPIENS_OAUTH_CLIENT_ID: 'cid',
  NETSAPIENS_OAUTH_CLIENT_SECRET: 'secret',
  MCP_TOKEN_STORE_PATH: storePath,
  LOG_LEVEL: 'info',
 },
 stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (b) => (serverLog += b));
server.stderr.on('data', (b) => (serverLog += b));

let up = false;
for (let i = 0; i < 150 && !up; i++) {
 try {
  up = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
 } catch {
  await new Promise((r) => setTimeout(r, 100));
 }
}
if (!up) {
 console.error(serverLog);
 throw new Error(`server at ${SERVER_ROOT} never became healthy`);
}

// --- drive it as an MCP client ------------------------------------------------
const sessions = {};
let rpcId = 0;
async function rpc(method, params, bearer = BEARER) {
 const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
  method: 'POST',
  headers: {
   'Content-Type': 'application/json',
   Accept: 'application/json, text/event-stream',
   Authorization: `Bearer ${bearer}`,
   ...(sessions[bearer] ? { 'mcp-session-id': sessions[bearer] } : {}),
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
 });
 sessions[bearer] ??= res.headers.get('mcp-session-id') ?? undefined;
 const text = await res.text();
 const line = text.split('\n').find((l) => l.startsWith('data: ')) ?? text;
 let parsed;
 try {
  parsed = JSON.parse(line.replace(/^data: /, ''));
 } catch {
  parsed = { error: { message: text } };
 }
 return { ...parsed, httpStatus: res.status };
}

for (const bearer of [BEARER, BASIC_BEARER]) {
 await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ggrm-e2e', version: '0' } }, bearer);
}

/** Call a tool; return what it answered and every upstream request it made. */
async function callTool(name, args, bearer = BEARER) {
 const mark = upstream.length;
 const r = await rpc('tools/call', { name, arguments: args }, bearer);
 const text = r.result?.content?.[0]?.text ?? r.error?.message ?? '';
 const isError = Boolean(r.error || r.result?.isError);
 let body;
 try {
  body = JSON.parse(text);
 } catch {
  body = { text };
 }
 return { isError, text, body, hits: upstream.slice(mark), httpStatus: r.httpStatus };
}

const results = [];
function check(label, ok, detail) {
 results.push(ok);
 console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`);
}
const show = (hits) => hits.map((h) => `${h.method} ${h.path}${Object.keys(h.query).length ? ' ' + JSON.stringify(h.query) : ''}`).join(' | ') || '(none)';

console.log(`\n=== GGRM Office Manager (290@GGRM, domain_admin) against ${SERVER_ROOT} ===\n`);

const domain = await callTool('find_domain', {});
check(
 'find_domain answers without calling reseller-only GET /domains',
 !domain.hits.some((h) => h.path === '/domains') && domain.body?.data?.[0]?.domain === 'GGRM',
 `upstream: ${show(domain.hits)}; answer: ${domain.text.slice(0, 160)}`,
);

const vms = await callTool('my_voicemails', {});
check(
 'my_voicemails lists voicemails using only real folder paths',
 !vms.hits.some((h) => h.path === '/domains/~/users/~/voicemails') &&
 vms.hits.length > 0 &&
 vms.hits.every((h) => /\/voicemails\/(new|save|trash)$/.test(h.path)) &&
 !/No Route Found/.test(vms.text),
 `upstream: ${show(vms.hits)}; answer: ${vms.text.slice(0, 160)}`,
);

const ext = await callTool('recent_calls', { extension: '290' });
check(
 'recent_calls { extension: "290" } is refused, pointing at `user`, with no CDR request',
 ext.isError && /extension/.test(ext.text) && /user/.test(ext.text) && !ext.hits.some((h) => h.path.includes('cdrs')),
 `upstream: ${show(ext.hits)}; answer: ${ext.text.slice(0, 200)}`,
);

const one = await callTool('recent_calls', { user: '290' });
check(
 'recent_calls { user: "290" } reads extension 290 only, and says so',
 one.hits.length === 1 && one.hits[0].path === '/domains/~/users/290/cdrs' && one.body.scope === 'user' && typeof one.body.scope_note === 'string',
 `upstream: ${show(one.hits)}; scope: ${one.body.scope}; scope_note: ${one.body.scope_note}`,
);

const all = await callTool('recent_calls', {});
check(
 'recent_calls {} gives an Office Manager the whole domain, and says so',
 all.hits.length === 1 && all.hits[0].path === '/domains/~/cdrs' && all.body.scope === 'domain' && typeof all.body.scope_note === 'string',
 `upstream: ${show(all.hits)}; scope: ${all.body.scope}; scope_note: ${all.body.scope_note}`,
);

const trace = await callTool('call_trace', { call_id: TRACED_CALL });
const sip = trace.hits.find((h) => h.path === '/sipflow');
check(
 'call_trace on a completed call finds its core server in the CDRs and calls GET /sipflow',
 Boolean(sip) && sip.query.servers === CORE_SERVER && sip.query.type === 'call_trace' && sip.query.callids === TRACED_CALL &&
 !trace.hits.some((h) => h.path.startsWith('/sipflow/') || h.path.startsWith('/cradle2grave/')),
 `upstream: ${show(trace.hits)}`,
);

await callTool('find_user', { query: SENTINEL });

// Basic user 291 asks for extension 290's calls. NS refuses with 401 Invalid Scope.
// That is a permissions answer; the user's next request must still be served.
const refused = await callTool('recent_calls', { user: '290' }, BASIC_BEARER);
const after = await callTool('my_voicemails', {}, BASIC_BEARER);
check(
 'a 401 Invalid Scope from NS does not sign the user out of the connector',
 refused.hits.some((h) => h.path === '/domains/~/users/290/cdrs') && after.httpStatus === 200 && !after.isError && after.hits.length > 0,
 `refused call: ${refused.text.slice(0, 120)}; next call: HTTP ${after.httpStatus}, upstream ${show(after.hits)}, answer ${after.text.slice(0, 80)}`,
);

const logLines = serverLog
 .split('\n')
 .map((l) => {
  try {
   return JSON.parse(l);
  } catch {
   return undefined;
  }
 })
 .filter(Boolean);
const toolLogs = logLines.filter((l) => l.message === 'Tool call' && l.username !== '291@GGRM');
const loggedTools = toolLogs.map((l) => l.tool);
check(
 'one structured "Tool call" log per call, with role, username and argument names',
 ['find_domain', 'my_voicemails', 'recent_calls', 'call_trace', 'find_user'].every((t) => loggedTools.includes(t)) &&
 toolLogs.length === 7 &&
 toolLogs.every((l) => l.role === 'domain_admin' && l.username === '290@GGRM' && Array.isArray(l.argNames)),
 `tool call logs: ${toolLogs.map((l) => `${l.tool}(${(l.argNames ?? []).join(',')}) ok=${l.ok}${l.scope ? ' scope=' + l.scope : ''}`).join('; ') || '(none)'}`,
);
check('no argument value appears in any server log line', !serverLog.includes(SENTINEL));

server.kill('SIGTERM');
if (process.env.E2E_DUMP_LOG) console.log(serverLog);
ns.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${failed ? `FAIL: ${failed} of ${results.length} checks failed` : `PASS: all ${results.length} checks`}\n`);
process.exit(failed ? 1 : 0);
