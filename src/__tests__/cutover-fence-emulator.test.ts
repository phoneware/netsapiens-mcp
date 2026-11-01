import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { Firestore } from '@google-cloud/firestore';
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
import { createFirestoreStore, createFirestoreBackend } from '../store/firestore.js';
import { deriveStoreKey } from '../store/codec.js';

const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:18080';
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'nsmcp-cutover-real-emulator';

describe('Real Firestore Emulator Cutover Fence & Adoption Proof (Supported Namespace "mcp")', () => {
  let db: Firestore;
  const namespace = 'mcp'; // strictly supported namespace
  const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const key = deriveStoreKey(secret);

  const clearEmulator = async () => {
    try {
      const url = `http://${EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
      await fetch(url, { method: 'DELETE' });
    } catch {
      // Ignored if emulator endpoint reset is unavailable
    }
  };

  beforeAll(async () => {
    process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;
    process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;
    db = new Firestore({ projectId: PROJECT_ID });
    await clearEmulator();
  });

  beforeEach(async () => {
    await clearEmulator();
  });

  it('real emulator: executes full lifecycle legacy_open -> closing -> fenced -> migrating -> v3_ready -> v3_active', async () => {
    // 1. Initialize control in real Firestore
    const init = await initializeCutoverFence(db, namespace, { initialEpoch: 1 });
    expect(init.state).toBe('legacy_open');
    expect(init.epoch).toBe(1);

    // Seed legacy family in real Firestore
    const now = Date.now();
    await db.collection(`${namespace}_tokens_refresh_families`).doc('fam-real-1').set({
      currentRefreshToken: 'ref-real-1',
      currentAccessToken: 'acc-real-1',
      clientId: 'client-real',
      scope: 'read',
      createdAt: now,
      updatedAt: now,
    });
    await db.collection(`${namespace}_tokens_refresh`).doc('ref-real-1').set({
      familyId: 'fam-real-1',
      status: 'active',
      createdAt: now,
    });
    await db.collection(`${namespace}_tokens_upstream`).doc('fam-real-1').set({
      nsAccessToken: 'ns-tok-real',
      nsRefreshToken: 'ns-ref-real',
      nsUsername: 'user@domain.com',
      updatedAt: now,
    });
    await db.collection(`${namespace}_tokens`).doc('acc-real-1').set({
      familyId: 'fam-real-1',
      accessToken: 'acc-real-1',
      clientId: 'client-real',
      expiresAt: now + 3600_000,
    });

    // 2. withLegacyOperation admits operation during legacy_open in real Firestore
    let executedOp = false;
    await withLegacyOperation({ db, namespace, kind: 'token_exchange' }, async (ctx) => {
      expect(ctx.epoch).toBe(1);
      executedOp = true;
      await db.runTransaction(async (tx) => {
        const guard = await checkMutationGuardInTransaction(tx, { db, namespace, operation: ctx });
        expect(guard.control.state).toBe('legacy_open');
        guard.bufferCompletion();
      });
    });
    expect(executedOp).toBe(true);

    // 3. Transition to closing: new admissions refused
    await transitionCutoverFenceState(db, namespace, {
      fromState: 'legacy_open',
      toState: 'closing',
      expectedEpoch: 1,
    });

    await expect(
      withLegacyOperation({ db, namespace, kind: 'op_after_closing' }, async () => {}),
    ).rejects.toThrow(CutoverRefusedError);

    // 4. Transition to fenced
    await transitionCutoverFenceState(db, namespace, {
      fromState: 'closing',
      toState: 'fenced',
      expectedEpoch: 1,
    });

    // 5. Run migration under fenced state
    const report = await adoptFirestoreLegacyTokens({ db, namespace, key, expectedEpoch: 1 });
    expect(report.errors).toBe(0);
    expect(report.migrated).toBe(1);

    // Verify state transitioned to v3_ready and irreversible latch is engaged
    const controlRecord = await getCutoverFenceRecord(db, namespace);
    expect(controlRecord?.state).toBe('v3_ready');
    expect(controlRecord?.irreversible).toBe(true);
    expect(controlRecord?.migrationManifestDigest).toBeDefined();

    // Verify ordinary writes refused in v3_ready
    const backend = createFirestoreBackend({ db, namespace, key });
    await expect(
      backend.putAccess({
        id: 'real-writer-test',
        familyId: 'fam-real-1',
        expiresAt: now + 3600_000,
        retainUntil: now + 7200_000,
        sealed: 'sealed-data',
      }),
    ).rejects.toThrow(CutoverRefusedError);

    // 6. Transition to v3_active
    await transitionCutoverFenceState(db, namespace, {
      fromState: 'v3_ready',
      toState: 'v3_active',
      expectedEpoch: 1,
      migrationRunId: controlRecord!.migrationRunId!,
      migrationManifestDigest: controlRecord!.migrationManifestDigest!,
    });

    // In v3_active: ordinary writes and reads succeed in real Firestore!
    await backend.putAccess({
      id: 'real-writer-test',
      familyId: 'fam-real-1',
      expiresAt: now + 3600_000,
      retainUntil: now + 7200_000,
      sealed: 'sealed-data',
    });

    const store = createFirestoreStore({ db, namespace, key });
    const session = await store.sessions.get('acc-real-1');
    expect(session).toBeDefined();
    expect(session?.clientId).toBe('client-real');
    expect(session?.nsUsername).toBe('user@domain.com');

    const directAccess = await backend.getAccess('real-writer-test');
    expect(directAccess).toBeDefined();
    expect(directAccess?.id).toBe('real-writer-test');
  });

  it('real emulator: dryRun does zero writes and does not transition control state', async () => {
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'fenced' });

    const now = Date.now();
    await db.collection(`${namespace}_tokens_refresh_families`).doc('dry-fam').set({
      currentRefreshToken: 'dry-ref',
      currentAccessToken: 'dry-acc',
      clientId: 'c-dry',
      createdAt: now,
      updatedAt: now,
    });
    await db.collection(`${namespace}_tokens_refresh`).doc('dry-ref').set({
      familyId: 'dry-fam',
      status: 'active',
      createdAt: now,
    });
    await db.collection(`${namespace}_tokens_upstream`).doc('dry-fam').set({
      nsAccessToken: 'ns-dry',
      nsRefreshToken: 'ns-dry-r',
      nsUsername: 'dry@domain.com',
      updatedAt: now,
    });
    await db.collection(`${namespace}_tokens`).doc('dry-acc').set({
      familyId: 'dry-fam',
      accessToken: 'dry-acc',
      clientId: 'c-dry',
      expiresAt: now + 3600_000,
    });

    const report = await adoptFirestoreLegacyTokens({ db, namespace, key, dryRun: true, expectedEpoch: 1 });
    expect(report.errors).toBe(0);
    expect(report.migrated).toBe(1);

    // Verify zero writes occurred in real Firestore
    const v3Families = await db.collection(`${namespace}_refresh_families`).get();
    expect(v3Families.empty).toBe(true);

    const marker = await db.collection(`${namespace}_meta`).doc('v2_adopted').get();
    expect(marker.exists).toBe(false);

    const ctrl = await getCutoverFenceRecord(db, namespace);
    expect(ctrl?.state).toBe('fenced');
    expect(ctrl?.irreversible).toBe(false);
  });

  it('real emulator: orphan detection across real collections', async () => {
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'fenced' });

    // Seed orphan refresh
    await db.collection(`${namespace}_tokens_refresh`).doc('orphan-ref-real').set({
      familyId: 'ghost-family',
      status: 'active',
    });

    // Seed orphan upstream
    await db.collection(`${namespace}_tokens_upstream`).doc('ghost-family-2').set({
      nsAccessToken: 'ns-tok',
      nsRefreshToken: 'ns-ref',
    });

    const report = await adoptFirestoreLegacyTokens({ db, namespace, key, expectedEpoch: 1 });
    expect(report.errors).toBe(2);
  });
});
