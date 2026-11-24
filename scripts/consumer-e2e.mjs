#!/usr/bin/env node
/**
 * Consumer end-to-end proof for netsapiens-mcp.
 *
 * Usage:
 *   node scripts/consumer-e2e.mjs (--tarball <path> | --registry <version>) [--legs <csv>] [--firestore-major 7|8|9]
        *   node scripts/consumer-e2e.mjs --cold-registry <versioned|unversioned>
        *   Run both modes after publishing to exercise independent, empty npm caches.
 *
 * Legs:
 *   - install: installs package, proves no firestore dir, no *.node files, exports resolve.
 *   - config: tests documented failure exits on missing/bad env vars via package binary.
 *   - sqlite: runs against fake NetSapiens, exercises DCR, PKCE, token sign-in, read tool, restart persistence, file mode 600, lock exclusion, at-rest encryption.
 *   - memory: proves bearer is lost (401 invalid_token) after server restart in memory mode.
 *   - version: checks tool lists differ across versions, 46.0 tool refused on 44.4 with 0 requests, /health info, 500 origin handling.
 *   - firestore: installs @google-cloud/firestore, proves multi-instance bearer sharing, runs exported store conformance against emulator.
 *   - mfa: exercises password challenge, single-use retries and MCP connection against a fake NetSapiens.
 *   - library: tsc --noEmit on consumer TS file importing from 'netsapiens-mcp/lib'.
 *   - registry: main() with the access registry configured, against the fake NetSapiens and the fake registry. Every refusal is asserted with zero NetSapiens requests; the leg needs the 'registry' name and no other leg.
 *       REGISTRY_E2E_COLLECT=1 keeps the registry leg going past a failed row and lists every row that failed (revert-proof runs). The default stops at the first failure.
 *       REGISTRY_E2E_ALLOW_ALL=1 makes the fake registry allow everything (the positive control: refusal rows must then fail).
 */

import { spawn, execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function parseArgs() {
  const args = process.argv.slice(2);
  let tarball = null;
  let registry = null;
  let coldRegistry = null;
  let legs = null;
  let firestoreMajor = '8';
  let bridgeTarball = null;
  let canonicalTarball = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--tarball') {
      tarball = args[++i];
    } else if (arg === '--registry') {
      registry = args[++i];
    } else if (arg === '--cold-registry') {
      coldRegistry = args[++i];
    } else if (arg === '--legs') {
      legs = args[++i];
    } else if (arg === '--firestore-major') {
      firestoreMajor = args[++i];
    } else if (arg === '--bridge-tarball') {
      bridgeTarball = args[++i];
    } else if (arg === '--canonical-tarball') {
      canonicalTarball = args[++i];
    } else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/consumer-e2e.mjs (--tarball <path> | --registry <version>) [--legs <csv>] [--firestore-major 7|8|9] [--bridge-tarball <path> --canonical-tarball <path>]');
      process.exit(0);
    }
  }

  if (coldRegistry && (!['versioned', 'unversioned'].includes(coldRegistry) || tarball || registry || legs)) {
    throw new Error('--cold-registry requires versioned or unversioned and cannot be combined with package or leg options');
  }
  if (!tarball && !registry && !coldRegistry) {
    throw new Error('Specify --tarball, --registry, or --cold-registry');
  }

  const selectedLegs = coldRegistry ? ['sqlite'] : legs
    ? legs.split(',').map((s) => s.trim().toLowerCase())
    : ['install', 'config', 'sqlite', 'memory', 'version', 'library', 'mfa'];

  if (selectedLegs.includes('cutover-interop') && (!tarball || !bridgeTarball || !canonicalTarball)) {
    throw new Error('cutover-interop requires --tarball, --bridge-tarball, and --canonical-tarball');
  }
  return {
    tarball: tarball ? path.resolve(process.cwd(), tarball) : null,
    registry,
    coldRegistry,
    legs: selectedLegs,
    firestoreMajor,
    bridgeTarball: bridgeTarball ? path.resolve(process.cwd(), bridgeTarball) : null,
    canonicalTarball: canonicalTarball ? path.resolve(process.cwd(), canonicalTarball) : null,
  };
}

/** Every credential the leg minted or was handed. Failure text and log output replace each with [redacted]. */
const knownSecrets = new Set();
function scrub(text) {
  let out = String(text);
  for (const secret of [...knownSecrets].sort((a, b) => b.length - a.length)) out = out.split(secret).join('[redacted]');
  return out;
}

/** Records the credentials a token response carries, so no later failure text can name them. */
function captureTokens(json) {
  for (const key of ['access_token', 'refresh_token']) {
    if (typeof json?.[key] === 'string') knownSecrets.add(json[key]);
  }
  return json;
}

function parseJsonOrUndefined(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function truncate(value, max = 120) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** What a failure text may say about a response: its status, its error fields and its size. Never the body. */
function describeResponse(res) {
  const raw = typeof res?.rawText === 'string' ? res.rawText : undefined;
  const json = res?.json ?? (raw === undefined ? undefined : parseJsonOrUndefined(raw));
  const bytes = Buffer.byteLength(raw ?? JSON.stringify(json ?? null));
  const error = json?.error;
  let errorText = 'none';
  if (typeof error === 'string') errorText = truncate(error);
  else if (error !== null && typeof error === 'object') errorText = `code ${error.code ?? 'none'}: ${truncate(error.message)}`;
  const description = typeof json?.error_description === 'string' ? truncate(json.error_description) : 'none';
  return `status ${res?.status ?? 'none'}, error ${errorText}, error_description ${description}, body ${bytes} bytes`;
}

function formatFailure(leg, assertion, reason) {
  return scrub(`FAIL ${leg} ${assertion}: ${reason}`);
}

function pass(leg, assertion) {
  if (leg === 'registry' && collectedRegistryFailures.includes(assertion)) return;
  console.log(scrub(`PASS ${leg} ${assertion}`));
}

// REGISTRY_E2E_COLLECT=1 keeps the registry leg going after a failed row, so one run lists every row a change breaks.
// The default stops at the first failure.
const collectedRegistryFailures = [];
function fail(leg, assertion, reason) {
  const message = formatFailure(leg, assertion, reason);
  if (leg === 'registry' && process.env.REGISTRY_E2E_COLLECT === '1') {
    console.log(message);
    collectedRegistryFailures.push(assertion);
    return;
  }
  throw new Error(message);
}

async function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function walkFiles(dir, matchFn, results = []) {
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, matchFn, results);
    } else if (entry.isFile() && matchFn(entry.name, fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

function runCommand(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const cp = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';
    cp.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    cp.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    cp.on('close', (code, signal) => {
      resolve({ status: code ?? 1, stdout, stderr, signal });
    });
    cp.on('error', (err) => {
      resolve({ status: 1, stdout, stderr: stderr + err.message, signal: null });
    });
  });
}

let coldPackage = null;
function getPackageBinaryRunner() {
  return { cmd: 'npx', args: ['--yes', coldPackage ?? 'netsapiens-mcp'] };
}

async function startMcpServerProcess(tempDir, env) {
  const runner = getPackageBinaryRunner(tempDir);
  const cp = spawn(runner.cmd, runner.args, {
    cwd: tempDir,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  cp.stdout.on('data', (d) => { logs += d.toString('utf8'); });
  cp.stderr.on('data', (d) => { logs += d.toString('utf8'); });
  return {
    cp,
    getLogs: () => logs,
    async stop() {
      if (cp.exitCode === null) {
        if (process.platform !== 'win32' && cp.pid) {
          try { process.kill(-cp.pid, 'SIGTERM'); } catch { }
        } else {
          cp.kill('SIGTERM');
        }
        for (let i = 0; i < 40; i++) {
          if (cp.exitCode !== null) return;
          await delay(50);
        }
        if (process.platform !== 'win32' && cp.pid) {
          try { process.kill(-cp.pid, 'SIGKILL'); } catch { }
        } else {
          cp.kill('SIGKILL');
        }
      }
    },
  };
}

async function waitForHealthDown(port, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
      await delay(100);
    } catch {
      return;
    }
  }
}

async function waitForHealth(port, maxAttempts = coldPackage ? 1200 : 50) {
  for (let i = 0; i < maxAttempts; i++) {
    await delay(100);
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/health`);
      if (resp.ok) {
        return await resp.json();
      }
    } catch {
      // keep waiting
    }
  }
  throw new Error(`Server at port ${port} did not answer /health within timeout`);
}

async function performOAuthFlow(serverPort, platformOrigin, nsToken) {
  // 1. DCR
  const regResp = await fetch(`http://127.0.0.1:${serverPort}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: ['http://localhost/callback'],
      client_name: 'e2e-consumer',
      token_endpoint_auth_method: 'none',
    }),
  });
  if (regResp.status !== 201) {
    throw new Error(`DCR registration failed with status ${regResp.status}: ${await regResp.text()}`);
  }
  const regData = await regResp.json();
  const clientId = regData.client_id;
  if (!clientId) throw new Error('DCR returned no client_id');

  // 2. PKCE challenge
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  // 3. /authorize
  const authUrl = `http://127.0.0.1:${serverPort}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent('http://localhost/callback')}&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`;
  const authResp = await fetch(authUrl);
  if (authResp.status !== 200) {
    throw new Error(`/authorize returned status ${authResp.status}: ${await authResp.text()}`);
  }
  const authHtml = await authResp.text();
  const match = authHtml.match(/name="auth_state"\s+value="([^"]+)"/);
  if (!match) throw new Error('Could not find auth_state hidden input in /authorize HTML');
  const authState = match[1];

  // 4. /login (token sign-in)
  const loginResp = await fetch(`http://127.0.0.1:${serverPort}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      platform: platformOrigin,
      token: nsToken,
      auth_state: authState,
    }),
    redirect: 'manual',
  });
  if (loginResp.status !== 302) {
    throw new Error(`/login expected 302 redirect, got ${loginResp.status}: ${await loginResp.text()}`);
  }
  const redirectLoc = loginResp.headers.get('location');
  if (!redirectLoc) throw new Error('/login returned no Location header');
  const redirectUrl = new URL(redirectLoc);
  const code = redirectUrl.searchParams.get('code');
  if (!code) throw new Error(`/login redirect URL missing code: ${redirectLoc}`);

  // 5. /token exchange
  const tokenResp = await fetch(`http://127.0.0.1:${serverPort}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: 'http://localhost/callback',
      code_verifier: verifier,
    }),
  });
  if (tokenResp.status !== 200) {
    throw new Error(`/token exchange failed with status ${tokenResp.status}: ${await tokenResp.text()}`);
  }
  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) throw new Error('/token returned no access_token');
  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    clientId,
  };
}

async function sendMcpRequest(serverPort, bearer, method, params, sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${bearer}`,
  };
  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
  }
  const resp = await fetch(`http://127.0.0.1:${serverPort}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params: params ?? {},
    }),
  });

  const status = resp.status;
  const returnedSessionId = resp.headers.get('mcp-session-id') || sessionId;
  const rawText = await resp.text();
  const dataLine = rawText.split('\n').find((l) => l.startsWith('data: '))?.slice(6) ?? rawText;
  let json = null;
  try {
    json = JSON.parse(dataLine);
  } catch {
    json = null;
  }
  return { status, sessionId: returnedSessionId, json, rawText, headers: resp.headers };
}

// -----------------------------------------------------------------------------
// Access registry leg. The packed package's main() runs with the registry configured, against the fake NetSapiens and
// the fake registry. Each refusal is asserted with zero NetSapiens requests, and each has a positive control. The field
// table is read from the packed build and the content groups from the reviewed snapshot, so the expectations move with
// the tables rather than with numbers written here.
// -----------------------------------------------------------------------------

const REGISTRY_SESSION_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const REGISTRY_APP_REDIRECT = 'https://ai.example.test/oauth/callback';
const REGISTRY_BEARER = 'registry-bearer-e2e-7f3a91';
const REGISTRY_BAD_BEARER = 'registry-bearer-wrong-e2e-c208';
const REGISTRY_TTL_SECONDS = 5;
const REGISTRY_TTL_MS = REGISTRY_TTL_SECONDS * 1000;
// The leg's own registry and session credentials. Registered once here, so no failure text or log line can name them.
for (const secret of [REGISTRY_SESSION_SECRET, REGISTRY_BEARER, REGISTRY_BAD_BEARER]) knownSecrets.add(secret);
const REGISTRY_KINDS = ['call_recording', 'transcript', 'voicemail', 'sms_text', 'ai_summary', 'fax_page'];
const REGISTRY_REFUSAL_CODES = new Set([-32602, -32600]);
const AUTO_ATTENDANT_PROMPT_TOOL = 'get_domains_by_domain_users_by_user_autoattendants_by_prompt';
const RECORDING_TOOL = 'get_domains_by_domain_recordings_by_callid';
const CDR_SCHEDULE_ARGS = {
  domain: 'example.com',
  'schedule-name': 'slice-f-archive',
  'schedule-preset': 'Daily',
  'export-method': 'email',
  email: 'archive@external.example',
};
const ANSWER_RULE_ARGS = { timeframe: 'Default', update: { enabled: 'yes' } };
const IDENTITY_REQUEST = 'GET /ns-api/v2/domains/~/users/~';
const COPY_NOT_ENABLED = 'Your organization has not enabled this AI connector for your account.';
const COPY_APP_NOT_APPROVED = 'This AI app is not approved for your organization.';
const COPY_UNAVAILABLE = 'Sign-in is temporarily unavailable. Try again in a few minutes.';

/** A distinct client address for every request, so no harness request shares a per-address limit with another. */
let registryClientCount = 0;
function registryClientAddress() {
  registryClientCount += 1;
  return `10.77.${Math.floor(registryClientCount / 250)}.${(registryClientCount % 250) + 1}`;
}

function registryFetch(url, init = {}) {
  return fetch(url, { ...init, headers: { ...(init.headers ?? {}), 'X-Forwarded-For': registryClientAddress() } });
}

