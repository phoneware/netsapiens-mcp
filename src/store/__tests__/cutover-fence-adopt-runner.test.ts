// Cutover fence adoption on the protected runner and the Firestore emulator. Positive runner proofs mount the
// SYNTHETIC closed-scope bundle (support/closed-bundle.mjs); the production bundle stays open and is proved to
// refuse in scope-open-refusal.test.ts. Legacy state is seeded in the emulator, inspect supplies the source
// digest, and each adopt runs in a child process with the factory's exact argv.
//
// Error scenarios: the dry run classifies the errors and writes nothing; the commit must be refused with no
// write. Positive scenarios: the commit must succeed. Nothing here reaches a live system; the NetSapiens
// upstream is never called (the runner reads only the emulator and the fake Admin).
// Runs only where containerGateOpen() holds. Never touches an existing /opt/cutover or /run/cutover.
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
import { closedBundleBytes } from './support/closed-bundle.mjs';
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

const NS = 'mcp';
const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const key = deriveStoreKey(SECRET);
const gateOpen = containerGateOpen();
const fence = (db: Firestore) => db as unknown as FirestoreLike;

// Scenarios whose legacy state is an error for the migration. The dry run must report `errors` (a number, or
// '>=1' where the original assertion was a lower bound) and write nothing; the commit must be refused.
interface ErrorScenario {
  readonly name: string;
  readonly errors: number | '>=1';
  readonly seed: () => Array<readonly [string, Record<string, unknown>]>;
}

