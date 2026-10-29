import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { deriveStoreKey, StoreConfigError, StoreLockedError } from '../codec.js';
import { createSqliteBackend, createSqliteStore, SqliteBackend } from '../sqlite.js';
import { runStoreConformance } from '../conformance.js';

const key = deriveStoreKey('a secret long enough for the sqlite tests');
const directories: string[] = [];
function location() {
  const root = mkdtempSync(join(tmpdir(), 'store-sqlite-'));
  directories.push(root);
  return { root, directory: join(root, 'private'), path: join(root, 'private', 'store.db') };
}
afterEach(() => { vi.useRealTimers(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const conformanceRoot = mkdtempSync(join(tmpdir(), 'sqlite-conformance-'));
afterAll(() => rmSync(conformanceRoot, { recursive: true, force: true }));
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
      sessions: rows('SELECT id,refresh_id AS refreshId,expires_at AS expiresAt,retain_until AS retainUntil,ns_expires_at AS nsExpiresAt,lease_owner AS leaseOwner,lease_until AS leaseUntil,sealed FROM sessions'),
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
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  },
});

describe('SQLite storage', () => {
  it('creates private directory, database and WAL', async () => {
    const { path, directory } = location();
    const store = createSqliteStore({ path, namespace: 'test', key });
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
    await store.close();
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
    const script = `import {createSqliteStore} from ${JSON.stringify(modulePath)}; try { createSqliteStore({path:process.argv[1],namespace:'test',key:Buffer.alloc(32)}); process.exit(0); } catch(e) { console.error(e.name+': '+e.message); process.exit(1); }`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, path], { encoding: 'utf8' });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('StoreLockedError');
    expect(child.stderr).toContain(path);
    await store.close();
  });

  it('rejects insecure files and newer schema versions', async () => {
    const { path } = location();
    const store = createSqliteStore({ path, namespace: 'test', key });
    await store.close();
    chmodSync(path, 0o644);
    expect(() => createSqliteStore({ path, namespace: 'test', key })).toThrow(StoreConfigError);
    expect(() => createSqliteStore({ path, namespace: 'test', key })).toThrow('chmod 600');
    chmodSync(path, 0o600);
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version=99');
    db.close();
    expect(() => createSqliteStore({ path, namespace: 'test', key })).toThrow(StoreConfigError);
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

  it('sweeps expired retained rows on the ten minute timer', async () => {
    vi.useFakeTimers();
    const { path } = location();
    const store = createSqliteStore({ path, namespace: 'test', key });
    await store.sessions.create({ accessToken: 'old-access', refreshToken: 'old-refresh' }, { clientId: 'client', expiresAt: Date.now() - 31 * 86400_000, nsAccessToken: 'upstream', nsUsername: 'user' });
    await vi.advanceTimersByTimeAsync(600_000);
    await store.close();
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(path);
    expect(db.prepare('SELECT count(*) AS count FROM sessions').get().count).toBe(0);
    db.close();
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
