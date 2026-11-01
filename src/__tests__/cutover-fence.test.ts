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
import { adoptFirestoreLegacyTokens, ensureFirestoreAdopted } from '../store/firestore-v2-adoption.js';
import { createFirestoreStore, createFirestoreBackend, type FirestoreLike } from '../store/firestore.js';
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
  const defaultAdoptOpts = (opts: Record<string, unknown> = {}) => ({
    expectedEpoch: 1,
    migrationRunId: 'test-run-1',
    codeSha: '3edf8a262e9d06f4849318b1e0d09f197738bff9',
    codeArtifact: 'us-docker.pkg.dev/project/image@sha256:' + 'a'.repeat(64),
    packageIntegrity: 'sha512-test',
    ...opts,
  });

  it('executes full C1/C2/C7 state machine: legacy_open -> closing -> fenced -> migrating -> v3_ready', async () => {
    const db = new MockFirestore();
    const namespace = 'mcp';

    // 1. Initialize control record
    const init = await initializeCutoverFence(db, namespace, { initialEpoch: 1 });
    expect(init.state).toBe('legacy_open');
    expect(init.epoch).toBe(1);
    expect(init.activeOperations).toBe(0);
    expect(init.irreversible).toBe(false);

    // Seed a valid legacy token family in legacy_open
    const now = Date.now();
    await db.collection(`${namespace}_tokens_refresh_families`).doc('fam-1').set({
      currentRefreshToken: 'ref-1',
      currentAccessToken: 'tok-1',
      clientId: 'client-leg',
      scope: 'read',
      createdAt: now,
      updatedAt: now,
    });
    await db.collection(`${namespace}_tokens_refresh`).doc('ref-1').set({
      familyId: 'fam-1',
      status: 'active',
      createdAt: now,
    });
    await db.collection(`${namespace}_tokens_upstream`).doc('fam-1').set({
      nsAccessToken: 'ns-tok',
      nsRefreshToken: 'ns-ref',
      nsUsername: 'user@domain.com',
      updatedAt: now,
    });
    await db.collection(`${namespace}_tokens`).doc('tok-1').set({
      familyId: 'fam-1',
      accessToken: 'tok-1',
      clientId: 'client-leg',
      expiresAt: now + 3600_000,
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
    const report = await adoptFirestoreLegacyTokens({ db, namespace, key, ...defaultAdoptOpts({ expectedEpoch: 1 }) });
    expect(report.errors).toBe(0);
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
    ).rejects.toThrow(/cannot transition from v3_ready to legacy_open/);

    // 8. Transition to v3_active
    await transitionCutoverFenceState(db, namespace, {
      fromState: 'v3_ready',
      toState: 'v3_active',
      expectedEpoch: 1,
      migrationRunId: finalRecord!.migrationRunId!,
      migrationManifestDigest: finalRecord!.migrationManifestDigest!,
    });

    // 9. Verify v3 store can open and read the migrated session with 200 OK
    const store = createFirestoreStore({ db, namespace, key });
    const session = await store.sessions.get('tok-1');
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
    // Assert that control record remained strictly in 'fenced' state with irreversible: false
    const ctrlAfterDryRun = await getCutoverFenceRecord(db, namespace);
    expect(ctrlAfterDryRun?.state).toBe('fenced');
    expect(ctrlAfterDryRun?.epoch).toBe(1);
    expect(ctrlAfterDryRun?.irreversible).toBe(false);
    expect(ctrlAfterDryRun?.migrationRunId).toBeUndefined();
  });

  it('orphan family-linked token with missing legacy family reports error rather than silent omission', async () => {
    const db = new MockFirestore();
    const namespace = 'mcp';

    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'fenced' });

    // Seed an orphan access doc pointing to nonexistent family
    await db.collection(`${namespace}_tokens`).doc('orphan-access-tok').set({
      accessToken: 'orphan-access-tok',
      refreshToken: 'orphan-ref-tok',
      refreshFamilyId: 'nonexistent-fam-123',
      clientId: 'client-orphan',
    });

    const report = await adoptFirestoreLegacyTokens({ db, namespace, key, ...defaultAdoptOpts({ expectedEpoch: 1 }) });
    // Must report error, NOT silent skip!
    expect(report.errors).toBe(1);
  });

  it('partial target family in v3 causes migration conflict error', async () => {
    const db = new MockFirestore();
    const namespace = 'mcp';
    const familyId = 'fam-partial-conflict';

    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'fenced' });

    // Seed legacy family
    await db.collection(`${namespace}_tokens_refresh_families`).doc(familyId).set({
      id: familyId,
      currentAccessToken: 'partial-acc',
      currentRefreshToken: 'partial-ref',
      retiredRefreshFingerprints: [],
      updatedAt: Date.now(),
    });
    await db.collection(`${namespace}_tokens_refresh`).doc('partial-ref').set({
      accessToken: 'partial-acc',
      familyId,
      status: 'active',
      token: {
        accessToken: 'partial-acc',
        refreshToken: 'partial-ref',
        clientId: 'client-partial',
        expiresAt: Date.now() + 3600_000,
        nsAccessToken: 'ns-tok',
        nsRefreshToken: 'ns-ref',
        nsUsername: 'user@domain.com',
      },
    });
    await db.collection(`${namespace}_tokens_upstream`).doc(familyId).set({
      grant: { access_token: 'ns-tok', refresh_token: 'ns-ref', username: 'user@domain.com' },
      expiresAt: Date.now() + 3600_000,
      updatedAt: Date.now(),
    });

    // Seed partial target: ONLY refresh_families in v3, leaving sessions and upstream missing!
    await db.collection(`${namespace}_refresh_families`).doc(familyId).set({
      id: familyId,
      generation: 1,
      status: 'active',
    });

    const report = await adoptFirestoreLegacyTokens({ db, namespace, key, ...defaultAdoptOpts({ expectedEpoch: 1 }) });
    expect(report.errors).toBe(1);
  });

  it('missing access or refresh token identifier rejects with error rather than inventing random IDs', async () => {
    const db = new MockFirestore();
    const namespace = 'mcp';
    const familyId = 'fam-missing-ids';

    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'fenced' });

    // Seed legacy family missing currentAccessToken AND currentRefreshToken
    await db.collection(`${namespace}_tokens_refresh_families`).doc(familyId).set({
      id: familyId,
      retiredRefreshFingerprints: [],
      updatedAt: Date.now(),
    });
    await db.collection(`${namespace}_tokens_upstream`).doc(familyId).set({
      grant: { access_token: 'ns-tok', refresh_token: 'ns-ref', username: 'user@domain.com' },
      expiresAt: Date.now() + 3600_000,
      updatedAt: Date.now(),
    });

    const report = await adoptFirestoreLegacyTokens({ db, namespace, key, ...defaultAdoptOpts({ expectedEpoch: 1 }) });
    expect(report.errors).toBe(1);
  });

  it('fails closed when missing control record in controlled namespace', async () => {
    const db = new MockFirestore();
    const namespace = 'mcp';
    // No control record initialized!
    await expect(
      adoptFirestoreLegacyTokens({ db, namespace, key }),
    ).rejects.toThrow(CutoverFenceError);
  });

  it('classifies orphan refresh pointers and orphan upstream grants as errors', async () => {
    const db = new MockFirestore();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'fenced' });

    // Seed orphan refresh pointer (no family)
    await db.collection(`${namespace}_tokens_refresh`).doc('orphan-ref').set({
      familyId: 'nonexistent-fam',
      status: 'active',
    });

    // Seed orphan upstream grant (no family)
    await db.collection(`${namespace}_tokens_upstream`).doc('orphan-upstream-fam').set({
      nsAccessToken: 'ns-tok',
      nsRefreshToken: 'ns-ref',
    });

    const report = await adoptFirestoreLegacyTokens({ db, namespace, key, ...defaultAdoptOpts({ expectedEpoch: 1 }) });
    expect(report.errors).toBe(2);
  });

  it('rejects conflicting claims when two families claim the same access or refresh token', async () => {
    const db = new MockFirestore();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'fenced' });

    const now = Date.now();
    // Family 1
    await db.collection(`${namespace}_tokens_refresh_families`).doc('fam-1').set({
      currentRefreshToken: 'shared-ref',
      currentAccessToken: 'acc-1',
      clientId: 'c1',
      createdAt: now,
      updatedAt: now,
    });
    await db.collection(`${namespace}_tokens_refresh`).doc('shared-ref').set({
      familyId: 'fam-1',
      status: 'active',
      createdAt: now,
    });
    await db.collection(`${namespace}_tokens_upstream`).doc('fam-1').set({
      nsAccessToken: 'ns-tok-1',
      nsRefreshToken: 'ns-ref-1',
      nsUsername: 'u1@domain.com',
      updatedAt: now,
    });
    await db.collection(`${namespace}_tokens`).doc('acc-1').set({
      familyId: 'fam-1',
      accessToken: 'acc-1',
      clientId: 'c1',
      expiresAt: now + 3600_000,
    });

    // Family 2 claims the SAME refresh token shared-ref!
    await db.collection(`${namespace}_tokens_refresh_families`).doc('fam-2').set({
      currentRefreshToken: 'shared-ref',
      currentAccessToken: 'acc-2',
      clientId: 'c2',
      createdAt: now,
      updatedAt: now,
    });
    await db.collection(`${namespace}_tokens_upstream`).doc('fam-2').set({
      nsAccessToken: 'ns-tok-2',
      nsRefreshToken: 'ns-ref-2',
      nsUsername: 'u2@domain.com',
      updatedAt: now,
    });
    await db.collection(`${namespace}_tokens`).doc('acc-2').set({
      familyId: 'fam-2',
      accessToken: 'acc-2',
      clientId: 'c2',
      expiresAt: now + 3600_000,
    });

    const report = await adoptFirestoreLegacyTokens({ db, namespace, key, ...defaultAdoptOpts({ expectedEpoch: 1 }) });
    expect(report.errors).toBeGreaterThanOrEqual(1);
  });

  it('classifies family-linked access token as orphan if it does not match currentAccessToken', async () => {
    const db = new MockFirestore();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'fenced' });

    const now = Date.now();
    await db.collection(`${namespace}_tokens_refresh_families`).doc('fam-1').set({
      currentRefreshToken: 'ref-1',
      currentAccessToken: 'acc-legit',
      clientId: 'c1',
      createdAt: now,
      updatedAt: now,
    });
    await db.collection(`${namespace}_tokens_refresh`).doc('ref-1').set({
      familyId: 'fam-1',
      status: 'active',
      createdAt: now,
    });
    await db.collection(`${namespace}_tokens_upstream`).doc('fam-1').set({
      nsAccessToken: 'ns-tok-1',
      nsRefreshToken: 'ns-ref-1',
      nsUsername: 'u1@domain.com',
      updatedAt: now,
    });
    await db.collection(`${namespace}_tokens`).doc('acc-legit').set({
      familyId: 'fam-1',
      accessToken: 'acc-legit',
      clientId: 'c1',
      expiresAt: now + 3600_000,
    });

    // An extraneous token claiming refreshFamilyId: 'fam-1' but fam-1.currentAccessToken is acc-legit!
    await db.collection(`${namespace}_tokens`).doc('acc-stray').set({
      refreshFamilyId: 'fam-1',
      accessToken: 'acc-stray',
      clientId: 'c1',
      expiresAt: now + 3600_000,
    });

    const report = await adoptFirestoreLegacyTokens({ db, namespace, key, ...defaultAdoptOpts({ expectedEpoch: 1 }) });
    expect(report.errors).toBe(1);
  });

  it('ordinary writers are refused when fence is in v3_ready and allowed only in v3_active', async () => {
    const db = new MockFirestore();
    const namespace = 'mcp';

    // Initialize fence in v3_ready (not yet active)
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });
    await transitionCutoverFenceState(db, namespace, { fromState: 'legacy_open', toState: 'closing', expectedEpoch: 1 });
    await transitionCutoverFenceState(db, namespace, { fromState: 'closing', toState: 'fenced', expectedEpoch: 1 });
    await transitionCutoverFenceState(db, namespace, { fromState: 'fenced', toState: 'migrating', expectedEpoch: 1, migrationRunId: 'run-1' });
    await db.runTransaction(async (tx) => {
      await markIrreversibleInTransaction(tx, db, namespace, 1, 'run-1');
    });
    await transitionCutoverFenceState(db, namespace, {
      fromState: 'migrating',
      toState: 'v3_ready',
      expectedEpoch: 1,
      migrationRunId: 'run-1',
      migrationManifestDigest: 'digest-1',
    });

    const backend = createFirestoreBackend({ db, namespace, key });
    // In v3_ready, ordinary write mutations MUST BE REFUSED!
    await expect(
      backend.putAccess({
        id: 'tok-write',
        familyId: 'fam-1',
        expiresAt: Date.now() + 3600_000,
        retainUntil: Date.now() + 7200_000,
        sealed: 'sealed-data',
      }),
    ).rejects.toThrow(CutoverRefusedError);

    // Now activate to v3_active
    await transitionCutoverFenceState(db, namespace, {
      fromState: 'v3_ready',
      toState: 'v3_active',
      expectedEpoch: 1,
      migrationRunId: 'run-1',
      migrationManifestDigest: 'digest-1',
    });

    // Now ordinary write mutation MUST SUCCEED!
    await backend.putAccess({
      id: 'tok-write',
      familyId: 'fam-1',
      expiresAt: Date.now() + 3600_000,
      retainUntil: Date.now() + 7200_000,
      sealed: 'sealed-data',
    });

    const written = await backend.getAccess('tok-write');
    expect(written).toBeDefined();
    expect(written?.id).toBe('tok-write');
  });

  it('ensureFirestoreAdopted refuses request-triggered migration on read paths when legacy credentials exist', async () => {
    const db = new MockFirestore();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    // Seed legacy token
    await db.collection(`${namespace}_tokens`).doc('unmigrated-tok').set({
      accessToken: 'unmigrated-tok',
      refreshToken: 'unmigrated-ref',
    });

    // Calling ensureFirestoreAdopted on normal read path MUST REFUSE, NOT auto-migrate!
    await expect(
      ensureFirestoreAdopted({ db, namespace, key }),
    ).rejects.toThrow(CutoverRefusedError);
  });
});
