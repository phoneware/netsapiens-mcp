/**
 * File-backed token store for the HTTP transport's OAuth tokens.
 *
 * Persists tokens to a JSON file so that server restarts don't log out all users.
 * Default path: ~/.netsapiens-mcp/http-tokens.json (permissions 0o600).
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { MemoryTokenLedger, type BaseStoredToken } from './kit/ledger.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Token data structure
// ---------------------------------------------------------------------------

export interface StoredToken extends BaseStoredToken {
 /** Our issued access token (opaque string) */
 accessToken: string;
 /** Our issued refresh token */
 refreshToken: string;
 /** Client that owns this token */
 clientId: string;
 /** When our token expires (epoch ms) */
 expiresAt: number;
 /** Upstream NS access token for API calls */
 nsAccessToken: string;
 /** Upstream NS refresh token */
 nsRefreshToken?: string;
 /** When the upstream NS access token expires (epoch ms) */
 nsExpiresAt?: number;
 /** NS username (for identifying the user session) */
 nsUsername: string;
 /** Detected NS user role */
 nsUserRole?: string;
 /** Upstream NetSapiens platform API URL (e.g. https://edge.phoneware.cloud) */
 nsApiUrl?: string;
 /** MCP Server base URL this token was issued for (cross-server isolation) */
 serverBaseUrl?: string;
 /** Extra metadata stored with the token */
 extra?: Record<string, string>;
 /** Firestore TTL timestamp */
 ttlAt?: Date;
  /** Refresh family id */
  refreshFamilyId?: string;
}

export interface TokenStoreLike {
 get(accessToken: string): StoredToken | undefined | Promise<StoredToken | undefined>;
 getByRefreshToken(refreshToken: string): StoredToken | undefined | Promise<StoredToken | undefined>;
 set(token: StoredToken): void | Promise<void>;
 update(accessToken: string, patch: Partial<StoredToken>): StoredToken | undefined | Promise<StoredToken | undefined>;
 delete(accessToken: string): void | Promise<void>;
 deleteByRefreshToken(refreshToken: string): void | Promise<void>;
 refreshNsToken?(
  accessToken: string,
  doRefresh: (stored: StoredToken) => Promise<{ access_token: string; refresh_token?: string; expires_in?: number }>,
 ): Promise<StoredToken>;
 clearCache?(): void;
 readonly size: number;
}

// ---------------------------------------------------------------------------
// TokenStore
// ---------------------------------------------------------------------------

export class TokenStore extends MemoryTokenLedger<StoredToken> {
 private readonly filePath: string;

 constructor(filePath?: string) {
    super();
  const defaultFileName = process.env.MCP_READ_ONLY === 'true'
   ? 'http-tokens-readonly.json'
   : 'http-tokens.json';
  this.filePath =
   filePath ??
   process.env.MCP_TOKEN_STORE_PATH ??
   join(homedir(), '.netsapiens-mcp', defaultFileName);
  this.load();
 }

  async revokeByToken(token: string): Promise<void> {
    const access = (this as unknown as { byAccess: Map<string, StoredToken> }).byAccess.get(token);
    if (access) {
      if (access.refreshFamilyId) {
        await this.revokeFamily(access.refreshFamilyId);
      } else {
        (this as unknown as { byAccess: Map<string, StoredToken> }).byAccess.delete(token);
        (this as unknown as { byRefresh: Map<string, { token: StoredToken }> }).byRefresh.delete(access.refreshToken);
      }
      this.save();
      return;
    }
    await super.revokeByToken(token);
    this.save();
  }

 /** Get a token by its access token string. */
 get(accessToken: string): StoredToken | undefined {
    // MemoryTokenLedger.getByAccessToken is async, but local Map read is sync
    return (this as unknown as { byAccess: Map<string, StoredToken> }).byAccess.get(accessToken);
 }

 /** Get a token by its refresh token string. */
 getByRefreshToken(refreshToken: string): StoredToken | undefined {
    const record = (this as unknown as { byRefresh: Map<string, { status: string; token: StoredToken }> }).byRefresh.get(refreshToken);
    if (!record) return undefined;
    return record.token;
 }

 /** Store a token (indexed by both access and refresh token). */
 set(token: StoredToken): void {
  const familyId = token.refreshFamilyId ?? randomUUID();
  const stored: StoredToken = token;
  const priv = this as unknown as {
   byAccess: Map<string, StoredToken>;
   byRefresh: Map<string, { status: string; familyId: string; token: StoredToken }>;
   families: Map<string, unknown>;
  };
  priv.byAccess.set(stored.accessToken, stored);
  priv.byRefresh.set(stored.refreshToken, {
   status: 'active',
   familyId,
   token: stored,
  });
  priv.families.set(familyId, {
   id: familyId,
   currentAccessToken: stored.accessToken,
   currentRefreshToken: stored.refreshToken,
   retiredRefreshFingerprints: [],
   updatedAt: Date.now(),
  });
  this.save();
 }

