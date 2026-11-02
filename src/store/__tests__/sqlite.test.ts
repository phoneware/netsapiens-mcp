import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { deriveStoreKey, StoreConfigError, StoreLockedError } from '../codec.js';
import { createSqliteBackend, createSqliteStore, SqliteBackend } from '../sqlite.js';
import { runStoreConformance } from '../conformance.js';
import { logger } from '../../utils/logger.js';
import type { McpStore } from '../types.js';

const windows = process.platform === 'win32';
const key = deriveStoreKey('a secret long enough for the sqlite tests');
const directories: string[] = [];
function location() {
  const root = mkdtempSync(join(tmpdir(), 'store-sqlite-'));
  directories.push(root);
  return { root, directory: join(root, 'private'), path: join(root, 'private', 'store.db') };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const conformanceRoot = mkdtempSync(join(tmpdir(), 'sqlite-conformance-'));
afterAll(() => rmSync(conformanceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const conformancePath = (namespace: string) => join(conformanceRoot, `${namespace}.sqlite`);
runStoreConformance({
  name: 'sqlite',
  capabilities: { persistent: true, multiInstance: false, exclusive: true, expiry: 'sweep' },
  async openBackend(namespace) { return createSqliteBackend({ path: conformancePath(namespace), namespace }); },
  async inspect(handle) {
    const db = (handle as SqliteBackend).db;
    const rows = (sql: string) => db.prepare(sql).all().map(row => {
      const { id, ...fields } = row;
      return { key: id as string, fields: Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null)) };
    });
    return {
      sessions: rows('SELECT id,family_id AS familyId,expires_at AS expiresAt,retain_until AS retainUntil,sealed FROM sessions'),
      refreshTokens: rows('SELECT id,family_id AS familyId,status,generation,consumed_at AS consumedAt,successor_sealed AS successorSealed FROM refresh_tokens'),
      refreshFamilies: rows('SELECT id,generation,status,active_refresh_id AS activeRefreshId,current_access_token_id AS currentAccessTokenId,revoked_at AS revokedAt,updated_at AS updatedAt,sealed FROM refresh_families'),
      upstreamGrants: rows('SELECT id,grant_version AS grantVersion,ns_expires_at AS nsExpiresAt,lease_owner AS leaseOwner,lease_until AS leaseUntil,updated_at AS updatedAt,sealed FROM upstream_grants'),
      authCodes: rows('SELECT id,expires_at AS expiresAt,sealed FROM auth_codes'),
      resumeTokens: rows('SELECT id,consumed_at AS consumedAt,expires_at AS expiresAt FROM resume_tokens'),
      usage: rows("SELECT user_hash || '__' || tool_name AS id,user_hash AS userHash,tool_name AS toolName,count,last_used AS lastUsed FROM usage"),
      clients: db.prepare('SELECT id,value FROM oauth_clients').all().map(row => ({ key: row.id as string, fields: JSON.parse(row.value as string) })),
    };
  },
  async dumpRaw(handle) {
    const path = (handle as SqliteBackend).path;
    return Buffer.concat([readFileSync(path), ...(existsSync(`${path}-wal`) ? [readFileSync(`${path}-wal`)] : [])]).toString('latin1');
  },
  async cleanup(namespace) {
    const path = conformancePath(namespace);
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true, maxRetries: 10, retryDelay: 100 });
  },
});

