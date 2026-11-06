// Positive integration proof on a SYNTHETIC closed scope. The production core keeps complete:false. This test
// mutates only the in-memory copy of the bundle, to close the scope (complete true, unscanned empty), signs a
// fixture that binds those exact bytes, and runs the real protected runner against the emulator. Nothing here
// writes a production bundle, a production core, or a shared record.
//
// Isolation: the mutated bytes are mounted only in the fixed container paths, under the container gate, against
// the emulator profile. The mutation is asserted to match exactly once, so the proof fails loudly if the bundle
// text changes. It is a proof that the factory and the migration engine accept a closed, correctly signed scope;
// it is not a claim that production can close, which the census owner decides.
// Runs only where containerGateOpen() holds. Never touches an existing /opt/cutover or /run/cutover.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Firestore } from '@google-cloud/firestore';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { deriveStoreKey } from '../codec.js';
import { createFirestoreStore, type FirestoreLike } from '../firestore.js';
import { getCutoverFenceRecord, transitionCutoverFenceState } from '../firestore-v2-adoption.js';
import { startFakeAdmin } from './support/fake-admin.mjs';
import { OPT, assertCanOwnMounts, containerGateOpen, releaseMounts } from './support/mounts.mjs';
import { argvFor, fixtureFor, mountFixture, runFactory, runStep, scopeUnionUnchecked, sessionSecretOf } from './support/runner-harness.mjs';
import { EMULATOR, EPOCH, resetFencedNamespace, seedDocs, snapshotNamespace } from './support/emulator-seed.js';

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE_SOURCE = resolve(here, '..', 'cutover-protocol.mjs');
const NS = 'mcp';
const gateOpen = containerGateOpen();

// The open scope as the reviewed core writes it, and its closed synthetic form. Only the scope fields change.
const OPEN_SCOPE_TEXT = 'complete: false,\n    unscanned: Object.freeze(["sibling services", "terraform", "workflows"]),';
const CLOSED_SCOPE_TEXT = 'complete: true,\n    unscanned: Object.freeze([]),';