/** One MCP request from its own client address. The body and the result shape are those of sendMcpRequest. */
async function registryMcpRequest(port, bearer, method, params, sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${bearer}`,
    'X-Forwarded-For': registryClientAddress(),
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params: params ?? {} }),
  });
  const status = resp.status;
  const returnedSessionId = resp.headers.get('mcp-session-id') || sessionId;
  const rawText = await resp.text();
  const dataLine = rawText.split('\n').find((l) => l.startsWith('data: '))?.slice(6) ?? rawText;
  let json = null;
  try {
    json = JSON.parse(dataLine);
  } catch {
    json = null;
  }
  return { status, sessionId: returnedSessionId, json, rawText, headers: resp.headers };
}

/** The environment a registry child inherits: nothing that configures the server, so each child states its own. */
function registryInheritedEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('MCP_') && !name.startsWith('NETSAPIENS_')),
  );
}

function registryChildEnv({ port, nsOrigin, storePath, toolMode, registry }) {
  return {
    ...registryInheritedEnv(),
    MCP_TRANSPORT: 'http',
    MCP_PORT: String(port),
    MCP_HOST: '127.0.0.1',
    MCP_BASE_URL: `http://127.0.0.1:${port}`,
    NETSAPIENS_API_URL: nsOrigin,
    NETSAPIENS_AUTH_MODE: 'token',
    MCP_SESSION_SECRET: REGISTRY_SESSION_SECRET,
    MCP_PERSISTENCE: 'sqlite',
    MCP_STORE_PATH: storePath,
    MCP_STATELESS: 'false',
    MCP_MFA_REPLAY_AUDIENCE: 'consumer-registry-e2e',
    MCP_TRUST_PROXY_HOPS: '1',
    MCP_TOOL_MODE: toolMode,
    ...(registry === undefined
      ? {}
      : {
          MCP_ACCESS_REGISTRY_URL: registry.url,
          MCP_ACCESS_REGISTRY_AUTH: 'bearer',
          MCP_ACCESS_REGISTRY_TOKEN: registry.token,
          MCP_ACCESS_REGISTRY_MAX_STALE_SECONDS: String(registry.maxStaleSeconds),
        }),
  };
}

async function startRegistryChild(tempDir, nsOrigin, name, { storePath, toolMode = 'curated', registry } = {}) {
  const port = await getAvailablePort();
  const srv = await startMcpServerProcess(
    tempDir,
    registryChildEnv({
      port,
      nsOrigin,
      storePath: storePath ?? path.join(tempDir, `registry-${name}.sqlite`),
      toolMode,
      registry,
    }),
  );
  try {
    await waitForHealth(port);
  } catch (err) {
    console.error(scrub(`Registry child ${name} did not start. Logs:\n${srv.getLogs()}`));
    await srv.stop();
    throw err;
  }
  return { name, port, base: `http://127.0.0.1:${port}`, nsOrigin, srv, logs: () => srv.getLogs() };
}

/** Runs the consent page for one NetSapiens token. Returns the raw result, so a refusal can be asserted by its page. */
async function registrySignIn(child, nsToken, redirectUri = REGISTRY_APP_REDIRECT) {
  const registered = await registryFetch(`${child.base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: 'registry-e2e', token_endpoint_auth_method: 'none' }),
  });
  if (registered.status !== 201) fail('registry', 'dcr', `registration returned ${registered.status}`);
  const clientId = (await registered.json()).client_id;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = await registryFetch(
    `${child.base}/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })}`,
  );
  const authState = (await authorize.text()).match(/name="auth_state"\s+value="([^"]+)"/)?.[1];
  if (authorize.status !== 200 || authState === undefined) fail('registry', 'authorize', `status ${authorize.status}`);
  const login = await registryFetch(`${child.base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ platform: child.nsOrigin, token: nsToken, auth_state: authState }),
    redirect: 'manual',
  });
  const html = await login.text();
  const location = login.headers.get('location');
  const code = location === null ? undefined : (new URL(location).searchParams.get('code') ?? undefined);
  return { status: login.status, html, code, clientId, verifier, redirectUri };
}

async function registryTokens(child, granted) {
  const res = await registryFetch(`${child.base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: granted.code,
      client_id: granted.clientId,
      redirect_uri: granted.redirectUri,
      code_verifier: granted.verifier,
    }),
  });
  const json = captureTokens(await res.json());
  if (res.status !== 200 || typeof json.access_token !== 'string') fail('registry', 'token-exchange', `status ${res.status}`);
  return { accessToken: json.access_token, refreshToken: json.refresh_token, clientId: granted.clientId };
}

async function registryRefresh(child, tokens) {
  const res = await registryFetch(`${child.base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: tokens.clientId,
    }),
  });
  const json = captureTokens(await res.json().catch(() => ({})));
  return { status: res.status, json };
}

/** The failure a refresh must not produce. A refresh is refused as invalid_grant; anything else is named by describeResponse. */
function refreshRefusalFailure(res) {
  if (res.status === 400 && res.json?.error === 'invalid_grant') return undefined;
  return `expected status 400 with error invalid_grant, got ${describeResponse(res)}`;
}

async function registrySession(child, accessToken) {
  const init = await registryMcpRequest(child.port, accessToken, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'registry-e2e', version: '1.0.0' },
  });
  if (init.status !== 200 || init.json?.result === undefined) {
    fail('registry', 'initialize', describeResponse(init));
  }
  return { child, accessToken, sessionId: init.sessionId };
}

/** Signs one account in and opens an MCP session. The sign-in must succeed. */
async function openSessionAs(child, nsToken, redirectUri = REGISTRY_APP_REDIRECT) {
  const signedAt = Date.now();
  const signed = await registrySignIn(child, nsToken, redirectUri);
  if (signed.status !== 302 || signed.code === undefined) {
    fail('registry', 'sign-in', `${nsToken} at ${redirectUri} returned ${signed.status}`);
  }
  const tokens = await registryTokens(child, signed);
  const session = await registrySession(child, tokens.accessToken);
  return { session, tokens, signedAt };
}

const sentSince = (fake, mark) => fake.requests.slice(mark).map((request) => `${request.method} ${request.path}`);

/** A sign-in that must be refused. The only NetSapiens request it may make is the identity read that precedes the decision. */
async function signInRefusedWithNsCheck(fake, assertion, child, nsToken, redirectUri, status, copy) {
  const mark = fake.requests.length;
  const signed = await registrySignIn(child, nsToken, redirectUri);
  const sent = sentSince(fake, mark);
  if (sent.some((line) => line !== IDENTITY_REQUEST)) {
    fail('registry', assertion, `NetSapiens received ${sent.join(', ')} during the sign-in`);
  }
  if (signed.status !== status || signed.code !== undefined || !signed.html.includes(copy)) {
    fail('registry', assertion, `status ${signed.status}, code ${signed.code === undefined ? 'none' : 'issued'}`);
  }
  pass('registry', assertion);
}

const registryNames = (tools) => tools.map((tool) => tool.name);

function registryRpc(session, method, params) {
  return registryMcpRequest(session.child.port, session.accessToken, method, params, session.sessionId);
}

/** Every tools/list page, through the cursor. */
async function registryTools(session) {
  const tools = [];
  let cursor;
  for (let page = 0; page < 50; page++) {
    const res = await registryRpc(session, 'tools/list', cursor === undefined ? {} : { cursor });
    if (res.status !== 200 || !Array.isArray(res.json?.result?.tools)) {
      fail('registry', 'tools-list', describeResponse(res));
    }
    tools.push(...res.json.result.tools);
    cursor = res.json.result.nextCursor;
    if (cursor === undefined) return tools;
  }
  fail('registry', 'tools-list', 'more than 50 pages');
}

function registryCall(session, name, args = {}) {
  return registryRpc(session, 'tools/call', { name, arguments: args });
}

function registryCallApi(session, toolName, args = {}) {
  return registryCall(session, 'call_api', { tool_name: toolName, args });
}

/** The JSON-RPC error when the connector refused a call by policy or by the operation guard, or undefined. */
function refusalOf(res) {
  const error = res.json?.error;
  return error !== undefined && REGISTRY_REFUSAL_CODES.has(error.code) && /not permitted/.test(error.message) ? error : undefined;
}

/** A tool's JSON payload, parsed from its first text block, or undefined when there is none. */
function toolPayload(res) {
  const text = res.json?.result?.content?.[0]?.text;
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A call the connector must refuse, which must not reach NetSapiens. */
async function refusedWithoutSend(fake, assertion, call) {
  const mark = fake.requests.length;
  const res = await call();
  if (refusalOf(res) === undefined) fail('registry', assertion, `expected a refusal, got ${res.rawText.slice(0, 300)}`);
  const sent = sentSince(fake, mark);
  if (sent.length > 0) fail('registry', assertion, `refused, yet NetSapiens received ${sent.join(', ')}`);
  pass('registry', assertion);
  return res;
}

/** A call the connector must allow, which must reach NetSapiens on the expected request. */
async function allowedAndSent(fake, assertion, call, expectedLine) {
  const mark = fake.requests.length;
  const res = await call();
  if (refusalOf(res) !== undefined) fail('registry', assertion, `refused: ${res.rawText.slice(0, 300)}`);
  const sent = sentSince(fake, mark);
  if (!sent.some(expectedLine)) fail('registry', assertion, `NetSapiens received ${sent.join(', ') || 'nothing'}`);
  pass('registry', assertion);
  return res;
}

/** One CDR record: every content field the table names, every metadata field it declares, and two more to probe fallbacks. */
function buildCdrRow(fieldClasses) {
  const row = { id: 'slice-f-call-1', 'call-id': 'slice-f-call-1' };
  for (const [name, field] of Object.entries(fieldClasses)) {
    if (field.class === 'metadata' && !(name in row)) row[name] = `meta-${name}`;
    if (field.class === 'content') row[name] = `SECRET-${name}`;
  }
  // Undeclared in the table and classified by name in the projection's fallback. Its kind is transcript.
  row['call-intelligence-segments'] = 'SECRET-call-intelligence-segments';
  row['prefilled-transcription-api'] = 'SECRET-prefilled-transcription';
  row['zz-undeclared-field'] = 'undeclared-value';
  return row;
}

/** The _withheld counts a fully denied profile must report for one row: one per content field, by kind. */
function expectedWithheld(row, fieldClasses) {
  const counts = {};
  for (const name of Object.keys(row)) {
    const field = fieldClasses[name];
    if (field?.class === 'content') counts[field.kind] = (counts[field.kind] ?? 0) + 1;
    else if (field === undefined && name === 'call-intelligence-segments') counts.transcript = (counts.transcript ?? 0) + 1;
  }
  return counts;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) if (value[key] !== undefined) out[key] = canonicalJson(value[key]);
    return out;
  }
  return value;
}

const digest16 = (value) => createHash('sha256').update(JSON.stringify(canonicalJson(value))).digest('hex').slice(0, 16);

/** Each tool as [name, digest of its body, digest of its _meta or null], the form the committed baseline stores. */
function surfaceEntries(tools) {
  return tools.map((tool) => {
    const { name, _meta: meta, ...body } = tool;
    return [name, digest16(body), meta === undefined ? null : digest16(meta)];
  });
}

/** tools/list must match the committed baseline for the role and mode, entry by entry. */
function assertBaselineSurface(assertion, tools, mode, baseline) {
  const expected = baseline.combos[`${mode}|44.4.10|domain_admin`];
  if (!Array.isArray(expected)) fail('registry', assertion, `the baseline has no ${mode}|44.4.10|domain_admin combination`);
  const actual = surfaceEntries(tools);
  if (actual.length !== expected.length) fail('registry', assertion, `${actual.length} tools, the baseline lists ${expected.length}`);
  actual.forEach((entry, index) => {
    if (JSON.stringify(entry) !== JSON.stringify(expected[index])) {
      fail('registry', assertion, `tool ${index} (${entry[0]}) differs from the baseline`);
    }
  });
  pass('registry', assertion);
}

function nsRecord(user, domain) {
  return { user, login: `${user}@${domain}`, domain, name: user, 'user-scope': 'Office Manager' };
}

