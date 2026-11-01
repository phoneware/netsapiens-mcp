import { closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { StoreConfigError, StoreLockedError } from './codec.js';
import { createStore } from './store.js';
import { logger } from '../utils/logger.js';
import type { AuthCodeRow, ResumeRow, SessionRow, StoreBackend, StoreCapabilities } from './types.js';

// The project supports Node versions whose type definitions do not yet declare node:sqlite.
type SqlValue = string | number | null;
type Statement = { run(...values: SqlValue[]): { changes: number | bigint }; get(...values: SqlValue[]): Record<string, SqlValue> | undefined; all(...values: SqlValue[]): Record<string, SqlValue>[] };
type Database = { exec(sql: string): void; prepare(sql: string): Statement; close(): void };
const capabilities: StoreCapabilities = { persistent: true, multiInstance: false, exclusive: true, expiry: 'sweep' };

function session(row: Record<string, SqlValue> | undefined): SessionRow | undefined {
  if (!row) return undefined;
  return {
    id: row.id as string, refreshId: row.refresh_id as string, expiresAt: row.expires_at as number,
    retainUntil: row.retain_until as number, nsExpiresAt: (row.ns_expires_at ?? undefined) as number | undefined,
    leaseOwner: (row.lease_owner ?? undefined) as string | undefined, leaseUntil: (row.lease_until ?? undefined) as number | undefined,
    sealed: row.sealed as string
  };
}
function code(row: Record<string, SqlValue> | undefined): AuthCodeRow | undefined {
  return row && { id: row.id as string, expiresAt: row.expires_at as number, sealed: row.sealed as string };
}

export class SqliteBackend implements StoreBackend {
  readonly path: string;
  readonly db: Database;
  readonly name!: string;
  readonly capabilities!: StoreCapabilities;
  getSession!: StoreBackend['getSession'];
  findSessionByRefreshId!: StoreBackend['findSessionByRefreshId'];
  putSession!: StoreBackend['putSession'];
  updateSession!: StoreBackend['updateSession'];
  deleteSession!: StoreBackend['deleteSession'];
  putAuthCode!: StoreBackend['putAuthCode'];
  getAuthCode!: StoreBackend['getAuthCode'];
  takeAuthCode!: StoreBackend['takeAuthCode'];
  insertResumeIfAbsent!: StoreBackend['insertResumeIfAbsent'];
  incrementUsage!: StoreBackend['incrementUsage'];
  listUsage!: StoreBackend['listUsage'];
  getClient!: StoreBackend['getClient'];
  putClient!: StoreBackend['putClient'];
  sweep!: StoreBackend['sweep'];
  close!: StoreBackend['close'];
  constructor(options: { path: string; namespace: string; sweepIntervalMs?: number }) {
    const { path, namespace } = options;
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { closeSync(openSync(path, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    // Windows has no POSIX bits (Node reports 0666 and chmod only toggles read-only), so the
    // store and SQLite's -wal and -journal get the ACL Windows gives new files in this directory.
    if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) throw new StoreConfigError(`${path} is readable by other users; chmod 600 ${path}`);
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => Database };
    const db = new DatabaseSync(path);
    this.db = db;
    const transaction = <T>(fn: () => T): T => {
      db.exec('BEGIN IMMEDIATE');
      try { const value = fn(); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    };
    const sweep = (now: number) => transaction(() => ['sessions', 'auth_codes', 'resume_tokens'].reduce((n, table) => n + Number(db.prepare(`DELETE FROM ${table} WHERE ${table === 'sessions' ? 'retain_until' : 'expires_at'} <= ?`).run(now).changes), 0));
    try {
      db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=0; BEGIN IMMEDIATE; COMMIT;');
      const version = db.prepare('PRAGMA user_version').get()?.user_version as number;
      if (version > 1) throw new StoreConfigError(`Unsupported SQLite schema version ${version}`);
      db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY CHECK(length(id)=64), refresh_id TEXT NOT NULL CHECK(length(refresh_id)=64), expires_at INTEGER NOT NULL, retain_until INTEGER NOT NULL CHECK(retain_until >= expires_at), ns_expires_at INTEGER, lease_owner TEXT, lease_until INTEGER, sealed TEXT NOT NULL) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS sessions_refresh_id ON sessions(refresh_id);
      CREATE TABLE IF NOT EXISTS auth_codes (id TEXT PRIMARY KEY CHECK(length(id)=64), expires_at INTEGER NOT NULL, sealed TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS resume_tokens (id TEXT PRIMARY KEY CHECK(length(id)=64), consumed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS usage (user_hash TEXT NOT NULL CHECK(length(user_hash)=64), tool_name TEXT NOT NULL, count INTEGER NOT NULL, last_used INTEGER NOT NULL, PRIMARY KEY(user_hash, tool_name)) STRICT;
      PRAGMA user_version=1; COMMIT;`);
      const existing = db.prepare("SELECT value FROM meta WHERE key='namespace'").get();
      if (existing && existing.value !== namespace) throw new StoreConfigError(`SQLite store namespace mismatch for ${path}`);
      db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES ('namespace',?)").run(namespace);
      sweep(Date.now());
    } catch (error) {
      db.close();
      if ((error as NodeJS.ErrnoException).code === 'ERR_SQLITE_ERROR' && /locked|busy/i.test((error as Error).message)) {
        throw new StoreLockedError(`${path} is in use by another process. Give each server process its own MCP_STORE_PATH, or use MCP_PERSISTENCE=firestore for several instances.`);
      }
      throw error;
    }
    const get = (id: string) => session(db.prepare('SELECT * FROM sessions WHERE id=?').get(id));
    const put = (row: SessionRow) => db.prepare(`INSERT INTO sessions(id,refresh_id,expires_at,retain_until,ns_expires_at,lease_owner,lease_until,sealed) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET refresh_id=excluded.refresh_id,expires_at=excluded.expires_at,retain_until=excluded.retain_until,ns_expires_at=excluded.ns_expires_at,lease_owner=excluded.lease_owner,lease_until=excluded.lease_until,sealed=excluded.sealed`).run(row.id, row.refreshId, row.expiresAt, row.retainUntil, row.nsExpiresAt ?? null, row.leaseOwner ?? null, row.leaseUntil ?? null, row.sealed);
    const timer = setInterval(() => {
      try { sweep(Date.now()); }
      catch (error) { logger.warn('Failed to sweep SQLite store', { error: String(error) }); }
    }, options.sweepIntervalMs ?? 600_000);
    timer.unref();
    let closed = false;
    const backend: StoreBackend = {
      name: 'sqlite', capabilities,
      async getSession(id) { return get(id); },
      async findSessionByRefreshId(id) { return session(db.prepare('SELECT * FROM sessions WHERE refresh_id=?').get(id)); },
      async putSession(row) { put(row); },
      async updateSession(id, mutate) { return transaction(() => { const current = get(id); if (!current) return undefined; const next = mutate(current); if (next === null) { db.prepare('DELETE FROM sessions WHERE id=?').run(id); return undefined; } if (next) { put(next); return next; } return current; }); },
      async deleteSession(id) { db.prepare('DELETE FROM sessions WHERE id=?').run(id); },
      async putAuthCode(row) { db.prepare('INSERT OR REPLACE INTO auth_codes(id,expires_at,sealed) VALUES(?,?,?)').run(row.id, row.expiresAt, row.sealed); },
      async getAuthCode(id) { return code(db.prepare('SELECT * FROM auth_codes WHERE id=?').get(id)); },
      async takeAuthCode(id) { return transaction(() => { const row = code(db.prepare('SELECT * FROM auth_codes WHERE id=?').get(id)); db.prepare('DELETE FROM auth_codes WHERE id=?').run(id); return row; }); },
      async insertResumeIfAbsent(row: ResumeRow, now) { return transaction(() => { db.prepare('DELETE FROM resume_tokens WHERE id=? AND expires_at<=?').run(row.id, now); return Number(db.prepare('INSERT INTO resume_tokens(id,consumed_at,expires_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').run(row.id, row.consumedAt, row.expiresAt).changes) === 1; }); },
      async incrementUsage(userHash, toolName, now) { db.prepare('INSERT INTO usage(user_hash,tool_name,count,last_used) VALUES(?,?,1,?) ON CONFLICT(user_hash,tool_name) DO UPDATE SET count=count+1,last_used=excluded.last_used').run(userHash, toolName, now); },
      async listUsage(userHash) { return db.prepare('SELECT tool_name,count,last_used FROM usage WHERE user_hash=?').all(userHash).map(row => ({ toolName: row.tool_name as string, count: row.count as number, lastUsed: row.last_used as number })); },
      async getClient(id) { const row = db.prepare('SELECT value FROM oauth_clients WHERE id=?').get(id); return row ? JSON.parse(row.value as string) as OAuthClientInformationFull : undefined; },
      async putClient(client) { db.prepare('INSERT OR REPLACE INTO oauth_clients(id,value) VALUES(?,?)').run(client.client_id, JSON.stringify(client)); },
      async sweep(now) { return sweep(now); },
      async close() { if (!closed) { closed = true; clearInterval(timer); db.close(); } },
    };
    Object.assign(this, backend);
  }
}

export function createSqliteBackend(options: { path: string; namespace: string; sweepIntervalMs?: number }): SqliteBackend {
  return new SqliteBackend(options);
}

export function createSqliteStore(options: { path: string; namespace: string; key: Uint8Array; sweepIntervalMs?: number }) {
  return createStore(createSqliteBackend(options), { namespace: options.namespace, key: options.key });
}
