// PR56 adoption end to end, ported from the MockFirestore test onto the genuine protected runner and the
// Firestore emulator. Legacy state is seeded in the emulator; the runner adopts it; the v3 store is then read
// with the store key the factory derives from the mounted session secret. The NetSapiens token endpoint is
// mocked, and any other upstream call is refused, so this test performs no live vendor write.
// Runs only where containerGateOpen() holds. Never touches an existing /opt/cutover or /run/cutover.
// UNVERIFIED until run under the gate.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Firestore } from '@google-cloud/firestore';
import axios from 'axios';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NetSapiensAuthProvider } from '../auth/netsapiens-auth-provider.js';
import { deriveStoreKey } from '../store/codec.js';
import { createFirestoreStore, type FirestoreLike } from '../store/firestore.js';
import { getCutoverFenceRecord } from '../store/firestore-v2-adoption.js';
import { startFakeAdmin } from '../store/__tests__/support/fake-admin.mjs';
import { assertCanOwnMounts, containerGateOpen, releaseMounts } from '../store/__tests__/support/mounts.mjs';
import { fixtureFor, runStep, sessionSecretOf } from '../store/__tests__/support/runner-harness.mjs';
import { EMULATOR, EPOCH, resetFencedNamespace, seedDocs, snapshotNamespace } from '../store/__tests__/support/emulator-seed.js';
import { closedBundleBytes } from '../store/__tests__/support/closed-bundle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const NS = 'mcp';
const gateOpen = containerGateOpen();