describe('SQLite storage', () => {
  it.skipIf(windows)('creates private directory, database and WAL', async () => {
    const { path, directory } = location();
    const oldMask = process.umask(0);
    let store: McpStore;
    try { store = createSqliteStore({ path, namespace: 'test', key }); }
    finally { process.umask(oldMask); }
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
    await store.close();
  });
  it.runIf(windows)('reports group and other permission bits for a new 0600 file on Windows', () => {
    const { root } = location();
    const probe = join(root, 'probe');
    closeSync(openSync(probe, 'wx', 0o600));
    expect(statSync(probe).mode & 0o077).not.toBe(0);
  });

  it.runIf(windows)('opens, persists and reopens a store on Windows without a permission-bit check', async () => {
    const { path } = location();
    const store = createSqliteStore({ path, namespace: 'test', key });
    expect(existsSync(`${path}-wal`)).toBe(true);
    await store.sessions.create({ accessToken: 'access', refreshToken: 'refresh' }, {
      clientId: 'client',
      expiresAt: Date.now() + 60_000,
      nsAccessToken: 'ns-tok',
      nsRefreshToken: 'ns-ref',
      nsUsername: 'user',
      serverBaseUrl: 'http://localhost',
    });
    await store.close();

    const reopened = createSqliteStore({ path, namespace: 'test', key });
    expect((await reopened.sessions.get('access'))?.nsUsername).toBe('user');
    await reopened.close();
  });

  it('closes idempotently and releases the lock', async () => {
    const { path } = location();
    const store = createSqliteStore({ path, namespace: 'test', key });
    await store.close();
    await store.close();
    const reopened = createSqliteStore({ path, namespace: 'test', key });
    await reopened.close();
  });

  it('rejects a second open in this process', async () => {
    const { path } = location();
    const store = createSqliteStore({ path, namespace: 'test', key });
    expect(() => createSqliteStore({ path, namespace: 'test', key })).toThrow(StoreLockedError);
    expect(() => createSqliteStore({ path, namespace: 'test', key })).toThrow(path);
    await store.close();
  });

  it('rejects a second process and names the path', async () => {
    const { path } = location();
    const store = createSqliteStore({ path, namespace: 'test', key });
    const modulePath = resolve('src/store/sqlite.ts');
    const script = `import {createSqliteStore} from ${JSON.stringify(pathToFileURL(modulePath).href)}; try { createSqliteStore({path:process.argv[1],namespace:'test',key:Buffer.alloc(32)}); process.exit(0); } catch(e) { console.error(e.name+': '+e.message); process.exit(1); }`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, path], { encoding: 'utf8' });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('StoreLockedError');
    expect(child.stderr).toContain(path);
    await store.close();
  });

  it.skipIf(windows)('refuses a database other users can read', async () => {
    const { path } = location();
    const store = createSqliteStore({ path, namespace: 'test', key });
    await store.close();
    chmodSync(path, 0o644);
    expect(() => createSqliteStore({ path, namespace: 'test', key })).toThrow(StoreConfigError);
    expect(() => createSqliteStore({ path, namespace: 'test', key })).toThrow('chmod 600');
    chmodSync(path, 0o600);
    const reopened = createSqliteStore({ path, namespace: 'test', key });
    await reopened.close();
  });

  it('refuses a newer schema version', async () => {
    const { path } = location();
    const store = createSqliteStore({ path, namespace: 'test', key });
    await store.close();
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version=99');
    db.close();
    expect(() => createSqliteStore({ path, namespace: 'test', key })).toThrow('Unsupported SQLite schema version 99');
  });

  it('refuses a different namespace', async () => {
    const { path } = location();
    const store = createSqliteStore({ path, namespace: 'one', key });
    await store.close();
    expect(() => createSqliteStore({ path, namespace: 'two', key })).toThrow(StoreConfigError);
  });

  it('rejects sessions with a different key and swapped ciphertext', async () => {
    const { path } = location();
    let store = createSqliteStore({ path, namespace: 'test', key });
    const session = { clientId: 'client', expiresAt: Date.now() + 60_000, nsAccessToken: 'secret', nsUsername: 'user' };
    await store.sessions.create({ accessToken: 'first', refreshToken: 'first-refresh' }, session);
    await store.sessions.create({ accessToken: 'second', refreshToken: 'second-refresh' }, session);
    await store.close();
    store = createSqliteStore({ path, namespace: 'test', key: deriveStoreKey('another secret long enough for sqlite tests') });
    expect(await store.sessions.get('first')).toBeUndefined();
    await store.close();
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(path);
    const rows = db.prepare('SELECT id,sealed FROM sessions ORDER BY id').all();
    expect(rows).toHaveLength(2);
    db.prepare('UPDATE sessions SET sealed=? WHERE id=?').run(rows[1].sealed, rows[0].id);
    db.prepare('UPDATE sessions SET sealed=? WHERE id=?').run(rows[0].sealed, rows[1].id);
    db.close();
    store = createSqliteStore({ path, namespace: 'test', key });
    expect(await store.sessions.get('first')).toBeUndefined();
    expect(await store.sessions.get('second')).toBeUndefined();
    await store.close();
  });

  it('sweeps expired rows when the store opens', async () => {
    const { path } = location();
    let store = createSqliteStore({ path, namespace: 'test', key });
    await store.sessions.create({ accessToken: 'old-access', refreshToken: 'old-refresh' }, { clientId: 'client', expiresAt: Date.now() - 31 * 86400_000, nsAccessToken: 'upstream', nsUsername: 'user' });
    await store.close();
    store = createSqliteStore({ path, namespace: 'test', key });
    await store.close();
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(path);
    expect(db.prepare('SELECT count(*) AS count FROM sessions').get().count).toBe(0);
    db.close();
  });

  it('releases the lock when the startup sweep fails', async () => {
    const { path } = location();
    const store = createSqliteStore({ path, namespace: 'test', key });
    await store.sessions.create({ accessToken: 'old-access', refreshToken: 'old-refresh' }, { clientId: 'client', expiresAt: Date.now() - 31 * 86400_000, nsAccessToken: 'upstream', nsUsername: 'user' });
    await store.close();
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(path);
    db.exec("CREATE TRIGGER fail_sweep BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'sweep failure'); END");
    db.close();
    expect(() => createSqliteStore({ path, namespace: 'test', key })).toThrow('sweep failure');
    const repair = new DatabaseSync(path);
    repair.exec('DROP TRIGGER fail_sweep');
    repair.close();
    const reopened = createSqliteStore({ path, namespace: 'test', key });
    await reopened.close();
  });

  it('logs a failed timer sweep and continues sweeping', async () => {
    vi.useFakeTimers();
    const { path } = location();
    const backend = createSqliteBackend({ path, namespace: 'test' });
    const now = Date.now();
    await backend.putSession({ id: 'a'.repeat(64), refreshId: 'b'.repeat(64), expiresAt: now - 2, retainUntil: now - 1, sealed: 'test' });
    backend.db.exec("CREATE TRIGGER fail_sweep BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'sweep failure'); END");
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => { });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(warn).toHaveBeenCalledWith('Failed to sweep SQLite store', expect.objectContaining({ error: expect.stringContaining('sweep failure') }));
    expect(await backend.getSession('a'.repeat(64))).toBeDefined();
    backend.db.exec('DROP TRIGGER fail_sweep');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(await backend.getSession('a'.repeat(64))).toBeUndefined();
    await backend.close();
  });

  it('sweeps expired retained rows on the ten minute timer', async () => {
    vi.useFakeTimers();
    const original = globalThis.setInterval;
    const unrefs: ReturnType<typeof vi.spyOn>[] = [];
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((...args: Parameters<typeof setInterval>) => {
      const handle = original(...args);
      unrefs.push(vi.spyOn(handle, 'unref'));
      return handle;
    }) as typeof setInterval);
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    for (const [delay, expected] of [[599_999, 1], [600_000, 0]] as const) {
      const { path } = location();
      const store = createSqliteStore({ path, namespace: 'test', key });
      await store.sessions.create({ accessToken: 'old-access', refreshToken: 'old-refresh' }, { clientId: 'client', expiresAt: Date.now() - 31 * 86400_000, nsAccessToken: 'upstream', nsUsername: 'user' });
      await vi.advanceTimersByTimeAsync(delay);
      await store.close();
      const db = new DatabaseSync(path);
      expect(db.prepare('SELECT count(*) AS count FROM sessions').get().count).toBe(expected);
      db.close();
    }
    expect(unrefs).toHaveLength(2);
    for (const unref of unrefs) expect(unref).toHaveBeenCalledTimes(1);
  });

  it('keeps session secrets out of database and WAL bytes', async () => {
    const { path } = location();
    const store = createSqliteStore({ path, namespace: 'test', key });
    const values = ['private-access-token', 'private-refresh-token', 'private-upstream-token', 'private-upstream-refresh', 'private-username'];
    await store.sessions.create({ accessToken: values[0], refreshToken: values[1] }, { clientId: 'client', expiresAt: Date.now() + 60_000, nsAccessToken: values[2], nsRefreshToken: values[3], nsUsername: values[4] });
    const bytes = Buffer.concat([readFileSync(path), readFileSync(`${path}-wal`)]).toString('latin1');
    for (const value of values) expect(bytes).not.toContain(value);
    await store.close();
  });
});
