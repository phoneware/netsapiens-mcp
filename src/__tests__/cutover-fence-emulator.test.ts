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
import { deriveStoreKey, createCodec } from '../store/codec.js';

const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:18080';
const PROJECT_ID = 'nsmcp-cutover-fence-isolated';

describe('Real Firestore Emulator Cutover Fence & Adoption Proof (Supported Namespace "mcp")', () => {
  let db: Firestore;
  const namespace = 'mcp'; // strictly supported namespace
  const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const key = deriveStoreKey(secret);
  const codec = createCodec(key);
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

  it('real emulator: valid v2.3 base pointer with { accessToken } and no familyId adopts cleanly', async () => {
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'fenced' });

    const now = Date.now();
    // Seed v2.3 base token
    await db.collection(`${namespace}_tokens`).doc('base-acc-v23').set({
      accessToken: 'base-acc-v23',
      refreshToken: 'base-ref-v23',
      clientId: 'client-v23',
      nsAccessToken: 'ns-tok-v23',
      nsRefreshToken: 'ns-ref-v23',
      nsUsername: 'user@v23.com',
      expiresAt: now + 3600_000,
    });

    // Seed v2.3 refresh pointer with accessToken but NO familyId
    await db.collection(`${namespace}_tokens_refresh`).doc('base-ref-v23').set({
      accessToken: 'base-acc-v23',
      status: 'active',
      createdAt: now,
    });

    const report = await adoptFirestoreLegacyTokens({ db, namespace, key, expectedEpoch: 1 });
    expect(report.errors).toBe(0);
    expect(report.migrated).toBe(1);
  });

  it('real emulator: PR56 retiredRefreshFingerprints conflicting across families causes error', async () => {
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'fenced' });

    const now = Date.now();
    const sharedFingerprint = 'shared-retired-sha256-fingerprint';

    // Family 1
    await db.collection(`${namespace}_tokens_refresh_families`).doc('fam-ret-1').set({
      currentRefreshToken: 'ref-ret-1',
      currentAccessToken: 'acc-ret-1',
      clientId: 'c1',
      retiredRefreshFingerprints: [sharedFingerprint],
      createdAt: now,
      updatedAt: now,
    });
    await db.collection(`${namespace}_tokens_refresh`).doc('ref-ret-1').set({
      familyId: 'fam-ret-1',
      status: 'active',
      createdAt: now,
    });
    await db.collection(`${namespace}_tokens_upstream`).doc('fam-ret-1').set({
      nsAccessToken: 'ns-tok-1',
      nsRefreshToken: 'ns-ref-1',
      nsUsername: 'u1@domain.com',
      updatedAt: now,
    });
    await db.collection(`${namespace}_tokens`).doc('acc-ret-1').set({
      familyId: 'fam-ret-1',
      accessToken: 'acc-ret-1',
      clientId: 'c1',
      expiresAt: now + 3600_000,
    });

    // Family 2 claims the SAME retired fingerprint!
    await db.collection(`${namespace}_tokens_refresh_families`).doc('fam-ret-2').set({
      currentRefreshToken: 'ref-ret-2',
      currentAccessToken: 'acc-ret-2',
      clientId: 'c2',
      retiredRefreshFingerprints: [sharedFingerprint],
      createdAt: now,
      updatedAt: now,
    });
    await db.collection(`${namespace}_tokens_refresh`).doc('ref-ret-2').set({
      familyId: 'fam-ret-2',
      status: 'active',
      createdAt: now,
    });
    await db.collection(`${namespace}_tokens_upstream`).doc('fam-ret-2').set({
      nsAccessToken: 'ns-tok-2',
      nsRefreshToken: 'ns-ref-2',
      nsUsername: 'u2@domain.com',
      updatedAt: now,
    });
    await db.collection(`${namespace}_tokens`).doc('acc-ret-2').set({
      familyId: 'fam-ret-2',
      accessToken: 'acc-ret-2',
      clientId: 'c2',
      expiresAt: now + 3600_000,
    });

    const report = await adoptFirestoreLegacyTokens({ db, namespace, key, expectedEpoch: 1 });
    expect(report.errors).toBeGreaterThanOrEqual(1);
  });

  it('real emulator: unexpired auth code with nested pending migrates cleanly and exchanges atomically', async () => {
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'fenced' });

    const now = Date.now();
    const rawCode = 'auth-code-real-123';

    // Seed v2.4 auth code with nested pending and full nsTokens
    await db.collection(`${namespace}_auth_codes`).doc(rawCode).set({
      pending: {
        clientId: 'client-auth-test',
        codeChallenge: 'challenge-xyz',
        redirectUri: 'https://app.example.com/callback',
        state: 'oauth-state-1',
        scopes: ['user', 'admin'],
        createdAt: now,
      },
      nsTokens: {
        access_token: 'ns-auth-tok',
        refresh_token: 'ns-auth-ref',
        expires_in: 3600,
        username: 'authuser@domain.com',
      },
      clientId: 'client-auth-test',
      serverBaseUrl: 'http://localhost:3000',
      expiresAt: now + 600_000, // unexpired
    });

    const report = await adoptFirestoreLegacyTokens({ db, namespace, key, expectedEpoch: 1 });
    expect(report.errors).toBe(0);
    expect(report.migrated).toBe(1);

    // Transition to v3_active to permit redemption and issuance
    const ctrl = await getCutoverFenceRecord(db, namespace);
    await transitionCutoverFenceState(db, namespace, {
      fromState: 'v3_ready',
      toState: 'v3_active',
      expectedEpoch: 1,
      migrationRunId: ctrl!.migrationRunId!,
      migrationManifestDigest: ctrl!.migrationManifestDigest!,
    });

    // Verify code can be redeemed and issued atomically
    const store = createFirestoreStore({ db, namespace, key });
    const preview = await store.authCodes.getEntry(rawCode, {
      serverBaseUrl: 'http://localhost:3000',
      clientId: 'client-auth-test',
    });
    expect(preview).toBeDefined();
    expect(preview?.pending.codeChallenge).toBe('challenge-xyz');

    const tokens = { accessToken: 'issued-acc-1', refreshToken: 'issued-ref-1' };
    const storedToken = {
      clientId: 'client-auth-test',
      expiresAt: now + 3600_000,
      nsAccessToken: 'ns-auth-tok',
      nsRefreshToken: 'ns-auth-ref',
      nsUsername: 'authuser@domain.com',
      serverBaseUrl: 'http://localhost:3000',
    };

    const redeemed = await store.authCodes.redeemAndIssue(
      rawCode,
      { serverBaseUrl: 'http://localhost:3000', clientId: 'client-auth-test' },
      tokens,
      storedToken,
    );
    expect(redeemed).toBeDefined();

    // Code is now consumed (deleted)
    const reRedeem = await store.authCodes.redeem(rawCode, {
      serverBaseUrl: 'http://localhost:3000',
      clientId: 'client-auth-test',
    });
    expect(reRedeem).toBeUndefined();

    // Session is now active
    const session = await store.sessions.get('issued-acc-1');
    expect(session).toBeDefined();
    expect(session?.clientId).toBe('client-auth-test');
    expect(session?.nsUsername).toBe('authuser@domain.com');
  });

  it('real emulator: concurrent second migrator with wrong runId or wrong epoch is rejected', async () => {
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'fenced' });

    // Migrator 1 starts migration with runId "run-owner-1"
    await transitionCutoverFenceState(db, namespace, {
      fromState: 'fenced',
      toState: 'migrating',
      expectedEpoch: 1,
      migrationRunId: 'run-owner-1',
    });

    // Migrator 2 attempts to resume or join with wrong runId "intruder-run-2"
    await expect(
      adoptFirestoreLegacyTokens({
        db,
        namespace,
        key,
        expectedEpoch: 1,
        migrationRunId: 'intruder-run-2',
      }),
    ).rejects.toThrow(CutoverFenceError);

    // Migrator 2 attempts with wrong epoch 2
    await expect(
      adoptFirestoreLegacyTokens({
        db,
        namespace,
        key,
        expectedEpoch: 2,
        migrationRunId: 'run-owner-1',
      }),
    ).rejects.toThrow(CutoverFenceError);
  });

  it('real emulator: code exchange rolls back and keeps code redeemable when fence refuses', async () => {
    // Start in v3_ready (ordinary writes refused)
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });
    await transitionCutoverFenceState(db, namespace, { fromState: 'legacy_open', toState: 'closing', expectedEpoch: 1 });
    await transitionCutoverFenceState(db, namespace, { fromState: 'closing', toState: 'fenced', expectedEpoch: 1 });
    await transitionCutoverFenceState(db, namespace, { fromState: 'fenced', toState: 'migrating', expectedEpoch: 1, migrationRunId: 'r-fail' });
    await db.runTransaction(async (tx) => {
      await markIrreversibleInTransaction(tx, db, namespace, 1, 'r-fail');
    });
    await transitionCutoverFenceState(db, namespace, {
      fromState: 'migrating',
      toState: 'v3_ready',
      expectedEpoch: 1,
      migrationRunId: 'r-fail',
      migrationManifestDigest: 'd-fail',
    });

    const now = Date.now();
    const rawCode = 'rollback-test-code';
    const store = createFirestoreStore({ db, namespace, key });

    // Seed an auth code directly
    const codeId = codec.id('code', rawCode);
    await db.collection(`${namespace}_auth_codes`).doc(codeId).set({
      id: codeId,
      expiresAt: now + 600_000,
      sealed: codec.seal({
        pending: { clientId: 'c-test', codeChallenge: 'c-chal', redirectUri: 'http://cb', createdAt: now },
        nsTokens: { access_token: 'ns-tok' },
        clientId: 'c-test',
      }, `code:${codeId}`),
    });

    // In v3_ready, credential issuance is refused by the fence!
    // atomicRedeemCodeAndIssue MUST ROLL BACK and NOT delete the code!
    await expect(
      store.authCodes.redeemAndIssue(
        rawCode,
        { clientId: 'c-test' },
        { accessToken: 'fail-acc', refreshToken: 'fail-ref' },
        { clientId: 'c-test', expiresAt: now + 3600_000, nsAccessToken: 'ns-tok', nsUsername: 'user@test.com' },
      ),
    ).rejects.toThrow(CutoverRefusedError);

    // CRITICAL ASSERTION: The code document MUST STILL EXIST in Firestore!
    const codeDocAfterRollback = await db.collection(`${namespace}_auth_codes`).doc(codeId).get();
    expect(codeDocAfterRollback.exists).toBe(true);

    // Now activate fence
    await transitionCutoverFenceState(db, namespace, {
      fromState: 'v3_ready',
      toState: 'v3_active',
      expectedEpoch: 1,
      migrationRunId: 'r-fail',
      migrationManifestDigest: 'd-fail',
    });

    // In v3_active, the same code can now be redeemed successfully!
    const successfulRedeem = await store.authCodes.redeemAndIssue(
      rawCode,
      { clientId: 'c-test' },
      { accessToken: 'pass-acc', refreshToken: 'pass-ref' },
      { clientId: 'c-test', expiresAt: now + 3600_000, nsAccessToken: 'ns-tok', nsUsername: 'user@test.com' },
    );
    expect(successfulRedeem).toBeDefined();

    // Now it is consumed
    const codeDocAfterSuccess = await db.collection(`${namespace}_auth_codes`).doc(codeId).get();
    expect(codeDocAfterSuccess.exists).toBe(false);
  });

  it('real emulator: legacy OAuth client is inventoried, migrated, and usable after cutover', async () => {
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'fenced' });

    const clientId = 'legacy-registered-client-1';
    await db.collection(`${namespace}_clients`).doc(clientId).set({
      client_id: clientId,
      client_name: 'Legacy Client',
      redirect_uris: ['https://example.com/oauth/callback'],
      token_endpoint_auth_method: 'none',
      client_id_issued_at: Date.now(),
    });

    const report = await adoptFirestoreLegacyTokens({ db, namespace, key, expectedEpoch: 1 });
    expect(report.errors).toBe(0);
    expect(report.migrated).toBe(1);

    // Transition to v3_active
    const ctrl = await getCutoverFenceRecord(db, namespace);
    await transitionCutoverFenceState(db, namespace, {
      fromState: 'v3_ready',
      toState: 'v3_active',
      expectedEpoch: 1,
      migrationRunId: ctrl!.migrationRunId!,
      migrationManifestDigest: ctrl!.migrationManifestDigest!,
    });

    // Verify client can be read from v3 store
    const store = createFirestoreStore({ db, namespace, key });
    const client = await store.clients.getClient(clientId);
    expect(client).toBeDefined();
    expect(client?.client_id).toBe(clientId);
    expect(client?.client_name).toBe('Legacy Client');
    expect(client?.redirect_uris).toEqual(['https://example.com/oauth/callback']);
  });
});