describe.skipIf(!gateOpen)('PR56 Firestore Adoption E2E: TTL-deleted access doc + nested grant shape (emulator, runner)', () => {
  let bundleBytes: Buffer;
  let db: Firestore;
  let admin: { close: () => Promise<void> } | null = null;

  beforeAll(() => {
    assertCanOwnMounts();
    bundleBytes = closedBundleBytes();
    expect(bundleBytes.toString('utf8')).toContain('createProtectedFirestoreMigrationContext');
    db = new Firestore(EMULATOR);
  });

  afterEach(async () => {
    if (admin) await admin.close();
    admin = null;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    releaseMounts();
    await db.terminate();
  });
  it('refuses incomplete or mismatched missing-access evidence without writes', async () => {
    const now = Date.now();
    const valid = { accessToken: 'access/one', refreshToken: 'refresh/one', clientId: 'client', expiresAt: now + 60000, extra: { seatId: 'same-seat' } };
    const variants = [
      { field: 'accessToken', value: '' }, { field: 'refreshToken', value: '' },
      { field: 'clientId', value: '' }, { field: 'expiresAt', value: 0 },
      { field: 'accessToken', value: 'access.one' }, { field: 'refreshToken', value: 'refresh.one' },
      { field: 'familyId', value: 'other-family' },
    ];
    for (const variant of variants) {
      if (admin) { await admin.close(); admin = null; }
      await resetFencedNamespace(db, NS);
      const token = { ...valid, [variant.field]: variant.value };
      await seedDocs(db, [
        [`${NS}_tokens_refresh_families/family`, { currentAccessToken: valid.accessToken, currentRefreshToken: valid.refreshToken }],
        [`${NS}_tokens_refresh/refresh_one`, { familyId: 'family', status: 'active', token }],
        [`${NS}_tokens_upstream/family`, { nsAccessToken: 'upstream', nsUsername: 'user' }],
      ]);
      const fixture = fixtureFor({ bundleBytes, namespace: NS, epoch: EPOCH });
      admin = await startFakeAdmin({ databaseResource: fixture.index.provenance.databaseResource, policy: fixture.index.policy, token: 'owner' });
      const before = await snapshotNamespace(db, NS);
      const inspected = await runStep({ bundleBytes, namespace: NS, epoch: EPOCH, action: 'inspect' });
      if (inspected.ok) {
        expect((inspected.reasons?.missingAccessTokens ?? 0) + (inspected.reasons?.missingRefreshPointers ?? 0) +
          (inspected.reasons?.malformedRecords ?? 0) + (inspected.reasons?.conflictingClaims ?? 0)).toBeGreaterThan(0);
        const refused = await runStep({
          bundleBytes, namespace: NS, epoch: EPOCH, action: 'adopt',
          options: { dryRun: false, expectedSourceInventoryDigest: inspected.sourceInventoryDigest }
        });
        expect(refused.ok).toBe(false);
        expect(refused.message).toMatch(/Cannot prepare migration/);
      } else {
        expect(inspected.message).toMatch(/Source active refresh access identity mismatch|Embedded refresh family identity mismatch|Conflicting or malformed credential identity/);
      }
      expect(await snapshotNamespace(db, NS)).toEqual(before);
    }
  });
  it('refuses a surviving source changed after inspection without migration writes', async () => {
    await resetFencedNamespace(db, NS);
    const token = { accessToken: 'ttl-access', refreshToken: 'ttl-refresh', clientId: 'client', expiresAt: Date.now() + 60000 };
    await seedDocs(db, [
      [`${NS}_tokens_refresh_families/family`, { currentAccessToken: token.accessToken, currentRefreshToken: token.refreshToken }],
      [`${NS}_tokens_refresh/ttl-refresh`, { familyId: 'family', status: 'active', token }],
      [`${NS}_tokens_upstream/family`, { nsAccessToken: 'original', nsUsername: 'same-user' }],
    ]);
    const fixture = fixtureFor({ bundleBytes, namespace: NS, epoch: EPOCH });
    admin = await startFakeAdmin({ databaseResource: fixture.index.provenance.databaseResource, policy: fixture.index.policy, token: 'owner' });
    const inspected = await runStep({ bundleBytes, namespace: NS, epoch: EPOCH, action: 'inspect' });
    expect(inspected.ok, inspected.message).toBe(true);
    await db.collection(`${NS}_tokens_upstream`).doc('family').update({ nsAccessToken: 'changed' });
    const before = await snapshotNamespace(db, NS);
    const refused = await runStep({
      bundleBytes, namespace: NS, epoch: EPOCH, action: 'adopt',
      options: { dryRun: false, expectedSourceInventoryDigest: inspected.sourceInventoryDigest },
    });
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/Source inventory digest mismatch/);
    expect(await snapshotNamespace(db, NS)).toEqual(before);
  });

  it.each([true, false])('adopts absent access with refresh-level access alias present=%s and exchanges successfully', async (includeAccessAlias) => {
    const legacyRefreshToken = 'tok-refresh-valid';
    const legacyAccessToken = 'tok-access-expired';
    const familyId = 'fam-1';
    const expectedClientId = 'pr56-surviving-client';
    const legacyExpiry = Date.now() - 1000;

    // 1. Fenced namespace at the runner epoch, then the PR #56 legacy rows.
    await resetFencedNamespace(db, NS);
    await seedDocs(db, [
      // 2. Legacy families collection.
      [`${NS}_tokens_refresh_families/${familyId}`, {
        id: familyId,
        currentAccessToken: legacyAccessToken,
        currentRefreshToken: legacyRefreshToken,
        retiredRefreshFingerprints: [],
        updatedAt: Date.now(),
      }],
      // 3. Legacy refresh collection, which holds the authoritative embedded token.
      [`${NS}_tokens_refresh/${legacyRefreshToken}`, {
        ...(includeAccessAlias ? { accessToken: legacyAccessToken } : {}),
        familyId,
        status: 'active',
        token: {
          accessToken: legacyAccessToken,
          refreshToken: legacyRefreshToken,
          clientId: expectedClientId,
          expiresAt: legacyExpiry,
          serverBaseUrl: 'http://localhost:3000',
          nsAccessToken: 'ns-tok-legacy',
          nsRefreshToken: 'ns-ref-legacy',
          nsUsername: 'alice@domain.com',
          extra: { seatId: 'seat-42' },
        },
      }],
      // 4. Legacy upstream collection with the nested grant map.
      [`${NS}_tokens_upstream/${familyId}`, {
        grant: {
          access_token: 'ns-tok-upstream',
          refresh_token: 'ns-ref-upstream',
          username: 'alice@domain.com',
          user_role: 'admin',
          api_url: 'https://ns.example.com',
        },
        expiresAt: Date.now() + 3600_000,
        updatedAt: Date.now(),
      }],
      // 5. The access document in `${NS}_tokens` is absent (TTL-deleted), so it is not seeded.
    ]);

    // 6. The fake Admin serves the fixture's signed index for the runner's index reads.
    const fixture = fixtureFor({ bundleBytes, namespace: NS, epoch: EPOCH });
    admin = await startFakeAdmin({
      databaseResource: fixture.index.provenance.databaseResource,
      policy: fixture.index.policy,
      token: 'owner',
    });

    // 7. Inspect supplies the digest, then the runner adopts in commit mode.
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

    // 8. Move to v3_active with the run the runner recorded, then open the v3 store with the factory's key.
    const key = deriveStoreKey(sessionSecretOf(fixture));
    const ctrl = await getCutoverFenceRecord(db as unknown as FirestoreLike, NS);
    expect(ctrl?.state).toBe('v3_ready');
    const activated = await runStep({
      bundleBytes, namespace: NS, epoch: EPOCH, action: 'activate',
      options: { migrationManifestDigest: ctrl!.migrationManifestDigest! }
    });
    expect(activated.ok, activated.message).toBe(true);
    const store = createFirestoreStore({ db: db as unknown as FirestoreLike, namespace: NS, key });

    // 9. lookupRefresh resolves clientId and seatId from the active refresh pointer.
    const lookup = await store.sessions.lookupRefresh(legacyRefreshToken, expectedClientId, Date.now());
    expect(lookup.status).toBe('active');
    if (lookup.status === 'active') {
      expect(lookup.session.clientId).toBe(expectedClientId);
      expect(lookup.session.extra?.seatId).toBe('seat-42');
      expect(lookup.session.nsUsername).toBe('alice@domain.com');
      expect(lookup.session.nsAccessToken).toBe('ns-tok-upstream');
      expect(lookup.session.nsRefreshToken).toBe('ns-ref-upstream');
      expect(lookup.session.expiresAt).toBe(legacyExpiry);
    }

    const upstreamPost = vi.spyOn(axios, 'post')
      .mockResolvedValueOnce({ data: { access_token: 'ns-tok-new', refresh_token: 'ns-ref-new', expires_in: 3600 } })
      .mockRejectedValue(new Error('unmocked upstream call refused'));
    // 10. A mismatched client ID rejects the lookup.
    const wrongClientLookup = await store.sessions.lookupRefresh(legacyRefreshToken, 'wrong-client', Date.now());
    expect(wrongClientLookup.status).toBe('missing');
    expect(upstreamPost).not.toHaveBeenCalled();

    // 11. Exercise the provider refresh exchange. The upstream token endpoint is mocked; no live call is sent.
    const provider = new NetSapiensAuthProvider({
      platforms: [{ id: 'default', label: 'Default', apiUrl: 'https://ns.example.com' }],
      nsApiUrl: 'https://ns.example.com',
      nsClientId: 'test-client',
      nsClientSecret: 'test-secret',
      serverBaseUrl: 'http://localhost:3000',
      store,
    } as any);
    await expect(provider.verifyAccessToken(legacyAccessToken)).rejects.toThrow(/Access token expired/);

    const tokens = await provider.exchangeRefreshToken({ client_id: expectedClientId } as any, legacyRefreshToken);
    expect(upstreamPost).toHaveBeenCalledTimes(1);
    expect(upstreamPost.mock.calls[0][1]).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'ns-ref-upstream' });
    expect(tokens.access_token).toBeDefined();
    expect(tokens.refresh_token).toBeDefined();
    expect(tokens.token_type).toBe('Bearer');

    // 12. The new session keeps the client ID and the preserved seat ID.
    const newSession = await store.sessions.get(tokens.access_token);
    expect(newSession).toBeDefined();
    expect(newSession?.clientId).toBe(expectedClientId);
    expect(newSession?.extra?.seatId).toBe('seat-42');
    expect(newSession?.nsAccessToken).toBe('ns-tok-new');
  });
});
