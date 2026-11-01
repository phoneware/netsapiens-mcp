import { describe, expect, it } from 'vitest';
import { ensureFirestoreAdopted, type FirestoreAdoptionReport } from '../store/firestore-v2-adoption.js';
import type { FirestoreLike } from '../store/firestore.js';
import { deriveStoreKey } from '../store/codec.js';

class FailingMockFirestore implements FirestoreLike {
  public metaStore = new Map<string, Record<string, unknown>>();

  collection(path: string): any {
    if (path.endsWith('_meta')) {
      return {
        doc: (id: string) => ({
          id,
          get: async () => ({
            id,
            exists: this.metaStore.has(id),
            data: () => this.metaStore.get(id),
          }),
          set: async (data: Record<string, unknown>) => {
            this.metaStore.set(id, data);
          },
        }),
      };
    }

    // Legacy collections fail with simulated Firestore network/read error
    return {
      get: async () => {
        throw new Error('Firestore connection lost during preflight');
      },
    };
  }

  async runTransaction<T>(cb: (tx: any) => Promise<T>): Promise<T> {
    return cb({} as any);
  }
}

describe('Firestore Adoption Preflight Fail-Closed Guard', () => {
  const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const key = deriveStoreKey(secret);

  it('fails closed and writes NO marker when legacy collection reads fail', async () => {
    const db = new FailingMockFirestore();
    const namespace = 'mcp';

    await expect(
      ensureFirestoreAdopted({ db, namespace, key }),
    ).rejects.toThrow('Firestore connection lost during preflight');

    // Crucial check: verify that NO marker was written to meta collection!
    expect(db.metaStore.has('v2_adopted')).toBe(false);
  });
});
