// PR56 retired refresh token replay, ported from the MockFirestore test onto the genuine protected runner and
// the Firestore emulator. The legacy family carries a SHA-256 base64url fingerprint of a retired token; the
// runner adopts it and writes the retired row; presenting the old token must report replay and revoke the
// family. Runs only where containerGateOpen() holds. Never touches an existing /opt/cutover or /run/cutover.
// UNVERIFIED until run under the gate.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveStoreKey } from '../store/codec.js';
import { createFirestoreStore, type FirestoreLike } from '../store/firestore.js';
import { getCutoverFenceRecord } from '../store/firestore-v2-adoption.js';
import { startFakeAdmin } from '../store/__tests__/support/fake-admin.mjs';
import { assertCanOwnMounts, containerGateOpen, releaseMounts } from '../store/__tests__/support/mounts.mjs';
import { fixtureFor, runStep, sessionSecretOf } from '../store/__tests__/support/runner-harness.mjs';
import { EMULATOR, EPOCH, resetFencedNamespace, seedDocs } from '../store/__tests__/support/emulator-seed.js';
import { closedBundleBytes } from '../store/__tests__/support/closed-bundle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const NS = 'mcp';
const gateOpen = containerGateOpen();

describe.skipIf(!gateOpen)('PR56 Retired Refresh Token Replay Detection (emulator, runner)', () => {
  let bundleBytes: Buffer;
  let db: Firestore;

  beforeAll(() => {
    assertCanOwnMounts();
    bundleBytes = closedBundleBytes();
    expect(bundleBytes.toString('utf8')).toContain('createProtectedFirestoreMigrationContext');
    db = new Firestore(EMULATOR);
  });

  afterAll(async () => {
    releaseMounts();
    await db.terminate();
  });

  it('detects replay when an old PR56 retired token (SHA-256 base64url fingerprint) is presented and revokes family', async () => {
    const oldRetiredToken = 'old-pr56-token-123';
    const legacyShaFingerprint = createHash('sha256').update(oldRetiredToken).digest('base64url');

    const currentActiveRefresh = 'current-pr56-refresh';
    const currentActiveAccess = 'current-pr56-access';
    const familyId = 'fam-with-retired-history';
    const clientId = 'pr56-client';

    // 1. Fenced namespace at the runner epoch, then the legacy family with the retired fingerprint.
    await resetFencedNamespace(db, NS);
    await seedDocs(db, [
      [`${NS}_tokens_refresh_families/${familyId}`, {
        id: familyId,
        currentAccessToken: currentActiveAccess,
        currentRefreshToken: currentActiveRefresh,
        retiredRefreshFingerprints: [legacyShaFingerprint],
        updatedAt: Date.now(),
      }],
      // 2. Active refresh pointer.
      [`${NS}_tokens_refresh/${currentActiveRefresh}`, {
        accessToken: currentActiveAccess,
        familyId,
        status: 'active',
        token: {
          accessToken: currentActiveAccess,
          refreshToken: currentActiveRefresh,
          clientId,
          expiresAt: Date.now() + 3600_000,
          nsAccessToken: 'ns-tok',
          nsRefreshToken: 'ns-ref',
          nsUsername: 'alice@domain.com',
        },
      }],
      // 3. Upstream grant.
      [`${NS}_tokens_upstream/${familyId}`, {
        grant: { access_token: 'ns-tok', refresh_token: 'ns-ref', username: 'alice@domain.com' },
        expiresAt: Date.now() + 3600_000,
        updatedAt: Date.now(),
      }],
    ]);

    // 4. The fake Admin serves the fixture's signed index; inspect supplies the digest; the runner adopts.
    const fixture = fixtureFor({ bundleBytes, namespace: NS, epoch: EPOCH });
    const admin = await startFakeAdmin({
      databaseResource: fixture.index.provenance.databaseResource,
      policy: fixture.index.policy,
      token: 'owner',
    });
    try {
      const inspected = await runStep({ bundleBytes, namespace: NS, epoch: EPOCH, action: 'inspect' })
      expect(inspected.ok).toBe(true);
      const adopted = await runStep({
        bundleBytes,
        namespace: NS,
        epoch: EPOCH,
        action: 'adopt',
        options: { dryRun: false, expectedSourceInventoryDigest: inspected.sourceInventoryDigest },
      })
      expect(adopted.ok).toBe(true);
      expect(adopted.report?.errors).toBe(0);
      expect(adopted.report?.migrated).toBe(1);
      const prepared = (await db.collection(`${NS}_meta`).doc(`migration_prepared_${EPOCH}`).get()).data();
      expect(prepared?.physicalCounts).toMatchObject({ families: 1, refresh: 1, upstream: 1, tokens: 0 });
      expect(prepared?.totalPhysicalRecords).toBe(3);

      // The runner writes the retired fingerprint as a row that points at the family.
      const retiredRow = await db.collection(`${NS}_retired_refresh`).doc(legacyShaFingerprint).get();
      expect(retiredRow.exists).toBe(true);
      expect(retiredRow.data()).toEqual({ familyId });
      const ctrl = await getCutoverFenceRecord(db as unknown as FirestoreLike, NS);
      expect(ctrl?.state).toBe('v3_ready');
      const activated = await runStep({
        bundleBytes, namespace: NS, epoch: EPOCH, action: 'activate',
        options: { migrationManifestDigest: ctrl!.migrationManifestDigest! }
      });
      expect(activated.ok, activated.message).toBe(true);
    } finally {
      await admin.close();
    }

    // 5. Move to v3_active with the run the runner recorded, then open the v3 store with the factory's key.
    const key = deriveStoreKey(sessionSecretOf(fixture));
    const store = createFirestoreStore({ db: db as unknown as FirestoreLike, namespace: NS, key });

    // 6. Presenting the old retired token is detected as replay for its family.
    const replayLookup = await store.sessions.lookupRefresh(oldRetiredToken, clientId, Date.now());
    expect(replayLookup.status).toBe('replay');
    if (replayLookup.status === 'replay') {
      expect(replayLookup.familyId).toBe(familyId);
    }

    // 7. The family is revoked: the active refresh no longer resolves, and its session is gone.
    const activeLookup = await store.sessions.lookupRefresh(currentActiveRefresh, clientId, Date.now());
    expect(activeLookup.status).toBe('missing');

    const session = await store.sessions.get(currentActiveAccess);
    expect(session).toBeUndefined();
  });
});
