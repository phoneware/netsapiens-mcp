import { afterAll, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { createSqliteStore } from '../store/sqlite.js';
import { deriveStoreKey } from '../store/codec.js';
import { startHttpServer } from '../http-server.js';
import * as http from 'node:http';
import * as storeConfig from '../config/store.js';
import * as version from '../netsapiens/version.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { get(): { user_version: number } }; close(): void };
};

const testHome = mkdtempSync(join(tmpdir(), 'nsmcp-config-store-test-'));
afterAll(() => rmSync(testHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const args = ['--import', 'tsx', 'src/index.ts'];
const baseEnv = {
  PATH: process.env.PATH,
  HOME: testHome,
  USERPROFILE: testHome,
  SystemRoot: process.env.SystemRoot,
  TMPDIR: testHome,
  MCP_TRANSPORT: 'http',
  NETSAPIENS_API_URL: 'https://netsapiens.example.com',
  NETSAPIENS_OAUTH_CLIENT_ID: 'client',
  NETSAPIENS_OAUTH_CLIENT_SECRET: 'secret',
  MCP_SESSION_SECRET: 'a'.repeat(32),
  MCP_MFA_REPLAY_AUDIENCE: 'config-store-test',
};

function startup(env: Record<string, string | undefined>) {
  return spawnSync(process.execPath, args, {
    env: { ...baseEnv, ...env },
    encoding: 'utf8',
    timeout: 30000,
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

  it('does not upgrade an existing SQLite database when provider or proxy preflight fails', async () => {
    const path = join(testHome, 'preflight.sqlite');
    const store = createSqliteStore({ path, namespace: 'mcp', key: deriveStoreKey('a'.repeat(32)) });
    await store.close();
    const db = new DatabaseSync(path);
    try {
      db.exec('DROP TABLE rate_limits; PRAGMA user_version=3;');
      for (const [override, message] of [
        [{ MCP_MFA_REPLAY_AUDIENCE: 'bad audience' }, 'replayAudience must be a stable replay-store identity'],
        [{ MCP_TRUST_PROXY_HOPS: '2' }, 'MCP_TRUST_PROXY_HOPS must be 0 or 1'],
        [{ MCP_BASE_URL: 'https://mcp.example.com/?private=do-not-log' }, 'MCP_BASE_URL is not a valid OAuth issuer'],
        [{ MCP_BASE_URL: 'https://mcp.example.com/#private-fragment' }, 'MCP_BASE_URL is not a valid OAuth issuer'],
        [{ MCP_BASE_URL: 'https://mcp.example.com', MCP_PORT: '65536' }, 'MCP_PORT must be an integer from 0 to 65535'],
        [{ MCP_BASE_URL: 'https://mcp.example.com', MCP_PORT: '-1' }, 'MCP_PORT must be an integer from 0 to 65535'],
        [{ MCP_BASE_URL: 'https://mcp.example.com', MCP_PORT: '12invalid' }, 'MCP_PORT must be an integer from 0 to 65535'],
      ] as const) {
        const result = startup({ MCP_STORE_PATH: path, ...override });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(message);
        expect(db.prepare('PRAGMA user_version').get().user_version).toBe(3);
        expect(db.prepare("SELECT count(*) AS user_version FROM sqlite_master WHERE type='table' AND name='rate_limits'").get().user_version).toBe(0);
      }
    } finally { db.close(); }
  });

  it('rejects an occupied port without upgrading a schema-3 database or installing signal handlers', async () => {
    const socket = createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const address = socket.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const path = join(testHome, 'occupied.sqlite');
    const original = createSqliteStore({ path, namespace: 'mcp', key: deriveStoreKey('a'.repeat(32)) });
    await original.close();
    const fixture = new DatabaseSync(path);
    fixture.exec('DROP TABLE rate_limits; PRAGMA user_version=3;');
    fixture.close();
    const keys = ['MCP_TRANSPORT', 'MCP_PORT', 'MCP_HOST', 'MCP_BASE_URL', 'MCP_PERSISTENCE', 'MCP_STORE_PATH', 'MCP_SESSION_SECRET', 'MCP_MFA_REPLAY_AUDIENCE', 'NETSAPIENS_API_URL', 'NETSAPIENS_OAUTH_CLIENT_ID', 'NETSAPIENS_OAUTH_CLIENT_SECRET'] as const;
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const sigint = process.listeners('SIGINT');
    const sigterm = process.listeners('SIGTERM');
    const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      Object.assign(process.env, {
        MCP_TRANSPORT: 'http', MCP_PORT: String(address.port), MCP_HOST: '127.0.0.1', MCP_BASE_URL: 'http://localhost',
        MCP_PERSISTENCE: 'sqlite', MCP_STORE_PATH: path, MCP_SESSION_SECRET: 'a'.repeat(32),
        MCP_MFA_REPLAY_AUDIENCE: 'occupied-test', NETSAPIENS_API_URL: 'https://netsapiens.example.com',
        NETSAPIENS_OAUTH_CLIENT_ID: 'client', NETSAPIENS_OAUTH_CLIENT_SECRET: 'secret',
      });
      await expect(startHttpServer()).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(process.listeners('SIGINT')).toEqual(sigint);
      expect(process.listeners('SIGTERM')).toEqual(sigterm);
      expect(JSON.stringify(output.mock.calls)).not.toContain('NetSapiens MCP HTTP server started');
      const unchanged = new DatabaseSync(path);
      try {
        expect(unchanged.prepare('PRAGMA user_version').get().user_version).toBe(3);
        expect(unchanged.prepare("SELECT count(*) AS user_version FROM sqlite_master WHERE type='table' AND name='rate_limits'").get().user_version).toBe(0);
      } finally { unchanged.close(); }
    } finally {
      output.mockRestore();
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      socket.close();
      await once(socket, 'close');
    }
  });

  it('holds the real port but drops requests until initialization completes, then closes its store', async () => {
    const path = join(testHome, 'startup-gated.sqlite');
    const keys = ['MCP_TRANSPORT', 'MCP_PORT', 'MCP_HOST', 'MCP_BASE_URL', 'MCP_PERSISTENCE', 'MCP_STORE_PATH', 'MCP_SESSION_SECRET', 'MCP_MFA_REPLAY_AUDIENCE', 'NETSAPIENS_API_URL', 'NETSAPIENS_OAUTH_CLIENT_ID', 'NETSAPIENS_OAUTH_CLIENT_SECRET'] as const;
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const sigint = process.listeners('SIGINT');
    const sigterm = process.listeners('SIGTERM');
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const originalFactory = storeConfig.createStoreFromEnv;
    let listener: http.Server | undefined;
    const originalListen = http.Server.prototype.listen;
    const listenSpy = vi.spyOn(http.Server.prototype, 'listen').mockImplementation(function (this: http.Server, port: number, host: string) {
      listener = this;
      return originalListen.call(this, port, host);
    });
    const factory = vi.spyOn(storeConfig, 'createStoreFromEnv').mockImplementation(async env => {
      entered.resolve();
      await gate.promise;
      return originalFactory(env);
    });
    const warm = vi.spyOn(version, 'warmVersionCache').mockResolvedValue();
    let running: http.Server | undefined;
    let starting: Promise<http.Server> | undefined;
    try {
      Object.assign(process.env, {
        MCP_TRANSPORT: 'http', MCP_PORT: '0', MCP_HOST: '127.0.0.1', MCP_BASE_URL: 'http://localhost',
        MCP_PERSISTENCE: 'sqlite', MCP_STORE_PATH: path, MCP_SESSION_SECRET: 'a'.repeat(32),
        MCP_MFA_REPLAY_AUDIENCE: 'gated-test', NETSAPIENS_API_URL: 'https://netsapiens.example.com',
        NETSAPIENS_OAUTH_CLIENT_ID: 'client', NETSAPIENS_OAUTH_CLIENT_SECRET: 'secret',
      });
      starting = startHttpServer();
      await entered.promise;
      const address = listener!.address();
      if (!address || typeof address === 'string') throw new Error('No listening address');
      const probe = createServer();
      const conflict = new Promise<string | undefined>(resolve => {
        probe.once('error', (error: NodeJS.ErrnoException) => resolve(error.code));
        probe.listen(address.port, '127.0.0.1', () => { probe.close(); resolve(undefined); });
      });
      expect(await conflict).toBe('EADDRINUSE');
      await expect(new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${address.port}/health`, () => resolve());
        req.once('error', reject);
      })).rejects.toMatchObject({ code: 'ECONNRESET' });
      gate.resolve();
      running = await starting;
      starting = undefined;
      expect(running).toBe(listener);
      expect((await fetch(`http://127.0.0.1:${address.port}/health`)).status).toBe(200);
      await new Promise<void>(resolve => running!.close(() => resolve()));
      running = undefined;
      expect(process.listeners('SIGINT')).toEqual(sigint);
      expect(process.listeners('SIGTERM')).toEqual(sigterm);
      const reopened = createSqliteStore({ path, namespace: 'mcp', key: deriveStoreKey('a'.repeat(32)) });
      await reopened.close();

      const failedPath = join(testHome, 'startup-failed.sqlite');
      process.env.MCP_STORE_PATH = failedPath;
      let failedPort = 0;
      factory.mockImplementation(async env => {
        const result = await originalFactory(env);
        const current = listener!.address();
        if (!current || typeof current === 'string') throw new Error('No listening address');
        failedPort = current.port;
        return { ...result, store: { ...result.store, rateLimits: undefined as unknown as typeof result.store.rateLimits } };
      });
      await expect(startHttpServer()).rejects.toThrow('ConfigError: the store does not implement rateLimits.hit');
      const rebound = createServer();
      await new Promise<void>((resolve, reject) => {
        rebound.once('error', reject);
        rebound.listen(failedPort, '127.0.0.1', resolve);
      });
      await new Promise<void>(resolve => rebound.close(() => resolve()));
      const afterFailure = createSqliteStore({ path: failedPath, namespace: 'mcp', key: deriveStoreKey('a'.repeat(32)) });
      await afterFailure.close();
      expect(process.listeners('SIGINT')).toEqual(sigint);
      expect(process.listeners('SIGTERM')).toEqual(sigterm);
    } finally {
      gate.resolve();
      if (!running && starting) running = await starting.catch(() => undefined);
      if (running) await new Promise<void>(resolve => running!.close(() => resolve()));
      listenSpy.mockRestore();
      factory.mockRestore();
      warm.mockRestore();
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
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
      env: { ...baseEnv, MCP_MFA_REPLAY_AUDIENCE: undefined, MCP_PORT: String(port), MCP_HOST: '127.0.0.1' },
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
      const data = await response!.json() as { store: Record<string, unknown>; signIn: { mfaReady: boolean } };
      expect(data.store).toEqual({
        backend: 'sqlite',
        namespace: 'mcp',
        persistent: true,
        multiInstance: false,
      });
      expect(data.signIn.mfaReady).toBe(false);
      const expectedDbPath = join(testHome, '.netsapiens-mcp', 'mcp.sqlite');
      expect(stderr).toContain(`store: sqlite ${expectedDbPath} (namespace mcp)`);
      expect(stderr).toContain('MFA unavailable: configure MCP_MFA_REPLAY_AUDIENCE');
    } finally {
      if (server.exitCode === null && server.signalCode === null) {
        const exited = once(server, 'exit');
        server.kill();
        await exited;
      }
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
      if (server.exitCode === null && server.signalCode === null) {
        const exited = once(server, 'exit');
        server.kill();
        await exited;
      }
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
      if (server.exitCode === null && server.signalCode === null) {
        const exited = once(server, 'exit');
        server.kill();
        await exited;
      }
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
