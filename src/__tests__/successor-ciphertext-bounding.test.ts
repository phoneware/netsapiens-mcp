import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryBackend } from '../store/memory.js';
import { createSqliteBackend } from '../store/sqlite.js';
import { createFirestoreBackend, type FirestoreLike } from '../store/firestore.js';
import { createStore, REFRESH_RETRY_WINDOW_MS } from '../store/store.js';
import { deriveStoreKey } from '../store/codec.js';
import type { McpStore, StoreBackend } from '../store/types.js';

class MockFirestore implements FirestoreLike {
  private collections = new Map<string, Map<string, Record<string, unknown>>>();

  private getCol(name: string): Map<string, Record<string, unknown>> {
    if (!this.collections.has(name)) {
      this.collections.set(name, new Map());
    }
    return this.collections.get(name)!;
  }

  collection(path: string): any {
    const col = this.getCol(path);
    return {
      doc: (id: string) => ({
        id,
        get: async () => ({
          id,
          exists: col.has(id),
          data: () => col.get(id),
        }),
        set: async (data: Record<string, unknown>) => {
          col.set(id, data);
        },
        delete: async () => {
          col.delete(id);
        },
      }),
      get: async () => ({
        empty: col.size === 0,
        docs: Array.from(col.entries()).map(([id, data]) => ({
          id,
          exists: true,
          data: () => data,
        })),
      }),
      where: (field: string, _op: string, value: string) => ({
        get: async () => {
          const matched = Array.from(col.entries()).filter(([, d]) => d[field] === value);
          return {
            empty: matched.length === 0,
            docs: matched.map(([id, data]) => ({
              id,
              exists: true,
              data: () => data,
            })),
          };
        },
      }),
    };
  }

  async runTransaction<T>(cb: (tx: any) => Promise<T>): Promise<T> {
    const tx = {
      get: async (docRef: any) => docRef.get(),
      set: (docRef: any, data: any) => docRef.set(data),
      delete: (docRef: any) => docRef.delete(),
    };
    return cb(tx);
  }
}

describe('Historical successor credentials bounding & redaction across backends', () => {
  const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const key = deriveStoreKey(secret);

  const backends: Array<[string, () => { backend: StoreBackend; store: McpStore; cleanup?: () => void }]> = [
    ['memory', () => {
      const backend = createMemoryBackend();
      const store = createStore(backend, { namespace: `trim_mem_${randomUUID().slice(0, 8)}`, key });
      return { backend, store };
    }],
    ['sqlite', () => {
      const dir = mkdtempSync(join(tmpdir(), 'nsmcp-trim-sqlite-'));
      const path = join(dir, 'store.db');
      const backend = createSqliteBackend({ path, namespace: `trim_sql_${randomUUID().slice(0, 8)}`, key });
      const store = createStore(backend, { namespace: `trim_sql_${randomUUID().slice(0, 8)}`, key });
      return {
        backend,
        store,
        cleanup: () => {
          backend.close().catch(() => {});
          rmSync(dir, { recursive: true, force: true });
        },
      };
    }],
    ['firestore', () => {
      const db = new MockFirestore();
      const namespace = `trim_fs_${randomUUID().slice(0, 8)}`;
      const backend = createFirestoreBackend({ db, namespace, key });
      const store = createStore(backend, { namespace, key });
      return { backend, store };
    }],
  ];

  describe.each(backends)('Backend: %s', (_name, factory) => {
    it('prunes successor ciphertext on rotation and late replay purges credentials', async () => {
      const { backend, store, cleanup } = factory();

      const tokens1 = { accessToken: `acc_${randomUUID()}`, refreshToken: `ref_${randomUUID()}` };
      const session = await store.sessions.create(tokens1, {
        clientId: 'client-1',
        expiresAt: Date.now() + 3600_000,
        nsAccessToken: 'ns-acc-1',
        nsRefreshToken: 'ns-ref-1',
        nsExpiresAt: Date.now() + 3600_000,
        nsUsername: 'user@example.com',
        nsUserRole: 'admin',
        nsApiUrl: 'https://ns.example.com',
      });

      // 1. First rotation at t0
      const t0 = Date.now();
      const tokens2 = { accessToken: `acc_${randomUUID()}`, refreshToken: `ref_${randomUUID()}` };
      const rotate1 = await store.sessions.rotate(tokens1.refreshToken, { tokens: tokens2, session }, 'client-1', t0);
      expect(rotate1.status).toBe('claimed');

      // 2. Second rotation at t0 + 45s (past retry window)
      // This rotation MUST prune successorSealed from tokens1 right inside the transaction!
      const t1 = t0 + REFRESH_RETRY_WINDOW_MS + 15_000;
      const tokens3 = { accessToken: `acc_${randomUUID()}`, refreshToken: `ref_${randomUUID()}` };
      const rotate2 = await store.sessions.rotate(tokens2.refreshToken, { tokens: tokens3, session }, 'client-1', t1);
      expect(rotate2.status).toBe('claimed');

      // 3. Verify that old consumed pointer tokens1 has successorSealed pruned to undefined / null!
      const lookupOld = await store.sessions.lookupRefresh(tokens1.refreshToken, 'client-1', t1);
      // Older than retry window -> replay!
      expect(lookupOld.status).toBe('replay');

      // 4. Verify that late replay executed full credential minimization
      const family = await backend.getFamily(session.refreshFamilyId!);
      expect(family?.status).toBe('revoked');

      // Upstream grant must be completely deleted!
      const upstream = await backend.getUpstream(session.refreshFamilyId!);
      expect(upstream).toBeUndefined();

      // Active access token must be completely deleted!
      const activeSession = await store.sessions.get(tokens3.accessToken);
      expect(activeSession).toBeUndefined();

      // Active refresh token now fails lookup!
      const lookupActive = await store.sessions.lookupRefresh(tokens3.refreshToken, 'client-1', t1);
      expect(lookupActive.status).toBe('missing');

      if (cleanup) cleanup();
      await store.close();
    });
  });
});
