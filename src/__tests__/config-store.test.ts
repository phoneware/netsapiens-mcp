import { afterAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const testHome = mkdtempSync(join(tmpdir(), 'nsmcp-config-store-test-'));
afterAll(() => rmSync(testHome, { recursive: true, force: true }));

const args = ['--import', 'tsx', 'src/index.ts'];
const baseEnv = {
  PATH: process.env.PATH,
  HOME: testHome,
  TMPDIR: testHome,
  MCP_TRANSPORT: 'http',
  NETSAPIENS_API_URL: 'https://netsapiens.example.com',
  NETSAPIENS_OAUTH_CLIENT_ID: 'client',
  NETSAPIENS_OAUTH_CLIENT_SECRET: 'secret',
  MCP_SESSION_SECRET: 'a'.repeat(32),
};

function startup(env: Record<string, string | undefined>) {
  return spawnSync(process.execPath, args, {
    env: { ...baseEnv, ...env },
    encoding: 'utf8',
    timeout: 5000,
  });
}

describe('config-store', () => {
  it.each([
    [{ MCP_SESSION_SECRET: undefined }, 'ConfigError: MCP_SESSION_SECRET must be at least 32 characters'],
    [{ MCP_SESSION_SECRET: 'x'.repeat(31) }, 'ConfigError: MCP_SESSION_SECRET must be at least 32 characters'],
    [
      { GOOGLE_CLOUD_PROJECT: 'my-project', MCP_PERSISTENCE: undefined },
      'ConfigError: MCP_PERSISTENCE is not set. 2.x chose Firestore because GOOGLE_CLOUD_PROJECT is set; 3.0.0 never infers the store. Set MCP_PERSISTENCE=firestore or MCP_PERSISTENCE=sqlite.',
    ],
    [
      { MCP_PERSISTENCE: 'file' },
      'ConfigError: MCP_PERSISTENCE=file was removed in 3.0.0; the default store is sqlite (see MCP_STORE_PATH)',
    ],
    [
      { MCP_TOKEN_STORE_PATH: '/tmp/tokens.json' },
      'ConfigError: MCP_TOKEN_STORE_PATH was removed in 3.0.0; use MCP_STORE_PATH',
    ],
    [
      { FIRESTORE_AUTH_CODES_COLLECTION: 'custom_codes' },
      'ConfigError: FIRESTORE_AUTH_CODES_COLLECTION was removed in 3.0.0; use MCP_STORE_NAMESPACE',
    ],
    [
      { FIRESTORE_RESUME_TOKENS_COLLECTION: 'custom_resume' },
      'ConfigError: FIRESTORE_RESUME_TOKENS_COLLECTION was removed in 3.0.0; use MCP_STORE_NAMESPACE',
    ],
    [
      { MCP_STORE_PATH: 'relative/path.sqlite' },
      'ConfigError: MCP_STORE_PATH must be an absolute path',
    ],
    [
      { MCP_PERSISTENCE: 'firestore', MCP_STORE_PATH: '/tmp/test.sqlite' },
      'ConfigError: MCP_STORE_PATH is only valid with MCP_PERSISTENCE=sqlite; got backend "firestore"',
    ],
    [
      { MCP_STORE_NAMESPACE: 'BAD_NAMESPACE!' },
      'ConfigError: MCP_STORE_NAMESPACE must match ^[a-z][a-z0-9_]{0,30}$, got "BAD_NAMESPACE!"',
    ],
    [
      { MCP_STORE_NAMESPACE: 'bad-hyphen' },
      'ConfigError: MCP_STORE_NAMESPACE must match ^[a-z][a-z0-9_]{0,30}$, got "bad-hyphen"',
    ],
  ])('asserts startup exit 1 and message for %j', (env, expectedMsg) => {
    const res = startup(env);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(expectedMsg);
  });

  it('asserts default /health.store output and sqlite startup log', async () => {
    const socket = createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const addr = socket.address();
    if (!addr || typeof addr === 'string') throw new Error('No port');
    const port = addr.port;
    socket.close();
    await once(socket, 'close');

    const server = spawn(process.execPath, args, {
      env: { ...baseEnv, MCP_PORT: String(port), MCP_HOST: '127.0.0.1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    server.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    try {
      const url = `http://127.0.0.1:${port}`;
      let response: Response | undefined;
      // Exception: Spawned child process socket listening cannot be controlled by fake timers.
      for (let i = 0; i < 100; i++) {
        try { response = await fetch(`${url}/health`); break; } catch { await delay(50); }
      }
      expect(response?.status).toBe(200);
      const data = await response!.json() as { store: Record<string, unknown> };
      expect(data.store).toEqual({
        backend: 'sqlite',
        namespace: 'mcp',
        persistent: true,
        multiInstance: false,
      });
      const expectedDbPath = join(testHome, '.netsapiens-mcp', 'mcp.sqlite');
      expect(stderr).toContain(`store: sqlite ${expectedDbPath} (namespace mcp)`);
    } finally {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
  });

  it('asserts MCP_READ_ONLY=true produces readonly_mcp namespace and db file', async () => {
    const socket = createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const addr = socket.address();
    if (!addr || typeof addr === 'string') throw new Error('No port');
    const port = addr.port;
    socket.close();
    await once(socket, 'close');

    const server = spawn(process.execPath, args, {
      env: {
        ...baseEnv,
        MCP_PORT: String(port),
        MCP_HOST: '127.0.0.1',
        MCP_READ_ONLY: 'true',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    server.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    try {
      const url = `http://127.0.0.1:${port}`;
      let response: Response | undefined;
      // Exception: Spawned child process socket listening cannot be controlled by fake timers.
      for (let i = 0; i < 100; i++) {
        try { response = await fetch(`${url}/health`); break; } catch { await delay(50); }
      }
      expect(response?.status).toBe(200);
      const data = await response!.json() as { store: Record<string, unknown> };
      expect(data.store).toEqual({
        backend: 'sqlite',
        namespace: 'readonly_mcp',
        persistent: true,
        multiInstance: false,
      });
      const expectedDbPath = join(testHome, '.netsapiens-mcp', 'readonly_mcp.sqlite');
      expect(stderr).toContain(`store: sqlite ${expectedDbPath} (namespace readonly_mcp)`);
    } finally {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
  });

  it('asserts planted http-tokens.json emits warning on HTTP startup', async () => {
    const nsmcpDir = join(testHome, '.netsapiens-mcp');
    mkdirSync(nsmcpDir, { recursive: true });
    const legacyPath = join(nsmcpDir, 'http-tokens.json');
    writeFileSync(legacyPath, '{}', 'utf8');

    const socket = createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const addr = socket.address();
    if (!addr || typeof addr === 'string') throw new Error('No port');
    const port = addr.port;
    socket.close();
    await once(socket, 'close');

    const server = spawn(process.execPath, args, {
      env: { ...baseEnv, MCP_PORT: String(port), MCP_HOST: '127.0.0.1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    server.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    try {
      const url = `http://127.0.0.1:${port}`;
      // Exception: Spawned child process socket listening cannot be controlled by fake timers.
      for (let i = 0; i < 100; i++) {
        try { const r = await fetch(`${url}/health`); if (r.ok) break; } catch { await delay(50); }
      }
      expect(stderr).toContain(
        `warn: ${legacyPath} is a 2.x token file. 3.0.0 does not read it, and it holds plaintext tokens. Delete it: rm ${legacyPath}`,
      );
    } finally {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
  });

  it('asserts stdio mode emits warnings for configured store variables', () => {
    const res = spawnSync(process.execPath, args, {
      env: {
        PATH: process.env.PATH,
        HOME: testHome,
        TMPDIR: testHome,
        MCP_TRANSPORT: 'stdio',
        NETSAPIENS_API_URL: 'https://netsapiens.example.com',
        NETSAPIENS_API_TOKEN: 'static-api-token',
        MCP_PERSISTENCE: 'memory',
        MCP_STORE_NAMESPACE: 'custom',
        MCP_STORE_PATH: '/tmp/test.sqlite',
        MCP_SESSION_SECRET: 'b'.repeat(32),
      },
      encoding: 'utf8',
      timeout: 5000,
      input: '',
    });

    expect(res.stderr).toContain('warn: MCP_PERSISTENCE is ignored in stdio mode');
    expect(res.stderr).toContain('warn: MCP_STORE_NAMESPACE is ignored in stdio mode');
    expect(res.stderr).toContain('warn: MCP_STORE_PATH is ignored in stdio mode');
    expect(res.stderr).toContain('warn: MCP_SESSION_SECRET is ignored in stdio mode');
  });

  it('asserts memory store logs warning on startup', async () => {
    const socket = createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const addr = socket.address();
    if (!addr || typeof addr === 'string') throw new Error('No port');
    const port = addr.port;
    socket.close();
    await once(socket, 'close');

    const server = spawn(process.execPath, args, {
      env: {
        ...baseEnv,
        MCP_PORT: String(port),
        MCP_HOST: '127.0.0.1',
        MCP_PERSISTENCE: 'memory',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    server.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    try {
      const url = `http://127.0.0.1:${port}`;
      let response: Response | undefined;
      // Exception: Spawned child process socket listening cannot be controlled by fake timers.
      for (let i = 0; i < 100; i++) {
        try { response = await fetch(`${url}/health`); break; } catch { await delay(50); }
      }
      expect(response?.status).toBe(200);
      const data = await response!.json() as { store: Record<string, unknown> };
      expect(data.store).toEqual({
        backend: 'memory',
        namespace: 'mcp',
        persistent: false,
        multiInstance: false,
      });
      expect(stderr).toContain('warn: memory store: every sign-in is lost on restart; one process only');
    } finally {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
  });
});
