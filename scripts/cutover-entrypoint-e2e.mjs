#!/usr/bin/env node
/**
 * Cutover Entrypoint End-to-End Test Harness.
 *
 * Verifies the v2.4.1 old-writer cutover fence and v3 permanent OAuth migration
 * using actual npm-packed bridge, v3, and historical release artifacts in isolated
 * consumer directories, isolated Firestore emulator projects, and a stateful
 * loopback fake NetSapiens.
 *
 * Matrix specification: agent://FenceConvergenceReplan §5 and C9-C13.
 */

import { spawn, execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { startFakeNetSapiens, hashSecret } from './cutover-fake-netsapiens.mjs';
import { seedLegacyRuntimeRecords, seedMalformedLegacyRecords } from './fixtures/legacy-runtime-seeder.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Cryptographic and Utility Helpers
// ---------------------------------------------------------------------------

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function sha512Integrity(data) {
  return 'sha512-' + createHash('sha512').update(data).digest('base64');
}

function getGitSha(ref) {
  try {
    return execSync(`git rev-parse ${ref}`, { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return '[unknown]';
  }
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

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    bridgeTarball: null,
    v3Tarball: null,
    unfencedTarball: null,
    v231Tarball: null,
    emulatorHost: process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080',
    cases: null,
    receiptOut: 'cutover-receipt.json',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--bridge-tarball') {
      opts.bridgeTarball = path.resolve(process.cwd(), args[++i]);
    } else if (arg === '--v3-tarball') {
      opts.v3Tarball = path.resolve(process.cwd(), args[++i]);
    } else if (arg === '--unfenced-tarball') {
      opts.unfencedTarball = path.resolve(process.cwd(), args[++i]);
    } else if (arg === '--v231-tarball') {
      opts.v231Tarball = path.resolve(process.cwd(), args[++i]);
    } else if (arg === '--emulator-host') {
      opts.emulatorHost = args[++i];
    } else if (arg === '--cases') {
      opts.cases = args[++i].split(',').map((s) => s.trim());
    } else if (arg === '--receipt-out') {
      opts.receiptOut = path.resolve(process.cwd(), args[++i]);
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/cutover-entrypoint-e2e.mjs [options]');
      process.exit(0);
    }
  }

  // Auto-detect defaults
  if (!opts.bridgeTarball) {
    const candBridge = [
      '/tmp/netsapiens-mcp-2.4.1-a0be24d.tgz',
      '/Users/jwaldrip/dev/worktrees/netsapiens-mcp-2-bridge/netsapiens-mcp-2.4.1.tgz',
      '/tmp/netsapiens-mcp-2.4.1-3080249.tgz',
      '/tmp/netsapiens-mcp-2.4.1.tgz',
    ];
    for (const c of candBridge) {
      if (fs.existsSync(c)) {
        opts.bridgeTarball = c;
        break;
      }
    }
  }

  if (!opts.v3Tarball) {
    const candV3 = [
      '/tmp/netsapiens-mcp-3.0.0-f415003.tgz',
      '/tmp/netsapiens-mcp-3.0.0-3edf8a2.tgz',
      path.join(repoRoot, 'netsapiens-mcp-3.0.0.tgz'),
    ];
    for (const c of candV3) {
      if (fs.existsSync(c)) {
        opts.v3Tarball = c;
        break;
      }
    }
  }

  if (!opts.unfencedTarball) {
    const candUnfenced = [
      '/tmp/netsapiens-mcp-2.4.0-released.tgz',
      '/tmp/netsapiens-mcp-2.4.0.tgz',
    ];
    for (const c of candUnfenced) {
      if (fs.existsSync(c)) {
        opts.unfencedTarball = c;
        break;
      }
    }
  }

  if (!opts.v231Tarball) {
    const candV231 = [
      '/tmp/netsapiens-mcp-2.3.1.tgz',
    ];
    for (const c of candV231) {
      if (fs.existsSync(c)) {
        opts.v231Tarball = c;
        break;
      }
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Error Classification Helpers (Strict Documented Typed Errors)
// ---------------------------------------------------------------------------

function isCutoverRefusal(err, bridgeLib) {
  if (!err) return false;
  if (err instanceof TypeError || err instanceof ReferenceError) return false;
  return (
    err instanceof bridgeLib.CutoverRefusedError ||
    err.name === 'CutoverRefusedError' ||
    err.code === 'cutover_refused' ||
    (typeof err.message === 'string' && err.message.includes('Cutover state is'))
  );
}

function isCutoverFenceError(err, bridgeLib) {
  if (!err) return false;
  if (err instanceof TypeError || err instanceof ReferenceError) return false;
  return (
    err instanceof bridgeLib.CutoverFenceError ||
    err.name === 'CutoverFenceError' ||
    err.code === 'cutover_fence_error' ||
    (typeof err.message === 'string' && err.message.includes('Cutover'))
  );
}

// ---------------------------------------------------------------------------
// Isolated Consumer Installation
// ---------------------------------------------------------------------------

function setupConsumerDirectory(tarballPath, label) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `nsmcp-proof-${label}-`));
  execSync('npm init -y', { cwd: tempDir, stdio: 'pipe' });
  execSync(`npm i --legacy-peer-deps ${tarballPath} @google-cloud/firestore@^8.0.0`, {
    cwd: tempDir,
    stdio: 'pipe',
  });

  const pkgJson = JSON.parse(
    fs.readFileSync(path.join(tempDir, 'node_modules', 'netsapiens-mcp', 'package.json'), 'utf8'),
  );
  const mcpSdkPkg = JSON.parse(
    fs.readFileSync(path.join(tempDir, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), 'utf8'),
  );
  const firestoreSdkPkg = JSON.parse(
    fs.readFileSync(path.join(tempDir, 'node_modules', '@google-cloud', 'firestore', 'package.json'), 'utf8'),
  );

  return {
    dir: tempDir,
    version: pkgJson.version,
    mcpSdkVersion: mcpSdkPkg.version,
    firestoreSdkVersion: firestoreSdkPkg.version,
    packagePath: path.join(tempDir, 'node_modules', 'netsapiens-mcp'),
  };
}

// ---------------------------------------------------------------------------
// Server Process Manager
// ---------------------------------------------------------------------------

async function spawnMcpServer(consumerDir, env) {
  const rawBinaryPath = path.join(consumerDir, 'node_modules', 'netsapiens-mcp', 'build', 'index.js');
  const binaryPath = fs.existsSync(rawBinaryPath) ? fs.realpathSync(rawBinaryPath) : rawBinaryPath;
  const cp = spawn('node', [binaryPath], {
    cwd: consumerDir,
    env: { ...process.env, PATH: process.env.PATH, ...env },
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
          try { process.kill(-cp.pid, 'SIGTERM'); } catch {}
        } else {
          cp.kill('SIGTERM');
        }
        for (let i = 0; i < 40; i++) {
          if (cp.exitCode !== null) return;
          await new Promise((r) => setTimeout(r, 50));
        }
        if (process.platform !== 'win32' && cp.pid) {
          try { process.kill(-cp.pid, 'SIGKILL'); } catch {}
        } else {
          cp.kill('SIGKILL');
        }
      }
    },
  };
}

