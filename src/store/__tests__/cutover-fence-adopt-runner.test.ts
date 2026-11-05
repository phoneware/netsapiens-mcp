// Cutover fence adoption cases, ported from cutover-fence.test.ts onto the genuine protected runner and the
// Firestore emulator. Legacy state is seeded in the emulator, the inspect step supplies the source digest,
// and the adopt step runs in a child process with the factory's exact argv through support/runner-harness.
// Runs only where containerGateOpen() holds. Never touches an existing /opt/cutover or /run/cutover.
// UNVERIFIED: written without an emulator run (disk limited). The expectations are the original assertions.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Firestore } from '@google-cloud/firestore';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { deriveStoreKey } from '../codec.js';
import {
  CutoverRefusedError,
  checkMutationGuardInTransaction,
  ensureFirestoreAdopted,
  getCutoverFenceRecord,
  initializeCutoverFence,
  startMonotonicTimer,
  transitionCutoverFenceState,
  withLegacyOperation,
} from '../firestore-v2-adoption.js';
import { createFirestoreBackend, createFirestoreStore, type FirestoreLike } from '../firestore.js';
import { startFakeAdmin } from './support/fake-admin.mjs';
import { assertCanOwnMounts, containerGateOpen, releaseMounts } from './support/mounts.mjs';
import { fixtureFor, runStep, sessionSecretOf } from './support/runner-harness.mjs';
import {
  EMULATOR,
  EPOCH,
  resetFencedNamespace,
  resetNamespaceWithoutFence,
  seedDocs,
  snapshotNamespace,
} from './support/emulator-seed.js';
import { reviewedScopeClosed } from './support/reviewed-scope.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE_SOURCE = resolve(here, '..', 'cutover-protocol.mjs');
const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const key = deriveStoreKey(SECRET);
const NS = 'mcp';
const gateOpen = containerGateOpen();
// Positive runner cases (an adopt commit that must succeed) run only when the reviewed scope is closed. While the
// census is open they are skipped; the negatives and the in-process read-path case still run.
const positiveScopeClosed = gateOpen && reviewedScopeClosed();

