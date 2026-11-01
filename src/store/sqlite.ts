import type { AtomicIssueParams } from './types.js';
import { closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createCodec, StoreConfigError, StoreLockedError } from './codec.js';
import { createStore, REFRESH_RETRY_WINDOW_MS } from './store.js';
import { logger } from '../utils/logger.js';
import type {
  AccessRow,
  AuthCodeRow,
  BackendRotateParams,
  BackendRotateResult,
  FamilyRow,
  RefreshPointerRow,
  ResumeRow,
  McpStore,
  RevokeCondition,
  SessionRow,
  StoreBackend,
  StoreCapabilities,
  StoredToken,
  UpstreamGrantRow,
} from './types.js';

type SqlValue = string | number | null;
type Statement = { run(...values: SqlValue[]): { changes: number | bigint }; get(...values: SqlValue[]): Record<string, SqlValue> | undefined; all(...values: SqlValue[]): Record<string, SqlValue>[] };
type Database = { exec(sql: string): void; prepare(sql: string): Statement; close(): void };
const capabilities: StoreCapabilities = { persistent: true, multiInstance: false, exclusive: true, expiry: 'sweep' };

function accessRow(row: Record<string, SqlValue> | undefined): AccessRow | undefined {
  if (!row) return undefined;
  return {
    id: row.id as string,
    familyId: row.family_id as string,
    expiresAt: row.expires_at as number,
    retainUntil: row.retain_until as number,
    sealed: row.sealed as string,
  };
}

function refreshRow(row: Record<string, SqlValue> | undefined): RefreshPointerRow | undefined {
  if (!row) return undefined;
  return {
    id: row.id as string,
    familyId: row.family_id as string,
    status: row.status as 'active' | 'consumed',
    generation: row.generation as number,
    consumedAt: (row.consumed_at ?? undefined) as number | undefined,
    successorSealed: (row.successor_sealed ?? undefined) as string | undefined,
  };
}

function familyRow(row: Record<string, SqlValue> | undefined): FamilyRow | undefined {
  if (!row) return undefined;
  return {
    id: row.id as string,
    generation: row.generation as number,
    status: row.status as 'active' | 'revoked',
    activeRefreshId: row.active_refresh_id as string,
    currentAccessTokenId: row.current_access_token_id as string,
    revokedAt: (row.revoked_at ?? undefined) as number | undefined,
    updatedAt: row.updated_at as number,
    sealed: row.sealed as string,
  };
}

function upstreamRow(row: Record<string, SqlValue> | undefined): UpstreamGrantRow | undefined {
  if (!row) return undefined;
  return {
    id: row.id as string,
    grantVersion: row.grant_version as number,
    nsExpiresAt: (row.ns_expires_at ?? undefined) as number | undefined,
    leaseOwner: (row.lease_owner ?? undefined) as string | undefined,
    leaseUntil: (row.lease_until ?? undefined) as number | undefined,
    updatedAt: row.updated_at as number,
    sealed: row.sealed as string,
  };
}

function code(row: Record<string, SqlValue> | undefined): AuthCodeRow | undefined {
  return row && { id: row.id as string, expiresAt: row.expires_at as number, sealed: row.sealed as string };
}

export class SqliteBackend implements StoreBackend {
  readonly path: string;
  readonly db: Database;
  readonly name: string = 'sqlite';
  readonly capabilities: StoreCapabilities = capabilities;

  getAccess!: StoreBackend['getAccess'];
  putAccess!: StoreBackend['putAccess'];
  deleteAccess!: StoreBackend['deleteAccess'];

  getRefresh!: StoreBackend['getRefresh'];
  putRefresh!: StoreBackend['putRefresh'];
  deleteRefresh!: StoreBackend['deleteRefresh'];

  getFamily!: StoreBackend['getFamily'];
  putFamily!: StoreBackend['putFamily'];

  getUpstream!: StoreBackend['getUpstream'];
  putUpstream!: StoreBackend['putUpstream'];
  updateUpstream!: StoreBackend['updateUpstream'];
  atomicIssue!: StoreBackend['atomicIssue'];
  atomicRotate!: StoreBackend['atomicRotate'];
  atomicRevokeFamily!: StoreBackend['atomicRevokeFamily'];
  findFamilyByRetiredId!: NonNullable<StoreBackend['findFamilyByRetiredId']>;

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

