import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { deriveStoreKey, StoreConfigError, StoreLockedError } from '../codec.js';
import { createSqliteStore } from '../sqlite.js';

const key = deriveStoreKey('a secret long enough for the sqlite tests');
const directories: string[] = [];
function location() {
  const root = mkdtempSync(join(tmpdir(), 'store-sqlite-'));
  directories.push(root);
  return { root, directory: join(root, 'private'), path: join(root, 'private', 'store.db') };
}
afterEach(() => { vi.useRealTimers(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

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
