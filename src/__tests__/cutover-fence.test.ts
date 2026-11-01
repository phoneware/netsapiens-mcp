import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  initializeCutoverFence,
  getCutoverFenceRecord,
  transitionCutoverFenceState,
  withLegacyOperation,
  checkMutationGuardInTransaction,
  markIrreversibleInTransaction,
  CutoverFenceError,
  CutoverRefusedError,
} from '../auth/kit/cutover-fence.js';
import { adoptFirestoreLegacyTokens } from '../store/firestore-v2-adoption.js';
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
        set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
          if (opts?.merge && col.has(id)) {
            col.set(id, { ...col.get(id), ...data });
          } else {
            col.set(id, data);
          }
        },
        delete: async () => {
          col.delete(id);
        },
        collection: (sub: string) => this.collection(`${path}/${id}/${sub}`),
      }),
      get: async () => ({
        empty: col.size === 0,
        docs: Array.from(col.entries()).map(([id, data]) => ({
          id,
          exists: true,
          data: () => data,
          ref: {
            delete: async () => col.delete(id),
            set: async (d: any) => col.set(id, d),
          },
        })),
      }),
      where: (field: string, _op: string, value: any) => ({
        get: async () => {
          const matched = Array.from(col.entries()).filter(([, d]) => {
            if (_op === 'in' && Array.isArray(value)) return value.includes(d[field]);
            return d[field] === value;
          });
          return {
            empty: matched.length === 0,
            docs: matched.map(([id, data]) => ({
              id,
              exists: true,
              data: () => data,
            })),
          };
        },
        limit: (_n: number) => ({
          get: async () => {
            const matched = Array.from(col.entries()).filter(([, d]) => {
              if (_op === 'in' && Array.isArray(value)) return value.includes(d[field]);
              return d[field] === value;
            });
            return {
              empty: matched.length === 0,
              docs: matched.slice(0, 1).map(([id, data]) => ({
                id,
                exists: true,
                data: () => data,
              })),
            };
          },
        }),
      }),
    };
  }

  async runTransaction<T>(cb: (tx: any) => Promise<T>): Promise<T> {
    const tx = {
      get: async (target: any) => target.get(),
      set: (docRef: any, data: any, opts?: any) => docRef.set(data, opts),
      delete: (docRef: any) => docRef.delete(),
    };
    return cb(tx);
  }
}

