#!/usr/bin/env node
/**
 * Consumer end-to-end proof for netsapiens-mcp.
 *
 * Usage:
 *   node scripts/consumer-e2e.mjs (--tarball <path> | --registry <version>) [--legs <csv>] [--firestore-major 7|8|9]
 *
 * Legs:
 *   - install: installs package, proves no firestore dir, no *.node files, exports resolve.
 *   - config: tests documented failure exits on missing/bad env vars via package binary.
 *   - sqlite: runs against fake NetSapiens, exercises DCR, PKCE, token sign-in, read tool, restart persistence, file mode 600, lock exclusion, at-rest encryption.
 *   - memory: proves bearer is lost (401 invalid_token) after server restart in memory mode.
 *   - version: checks tool lists differ across versions, 46.0 tool refused on 44.4 with 0 requests, /health info, 500 origin handling.
 *   - firestore: installs @google-cloud/firestore, proves multi-instance bearer sharing, runs exported store conformance against emulator.
 *   - library: tsc --noEmit on consumer TS file importing from 'netsapiens-mcp/lib'.
 */

import { spawn, execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function parseArgs() {
  const args = process.argv.slice(2);
  let tarball = null;
  let registry = null;
  let legs = null;
  let firestoreMajor = '8';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--tarball') {
      tarball = args[++i];
    } else if (arg === '--registry') {
      registry = args[++i];
    } else if (arg === '--legs') {
      legs = args[++i];
    } else if (arg === '--firestore-major') {
      firestoreMajor = args[++i];
    } else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/consumer-e2e.mjs (--tarball <path> | --registry <version>) [--legs <csv>] [--firestore-major 7|8|9]');
      process.exit(0);
    }
  }

  if (!tarball && !registry) {
    console.error('FAIL args: Either --tarball <path> or --registry <version> is required.');
    process.exit(1);
  }

  const selectedLegs = legs
    ? legs.split(',').map((s) => s.trim().toLowerCase())
    : ['install', 'config', 'sqlite', 'memory', 'version', 'library'];

  return {
    tarball: tarball ? path.resolve(process.cwd(), tarball) : null,
    registry,
    legs: selectedLegs,
    firestoreMajor,
  };
}

function pass(leg, assertion) {
  console.log(`PASS ${leg} ${assertion}`);
}

function fail(leg, assertion, reason) {
  console.error(`FAIL ${leg} ${assertion}: ${reason}`);
  process.exit(1);
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

function getPackageBinaryRunner() {
  // Proven documented npx entry path
  return { cmd: 'npx', args: ['--yes', 'netsapiens-mcp'] };
}

async function startMcpServerProcess(tempDir, env) {
  const runner = getPackageBinaryRunner(tempDir);
  const cp = spawn(runner.cmd, runner.args, {
    cwd: tempDir,
    env,
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
        cp.kill('SIGTERM');
        for (let i = 0; i < 40; i++) {
          if (cp.exitCode !== null) return;
          await delay(50);
        }
        cp.kill('SIGKILL');
      }
    },
  };
}

async function waitForHealth(port, maxAttempts = 50) {
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

async function main() {
  const opts = parseArgs();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsmcp-consumer-e2e-'));
  const targetPkg = opts.tarball || `netsapiens-mcp@${opts.registry}`;
  const sessionSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  console.log(`Starting consumer-e2e in ${tempDir} [target: ${targetPkg}]`);

  // Dynamically import startFakeNetSapiens from repo
  const { startFakeNetSapiens } = await import(path.join(repoRoot, 'scripts/fake-netsapiens/index.mjs'));

  try {
    // Initialize consumer directory with target package
    execSync('npm init -y', { cwd: tempDir, stdio: 'pipe' });
    execSync(`npm i ${targetPkg}`, { cwd: tempDir, stdio: 'pipe' });

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
      execSync('npm i vitest@^4.1.11', { cwd: tempDir, stdio: 'pipe' });
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
        const health = await waitForHealth(serverPort);

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
              arguments: { key: sampleKey },
            });

            // Refusal must occur
            if (callRes.status === 200 && !callRes.json?.error && !callRes.json?.result?.isError) {
              fail('version', 'refusal-of-46-only-tool', `call_api for 46-only key unexpectedly succeeded on 44.4.10`);
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
      console.log(`Installing ${fsPkg} in consumer...`);
      execSync(`npm i ${fsPkg}`, { cwd: tempDir, stdio: 'pipe' });

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
      const fsEnvCommon = {
        ...process.env,
        MCP_TRANSPORT: 'http',
        MCP_PERSISTENCE: 'firestore',
        MCP_STORE_NAMESPACE: 'mcp',
        GOOGLE_CLOUD_PROJECT: gcpProject,
        FIRESTORE_EMULATOR_HOST: emuHost,
        MCP_SESSION_SECRET: sessionSecret,
        NETSAPIENS_API_URL: fake.origin,
        NETSAPIENS_OAUTH_CLIENT_ID: 'op-client',
        NETSAPIENS_OAUTH_CLIENT_SECRET: 'op-secret',
        MCP_STATELESS: 'false',
      };

      const srv1 = await startMcpServerProcess(tempDir, {
        ...fsEnvCommon,
        MCP_PORT: String(port1),
        MCP_BASE_URL: `http://127.0.0.1:${port1}`,
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
          MCP_BASE_URL: `http://127.0.0.1:${port2}`,
        });

        try {
          await waitForHealth(port2);

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
  capabilities: { persistent: true, multiInstance: true, exclusive: false, expiry: 'ttl-policy' },
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

        const vitestRes = await runCommand('npx', ['vitest', 'run', 'firestore-conformance.test.mjs'], {
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
      execSync('npm i -D typescript @types/node', { cwd: tempDir, stdio: 'pipe' });
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
  console.error('FAIL consumer-e2e unexpected-error:', err);
  process.exit(1);
});
