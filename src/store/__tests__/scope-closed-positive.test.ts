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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveStoreKey } from '../codec.js';
import { createFirestoreStore, type FirestoreLike } from '../firestore.js';
import { getCutoverFenceRecord } from '../firestore-v2-adoption.js';
import { startFakeAdmin } from './support/fake-admin.mjs';
import { OPT, assertCanOwnMounts, containerGateOpen, releaseMounts } from './support/mounts.mjs';
import { argvFor, fixtureFor, mountFixture, runFactory, runStep, scopeUnionUnchecked, sessionSecretOf } from './support/runner-harness.mjs';
import { EMULATOR, EPOCH, resetFencedNamespace, seedDocs } from './support/emulator-seed.js';

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
    closedBundle = Buffer.from(text.replace(OPEN_SCOPE_TEXT, CLOSED_SCOPE_TEXT), 'utf8');
    db = new Firestore(EMULATOR);
  });

  afterAll(async () => {
    if (admin) await admin.close();
    releaseMounts();
    await db.terminate();
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
});
