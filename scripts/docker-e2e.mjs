#!/usr/bin/env node
/**
 * Docker end-to-end proof for netsapiens-mcp.
 *
 * Verifies:
 * 1. Dockerfile builds cleanly into a runnable image.
 * 2. Starts with named volume and explicit NetSapiens URL + session secret.
 * 3. /health reports store.backend === 'sqlite'.
 * 4. stat -c '%a %U' /home/nodejs/.netsapiens-mcp/mcp.sqlite prints '600 nodejs'.
 * 5. A second container sharing the same named volume exits non-zero with
 *    "is in use by another process".
 * 6. Cleans up its own containers, volume, and image.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const cp = spawn(command, args, {
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

function pass(assertion) {
  console.log(`PASS docker ${assertion}`);
}

function fail(assertion, reason) {
  console.error(`FAIL docker ${assertion}: ${reason}`);
  process.exit(1);
}

async function main() {
  const runId = randomBytes(4).toString('hex');
  const imageName = `nsmcp-docker-e2e:${runId}`;
  const volumeName = `nsmcp-vol-${runId}`;
  const container1 = `nsmcp-c1-${runId}`;
  const container2 = `nsmcp-c2-${runId}`;
  const port = await getAvailablePort();
  const sessionSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  console.log(`Starting docker-e2e [runId=${runId}, port=${port}]`);

  try {
    // 1. Build Dockerfile
    const buildRes = await run('docker', ['build', '-t', imageName, '.']);
    if (buildRes.status !== 0) {
      fail('image-build', `docker build exited ${buildRes.status}: ${buildRes.stderr || buildRes.stdout}`);
    }
    pass('image-build');

    // 2. Create named volume
    const volRes = await run('docker', ['volume', 'create', volumeName]);
    if (volRes.status !== 0) {
      fail('volume-create', `docker volume create exited ${volRes.status}: ${volRes.stderr}`);
    }
    pass('volume-create');

    // 3. Start Container 1
    const runRes = await run('docker', [
      'run', '-d',
      '--name', container1,
      '-v', `${volumeName}:/home/nodejs/.netsapiens-mcp`,
      '-p', `127.0.0.1:${port}:3000`,
      '-e', 'NETSAPIENS_API_URL=https://netsapiens.example.com',
      '-e', 'NETSAPIENS_OAUTH_CLIENT_ID=dummy-client-id',
      '-e', 'NETSAPIENS_OAUTH_CLIENT_SECRET=dummy-client-secret',
      '-e', `MCP_SESSION_SECRET=${sessionSecret}`,
      imageName,
    ]);
    if (runRes.status !== 0) {
      fail('container-start', `docker run container1 exited ${runRes.status}: ${runRes.stderr}`);
    }

    // 4. Poll /health until server responds
    let healthData = null;
    for (let i = 0; i < 40; i++) {
      await delay(500);
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/health`);
        if (resp.ok) {
          healthData = await resp.json();
          break;
        }
      } catch {
        // Retry
      }
    }

    if (!healthData) {
      const logs = await run('docker', ['logs', container1]);
      fail('health-check', `server failed to answer /health within timeout. Logs:\n${logs.stdout}\n${logs.stderr}`);
    }

    if (healthData.store?.backend !== 'sqlite') {
      fail('health-store-backend', `expected store.backend === 'sqlite', got '${healthData.store?.backend}'`);
    }
    pass('health-store-backend');

    // 5. Stat sqlite file inside container
    const statRes = await run('docker', [
      'exec', container1,
      'stat', '-c', '%a %U', '/home/nodejs/.netsapiens-mcp/mcp.sqlite',
    ]);
    if (statRes.status !== 0) {
      fail('sqlite-file-stat', `stat command failed (${statRes.status}): ${statRes.stderr}`);
    }
    const statOutput = statRes.stdout.trim();
    if (statOutput !== '600 nodejs') {
      fail('sqlite-file-stat', `expected '600 nodejs', got '${statOutput}'`);
    }
    pass('sqlite-file-stat');

    // 6. Run container 2 on same volume - must exit non-zero with locked error
    const run2Res = await run('docker', [
      'run',
      '--name', container2,
      '-v', `${volumeName}:/home/nodejs/.netsapiens-mcp`,
      '-e', 'NETSAPIENS_API_URL=https://netsapiens.example.com',
      '-e', 'NETSAPIENS_OAUTH_CLIENT_ID=dummy-client-id',
      '-e', 'NETSAPIENS_OAUTH_CLIENT_SECRET=dummy-client-secret',
      '-e', `MCP_SESSION_SECRET=${sessionSecret}`,
      imageName,
    ]);

    const combinedOutput = `${run2Res.stdout}\n${run2Res.stderr}`;
    if (run2Res.status === 0) {
      fail('second-container-lock', 'expected container 2 to exit non-zero, but exited 0');
    }
    if (!combinedOutput.includes('is in use by another process')) {
      fail('second-container-lock', `expected "is in use by another process" in output, got:\n${combinedOutput}`);
    }
    pass('second-container-lock');

  } finally {
    // Cleanup: remove only our own containers, volume, image
    await run('docker', ['rm', '-f', container1]);
    await run('docker', ['rm', '-f', container2]);
    await run('docker', ['volume', 'rm', volumeName]);
    await run('docker', ['rmi', '-f', imageName]);
  }
}

main().catch((err) => {
  console.error('FAIL docker unexpected-error:', err);
  process.exit(1);
});
