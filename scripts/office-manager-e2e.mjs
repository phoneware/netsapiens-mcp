/**
 * End-to-end proof of the office-manager domain-scope fix.
 *
 * Stands up a stub NetSapiens API that answers exactly like Spooner PT did on
 * the call (the office manager has 2 calls today; the domain has 1500), runs
 * the REAL MCP server against it, and drives it as a real MCP client over HTTP
 * with an Office Manager bearer token.
 */

import http from 'node:http';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const USER_CDRS = [{ 'call-id': 'u1' }, { 'call-id': 'u2' }];
const DOMAIN_CDR_COUNT = 1500;

const upstreamHits = [];

// --- stub NetSapiens -------------------------------------------------------
const ns = http.createServer((req, res) => {
 const url = new URL(req.url, 'http://ns');
 upstreamHits.push(url.pathname);
 const json = (body) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
 };
 // Who am I: NS reports this login as an Office Manager.
 if (url.pathname === '/ns-api/v2/domains/~/users/~') {
  return json({ 'user-scope': 'Office Manager', user: '1001', domain: 'SpoonerPT' });
 }
 if (url.pathname === '/ns-api/v2/domains/~/users/~/cdrs') return json(USER_CDRS);
 if (url.pathname === '/ns-api/v2/domains/~/cdrs')
  return json(Array.from({ length: 25 }, (_, i) => ({ 'call-id': `d${i}` })));
 if (url.pathname === '/ns-api/v2/domains/~/cdrs/count')
  return json({ total: DOMAIN_CDR_COUNT, 'total-duration': 184320 });
 if (url.pathname === '/ns-api/v2/domains/~/users/~/cdrs/count')
  return json({ total: USER_CDRS.length, 'total-duration': 240 });
 json({});
});
await new Promise((r) => ns.listen(0, '127.0.0.1', r));
const nsUrl = `http://127.0.0.1:${ns.address().port}`;

// --- seed an Office Manager session ---------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'ns-mcp-e2e-'));
const storePath = join(dir, 'tokens.json');
const BEARER = 'office-manager-test-token';
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
    nsUsername: '1001@SpoonerPT',
    nsUserRole: 'domain_admin',
   },
  },
 }),
);

// --- run the real MCP server ----------------------------------------------
const port = 39000 + Math.floor(Math.random() * 2000);
const server = spawn('npx', ['tsx', 'bin/server.ts'], {
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
  LOG_LEVEL: 'warn',
 },
 stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (b) => process.stderr.write(b));

for (let i = 0; i < 100; i++) {
 try {
  await fetch(`http://127.0.0.1:${port}/health`);
  break;
 } catch {
  await new Promise((r) => setTimeout(r, 100));
 }
}

// --- drive it as an MCP client --------------------------------------------
let sessionId;
async function rpc(method, params) {
 const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
  method: 'POST',
  headers: {
   'Content-Type': 'application/json',
   Accept: 'application/json, text/event-stream',
   Authorization: `Bearer ${BEARER}`,
   ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
 });
 sessionId ??= res.headers.get('mcp-session-id') ?? undefined;
 const text = await res.text();
 const line = text.split('\n').find((l) => l.startsWith('data: ')) ?? text;
 return JSON.parse(line.replace(/^data: /, ''));
}

await rpc('initialize', {
 protocolVersion: '2025-06-18',
 capabilities: {},
 clientInfo: { name: 'e2e', version: '0' },
});

const before = upstreamHits.length;
const oldWay = await rpc('tools/call', { name: 'recent_calls', arguments: {} });
const userPath = upstreamHits.slice(before).at(-1);

const b2 = upstreamHits.length;
const domainWide = await rpc('tools/call', { name: 'recent_calls', arguments: { scope: 'domain' } });
const domainPath = upstreamHits.slice(b2).at(-1);

const b3 = upstreamHits.length;
const volume = await rpc('tools/call', { name: 'call_volume', arguments: { scope: 'domain' } });
const countPath = upstreamHits.slice(b3).at(-1);

const parse = (r) => (r.result ? JSON.parse(r.result.content[0].text) : { data: null, error: r.error?.message ?? 'tool not available' });

console.log('\n=== Office Manager, connected over OAuth as 1001@SpoonerPT ===');
console.log('NS reported scope        : Office Manager');
console.log('\n-- "my recent calls" (default) --');
console.log('  upstream path          :', userPath);
console.log('  calls returned         :', parse(oldWay).data?.length ?? 'n/a');
console.log('\n-- "calls across the whole domain" (scope=domain) --');
console.log('  upstream path          :', domainPath);
console.log('  calls returned         :', parse(domainWide).data?.length ?? 'n/a');
console.log('\n-- "how many calls did the domain take today" (call_volume) --');
console.log('  total                  :', parse(volume).data?.total ?? `unavailable (${parse(volume).error})`);

const ok =
 userPath === '/ns-api/v2/domains/~/users/~/cdrs' &&
 domainPath === '/ns-api/v2/domains/~/cdrs' &&
 countPath === '/ns-api/v2/domains/~/cdrs/count' &&
 parse(volume).data?.total === DOMAIN_CDR_COUNT;

console.log(`\n${ok ? 'PASS' : 'FAIL'}: domain question answers ${parse(volume).data?.total ?? 'nothing'}, not ${USER_CDRS.length}\n`);

server.kill('SIGTERM');
ns.close();
process.exit(ok ? 0 : 1);