  constructor(options: { path: string; namespace: string; key?: Uint8Array; sweepIntervalMs?: number }) {
    const { path, namespace, key } = options;
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { closeSync(openSync(path, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }

    if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
      throw new StoreConfigError(`${path} is readable by other users; chmod 600 ${path}`);
    }

    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => Database };
    const db = new DatabaseSync(path);
    this.db = db;

    const transaction = <T>(fn: () => T): T => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const value = fn();
        db.exec('COMMIT');
        return value;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    };

    const sweep = (now: number) => transaction(() => {
      let n = 0;
      n += Number(db.prepare('DELETE FROM sessions WHERE retain_until <= ?').run(now).changes);
      n += Number(db.prepare('DELETE FROM auth_codes WHERE expires_at <= ?').run(now).changes);
      n += Number(db.prepare('DELETE FROM resume_tokens WHERE expires_at <= ?').run(now).changes);
      db.prepare('UPDATE refresh_tokens SET successor_sealed=NULL WHERE consumed_at IS NOT NULL AND consumed_at <= ? AND successor_sealed IS NOT NULL').run(now - REFRESH_RETRY_WINDOW_MS);
      return n;
    });

    try {
      db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=0; BEGIN IMMEDIATE; COMMIT;');
      const versionRow = db.prepare('PRAGMA user_version').get();
      const version = (versionRow?.user_version as number) ?? 0;
      if (version > 2) throw new StoreConfigError(`Unsupported SQLite schema version ${version}`);

      if (version === 1) {
        // v1 -> v2 migration inside transaction BEFORE sweep
        transaction(() => {
          const v1Rows = db.prepare('SELECT id, refresh_id, expires_at, retain_until, ns_expires_at, sealed FROM sessions').all() as Array<{
            id: string;
            refresh_id: string;
            expires_at: number;
            retain_until: number;
            ns_expires_at?: number;
            sealed: string;
          }>;

          if (v1Rows.length > 0 && !key) {
            throw new StoreConfigError('Key required to migrate SQLite v1 store containing sessions');
          }

          db.exec(`
            CREATE TABLE IF NOT EXISTS refresh_families (id TEXT PRIMARY KEY, generation INTEGER NOT NULL, status TEXT NOT NULL, active_refresh_id TEXT NOT NULL, current_access_token_id TEXT NOT NULL, revoked_at INTEGER, updated_at INTEGER NOT NULL, sealed TEXT NOT NULL) STRICT;
            CREATE TABLE IF NOT EXISTS refresh_tokens (id TEXT PRIMARY KEY CHECK(length(id)=64), family_id TEXT NOT NULL, status TEXT NOT NULL, generation INTEGER NOT NULL, consumed_at INTEGER, successor_sealed TEXT) STRICT;
            CREATE TABLE IF NOT EXISTS upstream_grants (id TEXT PRIMARY KEY, grant_version INTEGER NOT NULL, ns_expires_at INTEGER, lease_owner TEXT, lease_until INTEGER, updated_at INTEGER NOT NULL, sealed TEXT NOT NULL) STRICT;
            CREATE TABLE IF NOT EXISTS retired_refresh_tokens (refresh_id TEXT PRIMARY KEY CHECK(length(refresh_id)=64), family_id TEXT NOT NULL) STRICT;
            ALTER TABLE sessions RENAME TO sessions_v1;
            CREATE TABLE sessions (id TEXT PRIMARY KEY CHECK(length(id)=64), family_id TEXT NOT NULL, expires_at INTEGER NOT NULL, retain_until INTEGER NOT NULL CHECK(retain_until >= expires_at), sealed TEXT NOT NULL) STRICT;
          `);

          if (v1Rows.length > 0 && key) {
            const codec = createCodec(key);
            for (const row of v1Rows) {
              const legacy = codec.open<StoredToken>(row.sealed, `session:${row.id}:${row.refresh_id}`);
              if (!legacy) {
                throw new StoreConfigError(`Failed to decode SQLite v1 session ${row.id} during migration: aborted to prevent data loss`);
              }

              const familyId = randomUUID();
              const now = Date.now();
              const gen = 1;
              const gVer = 1;

              db.prepare('INSERT INTO refresh_families(id,generation,status,active_refresh_id,current_access_token_id,updated_at,sealed) VALUES (?,?,?,?,?,?,?)').run(
                familyId,
                gen,
                'active',
                row.refresh_id,
                row.id,
                now,
                codec.seal({
                  clientId: legacy.clientId,
                  serverBaseUrl: legacy.serverBaseUrl,
                  extra: legacy.extra,
                  retiredRefreshIds: [],
                }, `family:${familyId}:${gen}`),
              );

              db.prepare('INSERT INTO refresh_tokens(id,family_id,status,generation) VALUES (?,?,?,?)').run(
                row.refresh_id,
                familyId,
                'active',
                gen,
              );

              db.prepare('INSERT INTO upstream_grants(id,grant_version,ns_expires_at,updated_at,sealed) VALUES (?,?,?,?,?)').run(
                familyId,
                gVer,
                row.ns_expires_at ?? null,
                now,
                codec.seal({
                  nsAccessToken: legacy.nsAccessToken,
                  nsRefreshToken: legacy.nsRefreshToken,
                  nsUsername: legacy.nsUsername,
                  nsUserRole: legacy.nsUserRole,
                  nsApiUrl: legacy.nsApiUrl,
                }, `upstream:${familyId}:${gVer}`),
              );

              db.prepare('INSERT INTO sessions(id,family_id,expires_at,retain_until,sealed) VALUES (?,?,?,?,?)').run(
                row.id,
                familyId,
                row.expires_at,
                row.retain_until,
                codec.seal({
                  familyId,
                  clientId: legacy.clientId,
                  serverBaseUrl: legacy.serverBaseUrl,
                  extra: legacy.extra,
                }, `access:${row.id}:${familyId}`),
              );
            }
          }

          db.exec('DROP TABLE sessions_v1; PRAGMA user_version=2;');
        });
      } else {
        // v0 -> v2 initialization
        db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY CHECK(length(id)=64), family_id TEXT NOT NULL, expires_at INTEGER NOT NULL, retain_until INTEGER NOT NULL CHECK(retain_until >= expires_at), sealed TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS refresh_families (id TEXT PRIMARY KEY, generation INTEGER NOT NULL, status TEXT NOT NULL, active_refresh_id TEXT NOT NULL, current_access_token_id TEXT NOT NULL, revoked_at INTEGER, updated_at INTEGER NOT NULL, sealed TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS refresh_tokens (id TEXT PRIMARY KEY CHECK(length(id)=64), family_id TEXT NOT NULL, status TEXT NOT NULL, generation INTEGER NOT NULL, consumed_at INTEGER, successor_sealed TEXT) STRICT;
          CREATE TABLE IF NOT EXISTS upstream_grants (id TEXT PRIMARY KEY, grant_version INTEGER NOT NULL, ns_expires_at INTEGER, lease_owner TEXT, lease_until INTEGER, updated_at INTEGER NOT NULL, sealed TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS retired_refresh_tokens (refresh_id TEXT PRIMARY KEY CHECK(length(refresh_id)=64), family_id TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS auth_codes (id TEXT PRIMARY KEY CHECK(length(id)=64), expires_at INTEGER NOT NULL, sealed TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS resume_tokens (id TEXT PRIMARY KEY CHECK(length(id)=64), consumed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS usage (user_hash TEXT NOT NULL CHECK(length(user_hash)=64), tool_name TEXT NOT NULL, count INTEGER NOT NULL, last_used INTEGER NOT NULL, PRIMARY KEY(user_hash, tool_name)) STRICT;
          PRAGMA user_version=2;
        COMMIT;`);
      }

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

    const timer = setInterval(() => {
      try { sweep(Date.now()); }
      catch (error) { logger.warn('Failed to sweep SQLite store', { error: String(error) }); }
    }, options.sweepIntervalMs ?? 600_000);
    timer.unref();

    let closed = false;

    const backend: StoreBackend = {
      name: 'sqlite',
      capabilities,

      async getAccess(id: string) {
        return accessRow(db.prepare('SELECT * FROM sessions WHERE id=?').get(id));
      },
      async putAccess(row: AccessRow) {
        db.prepare(`INSERT INTO sessions(id,family_id,expires_at,retain_until,sealed) VALUES (?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET family_id=excluded.family_id,expires_at=excluded.expires_at,retain_until=excluded.retain_until,sealed=excluded.sealed`)
          .run(row.id, row.familyId, row.expiresAt, row.retainUntil, row.sealed);
      },
      async deleteAccess(id: string) {
        db.prepare('DELETE FROM sessions WHERE id=?').run(id);
      },

      async getRefresh(id: string) {
        return refreshRow(db.prepare('SELECT * FROM refresh_tokens WHERE id=?').get(id));
      },
      async putRefresh(row: RefreshPointerRow) {
        db.prepare(`INSERT INTO refresh_tokens(id,family_id,status,generation,consumed_at,successor_sealed) VALUES (?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET family_id=excluded.family_id,status=excluded.status,generation=excluded.generation,consumed_at=excluded.consumed_at,successor_sealed=excluded.successor_sealed`)
          .run(row.id, row.familyId, row.status, row.generation, row.consumedAt ?? null, row.successorSealed ?? null);
      },
      async deleteRefresh(id: string) {
        db.prepare('DELETE FROM refresh_tokens WHERE id=?').run(id);
      },

      async getFamily(id: string) {
        return familyRow(db.prepare('SELECT * FROM refresh_families WHERE id=?').get(id));
      },
      async putFamily(row: FamilyRow) {
        db.prepare(`INSERT INTO refresh_families(id,generation,status,active_refresh_id,current_access_token_id,revoked_at,updated_at,sealed) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,status=excluded.status,active_refresh_id=excluded.active_refresh_id,current_access_token_id=excluded.current_access_token_id,revoked_at=excluded.revoked_at,updated_at=excluded.updated_at,sealed=excluded.sealed`)
          .run(row.id, row.generation, row.status, row.activeRefreshId, row.currentAccessTokenId, row.revokedAt ?? null, row.updatedAt, row.sealed);
      },

      async getUpstream(id: string) {
        return upstreamRow(db.prepare('SELECT * FROM upstream_grants WHERE id=?').get(id));
      },
      async putUpstream(row: UpstreamGrantRow) {
        db.prepare(`INSERT INTO upstream_grants(id,grant_version,ns_expires_at,lease_owner,lease_until,updated_at,sealed) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET grant_version=excluded.grant_version,ns_expires_at=excluded.ns_expires_at,lease_owner=excluded.lease_owner,lease_until=excluded.lease_until,updated_at=excluded.updated_at,sealed=excluded.sealed`)
          .run(row.id, row.grantVersion, row.nsExpiresAt ?? null, row.leaseOwner ?? null, row.leaseUntil ?? null, row.updatedAt, row.sealed);
      },
      async atomicIssue(params: AtomicIssueParams): Promise<void> {
        transaction(() => {
          db.prepare(`INSERT INTO sessions(id,family_id,expires_at,retain_until,sealed) VALUES (?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET family_id=excluded.family_id,expires_at=excluded.expires_at,retain_until=excluded.retain_until,sealed=excluded.sealed`)
            .run(params.accessRow.id, params.accessRow.familyId, params.accessRow.expiresAt, params.accessRow.retainUntil, params.accessRow.sealed);

          db.prepare(`INSERT INTO refresh_tokens(id,family_id,status,generation,consumed_at,successor_sealed) VALUES (?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET family_id=excluded.family_id,status=excluded.status,generation=excluded.generation,consumed_at=excluded.consumed_at,successor_sealed=excluded.successor_sealed`)
            .run(params.refreshRow.id, params.refreshRow.familyId, params.refreshRow.status, params.refreshRow.generation, params.refreshRow.consumedAt ?? null, params.refreshRow.successorSealed ?? null);

          db.prepare(`INSERT INTO refresh_families(id,generation,status,active_refresh_id,current_access_token_id,revoked_at,updated_at,sealed) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,status=excluded.status,active_refresh_id=excluded.active_refresh_id,current_access_token_id=excluded.current_access_token_id,revoked_at=excluded.revoked_at,updated_at=excluded.updated_at,sealed=excluded.sealed`)
            .run(params.familyRow.id, params.familyRow.generation, params.familyRow.status, params.familyRow.activeRefreshId, params.familyRow.currentAccessTokenId, params.familyRow.revokedAt ?? null, params.familyRow.updatedAt, params.familyRow.sealed);

          db.prepare(`INSERT INTO upstream_grants(id,grant_version,ns_expires_at,lease_owner,lease_until,updated_at,sealed) VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET grant_version=excluded.grant_version,ns_expires_at=excluded.ns_expires_at,lease_owner=excluded.lease_owner,lease_until=excluded.lease_until,updated_at=excluded.updated_at,sealed=excluded.sealed`)
            .run(params.upstreamRow.id, params.upstreamRow.grantVersion, params.upstreamRow.nsExpiresAt ?? null, params.upstreamRow.leaseOwner ?? null, params.upstreamRow.leaseUntil ?? null, params.upstreamRow.updatedAt, params.upstreamRow.sealed);
        });
      },

      async updateUpstream(id: string, mutate) {
        return transaction(() => {
          const current = upstreamRow(db.prepare('SELECT * FROM upstream_grants WHERE id=?').get(id));
          if (!current) return undefined;
          const next = mutate(current);
          if (next === null) {
            db.prepare('DELETE FROM upstream_grants WHERE id=?').run(id);
            return undefined;
          }
          if (next) {
            db.prepare(`INSERT INTO upstream_grants(id,grant_version,ns_expires_at,lease_owner,lease_until,updated_at,sealed) VALUES (?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET grant_version=excluded.grant_version,ns_expires_at=excluded.ns_expires_at,lease_owner=excluded.lease_owner,lease_until=excluded.lease_until,updated_at=excluded.updated_at,sealed=excluded.sealed`)
              .run(next.id, next.grantVersion, next.nsExpiresAt ?? null, next.leaseOwner ?? null, next.leaseUntil ?? null, next.updatedAt, next.sealed);
            return next;
          }
          return current;
        });
      },

      async findFamilyByRetiredId(retiredId: string) {
        const row = db.prepare('SELECT family_id FROM retired_refresh_tokens WHERE refresh_id=?').get(retiredId);
        if (!row) return undefined;
        return familyRow(db.prepare('SELECT * FROM refresh_families WHERE id=?').get(row.family_id as string));
      },

      async atomicRotate(params: BackendRotateParams): Promise<BackendRotateResult> {
        return transaction(() => {
          const oldRef = refreshRow(db.prepare('SELECT * FROM refresh_tokens WHERE id=?').get(params.oldRefreshId));
          if (!oldRef) {
            const retired = db.prepare('SELECT family_id FROM retired_refresh_tokens WHERE refresh_id=?').get(params.oldRefreshId);
            if (retired) {
              const famId = retired.family_id as string;
              db.prepare("UPDATE refresh_families SET status='revoked', revoked_at=?, generation=generation+1, updated_at=? WHERE id=?")
                .run(params.now, params.now, famId);
              return { status: 'replay', familyId: famId };
            }
            return { status: 'missing' };
          }

          const fam = familyRow(db.prepare('SELECT * FROM refresh_families WHERE id=?').get(oldRef.familyId));
          if (!fam || fam.status !== 'active') return { status: 'missing' };

          if (oldRef.status === 'consumed') {
            const withinRetry = oldRef.consumedAt !== undefined && params.now - oldRef.consumedAt <= REFRESH_RETRY_WINDOW_MS;
            if (withinRetry && oldRef.successorSealed) {
              return {
                status: 'retry',
                familyId: fam.id,
                generation: fam.generation,
                successorSealed: oldRef.successorSealed,
              };
            }
            // Late replay
            db.prepare("UPDATE refresh_families SET status='revoked', revoked_at=?, generation=generation+1, updated_at=? WHERE id=?")
              .run(params.now, params.now, fam.id);
            return { status: 'replay', familyId: fam.id };
          }

          const nextGen = fam.generation + 1;

          // Consume old refresh
          db.prepare("UPDATE refresh_tokens SET status='consumed', consumed_at=?, successor_sealed=? WHERE id=?")
            .run(params.now, params.newSuccessorSealed, params.oldRefreshId);
          db.prepare('UPDATE refresh_tokens SET successor_sealed=NULL WHERE family_id=? AND consumed_at IS NOT NULL AND consumed_at <= ? AND successor_sealed IS NOT NULL')
            .run(fam.id, params.now - REFRESH_RETRY_WINDOW_MS);
          if (params.retiredFingerprint) {
            db.prepare('INSERT OR REPLACE INTO retired_refresh_tokens(refresh_id, family_id) VALUES (?,?)')
              .run(params.retiredFingerprint, fam.id);
          }

          // Delete old access token
          if (fam.currentAccessTokenId) {
            db.prepare('DELETE FROM sessions WHERE id=?').run(fam.currentAccessTokenId);
          }

          // Insert new access token
          db.prepare('INSERT INTO sessions(id,family_id,expires_at,retain_until,sealed) VALUES (?,?,?,?,?)')
            .run(params.newAccessRow.id, fam.id, params.newAccessRow.expiresAt, params.newAccessRow.retainUntil, params.newAccessRow.sealed);

          // Insert new refresh token
          db.prepare('INSERT INTO refresh_tokens(id,family_id,status,generation) VALUES (?,?,?,?)')
            .run(params.newRefreshRow.id, fam.id, 'active', nextGen);

          // Update family
          db.prepare('UPDATE refresh_families SET generation=?, active_refresh_id=?, current_access_token_id=?, sealed=?, updated_at=? WHERE id=?')
            .run(nextGen, params.newRefreshRow.id, params.newAccessRow.id, params.newFamilySealed, params.now, fam.id);

          // Update upstream if provided
          if (params.newUpstreamSealed) {
            db.prepare('UPDATE upstream_grants SET grant_version=grant_version+1, ns_expires_at=?, lease_owner=NULL, lease_until=NULL, updated_at=?, sealed=? WHERE id=?')
              .run(params.newNsExpiresAt ?? null, params.now, params.newUpstreamSealed, fam.id);
          }

          return {
            status: 'claimed',
            familyId: fam.id,
            generation: nextGen,
          };
        });
      },

      async atomicRevokeFamily(familyId: string, condition?: RevokeCondition): Promise<'revoked' | 'stale' | 'missing'> {
        return transaction(() => {
          const fam = familyRow(db.prepare('SELECT * FROM refresh_families WHERE id=?').get(familyId));
          if (!fam) return 'missing';
          if (fam.status !== 'active') return 'stale';

          if (condition?.expectedFamilyGeneration !== undefined && fam.generation !== condition.expectedFamilyGeneration) {
            return 'stale';
          }
          if (condition?.expectedUpstreamGrantVersion !== undefined) {
            const up = upstreamRow(db.prepare('SELECT * FROM upstream_grants WHERE id=?').get(familyId));
            if (up && up.grantVersion !== condition.expectedUpstreamGrantVersion) {
              return 'stale';
            }
          }

          const now = Date.now();
          db.prepare("UPDATE refresh_families SET status='revoked', revoked_at=?, generation=generation+1, updated_at=? WHERE id=?")
            .run(now, now, fam.id);

          db.prepare('DELETE FROM sessions WHERE family_id=?').run(fam.id);
          db.prepare('DELETE FROM upstream_grants WHERE id=?').run(fam.id);
          db.prepare("UPDATE refresh_tokens SET status='consumed', consumed_at=?, successor_sealed=NULL WHERE family_id=?")
            .run(now, fam.id);

          return 'revoked';
        });
      },

      async putAuthCode(row: AuthCodeRow) { db.prepare('INSERT OR REPLACE INTO auth_codes(id,expires_at,sealed) VALUES(?,?,?)').run(row.id, row.expiresAt, row.sealed); },
      async getAuthCode(id: string) { return code(db.prepare('SELECT * FROM auth_codes WHERE id=?').get(id)); },
      async takeAuthCode(id: string) { return transaction(() => { const row = code(db.prepare('SELECT * FROM auth_codes WHERE id=?').get(id)); db.prepare('DELETE FROM auth_codes WHERE id=?').run(id); return row; }); },
      async insertResumeIfAbsent(row: ResumeRow, now) { return transaction(() => { db.prepare('DELETE FROM resume_tokens WHERE id=? AND expires_at<=?').run(row.id, now); return Number(db.prepare('INSERT INTO resume_tokens(id,consumed_at,expires_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').run(row.id, row.consumedAt, row.expiresAt).changes) === 1; }); },
      async incrementUsage(userHash, toolName, now) { db.prepare('INSERT INTO usage(user_hash,tool_name,count,last_used) VALUES(?,?,1,?) ON CONFLICT(user_hash,tool_name) DO UPDATE SET count=count+1,last_used=excluded.last_used').run(userHash, toolName, now); },
      async listUsage(userHash) { return db.prepare('SELECT tool_name,count,last_used FROM usage WHERE user_hash=?').all(userHash).map(row => ({ toolName: row.tool_name as string, count: row.count as number, lastUsed: row.last_used as number })); },
      async getClient(id) { const row = db.prepare('SELECT value FROM oauth_clients WHERE id=?').get(id); return row ? JSON.parse(row.value as string) as OAuthClientInformationFull : undefined; },
      async putClient(client) { db.prepare('INSERT OR REPLACE INTO oauth_clients(id,value) VALUES(?,?)').run(client.client_id, JSON.stringify(client)); },
      async sweep(now) { return sweep(now); },
      async close() { if (!closed) { closed = true; clearInterval(timer); db.close(); } },
      async getSession(id) {
        const row = accessRow(db.prepare('SELECT * FROM sessions WHERE id=?').get(id));
        if (!row) return undefined;
        return { id: row.id, refreshId: row.familyId, expiresAt: row.expiresAt, retainUntil: row.retainUntil, sealed: row.sealed };
      },
      async findSessionByRefreshId(id) {
        const row = db.prepare('SELECT s.* FROM sessions s JOIN refresh_tokens r ON s.family_id = r.family_id WHERE r.id=?').get(id);
        const a = accessRow(row);
        if (!a) return undefined;
        return { id: a.id, refreshId: id, expiresAt: a.expiresAt, retainUntil: a.retainUntil, sealed: a.sealed };
      },
      async putSession(row) {
        db.prepare(`INSERT INTO sessions(id,family_id,expires_at,retain_until,sealed) VALUES (?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET family_id=excluded.family_id,expires_at=excluded.expires_at,retain_until=excluded.retain_until,sealed=excluded.sealed`)
          .run(row.id, row.refreshId ?? row.id, row.expiresAt, row.retainUntil, row.sealed);
      },
      async updateSession(id, mutate) {
        return transaction(() => {
          const current = accessRow(db.prepare('SELECT * FROM sessions WHERE id=?').get(id));
          if (!current) return undefined;
          const legacyRow: SessionRow = { id: current.id, refreshId: current.familyId, expiresAt: current.expiresAt, retainUntil: current.retainUntil, sealed: current.sealed };
          const next = mutate(legacyRow);
          if (next === null) { db.prepare('DELETE FROM sessions WHERE id=?').run(id); return undefined; }
          if (next) {
            db.prepare(`INSERT INTO sessions(id,family_id,expires_at,retain_until,sealed) VALUES (?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET family_id=excluded.family_id,expires_at=excluded.expires_at,retain_until=excluded.retain_until,sealed=excluded.sealed`)
              .run(next.id, next.refreshId ?? next.id, next.expiresAt, next.retainUntil, next.sealed);
            return next;
          }
          return legacyRow;
        });
      },
      async deleteSession(id) { db.prepare('DELETE FROM sessions WHERE id=?').run(id); },
    };

    Object.assign(this, backend);
  }
}

export function createSqliteBackend(options: { path: string; namespace: string; key?: Uint8Array; sweepIntervalMs?: number }): SqliteBackend {
  return new SqliteBackend(options);
}

export function createSqliteStore(options: { path: string; namespace: string; key: Uint8Array; sweepIntervalMs?: number }): McpStore {
  return createStore(createSqliteBackend(options), { namespace: options.namespace, key: options.key });
}