describe.skipIf(!gateOpen)('positive integration on a synthetic closed scope (emulator, protected runner)', () => {
  let bundleBytes: Buffer;
  let closedBundle: Buffer;
  let db: Firestore;
  let admin: { close: () => Promise<void> } | null = null;

  beforeAll(() => {
    assertCanOwnMounts();
    bundleBytes = readFileSync(BUNDLE_SOURCE);
    const text = bundleBytes.toString('utf8');
    expect(text.split(OPEN_SCOPE_TEXT).length - 1, 'open scope text must appear exactly once').toBe(1);
    let synthetic = text.replace(OPEN_SCOPE_TEXT, CLOSED_SCOPE_TEXT);
    const mutation = process.env.CUTOVER_PROOF_MUTATION;
    const mutations: Record<string, Array<readonly [string, string]>> = {
      'first-write-latch': [['if (!control.irreversible) {', 'if (false) {']],
      'malformed-marker': [
        ['validateMigrationIdentityFields(m, namespace, expectedEpoch, migrationRunId);', 'void m;'],
        ['if (f[k] !== p[k] || m[k] !== p[k]) {', 'if (f[k] !== p[k]) {'],
      ],
      'unexpected-target': [['if (!expectedWrittenTargets.has(targetKey)) {', 'if (false) {']],
      'finalization-latch': [['if (markerDoc.emptyNamespace !== true && !control.irreversible) {', 'if (false) {']],
    };
    if (mutation) {
      if (!mutations[mutation]) throw new Error(`Unknown proof mutation ${mutation}`);
      for (const [before, after] of mutations[mutation]) {
        if (synthetic.split(before).length !== 2) throw new Error(`Mutation anchor is not unique: ${mutation}`);
        synthetic = synthetic.replace(before, after);
      }
    }
    closedBundle = Buffer.from(synthetic, 'utf8');
    db = new Firestore(EMULATOR);
  });
  afterEach(async () => {
    if (admin) { await admin.close(); admin = null; }
  });

  afterAll(async () => {
    if (admin) await admin.close();
    releaseMounts();
    await db.terminate();
  });
  async function emptyReadyFixture() {
    if (admin) { await admin.close(); admin = null; }
    await resetFencedNamespace(db, NS);
    const collectionGroups = scopeUnionUnchecked(NS);
    const fixture = fixtureFor({ bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, collectionGroups });
    admin = await startFakeAdmin({ databaseResource: fixture.index.provenance.databaseResource, policy: fixture.index.policy, token: 'owner' });
    const inspected = await runStep({ bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, action: 'inspect', collectionGroups });
    expect(inspected.ok, inspected.message).toBe(true);
    const committed = await runStep({
      bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, action: 'adopt',
      options: { dryRun: false, expectedSourceInventoryDigest: inspected.sourceInventoryDigest }, collectionGroups,
    });
    expect(committed.ok, committed.message).toBe(true);
    const ready = await getCutoverFenceRecord(db as unknown as FirestoreLike, NS);
    expect(ready).toMatchObject({ state: 'v3_ready', emptyNamespace: true, irreversible: false });
    return { collectionGroups, options: { migrationManifestDigest: ready!.migrationManifestDigest! } };
  }

  async function assertMarkerRefusal(edit: (marker: Record<string, unknown>) => Record<string, unknown>, diagnostic: RegExp) {
    const { collectionGroups, options } = await emptyReadyFixture();
    const markerRef = db.collection(`${NS}_meta`).doc('v2_adopted');
    const marker = (await markerRef.get()).data()!;
    await markerRef.set(edit({ ...marker }));
    const before = await snapshotNamespace(db, NS);
    const refused = await runStep({ bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, action: 'activate', options, collectionGroups });
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(diagnostic);
    expect(await snapshotNamespace(db, NS)).toEqual(before);
    await markerRef.set(marker);
    const restored = await runStep({ bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, action: 'activate', options, collectionGroups });
    expect(restored.ok, restored.message).toBe(true);
  }

  it('signed activation refuses a wrong marker run ID without writes', async () => {
    await assertMarkerRefusal((marker) => ({ ...marker, migrationRunId: 'wrong-run' }), /migrationRunId mismatch/i);
  });
  it('signed activation refuses a missing marker field without writes', async () => {
    await assertMarkerRefusal((marker) => { delete marker.codeSha; return marker; }, /Missing required field.*codeSha/i);
  });
  it('signed activation refuses an unsupported marker schema without writes', async () => {
    await assertMarkerRefusal((marker) => ({ ...marker, schemaVersion: 99 }), /schemaVersion/i);
  });
  it('signed activation refuses an unexpected target without writes', async () => {
    const { collectionGroups, options } = await emptyReadyFixture();
    const unexpected = db.collection(`${NS}_sessions`).doc('unexpected-target');
    await unexpected.set({ status: 'unexpected' });
    const before = await snapshotNamespace(db, NS);
    const refused = await runStep({ bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, action: 'activate', options, collectionGroups });
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/extra target document/i);
    expect(await snapshotNamespace(db, NS)).toEqual(before);
  });

  it('a signed fixture over the synthetic closed scope passes inspect, dry-run, and commit to v3_ready', async () => {
    await resetFencedNamespace(db, NS);
    const familyId = 'fam-closed-positive';
    const now = Date.now();
    await seedDocs(db, [
      [`${NS}_tokens_refresh_families/${familyId}`, {
        id: familyId,
        currentAccessToken: 'closed-acc',
        currentRefreshToken: 'closed-ref',
        retiredRefreshFingerprints: [],
        updatedAt: now,
      }],
      [`${NS}_tokens_refresh/closed-ref`, {
        accessToken: 'closed-acc',
        familyId,
        status: 'active',
        token: {
          accessToken: 'closed-acc',
          refreshToken: 'closed-ref',
          clientId: 'closed-client',
          expiresAt: now + 3600_000,
          serverBaseUrl: 'http://localhost:3000',
          nsAccessToken: 'ns-closed',
          nsRefreshToken: 'ns-closed-ref',
          nsUsername: 'closed@domain.com',
        },
      }],
      [`${NS}_tokens_upstream/${familyId}`, {
        grant: { access_token: 'ns-closed', refresh_token: 'ns-closed-ref', username: 'closed@domain.com' },
        expiresAt: now + 3600_000,
        updatedAt: now,
      }],
      [`${NS}_tokens/closed-acc`, { accessToken: 'closed-acc', refreshToken: 'closed-ref', refreshFamilyId: familyId, clientId: 'closed-client' }],
    ]);

    // The fake Admin serves the fixture's signed index. Its groups are the reviewed groups, unchecked here: the
    // factory compares them with the closed scope's groups, which is the gate under proof.
    const collectionGroups = scopeUnionUnchecked(NS);
    const fixture = fixtureFor({ bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, collectionGroups });
    admin = await startFakeAdmin({
      databaseResource: fixture.index.provenance.databaseResource,
      policy: fixture.index.policy,
      token: 'owner',
    });

    const inspected = await runStep({ bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, action: 'inspect', collectionGroups })
    expect(inspected.ok, `inspect refused: ${inspected.message}`).toBe(true);
    const digest = inspected.sourceInventoryDigest as string;
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    // The dry run writes nothing: the fence stays fenced and no v3 document appears.
    const dry = await runStep({
      bundleBytes: closedBundle,
      namespace: NS,
      epoch: EPOCH,
      action: 'adopt',
      options: { dryRun: true, expectedSourceInventoryDigest: digest },
      collectionGroups,
    })
    expect(dry.ok, `dry run refused: ${dry.message}`).toBe(true);
    expect(dry.report?.errors).toBe(0);
    expect((await getCutoverFenceRecord(db as unknown as FirestoreLike, NS))?.state).toBe('fenced');

    // Pause the actual Firestore SDK transaction after the real engine has authorized the signed request,
    // mutate the caller's key, then release the SDK transaction. Later reads prove original-key persistence.
    const options = { dryRun: false, expectedSourceInventoryDigest: digest };
    mountFixture(fixture, 'adopt', options);
    writeFileSync(resolve(OPT, 'runner.mjs'), readFileSync(resolve(here, 'support', 'key-race-runner.mjs')));
    const committed = await runFactory(argvFor('adopt', NS, options));
    expect(committed.paused).toBe(true);
    expect(committed.ok, `commit refused: ${committed.message}`).toBe(true);
    expect(committed.report?.errors).toBe(0);
    expect(committed.report?.migrated).toBe(1);

    const ctrl = await getCutoverFenceRecord(db as unknown as FirestoreLike, NS);
    expect(ctrl?.state).toBe('v3_ready');
    expect(ctrl?.irreversible).toBe(true);
    await expect(transitionCutoverFenceState(db as unknown as FirestoreLike, NS, {
      toState: 'legacy_open', expectedEpoch: EPOCH,
    })).rejects.toThrow();
    // Reads are served only once the fence is v3_active; v3_ready is the post-commit, pre-activation state.
    const activated = await runStep({
      bundleBytes: closedBundle,
      namespace: NS,
      epoch: EPOCH,
      action: 'activate',
      options: { migrationManifestDigest: ctrl!.migrationManifestDigest! },
      collectionGroups,
    });
    expect(activated.ok, `activation refused: ${activated.message}`).toBe(true);
    expect(activated.result?.status).toBe('activated');
    expect((await getCutoverFenceRecord(db as unknown as FirestoreLike, NS))?.state).toBe('v3_active');

    // The v3 store reads the migrated session with the factory's key, from the same synthetic bundle's secret.
    const store = createFirestoreStore({ db: db as unknown as FirestoreLike, namespace: NS, key: deriveStoreKey(sessionSecretOf(fixture)) });
    const session = await store.sessions.get('closed-acc');
    expect(session?.clientId).toBe('closed-client');
    expect(session?.nsUsername).toBe('closed@domain.com');
    const mutatedKeyStore = createFirestoreStore({ db: db as unknown as FirestoreLike, namespace: NS, key: Buffer.alloc(32) });
    expect(await mutatedKeyStore.sessions.get('closed-acc')).toBeUndefined();
    await store.clients.registerClient({ redirect_uris: ['https://example.test/callback'], token_endpoint_auth_method: 'none' });
    const retry = await runStep({
      bundleBytes: closedBundle,
      namespace: NS,
      epoch: EPOCH,
      action: 'activate',
      options: { migrationManifestDigest: ctrl!.migrationManifestDigest! },
      collectionGroups,
    });
    expect(retry.ok, `activation retry refused: ${retry.message}`).toBe(true);
    expect(retry.result?.status).toBe('already_active');
  });

  it('signed empty migration activates without a latch, rejects a malformed marker, and latches on the first write', async () => {
    if (admin) { await admin.close(); admin = null; }
    await resetFencedNamespace(db, NS);
    const collectionGroups = scopeUnionUnchecked(NS);
    const fixture = fixtureFor({ bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, collectionGroups });
    admin = await startFakeAdmin({ databaseResource: fixture.index.provenance.databaseResource, policy: fixture.index.policy, token: 'owner' });
    const inspected = await runStep({ bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, action: 'inspect', collectionGroups });
    expect(inspected.ok, inspected.message).toBe(true);
    const committed = await runStep({
      bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, action: 'adopt',
      options: { dryRun: false, expectedSourceInventoryDigest: inspected.sourceInventoryDigest }, collectionGroups,
    });
    expect(committed.ok, committed.message).toBe(true);
    expect(committed.report?.errors).toBe(0);
    expect(committed.report?.migrated).toBe(0);
    const ready = await getCutoverFenceRecord(db as unknown as FirestoreLike, NS);
    expect(ready).toMatchObject({ state: 'v3_ready', emptyNamespace: true, irreversible: false });
    const prepared = (await db.collection(`${NS}_meta`).doc(`migration_prepared_${EPOCH}`).get()).data();
    const final = (await db.collection(`${NS}_meta`).doc(`migration_manifest_${EPOCH}`).get()).data();
    expect(prepared?.kind).toBe('prepared');
    expect(final?.kind).toBe('final');
    expect(Object.values(prepared!.physicalCounts).every((count) => count === 0)).toBe(true);
    expect(Object.values(final!.targetCounts).every((count) => count === 0)).toBe(true);
    const markerRef = db.collection(`${NS}_meta`).doc('v2_adopted');
    const marker = (await markerRef.get()).data();
    expect(marker).toMatchObject({ kind: 'ownership', emptyNamespace: true });
    const activationOptions = { migrationManifestDigest: ready!.migrationManifestDigest! };
    const unexpectedTarget = db.collection(`${NS}_sessions`).doc('unexpected');
    await unexpectedTarget.set({ status: 'unexpected' });
    const withUnexpectedTarget = await snapshotNamespace(db, NS);
    const nonempty = await runStep({ bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, action: 'activate', options: activationOptions, collectionGroups });
    expect(nonempty.ok).toBe(false);
    expect(nonempty.message).toMatch(/extra target document/i);
    expect(await snapshotNamespace(db, NS)).toEqual(withUnexpectedTarget);
    expect((await getCutoverFenceRecord(db as unknown as FirestoreLike, NS))?.state).toBe('v3_ready');
    await unexpectedTarget.delete();
    const missingField = { ...marker };
    delete missingField.codeSha;
    for (const [invalid, diagnostic] of [
      [{ ...marker, migrationRunId: 'wrong-run' }, /migrationRunId mismatch/i],
      [missingField, /Missing required field.*codeSha/i],
      [{ ...marker, schemaVersion: 99 }, /schemaVersion/i],
    ] as const) {
      await markerRef.set(invalid);
      const beforeRefusal = await snapshotNamespace(db, NS);
      const refused = await runStep({ bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, action: 'activate', options: activationOptions, collectionGroups });
      expect(refused.ok).toBe(false);
      expect(refused.message).toMatch(diagnostic);
      expect(await snapshotNamespace(db, NS)).toEqual(beforeRefusal);
      await markerRef.set(marker!);
    }
    const activated = await runStep({ bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, action: 'activate', options: activationOptions, collectionGroups });
    expect(activated.ok, activated.message).toBe(true);
    expect((await getCutoverFenceRecord(db as unknown as FirestoreLike, NS))).toMatchObject({ state: 'v3_active', irreversible: false });
    const activeSnapshot = await snapshotNamespace(db, NS);
    const retry = await runStep({ bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, action: 'activate', options: activationOptions, collectionGroups });
    expect(retry.ok, retry.message).toBe(true);
    expect(retry.result?.status).toBe('already_active');
    expect(await snapshotNamespace(db, NS)).toEqual(activeSnapshot);
    const store = createFirestoreStore({ db: db as unknown as FirestoreLike, namespace: NS, key: deriveStoreKey(sessionSecretOf(fixture)) });
    const beforeAbort = await snapshotNamespace(db, NS);
    const runTransaction = db.runTransaction.bind(db);
    const abort = vi.spyOn(db, 'runTransaction').mockImplementation(async (callback, options) => runTransaction(async (transaction) => {
      await callback(transaction);
      throw new Error('injected credential transaction abort');
    }, options));
    try {
      await expect(store.clients.registerClient({ redirect_uris: ['https://example.test/abort'], token_endpoint_auth_method: 'none' }))
        .rejects.toThrow(/injected credential transaction abort/);
    } finally {
      abort.mockRestore();
    }
    expect(await snapshotNamespace(db, NS)).toEqual(beforeAbort);
    await store.clients.registerClient({ redirect_uris: ['https://example.test/callback'], token_endpoint_auth_method: 'none' });
    const active = await getCutoverFenceRecord(db as unknown as FirestoreLike, NS);
    expect(active).toMatchObject({ state: 'v3_active', irreversible: true, emptyNamespace: false });
    await expect(transitionCutoverFenceState(db as unknown as FirestoreLike, NS, {
      toState: 'legacy_open', expectedEpoch: EPOCH,
    })).rejects.toThrow();
  });

  it('packed private v3 guard atomically latches a real credential write and rejects aborts and bad markers', async () => {
    if (admin) { await admin.close(); admin = null; }
    const modulePath = process.env.CUTOVER_PRIVATE_PROTOCOL_FILE;
    if (!modulePath) throw new Error('CUTOVER_PRIVATE_PROTOCOL_FILE is required for packed private guard proof');
    // The path selects the exact independently packed private artifact at runtime.
    const privateKit = await import(pathToFileURL(modulePath).href);
    await resetFencedNamespace(db, NS);
    const collectionGroups = scopeUnionUnchecked(NS);
    const fixture = fixtureFor({ bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, collectionGroups });
    admin = await startFakeAdmin({ databaseResource: fixture.index.provenance.databaseResource, policy: fixture.index.policy, token: 'owner' });
    const inspected = await runStep({ bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, action: 'inspect', collectionGroups });
    expect(inspected.ok, inspected.message).toBe(true);
    const committed = await runStep({
      bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, action: 'adopt',
      options: { dryRun: false, expectedSourceInventoryDigest: inspected.sourceInventoryDigest }, collectionGroups,
    });
    expect(committed.ok, committed.message).toBe(true);
    const ready = await getCutoverFenceRecord(db as unknown as FirestoreLike, NS);
    const activated = await runStep({
      bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, action: 'activate',
      options: { migrationManifestDigest: ready!.migrationManifestDigest! }, collectionGroups,
    });
    expect(activated.ok, activated.message).toBe(true);
    expect((await getCutoverFenceRecord(db as unknown as FirestoreLike, NS))).toMatchObject({ state: 'v3_active', irreversible: false });
    const credential = db.collection(`${NS}_sessions`).doc('private-guard-credential');
    const row = { familyId: 'private-guard-family', expiresAt: Date.now() + 60000, retainUntil: Date.now() + 120000, sealed: 'test-only-sealed', v: 2, ttlAt: new Date(Date.now() + 120000) };
    const beforeAbort = await snapshotNamespace(db, NS);
    await expect(db.runTransaction(async (transaction) => {
      const guard = await privateKit.checkV3MutationGuardInTransaction(transaction, {
        db, namespace: NS, timer: privateKit.startMonotonicTimer(),
      });
      guard.bufferMutation();
      transaction.set(credential, row);
      throw new Error('injected private guard abort');
    })).rejects.toThrow(/injected private guard abort/);
    expect(await snapshotNamespace(db, NS)).toEqual(beforeAbort);
    expect((await credential.get()).exists).toBe(false);
    await db.runTransaction(async (transaction) => {
      const guard = await privateKit.checkV3MutationGuardInTransaction(transaction, {
        db, namespace: NS, timer: privateKit.startMonotonicTimer(),
      });
      guard.bufferMutation();
      transaction.set(credential, row);
      guard.assertPreReturn();
    });
    expect((await credential.get()).data()).toMatchObject({ familyId: row.familyId, sealed: row.sealed, v: 2 });
    expect(await getCutoverFenceRecord(db as unknown as FirestoreLike, NS)).toMatchObject({ state: 'v3_active', irreversible: true, emptyNamespace: false });
    const markerRef = db.collection(`${NS}_meta`).doc('v2_adopted');
    const marker = (await markerRef.get()).data()!;
    await markerRef.set({ schemaVersion: 99 }, { merge: true });
    const beforeRefusal = await snapshotNamespace(db, NS);
    await expect(db.runTransaction(async (transaction) => {
      const guard = await privateKit.checkV3MutationGuardInTransaction(transaction, {
        db, namespace: NS, timer: privateKit.startMonotonicTimer(),
      });
      guard.bufferMutation();
      transaction.set(db.collection(`${NS}_sessions`).doc('must-not-write'), row);
    })).rejects.toThrow(/schemaVersion/i);
    expect(await snapshotNamespace(db, NS)).toEqual(beforeRefusal);
    expect((await db.collection(`${NS}_sessions`).doc('must-not-write').get()).exists).toBe(false);
    await markerRef.set(marker);
  });

  it('refuses an altered prepared snapshot before writing an item', async () => {
    if (admin) { await admin.close(); admin = null; }
    await resetFencedNamespace(db, NS);
    const family = 'prepared-race-family';
    const source = {
      accessToken: 'prepared-race-access', refreshToken: 'prepared-race-refresh',
      refreshFamilyId: family, clientId: 'prepared-race-client',
    };
    await seedDocs(db, [
      [`${NS}_tokens_refresh_families/${family}`, {
        id: family, currentAccessToken: source.accessToken, currentRefreshToken: source.refreshToken,
        retiredRefreshFingerprints: [], updatedAt: Date.now(),
      }],
      [`${NS}_tokens_refresh/${source.refreshToken}`, {
        familyId: family, status: 'active', accessToken: source.accessToken,
        token: { ...source, expiresAt: Date.now() + 3600_000, nsAccessToken: 'upstream', nsRefreshToken: 'refresh', nsUsername: 'test@example.test' },
      }],
      [`${NS}_tokens_upstream/${family}`, {
        grant: { access_token: 'upstream', refresh_token: 'refresh', username: 'test@example.test' },
        expiresAt: Date.now() + 3600_000, updatedAt: Date.now(),
      }],
      [`${NS}_tokens/${source.accessToken}`, source],
    ]);
    const collectionGroups = scopeUnionUnchecked(NS);
    const fixture = fixtureFor({ bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, collectionGroups });
    admin = await startFakeAdmin({ databaseResource: fixture.index.provenance.databaseResource, policy: fixture.index.policy, token: 'owner' });
    const inspected = await runStep({ bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, action: 'inspect', collectionGroups });
    expect(inspected.ok, inspected.message).toBe(true);
    const options = { dryRun: false, expectedSourceInventoryDigest: inspected.sourceInventoryDigest };
    mountFixture(fixture, 'adopt', options);
    writeFileSync(resolve(OPT, 'runner.mjs'), readFileSync(resolve(here, 'support', 'prepared-race-runner.mjs')));
    const result = await runFactory(argvFor('adopt', NS, options));
    expect(result.mutated).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Prepared manifest changed before item transaction');
    expect((await db.collection(`${NS}_tokens`).doc(source.accessToken).get()).data()).toEqual(source);
    expect((await db.collection(`${NS}_sessions`).get()).empty).toBe(true);
    expect((await getCutoverFenceRecord(db as unknown as FirestoreLike, NS))?.state).toBe('migrating');
  });

  it('signed nonempty finalization refuses a lost irreversible latch', async () => {
    if (admin) { await admin.close(); admin = null; }
    await resetFencedNamespace(db, NS);
    const family = 'latch-race-family';
    const source = {
      accessToken: 'latch-race-access', refreshToken: 'latch-race-refresh',
      refreshFamilyId: family, clientId: 'latch-race-client',
    };
    const sourceDocs: Array<readonly [string, Record<string, unknown>]> = [
      [`${NS}_tokens_refresh_families/${family}`, {
        id: family, currentAccessToken: source.accessToken, currentRefreshToken: source.refreshToken,
        retiredRefreshFingerprints: [], updatedAt: Date.now(),
      }],
      [`${NS}_tokens_refresh/${source.refreshToken}`, {
        familyId: family, status: 'active', accessToken: source.accessToken,
        token: { ...source, expiresAt: Date.now() + 3600_000, nsAccessToken: 'upstream', nsRefreshToken: 'refresh', nsUsername: 'test@example.test' },
      }],
      [`${NS}_tokens_upstream/${family}`, {
        grant: { access_token: 'upstream', refresh_token: 'refresh', username: 'test@example.test' },
        expiresAt: Date.now() + 3600_000, updatedAt: Date.now(),
      }],
      [`${NS}_tokens/${source.accessToken}`, source],
    ];
    await seedDocs(db, sourceDocs);
    const collectionGroups = scopeUnionUnchecked(NS);
    const fixture = fixtureFor({ bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, collectionGroups });
    admin = await startFakeAdmin({ databaseResource: fixture.index.provenance.databaseResource, policy: fixture.index.policy, token: 'owner' });
    const inspected = await runStep({ bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, action: 'inspect', collectionGroups });
    expect(inspected.ok, inspected.message).toBe(true);
    const options = { dryRun: false, expectedSourceInventoryDigest: inspected.sourceInventoryDigest };
    mountFixture(fixture, 'adopt', options);
    writeFileSync(resolve(OPT, 'runner.mjs'), readFileSync(resolve(here, 'support', 'latch-race-runner.mjs')));
    const result = await runFactory(argvFor('adopt', NS, options));
    expect(result.altered).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/irreversible/i);
    const targets = await db.collection(`${NS}_sessions`).get();
    const metadata = await db.collection(`${NS}_meta`).get();
    const receipts = metadata.docs.filter((doc) => doc.id.startsWith(`migration_receipt_${EPOCH}_`));
    const digest = (docs: typeof metadata.docs) => createHash('sha256').update(JSON.stringify(
      docs.map((doc) => [doc.id, doc.data()]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    )).digest('hex');
    expect(targets.size).toBeGreaterThan(0);
    expect(receipts).toHaveLength(targets.size);
    expect(result.committedTargets).toEqual({ count: targets.size, digest: digest(targets.docs) });
    expect(result.committedReceipts).toEqual({ count: receipts.length, digest: digest(receipts) });
    expect((await db.collection(`${NS}_meta`).doc(`migration_manifest_${EPOCH}`).get()).exists).toBe(false);
    expect((await db.collection(`${NS}_meta`).doc('v2_adopted').get()).exists).toBe(false);
    expect((await getCutoverFenceRecord(db as unknown as FirestoreLike, NS))?.state).toBe('migrating');
    await resetFencedNamespace(db, NS);
    await seedDocs(db, sourceDocs);
    const cleanInspect = await runStep({ bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, action: 'inspect', collectionGroups });
    expect(cleanInspect.ok, cleanInspect.message).toBe(true);
    const clean = await runStep({
      bundleBytes: closedBundle, namespace: NS, epoch: EPOCH, action: 'adopt',
      options: { dryRun: false, expectedSourceInventoryDigest: cleanInspect.sourceInventoryDigest }, collectionGroups,
    });
    expect(clean.ok, clean.message).toBe(true);
    expect(await getCutoverFenceRecord(db as unknown as FirestoreLike, NS)).toMatchObject({ state: 'v3_ready', irreversible: true });
  });
});