describe.skipIf(!gateOpen)('cutover fence adoption on the protected runner and emulator (unverified)', () => {
  let bundleBytes: Buffer;
  let db: Firestore;
  let admin: { close: () => Promise<void> } | null = null;

  beforeAll(() => {
    assertCanOwnMounts();
    bundleBytes = readFileSync(BUNDLE_SOURCE);
    expect(bundleBytes.toString('utf8')).toContain('createProtectedFirestoreMigrationContext');
    db = new Firestore(EMULATOR);
  });

  afterEach(async () => {
    if (admin) await admin.close();
    admin = null;
  });

  afterAll(async () => {
    releaseMounts();
    await db.terminate();
  });

  // The fake Admin serves the fixture's signed index for the index reads the runner makes.
  async function startAdmin(namespace: string): Promise<void> {
    const fixture = fixtureFor({ bundleBytes, namespace, epoch: EPOCH, action: 'inspect' });
    admin = await startFakeAdmin({
      databaseResource: fixture.index.provenance.databaseResource,
      policy: fixture.index.policy,
      token: 'owner',
    });
  }

  // Inspect supplies the source digest the adopt must present. An inspect refusal fails the case.
  async function inspectDigest(namespace: string): Promise<string> {
    const inspected = runStep({ bundleBytes, namespace, epoch: EPOCH, action: 'inspect' });
    expect(inspected.ok).toBe(true);
    return inspected.sourceInventoryDigest as string;
  }

  function adopt(namespace: string, expectedSourceInventoryDigest: string, dryRun: boolean) {
    return runStep({
      bundleBytes,
      namespace,
      epoch: EPOCH,
      action: 'adopt',
      options: { dryRun, expectedSourceInventoryDigest },
    });
  }

  it.skipIf(!positiveScopeClosed)('dryRun: true accurately reports migrated counts without writing v3 documents or marker', async () => {
    await resetFencedNamespace(db, NS);
    const familyId = 'dry-fam-1';
    await seedDocs(db, [
      [`${NS}_tokens_refresh_families/${familyId}`, {
        id: familyId,
        currentAccessToken: 'dry-acc',
        currentRefreshToken: 'dry-ref',
        retiredRefreshFingerprints: [],
        updatedAt: Date.now(),
      }],
      [`${NS}_tokens_refresh/dry-ref`, {
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
      }],
      [`${NS}_tokens_upstream/${familyId}`, {
        grant: { access_token: 'ns-dry-tok', refresh_token: 'ns-dry-ref', username: 'dry@domain.com' },
        expiresAt: Date.now() + 3600_000,
        updatedAt: Date.now(),
      }],
      [`${NS}_tokens/dry-acc`, {
        accessToken: 'dry-acc',
        refreshToken: 'dry-ref',
        refreshFamilyId: familyId,
        clientId: 'dry-client',
      }],
    ]);
    await startAdmin(NS);
    const digest = await inspectDigest(NS);

    const report = adopt(NS, digest, true);
    expect(report.ok).toBe(true);
    expect(report.report?.errors).toBe(0);
    expect(report.report?.migrated).toBe(1);

    // No v3 documents or v2_adopted marker were written during the dry run.
    expect((await db.collection(`${NS}_refresh_families`).get()).empty).toBe(true);
    expect((await db.doc(`${NS}_meta/v2_adopted`).get()).exists).toBe(false);

    // The control record stays strictly in fenced, not irreversible, with no migration run.
    const ctrl = await getCutoverFenceRecord(db as unknown as FirestoreLike, NS);
    expect(ctrl?.state).toBe('fenced');
    expect(ctrl?.epoch).toBe(EPOCH);
    expect(ctrl?.irreversible).toBe(false);
    expect(ctrl?.migrationRunId).toBeUndefined();
  });

  it.skipIf(!positiveScopeClosed)('orphan family-linked token with missing legacy family reports error rather than silent omission', async () => {
    await resetFencedNamespace(db, NS);
    await seedDocs(db, [
      [`${NS}_tokens/orphan-access-tok`, {
        accessToken: 'orphan-access-tok',
        refreshToken: 'orphan-ref-tok',
        refreshFamilyId: 'nonexistent-fam-123',
        clientId: 'client-orphan',
      }],
    ]);
    await startAdmin(NS);
    const digest = await inspectDigest(NS);

    const report = adopt(NS, digest, false);
    // Must report error, NOT silent skip.
    expect(report.ok).toBe(true);
    expect(report.report?.errors).toBe(1);
  });

  it.skipIf(!positiveScopeClosed)('partial target family in v3 causes migration conflict error', async () => {
    const familyId = 'fam-partial-conflict';
    await resetFencedNamespace(db, NS);
    await seedDocs(db, [
      [`${NS}_tokens_refresh_families/${familyId}`, {
        id: familyId,
        currentAccessToken: 'partial-acc',
        currentRefreshToken: 'partial-ref',
        retiredRefreshFingerprints: [],
        updatedAt: Date.now(),
      }],
      [`${NS}_tokens_refresh/partial-ref`, {
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
      }],
      [`${NS}_tokens_upstream/${familyId}`, {
        grant: { access_token: 'ns-tok', refresh_token: 'ns-ref', username: 'user@domain.com' },
        expiresAt: Date.now() + 3600_000,
        updatedAt: Date.now(),
      }],
      // Partial target: only refresh_families in v3, sessions and upstream missing.
      [`${NS}_refresh_families/${familyId}`, { id: familyId, generation: 1, status: 'active' }],
    ]);
    await startAdmin(NS);
    const digest = await inspectDigest(NS);

    const report = adopt(NS, digest, false);
    expect(report.ok).toBe(true);
    expect(report.report?.errors).toBe(1);
  });

  it.skipIf(!positiveScopeClosed)('missing access or refresh token identifier rejects with error rather than inventing random IDs', async () => {
    const familyId = 'fam-missing-ids';
    await resetFencedNamespace(db, NS);
    await seedDocs(db, [
      // Legacy family missing currentAccessToken and currentRefreshToken.
      [`${NS}_tokens_refresh_families/${familyId}`, {
        id: familyId,
        retiredRefreshFingerprints: [],
        updatedAt: Date.now(),
      }],
      [`${NS}_tokens_upstream/${familyId}`, {
        grant: { access_token: 'ns-tok', refresh_token: 'ns-ref', username: 'user@domain.com' },
        expiresAt: Date.now() + 3600_000,
        updatedAt: Date.now(),
      }],
    ]);
    await startAdmin(NS);
    const digest = await inspectDigest(NS);

    const report = adopt(NS, digest, false);
    expect(report.ok).toBe(true);
    expect(report.report?.errors).toBe(1);
  });

  it('fails closed when missing control record in controlled namespace', async () => {
    // No fence record. The runner must refuse and write nothing: no fence, no marker, no v3 documents.
    await resetNamespaceWithoutFence(db, NS);
    await startAdmin(NS);
    const before = await snapshotNamespace(db, NS);

    const attempt = adopt(NS, '0'.repeat(64), false);
    expect(attempt.ok).toBe(false);

    expect(await getCutoverFenceRecord(db as unknown as FirestoreLike, NS)).toBeFalsy();
    expect((await db.doc(`${NS}_meta/v2_adopted`).get()).exists).toBe(false);
    expect(await snapshotNamespace(db, NS)).toEqual(before);
  });

  it.skipIf(!positiveScopeClosed)('classifies orphan refresh pointers and orphan upstream grants as errors', async () => {
    await resetFencedNamespace(db, NS);
    await seedDocs(db, [
      // Orphan refresh pointer with no family.
      [`${NS}_tokens_refresh/orphan-ref`, { familyId: 'nonexistent-fam', status: 'active' }],
      // Orphan upstream grant with no family.
      [`${NS}_tokens_upstream/orphan-upstream-fam`, { nsAccessToken: 'ns-tok', nsRefreshToken: 'ns-ref' }],
    ]);
    await startAdmin(NS);
    const digest = await inspectDigest(NS);

    const report = adopt(NS, digest, false);
    expect(report.ok).toBe(true);
    expect(report.report?.errors).toBe(2);
  });

  it.skipIf(!positiveScopeClosed)('rejects conflicting claims when two families claim the same access or refresh token', async () => {
    const now = Date.now();
    await resetFencedNamespace(db, NS);
    await seedDocs(db, [
      // Family 1.
      [`${NS}_tokens_refresh_families/fam-1`, { currentRefreshToken: 'shared-ref', currentAccessToken: 'acc-1', clientId: 'c1', createdAt: now, updatedAt: now }],
      [`${NS}_tokens_refresh/shared-ref`, { familyId: 'fam-1', status: 'active', createdAt: now }],
      [`${NS}_tokens_upstream/fam-1`, { nsAccessToken: 'ns-tok-1', nsRefreshToken: 'ns-ref-1', nsUsername: 'u1@domain.com', updatedAt: now }],
      [`${NS}_tokens/acc-1`, { familyId: 'fam-1', accessToken: 'acc-1', clientId: 'c1', expiresAt: now + 3600_000 }],
      // Family 2 claims the same refresh token shared-ref.
      [`${NS}_tokens_refresh_families/fam-2`, { currentRefreshToken: 'shared-ref', currentAccessToken: 'acc-2', clientId: 'c2', createdAt: now, updatedAt: now }],
      [`${NS}_tokens_upstream/fam-2`, { nsAccessToken: 'ns-tok-2', nsRefreshToken: 'ns-ref-2', nsUsername: 'u2@domain.com', updatedAt: now }],
      [`${NS}_tokens/acc-2`, { familyId: 'fam-2', accessToken: 'acc-2', clientId: 'c2', expiresAt: now + 3600_000 }],
    ]);
    await startAdmin(NS);
    const digest = await inspectDigest(NS);

    const report = adopt(NS, digest, false);
    expect(report.ok).toBe(true);
    expect(report.report?.errors).toBeGreaterThanOrEqual(1);
  });

  it.skipIf(!positiveScopeClosed)('classifies family-linked access token as orphan if it does not match currentAccessToken', async () => {
    const now = Date.now();
    await resetFencedNamespace(db, NS);
    await seedDocs(db, [
      [`${NS}_tokens_refresh_families/fam-1`, { currentRefreshToken: 'ref-1', currentAccessToken: 'acc-legit', clientId: 'c1', createdAt: now, updatedAt: now }],
      [`${NS}_tokens_refresh/ref-1`, { familyId: 'fam-1', status: 'active', createdAt: now }],
      [`${NS}_tokens_upstream/fam-1`, { nsAccessToken: 'ns-tok-1', nsRefreshToken: 'ns-ref-1', nsUsername: 'u1@domain.com', updatedAt: now }],
      [`${NS}_tokens/acc-legit`, { familyId: 'fam-1', accessToken: 'acc-legit', clientId: 'c1', expiresAt: now + 3600_000 }],
      // An extraneous token claiming fam-1, whose currentAccessToken is acc-legit.
      [`${NS}_tokens/acc-stray`, { refreshFamilyId: 'fam-1', accessToken: 'acc-stray', clientId: 'c1', expiresAt: now + 3600_000 }],
    ]);
    await startAdmin(NS);
    const digest = await inspectDigest(NS);

    const report = adopt(NS, digest, false);
    expect(report.ok).toBe(true);
    expect(report.report?.errors).toBe(1);
  });

  it.skipIf(!positiveScopeClosed)('ordinary writers are refused when fence is in v3_ready and allowed only in v3_active', async () => {
    await resetFencedNamespace(db, NS);
    await startAdmin(NS);
    const digest = await inspectDigest(NS);

    // The runner's commit moves the fence to v3_ready and records its migration run.
    const committed = adopt(NS, digest, false);
    expect(committed.ok).toBe(true);
    const ctrlReady = await getCutoverFenceRecord(db as unknown as FirestoreLike, NS);
    expect(ctrlReady?.state).toBe('v3_ready');

    const backend = createFirestoreBackend({ db: db as unknown as FirestoreLike, namespace: NS, key });
    // In v3_ready, ordinary write mutations must be refused.
    await expect(
      backend.putAccess({
        id: 'tok-write',
        familyId: 'fam-1',
        expiresAt: Date.now() + 3600_000,
        retainUntil: Date.now() + 7200_000,
        sealed: 'sealed-data',
      }),
    ).rejects.toThrow(CutoverRefusedError);

    // Activation is the in-process transition the original test drove; it takes the run the runner recorded.
    const { transitionCutoverFenceState } = await import('../firestore-v2-adoption.js');
    await transitionCutoverFenceState(db as unknown as FirestoreLike, NS, {
      fromState: 'v3_ready',
      toState: 'v3_active',
      expectedEpoch: ctrlReady!.epoch,
      migrationRunId: ctrlReady!.migrationRunId!,
      migrationManifestDigest: ctrlReady!.migrationManifestDigest!,
    });

    // Once v3_active, the same ordinary write must succeed.
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

  // In-process, not a runner case: ensureFirestoreAdopted is the read-path guard, not the protected runner.
  it('ensureFirestoreAdopted refuses request-triggered migration on read paths when legacy credentials exist', async () => {
    await resetNamespaceWithoutFence(db, NS);
    await initializeCutoverFence(db as unknown as FirestoreLike, NS, { initialEpoch: 1, initialState: 'legacy_open' });
    await seedDocs(db, [[`${NS}_tokens/unmigrated-tok`, { accessToken: 'unmigrated-tok', refreshToken: 'unmigrated-ref' }]]);

    // The read path must refuse, not auto-migrate.
    await expect(
      ensureFirestoreAdopted({ db: db as unknown as FirestoreLike, namespace: NS, key }),
    ).rejects.toThrow(CutoverRefusedError);
  });

  // Ported from cutover-fence.test.ts (C1/C2/C7). The in-process steps are identical; only the adopt step moves to
  // the protected runner, because the protected binding exists only in the runner.
  it.skipIf(!positiveScopeClosed)('executes full C1/C2/C7 state machine: legacy_open -> closing -> fenced -> migrating -> v3_ready -> v3_active', async () => {
    await resetNamespaceWithoutFence(db, NS);
    const init = await initializeCutoverFence(db as unknown as FirestoreLike, NS, { initialEpoch: EPOCH });
    expect(init.state).toBe('legacy_open');
    expect(init.epoch).toBe(EPOCH);
    expect(init.activeOperations).toBe(0);
    expect(init.irreversible).toBe(false);

    const now = Date.now();
    await seedDocs(db, [
      [`${NS}_tokens_refresh_families/fam-1`, { currentRefreshToken: 'ref-1', currentAccessToken: 'tok-1', clientId: 'client-leg', scope: 'read', createdAt: now, updatedAt: now }],
      [`${NS}_tokens_refresh/ref-1`, { familyId: 'fam-1', status: 'active', createdAt: now }],
      [`${NS}_tokens_upstream/fam-1`, { nsAccessToken: 'ns-tok', nsRefreshToken: 'ns-ref', nsUsername: 'user@domain.com', updatedAt: now }],
      [`${NS}_tokens/tok-1`, { familyId: 'fam-1', accessToken: 'tok-1', clientId: 'client-leg', expiresAt: now + 3600_000 }],
    ]);

    // 2. A legacy operation is admitted during legacy_open, and its guard permits the mutation.
    let executedOp = false;
    await withLegacyOperation({ db: db as unknown as FirestoreLike, namespace: NS, identityKey: key, kind: 'token' }, async (ctx) => {
      expect(ctx.epoch).toBe(EPOCH);
      executedOp = true;
      const guard = await db.runTransaction(async (tx: any) => {
        const timer = startMonotonicTimer();
        const g = await checkMutationGuardInTransaction(tx, { db: db as unknown as FirestoreLike, namespace: NS, operation: ctx, timer });
        expect(g.control.state).toBe('legacy_open');
        g.bufferCompletion();
        g.assertPreReturn();
        return g;
      });
      guard.onCommit();
    });
    expect(executedOp).toBe(true);
    expect((await getCutoverFenceRecord(db as unknown as FirestoreLike, NS))?.activeOperations).toBe(0);

    // 3. closing refuses new legacy operations.
    await transitionCutoverFenceState(db as unknown as FirestoreLike, NS, { fromState: 'legacy_open', toState: 'closing', expectedEpoch: EPOCH });
    await expect(
      withLegacyOperation({ db: db as unknown as FirestoreLike, namespace: NS, identityKey: key, kind: 'token' }, async () => { }),
    ).rejects.toThrow(CutoverRefusedError);

    // 4. fenced: activeOperations is zero, and mutations are refused.
    await transitionCutoverFenceState(db as unknown as FirestoreLike, NS, { fromState: 'closing', toState: 'fenced', expectedEpoch: EPOCH });
    await expect(
      db.runTransaction(async (tx: any) => {
        const timer = startMonotonicTimer();
        await checkMutationGuardInTransaction(tx, { db: db as unknown as FirestoreLike, namespace: NS, timer });
      }),
    ).rejects.toThrow(CutoverRefusedError);

    // 5. The protected runner adopts the fenced namespace, with the fake Admin serving the signed index.
    const fixture = fixtureFor({ bundleBytes, namespace: NS, epoch: EPOCH });
    admin = await startFakeAdmin({ databaseResource: fixture.index.provenance.databaseResource, policy: fixture.index.policy, token: 'owner' });
    const inspected = runStep({ bundleBytes, namespace: NS, epoch: EPOCH, action: 'inspect' });
    expect(inspected.ok).toBe(true);
    const adopted = runStep({
      bundleBytes,
      namespace: NS,
      epoch: EPOCH,
      action: 'adopt',
      options: { dryRun: false, expectedSourceInventoryDigest: inspected.sourceInventoryDigest },
    });
    expect(adopted.ok).toBe(true);
    expect(adopted.report?.errors).toBe(0);

    // 6. The fence is v3_ready and irreversible, with a manifest digest.
    const finalRecord = await getCutoverFenceRecord(db as unknown as FirestoreLike, NS);
    expect(finalRecord?.state).toBe('v3_ready');
    expect(finalRecord?.irreversible).toBe(true);
    expect(finalRecord?.migrationManifestDigest).toBeDefined();

    // 7. The irreversibility latch: v3_ready cannot return to legacy_open.
    await expect(
      transitionCutoverFenceState(db as unknown as FirestoreLike, NS, { fromState: 'v3_ready', toState: 'legacy_open', expectedEpoch: finalRecord!.epoch }),
    ).rejects.toThrow(/cannot transition from v3_ready to legacy_open/);

    // 8. v3_active, bound to the run and manifest the runner recorded.
    await transitionCutoverFenceState(db as unknown as FirestoreLike, NS, {
      fromState: 'v3_ready',
      toState: 'v3_active',
      expectedEpoch: finalRecord!.epoch,
      migrationRunId: finalRecord!.migrationRunId!,
      migrationManifestDigest: finalRecord!.migrationManifestDigest!,
    });

    // 9. The v3 store reads the migrated session with the factory's key.
    const store = createFirestoreStore({ db: db as unknown as FirestoreLike, namespace: NS, key: deriveStoreKey(sessionSecretOf(fixture)) });
    const session = await store.sessions.get('tok-1');
    expect(session?.clientId).toBe('client-leg');
    expect(session?.nsUsername).toBe('user@domain.com');
  });
});
