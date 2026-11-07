/**
 * End-to-end proof of the office-manager domain-scope fix.
 *
 * Stands up a stub NetSapiens API that answers exactly like Example Clinic did on
 * the call (the office manager has 2 calls today; the domain has 1500), runs
 * the REAL MCP server against it, and drives it as a real MCP client over HTTP
 * with an Office Manager bearer token.
 */

import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const readArg = (name) => {
 const i = args.indexOf(name);
 return i < 0 ? undefined : args[i + 1];
};
const cliApiUrl = readArg('--api-url');
const cliCredentials = readArg('--credentials');
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
 if (url.pathname === '/ns-api/v2/tokens' || url.pathname === '/ns-api/oauth2/token' || url.pathname === '/ns-api/v2/jwt') {
  return json({ access_token: 'ns-upstream-token', refresh_token: 'rt', expires_in: 3600 });
 }
 if (url.pathname === '/ns-api/v2/domains/~/users/~') {
  return json({ 'user-scope': 'Office Manager', user: '1001', domain: 'ExampleClinic' });
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
const nsUrl = cliApiUrl || `http://127.0.0.1:${ns.address().port}`;

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
  MCP_PERSISTENCE: 'memory',
  MCP_SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
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

// --- seed an Office Manager session via OAuth login -------------------------
const regRes = await fetch(`http://127.0.0.1:${port}/register`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ redirect_uris: ['http://localhost/callback'], client_name: 'e2e' }),
});
const { client_id, client_secret } = await regRes.json();

const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

const authRes = await fetch(
 `http://127.0.0.1:${port}/authorize?response_type=code&client_id=${client_id}&redirect_uri=http://localhost/callback&code_challenge=${challenge}&code_challenge_method=S256&state=xyz`
);
const authHtml = await authRes.text();
const match = authHtml.match(/name="auth_state"\s+value="([^"]+)"/);
const authState = match ? match[1] : '';

const loginRes = await fetch(`http://127.0.0.1:${port}/login`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
 body: new URLSearchParams({
  username: '1001@ExampleClinic',
  password: 'password',
  auth_state: authState,
 }),
 redirect: 'manual',
});
const location = loginRes.headers.get('location') || '';
const code = new URL(location).searchParams.get('code') || '';

const tokenRes = await fetch(`http://127.0.0.1:${port}/token`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
 body: new URLSearchParams({
  grant_type: 'authorization_code',
  code,
  code_verifier: verifier,
  client_id,
  client_secret,
  redirect_uri: 'http://localhost/callback',
 }),
});
const tokenData = await tokenRes.json();
const BEARER = tokenData.access_token;
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

const parse = (r) =>
 r.result ? JSON.parse(r.result.content[0].text) : { data: null, error: r.error?.message ?? 'tool not available' };

/** Call a tool and report which upstream NS path it actually reached. */
async function callTool(name, args) {
 const mark = upstreamHits.length;
 const res = await rpc('tools/call', { name, arguments: args });
 return { path: upstreamHits.slice(mark).at(-1), body: parse(res) };
}

// The question Jordan actually asks. A model answering "how many calls did we
// take today" passes no scope hint, so the default has to be right on its own.
const bareVolume = await callTool('call_volume', {});
const bareCalls = await callTool('recent_calls', {});
// Explicit narrowing still has to work, or managers lose their own view.
const ownCalls = await callTool('recent_calls', { scope: 'mine' });
// And one named user stays one named user.
const oneUser = await callTool('recent_calls', { user: '2002' });

console.log('\n=== Office Manager, connected over OAuth as 1001@ExampleClinic ===');
console.log('NS reported scope        : Office Manager');
console.log('\n-- "how many calls did we take today" (no scope passed) --');
console.log('  upstream path          :', bareVolume.path);
console.log('  scope reported         :', bareVolume.body.scope ?? 'none');
console.log('  total                  :', bareVolume.body.data?.total ?? `unavailable (${bareVolume.body.error})`);
console.log('\n-- "show me recent calls" (no scope passed) --');
console.log('  upstream path          :', bareCalls.path);
console.log('  calls returned         :', bareCalls.body.data?.length ?? 'n/a');
console.log('\n-- "just my own calls" (scope=mine) --');
console.log('  upstream path          :', ownCalls.path);
console.log('  calls returned         :', ownCalls.body.data?.length ?? 'n/a');
console.log('\n-- "calls for extension 2002" --');
console.log('  upstream path          :', oneUser.path);

const ok =
 bareVolume.path === '/ns-api/v2/domains/~/cdrs/count' &&
 bareVolume.body.data?.total === DOMAIN_CDR_COUNT &&
 bareCalls.path === '/ns-api/v2/domains/~/cdrs' &&
 ownCalls.path === '/ns-api/v2/domains/~/users/~/cdrs' &&
 ownCalls.body.data?.length === USER_CDRS.length &&
 oneUser.path === '/ns-api/v2/domains/~/users/2002/cdrs';

console.log(
 `\n${ok ? 'PASS' : 'FAIL'}: the bare question answers ${bareVolume.body.data?.total ?? 'nothing'}, not ${USER_CDRS.length}\n`,
);

server.kill('SIGTERM');
ns.close();
process.exit(ok ? 0 : 1);
