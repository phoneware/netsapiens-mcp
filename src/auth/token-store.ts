/**
 * File-backed token store for the HTTP transport's OAuth tokens.
 *
 * Persists tokens to a JSON file so that server restarts don't log out all users.
 * Default path: ~/.netsapiens-mcp/http-tokens.json (permissions 0o600).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Token data structure
// ---------------------------------------------------------------------------

export interface StoredToken {
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
}

// ---------------------------------------------------------------------------
// Persistence format
// ---------------------------------------------------------------------------

interface TokenStoreData {
  tokens: Record<string, StoredToken>;
}

/**
 * Async-friendly interface implemented by both the in-process file-backed
 * store and the Firestore-backed one. Auth provider code only sees this.
 */
export interface TokenStoreLike {
  get(accessToken: string): StoredToken | undefined | Promise<StoredToken | undefined>;
  getByRefreshToken(refreshToken: string): StoredToken | undefined | Promise<StoredToken | undefined>;
  set(token: StoredToken): void | Promise<void>;
  update(accessToken: string, patch: Partial<StoredToken>): StoredToken | undefined | Promise<StoredToken | undefined>;
  delete(accessToken: string): void | Promise<void>;
  deleteByRefreshToken(refreshToken: string): void | Promise<void>;
  readonly size: number;
}

// ---------------------------------------------------------------------------
// TokenStore
// ---------------------------------------------------------------------------

export class TokenStore {
  private tokens = new Map<string, StoredToken>();
  private refreshIdx = new Map<string, StoredToken>();
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? join(homedir(), '.netsapiens-mcp', 'http-tokens.json');
    this.load();
  }

  /** Get a token by its access token string. */
  get(accessToken: string): StoredToken | undefined {
    return this.tokens.get(accessToken);
  }

  /** Get a token by its refresh token string. */
  getByRefreshToken(refreshToken: string): StoredToken | undefined {
    return this.refreshIdx.get(refreshToken);
  }

  /** Store a token (indexed by both access and refresh token). */
  set(token: StoredToken): void {
    this.tokens.set(token.accessToken, token);
    this.refreshIdx.set(token.refreshToken, token);
    this.save();
  }

  /** Update an existing token in place (e.g. after refreshing the upstream NS token). */
  update(accessToken: string, patch: Partial<StoredToken>): StoredToken | undefined {
    const existing = this.tokens.get(accessToken);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch };
    this.tokens.set(updated.accessToken, updated);
    if (patch.refreshToken && patch.refreshToken !== existing.refreshToken) {
      this.refreshIdx.delete(existing.refreshToken);
    }
    this.refreshIdx.set(updated.refreshToken, updated);
    this.save();
    return updated;
  }

  /** Delete a token by its access token. */
  delete(accessToken: string): void {
    const token = this.tokens.get(accessToken);
    if (token) {
      this.tokens.delete(accessToken);
      this.refreshIdx.delete(token.refreshToken);
      this.save();
    }
  }

  /** Delete a token by its refresh token. */
  deleteByRefreshToken(refreshToken: string): void {
    const token = this.refreshIdx.get(refreshToken);
    if (token) {
      this.refreshIdx.delete(refreshToken);
      this.tokens.delete(token.accessToken);
      this.save();
    }
  }

  /** Remove all expired tokens. */
  cleanup(): void {
    const now = Date.now();
    let changed = false;
    for (const [key, token] of this.tokens) {
      if (token.expiresAt <= now) {
        this.tokens.delete(key);
        this.refreshIdx.delete(token.refreshToken);
        changed = true;
      }
    }
    if (changed) {
      this.save();
      logger.info('Cleaned up expired tokens');
    }
  }

  /** Number of active (stored) tokens. */
  get size(): number {
    return this.tokens.size;
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = readFileSync(this.filePath, 'utf-8');
      const data: TokenStoreData = JSON.parse(raw);
      for (const [key, token] of Object.entries(data.tokens)) {
        this.tokens.set(key, token);
        this.refreshIdx.set(token.refreshToken, token);
      }
      logger.info('Loaded token store', { count: this.tokens.size, path: this.filePath });
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
      const data: TokenStoreData = {
        tokens: Object.fromEntries(this.tokens),
      };
      writeFileSync(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch (err) {
      logger.error('Failed to save token store', { error: String(err) });
    }
  }
}
