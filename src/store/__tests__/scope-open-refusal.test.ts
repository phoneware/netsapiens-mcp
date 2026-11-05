// Real production bundle, unmodified, with the reviewed scope OPEN (complete:false). Every protected action must
// refuse at the factory's scope gate, and the emulator store must be byte-identical before and after. This is
// the production hold: nothing here mounts a synthetic bundle, and nothing here asserts a positive.
// Runs only where containerGateOpen() holds. Never touches an existing /opt/cutover or /run/cutover.
import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeAdmin } from './support/fake-admin.mjs';
import { productionBundleBytes } from './support/closed-bundle.mjs';
import { assertCanOwnMounts, containerGateOpen, releaseMounts } from './support/mounts.mjs';
import { fixtureFor, runStep, scopeUnionUnchecked } from './support/runner-harness.mjs';
import { EMULATOR, EPOCH, resetFencedNamespace, seedDocs, snapshotNamespace } from './support/emulator-seed.js';

const NS = 'mcp';
const OPEN_REFUSAL = /Runtime collection scope is incomplete/;

describe.skipIf(!containerGateOpen())('production bundle with the reviewed scope open refuses every action', () => {
  let bundleBytes: Buffer;
  let db: Firestore;
  let admin: { close: () => Promise<void> } | null = null;

  beforeAll(async () => {
    assertCanOwnMounts();
    bundleBytes = productionBundleBytes();
    db = new Firestore(EMULATOR);
    await resetFencedNamespace(db, NS);
    const now = Date.now();
    await seedDocs(db, [
      [`${NS}_tokens_refresh_families/open-fam`, { id: 'open-fam', currentAccessToken: 'open-acc', currentRefreshToken: 'open-ref', retiredRefreshFingerprints: [], updatedAt: now }],
      [`${NS}_tokens_refresh/open-ref`, { accessToken: 'open-acc', familyId: 'open-fam', status: 'active', token: { accessToken: 'open-acc', refreshToken: 'open-ref', clientId: 'open-client', expiresAt: now + 3600_000, nsAccessToken: 'ns-open', nsRefreshToken: 'ns-open-ref', nsUsername: 'open@domain.com' } }],
      [`${NS}_tokens_upstream/open-fam`, { grant: { access_token: 'ns-open', refresh_token: 'ns-open-ref', username: 'open@domain.com' }, expiresAt: now + 3600_000, updatedAt: now }],
    ]);
    const fixture = fixtureFor({ bundleBytes, namespace: NS, epoch: EPOCH, collectionGroups: scopeUnionUnchecked(NS) });
    admin = await startFakeAdmin({ databaseResource: fixture.index.provenance.databaseResource, policy: fixture.index.policy, token: 'owner' });
  });

  afterAll(async () => {
    if (admin) await admin.close();
    releaseMounts();
    await db.terminate();
  });

  it('refuses inspect, dry run, and commit at the scope gate with no write to the store', async () => {
    const before = await snapshotNamespace(db, NS);
    const groups = scopeUnionUnchecked(NS);

    const inspected = await runStep({ bundleBytes, namespace: NS, epoch: EPOCH, action: 'inspect', collectionGroups: groups })
    expect(inspected.ok).toBe(false);
    expect(String(inspected.message)).toMatch(OPEN_REFUSAL);

    const digest = '0'.repeat(64);
    const dry = await runStep({ bundleBytes, namespace: NS, epoch: EPOCH, action: 'adopt', options: { dryRun: true, expectedSourceInventoryDigest: digest }, collectionGroups: groups })
    expect(dry.ok).toBe(false);
    expect(String(dry.message)).toMatch(OPEN_REFUSAL);

    const commit = await runStep({ bundleBytes, namespace: NS, epoch: EPOCH, action: 'adopt', options: { dryRun: false, expectedSourceInventoryDigest: digest }, collectionGroups: groups })
    expect(commit.ok).toBe(false);
    expect(String(commit.message)).toMatch(OPEN_REFUSAL);

    expect(await snapshotNamespace(db, NS)).toEqual(before);
  });
});
