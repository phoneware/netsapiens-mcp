/**
 * Per-user tool-usage tracking. Powers automatic promotion of frequently-
 * used generated tools into the user's default tool list.
 *
 * Two implementations:
 *   - FirestoreUsageStore — persistent across deploys; used in production.
 *   - InMemoryUsageStore — for stdio mode and tests.
 *
 * Keying convention: `${userKey}__${toolName}` as the document id. `userKey`
 * is the NetSapiens username (from the bearer token's auth context), so
 * promotion is per NetSapiens identity, not per AI client.
 */

import { Firestore } from '@google-cloud/firestore';
import { logger } from '../../utils/logger.js';

export interface UsageRecord {
  /** Number of successful invocations recorded. */
  count: number;
  /** Epoch ms of the most recent successful invocation. */
  lastUsed: number;
}

export interface UsageStore {
  recordCall(userKey: string, toolName: string): Promise<void>;
  /** Returns a snapshot of the user's usage records keyed by tool name. */
  getUserUsage(userKey: string): Promise<Map<string, UsageRecord>>;
}

// ---------------------------------------------------------------------------
// In-memory (default; used in stdio + tests)
// ---------------------------------------------------------------------------

export class InMemoryUsageStore implements UsageStore {
  private map = new Map<string, Map<string, UsageRecord>>();

  async recordCall(userKey: string, toolName: string): Promise<void> {
    let perUser = this.map.get(userKey);
    if (!perUser) {
      perUser = new Map();
      this.map.set(userKey, perUser);
    }
    const existing = perUser.get(toolName);
    perUser.set(toolName, {
      count: (existing?.count ?? 0) + 1,
      lastUsed: now(),
    });
  }

  async getUserUsage(userKey: string): Promise<Map<string, UsageRecord>> {
    return new Map(this.map.get(userKey) ?? []);
  }
}

// ---------------------------------------------------------------------------
// Firestore-backed
// ---------------------------------------------------------------------------

export class FirestoreUsageStore implements UsageStore {
  private readonly db: Firestore;
  private readonly collection: string;
  /** Cache the most recent per-user snapshot so promotion lookups are cheap. */
  private cache = new Map<string, { fetchedAt: number; data: Map<string, UsageRecord> }>();
  private static readonly CACHE_TTL_MS = 30_000;

  constructor(opts: { collection?: string; projectId?: string } = {}) {
    this.collection = opts.collection ?? 'mcp_tool_usage';
    this.db = new Firestore({ projectId: opts.projectId });
    logger.info('Firestore usage store initialized', { collection: this.collection });
  }

  private docId(userKey: string, toolName: string): string {
    // Avoid Firestore id-forbidden chars by base64url-encoding the username.
    const safeUser = Buffer.from(userKey).toString('base64url');
    return `${safeUser}__${toolName}`;
  }

  async recordCall(userKey: string, toolName: string): Promise<void> {
    const docRef = this.db.collection(this.collection).doc(this.docId(userKey, toolName));
    try {
      const snap = await docRef.get();
      const existing = snap.exists ? (snap.data() as { count?: number }) : undefined;
      const next: UsageRecord & { userKey: string; toolName: string } = {
        count: (existing?.count ?? 0) + 1,
        lastUsed: now(),
        userKey,
        toolName,
      };
      await docRef.set(next);
      // Invalidate the cached snapshot for this user so the next promotion
      // lookup sees the fresh count.
      this.cache.delete(userKey);
    } catch (err) {
      // Usage tracking is best-effort — it must never fail a tool call.
      logger.warn('FirestoreUsageStore.recordCall failed', {
        userKey,
        toolName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async getUserUsage(userKey: string): Promise<Map<string, UsageRecord>> {
    const cached = this.cache.get(userKey);
    if (cached && now() - cached.fetchedAt < FirestoreUsageStore.CACHE_TTL_MS) {
      return new Map(cached.data);
    }
    try {
      const safeUser = Buffer.from(userKey).toString('base64url');
      const query = await this.db
        .collection(this.collection)
        .where('userKey', '==', userKey)
        .get();
      const map = new Map<string, UsageRecord>();
      query.forEach((doc) => {
        const data = doc.data() as { toolName?: string; count?: number; lastUsed?: number };
        if (data.toolName && typeof data.count === 'number' && typeof data.lastUsed === 'number') {
          map.set(data.toolName, { count: data.count, lastUsed: data.lastUsed });
        }
      });
      this.cache.set(userKey, { fetchedAt: now(), data: map });
      // Suppress unused-locals warning for the safeUser variable (we reference
      // it during writes via docId; the where() query uses the plain userKey).
      void safeUser;
      return new Map(map);
    } catch (err) {
      logger.warn('FirestoreUsageStore.getUserUsage failed', {
        userKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return new Map();
    }
  }
}

// ---------------------------------------------------------------------------
// Factory + helpers
// ---------------------------------------------------------------------------

let singleton: UsageStore | null = null;

/** Returns the configured usage store (Firestore on Cloud Run, in-memory otherwise). */
export function getUsageStore(): UsageStore {
  if (singleton) return singleton;
  const useFirestore =
    process.env.MCP_PERSISTENCE === 'firestore' ||
    (process.env.MCP_PERSISTENCE !== 'file' && !!process.env.GOOGLE_CLOUD_PROJECT);
  singleton = useFirestore
    ? new FirestoreUsageStore({ projectId: process.env.GOOGLE_CLOUD_PROJECT })
    : new InMemoryUsageStore();
  return singleton;
}

/** Reset the singleton (test-only). */
export function _resetUsageStoreForTests(store?: UsageStore): void {
  singleton = store ?? null;
}

function now(): number {
  return Date.now();
}