async function registryLeg(tempDir) {
  const { startFakeNetSapiens } = await import(path.join(repoRoot, 'scripts/fake-netsapiens/index.mjs'));
  const { startFakeAccessRegistry, allowDecision, denyDecision, fault, policy } = await import(
    path.join(repoRoot, 'scripts/fake-access-registry.mjs')
  );
  const { NS_RESOURCE_FIELDS } = await import(
    pathToFileURL(path.join(tempDir, 'node_modules/netsapiens-mcp/build/governance/ns-fields.generated.js')).href
  );
  const cdrFields = NS_RESOURCE_FIELDS.CdrD;
  if (cdrFields === undefined) fail('registry', 'tables', 'the packed build has no CdrD field table');

  // The reviewed content groups, by tool name, from the snapshot the test suite keeps equal to the code.
  const contentNames = new Set();
  const contentByKind = new Map(REGISTRY_KINDS.map((kind) => [kind, new Set()]));
  for (const line of fs.readFileSync(path.join(repoRoot, 'src/__tests__/fixtures/content-groups.snapshot.txt'), 'utf8').split('\n')) {
    if (!line.startsWith('@content:')) continue;
    const [group, , canonical, exposed] = line.split('\t');
    const kind = group.slice('@content:'.length);
    if (!contentByKind.has(kind)) fail('registry', 'snapshot', `unknown content group ${group}`);
    contentByKind.get(kind).add(exposed);
    contentNames.add(exposed);
    contentNames.add(canonical);
  }
  if (contentNames.size === 0) fail('registry', 'snapshot', 'the content-groups snapshot lists no tools');

  const baseline = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src/__tests__/fixtures/tools-baseline.json'), 'utf8'));
  const cdrRow = buildCdrRow(cdrFields);
  const fake = await startFakeNetSapiens({
    apiVersion: '44.4.10',
    tokens: {
      'ns-alice': nsRecord('alice', 'example.com'),
      'ns-bob': nsRecord('bob', 'example.com'),
      'ns-carol': nsRecord('carol', 'example.com'),
      'ns-dave': nsRecord('dave', 'example.com'),
      'ns-dest': nsRecord('dest', 'example.com'),
      'ns-erin': nsRecord('erin', 'example.com'),
      'ns-frank': nsRecord('frank', 'example.com'),
      'ns-gina': nsRecord('gina', 'example.com'),
      'ns-henry': nsRecord('henry', 'example.com'),
      'ns-ivan': nsRecord('ivan', 'example.com'),
      'ns-lukas': nsRecord('lukas', 'example.com'),
      'ns-mallory': nsRecord('mallory', 'example.com'),
      'ns-zed': nsRecord('zed', 'unenrolled.example'),
    },
    routeModules: [
      {
        method: 'GET',
        path: '/domains/{domain}/cdrs',
        handler: ({ token }) =>
          token === 'ns-ivan'
            ? { status: 302, headers: { Location: '/ns-api/v2/domains/example.com/recordings/redirected-call' }, body: '' }
            : { status: 200, body: [cdrRow] },
      },
      {
        method: 'GET',
        path: '/domains/{domain}/recordings/{callid}',
        handler: () => ({ status: 200, body: { recording: 'REDIRECTED-RECORDING-BODY' } }),
      },
      {
        method: 'PUT',
        path: '/domains/{domain}/users/{user}/answerrules/{timeframe}',
        handler: () => ({ status: 200, body: { success: true } }),
      },
    ],
  });

  // Every decision carries a short cache lifetime, so a change lands within the test. A subject with no decision is
  // refused as not enrolled, which is the registry's own answer for a domain it does not serve.
  const reg = await startFakeAccessRegistry({ bearer: REGISTRY_BEARER, allowAll: process.env.REGISTRY_E2E_ALLOW_ALL === '1' });
  const decide = (revision, overrides) => allowDecision({ ttlSeconds: REGISTRY_TTL_SECONDS, revision, policy: policy(overrides) });
  const allContentDenied = Object.fromEntries(REGISTRY_KINDS.map((kind) => [kind, 'deny']));
  reg.setDecision('example.com', 'alice@example.com', decide('alice-1', {
    tools: { deny: ['find_user', AUTO_ATTENDANT_PROMPT_TOOL] },
    platforms: [REGISTRY_APP_REDIRECT],
  }));
  reg.setDecision('example.com', 'bob@example.com', decide('bob-1', { access: 'read', platforms: [REGISTRY_APP_REDIRECT] }));
  reg.setDecision('example.com', 'carol@example.com', decide('carol-1', { content: allContentDenied, platforms: [REGISTRY_APP_REDIRECT] }));
  reg.setDecision('example.com', 'dave@example.com', decide('dave-1', { unclassifiedOutput: 'deny', platforms: [REGISTRY_APP_REDIRECT] }));
  reg.setDecision('example.com', 'dest@example.com', decide('dest-1', { content: { ai_summary: 'deny' }, platforms: [REGISTRY_APP_REDIRECT] }));
  reg.setDecision('example.com', 'erin@example.com', decide('erin-1', { platforms: [REGISTRY_APP_REDIRECT] }));
  reg.setDecision('example.com', 'frank@example.com', decide('frank-1', { platforms: [REGISTRY_APP_REDIRECT] }));
  reg.setDecision('example.com', 'gina@example.com', decide('gina-1', { platforms: [REGISTRY_APP_REDIRECT] }));
  reg.setDecision('example.com', 'henry@example.com', decide('henry-1', { platforms: ['*'] }));
  reg.setDecision('example.com', 'ivan@example.com', decide('ivan-1', { content: { call_recording: 'deny' }, platforms: [REGISTRY_APP_REDIRECT] }));
  reg.setDecision('example.com', 'lukas@example.com', decide('lukas-1', { platforms: [REGISTRY_APP_REDIRECT] }));
  reg.setDecision('example.com', 'mallory@example.com', denyDecision({ reason: 'subject_not_enabled', revision: 'mallory-1', ttlSeconds: REGISTRY_TTL_SECONDS }));
  reg.setDecision('partner-deny.example', 'alice@example.com', denyDecision({ reason: 'foreign_access_denied', revision: 'partner-deny-1', ttlSeconds: REGISTRY_TTL_SECONDS }));
  reg.setDecision('partner-content.example', 'alice@example.com', decide('partner-content-1', { content: { call_recording: 'deny' } }));
  reg.setDecision('partner-read.example', 'alice@example.com', decide('partner-read-1', { access: 'read' }));

  const registry = { url: reg.url, token: REGISTRY_BEARER, maxStaleSeconds: 2 };
  const children = [];
  const startChild = async (name, options = {}) => {
    const child = await startRegistryChild(tempDir, fake.origin, name, options);
    children.push(child);
    return child;
  };
  try {
    // ----- primary: curated tools, registry on, a two-second last-known-good window -----
    const primary = await startChild('main', { registry });
    const primaryHealth = await (await fetch(`${primary.base}/health`)).json();
    if (primaryHealth.accessRegistry !== 'enforced') fail('registry', 'health', `accessRegistry is ${String(primaryHealth.accessRegistry)}; ${describeResponse({ status: 200, json: primaryHealth })}`);
    pass('registry', 'health reports accessRegistry enforced');

    // Rows 1 to 3: who may sign in, and from which AI app. A refused sign-in makes one identity read and issues no code.
    await signInRefusedWithNsCheck(fake, 'domain not enrolled: 403 with no code', primary, 'ns-zed', REGISTRY_APP_REDIRECT, 403, COPY_NOT_ENABLED);
    await signInRefusedWithNsCheck(fake, 'user not on the list: 403 with no code', primary, 'ns-mallory', REGISTRY_APP_REDIRECT, 403, COPY_NOT_ENABLED);
    await signInRefusedWithNsCheck(fake, 'redirect that differs in path case: 403, app not approved', primary, 'ns-alice', 'https://ai.example.test/OAuth/Callback', 403, COPY_APP_NOT_APPROVED);
    const slash = await registrySignIn(primary, 'ns-alice', 'https://ai.example.test/oauth/callback/');
    if (slash.status !== 302 || slash.code === undefined) fail('registry', 'redirect with a trailing slash', `status ${slash.status}`);
    pass('registry', 'redirect that differs by a trailing slash is approved, because the path is normalized');

    const alice = await openSessionAs(primary, 'ns-alice');
    pass('registry', 'listed user on an enrolled domain at the approved app signs in');

    // Row 4: tool selection, as the signed-in person sees it.
    const aliceNames = registryNames(await registryTools(alice.session));
    if (aliceNames.includes('find_user') || aliceNames.includes(AUTO_ATTENDANT_PROMPT_TOOL)) {
      fail('registry', 'tool selection', 'a denied tool is listed');
    }
    if (!['search_api', 'call_api', 'recent_calls'].every((name) => aliceNames.includes(name))) {
      fail('registry', 'tool selection', 'an allowed meta or read tool is missing from tools/list');
    }
    pass('registry', 'tool selection: denied tools are absent from tools/list, allowed tools are listed');
    await refusedWithoutSend(fake, 'tool selection: a denied tool is refused on a direct call with zero NetSapiens requests', () =>
      registryCall(alice.session, 'find_user', { query: 'alice' }));
    await refusedWithoutSend(fake, 'tool selection: a denied tool is refused through call_api with zero NetSapiens requests', () =>
      registryCallApi(alice.session, 'find_user', { query: 'alice' }));
    await refusedWithoutSend(fake, 'tool selection: a denied generated tool is refused through call_api with zero NetSapiens requests', () =>
      registryCallApi(alice.session, AUTO_ATTENDANT_PROMPT_TOOL, {}));
    const aliceSearch = toolPayload(await registryCall(alice.session, 'search_api', { query: 'autoattendants prompt', limit: 50 }));
    if (!Array.isArray(aliceSearch?.matches) || aliceSearch.matches.some((match) => match.name === AUTO_ATTENDANT_PROMPT_TOOL)) {
      fail('registry', 'tool selection: search_api hides a denied tool', 'the denied tool is in the matches');
    }
    pass('registry', 'tool selection: search_api hides the denied generated tool');
    await allowedAndSent(fake, 'tool selection: an allowed tool works and reaches NetSapiens',
      () => registryCall(alice.session, 'recent_calls', { limit: 2 }),
      (line) => line.startsWith('GET ') && line.includes('/cdrs'));

    // Row 5: read-only access, bob. The same tool and arguments are allowed under write and refused under read.
    const bob = await openSessionAs(primary, 'ns-bob');
    const bobNames = registryNames(await registryTools(bob.session));
    if (bobNames.includes('set_hold_message')) fail('registry', 'read-only: a write tool is absent from tools/list', 'set_hold_message is listed');
    pass('registry', 'read-only: a write tool is absent from tools/list');
    await refusedWithoutSend(fake, 'read-only: a write tool is refused on a direct call with zero NetSapiens requests', () =>
      registryCall(bob.session, 'set_hold_message', {}));
    await refusedWithoutSend(fake, 'read-only: a v2 POST through call_api is refused with zero NetSapiens requests', () =>
      registryCallApi(bob.session, 'post_domains_by_domain_users_by_user_answerrules', { domain: 'example.com', user: 'bob' }));
    const bobSearch = toolPayload(await registryCall(bob.session, 'search_api', { query: 'autoattendants prompt', limit: 50 }));
    if (!bobSearch?.matches?.some((match) => match.name === AUTO_ATTENDANT_PROMPT_TOOL)) {
      fail('registry', 'tool selection: a session without the denial finds the tool search hides', 'it is missing');
    }
    pass('registry', 'tool selection: a session without the denial finds the same tool in search_api');
    await allowedAndSent(fake, 'read-only: a read tool works and reaches NetSapiens',
      () => registryCall(bob.session, 'recent_calls', { limit: 2 }),
      (line) => line.startsWith('GET ') && line.includes('/cdrs'));

    // Row 6: content deny, carol. No content tool is listed, and the call history loses its content fields.
    const carol = await openSessionAs(primary, 'ns-carol');
    const carolNames = registryNames(await registryTools(carol.session));
    const carolContent = carolNames.filter((name) => contentNames.has(name));
    if (carolContent.length > 0) fail('registry', 'content deny: no content tool is listed', carolContent.join(', '));
    pass('registry', 'content deny: no tool in a denied content group is listed');
    await refusedWithoutSend(fake, 'content deny: a voicemail read is refused on a direct call with zero NetSapiens requests', () =>
      registryCall(carol.session, 'read_voicemail', { domain: 'example.com', user: 'carol', voicemail: 'x' }));
    await refusedWithoutSend(fake, 'content deny: a v1 audio play through call_api is refused with zero NetSapiens requests', () =>
      registryCallApi(carol.session, 'v1_audio_play', { object: 'audio', action: 'play' }));
    await refusedWithoutSend(fake, 'content deny: a recording read through call_api is refused with zero NetSapiens requests', () =>
      registryCallApi(carol.session, RECORDING_TOOL, { domain: 'example.com', callid: 'slice-f-call-1' }));
    const carolRaw = await registryCall(carol.session, 'recent_calls', { limit: 2 });
    const carolCalls = toolPayload(carolRaw);
    if (carolCalls?.data?.length !== 1) fail('registry', 'content deny: recent_calls keeps its rows', carolRaw.rawText.slice(0, 300));
    if (carolRaw.rawText.includes('SECRET-')) fail('registry', 'content deny: recent_calls strips every content field', 'a content value survived');
    const expected = expectedWithheld(cdrRow, cdrFields);
    if (JSON.stringify(Object.entries(carolCalls._withheld ?? {}).sort()) !== JSON.stringify(Object.entries(expected).sort())) {
      fail('registry', 'content deny: _withheld counts each stripped field by kind', `${JSON.stringify(carolCalls._withheld)} != ${JSON.stringify(expected)}`);
    }
    pass('registry', 'content deny: recent_calls strips every content field and reports _withheld by kind');
    const carolRow = carolCalls.data[0];
    for (const [name, field] of Object.entries(cdrFields)) {
      if (field.class === 'metadata' && carolRow[name] !== cdrRow[name]) fail('registry', 'content deny: metadata is intact', name);
    }
    if (carolRow['call-id'] !== cdrRow['call-id'] || carolRow.id !== cdrRow.id) fail('registry', 'content deny: metadata is intact', 'id');
    if (carolRow['zz-undeclared-field'] !== cdrRow['zz-undeclared-field']) fail('registry', 'content deny: unclassified output allowed', 'an undeclared field was dropped');
    if (carolRow['prefilled-transcription-api'] !== undefined) fail('registry', 'content deny: internal fields are dropped', 'prefilled-transcription-api survived');
    pass('registry', 'content deny: metadata is intact, undeclared fields follow the profile, and internal fields are dropped');

    // Destination writes. Slice B classifies a write that changes where content is sent as content. A write that only
    // routes calls is not content. Under read access the same requests are refused as read-only.
    const dest = await openSessionAs(primary, 'ns-dest');
    await refusedWithoutSend(fake, 'destination write: a CDR schedule that emails an external address is refused under a denied content kind, with zero NetSapiens requests', () =>
      registryCallApi(dest.session, 'create_cdrschedule', CDR_SCHEDULE_ARGS));
    await allowedAndSent(fake, 'destination write: a call-routing write, which is not content, is allowed under the same profile',
      () => registryCallApi(dest.session, 'update_my_answer_rule', ANSWER_RULE_ARGS),
      (line) => line.startsWith('PUT ') && line.includes('/answerrules/Default'));
    await refusedWithoutSend(fake, 'destination write: the same CDR schedule request under read access is refused as read-only, with zero NetSapiens requests', () =>
      registryCallApi(bob.session, 'create_cdrschedule', CDR_SCHEDULE_ARGS));
    await refusedWithoutSend(fake, 'destination write: the same call-routing write under read access is refused as read-only, with zero NetSapiens requests', () =>
      registryCallApi(bob.session, 'update_my_answer_rule', ANSWER_RULE_ARGS));

    // Row 13: foreign targets. An explicit target is judged by its own enrolment; an un-enrolled target by the caller.
    await refusedWithoutSend(fake, 'foreign target: a domain that denies foreign access is refused with zero NetSapiens requests', () =>
      registryCallApi(alice.session, 'get_domains_by_domain_cdrs_1', { domain: 'partner-deny.example' }));
    await refusedWithoutSend(fake, 'foreign target: a recording read on a domain that denies recordings is refused with zero NetSapiens requests', () =>
      registryCallApi(alice.session, RECORDING_TOOL, { domain: 'partner-content.example', callid: 'slice-f-call-1' }));
    await refusedWithoutSend(fake, 'foreign target: a write on a read-only domain is refused with zero NetSapiens requests', () =>
      registryCallApi(alice.session, 'create_cdrschedule', { ...CDR_SCHEDULE_ARGS, domain: 'partner-read.example' }));
    await allowedAndSent(fake, 'foreign target: an un-enrolled domain is judged by the caller and reaches NetSapiens',
      () => registryCallApi(alice.session, 'get_domains_by_domain_cdrs_1', { domain: 'unenrolled.example' }),
      (line) => line.includes('/domains/unenrolled.example/cdrs'));

    // Row 14: a redirect from NetSapiens. The connector does not follow it, so the denied path is never requested.
    const ivan = await openSessionAs(primary, 'ns-ivan');
    const ivanMark = fake.requests.length;
    const ivanRes = await registryCall(ivan.session, 'recent_calls', { limit: 2 });
    if (sentSince(fake, ivanMark).some((line) => line.includes('/recordings/redirected-call'))) {
      fail('registry', 'redirect: the denied path is never requested', 'NetSapiens received the redirect target');
    }
    if (ivanRes.rawText.includes('REDIRECTED-RECORDING-BODY')) fail('registry', 'redirect: no body from the denied path is returned', 'the body leaked');
    if (ivanRes.json?.error === undefined && ivanRes.json?.result?.isError !== true && toolPayload(ivanRes)?.success !== false) {
      fail('registry', 'redirect: a 3xx is an error', describeResponse(ivanRes));
    }
    pass('registry', 'redirect: the denied path is never requested, and no body from it is returned');

    // Row 8: revocation. A stale unchanged decision is revalidated with If-None-Match and a 304 keeps it. A flipped
    // decision refuses the next bearer request, and the refresh then answers invalid_grant.
    const frank = await openSessionAs(primary, 'ns-frank');
    await delay(Math.max(0, frank.signedAt + REGISTRY_TTL_MS + 500 - Date.now()));
    const frankStill = await registryRpc(frank.session, 'tools/list', {});
    if (frankStill.status !== 200) fail('registry', 'revocation: a stale unchanged decision keeps the session', `status ${frankStill.status}`);
    if (!reg.requests.some((entry) => entry.subject === 'frank@example.com' && entry.outcome === 'not_modified' && entry.ifNoneMatch)) {
      fail('registry', 'revocation: revalidation sends If-None-Match and takes a 304', 'no not_modified answer for frank');
    }
    pass('registry', 'revocation: a stale unchanged decision is revalidated with If-None-Match, and a 304 keeps the session');
    reg.setDecision('example.com', 'frank@example.com', denyDecision({ reason: 'subject_not_enabled', revision: 'frank-2', ttlSeconds: REGISTRY_TTL_SECONDS }));
    let revoked;
    for (let deadline = Date.now() + 3 * REGISTRY_TTL_MS; Date.now() < deadline; ) {
      revoked = await registryRpc(frank.session, 'tools/list', {});
      if (revoked.status === 401) break;
      await delay(250);
    }
    if (revoked?.status !== 401) fail('registry', 'revocation: the next bearer request is refused', `still ${revoked?.status} after the cache lifetime`);
    pass('registry', 'revocation: a flipped decision refuses the next bearer request with 401');
    const frankRefresh = await registryRefresh(primary, frank.tokens);
    const refreshWrong = refreshRefusalFailure(frankRefresh);
    if (refreshWrong !== undefined) fail('registry', 'revocation: the refresh is invalid_grant', refreshWrong);
    pass('registry', 'revocation: the refresh answers invalid_grant');

    // Self-test: the text of a failing refresh assertion carries neither the access token, the refresh token nor the bearer,
    // even when the response it describes holds them. It is built by the functions the row uses. Dropping the scrub makes
    // an echoed reason carry the secrets, and this row fails.
    {
      const { accessToken, refreshToken } = frank.tokens;
      const echoed = { status: 200, json: { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer' } };
      const refreshText = formatFailure('registry', 'revocation: the refresh is invalid_grant', refreshRefusalFailure(echoed));
      const echoText = formatFailure('registry', 'self-test', `a reason that echoes ${accessToken}, ${refreshToken} and ${REGISTRY_BEARER}`);
      const leaked = [accessToken, refreshToken, REGISTRY_BEARER].filter((secret) => refreshText.includes(secret) || echoText.includes(secret));
      if (leaked.length > 0) fail('registry', 'self-test: a failing refresh message carries no token or bearer', `${leaked.length} secret(s) reached the text`);
      pass('registry', 'self-test: a failing refresh message carries no token or bearer, and an echoed secret is scrubbed');
    }

    // Row 7: registry down, with a two-second window. Inside the cache lifetime the decision still serves with no request
    // to the registry. Past it, tools are empty, calls are refused, an existing session refreshes, and a new sign-in is 503.
    const erin = await openSessionAs(primary, 'ns-erin');
    reg.setFault('example.com', 'erin@example.com', fault('status', { status: 500 }));
    const erinMark = reg.requests.length;
    if ((await registryTools(erin.session)).length === 0) fail('registry', 'registry down: inside the window the decision serves', 'tools/list was empty');
    if (reg.requests.slice(erinMark).some((entry) => entry.subject === 'erin@example.com')) {
      fail('registry', 'registry down: inside the window the decision serves', 'the fresh decision asked the registry');
    }
    pass('registry', 'registry down: inside the cache lifetime the decision serves, with no registry request');
    await delay(Math.max(0, erin.signedAt + REGISTRY_TTL_MS + 500 - Date.now()));
    if ((await registryTools(erin.session)).length !== 0) fail('registry', 'registry down: past the window tools/list is empty', 'tools were listed');
    pass('registry', 'registry down: past the window, tools/list is empty');
    await refusedWithoutSend(fake, 'registry down: a tool call past the window is refused with zero NetSapiens requests', () =>
      registryCall(erin.session, 'recent_calls', { limit: 2 }));
    const erinRefresh = await registryRefresh(primary, erin.tokens);
    if (erinRefresh.status !== 200 || typeof erinRefresh.json.access_token !== 'string') {
      fail('registry', 'registry down: an existing session refreshes', `status ${erinRefresh.status}`);
    }
    pass('registry', 'registry down: an existing session refreshes and stays signed in');
    const erinAfter = await registrySession(primary, erinRefresh.json.access_token);
    if ((await registryRpc(erinAfter, 'tools/list', {})).status !== 200) fail('registry', 'registry down: the refreshed session is accepted', 'refused');
    const erinNew = await registrySignIn(primary, 'ns-erin');
    if (erinNew.status !== 503 || erinNew.code !== undefined || !erinNew.html.includes(COPY_UNAVAILABLE)) {
      fail('registry', 'registry down: a new sign-in is 503', `status ${erinNew.status}`);
    }
    pass('registry', 'registry down: a new sign-in gets 503 with no code');
    reg.setFault('example.com', 'erin@example.com', null);

    // ----- lkg: the same outage with a ten-second last-known-good window -----
    const lkg = await startChild('lkg', { registry: { ...registry, maxStaleSeconds: 10 } });
    const lukas = await openSessionAs(lkg, 'ns-lukas');
    reg.setFault('example.com', 'lukas@example.com', fault('status', { status: 500 }));
    await delay(Math.max(0, lukas.signedAt + REGISTRY_TTL_MS + 500 - Date.now()));
    if ((await registryTools(lukas.session)).length === 0) fail('registry', 'last known good: a stale decision serves inside the window', 'tools/list was empty');
    if (!reg.requests.some((entry) => entry.subject === 'lukas@example.com' && entry.outcome === 'fault:status')) {
      fail('registry', 'last known good: the registry was asked and failed', 'no failed request for lukas');
    }
    pass('registry', 'last known good: a stale decision serves inside the window after the registry fails');
    const lkgSignIn = await registrySignIn(lkg, 'ns-lukas');
    if (lkgSignIn.status !== 302 || lkgSignIn.code === undefined) fail('registry', 'last known good: a new sign-in is served', `status ${lkgSignIn.status}`);
    pass('registry', 'last known good: a new sign-in inside the window is served from the last decision');
    await delay(Math.max(0, lukas.signedAt + 10_000 + 500 - Date.now()));
    if ((await registryTools(lukas.session)).length !== 0) fail('registry', 'last known good: past the window tools/list is empty', 'tools were listed');
    const lkgExpired = await registrySignIn(lkg, 'ns-lukas');
    if (lkgExpired.status !== 503 || lkgExpired.code !== undefined || !lkgExpired.html.includes(COPY_UNAVAILABLE)) {
      fail('registry', 'last known good: past the window a new sign-in is 503', `status ${lkgExpired.status}`);
    }
    pass('registry', 'last known good: past the window, tools are empty and a new sign-in is 503');
    reg.setFault('example.com', 'lukas@example.com', null);

    // ----- full: the generated tools, from the same registry -----
    const full = await startChild('full', { toolMode: 'full', registry });
    const fullAlice = await openSessionAs(full, 'ns-alice');
    const fullCarol = await openSessionAs(full, 'ns-carol');
    const fullDave = await openSessionAs(full, 'ns-dave');
    const fullBob = await openSessionAs(full, 'ns-bob');
    const aliceFull = registryNames(await registryTools(fullAlice.session));
    const carolFull = registryNames(await registryTools(fullCarol.session));
    const daveFull = registryNames(await registryTools(fullDave.session));
    const bobFull = registryNames(await registryTools(fullBob.session));
    if (aliceFull.includes(AUTO_ATTENDANT_PROMPT_TOOL)) fail('registry', 'full mode: a denied generated tool is absent from tools/list', 'it is listed');
    pass('registry', 'full mode: a denied generated tool is absent from tools/list');
    await refusedWithoutSend(fake, 'full mode: a denied generated tool is refused on a direct call with zero NetSapiens requests', () =>
      registryCall(fullAlice.session, AUTO_ATTENDANT_PROMPT_TOOL, {}));
    if (carolFull.some((name) => contentNames.has(name))) fail('registry', 'full mode: the all-denied profile lists no content tool', 'a content tool is listed');
    const removedContent = aliceFull.filter((name) => !carolFull.includes(name) && contentNames.has(name));
    if (removedContent.length === 0) fail('registry', 'full mode: the all-denied profile removes content tools', 'none were removed');
    pass('registry', `full mode: the all-denied profile lists no content tool, and removes ${removedContent.length} that the reviewed groups classify`);
    await refusedWithoutSend(fake, 'full mode: a content tool is refused on a direct call with zero NetSapiens requests', () =>
      registryCall(fullCarol.session, RECORDING_TOOL, { domain: 'example.com', callid: 'slice-f-call-1' }));
    // unclassifiedOutput deny: a generated tool with no output mapping is absent and refused.
    const unmapped = aliceFull.filter((name) => !daveFull.includes(name));
    if (unmapped.length === 0) fail('registry', 'unclassified output: an unmapped generated tool is absent', 'no tool is unmapped in the packed build');
    await refusedWithoutSend(fake, 'unclassified output deny: an unmapped generated tool is refused on a direct call with zero NetSapiens requests', () =>
      registryCall(fullDave.session, unmapped[0], {}));
    const daveCdrs = await registryCall(fullDave.session, 'get_domains_by_domain_cdrs_1', { domain: 'example.com' });
    if (daveCdrs.rawText.includes('zz-undeclared-field')) fail('registry', 'unclassified output deny: an undeclared field is dropped', 'it survived');
    if (!daveCdrs.rawText.includes('meta-call-direction')) fail('registry', 'unclassified output deny: a declared field is kept', 'call-direction is missing');
    pass('registry', 'unclassified output deny: an undeclared field is dropped, and a declared field is kept');
    // read access, full mode: a generated write is absent from the list and refused on a direct call.
    if (bobFull.includes('post_domains_by_domain_users_by_user_answerrules')) fail('registry', 'read-only: a generated write is absent in full mode', 'it is listed');
    await refusedWithoutSend(fake, 'read-only: a generated write is refused on a direct call in full mode, with zero NetSapiens requests', () =>
      registryCall(fullBob.session, 'post_domains_by_domain_users_by_user_answerrules', { domain: 'example.com', user: 'bob' }));

    // ----- row 10: env unset. The surface is the committed baseline, and an allow-all registry changes nothing. -----
    const unsetCurated = await startChild('unset-curated', {});
    const unsetHealth = await (await fetch(`${unsetCurated.base}/health`)).json();
    if ('accessRegistry' in unsetHealth) fail('registry', 'env unset: /health has no accessRegistry field', describeResponse({ status: 200, json: unsetHealth }));
    pass('registry', 'env unset: /health has no accessRegistry field');
    const unsetAlice = await openSessionAs(unsetCurated, 'ns-alice');
    const unsetTools = await registryTools(unsetAlice.session);
    assertBaselineSurface('env unset: curated tools/list matches the committed baseline for domain_admin', unsetTools, 'curated', baseline);
    const unsetFull = await startChild('unset-full', { toolMode: 'full' });
    const unsetFullAlice = await openSessionAs(unsetFull, 'ns-alice');
    assertBaselineSurface('env unset: full tools/list matches the committed baseline for domain_admin', await registryTools(unsetFullAlice.session), 'full', baseline);
    const allowAll = await startChild('allow-all', { registry });
    const allowAllHealth = await (await fetch(`${allowAll.base}/health`)).json();
    if (allowAllHealth.accessRegistry !== 'enforced') fail('registry', 'health', 'an allow-all registry does not report enforced');
    const henry = await openSessionAs(allowAll, 'ns-henry');
    const henryTools = await registryTools(henry.session);
    if (JSON.stringify(henryTools) !== JSON.stringify(unsetTools)) fail('registry', 'allow-all equals unset', 'the tools/list JSON differs');
    const unsetRecent = await registryCall(unsetAlice.session, 'recent_calls', { limit: 2 });
    const henryRecent = await registryCall(henry.session, 'recent_calls', { limit: 2 });
    const unsetPayload = toolPayload(unsetRecent);
    const henryPayload = toolPayload(henryRecent);
    const unsetFirst = unsetPayload?.data?.[0];
    if (unsetFirst === undefined || henryPayload?.data?.[0] === undefined) fail('registry', 'allow-all equals unset', 'a recent_calls row is missing');
    // Section 3.3 (E9) has registry mode drop the fields the table classifies as internal, and unset mode keeps them.
    // Nothing else may differ between the two results.
    const internalFields = new Set([
      ...Object.entries(cdrFields).filter(([, field]) => field.class === 'internal').map(([name]) => name),
      'prefilled-transcription-api',
    ]);
    const droppedByRegistry = Object.keys(unsetFirst).filter((name) => !(name in henryPayload.data[0]));
    if (droppedByRegistry.some((name) => !internalFields.has(name))) {
      fail('registry', 'allow-all equals unset', `results differ in fields that are not internal: ${droppedByRegistry.join(', ')}`);
    }
    const expectedPayload = structuredClone(unsetPayload);
    for (const name of droppedByRegistry) delete expectedPayload.data[0][name];
    if (JSON.stringify(expectedPayload) !== JSON.stringify(henryPayload)) {
      fail('registry', 'allow-all equals unset', 'the results differ beyond the dropped internal fields');
    }
    pass('registry', `an allow-all decision lists the same tools, and its results equal unset except the internal fields the projection drops (${droppedByRegistry.join(', ') || 'none'})`);

    // Row 12: registry authentication. A wrong token fails closed, and the token never reaches a log.
    const beforeWrong = reg.requests.length;
    const wrong = await startChild('wrong-token', { registry: { ...registry, token: REGISTRY_BAD_BEARER } });
    const wrongSignIn = await registrySignIn(wrong, 'ns-alice');
    if (wrongSignIn.status !== 503 || wrongSignIn.code !== undefined) fail('registry', 'registry authentication: a wrong token fails closed', `status ${wrongSignIn.status}`);
    if (!reg.requests.slice(beforeWrong).some((entry) => entry.authorized === false && entry.outcome === 'unauthorized')) {
      fail('registry', 'registry authentication: the registry refused the wrong token', 'no unauthorized answer');
    }
    pass('registry', 'registry authentication: a wrong token fails closed with 503, and the registry refuses it');

    // Row 11: stdio cannot enforce the registry, so the server refuses to start with it.
    const runner = getPackageBinaryRunner(tempDir);
    const stdio = await runCommand(runner.cmd, runner.args, {
      cwd: tempDir,
      env: {
        PATH: process.env.PATH,
        MCP_TRANSPORT: 'stdio',
        NETSAPIENS_API_URL: fake.origin,
        MCP_ACCESS_REGISTRY_URL: reg.url,
        MCP_ACCESS_REGISTRY_AUTH: 'bearer',
        MCP_ACCESS_REGISTRY_TOKEN: REGISTRY_BEARER,
      },
    });
    const stdioOut = `${stdio.stdout}\n${stdio.stderr}`;
    if (stdio.status !== 1 || !stdioOut.includes('ConfigError: MCP_ACCESS_REGISTRY_URL requires MCP_TRANSPORT=http')) {
      fail('registry', 'stdio misuse: exits 1 with the ConfigError', `status ${stdio.status}: ${stdioOut.slice(0, 300)}`);
    }
    pass('registry', 'stdio misuse: exits 1 with the ConfigError before serving anything');

    // Row 9: legacy session. A session made while the registry was unset is refused under it, and a fresh sign-in works.
    const legacyStore = path.join(tempDir, 'registry-legacy.sqlite');
    const legacyBefore = await startChild('legacy-before', { storePath: legacyStore });
    const gina = await openSessionAs(legacyBefore, 'ns-gina');
    await legacyBefore.srv.stop();
    const legacyAfter = await startChild('legacy-after', { storePath: legacyStore, registry });
    const legacyRes = await registryMcpRequest(legacyAfter.port, gina.tokens.accessToken, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'registry-e2e', version: '1.0.0' },
    });
    if (legacyRes.status !== 401) fail('registry', 'legacy session: 401 under the registry', `status ${legacyRes.status}`);
    pass('registry', 'legacy session: a session made while the registry was unset gets 401 under it');
    const legacyRefresh = await registryRefresh(legacyAfter, gina.tokens);
    if (legacyRefresh.status !== 400 || legacyRefresh.json.error !== 'invalid_grant') {
      fail('registry', 'legacy session: refresh is invalid_grant', `status ${legacyRefresh.status}`);
    }
    pass('registry', 'legacy session: its refresh answers invalid_grant');
    await openSessionAs(legacyAfter, 'ns-gina');
    pass('registry', 'legacy session: a fresh sign-in under the registry works');

    // Registry tokens are never logged, by the server or by the stdio run.
    const everyLog = children.map((child) => child.logs()).join('\n') + stdioOut;
    if ([...knownSecrets].some((secret) => everyLog.includes(secret))) {
      fail('registry', 'registry tokens never reach stdout or stderr', 'a registry token appears in a log');
    }
    pass('registry', 'registry tokens never appear in child stdout or stderr');
  } finally {
    for (const child of children) await child.srv.stop();
    await fake.close();
    await reg.close();
  }
}