const errorScenarios = (): ErrorScenario[] => {
  const now = Date.now();
  return [
    {
      name: 'orphan family-linked token with missing legacy family reports error rather than silent omission',
      errors: 1,
      seed: () => [[`${NS}_tokens/orphan-access-tok`, {
        accessToken: 'orphan-access-tok', refreshToken: 'orphan-ref-tok', refreshFamilyId: 'nonexistent-fam-123', clientId: 'client-orphan',
      }]],
    },
    {
      name: 'partial target family in v3 causes migration conflict error',
      errors: 1,
      seed: () => [
        [`${NS}_tokens_refresh_families/fam-partial-conflict`, {
          id: 'fam-partial-conflict', currentAccessToken: 'partial-acc', currentRefreshToken: 'partial-ref', retiredRefreshFingerprints: [], updatedAt: now,
        }],
        [`${NS}_tokens_refresh/partial-ref`, {
          accessToken: 'partial-acc', familyId: 'fam-partial-conflict', status: 'active',
          token: { accessToken: 'partial-acc', refreshToken: 'partial-ref', clientId: 'client-partial', expiresAt: now + 3600_000, nsAccessToken: 'ns-tok', nsRefreshToken: 'ns-ref', nsUsername: 'user@domain.com' },
        }],
        [`${NS}_tokens_upstream/fam-partial-conflict`, {
          grant: { access_token: 'ns-tok', refresh_token: 'ns-ref', username: 'user@domain.com' }, expiresAt: now + 3600_000, updatedAt: now,
        }],
        // Partial target: only refresh_families in v3, sessions and upstream missing.
        [`${NS}_refresh_families/fam-partial-conflict`, { id: 'fam-partial-conflict', generation: 1, status: 'active' }],
      ],
    },
    {
      name: 'missing access or refresh token identifier rejects with error rather than inventing random IDs',
      errors: 1,
      seed: () => [
        [`${NS}_tokens_refresh_families/fam-missing-ids`, { id: 'fam-missing-ids', retiredRefreshFingerprints: [], updatedAt: now }],
        [`${NS}_tokens_upstream/fam-missing-ids`, {
          grant: { access_token: 'ns-tok', refresh_token: 'ns-ref', username: 'user@domain.com' }, expiresAt: now + 3600_000, updatedAt: now,
        }],
      ],
    },
    {
      name: 'classifies orphan refresh pointers and orphan upstream grants as errors',
      errors: 2,
      seed: () => [
        [`${NS}_tokens_refresh/orphan-ref`, { familyId: 'nonexistent-fam', status: 'active' }],
        [`${NS}_tokens_upstream/orphan-upstream-fam`, { nsAccessToken: 'ns-tok', nsRefreshToken: 'ns-ref' }],
      ],
    },
    {
      name: 'rejects conflicting claims when two families claim the same access or refresh token',
      errors: '>=1',
      seed: () => [
        [`${NS}_tokens_refresh_families/fam-1`, { currentRefreshToken: 'shared-ref', currentAccessToken: 'acc-1', clientId: 'c1', createdAt: now, updatedAt: now }],
        [`${NS}_tokens_refresh/shared-ref`, { familyId: 'fam-1', status: 'active', createdAt: now }],
        [`${NS}_tokens_upstream/fam-1`, { nsAccessToken: 'ns-tok-1', nsRefreshToken: 'ns-ref-1', nsUsername: 'u1@domain.com', updatedAt: now }],
        [`${NS}_tokens/acc-1`, { familyId: 'fam-1', accessToken: 'acc-1', clientId: 'c1', expiresAt: now + 3600_000 }],
        [`${NS}_tokens_refresh_families/fam-2`, { currentRefreshToken: 'shared-ref', currentAccessToken: 'acc-2', clientId: 'c2', createdAt: now, updatedAt: now }],
        [`${NS}_tokens_upstream/fam-2`, { nsAccessToken: 'ns-tok-2', nsRefreshToken: 'ns-ref-2', nsUsername: 'u2@domain.com', updatedAt: now }],
        [`${NS}_tokens/acc-2`, { familyId: 'fam-2', accessToken: 'acc-2', clientId: 'c2', expiresAt: now + 3600_000 }],
      ],
    },
    {
      name: 'classifies family-linked access token as orphan if it does not match currentAccessToken',
      errors: 1,
      seed: () => [
        [`${NS}_tokens_refresh_families/fam-1`, { currentRefreshToken: 'ref-1', currentAccessToken: 'acc-legit', clientId: 'c1', createdAt: now, updatedAt: now }],
        [`${NS}_tokens_refresh/ref-1`, { familyId: 'fam-1', status: 'active', createdAt: now }],
        [`${NS}_tokens_upstream/fam-1`, { nsAccessToken: 'ns-tok-1', nsRefreshToken: 'ns-ref-1', nsUsername: 'u1@domain.com', updatedAt: now }],
        [`${NS}_tokens/acc-legit`, { familyId: 'fam-1', accessToken: 'acc-legit', clientId: 'c1', expiresAt: now + 3600_000 }],
        // An extraneous token claiming fam-1, whose currentAccessToken is acc-legit.
        [`${NS}_tokens/acc-stray`, { refreshFamilyId: 'fam-1', accessToken: 'acc-stray', clientId: 'c1', expiresAt: now + 3600_000 }],
      ],
    },
    {
      name: 'holds an unclaimed access token with contradictory family ownership fields',
      errors: 1,
      seed: () => [[`${NS}_tokens/ambiguous`, {
        accessToken: 'ambiguous', refreshToken: 'ambiguous-ref', familyId: 'fam-a', refreshFamilyId: 'fam-b',
        clientId: 'client', expiresAt: now + 3600_000,
      }]],
    },
    {
      name: 'holds a family-selected access token with contradictory family ownership fields',
      errors: '>=1',
      seed: () => [
        [`${NS}_tokens_refresh_families/fam-a`, { id: 'fam-a', currentAccessToken: 'ambiguous', currentRefreshToken: 'ambiguous-ref', retiredRefreshFingerprints: [], updatedAt: now }],
        [`${NS}_tokens_refresh/ambiguous-ref`, { refreshToken: 'ambiguous-ref', accessToken: 'ambiguous', familyId: 'fam-a', status: 'active', token: { clientId: 'client', expiresAt: now + 3600_000 } }],
        [`${NS}_tokens_upstream/fam-a`, { nsAccessToken: 'upstream', nsUsername: 'user@example.test' }],
        [`${NS}_tokens/ambiguous`, { accessToken: 'ambiguous', refreshToken: 'ambiguous-ref', familyId: 'fam-a', refreshFamilyId: 'fam-b', clientId: 'client', expiresAt: now + 3600_000 }],
      ],
    },
    {
      name: 'holds a family-selected token naming only a different family',
      errors: '>=1',
      seed: () => [
        [`${NS}_tokens_refresh_families/fam-a`, { id: 'fam-a', currentAccessToken: 'ambiguous', currentRefreshToken: 'ambiguous-ref', retiredRefreshFingerprints: [], updatedAt: now }],
        [`${NS}_tokens_refresh/ambiguous-ref`, { refreshToken: 'ambiguous-ref', accessToken: 'ambiguous', familyId: 'fam-a', status: 'active', token: { clientId: 'client', expiresAt: now + 3600_000 } }],
        [`${NS}_tokens_upstream/fam-a`, { nsAccessToken: 'upstream', nsUsername: 'user@example.test' }],
        [`${NS}_tokens/ambiguous`, { accessToken: 'ambiguous', refreshToken: 'ambiguous-ref', familyId: 'fam-b', clientId: 'client', expiresAt: now + 3600_000 }],
      ],
    },
  ];
};