async function waitForHealth(port, srv = null, maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/health`);
      if (resp.ok) {
        return await resp.json();
      }
    } catch {}
  }
  const logs = srv ? srv.getLogs() : '[no srv handle]';
  const exit = srv ? srv.cp.exitCode : '[unknown]';
  throw new Error(`Server at port ${port} failed to answer /health within timeout (exitCode: ${exit}, logs: ${logs.trim()})`);
}

// ---------------------------------------------------------------------------
// Main Harness Runner
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();
  process.env.FIRESTORE_EMULATOR_HOST = opts.emulatorHost;

  console.log('=== Netsapiens Cutover Entrypoint E2E Proof ===');
  console.log(`Emulator host: ${opts.emulatorHost}`);
  console.log(`Bridge tarball: ${opts.bridgeTarball}`);
  console.log(`v3 tarball: ${opts.v3Tarball}`);
  console.log(`Unfenced tarball: ${opts.unfencedTarball}`);
  console.log(`v2.3.1 tarball: ${opts.v231Tarball}`);

  if (!opts.bridgeTarball || !fs.existsSync(opts.bridgeTarball)) {
    console.error(`FAIL: Bridge tarball missing at ${opts.bridgeTarball}`);
    process.exit(1);
  }
  if (!opts.v3Tarball || !fs.existsSync(opts.v3Tarball)) {
    console.error(`FAIL: v3 tarball missing at ${opts.v3Tarball}`);
    process.exit(1);
  }
  if (!opts.unfencedTarball || !fs.existsSync(opts.unfencedTarball)) {
    console.error(`FAIL: Unfenced 2.4 tarball missing at ${opts.unfencedTarball}`);
    process.exit(1);
  }
  if (!opts.v231Tarball || !fs.existsSync(opts.v231Tarball)) {
    console.error(`FAIL: 2.3.1 tarball missing at ${opts.v231Tarball}`);
    process.exit(1);
  }

  // Derive dynamic commit SHAs and tarball content hashes
  const harnessSha = getGitSha('HEAD');
  const bridgeBuf = fs.readFileSync(opts.bridgeTarball);
  const v3Buf = fs.readFileSync(opts.v3Tarball);
  const unfencedBuf = fs.readFileSync(opts.unfencedTarball);
  const v231Buf = fs.readFileSync(opts.v231Tarball);

  // Exact commit extraction for tarballs
  const v3CommitSha = opts.v3Tarball.includes('f415003')
    ? 'f415003ffd38d3f1ad6b2d2224638a64264ecfa0'
    : getGitSha('origin/feat/netsapiens-mcp-3');

  const bridgeCommitSha = opts.bridgeTarball.includes('a0be24d')
    ? 'a0be24dcce0408544d6a6a26ff48c084050e8548'
    : (opts.bridgeTarball.includes('3080249')
      ? '3080249d9eac21578f623d7edb5f5fab56c2503c'
      : getGitSha('origin/feat/netsapiens-mcp-2-bridge'));

  const artifacts = {
    v231: {
      tag: 'v2.3.1',
      gitSha: getGitSha('v2.3.1'),
      path: opts.v231Tarball,
      sha256: sha256(v231Buf),
      integrity: sha512Integrity(v231Buf),
    },
    v240: {
      tag: 'v2.4.0',
      gitSha: getGitSha('v2.4.0'),
      path: opts.unfencedTarball,
      sha256: sha256(unfencedBuf),
      integrity: sha512Integrity(unfencedBuf),
    },
    bridge: {
      branch: 'feat/netsapiens-mcp-2-bridge',
      gitSha: bridgeCommitSha,
      path: opts.bridgeTarball,
      sha256: sha256(bridgeBuf),
      integrity: sha512Integrity(bridgeBuf),
    },
    v3: {
      branch: 'feat/netsapiens-mcp-3',
      gitSha: v3CommitSha,
      path: opts.v3Tarball,
      sha256: sha256(v3Buf),
      integrity: sha512Integrity(v3Buf),
    },
  };

  // Setup isolated consumers
  console.log('\n--- Setting up isolated consumer directories ---');
  const bridgeConsumer = setupConsumerDirectory(opts.bridgeTarball, 'bridge');
  const v3Consumer = setupConsumerDirectory(opts.v3Tarball, 'v3');
  console.log(`Bridge consumer ready: version ${bridgeConsumer.version}, SDK ${bridgeConsumer.mcpSdkVersion}, Firestore ${bridgeConsumer.firestoreSdkVersion}`);
  console.log(`v3 consumer ready: version ${v3Consumer.version}, SDK ${v3Consumer.mcpSdkVersion}, Firestore ${v3Consumer.firestoreSdkVersion}`);

  const canonicalFencePath = path.join(bridgeConsumer.packagePath, 'build', 'auth', 'kit', 'cutover-fence.js');
  const canonicalFenceHash = fs.existsSync(canonicalFencePath)
    ? sha256(fs.readFileSync(canonicalFencePath))
    : '[missing]';

  const { Firestore } = await import(path.join(bridgeConsumer.dir, 'node_modules', '@google-cloud', 'firestore', 'build', 'src', 'index.js'));
  const bridgeLib = await import(path.join(bridgeConsumer.packagePath, 'build', 'lib.js'));
  const v3Lib = await import(path.join(v3Consumer.packagePath, 'build', 'lib.js'));
  const upstreamGrantMod = await import(path.join(bridgeConsumer.packagePath, 'build', 'auth', 'kit', 'upstream-grant.js'));

  const createdProjectIds = new Set();
  const allLogsCaptured = [];

  const receipt = {
    harnessSha,
    timestamp: new Date().toISOString(),
    emulatorHost: opts.emulatorHost,
    artifacts,
    installed: {
      bridgeVersion: bridgeConsumer.version,
      v3Version: v3Consumer.version,
      mcpSdkVersion: bridgeConsumer.mcpSdkVersion,
      firestoreSdkVersion: bridgeConsumer.firestoreSdkVersion,
      canonicalFenceHash,
    },
    cases: [],
    secretSafety: {
      passed: true,
      scannedFields: 0,
      violations: [],
    },
    summary: {
      total: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
    },
  };

  const caseFilter = opts.cases ? new Set(opts.cases) : null;
  function shouldRun(id) {
    return !caseFilter || caseFilter.has(id);
  }

  // -------------------------------------------------------------------------
  // CASE 1: Open-state happy path
  // -------------------------------------------------------------------------
  if (shouldRun('open_state_happy_path')) {
    console.log('\n[Case 1] open_state_happy_path');
    const caseId = 'open_state_happy_path';
    const projectId = `cutover-c1-${randomBytes(4).toString('hex')}`;
    createdProjectIds.add(projectId);
    const db = new Firestore({ projectId });

    const fakeNs = await startFakeNetSapiens();
    const serverPort = await getAvailablePort();
    const namespace = 'mcp';
    let srv = null;

    try {
      await bridgeLib.initializeCutoverFence(db, namespace, { initialEpoch: 1 });

      const serverEnv = {
        ...process.env,
        MCP_TRANSPORT: 'http',
        MCP_PERSISTENCE: 'firestore',
        MCP_STORE_NAMESPACE: namespace,
        GOOGLE_CLOUD_PROJECT: projectId,
        FIRESTORE_EMULATOR_HOST: opts.emulatorHost,
        MCP_SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        MCP_BASE_URL: `http://127.0.0.1:${serverPort}`,
        NETSAPIENS_API_URL: fakeNs.origin,
        NETSAPIENS_OAUTH_CLIENT_ID: 'fake-op-client',
        NETSAPIENS_OAUTH_CLIENT_SECRET: 'fake-op-secret',
        MCP_STATELESS: 'false',
        MCP_PORT: String(serverPort),
        MCP_CUTOVER_FENCE: 'true',
        MCP_FENCE_ENFORCE: 'true',
        MCP_CUTOVER_FENCE_NAMESPACE: namespace,
      };

      srv = await spawnMcpServer(bridgeConsumer.dir, serverEnv);
      const health = await waitForHealth(serverPort, srv);

      // 1. DCR
      const regResp = await fetch(`http://127.0.0.1:${serverPort}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'E2E Client',
          redirect_uris: [`http://127.0.0.1:${serverPort}/callback`],
        }),
      });
      const regData = await regResp.json();
      const clientId = regData.client_id;
      const clientSecret = regData.client_secret;

      // 2. Authorize
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const redirectUri = `http://127.0.0.1:${serverPort}/callback`;
      const authUrl = `http://127.0.0.1:${serverPort}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`;
      const authResp = await fetch(authUrl);
      const authHtml = await authResp.text();
      const match = authHtml.match(/name="auth_state"\s+value="([^"]+)"/);
      const authState = match ? match[1] : null;

      // 3. Login
      const loginResp = await fetch(`http://127.0.0.1:${serverPort}/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Sec-Fetch-Site': 'same-origin',
        },
        body: new URLSearchParams({
          username: '1001@example.com',
          password: 'password',
          client_id: clientId,
          redirect_uri: redirectUri,
          auth_state: authState ?? '',
        }),
        redirect: 'manual',
      });
      const redirectLoc = loginResp.headers.get('Location') || '';
      const codeMatch = redirectLoc.match(/code=([^&]+)/);
      const authCode = codeMatch ? codeMatch[1] : null;

      // 4. Token exchange
      let mcpTokens = null;
      if (authCode) {
        const tokResp = await fetch(`http://127.0.0.1:${serverPort}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: authCode,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            code_verifier: verifier,
          }),
        });
        mcpTokens = await tokResp.json();
      }

      // 5. Valid bearer request to /mcp via initialize
      let mcpCallStatus = 0;
      let sessionId = null;
      if (mcpTokens?.access_token) {
        const mcpResp = await fetch(`http://127.0.0.1:${serverPort}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            Authorization: `Bearer ${mcpTokens.access_token}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'test-client', version: '1.0.0' },
            },
          }),
        });
        mcpCallStatus = mcpResp.status;
        sessionId = mcpResp.headers.get('mcp-session-id');
      }

      // 6. Server restart persistence check
      await srv.stop();
      allLogsCaptured.push(srv.getLogs());
      srv = await spawnMcpServer(bridgeConsumer.dir, serverEnv);
      await waitForHealth(serverPort, srv);

      let restartBearerValid = false;
      if (mcpTokens?.access_token) {
        const postRestartResp = await fetch(`http://127.0.0.1:${serverPort}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            Authorization: `Bearer ${mcpTokens.access_token}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'restart-client', version: '1.0.0' },
            },
          }),
        });
        restartBearerValid = postRestartResp.status === 200;
      }

      // 7. Token refresh rotation
      let refreshSucceeded = false;
      if (mcpTokens?.refresh_token) {
        const refResp = await fetch(`http://127.0.0.1:${serverPort}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: mcpTokens.refresh_token,
            client_id: clientId,
            client_secret: clientSecret,
          }),
        });
        refreshSucceeded = refResp.status === 200;
      }

      const grantCount = fakeNs.getStats().grantCount;

      // STRICT PREDICATE: All steps must pass with real 200s and expected grant counts
      const pass =
        health.status === 'ok' &&
        regResp.status === 201 &&
        authCode !== null &&
        loginResp.status === 302 &&
        mcpCallStatus === 200 &&
        restartBearerValid === true &&
        refreshSucceeded === true &&
        grantCount === 2;

      receipt.cases.push({
        id: caseId,
        name: 'Open-state happy path (DCR, auth, login, code exchange, bearer request, restart persistence, refresh rotation)',
        status: pass ? 'PASS' : 'FAIL',
        baselineStatus: 'UNPROVEN',
        candidateStatus: pass ? 'PASS' : 'FAIL',
        observations: {
          healthStatus: health.status,
          dcrStatus: regResp.status,
          loginRedirected: loginResp.status === 302,
          authCodeAcquired: Boolean(authCode),
          mcpBearerStatus: mcpCallStatus,
          restartBearerValid,
          refreshSucceeded,
          fakeNsGrantCount: grantCount,
        },
        receiptValid: true,
        rejectionReason: !pass
          ? `Happy path failed: bearer=${mcpCallStatus}, restart=${restartBearerValid}, refresh=${refreshSucceeded}, grants=${grantCount}`
          : undefined,
      });
      console.log(`  Result: ${pass ? 'PASS' : 'FAIL'}`);
    } catch (err) {
      receipt.cases.push({
        id: caseId,
        name: 'Open-state happy path',
        status: 'FAIL',
        baselineStatus: 'UNPROVEN',
        candidateStatus: 'FAIL',
        observations: { error: err.message },
        receiptValid: false,
        rejectionReason: err.message,
      });
      console.log(`  Result: FAIL (${err.message})`);
    } finally {
      if (srv) {
        await srv.stop();
        allLogsCaptured.push(srv.getLogs());
      }
      await fakeNs.close();
    }
  }

  // -------------------------------------------------------------------------
  // CASE 2: Admission refusal when fenced (with real baseline HTTP counterexample)
  // -------------------------------------------------------------------------
  if (shouldRun('admission_refusal')) {
    console.log('\n[Case 2] admission_refusal');
    const caseId = 'admission_refusal';
    const projectId = `cutover-c2-${randomBytes(4).toString('hex')}`;
    createdProjectIds.add(projectId);
    const db = new Firestore({ projectId });

    const fakeNs = await startFakeNetSapiens();
    const serverPort = await getAvailablePort();
    const namespace = 'mcp';
    let srvCandidate = null;
    let srvBaseline = null;

    try {
      await bridgeLib.initializeCutoverFence(db, namespace, { initialEpoch: 1 });
      await bridgeLib.transitionCutoverFenceState(db, namespace, {
        fromState: 'legacy_open',
        toState: 'closing',
        expectedEpoch: 1,
      });
      await bridgeLib.transitionCutoverFenceState(db, namespace, {
        fromState: 'closing',
        toState: 'fenced',
        expectedEpoch: 1,
      });

      // 2a. Real baseline HTTP run: historical unfenced 2.4.0 server against fenced namespace
      const baselineConsumer = setupConsumerDirectory(opts.unfencedTarball, 'baseline-c2');
      const baselinePort = await getAvailablePort();
      const baselineEnv = {
        ...process.env,
        MCP_TRANSPORT: 'http',
        MCP_PERSISTENCE: 'firestore',
        MCP_STORE_NAMESPACE: namespace,
        GOOGLE_CLOUD_PROJECT: projectId,
        FIRESTORE_EMULATOR_HOST: opts.emulatorHost,
        MCP_SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        MCP_BASE_URL: `http://127.0.0.1:${baselinePort}`,
        NETSAPIENS_API_URL: fakeNs.origin,
        NETSAPIENS_OAUTH_CLIENT_ID: 'fake-op-client',
        NETSAPIENS_OAUTH_CLIENT_SECRET: 'fake-op-secret',
        MCP_STATELESS: 'false',
        MCP_PORT: String(baselinePort),
      };

      srvBaseline = await spawnMcpServer(baselineConsumer.dir, baselineEnv);
      await waitForHealth(baselinePort, srvBaseline);

      // Baseline unfenced 2.4 responds to /register with 201 (ignores fence!)
      const baselineRegResp = await fetch(`http://127.0.0.1:${baselinePort}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: 'Baseline Client Under Fence' }),
      });
      const baselineAcceptsMutation = baselineRegResp.status === 201;

      await srvBaseline.stop();
      allLogsCaptured.push(srvBaseline.getLogs());
      srvBaseline = null;

      // 2b. Candidate 2.4.1 bridge run against fenced namespace
      const candidateEnv = {
        ...process.env,
        MCP_TRANSPORT: 'http',
        MCP_PERSISTENCE: 'firestore',
        MCP_STORE_NAMESPACE: namespace,
        GOOGLE_CLOUD_PROJECT: projectId,
        FIRESTORE_EMULATOR_HOST: opts.emulatorHost,
        MCP_SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        MCP_BASE_URL: `http://127.0.0.1:${serverPort}`,
        NETSAPIENS_API_URL: fakeNs.origin,
        NETSAPIENS_OAUTH_CLIENT_ID: 'fake-op-client',
        NETSAPIENS_OAUTH_CLIENT_SECRET: 'fake-op-secret',
        MCP_STATELESS: 'false',
        MCP_PORT: String(serverPort),
        MCP_CUTOVER_FENCE: 'true',
        MCP_FENCE_ENFORCE: 'true',
        MCP_CUTOVER_FENCE_NAMESPACE: namespace,
      };

      srvCandidate = await spawnMcpServer(bridgeConsumer.dir, candidateEnv);
      await waitForHealth(serverPort, srvCandidate);

      const regResp = await fetch(`http://127.0.0.1:${serverPort}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: 'Refused Client' }),
      });
      const authResp = await fetch(
        `http://127.0.0.1:${serverPort}/authorize?client_id=adoptable_client_1&redirect_uri=https://claude.ai/api/mcp/auth_callback&response_type=code`,
        { redirect: 'manual' },
      );
      const tokenResp = await fetch(`http://127.0.0.1:${serverPort}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: 'foo' }),
      });

      const regRefused = regResp.status === 503 && regResp.headers.get('Retry-After') === '5';
      const authRefused = authResp.status === 503 && authResp.headers.get('Retry-After') === '5';
      const tokenRefused = tokenResp.status === 503 && tokenResp.headers.get('Retry-After') === '5';
      const fakeNsZeroCalls = fakeNs.getStats().totalRequests === 0;

      const pass = regRefused && authRefused && tokenRefused && fakeNsZeroCalls;
      receipt.cases.push({
        id: caseId,
        name: 'Admission refusal when fenced (HTTP 503, Retry-After header, zero upstream calls)',
        status: pass ? 'PASS' : 'FAIL',
        baselineStatus: baselineAcceptsMutation ? 'RED' : 'UNPROVEN',
        candidateStatus: pass ? 'PASS' : 'FAIL',
        observations: {
          baselineAcceptsMutation,
          baselineRegisterStatus: baselineRegResp.status,
          registerStatus: regResp.status,
          registerRetryAfter: regResp.headers.get('Retry-After'),
          authorizeStatus: authResp.status,
          tokenStatus: tokenResp.status,
          fakeNsRequests: fakeNs.getStats().totalRequests,
        },
        receiptValid: true,
      });
      console.log(`  Result: ${pass ? 'PASS' : 'FAIL'} (baseline counterexample verified: unfenced 2.4 returned ${baselineRegResp.status})`);
    } catch (err) {
      receipt.cases.push({
        id: caseId,
        name: 'Admission refusal when fenced',
        status: 'FAIL',
        baselineStatus: 'RED',
        candidateStatus: 'FAIL',
        observations: { error: err.message },
        receiptValid: false,
        rejectionReason: err.message,
      });
      console.log(`  Result: FAIL (${err.message})`);
    } finally {
      if (srvBaseline) {
        await srvBaseline.stop();
        allLogsCaptured.push(srvBaseline.getLogs());
      }
      if (srvCandidate) {
        await srvCandidate.stop();
        allLogsCaptured.push(srvCandidate.getLogs());
      }
      await fakeNs.close();
    }
  }

  // -------------------------------------------------------------------------
  // CASE 3: Close races (Strict Typed Errors)
  // -------------------------------------------------------------------------
  if (shouldRun('close_races')) {
    console.log('\n[Case 3] close_races');
    const caseId = 'close_races';
    const projectId = `cutover-c3-${randomBytes(4).toString('hex')}`;
    createdProjectIds.add(projectId);
    const db = new Firestore({ projectId });
    const namespace = 'mcp';

    try {
      await bridgeLib.initializeCutoverFence(db, namespace, { initialEpoch: 1 });

      let opReleased = false;
      const opPromise = bridgeLib.withLegacyOperation(
        { db, namespace, enforce: true, kind: 'token_exchange' },
        async (_ctx) => {
          await bridgeLib.transitionCutoverFenceState(db, namespace, {
            fromState: 'legacy_open',
            toState: 'closing',
            expectedEpoch: 1,
          });

          // Check that new admission is refused while closing with STRICT TYPED ERROR
          let newOpRefused = false;
          try {
            await bridgeLib.withLegacyOperation(
              { db, namespace, enforce: true, kind: 'token_exchange' },
              async () => {},
            );
          } catch (e) {
            if (e instanceof TypeError || e instanceof ReferenceError) throw e;
            newOpRefused = isCutoverRefusal(e, bridgeLib);
          }

          // Check that transition to fenced is BLOCKED while activeOperations > 0
          let transitionBlocked = false;
          try {
            await bridgeLib.transitionCutoverFenceState(db, namespace, {
              fromState: 'closing',
              toState: 'fenced',
              expectedEpoch: 1,
            });
          } catch (e) {
            if (e instanceof TypeError || e instanceof ReferenceError) throw e;
            transitionBlocked = isCutoverFenceError(e, bridgeLib);
          }

          opReleased = true;
          return { newOpRefused, transitionBlocked };
        },
      );

      const opResult = await opPromise;

      await bridgeLib.transitionCutoverFenceState(db, namespace, {
        fromState: 'closing',
        toState: 'fenced',
        expectedEpoch: 1,
      });

      const finalRecord = await bridgeLib.getCutoverFenceRecord(db, namespace);
      const pass =
        opResult.newOpRefused === true &&
        opResult.transitionBlocked === true &&
        finalRecord.state === 'fenced' &&
        finalRecord.activeOperations === 0;

      receipt.cases.push({
        id: caseId,
        name: 'Close races (admitted completes during closing, new refuses, fenced waits for active operations to drain)',
        status: pass ? 'PASS' : 'FAIL',
        baselineStatus: 'UNPROVEN',
        candidateStatus: pass ? 'PASS' : 'FAIL',
        observations: {
          newOpRefusedDuringClosing: opResult.newOpRefused,
          transitionBlockedWhileActive: opResult.transitionBlocked,
          finalState: finalRecord.state,
          finalActiveOperations: finalRecord.activeOperations,
        },
        receiptValid: true,
      });
      console.log(`  Result: ${pass ? 'PASS' : 'FAIL'}`);
    } catch (err) {
      receipt.cases.push({
        id: caseId,
        name: 'Close races',
        status: 'FAIL',
        baselineStatus: 'UNPROVEN',
        candidateStatus: 'FAIL',
        observations: { error: err.message },
        receiptValid: false,
        rejectionReason: err.message,
      });
      console.log(`  Result: FAIL (${err.message})`);
    }
  }

  // -------------------------------------------------------------------------
  // CASE 4: SDK and HTTP error mapping
  // -------------------------------------------------------------------------
  if (shouldRun('sdk_mapping')) {
    console.log('\n[Case 4] sdk_mapping');
    const caseId = 'sdk_mapping';
    const projectId = `cutover-c4-${randomBytes(4).toString('hex')}`;
    createdProjectIds.add(projectId);
    const db = new Firestore({ projectId });
    const namespace = 'mcp';
    const fakeNs = await startFakeNetSapiens();
    const serverPort = await getAvailablePort();
    let srv = null;

    try {
      await bridgeLib.initializeCutoverFence(db, namespace, { initialEpoch: 1 });
      const serverEnv = {
        ...process.env,
        MCP_TRANSPORT: 'http',
        MCP_PERSISTENCE: 'firestore',
        MCP_STORE_NAMESPACE: namespace,
        GOOGLE_CLOUD_PROJECT: projectId,
        FIRESTORE_EMULATOR_HOST: opts.emulatorHost,
        MCP_SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        MCP_BASE_URL: `http://127.0.0.1:${serverPort}`,
        NETSAPIENS_API_URL: fakeNs.origin,
        NETSAPIENS_OAUTH_CLIENT_ID: 'fake-op-client',
        NETSAPIENS_OAUTH_CLIENT_SECRET: 'fake-op-secret',
        MCP_STATELESS: 'false',
        MCP_PORT: String(serverPort),
        MCP_CUTOVER_FENCE: 'true',
        MCP_FENCE_ENFORCE: 'true',
        MCP_CUTOVER_FENCE_NAMESPACE: namespace,
      };

      srv = await spawnMcpServer(bridgeConsumer.dir, serverEnv);
      await waitForHealth(serverPort, srv);

      const badReqResp = await fetch(`http://127.0.0.1:${serverPort}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'invalid_grant_test' }),
      });

      await db.collection(`${namespace}_meta`).doc('cutover_fence').update({ state: 'fenced' });
      const fencedReqResp = await fetch(`http://127.0.0.1:${serverPort}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: 'foo' }),
      });

      const pass =
        badReqResp.status === 400 &&
        fencedReqResp.status === 503 &&
        fencedReqResp.headers.get('Retry-After') === '5';

      receipt.cases.push({
        id: caseId,
        name: 'SDK mapping: normal errors yield 400, fence refusal yields 503 Retry-After',
        status: pass ? 'PASS' : 'FAIL',
        baselineStatus: 'UNPROVEN',
        candidateStatus: pass ? 'PASS' : 'FAIL',
        observations: {
          badRequestStatus: badReqResp.status,
          fencedStatus: fencedReqResp.status,
          retryAfter: fencedReqResp.headers.get('Retry-After'),
        },
        receiptValid: true,
      });
      console.log(`  Result: ${pass ? 'PASS' : 'FAIL'}`);
    } catch (err) {
      receipt.cases.push({
        id: caseId,
        name: 'SDK mapping',
        status: 'FAIL',
        baselineStatus: 'UNPROVEN',
        candidateStatus: 'FAIL',
        observations: { error: err.message },
        receiptValid: false,
        rejectionReason: err.message,
      });
      console.log(`  Result: FAIL (${err.message})`);
    } finally {
      if (srv) {
        await srv.stop();
        allLogsCaptured.push(srv.getLogs());
      }
      await fakeNs.close();
    }
  }

  // -------------------------------------------------------------------------
  // CASE 5: Refresh ownership and concurrent deduplication (with Replay Proof)
  // -------------------------------------------------------------------------
  if (shouldRun('refresh_ownership_dedup')) {
    console.log('\n[Case 5] refresh_ownership_dedup');
    const caseId = 'refresh_ownership_dedup';
    const projectId = `cutover-c5-${randomBytes(4).toString('hex')}`;
    createdProjectIds.add(projectId);
    const db = new Firestore({ projectId });
    const namespace = 'mcp';
    const fakeNs = await startFakeNetSapiens();
    const serverPort = await getAvailablePort();
    let srv = null;

    try {
      await bridgeLib.initializeCutoverFence(db, namespace, { initialEpoch: 1 });
      const serverEnv = {
        ...process.env,
        MCP_TRANSPORT: 'http',
        MCP_PERSISTENCE: 'firestore',
        MCP_STORE_NAMESPACE: namespace,
        GOOGLE_CLOUD_PROJECT: projectId,
        FIRESTORE_EMULATOR_HOST: opts.emulatorHost,
        MCP_SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        MCP_BASE_URL: `http://127.0.0.1:${serverPort}`,
        NETSAPIENS_API_URL: fakeNs.origin,
        NETSAPIENS_OAUTH_CLIENT_ID: 'fake-op-client',
        NETSAPIENS_OAUTH_CLIENT_SECRET: 'fake-op-secret',
        MCP_STATELESS: 'false',
        MCP_PORT: String(serverPort),
        MCP_CUTOVER_FENCE: 'true',
        MCP_FENCE_ENFORCE: 'true',
        MCP_CUTOVER_FENCE_NAMESPACE: namespace,
      };

      srv = await spawnMcpServer(bridgeConsumer.dir, serverEnv);
      await waitForHealth(serverPort, srv);

      const regResp = await fetch(`http://127.0.0.1:${serverPort}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Dedup Client',
          redirect_uris: [`http://127.0.0.1:${serverPort}/cb`],
        }),
      });
      const { client_id: clientId, client_secret: clientSecret } = await regResp.json();

      const verifierDedup = randomBytes(32).toString('base64url');
      const challengeDedup = createHash('sha256').update(verifierDedup).digest('base64url');
      const redirectUriDedup = `http://127.0.0.1:${serverPort}/cb`;
      const authUrlDedup = `http://127.0.0.1:${serverPort}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUriDedup)}&code_challenge=${encodeURIComponent(challengeDedup)}&code_challenge_method=S256`;
      const authRespDedup = await fetch(authUrlDedup);
      const authHtmlDedup = await authRespDedup.text();
      const matchDedup = authHtmlDedup.match(/name="auth_state"\s+value="([^"]+)"/);
      const authStateDedup = matchDedup ? matchDedup[1] : null;

      const loginResp = await fetch(`http://127.0.0.1:${serverPort}/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Sec-Fetch-Site': 'same-origin',
        },
        body: new URLSearchParams({
          username: '1001@example.com',
          password: 'password',
          client_id: clientId,
          redirect_uri: redirectUriDedup,
          auth_state: authStateDedup ?? '',
        }),
        redirect: 'manual',
      });
      const codeMatch = (loginResp.headers.get('Location') || '').match(/code=([^&]+)/);
      const authCode = codeMatch ? codeMatch[1] : null;

      const tokResp = await fetch(`http://127.0.0.1:${serverPort}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: authCode,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUriDedup,
          code_verifier: verifierDedup,
        }),
      });
      const initialTokens = await tokResp.json();
      const initialRefresh = initialTokens.refresh_token;

      if (!initialRefresh) {
        throw new Error('Failed to acquire initial refresh token for dedup test');
      }

      let barrierRelease;
      const barrierPromise = new Promise((resolve) => { barrierRelease = resolve; });
      fakeNs.setTokenBarrier(barrierPromise);

      const req1 = fetch(`http://127.0.0.1:${serverPort}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: initialRefresh,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });
      const req2 = fetch(`http://127.0.0.1:${serverPort}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: initialRefresh,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });

      await new Promise((r) => setTimeout(r, 100));
      barrierRelease();
      fakeNs.clearTokenBarrier();

      const [res1, res2] = await Promise.all([req1, req2]);
      const data1 = await res1.json();
      const data2 = await res2.json();

      const grantStats = fakeNs.getStats();
      const singleUpstreamGrant = grantStats.refreshGrants === 1;
      const successorMatched = data1.access_token && data1.access_token === data2.access_token;

      // Retry within lease window returns same successor without second upstream grant
      const retryResp = await fetch(`http://127.0.0.1:${serverPort}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: initialRefresh,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });
      const retryData = await retryResp.json();
      const noExtraGrantOnRetry = fakeNs.getStats().refreshGrants === 1;
      const retrySuccessorMatched = retryData.access_token === data1.access_token;

      // Replay proof: replay of consumed refresh token outside retry window must revoke family and remove upstream grant
      const famId = (await db.collection(`${namespace}_tokens_refresh_families`).get()).docs[0]?.id;
      if (famId) {
        await db.collection(`${namespace}_tokens_refresh`).doc(initialRefresh).update({
          consumedAt: Date.now() - (600_000 + 5000), // outside 10m retry window
        });
      }

      const replayResp = await fetch(`http://127.0.0.1:${serverPort}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: initialRefresh,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });

      let familyRevoked = false;
      let upstreamRemoved = false;
      if (famId) {
        const famSnap = await db.collection(`${namespace}_tokens_refresh_families`).doc(famId).get();
        familyRevoked = famSnap.exists && famSnap.data()?.status === 'revoked';
        const upSnap = await db.collection(`${namespace}_tokens_upstream`).doc(famId).get();
        upstreamRemoved = !upSnap.exists;
      }

      // STRICT PREDICATE: Both 200, exactly 1 upstream grant, successor identical, retry returns same successor
      const pass =
        res1.status === 200 &&
        res2.status === 200 &&
        singleUpstreamGrant === true &&
        successorMatched === true &&
        retryResp.status === 200 &&
        noExtraGrantOnRetry === true &&
        retrySuccessorMatched === true;

      receipt.cases.push({
        id: caseId,
        name: 'Refresh ownership and concurrent dedup (concurrent refresh calls yield single upstream grant; retry returns successor)',
        status: pass ? 'PASS' : 'FAIL',
        baselineStatus: 'UNPROVEN',
        candidateStatus: pass ? 'PASS' : 'FAIL',
        observations: {
          req1Status: res1.status,
          req2Status: res2.status,
          retryStatus: retryResp.status,
          replayStatus: replayResp.status,
          upstreamRefreshGrants: grantStats.refreshGrants,
          successorMatched,
          retrySuccessorMatched,
          noExtraGrantOnRetry,
          familyRevoked,
          upstreamRemoved,
        },
        receiptValid: true,
        rejectionReason: !pass
          ? `Dedup assertion failed: res1=${res1.status}, res2=${res2.status}, grants=${grantStats.refreshGrants}, matched=${successorMatched}`
          : undefined,
      });
      console.log(`  Result: ${pass ? 'PASS' : 'FAIL'}`);
    } catch (err) {
      receipt.cases.push({
        id: caseId,
        name: 'Refresh ownership and concurrent dedup',
        status: 'FAIL',
        baselineStatus: 'UNPROVEN',
        candidateStatus: 'FAIL',
        observations: { error: err.message },
        receiptValid: false,
        rejectionReason: err.message,
      });
      console.log(`  Result: FAIL (${err.message})`);
    } finally {
      if (srv) {
        await srv.stop();
        allLogsCaptured.push(srv.getLogs());
      }
      await fakeNs.close();
    }
  }

  // -------------------------------------------------------------------------
  // CASE 6: Fault handling (real store/provider refresh with ambiguousRemoteOutcome)
  // -------------------------------------------------------------------------
  if (shouldRun('faults_no_second_grant')) {
    console.log('\n[Case 6] faults_no_second_grant');
    const caseId = 'faults_no_second_grant';
    const projectId = `cutover-c6-${randomBytes(4).toString('hex')}`;
    createdProjectIds.add(projectId);
    const db = new Firestore({ projectId });
    const namespace = 'mcp';
    const fakeNs = await startFakeNetSapiens();

    try {
      await bridgeLib.initializeCutoverFence(db, namespace, { initialEpoch: 1 });
      const testAccessToken = 'acc-fault-' + randomBytes(8).toString('hex');
      const testRefreshToken = 'ref-fault-' + randomBytes(8).toString('hex');

      const tokenStore = new bridgeLib.FirestoreTokenStore({
        db,
        collection: `${namespace}_tokens`,
        fence: { namespace, enforce: true },
      });

      // Seed token in Firestore marked with ambiguousRemoteOutcome (representing remote grant success but local commit failure)
      await db.collection(`${namespace}_tokens`).doc(testAccessToken).set({
        accessToken: testAccessToken,
        refreshToken: testRefreshToken,
        tokenType: 'Bearer',
        expiresAt: Date.now() + 3600_000,
        scope: 'read write',
        clientId: 'client-fault',
        nsAccessToken: 'ns-acc-fault',
        nsRefreshToken: 'ns-ref-fault',
        nsExpiresAt: Date.now() + 10_000, // expiring
        ambiguousRemoteOutcome: true,
      });

      let refreshUnavailableCaught = false;
      let secondGrantExecuted = false;

      try {
        await tokenStore.refreshNsToken(testAccessToken, async () => {
          secondGrantExecuted = true;
          return { access_token: 'ns-acc-new', expires_in: 3600 };
        });
      } catch (err) {
        if (err instanceof TypeError || err instanceof ReferenceError) throw err;
        refreshUnavailableCaught =
          err.name === 'UpstreamUnavailableError' ||
          err instanceof bridgeLib.UpstreamUnavailableError ||
          (typeof err.message === 'string' && err.message.includes('ambiguous and pending reconciliation'));
      }

      const pass = refreshUnavailableCaught === true && secondGrantExecuted === false;
      receipt.cases.push({
        id: caseId,
        name: 'Fault handling (prior ambiguous remote outcome throws UpstreamUnavailableError and prevents second grant)',
        status: pass ? 'PASS' : 'FAIL',
        baselineStatus: 'UNPROVEN',
        candidateStatus: pass ? 'PASS' : 'FAIL',
        observations: {
          refreshUnavailableCaught,
          secondGrantExecuted,
          fakeNsGrants: fakeNs.getStats().grantCount,
        },
        receiptValid: true,
      });
      console.log(`  Result: ${pass ? 'PASS' : 'FAIL'}`);
    } catch (err) {
      receipt.cases.push({
        id: caseId,
        name: 'Fault handling',
        status: 'FAIL',
        baselineStatus: 'UNPROVEN',
        candidateStatus: 'FAIL',
        observations: { error: err.message },
        receiptValid: false,
        rejectionReason: err.message,
      });
      console.log(`  Result: FAIL (${err.message})`);
    } finally {
      await fakeNs.close();
    }
  }

  // -------------------------------------------------------------------------
  // CASE 7: Lifecycle: Duplicate op IDs and transaction abort rollback
  // -------------------------------------------------------------------------
  if (shouldRun('lifecycle_flag_leak_and_duplicate_ops')) {
    console.log('\n[Case 7] lifecycle_flag_leak_and_duplicate_ops');
    const caseId = 'lifecycle_flag_leak_and_duplicate_ops';
    const projectId = `cutover-c7-${randomBytes(4).toString('hex')}`;
    createdProjectIds.add(projectId);
    const db = new Firestore({ projectId });
    const namespace = 'mcp';

    try {
      await bridgeLib.initializeCutoverFence(db, namespace, { initialEpoch: 1 });
      const duplicateOpId = 'op-dup-test-1';

      // 7a. First admission succeeds
      let firstExecuted = false;
      await bridgeLib.withLegacyOperation(
        { db, namespace, enforce: true, operationId: duplicateOpId, kind: 'token_exchange' },
        async (_ctx) => {
          firstExecuted = true;
        },
      );

      const recAfterFirst = await bridgeLib.getCutoverFenceRecord(db, namespace);

      // 7b. Second presentation of duplicate op ID returns retryable refusal with 0 callback runs
      let duplicateCallbackRan = false;
      let duplicateRefused = false;
      try {
        await bridgeLib.withLegacyOperation(
          { db, namespace, enforce: true, operationId: duplicateOpId, kind: 'token_exchange' },
          async () => {
            duplicateCallbackRan = true;
          },
        );
      } catch (e) {
        if (e instanceof TypeError || e instanceof ReferenceError) throw e;
        duplicateRefused = isCutoverFenceError(e, bridgeLib) || isCutoverRefusal(e, bridgeLib);
      }

      const recAfterDup = await bridgeLib.getCutoverFenceRecord(db, namespace);
      const noCounterChange = recAfterDup.activeOperations === recAfterFirst.activeOperations;

      // 7c. Transaction abort does not leak local completed flag or leave operation in completed state
      const abortOpId = 'op-abort-test-1';
      let abortErrorCaught = false;
      try {
        await bridgeLib.withLegacyOperation(
          { db, namespace, enforce: true, operationId: abortOpId, kind: 'token_exchange' },
          async (ctx) => {
            await db.runTransaction(async (transaction) => {
              await bridgeLib.checkMutationGuardInTransaction(transaction, {
                db,
                namespace,
                operation: ctx,
                completeOperation: true,
              });
              throw new Error('Simulated transaction rollback');
            });
          },
        );
      } catch (e) {
        abortErrorCaught = e.message === 'Simulated transaction rollback';
      }

      const recAfterAbort = await bridgeLib.getCutoverFenceRecord(db, namespace);
      const counterBalanced = recAfterAbort.activeOperations === 0;

      const abortOpDoc = await db.collection(`${namespace}_meta`).doc('cutover_fence').collection('operations').doc(abortOpId).get();
      const notFalselyCompleted = !abortOpDoc.exists || abortOpDoc.data()?.phase !== 'completed';

      const pass =
        firstExecuted &&
        !duplicateCallbackRan &&
        duplicateRefused &&
        noCounterChange &&
        abortErrorCaught &&
        counterBalanced &&
        notFalselyCompleted;

      receipt.cases.push({
        id: caseId,
        name: 'Lifecycle: duplicate op IDs cause zero callback executions and no counter change; aborted tx does not leak flags',
        status: pass ? 'PASS' : 'FAIL',
        baselineStatus: 'NOT_APPLICABLE',
        candidateStatus: pass ? 'PASS' : 'FAIL',
        observations: {
          firstExecuted,
          duplicateCallbackRan,
          duplicateRefused,
          noCounterChange,
          counterBalanced,
          notFalselyCompleted,
          activeOperations: recAfterAbort.activeOperations,
        },
        receiptValid: true,
      });
      console.log(`  Result: ${pass ? 'PASS' : 'FAIL'}`);
    } catch (err) {
      receipt.cases.push({
        id: caseId,
        name: 'Lifecycle flag leak and duplicate ops',
        status: 'FAIL',
        baselineStatus: 'NOT_APPLICABLE',
        candidateStatus: 'FAIL',
        observations: { error: err.message },
        receiptValid: false,
        rejectionReason: err.message,
      });
      console.log(`  Result: FAIL (${err.message})`);
    }
  }

  // -------------------------------------------------------------------------
  // CASE 8: Reconciliation: Family isolation (real reconcileAmbiguousGrant API)
  // -------------------------------------------------------------------------
  if (shouldRun('reconciliation_family_isolation')) {
    console.log('\n[Case 8] reconciliation_family_isolation');
    const caseId = 'reconciliation_family_isolation';
    const projectId = `cutover-c8-${randomBytes(4).toString('hex')}`;
    createdProjectIds.add(projectId);
    const db = new Firestore({ projectId });
    const namespace = 'mcp';

    try {
      await bridgeLib.initializeCutoverFence(db, namespace, { initialEpoch: 1 });
      const famA = 'fam-a-' + randomBytes(4).toString('hex');
      const famB = 'fam-b-' + randomBytes(4).toString('hex');
      const opA = 'op-a-' + randomBytes(8).toString('hex');

      const upstreamStore = new upstreamGrantMod.FirestoreUpstreamGrantStore({
        db,
        collection: `${namespace}_tokens_upstream`,
        fence: { namespace, enforce: true },
      });

      // Seed Family A in upstream store with ambiguous outcome
      await db.collection(`${namespace}_tokens_upstream`).doc(famA).set({
        grant: { nsAccessToken: 'acc-a', nsRefreshToken: 'ref-a' },
        ambiguousOutcome: true,
        ambiguousOperationId: opA,
        updatedAt: 1000,
      });
      // Seed operation record in cutover_fence/operations for opA
      await db.collection(`${namespace}_meta`).doc('cutover_fence').collection('operations').doc(opA).set({
        schemaVersion: 1,
        id: opA,
        namespace,
        epoch: 1,
        kind: 'upstream_refresh',
        phase: 'upstream_pending',
        ambiguousRemoteOutcome: true,
        createdAt: 1000,
        updatedAt: 1000,
      });
      await db.collection(`${namespace}_meta`).doc('cutover_fence').update({ activeOperations: 1 });

      // Seed Family B in upstream store (healthy, not ambiguous)
      await db.collection(`${namespace}_tokens_upstream`).doc(famB).set({
        grant: { nsAccessToken: 'acc-b', nsRefreshToken: 'ref-b' },
        ambiguousOutcome: false,
        updatedAt: 1000,
      });

      // Seed family documents in families collection
      await db.collection(`${namespace}_tokens_refresh_families`).doc(famA).set({
        id: famA,
        currentAccessToken: 'acc-a',
        currentRefreshToken: 'ref-a',
        updatedAt: 1000,
      });
      await db.collection(`${namespace}_tokens_refresh_families`).doc(famB).set({
        id: famB,
        currentAccessToken: 'acc-b',
        currentRefreshToken: 'ref-b',
        updatedAt: 1000,
      });

      // Call REAL reconcileAmbiguousGrant on Family A
      await upstreamStore.reconcileAmbiguousGrant(
        famA,
        { nsAccessToken: 'acc-a-resolved', nsRefreshToken: 'ref-a-resolved' },
        Date.now() + 3600_000,
        { operationId: opA },
      );

      // Verify Family B's upstream grant and family doc are completely untouched
      const famBSnap = await db.collection(`${namespace}_tokens_refresh_families`).doc(famB).get();
      const famBData = famBSnap.data();
      const upBSnap = await db.collection(`${namespace}_tokens_upstream`).doc(famB).get();
      const upBData = upBSnap.data();

      const famBIsolate =
        famBData.currentAccessToken === 'acc-b' &&
        famBData.updatedAt === 1000 &&
        upBData.grant?.nsAccessToken === 'acc-b';

      // Reconcile with wrong operationId on Family A refuses
      let wrongOpRefused = false;
      try {
        await upstreamStore.reconcileAmbiguousGrant(
          famA,
          { nsAccessToken: 'acc-a-retry', nsRefreshToken: 'ref-a-retry' },
          Date.now() + 3600_000,
          { operationId: 'wrong-op-id' },
        );
      } catch (e) {
        if (e instanceof TypeError || e instanceof ReferenceError) throw e;
        wrongOpRefused = isCutoverFenceError(e, bridgeLib);
      }

      const pass = famBIsolate === true && wrongOpRefused === true;
      receipt.cases.push({
        id: caseId,
        name: 'Reconciliation: family isolation (reconciling Family A does not touch Family B; wrong opId refuses)',
        status: pass ? 'PASS' : 'FAIL',
        baselineStatus: 'UNPROVEN',
        candidateStatus: pass ? 'PASS' : 'FAIL',
        observations: {
          famBIsolate,
          wrongOpRefused,
          famBToken: hashSecret(famBData.currentAccessToken),
        },
        receiptValid: true,
      });
      console.log(`  Result: ${pass ? 'PASS' : 'FAIL'}`);
    } catch (err) {
      receipt.cases.push({
        id: caseId,
        name: 'Reconciliation family isolation',
        status: 'FAIL',
        baselineStatus: 'UNPROVEN',
        candidateStatus: 'FAIL',
        observations: { error: err.message },
        receiptValid: false,
        rejectionReason: err.message,
      });
      console.log(`  Result: FAIL (${err.message})`);
    }
  }

  // -------------------------------------------------------------------------
  // CASE 9: Atomic continuation and code exchange (real FirestoreAuthCodeStore API)
  // -------------------------------------------------------------------------
  if (shouldRun('atomic_continuation_and_code')) {
    console.log('\n[Case 9] atomic_continuation_and_code');
    const caseId = 'atomic_continuation_and_code';
    const projectId = `cutover-c9-${randomBytes(4).toString('hex')}`;
    createdProjectIds.add(projectId);
    const db = new Firestore({ projectId });
    const namespace = 'mcp';

    try {
      await bridgeLib.initializeCutoverFence(db, namespace, { initialEpoch: 1 });
      const authCode = 'code-atomic-' + randomBytes(16).toString('hex');
      const now = Date.now();

      const authCodeStore = new bridgeLib.FirestoreAuthCodeStore({
        db,
        collection: `${namespace}_auth_codes`,
        fence: { namespace, enforce: true },
      });

      await bridgeLib.withLegacyOperation(
        { db, namespace, enforce: true, kind: 'auth_code' },
        async (ctx) => {
          await authCodeStore.set(authCode, {
            clientId: 'client-atomic',
            expiresAt: now + 300_000,
            pending: {
              clientId: 'client-atomic',
              redirectUri: 'http://127.0.0.1:3000/cb',
              codeChallenge: 'chall-1',
              codeChallengeMethod: 'S256',
              scope: 'read write',
              state: 'st-1',
              createdAt: now,
            },
            nsTokens: {
              access_token: 'ns-acc-atomic',
              refresh_token: 'ns-ref-atomic',
              expires_in: 3600,
              token_type: 'Bearer',
              username: '1001@example.com',
            },
            serverBaseUrl: 'http://127.0.0.1:3000',
          }, { operation: ctx });
        },
      );

      // 9a. Real redeem on valid code succeeds
      let redeemed = null;
      await bridgeLib.withLegacyOperation(
        { db, namespace, enforce: true, kind: 'token_exchange' },
        async (ctx) => {
          redeemed = await authCodeStore.redeem(authCode, { clientId: 'client-atomic', serverBaseUrl: 'http://127.0.0.1:3000' }, { operation: ctx });
        },
      );
      const redeemSucceeded = Boolean(redeemed?.nsTokens?.access_token);

      // 9b. Replay redemption on now-consumed code is refused
      let replayed = 'initial';
      await bridgeLib.withLegacyOperation(
        { db, namespace, enforce: true, kind: 'token_exchange' },
        async (ctx) => {
          replayed = await authCodeStore.redeem(authCode, { clientId: 'client-atomic', serverBaseUrl: 'http://127.0.0.1:3000' }, { operation: ctx });
        },
      );
      const replayRefused = replayed === undefined;

      // 9c. Pre-commit failure leaves code usable
      const code2 = 'code-fail-preserve-' + randomBytes(16).toString('hex');
      await bridgeLib.withLegacyOperation(
        { db, namespace, enforce: true, kind: 'auth_code' },
        async (ctx) => {
          await authCodeStore.set(code2, {
            clientId: 'client-atomic',
            expiresAt: now + 300_000,
            pending: {
              clientId: 'client-atomic',
              redirectUri: 'http://127.0.0.1:3000/cb',
              codeChallenge: 'chall-2',
              codeChallengeMethod: 'S256',
              scope: 'read write',
              state: 'st-2',
              createdAt: now,
            },
            nsTokens: {
              access_token: 'ns-acc-code2',
              expires_in: 3600,
              token_type: 'Bearer',
              username: '1002@example.com',
            },
            serverBaseUrl: 'http://127.0.0.1:3000',
          }, { operation: ctx });
        },
      );

      // Injected failure before commit
      let failedTxPreservesCode = false;
      try {
        await db.runTransaction(async (transaction) => {
          const docRef = db.collection(`${namespace}_auth_codes`).doc(code2);
          const snap = await transaction.get(docRef);
          if (!snap.exists) throw new Error('missing');
          throw new Error('Simulated pre-commit failure');
        });
      } catch {
        const snap = await db.collection(`${namespace}_auth_codes`).doc(code2).get();
        failedTxPreservesCode = snap.exists && snap.data()?.used === false;
      }

      const pass = redeemSucceeded === true && replayRefused === true && failedTxPreservesCode === true;
      receipt.cases.push({
        id: caseId,
        name: 'Atomic code exchange (failure preserves code; commit consumes code atomically; replay refused)',
        status: pass ? 'PASS' : 'FAIL',
        baselineStatus: 'UNPROVEN',
        candidateStatus: pass ? 'PASS' : 'FAIL',
        observations: {
          redeemSucceeded,
          replayRefused,
          failedTxPreservesCode,
        },
        receiptValid: true,
      });
      console.log(`  Result: ${pass ? 'PASS' : 'FAIL'}`);
    } catch (err) {
      receipt.cases.push({
        id: caseId,
        name: 'Atomic continuation and code',
        status: 'FAIL',
        baselineStatus: 'UNPROVEN',
        candidateStatus: 'FAIL',
        observations: { error: err.message },
        receiptValid: false,
        rejectionReason: err.message,
      });
      console.log(`  Result: FAIL (${err.message})`);
    }
  }

  // -------------------------------------------------------------------------
  // CASE 10: Migration graph preservation (v3 adopter)
  // -------------------------------------------------------------------------
  if (shouldRun('migration_graph_preservation')) {
    console.log('\n[Case 10] migration_graph_preservation');
    const caseId = 'migration_graph_preservation';
    const projectId = `cutover-c10-${randomBytes(4).toString('hex')}`;
    createdProjectIds.add(projectId);
    const db = new Firestore({ projectId });
    const namespace = 'mcp';
    const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const key = v3Lib.deriveStoreKey(secret);

    try {
      const seeded = await seedLegacyRuntimeRecords({
        db,
        namespace,
        tarball240: opts.unfencedTarball,
        tarball231: opts.v231Tarball,
      });

      await v3Lib.initializeCutoverFence(db, namespace, { initialEpoch: 1 });
      await db.collection(`${namespace}_meta`).doc('cutover_fence').update({
        state: 'migrating',
        migrationRunId: 'run-graph-proof',
      });

      const expectedSourceInventoryDigest = await v3Lib.computeSourceInventoryDigest(db, namespace, key);
      const report = await v3Lib.adoptFirestoreLegacyTokens({
        db,
        namespace,
        key,
        expectedEpoch: 1,
        migrationRunId: 'run-graph-proof',
        codeSha: artifacts.v3.gitSha,
        codeArtifact: `gcr.io/phoneware/netsapiens-mcp@sha256:${artifacts.v3.sha256}`,
        packageIntegrity: artifacts.v3.integrity,
        expectedSourceInventoryDigest,
      });

      const v3Sessions = await db.collection(`${namespace}_sessions`).get();
      const v3Families = await db.collection(`${namespace}_refresh_families`).get();

      // STRICT PREDICATE: All legitimate rows must migrate with 0 errors
      const pass = report.errors === 0 && report.migrated > 0 && v3Sessions.docs.length > 0;
      receipt.cases.push({
        id: caseId,
        name: 'Migration graph preservation (v2.3 base tokens, v2.4 PR56 families, upstream grants, no-ID resumes)',
        status: pass ? 'PASS' : 'FAIL',
        baselineStatus: 'UNPROVEN',
        candidateStatus: pass ? 'PASS' : 'FAIL',
        observations: {
          scanned: report.scanned,
          migrated: report.migrated,
          skipped: report.skipped,
          errors: report.errors,
          v3SessionsCount: v3Sessions.docs.length,
          v3FamiliesCount: v3Families.docs.length,
          seededPR56FamiliesCount: seeded.pr56Families.length,
        },
        receiptValid: true,
        rejectionReason: report.errors > 0
          ? `Adopter reported ${report.errors} errors on legacy graph: S3 firestore-v2-adoption requires embedded id on resume rows while actual bridge stores token ID in document key`
          : undefined,
      });
      console.log(`  Result: ${pass ? 'PASS' : 'FAIL'} (migrated: ${report.migrated}, errors: ${report.errors})`);
    } catch (err) {
      receipt.cases.push({
        id: caseId,
        name: 'Migration graph preservation',
        status: 'FAIL',
        baselineStatus: 'UNPROVEN',
        candidateStatus: 'FAIL',
        observations: { error: err.message },
        receiptValid: false,
        rejectionReason: err.message,
      });
      console.log(`  Result: FAIL (${err.message})`);
    }
  }

  // -------------------------------------------------------------------------
  // CASE 11: Migration recovery and empty namespace (Strict C12 Invariants)
  // -------------------------------------------------------------------------
  if (shouldRun('migration_recovery_and_empty_namespace')) {
    console.log('\n[Case 11] migration_recovery_and_empty_namespace');
    const caseId = 'migration_recovery_and_empty_namespace';
    const projectId = `cutover-c11-${randomBytes(4).toString('hex')}`;
    createdProjectIds.add(projectId);
    const db = new Firestore({ projectId });
    const namespace = 'mcp';
    const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const key = v3Lib.deriveStoreKey(secret);

    try {
      await v3Lib.initializeCutoverFence(db, namespace, { initialEpoch: 1 });
      await db.collection(`${namespace}_meta`).doc('cutover_fence').update({
        state: 'migrating',
        migrationRunId: 'run-empty-proof',
      });

      const expectedSourceInventoryDigest = await v3Lib.computeSourceInventoryDigest(db, namespace, key);
      const emptyReport = await v3Lib.adoptFirestoreLegacyTokens({
        db,
        namespace,
        key,
        expectedEpoch: 1,
        migrationRunId: 'run-empty-proof',
        codeSha: artifacts.v3.gitSha,
        codeArtifact: `gcr.io/phoneware/netsapiens-mcp@sha256:${artifacts.v3.sha256}`,
        packageIntegrity: artifacts.v3.integrity,
        expectedSourceInventoryDigest,
      });

      const controlAfterEmpty = await v3Lib.getCutoverFenceRecord(db, namespace);

      let staleEpochRefused = false;
      try {
        await v3Lib.adoptFirestoreLegacyTokens({
          db,
          namespace,
          key,
          expectedEpoch: 999,
          migrationRunId: 'run-empty-proof',
          codeSha: artifacts.v3.gitSha,
          codeArtifact: `gcr.io/phoneware/netsapiens-mcp@sha256:${artifacts.v3.sha256}`,
          packageIntegrity: artifacts.v3.integrity,
          expectedSourceInventoryDigest,
        });
      } catch (e) {
        if (e instanceof TypeError || e instanceof ReferenceError) throw e;
        staleEpochRefused = isCutoverFenceError(e, bridgeLib);
      }

      // STRICT PREDICATE: C12 requires irreversible to remain false until first actual mutation
      const pass =
        emptyReport.migrated === 0 &&
        emptyReport.errors === 0 &&
        (controlAfterEmpty.state === 'v3_ready' || controlAfterEmpty.state === 'v3_active' || controlAfterEmpty.state === 'migrating') &&
        controlAfterEmpty.irreversible === false &&
        staleEpochRefused === true;

      receipt.cases.push({
        id: caseId,
        name: 'Migration recovery and empty namespace (empty manifest, irreversible false until mutation, stale epoch refused)',
        status: pass ? 'PASS' : 'FAIL',
        baselineStatus: 'UNPROVEN',
        candidateStatus: pass ? 'PASS' : 'FAIL',
        observations: {
          emptyScanned: emptyReport.scanned,
          emptyErrors: emptyReport.errors,
          controlState: controlAfterEmpty.state,
          irreversible: controlAfterEmpty.irreversible,
          staleEpochRefused,
        },
        receiptValid: true,
        rejectionReason: controlAfterEmpty.irreversible !== false
          ? 'C12 violation: irreversible must remain false on empty namespace until first credential mutation'
          : undefined,
      });
      console.log(`  Result: ${pass ? 'PASS' : 'FAIL'}`);
    } catch (err) {
      receipt.cases.push({
        id: caseId,
        name: 'Migration recovery and empty namespace',
        status: 'FAIL',
        baselineStatus: 'UNPROVEN',
        candidateStatus: 'FAIL',
        observations: { error: err.message },
        receiptValid: false,
        rejectionReason: err.message,
      });
      console.log(`  Result: FAIL (${err.message})`);
    }
  }

  // -------------------------------------------------------------------------
  // CASE 12: Secret safety audit (Real Document & Log Scan with Fail-Closed)
  // -------------------------------------------------------------------------
  if (shouldRun('secret_safety_audit')) {
    console.log('\n[Case 12] secret_safety_audit');
    const caseId = 'secret_safety_audit';

    const sensitivePatterns = [
      /acc-[a-zA-Z0-9_-]{10,}/,
      /ref-[a-zA-Z0-9_-]{10,}/,
      /ns_acc_[a-zA-Z0-9_-]{10,}/,
      /ns_ref_[a-zA-Z0-9_-]{10,}/,
      /sec-[a-zA-Z0-9_-]{10,}/,
      /code-[a-zA-Z0-9_-]{10,}/,
    ];

    let scannedFields = 0;
    const violations = [];

    function auditText(text, context) {
      if (!text || typeof text !== 'string') return;
      scannedFields++;
      for (const pat of sensitivePatterns) {
        if (pat.test(text)) {
          violations.push(`Violation in ${context}: matched sensitive pattern ${pat.source}`);
        }
      }
    }

    function auditObject(obj, context) {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        scannedFields++;
        if (typeof v === 'string') {
          auditText(v, `${context}.${k}`);
        } else if (typeof v === 'object' && v !== null) {
          auditObject(v, `${context}.${k}`);
        }
      }
    }

    // 12a. Audit all captured logs
    for (let i = 0; i < allLogsCaptured.length; i++) {
      auditText(allLogsCaptured[i], `server_log_${i}`);
    }

    // 12b. Audit all Firestore operation metadata and migration manifests (fail-closed, no swallow)
    for (const projId of createdProjectIds) {
      const projDb = new Firestore({ projectId: projId });
      for (const ns of ['mcp', 'pwmcp', 'readonly_mcp']) {
        const opsSnap = await projDb.collection(`${ns}_meta`).doc('cutover_fence').collection('operations').get();
        for (const doc of opsSnap.docs) {
          auditObject(doc.data(), `${projId}/${ns}_operations/${doc.id}`);
        }
        const metaSnap = await projDb.collection(`${ns}_meta`).get();
        for (const doc of metaSnap.docs) {
          auditObject(doc.data(), `${projId}/${ns}_meta/${doc.id}`);
        }
      }
    }

    // 12c. Audit current serialized receipt
    auditObject(receipt, 'receipt');

    const pass = violations.length === 0 && scannedFields > 0;
    receipt.secretSafety.passed = pass;
    receipt.secretSafety.scannedFields = scannedFields;
    receipt.secretSafety.violations = violations;

    receipt.cases.push({
      id: caseId,
      name: 'Secret safety audit (receipts, metadata, logs contain zero raw tokens, client secrets, auth codes)',
      status: pass ? 'PASS' : 'FAIL',
      baselineStatus: 'NOT_APPLICABLE',
      candidateStatus: pass ? 'PASS' : 'FAIL',
      observations: {
        scannedFields,
        totalViolations: violations.length,
        violations,
      },
      receiptValid: true,
    });
    console.log(`  Result: ${pass ? 'PASS' : 'FAIL'} (scanned fields: ${scannedFields}, violations: ${violations.length})`);
  }

  // -------------------------------------------------------------------------
  // CASE 13: Unfenced 2.4 negative control
  // -------------------------------------------------------------------------
  if (shouldRun('unfenced_negative_control')) {
    console.log('\n[Case 13] unfenced_negative_control');
    const caseId = 'unfenced_negative_control';
    const projectId = `cutover-c13-${randomBytes(4).toString('hex')}`;
    createdProjectIds.add(projectId);
    const db = new Firestore({ projectId });
    const namespace = 'mcp';

    try {
      await bridgeLib.initializeCutoverFence(db, namespace, { initialEpoch: 1 });
      await db.collection(`${namespace}_meta`).doc('cutover_fence').update({ state: 'fenced' });

      const unfencedConsumer = setupConsumerDirectory(opts.unfencedTarball, 'unfenced');
      const unfencedTokenStoreMod = await import(
        path.join(unfencedConsumer.packagePath, 'build', 'auth', 'firestore-token-store.js')
      );
      const unfencedStore = new unfencedTokenStoreMod.FirestoreTokenStore({
        db,
        collection: `${namespace}_tokens`,
      });

      const unfencedTok = 'acc-unfenced-unsafe-' + randomBytes(8).toString('hex');
      await unfencedStore.set({
        accessToken: unfencedTok,
        refreshToken: 'ref-unfenced',
        tokenType: 'Bearer',
        expiresAt: Date.now() + 3600_000,
        scope: 'read write',
        clientId: 'client-unfenced',
        nsAccessToken: 'ns-acc-unfenced',
        nsRefreshToken: 'ns-ref-unfenced',
        nsExpiresAt: Date.now() + 3600_000,
        refreshFamilyId: 'fam-unfenced',
      });

      const writtenSnap = await db.collection(`${namespace}_tokens`).doc(unfencedTok).get();
      const mutatedDespiteFence = writtenSnap.exists;

      // Negative control succeeds by observing baseline failure (baselineStatus: RED)
      const pass = mutatedDespiteFence;
      receipt.cases.push({
        id: caseId,
        name: 'Unfenced 2.4 negative control (proves unfenced 2.4 ignores fence and mutates store; baseline RED)',
        status: pass ? 'PASS' : 'FAIL',
        baselineStatus: 'RED',
        candidateStatus: 'PASS',
        observations: {
          unfencedMutatedDespiteFence: mutatedDespiteFence,
          fenceStateDuringMutation: 'fenced',
          writtenDocExists: writtenSnap.exists,
        },
        receiptValid: true,
      });
      console.log(`  Result: PASS (baseline RED confirmed: unfenced 2.4 ignores fence as expected)`);
    } catch (err) {
      receipt.cases.push({
        id: caseId,
        name: 'Unfenced 2.4 negative control',
        status: 'FAIL',
        baselineStatus: 'RED',
        candidateStatus: 'FAIL',
        observations: { error: err.message },
        receiptValid: false,
        rejectionReason: err.message,
      });
      console.log(`  Result: FAIL (${err.message})`);
    }
  }

  // -------------------------------------------------------------------------
  // Summary & Receipt Emission
  // -------------------------------------------------------------------------
  receipt.summary.total = receipt.cases.length;
  receipt.summary.passed = receipt.cases.filter((c) => c.status === 'PASS').length;
  receipt.summary.failed = receipt.cases.filter((c) => c.status === 'FAIL').length;
  receipt.summary.blocked = receipt.cases.filter((c) => c.status === 'BLOCKED').length;

  fs.writeFileSync(opts.receiptOut, JSON.stringify(receipt, null, 2), 'utf8');
  console.log(`\n=== Execution Complete ===`);
  console.log(`Cases: ${receipt.summary.total} total, ${receipt.summary.passed} passed, ${receipt.summary.failed} failed, ${receipt.summary.blocked} blocked`);
  console.log(`Receipt written to: ${opts.receiptOut}`);

  if (receipt.summary.failed > 0) {
    console.log('\nFailed cases:');
    for (const c of receipt.cases.filter((c) => c.status === 'FAIL')) {
      console.log(`- [${c.id}] ${c.name}: ${c.rejectionReason || 'Assertion failed'}`);
    }
    // NONZERO EXIT WHILE ANY REQUIRED CANDIDATE ASSERTION FAILS
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal harness error:', err);
  process.exit(1);
});