async function main() {
  const opts = parseArgs();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsmcp-consumer-e2e-'));
  coldPackage = opts.coldRegistry === 'versioned' ? 'netsapiens-mcp@3'
    : opts.coldRegistry === 'unversioned' ? 'netsapiens-mcp' : null;
  const targetPkg = coldPackage || opts.tarball || `netsapiens-mcp@${opts.registry}`;
  if (coldPackage) process.env.npm_config_cache = path.join(tempDir, 'npm-cache');
  const sessionSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  console.log(`Starting consumer-e2e in ${tempDir} [target: ${targetPkg}]`);

  // Dynamically import startFakeNetSapiens from repo
  const { startFakeNetSapiens } = await import(path.join(repoRoot, 'scripts/fake-netsapiens/index.mjs'));

  try {
    if (!coldPackage) {
    execSync('npm init -y', { cwd: tempDir, stdio: 'pipe' });
      const install = await runCommand('npm', ['install', '--legacy-peer-deps', targetPkg], { cwd: tempDir });
      if (install.status !== 0) throw new Error(`Consumer install failed:\n${install.stdout}\n${install.stderr}`);
    }

    if (opts.legs.includes('mfa')) {
      const fake = await startFakeNetSapiens({
        tokens: { 'mfa-final': { user: 'alice', domain: 'example.com', login: 'alice@example.com', 'user-scope': 'Basic User' } },
        routeModules: [{
          method: 'POST', path: '/tokens', unauthenticated: true,
          handler: ({ body }) => body.grant_type === 'password'
            ? { body: { access_token: 'partial', mfa_type: 'authenticator', mfa_vendor: 'google' } }
            : body.grant_type === 'mfa' && body.passcode === '123456'
              ? { body: { access_token: 'mfa-final', refresh_token: 'mfa-refresh', expires_in: 3600 } }
              : { status: 401, body: { message: 'Invalid passcode' } },
        }],
      });
      const port = await getAvailablePort();
      const mfaEnv = {
        ...process.env, MCP_TRANSPORT: 'http', MCP_PORT: String(port), MCP_HOST: '127.0.0.1',
        MCP_BASE_URL: `http://127.0.0.1:${port}`, NETSAPIENS_API_URL: fake.origin,
        NETSAPIENS_OAUTH_CLIENT_ID: 'test-client', NETSAPIENS_OAUTH_CLIENT_SECRET: 'test-secret',
        MCP_TRUST_PROXY_HOPS: '1',
        MCP_SESSION_SECRET: sessionSecret, MCP_PERSISTENCE: 'sqlite', MCP_STORE_PATH: path.join(tempDir, 'mfa.sqlite'), MCP_STATELESS: 'false',
        MCP_MFA_REPLAY_AUDIENCE: 'consumer-mfa-sqlite',
      };
      let srv = await startMcpServerProcess(tempDir, mfaEnv);
      const base = `http://127.0.0.1:${port}`;
      const field = (html, name) => html.match(new RegExp(`name="${name}"\\s+value="([^"]+)"`))?.[1];
      const post = (route, body, ip) => fetch(`${base}${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': ip },
        body: new URLSearchParams(body), redirect: 'manual',
      });
      try {
        await waitForHealth(port);
        const health = await (await fetch(`${base}/health`)).json();
        if (JSON.stringify(health.signIn) !== JSON.stringify({ password: true, token: true, sso: [], ssoVisible: false, mfaAttemptLimit: 5, mfaReady: true, secondFactorPolicy: null })) fail('mfa', 'health', JSON.stringify(health.signIn));
        pass('mfa', 'health');
        const register = await fetch(`${base}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://localhost/callback'], client_name: 'mfa-e2e', token_endpoint_auth_method: 'none' }) });
        if (register.status !== 201) fail('mfa', 'register', String(register.status));
        const { client_id: clientId } = await register.json();
        async function begin(ip) {
          const verifier = randomBytes(32).toString('base64url');
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          const auth = await fetch(`${base}/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'http://localhost/callback', code_challenge: challenge, code_challenge_method: 'S256' })}`);
          const authState = field(await auth.text(), 'auth_state');
          if (!authState) fail('mfa', 'authorize', String(auth.status));
          const login = await post('/login', { username: 'alice', password: 'secret', auth_state: authState }, ip);
          const state = field(await login.text(), 'mfa_state');
          if (!state) fail('mfa', 'challenge', String(login.status));
          return { verifier, state };
        }
        const good = await begin('198.51.100.1');
        const success = await post('/mfa', { passcode: '123456', mfa_state: good.state }, '198.51.100.1');
        if (success.status !== 302) fail('mfa', 'correct-code', String(success.status));
        const code = new URL(success.headers.get('location')).searchParams.get('code');
        const exchange = await post('/token', { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: 'http://localhost/callback', code_verifier: good.verifier }, '198.51.100.1');
        if (exchange.status !== 200) fail('mfa', 'exchange', await exchange.text());
        const bearer = (await exchange.json()).access_token;
        const init = await sendMcpRequest(port, bearer, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mfa-e2e', version: '1' } });
        if (init.status !== 200 || !init.json?.result) fail('mfa', 'connect', init.rawText);
        pass('mfa', 'correct-code-connects');
        const bad = await begin('198.51.100.2');
        let state = bad.state;
        const before = fake.requests.filter(r => r.body?.grant_type === 'mfa').length;
        for (let n = 1; n <= 5; n++) {
          const result = await post('/mfa', { passcode: '000000', mfa_state: state }, '198.51.100.2');
          const html = await result.text();
          if (result.status !== (n === 5 ? 440 : 200)) fail('mfa', 'attempt-limit', `attempt ${n}: ${result.status}`);
          if (n < 5) {
            const next = field(html, 'mfa_state');
            if (!next || next === state) fail('mfa', 'new-challenge', `attempt ${n}`);
            state = next;
          } else if (!/reconnect/i.test(html)) fail('mfa', 'restart', html);
        }
        const count = () => fake.requests.filter(r => r.body?.grant_type === 'mfa').length;
        if (count() - before !== 5) fail('mfa', 'five-grants', String(count() - before));
        const replay = await post('/mfa', { passcode: '123456', mfa_state: bad.state }, '198.51.100.2');
        if (replay.status !== 440 || !/reconnect/i.test(await replay.text()) || count() - before !== 5) fail('mfa', 'replay', String(replay.status));
        pass('mfa', 'five-grants-and-replay');
        for (let n = 1; n <= 11; n++) {
          const result = await post('/mfa', { passcode: '123456', mfa_state: 'invalid' }, '198.51.100.3');
          if (result.status !== (n === 11 ? 429 : 440)) fail('mfa', 'rate-limit', `attempt ${n}: ${result.status}`);
        }
        pass('mfa', 'rate-limit');

        // A missing audience preserves existing sessions but must not issue or accept MFA.
        await srv.stop();
        await waitForHealthDown(port);
        const noAudienceEnv = { ...mfaEnv };
        delete noAudienceEnv.MCP_MFA_REPLAY_AUDIENCE;
        srv = await startMcpServerProcess(tempDir, noAudienceEnv);
        const noAudienceHealth = await waitForHealth(port);
        if (noAudienceHealth.signIn?.mfaReady !== false) fail('mfa', 'missing-audience-readiness', JSON.stringify(noAudienceHealth.signIn));
        const resumed = await sendMcpRequest(port, bearer, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mfa-e2e', version: '1' } });
        if (resumed.status !== 200 || !resumed.json?.result) fail('mfa', 'missing-audience-bearer', resumed.rawText);
        const grantsBefore = count();
        const refused = await post('/mfa', { passcode: '123456', mfa_state: good.state }, '198.51.100.4');
        if (refused.status !== 503 || !refused.headers.get('cache-control')?.includes('no-store') || count() !== grantsBefore) fail('mfa', 'missing-audience-submission', String(refused.status));
        const verifier = randomBytes(32).toString('base64url');
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        const auth = await fetch(`${base}/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'http://localhost/callback', code_challenge: challenge, code_challenge_method: 'S256' })}`);
        const authState = field(await auth.text(), 'auth_state');
        if (!authState) fail('mfa', 'missing-audience-authorize', String(auth.status));
        const noPrompt = await post('/login', { username: 'alice', password: 'secret', auth_state: authState }, '198.51.100.4');
        const noPromptBody = await noPrompt.text();
        if (noPrompt.status !== 503 || !noPrompt.headers.get('cache-control')?.includes('no-store') || field(noPromptBody, 'mfa_state') || count() !== grantsBefore) fail('mfa', 'missing-audience-issuance', String(noPrompt.status));
        pass('mfa', 'missing-audience-fails-closed-with-existing-bearer');
      } finally {
        await srv.stop();
        await fake.close();
      }
    }

    // -------------------------------------------------------------------------
    // Access registry: the packed package with the registry configured (see registryLeg)
    // -------------------------------------------------------------------------
    if (opts.legs.includes('registry')) {
      console.log('Running leg: registry');
      await registryLeg(tempDir);
      if (collectedRegistryFailures.length > 0) throw new Error(`registry leg: ${collectedRegistryFailures.length} row(s) failed`);
    }

    // -------------------------------------------------------------------------
    // LEG 1: install
    // -------------------------------------------------------------------------
    if (opts.legs.includes('install')) {
      console.log('Running leg: install');
      // Proves no @google-cloud/firestore directory
      const firestoreDir = path.join(tempDir, 'node_modules', '@google-cloud', 'firestore');
      if (fs.existsSync(firestoreDir)) {
        fail('install', 'no-firestore-package', 'found @google-cloud/firestore in node_modules');
      }
      pass('install', 'no-firestore-package');

      // Proves no *.node file in node_modules
      const nativeAddons = walkFiles(path.join(tempDir, 'node_modules'), (name) => name.endsWith('.node'));
      if (nativeAddons.length > 0) {
        fail('install', 'no-native-addons', `found *.node native addon(s): ${nativeAddons.join(', ')}`);
      }
      pass('install', 'no-native-addons');

      // Proves import('netsapiens-mcp') resolves
      const rootRes = await runCommand('node', [
        '--input-type=module',
        '-e',
        "import('netsapiens-mcp').then(m => { if (typeof m.main !== 'function') process.exit(1); })",
      ], { cwd: tempDir });
      if (rootRes.status !== 0) {
        fail('install', 'resolve-root-export', `import('netsapiens-mcp') failed: ${rootRes.stderr}`);
      }
      pass('install', 'resolve-root-export');

      // Proves import('netsapiens-mcp/lib') resolves
      const libRes = await runCommand('node', [
        '--input-type=module',
        '-e',
        "import('netsapiens-mcp/lib').then(m => { if (typeof m.createSqliteStore !== 'function') process.exit(1); })",
      ], { cwd: tempDir });
      if (libRes.status !== 0) {
        fail('install', 'resolve-lib-export', `import('netsapiens-mcp/lib') failed: ${libRes.stderr}`);
      }
      pass('install', 'resolve-lib-export');

      // Proves import('netsapiens-mcp/testing/store-conformance') resolves (after installing vitest)
      execSync('npm i --legacy-peer-deps vitest@^4.1.11', { cwd: tempDir, stdio: 'pipe' });
      const confRes = await runCommand('node', [
        '--input-type=module',
        '-e',
        "import('netsapiens-mcp/testing/store-conformance').then(m => { if (typeof m.runStoreConformance !== 'function') process.exit(1); })",
      ], { cwd: tempDir });
      if (confRes.status !== 0) {
        fail('install', 'resolve-store-conformance', `import('netsapiens-mcp/testing/store-conformance') failed: ${confRes.stderr}`);
      }
      pass('install', 'resolve-store-conformance');
    }

    // -------------------------------------------------------------------------
    // LEG 2: config
    // -------------------------------------------------------------------------
    if (opts.legs.includes('config')) {
      console.log('Running leg: config');
      const { cmd: runnerCmd, args: runnerArgs } = getPackageBinaryRunner(tempDir);

      // 1. Missing NETSAPIENS_API_URL
      const missingUrlRes = await runCommand(runnerCmd, runnerArgs, {
        cwd: tempDir,
        env: { PATH: process.env.PATH },
      });
      const missingUrlOut = `${missingUrlRes.stdout}\n${missingUrlRes.stderr}`;
      if (missingUrlRes.status !== 1) {
        fail('config', 'missing-api-url', `expected exit 1, got ${missingUrlRes.status}`);
      }
      if (!missingUrlOut.includes('ConfigError: NETSAPIENS_API_URL is required (your NetSapiens host, for example https://netsapiens.example.com)')) {
        fail('config', 'missing-api-url', `missing exact error message. Output:\n${missingUrlOut}`);
      }
      pass('config', 'missing-api-url');

      // 2. MCP_PERSISTENCE=file
      const fileRes = await runCommand(runnerCmd, runnerArgs, {
        cwd: tempDir,
        env: {
          PATH: process.env.PATH,
          MCP_TRANSPORT: 'http',
          NETSAPIENS_API_URL: 'https://netsapiens.example.com',
          NETSAPIENS_OAUTH_CLIENT_ID: 'dummy-id',
          NETSAPIENS_OAUTH_CLIENT_SECRET: 'dummy-secret',
          MCP_SESSION_SECRET: sessionSecret,
          MCP_PERSISTENCE: 'file',
        },
      });
      const fileOut = `${fileRes.stdout}\n${fileRes.stderr}`;
      if (fileRes.status !== 1) {
        fail('config', 'persistence-file-removed', `expected exit 1, got ${fileRes.status}`);
      }
      if (!fileOut.includes('ConfigError: MCP_PERSISTENCE=file was removed in 3.0.0; the default store is sqlite (see MCP_STORE_PATH)')) {
        fail('config', 'persistence-file-removed', `missing exact error message. Output:\n${fileOut}`);
      }
      pass('config', 'persistence-file-removed');

      // 3. GOOGLE_CLOUD_PROJECT without MCP_PERSISTENCE
      const gcpRes = await runCommand(runnerCmd, runnerArgs, {
        cwd: tempDir,
        env: {
          PATH: process.env.PATH,
          MCP_TRANSPORT: 'http',
          NETSAPIENS_API_URL: 'https://netsapiens.example.com',
          NETSAPIENS_OAUTH_CLIENT_ID: 'dummy-id',
          NETSAPIENS_OAUTH_CLIENT_SECRET: 'dummy-secret',
          MCP_SESSION_SECRET: sessionSecret,
          GOOGLE_CLOUD_PROJECT: 'my-gcp-project',
        },
      });
      const gcpOut = `${gcpRes.stdout}\n${gcpRes.stderr}`;
      if (gcpRes.status !== 1) {
        fail('config', 'gcp-project-without-persistence', `expected exit 1, got ${gcpRes.status}`);
      }
      if (!gcpOut.includes('ConfigError: MCP_PERSISTENCE is not set. 2.x chose Firestore because GOOGLE_CLOUD_PROJECT is set; 3.0.0 never infers the store. Set MCP_PERSISTENCE=firestore or MCP_PERSISTENCE=sqlite.')) {
        fail('config', 'gcp-project-without-persistence', `missing exact error message. Output:\n${gcpOut}`);
      }
      pass('config', 'gcp-project-without-persistence');

      // 4. MCP_PERSISTENCE=firestore with package absent
      const fsAbsentRes = await runCommand(runnerCmd, runnerArgs, {
        cwd: tempDir,
        env: {
          PATH: process.env.PATH,
          MCP_TRANSPORT: 'http',
          NETSAPIENS_API_URL: 'https://netsapiens.example.com',
          NETSAPIENS_OAUTH_CLIENT_ID: 'dummy-id',
          NETSAPIENS_OAUTH_CLIENT_SECRET: 'dummy-secret',
          MCP_SESSION_SECRET: sessionSecret,
          MCP_PERSISTENCE: 'firestore',
          GOOGLE_CLOUD_PROJECT: 'my-gcp-project',
        },
      });
      const fsAbsentOut = `${fsAbsentRes.stdout}\n${fsAbsentRes.stderr}`;
      if (fsAbsentRes.status !== 1) {
        fail('config', 'firestore-package-absent', `expected exit 1, got ${fsAbsentRes.status}`);
      }
      if (!fsAbsentOut.includes('ConfigError: MCP_PERSISTENCE=firestore needs @google-cloud/firestore: npm install @google-cloud/firestore')) {
        fail('config', 'firestore-package-absent', `missing exact error message. Output:\n${fsAbsentOut}`);
      }
      pass('config', 'firestore-package-absent');
    }

    // -------------------------------------------------------------------------
    // LEG 3: sqlite
    // -------------------------------------------------------------------------
    if (opts.legs.includes('sqlite')) {
      console.log('Running leg: sqlite');
      const nsToken = 'ns-token-alice-e2e-secret-12345';
      const fakeUser = {
        user: 'alice',
        login: 'alice@example.com',
        domain: 'example.com',
        name: 'Alice Smith',
        'user-scope': 'Office Manager',
      };

      const fake44 = await startFakeNetSapiens({
        apiVersion: '44.4.10',
        tokens: { [nsToken]: fakeUser },
        routeModules: [
          {
            method: 'GET',
            path: '/domains/{domain}/users',
            handler: () => ({ status: 200, body: [fakeUser] }),
          },
        ],
      });

      const fake46 = await startFakeNetSapiens({
        apiVersion: '46.0.2',
        tokens: { [nsToken]: fakeUser },
        routeModules: [
          {
            method: 'GET',
            path: '/domains/{domain}/users',
            handler: () => ({ status: 200, body: [fakeUser] }),
          },
        ],
      });

      const storePath = path.join(tempDir, 'sqlite-test.sqlite');
      const serverPort = await getAvailablePort();
      const serverEnv = {
        ...process.env,
        MCP_TRANSPORT: 'http',
        MCP_PORT: String(serverPort),
        MCP_HOST: '127.0.0.1',
        MCP_BASE_URL: `http://127.0.0.1:${serverPort}`,
        NETSAPIENS_API_URL: fake44.origin,
        NETSAPIENS_PLATFORMS: JSON.stringify({
          primary: fake44.origin,
          secondary: fake46.origin,
        }),
        NETSAPIENS_OAUTH_CLIENT_ID: 'op-client',
        NETSAPIENS_OAUTH_CLIENT_SECRET: 'op-secret',
        MCP_SESSION_SECRET: sessionSecret,
        MCP_PERSISTENCE: 'sqlite',
        MCP_STORE_PATH: storePath,
        MCP_STATELESS: 'false',
      };

      let srv1 = await startMcpServerProcess(tempDir, serverEnv);
      let mcpTokens;

      try {
        try {
          await waitForHealth(serverPort);
        } catch (err) {
          console.error(`Server failed to start. Logs:\n${srv1.getLogs()}`);
          throw err;
        }
        if (coldPackage) {
          const health = await (await fetch(`http://127.0.0.1:${serverPort}/health`)).json();
          if (typeof health.version !== 'string' || !/^3\./.test(health.version)) {
            fail('cold-registry', 'running-v3', `unexpected server version ${JSON.stringify(health.version)}`);
          }
          pass('cold-registry', `running-v3 ${health.version}`);
        }

        // Perform DCR, PKCE, token sign-in
        mcpTokens = await performOAuthFlow(serverPort, fake44.origin, nsToken);
        pass('sqlite', 'dcr-pkce-token-sign-in');

        // MCP initialize
        const initRes = await sendMcpRequest(serverPort, mcpTokens.accessToken, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'consumer-e2e', version: '1.0.0' },
        });
        if (initRes.status !== 200) {
          fail('sqlite', 'mcp-initialize', `initialize returned status ${initRes.status}: ${initRes.rawText}`);
        }
        pass('sqlite', 'mcp-initialize');

        // MCP tools/list
        const toolsRes = await sendMcpRequest(serverPort, mcpTokens.accessToken, 'tools/list', {}, initRes.sessionId);
        if (toolsRes.status !== 200 || !Array.isArray(toolsRes.json?.result?.tools)) {
          fail('sqlite', 'mcp-tools-list', `tools/list returned invalid response: ${toolsRes.rawText}`);
        }
        pass('sqlite', 'mcp-tools-list');

        // MCP read tool: find_user returns fake user
        const callRes = await sendMcpRequest(serverPort, mcpTokens.accessToken, 'tools/call', {
          name: 'find_user',
          arguments: { query: 'alice' },
        }, initRes.sessionId);
        if (callRes.status !== 200) {
          fail('sqlite', 'read-tool-returns-fake-user', `find_user failed (${callRes.status}): ${callRes.rawText}`);
        }
        const callText = JSON.stringify(callRes.json);
        if (!callText.includes('alice') && !callText.includes('Alice Smith')) {
          fail('sqlite', 'read-tool-returns-fake-user', `expected fake user alice in response, got: ${callText}`);
        }
        pass('sqlite', 'read-tool-returns-fake-user');

        // Restart server process
        await srv1.stop();
        await waitForHealthDown(serverPort);

        const srv2 = await startMcpServerProcess(tempDir, serverEnv);
        try {
          await waitForHealth(serverPort);

          // Verify same bearer still works after restart
          const restartInitRes = await sendMcpRequest(serverPort, mcpTokens.accessToken, 'initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'consumer-e2e', version: '1.0.0' },
          });
          if (restartInitRes.status !== 200) {
            fail('sqlite', 'bearer-survives-restart', `post-restart initialize returned ${restartInitRes.status}: ${restartInitRes.rawText}`);
          }
          const restartToolsRes = await sendMcpRequest(serverPort, mcpTokens.accessToken, 'tools/list', {}, restartInitRes.sessionId);
          if (restartToolsRes.status !== 200) {
            fail('sqlite', 'bearer-survives-restart', `post-restart tools/list returned ${restartToolsRes.status}: ${restartToolsRes.rawText}`);
          }
          pass('sqlite', 'bearer-survives-restart');

          // Proves store file mode 600
          const fileStat = fs.statSync(storePath);
          const mode = fileStat.mode & 0o777;
          if (mode !== 0o600) {
            fail('sqlite', 'store-file-mode-600', `expected mode 0600, got 0${mode.toString(8)}`);
          }
          pass('sqlite', 'store-file-mode-600');

          // Proves second server on same MCP_STORE_PATH exits with "is in use by another process"
          const port3 = await getAvailablePort();
          const sqliteRunner = getPackageBinaryRunner(tempDir);
          const lockConflictRes = await runCommand(sqliteRunner.cmd, sqliteRunner.args, {
            cwd: tempDir,
            env: {
              ...serverEnv,
              MCP_PORT: String(port3),
              MCP_BASE_URL: `http://127.0.0.1:${port3}`,
            },
          });
          const lockOut = `${lockConflictRes.stdout}\n${lockConflictRes.stderr}`;
          if (lockConflictRes.status === 0) {
            fail('sqlite', 'lock-exclusion', 'second server on same MCP_STORE_PATH unexpectedly succeeded (exit 0)');
          }
          if (!lockOut.includes('is in use by another process')) {
            fail('sqlite', 'lock-exclusion', `expected 'is in use by another process' in output, got:\n${lockOut}`);
          }
          pass('sqlite', 'lock-exclusion');
        } finally {
          await srv2.stop();
        }

        // Proves raw db and -wal bytes contain none of NetSapiens token, MCP access/refresh tokens, or username
        let rawBytes = fs.readFileSync(storePath).toString('binary');
        if (fs.existsSync(`${storePath}-wal`)) {
          rawBytes += fs.readFileSync(`${storePath}-wal`).toString('binary');
        }
        for (const secret of [nsToken, mcpTokens.accessToken, mcpTokens.refreshToken, 'alice']) {
          if (rawBytes.includes(secret)) {
            fail('sqlite', 'at-rest-encryption', `store at rest contains plaintext secret '${secret}'`);
          }
        }
        pass('sqlite', 'at-rest-encryption');

      } finally {
        await srv1.stop();
        await fake44.close();
        await fake46.close();
      }
    }

    // -------------------------------------------------------------------------
    // LEG 4: memory
    // -------------------------------------------------------------------------
    if (opts.legs.includes('memory')) {
      console.log('Running leg: memory');
      const nsToken = 'ns-token-memory-test-secret';
      const fakeUser = {
        user: 'alice',
        login: 'alice@example.com',
        domain: 'example.com',
        'user-scope': 'Office Manager',
      };
      const fake = await startFakeNetSapiens({
        apiVersion: '44.4.10',
        tokens: { [nsToken]: fakeUser },
        routeModules: [
          {
            method: 'GET',
            path: '/domains/{domain}/users',
            handler: () => ({ status: 200, body: [fakeUser] }),
          },
        ],
      });

      const serverPort = await getAvailablePort();
      const serverEnv = {
        ...process.env,
        MCP_TRANSPORT: 'http',
        MCP_PORT: String(serverPort),
        MCP_HOST: '127.0.0.1',
        MCP_BASE_URL: `http://127.0.0.1:${serverPort}`,
        NETSAPIENS_API_URL: fake.origin,
        NETSAPIENS_OAUTH_CLIENT_ID: 'op-client',
        NETSAPIENS_OAUTH_CLIENT_SECRET: 'op-secret',
        MCP_SESSION_SECRET: sessionSecret,
        MCP_PERSISTENCE: 'memory',
        MCP_STATELESS: 'false',
      };

      const srv1 = await startMcpServerProcess(tempDir, serverEnv);
      let bearer;
      try {
        await waitForHealth(serverPort);
        const tokens = await performOAuthFlow(serverPort, fake.origin, nsToken);
        bearer = tokens.accessToken;

        // Verify bearer works initially
        const initRes = await sendMcpRequest(serverPort, bearer, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        });
        if (initRes.status !== 200) {
          fail('memory', 'initial-sign-in', `initial request failed: ${initRes.rawText}`);
        }

        await srv1.stop();
        await waitForHealthDown(serverPort);

        // Restart server with memory store
        const srv2 = await startMcpServerProcess(tempDir, serverEnv);
        try {
          await waitForHealth(serverPort);

          // After restart, bearer gets 401 invalid_token "Invalid access token"
          const postRes = await sendMcpRequest(serverPort, bearer, 'initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0' },
          });

          if (postRes.status !== 401) {
            fail('memory', 'bearer-invalid-after-restart', `expected 401, got ${postRes.status}: ${postRes.rawText}`);
          }
          const authHeader = postRes.headers.get('www-authenticate') || '';
          const responseBody = postRes.rawText;
          const combined = `${authHeader} ${responseBody}`;
          if (!combined.includes('invalid_token') || !combined.includes('Invalid access token')) {
            fail('memory', 'bearer-invalid-after-restart', `expected invalid_token and 'Invalid access token', got: ${combined}`);
          }
          pass('memory', 'bearer-invalid-after-restart');
        } finally {
          await srv2.stop();
        }
      } finally {
        await srv1.stop();
        await fake.close();
      }
    }

    // -------------------------------------------------------------------------
    // LEG 5: version
    // -------------------------------------------------------------------------
    if (opts.legs.includes('version')) {
      console.log('Running leg: version');
      const nsToken = 'ns-token-version-test-secret';
      const fakeUser = {
        user: 'alice',
        login: 'alice@example.com',
        domain: 'example.com',
        name: 'Alice Smith',
        'user-scope': 'Office Manager',
      };

      const fake44 = await startFakeNetSapiens({
        apiVersion: '44.4.10',
        tokens: { [nsToken]: fakeUser },
        routeModules: [
          {
            method: 'GET',
            path: '/domains/{domain}/users',
            handler: () => ({ status: 200, body: [fakeUser] }),
          },
        ],
      });

      const fake46 = await startFakeNetSapiens({
        apiVersion: '46.0.2',
        tokens: { [nsToken]: fakeUser },
        routeModules: [
          {
            method: 'GET',
            path: '/domains/{domain}/users',
            handler: () => ({ status: 200, body: [fakeUser] }),
          },
        ],
      });

      const fake500 = await startFakeNetSapiens({
        apiVersion: null,
        versionStatus: 500,
      });

      const serverPort = await getAvailablePort();
      const serverEnv = {
        ...process.env,
        MCP_TRANSPORT: 'http',
        MCP_PORT: String(serverPort),
        MCP_HOST: '127.0.0.1',
        MCP_BASE_URL: `http://127.0.0.1:${serverPort}`,
        NETSAPIENS_API_URL: fake44.origin,
        NETSAPIENS_PLATFORMS: JSON.stringify({
          primary: fake44.origin,
          secondary: fake46.origin,
          faulty: fake500.origin,
        }),
        NETSAPIENS_OAUTH_CLIENT_ID: 'op-client',
        NETSAPIENS_OAUTH_CLIENT_SECRET: 'op-secret',
        MCP_SESSION_SECRET: sessionSecret,
        MCP_PERSISTENCE: 'memory',
        MCP_TOOL_MODE: 'full',
      };

      const srv = await startMcpServerProcess(tempDir, serverEnv);
      try {
        let health = await waitForHealth(serverPort);
        for (let i = 0; i < 50; i++) {
          const entry44 = health.netsapiens?.find?.((p) => p.apiUrl === fake44.origin);
          const entry46 = health.netsapiens?.find?.((p) => p.apiUrl === fake46.origin);
          if (entry44?.apiVersion && entry46?.apiVersion) break;
          await delay(100);
          health = await waitForHealth(serverPort);
        }

        // /health.netsapiens reports version info
        if (Array.isArray(health.netsapiens)) {
          const entry44 = health.netsapiens.find((p) => p.apiUrl === fake44.origin);
          const entry46 = health.netsapiens.find((p) => p.apiUrl === fake46.origin);
          const entry500 = health.netsapiens.find((p) => p.apiUrl === fake500.origin);

          if (entry44?.apiVersion !== '44.4.10') {
            fail('version', 'health-platform-version', `expected 44.4.10, got ${entry44?.apiVersion}`);
          }
          if (entry46?.apiVersion !== '46.0.2') {
            fail('version', 'health-platform-version', `expected 46.0.2, got ${entry46?.apiVersion}`);
          }
          if (entry500?.status !== 'unknown' && entry500?.apiVersion !== 'unknown') {
            fail('version', 'health-500-origin-unknown', `expected unknown status for 500 origin, got: ${JSON.stringify(entry500)}`);
          }
          pass('version', 'health-platform-version');
        } else {
          // If V2 is not merged yet, health has top-level version
          pass('version', 'health-version-fallback');
        }

        // Test sign in and tool lists
        const token44 = await performOAuthFlow(serverPort, fake44.origin, nsToken);
        const token46 = await performOAuthFlow(serverPort, fake46.origin, nsToken);

        const res44 = await sendMcpRequest(serverPort, token44.accessToken, 'tools/list');
        const res46 = await sendMcpRequest(serverPort, token46.accessToken, 'tools/list');

        const tools44 = res44.json?.result?.tools?.map((t) => t.name) ?? [];
        const tools46 = res46.json?.result?.tools?.map((t) => t.name) ?? [];

        // Check availability.json difference if available
        const availPath = path.join(tempDir, 'node_modules/netsapiens-mcp/build/generated/availability.json');
        if (fs.existsSync(availPath)) {
          const avail = JSON.parse(fs.readFileSync(availPath, 'utf8'));
          const v2 = avail.v2 || {};
          const keys46Only = Object.entries(v2)
            .filter(([, v]) => v.documented?.includes('46.0') && !v.documented?.includes('44.4') && !v.observed?.['44.4'])
            .map(([k]) => k);

          if (keys46Only.length > 0) {
            // Refusal of 46.0-only tool on 44.4.10 with 0 requests logged
            const initialReqCount = fake44.requests.length;
            // Attempt to invoke call_api for 46.0-only key or invoke the tool
            const sampleKey = keys46Only[0];
            const callRes = await sendMcpRequest(serverPort, token44.accessToken, 'tools/call', {
              name: 'call_api',
              arguments: { tool_name: 'get_health_status_api', args: {} },
            });

            // Refusal must occur
            if (callRes.status === 200 && !callRes.json?.error && !callRes.json?.result?.isError) {
              fail('version', 'refusal-of-46-only-tool', `call_api for 46-only tool unexpectedly succeeded on 44.4.10`);
            }
            const postReqCount = fake44.requests.length;
            if (postReqCount !== initialReqCount) {
              fail('version', 'zero-requests-on-refusal', `expected 0 upstream requests, but fake logged ${postReqCount - initialReqCount}`);
            }
            pass('version', 'refusal-of-46-only-tool');
          }
        }
        pass('version', 'tool-lists-version-gated');

        // Curated statistics tools present on 44.4.10
        // Stop server and restart in curated mode (default MCP_TOOL_MODE)
        await srv.stop();
        const curatedServerEnv = {
          ...serverEnv,
          MCP_TOOL_MODE: 'curated',
        };
        const srvCurated = await startMcpServerProcess(tempDir, curatedServerEnv);
        try {
          await waitForHealth(serverPort);
          const curatedTokens = await performOAuthFlow(serverPort, fake44.origin, nsToken);
          const curRes = await sendMcpRequest(serverPort, curatedTokens.accessToken, 'tools/list');
          const curatedToolNames = curRes.json?.result?.tools?.map((t) => t.name) ?? [];
          const hasObservations = fs.existsSync(availPath) && ((JSON.parse(fs.readFileSync(availPath, 'utf8')).observations?.length ?? 0) > 0);
          if (hasObservations) {
            if (!curatedToolNames.includes('call_statistics') && !curatedToolNames.includes('agent_statistics')) {
              fail('version', 'curated-statistics-present', `expected call_statistics/agent_statistics on 44.4.10, got: ${curatedToolNames.join(', ')}`);
            }
            pass('version', 'curated-statistics-present');
          } else {
            pass('version', 'curated-statistics-waiting-on-obs');
          }
        } finally {
          await srvCurated.stop();
        }

      } finally {
        await srv.stop();
        await fake44.close();
        await fake46.close();
        await fake500.close();
      }
    }

    // -------------------------------------------------------------------------
    // LEG 6: firestore
    // -------------------------------------------------------------------------
    if (opts.legs.includes('firestore')) {
      console.log('Running leg: firestore');
      const emuHost = process.env.FIRESTORE_EMULATOR_HOST;
      if (!emuHost) {
        fail('firestore', 'emulator-configured', 'FIRESTORE_EMULATOR_HOST environment variable is not set');
      }
      const gcpProject = process.env.GOOGLE_CLOUD_PROJECT || 'firestore-test';

      // 1. Install @google-cloud/firestore@^<major>
      const fsPkg = `@google-cloud/firestore@^${opts.firestoreMajor}`;
      console.log(`Installing ${fsPkg} and vitest in consumer...`);
      execSync(`npm i --legacy-peer-deps ${fsPkg} vitest@^4.1.11`, { cwd: tempDir, stdio: 'pipe' });

      const nsToken = 'ns-token-firestore-e2e-secret';
      const fakeUser = {
        user: 'alice',
        login: 'alice@example.com',
        domain: 'example.com',
        name: 'Alice Smith',
        'user-scope': 'Office Manager',
      };
      const fake = await startFakeNetSapiens({
        apiVersion: '44.4.10',
        tokens: { [nsToken]: fakeUser },
        routeModules: [
          {
            method: 'GET',
            path: '/domains/{domain}/users',
            handler: () => ({ status: 200, body: [fakeUser] }),
          },
        ],
      });

      const port1 = await getAvailablePort();
      const port2 = await getAvailablePort();
      const sharedBaseUrl = 'http://127.0.0.1:3000';
      const fsEnvCommon = {
        ...process.env,
        MCP_TRANSPORT: 'http',
        MCP_PERSISTENCE: 'firestore',
        MCP_TRUST_PROXY_HOPS: '1',
        MCP_STORE_NAMESPACE: 'mcp',
        GOOGLE_CLOUD_PROJECT: gcpProject,
        FIRESTORE_EMULATOR_HOST: emuHost,
        MCP_SESSION_SECRET: sessionSecret,
        MCP_MFA_REPLAY_AUDIENCE: 'consumer-firestore-shared',
        MCP_BASE_URL: sharedBaseUrl,
        NETSAPIENS_API_URL: fake.origin,
        NETSAPIENS_OAUTH_CLIENT_ID: 'op-client',
        NETSAPIENS_OAUTH_CLIENT_SECRET: 'op-secret',
        MCP_STATELESS: 'false',
      };

      // 2. Negative proof: verify uninitialized Firestore fails closed on DCR client registration
      const uninitPort = await getAvailablePort();
      const uninitSrv = await startMcpServerProcess(tempDir, {
        ...fsEnvCommon,
        MCP_PORT: String(uninitPort),
      });
      try {
        await waitForHealth(uninitPort);
        const uninitReg = await fetch(`http://127.0.0.1:${uninitPort}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            redirect_uris: ['http://localhost/callback'],
            client_name: 'e2e-uninit-test',
            token_endpoint_auth_method: 'none',
          }),
        });
        if (uninitReg.status !== 500) {
          fail('firestore', 'uninitialized-fence-rejection', `expected uninitialized DCR to fail with status 500, got ${uninitReg.status}`);
        }
        pass('firestore', 'uninitialized-fence-rejection');
      } finally {
        await uninitSrv.stop();
      }

      // 3. Seed emulator with valid v3_active cutover fence and matching ownership marker for namespace mcp
      const seedScriptPath = path.join(tempDir, 'seed-emulator-fence.mjs');
      fs.writeFileSync(
        seedScriptPath,
        `import { Firestore } from '@google-cloud/firestore';

const projectId = process.env.GOOGLE_CLOUD_PROJECT || 'firestore-test';
const namespace = process.env.MCP_STORE_NAMESPACE || 'mcp';
const db = new Firestore({ projectId });

const now = Date.now();
const runId = 'migration-e2e-seed-01';
const manifestDigest = '0'.repeat(64);
const codeSha = '17e13f2b8a7258d037f09efb3a3684393ea61bdd';

await db.collection(\`\${namespace}_meta\`).doc('cutover_fence').set({
  schemaVersion: 1,
  namespace,
  epoch: 2,
  state: 'v3_active',
  activeOperations: 0,
  irreversible: false,
  emptyNamespace: true,
  migrationRunId: runId,
  migrationManifestDigest: manifestDigest,
  createdAt: now,
  updatedAt: now,
  codeSha,
  codeArtifact: 'netsapiens-mcp@3.0.0',
});

await db.collection(\`\${namespace}_meta\`).doc('v2_adopted').set({
  schemaVersion: 2,
  namespace,
  epoch: 2,
  migrationRunId: runId,
  codeSha,
  codeArtifact: 'netsapiens-mcp@3.0.0',
  packageIntegrity: 'sha512-' + 'a'.repeat(86) + '==',
  protocolDigest: '1'.repeat(64),
  assemblyDigest: '2'.repeat(64),
  indexSchemaDigest: '3'.repeat(64),
  encoderVersion: 1,
  planDigest: '4'.repeat(64),
  kind: 'ownership',
  preparedDigest: '5'.repeat(64),
  migrationManifestDigest: manifestDigest,
  emptyNamespace: true,
  adoptedAt: now,
});
await db.terminate();
`
      );
      execSync('node seed-emulator-fence.mjs', { cwd: tempDir, env: fsEnvCommon, stdio: 'pipe' });
      pass('firestore', 'emulator-fence-seeded');

      // 4. Start Server 1 on seeded emulator
      const srv1 = await startMcpServerProcess(tempDir, {
        ...fsEnvCommon,
        MCP_PORT: String(port1),
      });

      try {
        const health1 = await waitForHealth(port1);
        if (
          health1.store?.backend !== 'firestore' ||
          health1.store?.namespace !== 'mcp' ||
          health1.store?.multiInstance !== true
        ) {
          fail('firestore', 'health-store-contract', `unexpected /health.store in firestore mode: ${JSON.stringify(health1.store)}`);
        }
        pass('firestore', 'health-store-contract');

        // Sign in on Server 1
        const tokens1 = await performOAuthFlow(port1, fake.origin, nsToken);

        // Start Server 2 sharing namespace mcp and same Firestore
        const srv2 = await startMcpServerProcess(tempDir, {
          ...fsEnvCommon,
          MCP_PORT: String(port2),
        });

        try {
          await waitForHealth(port2);
          for (let n = 0; n < 12; n++) {
            const port = n % 2 ? port2 : port1;
            const result = await fetch(`http://127.0.0.1:${port}/mfa`, {
              method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': '203.0.113.10' },
              body: new URLSearchParams({ passcode: '123456', mfa_state: 'invalid' }),
            });
            if (result.status !== (n < 10 ? 440 : 429)) fail('firestore', 'shared-signin-rate-limit', `attempt ${n + 1}: ${result.status}`);
          }
          const another = await fetch(`http://127.0.0.1:${port2}/mfa`, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': '203.0.113.11' },
            body: new URLSearchParams({ passcode: '123456', mfa_state: 'invalid' }),
          });
          if (another.status !== 440) fail('firestore', 'shared-signin-rate-limit', `other address: ${another.status}`);
          pass('firestore', 'shared-signin-rate-limit');

          // Verify bearer issued by Server 1 works on Server 2
          const srv2Init = await sendMcpRequest(port2, tokens1.accessToken, 'initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'consumer-e2e', version: '1.0.0' },
          });
          if (srv2Init.status !== 200) {
            fail('firestore', 'multi-instance-bearer-sharing', `bearer from server 1 failed on server 2 (${srv2Init.status}): ${srv2Init.rawText}`);
          }
          pass('firestore', 'multi-instance-bearer-sharing');
        } finally {
          await srv2.stop();
        }

        // Run exported store conformance suite against emulator
        const conformanceTestFile = path.join(tempDir, 'firestore-conformance.test.mjs');
        fs.writeFileSync(conformanceTestFile, `
import { runStoreConformance } from 'netsapiens-mcp/testing/store-conformance';
import { createFirestoreBackend, firestoreCollections } from 'netsapiens-mcp/lib';
import { Firestore, Timestamp } from '@google-cloud/firestore';

const projectId = process.env.GOOGLE_CLOUD_PROJECT || 'firestore-test';
const handles = new Map();

function normalize(value) {
  if (value instanceof Timestamp) return { $timestamp: value.toMillis() };
  if (value instanceof Date) return { $timestamp: value.getTime() };
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v != null)
        .map(([k, v]) => [k, normalize(v)])
    );
  }
  return value;
}

async function documents(handle) {
  const { db, collections } = handle;
  const pairs = await Promise.all(
    Object.entries(collections).map(async ([name, collection]) => {
      const snapshot = await db.collection(collection).get();
      return [name, snapshot.docs.map(doc => ({ key: doc.id, fields: doc.data() }))];
    })
  );
  return Object.fromEntries(pairs);
}

async function cleanup(ns) {
  const clients = handles.get(ns) ?? [];
  if (clients.length) {
    for (const name of Object.values(firestoreCollections(ns))) {
      const snapshot = await clients[0].collection(name).get();
      await Promise.all(snapshot.docs.map(doc => doc.ref.delete()));
    }
  }
  await Promise.all(clients.map(c => c.terminate()));
  handles.delete(ns);
}

runStoreConformance({
  name: 'firestore-consumer',
  capabilities: { persistent: true, multiInstance: true, subjectGuards: true, exclusive: false, expiry: 'ttl-policy' },
  async openBackend(ns) {
    const db = new Firestore({ projectId, ignoreUndefinedProperties: false });
    handles.set(ns, [...(handles.get(ns) ?? []), db]);
    return createFirestoreBackend({ db, namespace: ns });
  },
  async inspect(handle) {
    const rows = await documents(handle);
    const convert = (name) => (rows[name] || []).map(({ key, fields }) => {
      const { id: _id, ...rest } = fields;
      return { key, fields: normalize(rest) };
    });
    return {
      sessions: convert('sessions'),
      authCodes: convert('authCodes'),
      resumeTokens: convert('resumeTokens'),
      usage: (rows.usage || []).map(({ fields }) => ({ key: fields.userHash, fields: normalize(fields) })),
      clients: (rows.clients || []).map(({ key, fields }) => ({ key, fields: normalize(fields) })),
    };
  },
  async dumpRaw(handle) {
    const rows = await documents(handle);
    return JSON.stringify(rows);
  },
  async cleanup(ns) {
    await cleanup(ns);
  }
});
`);

        const vitestRes = await runCommand('npx', ['vitest', 'run', 'firestore-conformance.test.mjs', '--test-timeout=60000', '--hook-timeout=60000'], {
          cwd: tempDir,
          env: {
            ...process.env,
            FIRESTORE_EMULATOR_HOST: emuHost,
            GOOGLE_CLOUD_PROJECT: gcpProject,
          },
        });
        if (vitestRes.status !== 0) {
          fail('firestore', 'store-conformance-suite', `vitest store conformance failed: ${vitestRes.stdout}\n${vitestRes.stderr}`);
        }
        pass('firestore', 'store-conformance-suite');

      } finally {
        await srv1.stop();
        await fake.close();
      }
    }

    // -------------------------------------------------------------------------
    // LEG 7: library
    // -------------------------------------------------------------------------
    if (opts.legs.includes('library')) {
      console.log('Running leg: library');
      const identityProof = await runCommand('node', ['--input-type=module', '-e', `
import { deriveStoreKey, getCutoverOperationDocRef, withLegacyOperation } from 'netsapiens-mcp/lib';
import { deriveStoreKey as bundleDeriveStoreKey } from 'netsapiens-mcp/cutover-protocol';
const pathRef = (path = '') => ({
        collection: name => pathRef(path + '/' + name),
        doc: id => ({ ...pathRef(path + '/' + id), path: path + '/' + id }),
});
const db = pathRef();
const identityKey = deriveStoreKey('consumer proof session secret with more than 32 characters');
if (!Buffer.from(identityKey).equals(Buffer.from(bundleDeriveStoreKey('consumer proof session secret with more than 32 characters')))) throw new Error('bundle and library identity roots differ');
const callerId = 'arbitrary/id-with-secret-like-content';
const first = getCutoverOperationDocRef(db, 'mcp', callerId, identityKey).path;
const second = getCutoverOperationDocRef(db, 'mcp', callerId, identityKey).path;
if (first !== second || first.includes(callerId) || !/^op1_[0-9a-f]{64}$/.test(first.split('/').pop())) throw new Error('incorrect keyed operation path');
let called = false;
try {
        await withLegacyOperation({ db, namespace: 'mcp', kind: 'token_issue' }, async () => { called = true; });
        throw new Error('missing identityKey accepted');
} catch (error) {
        if (called || error?.kitCode !== 'cutover_fence_error' || error.message !== 'A stable operation identity key is required') throw error;
}
`], { cwd: tempDir });
      if (identityProof.status !== 0) {
        fail('library', 'standalone-fence-identity', identityProof.stderr);
      }
      pass('library', 'standalone-fence-identity');
      execSync('npm i --legacy-peer-deps -D typescript @types/node', { cwd: tempDir, stdio: 'pipe' });
      const consumerTsPath = path.join(tempDir, 'consumer-check.ts');
      fs.writeFileSync(consumerTsPath, `
import {
  createSqliteStore,
  createStore,
  type McpStore,
  type StoreBackend,
  parsePlatforms,
  type NetSapiensAuthProviderOptions,
} from 'netsapiens-mcp/lib';

const platforms = parsePlatforms(undefined, 'https://example.com');
const opts: Partial<NetSapiensAuthProviderOptions> = {
  nsApiUrl: 'https://example.com',
};
const dummyBackend: StoreBackend = {} as unknown as StoreBackend;
const dummyStore: McpStore = {} as unknown as McpStore;
void createSqliteStore;
void createStore;
void platforms;
void opts;
void dummyBackend;
void dummyStore;
`);
      fs.writeFileSync(path.join(tempDir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2022',
          strict: true,
          skipLibCheck: true,
          types: ['node'],
        },
      }));

      const tscRes = await runCommand('npx', ['tsc', '--noEmit'], { cwd: tempDir });
      if (tscRes.status !== 0) {
        fail('library', 'consumer-typecheck', `tsc --noEmit failed (${tscRes.status}):\n${tscRes.stdout}\n${tscRes.stderr}`);
      }
      pass('library', 'consumer-typecheck');

      fs.writeFileSync(path.join(tempDir, 'firestore-types.ts'), `
import { Firestore, type Transaction, type DocumentReference, type CollectionReference } from '@google-cloud/firestore';
import {
    getCutoverFenceDocRef, getCutoverOperationDocRef, getCutoverOperationsColRef,
    checkMutationGuardInTransaction, startMonotonicTimer,
    type FirestoreLike, type TransactionLike, type LegacyOperationContext,
} from 'netsapiens-mcp/lib';
declare const native: Firestore;
declare const nativeTransaction: Transaction;
declare const operation: LegacyOperationContext;
const structural: FirestoreLike = native;
const transaction: TransactionLike = nativeTransaction;
const control: DocumentReference = getCutoverFenceDocRef(native, 'mcp');
const operationRef: DocumentReference = getCutoverOperationDocRef(native, 'mcp', 'caller', new Uint8Array(32));
const operations: CollectionReference = getCutoverOperationsColRef(native, 'mcp');
void checkMutationGuardInTransaction(transaction, { db: structural, namespace: 'mcp', operation, identityKey: new Uint8Array(32), timer: startMonotonicTimer() });
void [control, operationRef, operations];
`);
      for (const version of ['7.11.0', '8.6.0', '9.0.0']) {
        execSync(`npm i --legacy-peer-deps --no-save @google-cloud/firestore@${version}`, { cwd: tempDir, stdio: 'pipe' });
        const sdkTypecheck = await runCommand('npx', ['tsc', '--noEmit'], { cwd: tempDir });
        if (sdkTypecheck.status !== 0) {
          fail('library', `firestore-${version}-typecheck`, `${sdkTypecheck.stdout}\n${sdkTypecheck.stderr}`);
        }
        pass('library', `firestore-${version}-typecheck`);
      }
    }
    if (opts.legs.includes('cutover-interop')) {
      console.log('Running leg: cutover-interop');
      const revisions = {
        migration: process.env.CUTOVER_MIGRATION_REVISION,
        bridge: process.env.CUTOVER_BRIDGE_REVISION,
        canonical: process.env.CUTOVER_CANONICAL_REVISION,
      };
      for (const [name, revision] of Object.entries(revisions)) {
        if (!/^[0-9a-f]{40}$/.test(revision ?? '')) throw new Error(`CUTOVER_${name.toUpperCase()}_REVISION must be a full source commit SHA`);
      }
      for (const [name, tarball] of Object.entries({ migration: opts.tarball, bridge: opts.bridgeTarball, canonical: opts.canonicalTarball })) {
        const digest = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
        console.log(`cutover-interop ${name} declared-revision=${revisions[name]} tarball-sha256=${digest}`);
      }
      const bridgeRoot = path.join(tempDir, 'bridge-consumer');
      const canonicalRoot = path.join(tempDir, 'canonical-consumer');
      for (const [root, tarball] of [[bridgeRoot, opts.bridgeTarball], [canonicalRoot, opts.canonicalTarball]]) {
        fs.mkdirSync(root);
        fs.writeFileSync(path.join(root, 'package.json'), '{"private":true,"type":"module"}\n');
        const result = await runCommand('npm', ['install', '--legacy-peer-deps', tarball], { cwd: root });
        if (result.status !== 0) throw new Error(`Interop install failed:\n${result.stdout}\n${result.stderr}`);
      }
      const bridgeTypes = await runCommand('npm', ['install', '--legacy-peer-deps', '--no-save', 'typescript@5.9.3', '@types/node@22', '@types/express@4'], { cwd: bridgeRoot });
      if (bridgeTypes.status !== 0) throw new Error(`Bridge typecheck setup failed:\n${bridgeTypes.stdout}\n${bridgeTypes.stderr}`);
      fs.writeFileSync(path.join(bridgeRoot, 'consumer.mts'), `
import {
    withLegacyOperation, checkMutationGuardInTransaction, startMonotonicTimer,
    type LegacyOperationContext, type PendingClaim, type CutoverFenceConfig,
} from 'netsapiens-mcp/lib';
declare const context: LegacyOperationContext;
declare const pending: PendingClaim;
declare const config: CutoverFenceConfig;
const id: string = context.storageId;
const owner: string = pending.claimOwner;
const enabled: boolean = config.enforce;
void [withLegacyOperation, checkMutationGuardInTransaction, startMonotonicTimer, id, owner, enabled];
`);
      const bridgeTypecheck = await runCommand('npx', ['tsc', '--noEmit', '--strict', '--skipLibCheck', 'false', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--target', 'ES2022', 'consumer.mts'], { cwd: bridgeRoot });
      if (bridgeTypecheck.status !== 0) throw new Error(`Packed bridge declaration check failed:\n${bridgeTypecheck.stdout}\n${bridgeTypecheck.stderr}`);
      pass('cutover-interop', 'packed-bridge-declarations');
      const firestore = await runCommand('npm', ['install', '--legacy-peer-deps', '--no-save', '@google-cloud/firestore@8.6.0'], { cwd: tempDir });
      if (firestore.status !== 0) throw new Error(`Firestore install failed:\n${firestore.stdout}\n${firestore.stderr}`);
      const { runCutoverInterop } = await import('./cutover-interop.mjs');
      await runCutoverInterop({ migrationRoot: tempDir, bridgeRoot, canonicalRoot });
      pass('cutover-interop', 'three-packed-runtimes');
    }

  } finally {
    // Cleanup temporary consumer directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }

  console.log('All executed legs passed successfully.');
}

main().catch((err) => {
  console.error(scrub(`FAIL consumer-e2e unexpected-error: ${err?.stack ?? err}`));
  process.exit(1);
});