describe.skipIf(!gateOpen)('cutover fence adoption on the protected runner and emulator (synthetic closed scope)', () => {
  let bundleBytes: Buffer;
  let db: Firestore;
  let admin: { close: () => Promise<void> } | null = null;

  beforeAll(() => {
    assertCanOwnMounts();
    bundleBytes = closedBundleBytes();
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

  // The fake Admin serves the fixture's signed index for the runner's index reads.
  async function startAdmin(namespace: string): Promise<void> {
    const fixture = fixtureFor({ bundleBytes, namespace, epoch: EPOCH });
    admin = await startFakeAdmin({ databaseResource: fixture.index.provenance.databaseResource, policy: fixture.index.policy, token: 'owner' });
  }

  function step(action: 'inspect' | 'adopt' | 'activate', options: Record<string, unknown> = {}) {
    return runStep({ bundleBytes, namespace: NS, epoch: EPOCH, action, options });
  }

  async function inspectDigest(): Promise<string> {
    const inspected = await step('inspect')
    expect(inspected.ok, `inspect refused: ${inspected.message}`).toBe(true);
    return inspected.sourceInventoryDigest as string;
  }

  for (const scenario of errorScenarios()) {
    it(`dry run classifies the error and writes nothing; commit is refused with no write: ${scenario.name}`, async () => {
      await resetFencedNamespace(db, NS);
      await seedDocs(db, scenario.seed());
      await startAdmin(NS);
      const digest = await inspectDigest();
      const before = await snapshotNamespace(db, NS);

      const dry = await step('adopt', { dryRun: true, expectedSourceInventoryDigest: digest })
      expect(dry.ok, `dry run refused: ${dry.message}`).toBe(true);
      if (scenario.errors === '>=1') expect(dry.report?.errors).toBeGreaterThanOrEqual(1);
      else expect(dry.report?.errors).toBe(scenario.errors);
      expect(await snapshotNamespace(db, NS)).toEqual(before);

      const committed = await step('adopt', { dryRun: false, expectedSourceInventoryDigest: digest })
      expect(committed.ok, 'a commit with migration errors must be refused').toBe(false);
      expect(committed.exitStatus).not.toBe(0);
      expect(await snapshotNamespace(db, NS)).toEqual(before);
      expect((await getCutoverFenceRecord(fence(db), NS))?.state).toBe('fenced');
    });
  }

  it('dryRun: true accurately reports migrated counts without writing v3 documents or marker', async () => {
    const now = Date.now();
    await resetFencedNamespace(db, NS);
    await seedDocs(db, [
      [`${NS}_tokens_refresh_families/dry-fam-1`, { id: 'dry-fam-1', currentAccessToken: 'dry-acc', currentRefreshToken: 'dry-ref', retiredRefreshFingerprints: [], updatedAt: now }],
      [`${NS}_tokens_refresh/dry-ref`, {
        accessToken: 'dry-acc', familyId: 'dry-fam-1', status: 'active',
        token: { accessToken: 'dry-acc', refreshToken: 'dry-ref', clientId: 'dry-client', expiresAt: now + 3600_000, serverBaseUrl: 'http://localhost:3000', nsAccessToken: 'ns-dry-tok', nsRefreshToken: 'ns-dry-ref', nsUsername: 'dry@domain.com' },
      }],
      [`${NS}_tokens_upstream/dry-fam-1`, { grant: { access_token: 'ns-dry-tok', refresh_token: 'ns-dry-ref', username: 'dry@domain.com' }, expiresAt: now + 3600_000, updatedAt: now }],
      [`${NS}_tokens/dry-acc`, { accessToken: 'dry-acc', refreshToken: 'dry-ref', refreshFamilyId: 'dry-fam-1', clientId: 'dry-client' }],
    ]);
    await startAdmin(NS);
    const digest = await inspectDigest();
    const report = await step('adopt', { dryRun: true, expectedSourceInventoryDigest: digest })
    expect(report.ok).toBe(true);
    expect(report.report?.errors).toBe(0);
    expect(report.report?.migrated).toBe(1);

    // No v3 documents or v2_adopted marker were written during the dry run.
    expect((await db.collection(`${NS}_refresh_families`).get()).empty).toBe(true);
    expect((await db.doc(`${NS}_meta/v2_adopted`).get()).exists).toBe(false);
    const ctrl = await getCutoverFenceRecord(fence(db), NS);
    expect(ctrl?.state).toBe('fenced');
    expect(ctrl?.irreversible).toBe(false);
    expect(ctrl?.migrationRunId).toBeUndefined();
  });

  it('a clean commit migrates to v3_ready; ordinary writers are refused there and allowed only after v3_active', async () => {
    const now = Date.now();
    await resetFencedNamespace(db, NS);
    await seedDocs(db, [
      [`${NS}_tokens_refresh_families/fam-1`, { id: 'fam-1', currentAccessToken: 'tok-1', currentRefreshToken: 'ref-1', retiredRefreshFingerprints: [], updatedAt: now }],
      [`${NS}_tokens_refresh/ref-1`, { accessToken: 'tok-1', familyId: 'fam-1', status: 'active', token: { accessToken: 'tok-1', refreshToken: 'ref-1', clientId: 'client-1', expiresAt: now + 3600_000, nsAccessToken: 'ns-1', nsRefreshToken: 'ns-ref-1', nsUsername: 'user@domain.com' } }],
      [`${NS}_tokens_upstream/fam-1`, { grant: { access_token: 'ns-1', refresh_token: 'ns-ref-1', username: 'user@domain.com' }, expiresAt: now + 3600_000, updatedAt: now }],
      [`${NS}_tokens/tok-1`, { accessToken: 'tok-1', refreshToken: 'ref-1', refreshFamilyId: 'fam-1', clientId: 'client-1' }],
    ]);
    await startAdmin(NS);
    const digest = await inspectDigest();
    const committed = await step('adopt', { dryRun: false, expectedSourceInventoryDigest: digest })
    expect(committed.ok, `commit refused: ${committed.message}`).toBe(true);
    expect(committed.report?.errors).toBe(0);
    expect(committed.report?.migrated).toBe(1);

    const ctrlReady = await getCutoverFenceRecord(fence(db), NS);
    expect(ctrlReady?.state).toBe('v3_ready');
    const backend = createFirestoreBackend({ db: fence(db), namespace: NS, key });
    const writeAccess = () => backend.putAccess({ id: 'tok-write', familyId: 'fam-1', expiresAt: Date.now() + 3600_000, retainUntil: Date.now() + 7200_000, sealed: 'sealed-data' });
    await expect(writeAccess()).rejects.toThrow(CutoverRefusedError);

    const activated = await step('activate', { migrationManifestDigest: ctrlReady!.migrationManifestDigest! });
    expect(activated.ok, `activation refused: ${activated.message}`).toBe(true);
    expect(activated.result?.status).toBe('activated');
    await writeAccess();
    expect((await backend.getAccess('tok-write'))?.id).toBe('tok-write');
  });

  // In-process read-path guard, not a runner case: ensureFirestoreAdopted must refuse, not migrate.
  it('ensureFirestoreAdopted refuses request-triggered migration on read paths when legacy credentials exist', async () => {
    await resetNamespaceWithoutFence(db, NS);
    await initializeCutoverFence(fence(db), NS, { initialEpoch: 1, initialState: 'legacy_open' });
    await seedDocs(db, [[`${NS}_tokens/unmigrated-tok`, { accessToken: 'unmigrated-tok', refreshToken: 'unmigrated-ref' }]]);
    await expect(ensureFirestoreAdopted({ db: fence(db), namespace: NS, key })).rejects.toThrow(CutoverRefusedError);
  });

  // Missing control: a specific error, not just a refusal. The closed bundle isolates the fence as the cause.
  it('fails closed on a missing control record with the fence-not-initialized error and writes nothing', async () => {
    await resetNamespaceWithoutFence(db, NS);
    await startAdmin(NS);
    const before = await snapshotNamespace(db, NS);

    const inspected = await step('inspect')
    expect(inspected.ok).toBe(false);
    expect(String(inspected.message)).toMatch(/not initialized/);

    const attempt = await step('adopt', { dryRun: false, expectedSourceInventoryDigest: '0'.repeat(64) })
    expect(attempt.ok).toBe(false);
    expect(String(attempt.message)).toMatch(/not initialized/);

    expect(await getCutoverFenceRecord(fence(db), NS).catch(() => undefined)).toBeFalsy();
    expect(await snapshotNamespace(db, NS)).toEqual(before);
  });

  // The C1/C2/C7 state machine: legacy operations, closing, fenced, the runner's adopt, v3_ready, v3_active, read.
  it('executes full C1/C2/C7 state machine: legacy_open -> closing -> fenced -> migrating -> v3_ready -> v3_active', async () => {
    const now = Date.now();
    await resetNamespaceWithoutFence(db, NS);
    const init = await initializeCutoverFence(fence(db), NS, { initialEpoch: 1 });
    expect(init.state).toBe('legacy_open');
    expect(init.activeOperations).toBe(0);
    expect(init.irreversible).toBe(false);
    await seedDocs(db, [
      [`${NS}_tokens_refresh_families/fam-1`, { currentRefreshToken: 'ref-1', currentAccessToken: 'tok-1', clientId: 'client-leg', scope: 'read', createdAt: now, updatedAt: now }],
      [`${NS}_tokens_refresh/ref-1`, { refreshToken: 'ref-1', accessToken: 'tok-1', familyId: 'fam-1', status: 'active', createdAt: now }],
      [`${NS}_tokens_upstream/fam-1`, { nsAccessToken: 'ns-tok', nsRefreshToken: 'ns-ref', nsUsername: 'user@domain.com', updatedAt: now }],
      [`${NS}_tokens/tok-1`, { familyId: 'fam-1', accessToken: 'tok-1', refreshToken: 'ref-1', clientId: 'client-leg', expiresAt: now + 3600_000 }],
    ]);

    let executedOp = false;
    await withLegacyOperation({ db: fence(db), namespace: NS, identityKey: key, kind: 'token' }, async (ctx) => {
      expect(ctx.epoch).toBe(1);
      executedOp = true;
      const guard = await db.runTransaction(async (tx: any) => {
        const timer = startMonotonicTimer();
        const g = await checkMutationGuardInTransaction(tx, { db: fence(db), namespace: NS, operation: ctx, timer, identityKey: key });
        expect(g.control.state).toBe('legacy_open');
        g.bufferCompletion();
        g.assertPreReturn();
        return g;
      });
      guard.onCommit();
    });
    expect(executedOp).toBe(true);
    expect((await getCutoverFenceRecord(fence(db), NS))?.activeOperations).toBe(0);

    await transitionCutoverFenceState(fence(db), NS, { fromState: 'legacy_open', toState: 'closing', expectedEpoch: 1 });
    await expect(withLegacyOperation({ db: fence(db), namespace: NS, identityKey: key, kind: 'token' }, async () => { })).rejects.toThrow(CutoverRefusedError);

    const fenced = await transitionCutoverFenceState(fence(db), NS, { fromState: 'closing', toState: 'fenced', expectedEpoch: 1 });
    expect(fenced.epoch).toBe(EPOCH);
    await expect(db.runTransaction(async (tx: any) => {
      const timer = startMonotonicTimer();
      await checkMutationGuardInTransaction(tx, { db: fence(db), namespace: NS, timer });
    })).rejects.toThrow(CutoverRefusedError);

    await startAdmin(NS);
    const digest = await inspectDigest();
    const adopted = await step('adopt', { dryRun: false, expectedSourceInventoryDigest: digest })
    expect(adopted.ok, `adopt refused: ${adopted.message}`).toBe(true);
    expect(adopted.report?.errors).toBe(0);

    const finalRecord = await getCutoverFenceRecord(fence(db), NS);
    expect(finalRecord?.state).toBe('v3_ready');
    expect(finalRecord?.irreversible).toBe(true);
    expect(finalRecord?.migrationManifestDigest).toBeDefined();

    await expect(transitionCutoverFenceState(fence(db), NS, { fromState: 'v3_ready', toState: 'legacy_open', expectedEpoch: finalRecord!.epoch }))
      .rejects.toThrow(/cannot transition from v3_ready to legacy_open/);

    const activated = await step('activate', { migrationManifestDigest: finalRecord!.migrationManifestDigest! });
    expect(activated.ok, `activation refused: ${activated.message}`).toBe(true);
    expect(activated.result?.status).toBe('activated');

    const fixture = fixtureFor({ bundleBytes, namespace: NS, epoch: EPOCH });
    const store = createFirestoreStore({ db: fence(db), namespace: NS, key: deriveStoreKey(sessionSecretOf(fixture)) });
    const session = await store.sessions.get('tok-1');
    expect(session?.clientId).toBe('client-leg');
    expect(session?.nsUsername).toBe('user@domain.com');
  });
});
