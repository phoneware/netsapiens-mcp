import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSqliteStore } from '../store/sqlite.js';
import { createCodec, deriveStoreKey } from '../store/codec.js';
import { StoreConfigError } from '../store/types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

describe('SQLite v1 to v2 Migration & Rollback Integrity', () => {
  const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const key = deriveStoreKey(secret);
  const codec = createCodec(key);

  function createV1Database(dbPath: string, corruptSealed = false) {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY CHECK(length(id)=64),
        refresh_id TEXT UNIQUE CHECK(length(refresh_id)=64),
        expires_at INTEGER NOT NULL,
        retain_until INTEGER NOT NULL CHECK(retain_until >= expires_at),
        ns_expires_at INTEGER,
        sealed TEXT NOT NULL
      ) STRICT;
      CREATE TABLE auth_codes (id TEXT PRIMARY KEY CHECK(length(id)=64), expires_at INTEGER NOT NULL, sealed TEXT NOT NULL) STRICT;
      CREATE TABLE resume_tokens (id TEXT PRIMARY KEY CHECK(length(id)=64), consumed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;
      CREATE TABLE oauth_clients (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE usage (user_hash TEXT NOT NULL CHECK(length(user_hash)=64), tool_name TEXT NOT NULL, count INTEGER NOT NULL, last_used INTEGER NOT NULL, PRIMARY KEY(user_hash, tool_name)) STRICT;
    `);

    const token1 = { accessToken: `acc_${randomUUID()}`, refreshToken: `ref_${randomUUID()}` };
    const id1 = codec.id('session', token1.accessToken);
    const refId1 = codec.id('refresh', token1.refreshToken);
    const expiresAt = Date.now() + 3600_000;
    const retainUntil = expiresAt + 7 * 86400_000;

    const payload = {
      clientId: 'client-v1',
      serverBaseUrl: 'http://localhost:3000',
      nsAccessToken: 'ns-acc-1',
      nsRefreshToken: 'ns-ref-1',
      nsUsername: 'user@example.com',
      nsUserRole: 'admin',
      nsApiUrl: 'https://ns.example.com',
    };

    const sealed1 = corruptSealed ? 'corrupted_ciphertext' : codec.seal(payload, `session:${id1}:${refId1}`);

    db.prepare('INSERT INTO sessions (id, refresh_id, expires_at, retain_until, ns_expires_at, sealed) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id1, refId1, expiresAt, retainUntil, expiresAt, sealed1);
    db.close();
    chmodSync(dbPath, 0o600);
    return { token1, id1, refId1, payload };
  }

  it('fails and rolls back migration if key is missing when v1 sessions exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nsmcp-v1-nokey-'));
    const path = join(dir, 'store.db');
    createV1Database(path);

    expect(() => {
      createSqliteStore({ path, namespace: 'test' });
    }).toThrow(StoreConfigError);

    // Verify database remains at version 1 and sessions table is untouched
    const verifyDb = new DatabaseSync(path);
    const version = (verifyDb.prepare('PRAGMA user_version').get() as any).user_version;
    expect(version).toBe(1);
    const rows = verifyDb.prepare('SELECT count(*) as count FROM sessions').get() as { count: number };
    expect(rows.count).toBe(1);
    verifyDb.close();

    rmSync(dir, { recursive: true, force: true });
  });

  it('fails and rolls back migration if any v1 row ciphertext is unopenable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nsmcp-v1-corrupt-'));
    const path = join(dir, 'store.db');
    createV1Database(path, true); // corrupt ciphertext

    expect(() => {
      createSqliteStore({ path, namespace: 'test', key });
    }).toThrow(/Failed to decode SQLite v1 session/);

    // Verify rollback
    const verifyDb = new DatabaseSync(path);
    const version = (verifyDb.prepare('PRAGMA user_version').get() as any).user_version;
    expect(version).toBe(1);
    const rows = verifyDb.prepare('SELECT count(*) as count FROM sessions').get() as { count: number };
    expect(rows.count).toBe(1);
    verifyDb.close();

    rmSync(dir, { recursive: true, force: true });
  });

  it('successfully migrates v1 database with key and preserves all session and upstream data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nsmcp-v1-ok-'));
    const path = join(dir, 'store.db');
    const { token1, id1, refId1, payload } = createV1Database(path);

    const store = createSqliteStore({ path, namespace: 'test', key });

    // Verify session is accessible through v2 store
    const session = await store.sessions.get(token1.accessToken);
    expect(session).toBeDefined();
    expect(session?.nsUsername).toBe(payload.nsUsername);
    expect(session?.nsAccessToken).toBe(payload.nsAccessToken);
    expect(session?.nsRefreshToken).toBe(payload.nsRefreshToken);
    expect(session?.clientId).toBe(payload.clientId);

    // Verify refresh lookup works
    const lookup = await store.sessions.lookupRefresh(token1.refreshToken, payload.clientId, Date.now());
    expect(lookup.status).toBe('active');
    if (lookup.status === 'active') {
      expect(lookup.session.nsUsername).toBe(payload.nsUsername);
    }

    await store.close();

    // Verify schema is now v2
    const verifyDb = new DatabaseSync(path);
    const version = (verifyDb.prepare('PRAGMA user_version').get() as any).user_version;
    expect(version).toBe(2);
    // sessions_v1 should be gone
    const tableNames = (verifyDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(r => r.name);
    expect(tableNames).not.toContain('sessions_v1');
    expect(tableNames).toContain('refresh_families');
    expect(tableNames).toContain('upstream_grants');
    expect(tableNames).toContain('refresh_tokens');
    verifyDb.close();

    rmSync(dir, { recursive: true, force: true });
  });
});
