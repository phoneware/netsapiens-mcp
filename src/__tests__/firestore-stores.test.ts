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
import { Timestamp } from '@google-cloud/firestore';
import { NetSapiensAuthProvider } from '../auth/netsapiens-auth-provider.js';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Request, Response } from 'express';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
 FirestoreTokenStore,
 FirestoreClientsStore,
 FirestoreAuthCodeStore,
} from '../auth/firestore-stores.js';
const emulatorRunning = !!process.env.FIRESTORE_EMULATOR_HOST;

// Vitest doesn't expose a top-level skip without describe/it, so we gate
// the suite with describe.skipIf and surface a hint if the env isn't set.
if (!emulatorRunning) {
 // eslint-disable-next-line no-console
 console.warn(
  '[firestore-stores.test] FIRESTORE_EMULATOR_HOST not set: skipping. ' +
  'Start the emulator with `gcloud beta emulators firestore start --host-port=localhost:8080` ' +
  'and export FIRESTORE_EMULATOR_HOST=localhost:8080 to run these tests.',
 );
}
function deferred<T = unknown>() {
 let resolve!: (value: T | PromiseLike<T>) => void;
 let reject!: (reason?: unknown) => void;
 const promise = new Promise<T>((res, rej) => {
  resolve = res;
  reject = rej;
 });
 return { promise, resolve, reject };
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

 it('persists across reads: getClient returns the registered object', async () => {
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

describe.skipIf(!emulatorRunning)('FirestoreAuthCodeStore (emulator)', () => {
 let store: FirestoreAuthCodeStore;

 beforeAll(async () => {
  process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'firestore-test';
  store = new FirestoreAuthCodeStore({
   collection: `auth_codes_${randomBytes(4).toString('hex')}`,
   projectId: process.env.GOOGLE_CLOUD_PROJECT,
  });
 });

 it('round-trips set, getChallenge, and single-use redeem in a transaction', async () => {
  const code = 'code-123';
  await store.set(code, {
   pending: {
    clientId: 'test-client',
    codeChallenge: 'challenge-abc',
    redirectUri: 'http://localhost/cb',
    createdAt: Date.now(),
   },
   nsTokens: {
    access_token: 'ns-tok',
    username: 'alice@domain.com',
    expires_in: 3600,
   },
   extra: { seat: 'seat-1' },
  });

  const challenge = await store.getChallenge(code);
  expect(challenge).toBe('challenge-abc');

  const redeemed = await store.redeem(code);
  expect(redeemed).toBeTruthy();
  expect(redeemed?.pending.clientId).toBe('test-client');
  expect(redeemed?.extra).toEqual({ seat: 'seat-1' });

  // Second redeem fails (single-use)
  const secondRedeem = await store.redeem(code);
  expect(secondRedeem).toBeUndefined();
  expect(await store.getChallenge(code)).toBeUndefined();
 });

 it('expired codes return undefined', async () => {
  const code = 'code-expired';
  await store.set(code, {
   pending: {
    clientId: 'test-client',
    codeChallenge: 'chal',
    redirectUri: 'http://localhost/cb',
    createdAt: Date.now() - 600_000,
   },
   nsTokens: { access_token: 'ns-tok', username: 'alice@domain.com' },
   expiresAt: Date.now() - 1000,
  });

  expect(await store.getChallenge(code)).toBeUndefined();
  expect(await store.redeem(code)).toBeUndefined();
 });
});

describe.skipIf(!emulatorRunning)('Multi-instance coordination (emulator)', () => {
 beforeAll(() => {
  process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'firestore-test';
 });

 it('a code issued by one provider instance is redeemed by a second instance sharing the Firestore emulator', async () => {
  const authCodesCollection = `codes_${randomBytes(4).toString('hex')}`;
  const tokensCollection = `tokens_${randomBytes(4).toString('hex')}`;
  const clientsCollection = `clients_${randomBytes(4).toString('hex')}`;

  process.env.MCP_PERSISTENCE = 'firestore';
  const provider1 = new NetSapiensAuthProvider({
   nsApiUrl: 'https://edge.phoneware.cloud',
   nsClientId: 'cid',
   nsClientSecret: 'sec',
   serverBaseUrl: 'http://localhost:3000',
   collections: {
    authCodes: authCodesCollection,
    tokens: tokensCollection,
    clients: clientsCollection,
   },
  });

  const provider2 = new NetSapiensAuthProvider({
   nsApiUrl: 'https://edge.phoneware.cloud',
   nsClientId: 'cid',
   nsClientSecret: 'sec',
   serverBaseUrl: 'http://localhost:3000',
   collections: {
    authCodes: authCodesCollection,
    tokens: tokensCollection,
    clients: clientsCollection,
   },
  });

  const client: OAuthClientInformationFull = {
   client_id: 'client-abc',
   redirect_uris: ['http://localhost/cb'],
   token_endpoint_auth_method: 'none',
  };

  let redirectUrl = '';
  const res = {
   redirect: (url: string) => { redirectUrl = url; },
  } as unknown as import('express').Response;

  await (provider1 as unknown as { completeLogin: (...args: unknown[]) => Promise<void> }).completeLogin(
   { clientId: 'client-abc', codeChallenge: 'chal-xyz', redirectUri: 'http://localhost/cb', createdAt: Date.now() },
   { access_token: 'ns-tok', username: 'user@dom.com', expires_in: 3600 },
   'user@dom.com',
   res,
   { extraFlag: 'instance1-extra' },
  );

  const code = new URL(redirectUrl).searchParams.get('code')!;
  expect(code).toBeTruthy();

  // Instance 2 verifies challenge and redeems code!
  const challenge = await provider2.challengeForAuthorizationCode(client, code);
  expect(challenge).toBe('chal-xyz');

  const tokens = await provider2.exchangeAuthorizationCode(client, code);
  expect(tokens.access_token).toBeTruthy();

  // Single-use check: redeeming again fails
  await expect(provider2.exchangeAuthorizationCode(client, code)).rejects.toThrow(InvalidGrantError);

  // Verify StoredToken on provider2 carries extra
  const stored = await (provider2 as unknown as { tokenStore: { get: (t: string) => Promise<import('../auth/types.js').StoredToken> } }).tokenStore.get(tokens.access_token);
  expect(stored.extra).toEqual({ extraFlag: 'instance1-extra' });
 });

 it('fails across instances when using the old in-memory auth codes map', async () => {
  process.env.MCP_PERSISTENCE = 'file';
  const provider1 = new NetSapiensAuthProvider({
   nsApiUrl: 'https://edge.phoneware.cloud',
   nsClientId: 'cid',
   nsClientSecret: 'sec',
   serverBaseUrl: 'http://localhost:3000',
  });
  const provider2 = new NetSapiensAuthProvider({
   nsApiUrl: 'https://edge.phoneware.cloud',
   nsClientId: 'cid',
   nsClientSecret: 'sec',
   serverBaseUrl: 'http://localhost:3000',
  });

  const client: OAuthClientInformationFull = {
   client_id: 'client-abc',
   redirect_uris: ['http://localhost/cb'],
   token_endpoint_auth_method: 'none',
  };

  let redirectUrl = '';
  const res = { redirect: (url: string) => { redirectUrl = url; } } as unknown as import('express').Response;

  await (provider1 as unknown as { completeLogin: (...args: unknown[]) => Promise<void> }).completeLogin(
   { clientId: 'client-abc', codeChallenge: 'chal-mem', redirectUri: 'http://localhost/cb', createdAt: Date.now() },
   { access_token: 'ns-tok', username: 'user@dom.com', expires_in: 3600 },
   'user@dom.com',
   res,
  );

  const code = new URL(redirectUrl).searchParams.get('code')!;
  // Instance 2 does not have code in its in-memory map
  await expect(provider2.challengeForAuthorizationCode(client, code)).rejects.toThrow(InvalidGrantError);
 });

 it('two instances refreshing the same expiring NS token make one upstream refresh', async () => {
  const collection = `tokens_${randomBytes(4).toString('hex')}`;
  const store1 = new FirestoreTokenStore({
   collection,
   projectId: process.env.GOOGLE_CLOUD_PROJECT,
  });
  const store2 = new FirestoreTokenStore({
   collection,
   projectId: process.env.GOOGLE_CLOUD_PROJECT,
  });

  // Seed token expiring in 10s (within 60s skew)
  await store1.set({
   accessToken: 'mcp-shared-token',
   refreshToken: 'mcp-shared-refresh',
   clientId: 'client-1',
   expiresAt: Date.now() + 3600_000,
   nsAccessToken: 'old-ns-token',
   nsRefreshToken: 'ns-refresh-token',
   nsExpiresAt: Date.now() + 10_000,
   nsUsername: 'shared@domain.com',
   nsUserRole: 'domain_admin',
  });

  let refreshCallCount = 0;
  const doRefresh = async () => {
   refreshCallCount++;
   await Promise.resolve();
   return {
    access_token: 'new-ns-token-from-upstream',
    refresh_token: 'new-ns-refresh-token',
    expires_in: 3600,
   };
  };

  const [res1, res2] = await Promise.all([
   store1.refreshNsToken('mcp-shared-token', doRefresh),
   store2.refreshNsToken('mcp-shared-token', doRefresh),
  ]);

  expect(refreshCallCount).toBe(1);
  expect(res1.nsAccessToken).toBe('new-ns-token-from-upstream');
  expect(res2.nsAccessToken).toBe('new-ns-token-from-upstream');
 });

 it('a code from the read-only server is refused at the writable one', async () => {
  const authCodesCollection = `codes_${randomBytes(4).toString('hex')}`;
  const clientsCollection = `clients_${randomBytes(4).toString('hex')}`;

  process.env.MCP_PERSISTENCE = 'firestore';
  const readOnlyProvider = new NetSapiensAuthProvider({
   nsApiUrl: 'https://edge.phoneware.cloud',
   nsClientId: 'cid',
   nsClientSecret: 'sec',
   serverBaseUrl: 'https://mcp-readonly.edge.phoneware.cloud',
   collections: {
    authCodes: authCodesCollection,
    clients: clientsCollection,
   },
  });

  const writableProvider = new NetSapiensAuthProvider({
   nsApiUrl: 'https://edge.phoneware.cloud',
   nsClientId: 'cid',
   nsClientSecret: 'sec',
   serverBaseUrl: 'https://mcp.edge.phoneware.cloud',
   collections: {
    authCodes: authCodesCollection,
    clients: clientsCollection,
   },
  });

  const client: OAuthClientInformationFull = {
   client_id: 'client-abc',
   redirect_uris: ['http://localhost/cb'],
   token_endpoint_auth_method: 'none',
  };

  let redirectUrl = '';
  const res = {
   redirect: (url: string) => { redirectUrl = url; },
  } as unknown as Response;

  await (readOnlyProvider as unknown as { completeLogin: (...args: unknown[]) => Promise<void> }).completeLogin(
   { clientId: 'client-abc', codeChallenge: 'chal-xyz', redirectUri: 'http://localhost/cb', createdAt: Date.now() },
   { access_token: 'ns-tok', username: 'user@dom.com', expires_in: 3600 },
   'user@dom.com',
   res,
  );

  const code = new URL(redirectUrl).searchParams.get('code')!;
  expect(code).toBeTruthy();

  // Challenge and redemption at writable provider must be refused!
  await expect(writableProvider.challengeForAuthorizationCode(client, code)).rejects.toThrow(InvalidGrantError);
  await expect(writableProvider.exchangeAuthorizationCode(client, code)).rejects.toThrow(InvalidGrantError);
 });

 it('a slow winning refresh does not cause the waiter request to delete the token', async () => {
  const collection = `tokens_${randomBytes(4).toString('hex')}`;
  const store1 = new FirestoreTokenStore({
   collection,
   projectId: process.env.GOOGLE_CLOUD_PROJECT,
  });
  const store2 = new FirestoreTokenStore({
   collection,
   projectId: process.env.GOOGLE_CLOUD_PROJECT,
  });

  const bearerToken = 'mcp-bearer-slow-refresh';
  await store1.set({
   accessToken: bearerToken,
   refreshToken: 'mcp-refresh',
   clientId: 'client-1',
   expiresAt: Date.now() + 3600_000,
   nsAccessToken: 'old-ns-token',
   nsRefreshToken: 'ns-refresh-token',
   nsExpiresAt: Date.now() - 5_000,
   nsUsername: 'shared@domain.com',
   nsUserRole: 'domain_admin',
  });

  const { promise: slowRefreshPromise, resolve: resolveSlowRefresh } = deferred<unknown>();

  const inst1Promise = store1.refreshNsToken(bearerToken, async () => {
   await slowRefreshPromise;
   return {
    access_token: 'new-ns-token-slow',
    refresh_token: 'new-ns-refresh-token',
    expires_in: 3600,
   };
  });

  // Give store1 time to acquire the lock
  await new Promise((r) => setTimeout(r, 100));

  // Store 2 waiter times out rather than waiting forever.
  // It must fail with a retryable error, NOT return the stale expired token.
  await expect(
   store2.refreshNsToken(
    bearerToken,
    async () => ({ access_token: 'should-not-run', expires_in: 3600 }),
    { maxWaitMs: 300, pollIntervalMs: 50 },
   ),
  ).rejects.toThrow();

  // The bearer token must NOT have been deleted from Firestore!
  const surviving = await store1.get(bearerToken);
  expect(surviving).toBeDefined();

  // Resolve instance 1's refresh
  resolveSlowRefresh(null);
  const refreshed = await inst1Promise;
  expect(refreshed.nsAccessToken).toBe('new-ns-token-slow');

  const finalToken = await store1.get(bearerToken);
  expect(finalToken?.nsAccessToken).toBe('new-ns-token-slow');
 });

 it('an abandoned lease becomes acquirable by the next waiter', async () => {
  const collection = `tokens_${randomBytes(4).toString('hex')}`;
  const store = new FirestoreTokenStore({
   collection,
   projectId: process.env.GOOGLE_CLOUD_PROJECT,
  });

  const bearerToken = 'mcp-bearer-abandoned-lease';
  await store.set({
   accessToken: bearerToken,
   refreshToken: 'mcp-refresh',
   clientId: 'client-1',
   expiresAt: Date.now() + 3600_000,
   nsAccessToken: 'old-ns-token',
   nsRefreshToken: 'ns-refresh-token',
   nsExpiresAt: Date.now() - 5_000,
   nsUsername: 'shared@domain.com',
   nsUserRole: 'domain_admin',
  });

  // Simulate an abandoned lease by setting refreshLockUntil in the past
  await (store as unknown as { db: import('@google-cloud/firestore').Firestore; collection: string }).db
   .collection(collection)
   .doc(bearerToken)
   .update({
    refreshLockUntil: Date.now() - 1000,
    refreshLockOwner: 'crashed-instance',
   });

  const refreshed = await store.refreshNsToken(
   bearerToken,
   async () => ({
    access_token: 'new-ns-token-acquired',
    expires_in: 3600,
   }),
   { maxWaitMs: 1000, pollIntervalMs: 50 },
  );

  expect(refreshed.nsAccessToken).toBe('new-ns-token-acquired');
 });

 it('revoke during an in-flight refresh leaves the token revoked', async () => {
  const collection = `tokens_${randomBytes(4).toString('hex')}`;
  const store = new FirestoreTokenStore({
   collection,
   projectId: process.env.GOOGLE_CLOUD_PROJECT,
  });

  const bearerToken = 'mcp-bearer-revoke-during-refresh';
  await store.set({
   accessToken: bearerToken,
   refreshToken: 'mcp-refresh',
   clientId: 'client-1',
   expiresAt: Date.now() + 3600_000,
   nsAccessToken: 'old-ns-token',
   nsRefreshToken: 'ns-refresh-token',
   nsExpiresAt: Date.now() - 5_000,
   nsUsername: 'shared@domain.com',
   nsUserRole: 'domain_admin',
  });

  // Start refresh and delete/revoke the token while refresh is in flight
  await expect(
   store.refreshNsToken(bearerToken, async () => {
    // Delete/revoke while in flight
    await store.delete(bearerToken);
    return {
     access_token: 'new-ns-token-should-not-resurrect',
     refresh_token: 'new-ns-refresh-token',
     expires_in: 3600,
    };
   }),
  ).rejects.toThrow();

  // Deletion must be authoritative: token document must no longer exist!
  const surviving = await store.get(bearerToken);
  expect(surviving).toBeUndefined();
 });

 it('an expired lease late completion cannot overwrite newer credentials or clear new owner lease', async () => {
  const collection = `tokens_${randomBytes(4).toString('hex')}`;
  const store1 = new FirestoreTokenStore({
   collection,
   projectId: process.env.GOOGLE_CLOUD_PROJECT,
  });
  const store2 = new FirestoreTokenStore({
   collection,
   projectId: process.env.GOOGLE_CLOUD_PROJECT,
  });

  const bearerToken = 'mcp-bearer-lease-fence';
  await store1.set({
   accessToken: bearerToken,
   refreshToken: 'mcp-refresh',
   clientId: 'client-1',
   expiresAt: Date.now() + 3600_000,
   nsAccessToken: 'token-v1',
   nsRefreshToken: 'refresh-v1',
   nsExpiresAt: Date.now() - 5_000,
   nsUsername: 'shared@domain.com',
   nsUserRole: 'domain_admin',
  });

  const { promise: slowRefreshPromise, resolve: resolveSlowRefresh } = deferred<unknown>();

  // Store 1 starts refresh with short lease, but its refresh call hangs
  const store1Promise = store1.refreshNsToken(
   bearerToken,
   async () => {
    await slowRefreshPromise;
    return {
     access_token: 'token-late-store1',
     refresh_token: 'refresh-late-store1',
     expires_in: 3600,
    };
   },
   { maxWaitMs: 5000, leaseDurationMs: 100 },
  );

  // Wait for store1's lease to expire and store2 to take over
  await new Promise((r) => setTimeout(r, 200));

  // Store 2 completes a newer refresh
  const refreshedStore2 = await store2.refreshNsToken(
   bearerToken,
   async () => ({
    access_token: 'token-newer-store2',
    refresh_token: 'refresh-newer-store2',
    expires_in: 3600,
   }),
   { maxWaitMs: 5000, leaseDurationMs: 5000 },
  );
  expect(refreshedStore2.nsAccessToken).toBe('token-newer-store2');

  // Now let store 1 finish late
  resolveSlowRefresh(null);
  await expect(store1Promise).rejects.toThrow();

  // Verify store 1's late completion did NOT overwrite store 2's newer credentials
  const currentToken = await store2.get(bearerToken);
  expect(currentToken?.nsAccessToken).toBe('token-newer-store2');
 });

 it('second post of the same resume token is refused across instances', async () => {
  const resumeTokensCollection = `resume_${randomBytes(4).toString('hex')}`;
  const clientsCollection = `clients_${randomBytes(4).toString('hex')}`;
  const authCodesCollection = `codes_${randomBytes(4).toString('hex')}`;

  process.env.MCP_PERSISTENCE = 'firestore';
  const provider1 = new NetSapiensAuthProvider({
   nsApiUrl: 'https://edge.phoneware.cloud',
   nsClientId: 'cid',
   nsClientSecret: 'sec',
   serverBaseUrl: 'http://localhost:3000',
   collections: {
    resumeTokens: resumeTokensCollection,
    clients: clientsCollection,
    authCodes: authCodesCollection,
   },
   hooks: {
    async onLogin() {
     return {
      kind: 'interstitial',
      html: '<form action="/enroll"><input type="hidden" name="resume_token" value="{{RESUME_TOKEN}}"></form>',
     };
    },
   },
  });

  const provider2 = new NetSapiensAuthProvider({
   nsApiUrl: 'https://edge.phoneware.cloud',
   nsClientId: 'cid',
   nsClientSecret: 'sec',
   serverBaseUrl: 'http://localhost:3000',
   collections: {
    resumeTokens: resumeTokensCollection,
    clients: clientsCollection,
    authCodes: authCodesCollection,
   },
  });

  (provider1 as unknown as { nsPasswordGrant: unknown }).nsPasswordGrant = vi.fn().mockResolvedValue({
   kind: 'tokens',
   tokens: { access_token: 'ns-tok', expires_in: 3600, username: 'dan@domain.com' },
  });
  (provider1 as unknown as { detectNsUserInfo: unknown }).detectNsUserInfo = vi.fn().mockResolvedValue({
   user: 'dan',
   domain: 'domain.com',
   scope: 'Office Manager',
   role: 'domain_admin',
   displayName: 'Dan',
   email: 'dan@domain.com',
  });

  const client: OAuthClientInformationFull = {
   client_id: 'client-abc',
   redirect_uris: ['http://localhost/cb'],
   token_endpoint_auth_method: 'none',
  };

  const authResObj = { html: '', redirectUrl: '', status: 200 };
  const mockRes = {
   status(s: number) { authResObj.status = s; return this; },
   send(h: string) { authResObj.html = h; return this; },
   redirect(u: string) { authResObj.redirectUrl = u; return this; },
   set() { return this; },
   type() { return this; },
   setHeader() { return this; },
   getHeader() { return undefined; },
  } as unknown as Response;

  await provider1.authorize(client, { codeChallenge: 'c1', redirectUri: 'http://localhost/cb' } as unknown as AuthorizationParams, mockRes);
  const authState = authResObj.html.match(/name="auth_state" value="([^"]+)"/)![1];

  const loginResObj = { html: '', redirectUrl: '', status: 200 };
  const mockLoginRes = {
   status(s: number) { loginResObj.status = s; return this; },
   send(h: string) { loginResObj.html = h; return this; },
   redirect(u: string) { loginResObj.redirectUrl = u; return this; },
   set() { return this; },
   type() { return this; },
   setHeader() { return this; },
   getHeader() { return undefined; },
  } as unknown as Response;

  await provider1.handleLogin(
   { body: { auth_state: authState }, headers: {} } as unknown as Request,
   mockLoginRes,
   'dan@domain.com',
   'secret',
  );

  const resumeToken = loginResObj.html.match(/name="resume_token" value="([^"]+)"/)![1];
  expect(resumeToken).toBeTruthy();

  // First post on provider1 succeeds
  const resumeRes1Obj = { html: '', redirectUrl: '', status: 200 };
  const mockResumeRes1 = {
   status(s: number) { resumeRes1Obj.status = s; return this; },
   send(h: string) { resumeRes1Obj.html = h; return this; },
   redirect(u: string) { resumeRes1Obj.redirectUrl = u; return this; },
   set() { return this; },
   type() { return this; },
   setHeader() { return this; },
   getHeader() { return undefined; },
  } as unknown as Response;
  await provider1.resumeLogin(mockResumeRes1, resumeToken);
  expect(resumeRes1Obj.redirectUrl).toContain('http://localhost/cb?code=');

  // Second post on provider2 (sharing Firestore) must be refused!
  const resumeRes2Obj = { html: '', redirectUrl: '', status: 200 };
  const mockResumeRes2 = {
   status(s: number) { resumeRes2Obj.status = s; return this; },
   send(h: string) { resumeRes2Obj.html = h; return this; },
   redirect(u: string) { resumeRes2Obj.redirectUrl = u; return this; },
   set() { return this; },
   type() { return this; },
   setHeader() { return this; },
   getHeader() { return undefined; },
  } as unknown as Response;
  await provider2.resumeLogin(mockResumeRes2, resumeToken);
  expect(resumeRes2Obj.status).toBe(400);
  expect(resumeRes2Obj.redirectUrl).toBe('');
 });

 it('after a refresh the stored ttlAt is still a Timestamp', async () => {
  const collection = `tokens_${randomBytes(4).toString('hex')}`;
  const store = new FirestoreTokenStore({
   collection,
   projectId: process.env.GOOGLE_CLOUD_PROJECT,
  });

  const bearerToken = 'mcp-bearer-timestamp-test';
  await store.set({
   accessToken: bearerToken,
   refreshToken: 'mcp-refresh',
   clientId: 'client-1',
   expiresAt: Date.now() + 3600_000,
   nsAccessToken: 'old-ns-token',
   nsRefreshToken: 'ns-refresh-token',
   nsExpiresAt: Date.now() - 5_000,
   nsUsername: 'shared@domain.com',
   nsUserRole: 'domain_admin',
   ttlAt: new Date(Date.now() + 86400_000),
  });

  const rawSnapBefore = await (store as unknown as { db: import('@google-cloud/firestore').Firestore; collection: string }).db
   .collection(collection)
   .doc(bearerToken)
   .get();
  const rawDataBefore = rawSnapBefore.data()!;
  expect(rawDataBefore.ttlAt).toBeInstanceOf(Timestamp);

  // Perform refresh
  await store.refreshNsToken(bearerToken, async () => ({
   access_token: 'new-ns-token',
   expires_in: 3600,
  }));

  // Verify stored token in Firestore AFTER refresh STILL has ttlAt as a Timestamp
  const rawSnapAfter = await (store as unknown as { db: import('@google-cloud/firestore').Firestore; collection: string }).db
   .collection(collection)
   .doc(bearerToken)
   .get();
  const rawDataAfter = rawSnapAfter.data()!;
  expect(rawDataAfter.ttlAt).toBeInstanceOf(Timestamp);
 });
});
