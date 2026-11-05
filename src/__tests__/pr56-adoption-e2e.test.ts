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
import { getCutoverFenceRecord, transitionCutoverFenceState } from '../store/firestore-v2-adoption.js';
import { startFakeAdmin } from '../store/__tests__/support/fake-admin.mjs';
import { assertCanOwnMounts, containerGateOpen, releaseMounts } from '../store/__tests__/support/mounts.mjs';
import { fixtureFor, runStep, sessionSecretOf } from '../store/__tests__/support/runner-harness.mjs';
import { EMULATOR, EPOCH, resetFencedNamespace, seedDocs } from '../store/__tests__/support/emulator-seed.js';
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

  it('adopts PR56 session where access doc is absent, preserves clientId and seatId, and exchanges successfully', async () => {
    const legacyRefreshToken = 'tok-refresh-valid';
    const legacyAccessToken = 'tok-access-expired';
    const familyId = 'fam-1';
    const expectedClientId = 'pr56-surviving-client';

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
        accessToken: legacyAccessToken,
        familyId,
        status: 'active',
        token: {
          accessToken: legacyAccessToken,
          refreshToken: legacyRefreshToken,
          clientId: expectedClientId,
          expiresAt: Date.now() - 1000,
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
    expect(adopted.report?.migrated).toBe(1);

    // 8. Move to v3_active with the run the runner recorded, then open the v3 store with the factory's key.
    const key = deriveStoreKey(sessionSecretOf(fixture));
    const ctrl = await getCutoverFenceRecord(db as unknown as FirestoreLike, NS);
    expect(ctrl?.state).toBe('v3_ready');
    await transitionCutoverFenceState(db as unknown as FirestoreLike, NS, {
      fromState: 'v3_ready',
      toState: 'v3_active',
      expectedEpoch: ctrl!.epoch,
      migrationRunId: ctrl!.migrationRunId!,
      migrationManifestDigest: ctrl!.migrationManifestDigest!,
    });
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
    }

    // 10. A mismatched client ID rejects the lookup.
    const wrongClientLookup = await store.sessions.lookupRefresh(legacyRefreshToken, 'wrong-client', Date.now());
    expect(wrongClientLookup.status).toBe('missing');

    // 11. The /token refresh exchange. The NetSapiens token endpoint is mocked once; any other upstream call
    // is refused, so no live vendor request is sent.
    const provider = new NetSapiensAuthProvider({
      platforms: [{ id: 'default', label: 'Default', apiUrl: 'https://ns.example.com' }],
      nsApiUrl: 'https://ns.example.com',
      nsClientId: 'test-client',
      nsClientSecret: 'test-secret',
      serverBaseUrl: 'http://localhost:3000',
      store,
    } as any);
    vi.spyOn(axios, 'post')
      .mockResolvedValueOnce({ data: { access_token: 'ns-tok-new', refresh_token: 'ns-ref-new', expires_in: 3600 } })
      .mockRejectedValue(new Error('unmocked upstream call refused'));

    const tokens = await provider.exchangeRefreshToken({ client_id: expectedClientId } as any, legacyRefreshToken);
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
