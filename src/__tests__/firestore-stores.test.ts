/**
 * Integration tests for the Firestore-backed stores.
 *
 * Requires the Firestore emulator. The @google-cloud/firestore SDK
 * automatically routes to the emulator when FIRESTORE_EMULATOR_HOST is set.
 *
 * To run locally (Docker — no Java required):
 *   docker run -d --rm --name fs-emu -p 8088:8080 \
 *     gcr.io/google.com/cloudsdktool/cloud-sdk:emulators \
 *     gcloud beta emulators firestore start --host-port=0.0.0.0:8080
 *   FIRESTORE_EMULATOR_HOST=localhost:8088 GOOGLE_CLOUD_PROJECT=firestore-test \
 *     npx vitest run src/__tests__/firestore-stores.test.ts
 *   docker rm -f fs-emu
 *
 * Or with a local gcloud (requires Java 8+):
 *   gcloud beta emulators firestore start --host-port=localhost:8080 &
 *   FIRESTORE_EMULATOR_HOST=localhost:8080 npx vitest run …
 *
 * Without an emulator the suite skips cleanly with a hint.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

const emulatorRunning = !!process.env.FIRESTORE_EMULATOR_HOST;

// Vitest doesn't expose a top-level skip without describe/it, so we gate
// the suite with describe.skipIf and surface a hint if the env isn't set.
if (!emulatorRunning) {
  // eslint-disable-next-line no-console
  console.warn(
    '[firestore-stores.test] FIRESTORE_EMULATOR_HOST not set — skipping. ' +
      'Start the emulator with `gcloud beta emulators firestore start --host-port=localhost:8080` ' +
      'and export FIRESTORE_EMULATOR_HOST=localhost:8080 to run these tests.',
  );
}

describe.skipIf(!emulatorRunning)('FirestoreTokenStore (emulator)', () => {
  let store: import('../auth/firestore-token-store.js').FirestoreTokenStore;

  beforeAll(async () => {
    process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'firestore-test';
    const mod = await import('../auth/firestore-token-store.js');
    store = new mod.FirestoreTokenStore({
      collection: `tokens_${randomBytes(4).toString('hex')}`,
      projectId: process.env.GOOGLE_CLOUD_PROJECT,
    });
  });

  afterEach(() => {
    // The emulator is wiped per test run automatically when started fresh;
    // collisions are avoided by the random per-suite collection name.
  });

  it('round-trips set/get/getByRefreshToken', async () => {
    const token = {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      clientId: 'client-x',
      expiresAt: Date.now() + 60_000,
      nsAccessToken: 'ns-1',
      nsRefreshToken: 'ns-r-1',
      nsExpiresAt: Date.now() + 60_000,
      nsUsername: 'alice',
      nsUserRole: 'reseller',
    };
    await store.set(token);
    const hit = await store.get('access-1');
    expect(hit).toMatchObject(token);
    const viaRefresh = await store.getByRefreshToken('refresh-1');
    expect(viaRefresh?.accessToken).toBe('access-1');
  });

  it('update merges fields and reindexes the refresh token when it changes', async () => {
    await store.set({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      clientId: 'c',
      expiresAt: Date.now() + 60_000,
      nsAccessToken: 'ns',
      nsUsername: 'u',
    });
    const updated = await store.update('access-2', {
      nsAccessToken: 'ns-fresh',
      refreshToken: 'refresh-2-new',
    });
    expect(updated?.nsAccessToken).toBe('ns-fresh');
    expect(updated?.refreshToken).toBe('refresh-2-new');
    expect(await store.getByRefreshToken('refresh-2-new')).toBeTruthy();
    expect(await store.getByRefreshToken('refresh-2')).toBeUndefined();
  });

  it('delete removes both access and refresh indexes', async () => {
    await store.set({
      accessToken: 'access-3',
      refreshToken: 'refresh-3',
      clientId: 'c',
      expiresAt: Date.now() + 60_000,
      nsAccessToken: 'ns',
      nsUsername: 'u',
    });
    await store.delete('access-3');
    expect(await store.get('access-3')).toBeUndefined();
    expect(await store.getByRefreshToken('refresh-3')).toBeUndefined();
  });

  it('strips undefined fields so Firestore writes succeed', async () => {
    // nsRefreshToken/nsExpiresAt/nsUserRole are explicitly undefined
    await store.set({
      accessToken: 'access-4',
      refreshToken: 'refresh-4',
      clientId: 'c',
      expiresAt: Date.now() + 60_000,
      nsAccessToken: 'ns',
      nsRefreshToken: undefined,
      nsExpiresAt: undefined,
      nsUsername: 'u',
      nsUserRole: undefined,
    });
    const hit = await store.get('access-4');
    expect(hit?.accessToken).toBe('access-4');
    // Stripped fields come back as undefined, not as null or empty string
    expect(hit?.nsRefreshToken).toBeUndefined();
  });
});

describe.skipIf(!emulatorRunning)('FirestoreClientsStore (emulator)', () => {
  let store: import('../auth/firestore-clients-store.js').FirestoreClientsStore;

  beforeAll(async () => {
    process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'firestore-test';
    const mod = await import('../auth/firestore-clients-store.js');
    store = new mod.FirestoreClientsStore({
      collection: `clients_${randomBytes(4).toString('hex')}`,
      projectId: process.env.GOOGLE_CLOUD_PROJECT,
    });
  });

  it('issues client_secret for confidential clients', async () => {
    const c = await store.registerClient!({
      redirect_uris: ['http://localhost/cb'],
      client_name: 'confidential',
    } as never);
    expect(c.client_id).toBeTruthy();
    expect(c.client_secret).toBeTruthy();
    expect(await store.getClient(c.client_id)).toMatchObject({ client_id: c.client_id });
  });

  it('omits client_secret for public clients (token_endpoint_auth_method=none)', async () => {
    const c = await store.registerClient!({
      redirect_uris: ['https://chatgpt.com/cb'],
      client_name: 'public',
      token_endpoint_auth_method: 'none',
    } as never);
    expect(c.client_id).toBeTruthy();
    expect(c.client_secret).toBeUndefined();
  });

  it('persists across reads — getClient returns the registered object', async () => {
    const c = await store.registerClient!({
      redirect_uris: ['http://localhost/cb'],
      client_name: 'persists',
    } as never);
    const fetched = await store.getClient(c.client_id);
    expect(fetched).toEqual(c);
  });

  it('returns undefined for unknown client_id', async () => {
    expect(await store.getClient('not-a-real-id')).toBeUndefined();
  });
});
