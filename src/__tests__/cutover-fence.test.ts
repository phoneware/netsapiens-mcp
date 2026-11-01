import { describe, expect, it } from 'vitest';
import {
  checkCutoverFence,
  engageCutoverFence,
  releaseCutoverFence,
  assertLegacyWritePermitted,
  CutoverFencedError,
  adoptFirestoreLegacyTokens,
} from '../store/firestore-v2-adoption.js';
import { createFirestoreStore, type FirestoreLike } from '../store/firestore.js';
import { deriveStoreKey } from '../store/codec.js';

class MockFirestore implements FirestoreLike {
  public collections = new Map<string, Map<string, Record<string, unknown>>>();

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

describe('Shared Cutover Fence Protocol & Bridge Old-Writer Protection', () => {
  const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const key = deriveStoreKey(secret);

  it('proves shared cutover fence lifecycle: open -> fenced -> migrated -> rollback', async () => {
    const db = new MockFirestore();
    const namespace = 'mcp';

    // 1. Initial State: Fence is not set, defaults to 'open'
    const initialFence = await checkCutoverFence({ db, namespace });
    expect(initialFence.status).toBe('open');

    // 2. Bridge writer can write normally when fence is 'open'
    await expect(assertLegacyWritePermitted({ db, namespace })).resolves.toBeUndefined();

    // Seed a legacy token while fence is open
    await db.collection(`${namespace}_tokens`).doc('seed-tok').set({
      accessToken: 'seed-tok',
      refreshToken: 'seed-ref',
      clientId: 'bridge-client',
      expiresAt: Date.now() + 3600_000,
      nsAccessToken: 'ns-tok',
      nsRefreshToken: 'ns-ref',
      nsUsername: 'user@domain.com',
    });

    // 3. Engage the cutover fence (Phase 2 of cutover protocol)
    const engaged = await engageCutoverFence({ db, namespace });
    expect(engaged.status).toBe('fenced');
    expect(engaged.fencedAt).toBeDefined();

    // 4. Any old 2.x bridge writer is ATOMICALLY FENCED from committing writes to legacy
    await expect(
      assertLegacyWritePermitted({ db, namespace }),
    ).rejects.toThrow(CutoverFencedError);

    // Verify fence inside a transaction
    await expect(
      db.runTransaction(async (tx) => {
        await assertLegacyWritePermitted({ db, namespace, tx });
        await tx.set(db.collection(`${namespace}_tokens`).doc('illegal-late-tok'), { bad: true });
      }),
    ).rejects.toThrow(CutoverFencedError);

    // Assert the illegal write was never committed!
    const illegalSnap = await db.collection(`${namespace}_tokens`).doc('illegal-late-tok').get();
    expect(illegalSnap.exists).toBe(false);

    // 5. Run migration under engaged fence
    const report = await adoptFirestoreLegacyTokens({ db, namespace, key, requireFence: true });
    expect(report.errors).toBe(0);
    expect(report.migrated).toBe(1);

    // Fence status is now 'migrated' and durable marker is written!
    const migratedFence = await checkCutoverFence({ db, namespace });
    expect(migratedFence.status).toBe('migrated');
    expect(migratedFence.migratedAt).toBeDefined();

    const markerSnap = await db.collection(`${namespace}_meta`).doc('v2_adopted').get();
    expect(markerSnap.exists).toBe(true);

    // Legacy writes remain permanently fenced
    await expect(
      assertLegacyWritePermitted({ db, namespace }),
    ).rejects.toThrow(CutoverFencedError);

    // 6. v3 store opens and serves the adopted session with 200 OK
    const store = createFirestoreStore({ db, namespace, key });
    const session = await store.sessions.get('seed-tok');
    expect(session).toBeDefined();
    expect(session?.clientId).toBe('bridge-client');
    expect(session?.nsUsername).toBe('user@domain.com');

    // 7. Rollback scenario verification:
    // If operators needed to abort and roll back, releaseCutoverFence re-opens write permissions
    await releaseCutoverFence({ db, namespace });
    const rolledBackFence = await checkCutoverFence({ db, namespace });
    expect(rolledBackFence.status).toBe('open');
    await expect(assertLegacyWritePermitted({ db, namespace })).resolves.toBeUndefined();
  });

  it('adoptFirestoreLegacyTokens rejects migration if requireFence is true but fence is not engaged', async () => {
    const db = new MockFirestore();
    const namespace = 'mcp';

    // Fence is open (not engaged)
    await expect(
      adoptFirestoreLegacyTokens({ db, namespace, key, requireFence: true }),
    ).rejects.toThrow(/cutover fence is not engaged/);
  });
});