 cleanup(): void {
  const now = Date.now();
  const priv = this as unknown as {
   byAccess: Map<string, StoredToken>;
   byRefresh: Map<string, { status: string; familyId: string; token: StoredToken }>;
  };
  for (const [key, token] of priv.byAccess.entries()) {
   if (token.expiresAt <= now) {
    priv.byAccess.delete(key);
    priv.byRefresh.delete(token.refreshToken);
   }
  }
  this.save();
 }

  /** Update an existing token in place. */
 update(accessToken: string, patch: Partial<StoredToken>): StoredToken | undefined {
    const existing = this.get(accessToken);
  if (!existing) return undefined;
    const updated: StoredToken = { ...existing, ...patch };
    const priv = this as unknown as {
      byAccess: Map<string, StoredToken>;
      byRefresh: Map<string, { status: string; familyId: string; token: StoredToken }>;
    };
    priv.byAccess.set(accessToken, updated);
    const refreshRec = priv.byRefresh.get(existing.refreshToken);
    if (refreshRec) {
      refreshRec.token = updated;
    }
  if (patch.refreshToken && patch.refreshToken !== existing.refreshToken) {
      priv.byRefresh.delete(existing.refreshToken);
      priv.byRefresh.set(patch.refreshToken, {
        status: 'active',
        familyId: updated.refreshFamilyId ?? 'default',
        token: updated,
      });
  }
  this.save();
  return updated;
 }

 async refreshNsToken(
  accessToken: string,
  doRefresh: (stored: StoredToken) => Promise<{ access_token: string; refresh_token?: string; expires_in?: number }>,
 ): Promise<StoredToken> {
  const token = this.get(accessToken);
  if (!token) throw new Error('Token document not found');
  const refreshed = await doRefresh(token);
  const expiresAt = refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : undefined;
  const updated = this.update(accessToken, {
   nsAccessToken: refreshed.access_token,
   nsRefreshToken: refreshed.refresh_token ?? token.nsRefreshToken,
   nsExpiresAt: expiresAt,
  });
  return updated ?? token;
 }

 /** Delete a token by its access token. */
 delete(accessToken: string): void {
  const token = this.get(accessToken);
  const priv = this as unknown as {
   byAccess: Map<string, StoredToken>;
   byRefresh: Map<string, { status: string; familyId?: string; token: StoredToken }>;
  };
  priv.byAccess.delete(accessToken);
  if (token) {
   priv.byRefresh.delete(token.refreshToken);
  }
  if (token?.refreshFamilyId) {
   void this.revokeFamily(token.refreshFamilyId).then(() => this.save());
  } else {
   this.save();
  }
 }

 /** Delete a token by its refresh token. */
 deleteByRefreshToken(refreshToken: string): void {
  const token = this.getByRefreshToken(refreshToken);
  const priv = this as unknown as {
   byAccess: Map<string, StoredToken>;
   byRefresh: Map<string, { status: string; familyId?: string; token: StoredToken }>;
  };
  priv.byRefresh.delete(refreshToken);
  if (token) {
   priv.byAccess.delete(token.accessToken);
  }
  void this.revokeByToken(refreshToken).then(() => this.save());
 }

 // -----------------------------------------------------------------------
 // Persistence
 // -----------------------------------------------------------------------

 private load(): void {
  try {
   if (!existsSync(this.filePath)) return;
   const raw = readFileSync(this.filePath, 'utf-8');
      if (!raw.trim()) return;
      // Check if format is MemoryTokenLedger.toJSON or legacy format
      if (raw.includes('"byAccess"')) {
        this.fromJSON(raw);
      } else {
        const legacy = JSON.parse(raw) as { tokens?: Record<string, StoredToken> };
        if (legacy && legacy.tokens) {
          for (const token of Object.values(legacy.tokens)) {
            void this.issue(token);
   }
        }
      }
      logger.info('Loaded token store', { count: this.size, path: this.filePath });
  } catch (err) {
   logger.warn('Failed to load token store, starting fresh', { error: String(err) });
  }
 }

 private save(): void {
  try {
   const dir = dirname(this.filePath);
   if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
   }
      writeFileSync(this.filePath, this.toJSON(), { mode: 0o600 });
  } catch (err) {
   logger.error('Failed to save token store', { error: String(err) });
  }
 }
}