describe('Canonical Cutover Fence Protocol & State Machine (C1, C2, C7, C8)', () => {
  const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const key = deriveStoreKey(secret);

  it('executes full C1/C2/C7 state machine: legacy_open -> closing -> fenced -> migrating -> v3_ready', async () => {
    const db = new MockFirestore();
    const namespace = 'mcp';

    // 1. Initialize control record
    const init = await initializeCutoverFence(db, namespace, { initialEpoch: 1 });
    expect(init.state).toBe('legacy_open');
    expect(init.epoch).toBe(1);
    expect(init.activeOperations).toBe(0);
    expect(init.irreversible).toBe(false);

    // Seed a legacy token in legacy_open
    await db.collection(`${namespace}_tokens`).doc('test-legacy-tok').set({
      accessToken: 'test-legacy-tok',
      refreshToken: 'test-legacy-ref',
      clientId: 'client-leg',
      expiresAt: Date.now() + 3600_000,
      nsAccessToken: 'ns-tok',
      nsRefreshToken: 'ns-ref',
      nsUsername: 'user@domain.com',
    });

    // 2. withLegacyOperation admits operation during legacy_open
    let executedOp = false;
    await withLegacyOperation({ db, namespace, kind: 'token_exchange' }, async (ctx) => {
      expect(ctx.epoch).toBe(1);
      executedOp = true;

      // Inside transaction, checkMutationGuardInTransaction permits mutation
      await db.runTransaction(async (tx) => {
        const guard = await checkMutationGuardInTransaction(tx, { db, namespace, operation: ctx });
        expect(guard.control.state).toBe('legacy_open');
        guard.bufferCompletion();
      });
    });
    expect(executedOp).toBe(true);

    const afterOp = await getCutoverFenceRecord(db, namespace);
    expect(afterOp?.activeOperations).toBe(0);

    // 3. Transition to 'closing': new operations rejected
    await transitionCutoverFenceState(db, namespace, {
      fromState: 'legacy_open',
      toState: 'closing',
      expectedEpoch: 1,
    });

    await expect(
      withLegacyOperation({ db, namespace, kind: 'new_op' }, async () => {}),
    ).rejects.toThrow(CutoverRefusedError);

    // 4. Transition to 'fenced': requires activeOperations === 0
    await transitionCutoverFenceState(db, namespace, {
      fromState: 'closing',
      toState: 'fenced',
      expectedEpoch: 1,
    });

    // In 'fenced': mutations refused
    await expect(
      db.runTransaction(async (tx) => {
        await checkMutationGuardInTransaction(tx, { db, namespace });
      }),
    ).rejects.toThrow(CutoverRefusedError);

    // 5. Run migration under fenced state
    const report = await adoptFirestoreLegacyTokens({ db, namespace, key, expectedEpoch: 1 });
    expect(report.errors).toBe(0);
    expect(report.migrated).toBe(1);

    // 6. Verify state is now v3_ready and irreversible is true
    const finalRecord = await getCutoverFenceRecord(db, namespace);
    expect(finalRecord?.state).toBe('v3_ready');
    expect(finalRecord?.irreversible).toBe(true);
    expect(finalRecord?.migrationManifestDigest).toBeDefined();

    // 7. Irreversibility latch: Attempting to return to legacy_open throws CutoverFenceError
    await expect(
      transitionCutoverFenceState(db, namespace, {
        fromState: 'v3_ready',
        toState: 'legacy_open',
        expectedEpoch: 1,
      }),
    ).rejects.toThrow(/irreversible migration latch is engaged/);

    // 8. Verify v3 store can open and read the migrated session with 200 OK
    const store = createFirestoreStore({ db, namespace, key });
    const session = await store.sessions.get('test-legacy-tok');
    expect(session).toBeDefined();
    expect(session?.clientId).toBe('client-leg');
    expect(session?.nsUsername).toBe('user@domain.com');
  });

  it('rejects state transition when epoch mismatches or invalid state transition attempted', async () => {
    const db = new MockFirestore();
    const namespace = 'mcp';

    await initializeCutoverFence(db, namespace, { initialEpoch: 5 });

    // Wrong expectedEpoch throws
    await expect(
      transitionCutoverFenceState(db, namespace, {
        fromState: 'legacy_open',
        toState: 'closing',
        expectedEpoch: 4, // mismatch!
      }),
    ).rejects.toThrow(/Epoch mismatch/);

    // Skipping states (legacy_open -> fenced directly without closing) throws
    await expect(
      transitionCutoverFenceState(db, namespace, {
        fromState: 'closing', // currently legacy_open!
        toState: 'fenced',
        expectedEpoch: 5,
      }),
    ).rejects.toThrow(/Invalid state transition/);
  });

  it('adoptFirestoreLegacyTokens dryRun: true accurately reports migrated counts without writing v3 documents or marker', async () => {
    const db = new MockFirestore();
    const namespace = 'mcp';

    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'fenced' });

    const familyId = 'dry-fam-1';
    await db.collection(`${namespace}_tokens_refresh_families`).doc(familyId).set({
      id: familyId,
      currentAccessToken: 'dry-acc',
      currentRefreshToken: 'dry-ref',
      retiredRefreshFingerprints: [],
      updatedAt: Date.now(),
    });
    await db.collection(`${namespace}_tokens_refresh`).doc('dry-ref').set({
      accessToken: 'dry-acc',
      familyId,
      status: 'active',
      token: {
        accessToken: 'dry-acc',
        refreshToken: 'dry-ref',
        clientId: 'dry-client',
        expiresAt: Date.now() + 3600_000,
        serverBaseUrl: 'http://localhost:3000',
        nsAccessToken: 'ns-dry-tok',
        nsRefreshToken: 'ns-dry-ref',
        nsUsername: 'dry@domain.com',
      },
    });
    await db.collection(`${namespace}_tokens_upstream`).doc(familyId).set({
      grant: { access_token: 'ns-dry-tok', refresh_token: 'ns-dry-ref', username: 'dry@domain.com' },
      expiresAt: Date.now() + 3600_000,
      updatedAt: Date.now(),
    });
    await db.collection(`${namespace}_tokens`).doc('dry-acc').set({
      accessToken: 'dry-acc',
      refreshToken: 'dry-ref',
      refreshFamilyId: familyId,
      clientId: 'dry-client',
    });

    const report = await adoptFirestoreLegacyTokens({ db, namespace, key, dryRun: true, expectedEpoch: 1 });
    expect(report.errors).toBe(0);
    expect(report.migrated).toBe(1);

    // Assert that NO v3 documents or v2_adopted marker were written during dryRun
    const v3Families = await db.collection(`${namespace}_refresh_families`).get();
    expect(v3Families.empty).toBe(true);

    const markerSnap = await db.collection(`${namespace}_meta`).doc('v2_adopted').get();
    expect(markerSnap.exists).toBe(false);
  });
});
