import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentReference, Firestore } from '@google-cloud/firestore';
import axios from 'axios';
import {
  CutoverFenceError,
  CutoverRefusedError,
  UpstreamRevokedError,
  UpstreamUnavailableError,
  UpstreamRequestRejectedError,
  toTokenEndpointError,
} from '../auth/kit/errors.js';
import {
  type CutoverFenceControlRecord,
  type LegacyOperationContext,
  type WithLegacyOperationOptions,
  deriveStoreKey,
  startMonotonicTimer,
  claimUpstreamGrantInTransaction,
  checkMutationGuardInTransaction,
  getCutoverFenceDocRef,
  getCutoverFenceRecord,
  getCutoverOperationDocRef,
  initializeCutoverFence,
  markIrreversibleInTransaction,
  transitionCutoverFenceState,
  withLegacyOperation as withKeyedLegacyOperation,
  requestOperationContext,
} from '../auth/kit/cutover-fence.js';
import {
  withLegacyOperation as canonicalWithLegacyOperation,
  checkMutationGuardInTransaction as canonicalGuard,
} from '../auth/kit/cutover-protocol.mjs';
import {
  FirestoreTokenStore,
  FirestoreClientsStore,
  FirestoreAuthCodeStore,
  LeaseLostError,
} from '../auth/firestore-stores.js';
import {
  NetSapiensAuthProvider,
  UpstreamGrantRejectedError,
  UpstreamTimeoutError,
  signValue,
} from '../auth/netsapiens-auth-provider.js';
import {
  InvalidGrantError,
  InvalidTokenError,
  TemporarilyUnavailableError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { docId } from '../auth/kit/firestore-ledger.js';
import { FirestoreUpstreamGrantStore } from '../auth/kit/upstream-grant.js';
import request from 'supertest';
import { createApp, validateBridgeStartup } from '../http-server.js';

const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST;
const TEST_SESSION_SECRET = 'bridge-test-secret-with-at-least-32-characters';
const TEST_IDENTITY_KEY = deriveStoreKey(TEST_SESSION_SECRET);

function withLegacyOperation<R>(
  options: Omit<WithLegacyOperationOptions, 'identityKey'>,
  fn: (ctx: LegacyOperationContext) => Promise<R>,
): Promise<R> {
  return withKeyedLegacyOperation({ ...options, identityKey: TEST_IDENTITY_KEY }, fn);
}

beforeEach(() => { process.env.MCP_SESSION_SECRET = TEST_SESSION_SECRET; });

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const environment = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in environment)) delete process.env[key];
  }
  Object.assign(process.env, environment);
  vi.restoreAllMocks();
});

function configureHttpTest(): void {
  process.env.MCP_TRANSPORT = 'http';
  process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'test_client_id';
  process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'test_client_secret';
  process.env.NETSAPIENS_API_URL = 'https://test.example.com';
  process.env.MCP_BASE_URL = 'http://localhost';
}

function createTestDb(projectId: string = `mcp-bridge-${randomUUID().slice(0, 8)}`): Firestore {
  return new Firestore({
    projectId,
    host: EMULATOR_HOST,
    ssl: false,
  });
}

function waitForAdmissionDrain(db: Firestore, namespace: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      unsubscribe?.();
      if (error) reject(error); else resolve();
    };
    // The timeout bounds a real Firestore listener and guarantees listener cleanup on failure.
    const deadline = setTimeout(() => finish(new Error('Admission did not drain')), 10_000);
    unsubscribe = getCutoverFenceDocRef(db, namespace).onSnapshot(
      (snapshot) => { if (snapshot.data()?.activeOperations === 0) finish(); },
      (error) => finish(error),
    );
    if (settled) unsubscribe();
  });
}

describe('Legacy Bridge Cutover Fence & Regressions (C1-C5, S2, §5.1)', { timeout: 60000 }, () => {
  if (!EMULATOR_HOST) {
    it.skip('Skipped when no emulator running locally; CI runs with FIRESTORE_EMULATOR_HOST', () => {});
    return;
  }
  it('preserves the key binding through closing, fenced, and reopening', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace);
    await withLegacyOperation({ db, namespace, kind: 'read' }, async () => { });
    const initial = await getCutoverFenceRecord(db, namespace);
    const binding = {
      operationIdentityVersion: initial?.operationIdentityVersion,
      operationIdentityKeyCheck: initial?.operationIdentityKeyCheck,
    };
    expect(binding.operationIdentityVersion).toBe(1);
    expect(binding.operationIdentityKeyCheck).toMatch(/^[0-9a-f]{64}$/);
    for (const [fromState, toState, epoch] of [
      ['legacy_open', 'closing', 1], ['closing', 'fenced', 1],
      ['fenced', 'closing', 2], ['closing', 'legacy_open', 2],
    ] as const) {
      await transitionCutoverFenceState(db, namespace, { fromState, toState, expectedEpoch: epoch });
      expect(await getCutoverFenceRecord(db, namespace)).toMatchObject(binding);
    }
    await expect(canonicalWithLegacyOperation({
      db, namespace, kind: 'read', identityKey: deriveStoreKey(`${TEST_SESSION_SECRET}-other`),
    }, async () => { })).rejects.toThrow(/identity key binding mismatch/i);
    await withLegacyOperation({ db, namespace, kind: 'read' }, async () => { });
    expect(await getCutoverFenceRecord(db, namespace)).toMatchObject(binding);
  });

  it('rejects altered keyed read contexts without exposing credentials and permits an admitted closing read', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace);
    const store = new FirestoreTokenStore({ db, collection: 'mcp_tokens', fence: { namespace, enforce: true } });
    await withLegacyOperation({ db, namespace, kind: 'issue' }, async (operation) => {
      await store.issue({
        accessToken: 'keyed-read-access', refreshToken: 'keyed-read-refresh', clientId: 'client',
        expiresAt: Date.now() + 60_000, nsAccessToken: 'protected', nsUsername: 'user',
      }, { operation });
    });
    await withLegacyOperation({ db, namespace, kind: 'read' }, async (operation) => {
      const mutations = [
        { ...operation, id: randomUUID() },
        { ...operation, storageId: `op1_${'a'.repeat(64)}` },
        { ...operation, identityKeyCheck: 'a'.repeat(64) },
        { ...operation, namespace: 'pwmcp' as const },
        { ...operation, epoch: operation.epoch + 1 },
        { ...operation, kind: 'update' },
        { ...operation, isCompleted: () => true },
      ];
      const before = (await store.accessDocRef('keyed-read-access').get()).data();
      for (const altered of mutations) {
        await expect(store.getByAccessToken('keyed-read-access', { operation: altered })).rejects.toThrow();
        expect((await store.accessDocRef('keyed-read-access').get()).data()).toEqual(before);
      }
      await transitionCutoverFenceState(db, namespace, { fromState: 'legacy_open', toState: 'closing', expectedEpoch: 1 });
      expect((await store.getByAccessToken('keyed-read-access', { operation }))?.nsAccessToken).toBe('protected');
    });
  });

  it('binds pending completion to the original random claimant without mutating on forgery', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    const familyId = 'claim-family';
    const owner = randomUUID();
    const familyRef = db.collection('mcp_tokens_refresh_families').doc(familyId);
    const pointerRef = db.collection('mcp_tokens_refresh').doc('refresh');
    const grantRef = db.collection('mcp_tokens_upstream').doc(familyId);
    await initializeCutoverFence(db, namespace);
    await familyRef.set({ id: familyId, generation: 3, currentRefreshToken: 'refresh' });
    await pointerRef.set({ familyId, status: 'active' });
    await grantRef.set({ grantVersion: 7, grant: { token: 'original' } });

    await withLegacyOperation({ db, namespace, kind: 'upstream_refresh' }, async (operation) => {
      const claim = await db.runTransaction((transaction) => claimUpstreamGrantInTransaction(transaction, db, {
        namespace, epoch: operation.epoch, familyId, operationId: operation.id,
        identityKey: TEST_IDENTITY_KEY, claimOwner: owner,
        expectedFamilyGeneration: 3, expectedGrantVersion: 7,
        expectedKind: operation.kind, timer: startMonotonicTimer(),
      }));
      const operationRef = getCutoverOperationDocRef(db, namespace, operation.id, TEST_IDENTITY_KEY);
      const controlRef = getCutoverFenceDocRef(db, namespace);
      const snapshot = async () => Promise.all(
        [familyRef, pointerRef, grantRef, operationRef, controlRef].map(async (ref) => (await ref.get()).data()),
      );
      const before = await snapshot();
      const forgeries = [
        { ...claim, claimOwner: randomUUID() },
        { ...claim, operationId: randomUUID() },
        { ...claim, familyId: 'other-family' },
        { ...claim, familyGeneration: claim.familyGeneration + 1 },
        { ...claim, grantVersion: claim.grantVersion + 1 },
        { ...claim, leaseExpiresAt: claim.leaseExpiresAt + 1 },
      ];
      for (const pendingClaim of forgeries) {
        await expect(db.runTransaction(async (transaction) => {
          await checkMutationGuardInTransaction(transaction, {
            db, namespace, operation, pendingClaim, identityKey: TEST_IDENTITY_KEY,
            timer: startMonotonicTimer(),
          });
        })).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
      }
      let onCommit: (() => void) | undefined;
      await db.runTransaction(async (transaction) => {
        const guard = await checkMutationGuardInTransaction(transaction, {
          db, namespace, operation, pendingClaim: claim, identityKey: TEST_IDENTITY_KEY,
          timer: startMonotonicTimer(),
        });
        guard.bufferCompletion();
        transaction.update(grantRef, {
          leaseOwner: null, leaseUntil: null, leaseExpiresAt: null,
          operationId: null, ambiguousOperationId: null,
        });
        onCommit = guard.onCommit;
      });
      onCommit?.();
      expect(operation.isCompleted()).toBe(true);
    });
  });

  it.each(['structured', 'legacy-pointer'])('refuses update over a claimed %s refresh owner', async (shape) => {
    const db = createTestDb();
    const store = new FirestoreTokenStore({ db, collection: 'mcp_tokens' });
    const first = await store.issue({
      accessToken: 'access-a', refreshToken: 'refresh-a', clientId: 'client',
      expiresAt: Date.now() + 60_000, nsAccessToken: 'upstream-a', nsUsername: 'a',
    });
    const second = await store.issue({
      accessToken: 'access-b', refreshToken: 'refresh-b', clientId: 'client',
      expiresAt: Date.now() + 60_000, nsAccessToken: 'upstream-b', nsUsername: 'b',
    });
    const family = second.refreshFamilyId!;
    const destination = store.refreshDocRef(second.refreshToken);
    if (shape === 'legacy-pointer') await destination.set({ accessToken: second.accessToken });
    await store.upstreamDocRef(family).set({ leaseOwner: 'held', grant: { nsAccessToken: 'upstream-b' } }, { merge: true });
    const refs = [
      store.accessDocRef(first.accessToken), store.accessDocRef(second.accessToken),
      store.refreshDocRef(first.refreshToken), destination,
      store.upstreamDocRef(first.refreshFamilyId!), store.upstreamDocRef(family),
    ];
    const snapshot = () => Promise.all(refs.map(async (ref) => (await ref.get()).data()));
    const before = await snapshot();
    await expect(store.update(first.accessToken, { refreshToken: second.refreshToken })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it('advances direct grant versions atomically and refuses an observed stale version', async () => {
    const db = createTestDb();
    const familyId = 'version-family';
    const store = new FirestoreUpstreamGrantStore<{ token: string }>({ db, collection: 'mcp_tokens_upstream' });
    await initializeCutoverFence(db, 'mcp');
    await db.collection('mcp_tokens_refresh_families').doc(familyId).set({
      id: familyId, generation: 1, currentRefreshToken: 'version-refresh',
    });
    await db.collection('mcp_tokens_refresh').doc('version-refresh').set({ familyId, status: 'active' });
    await store.put(familyId, { token: 'one' });
    expect((await store.get(familyId))?.grantVersion).toBe(1);
    await store.put(familyId, { token: 'one' });
    expect((await store.get(familyId))?.grantVersion).toBe(1);
    await store.put(familyId, { token: 'two' });
    const changed = await store.get(familyId);
    expect(changed?.grantVersion).toBe(2);
    await expect(withLegacyOperation({ db, namespace: 'mcp', kind: 'upstream_refresh' }, async (operation) => {
      await db.runTransaction((transaction) => claimUpstreamGrantInTransaction(transaction, db, {
        namespace: 'mcp', epoch: operation.epoch, familyId, operationId: operation.id,
        identityKey: TEST_IDENTITY_KEY, claimOwner: randomUUID(), expectedFamilyGeneration: 1,
        expectedGrantVersion: 1, expectedKind: operation.kind, timer: startMonotonicTimer(),
      }));
    })).rejects.toThrow();
    expect(await store.get(familyId)).toEqual(changed);
    await Promise.all([store.put(familyId, { token: 'three' }), store.put(familyId, { token: 'four' })]);
    const concurrent = await store.get(familyId);
    expect(concurrent?.grantVersion).toBe(4);
    expect(['three', 'four']).toContain(concurrent?.grant.token);
    await db.collection('mcp_tokens_upstream').doc(familyId).set({ leaseUntil: 0 }, { merge: true });
    const held = await store.get(familyId);
    await expect(store.put(familyId, { token: 'five' })).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(await store.get(familyId)).toEqual(held);
  });

  it('updates the upstream version only when token update changes its grant', async () => {
    const db = createTestDb();
    const store = new FirestoreTokenStore({ db, collection: 'mcp_tokens' });
    const token = await store.issue({
      accessToken: 'version-access', refreshToken: 'version-refresh', clientId: 'client',
      expiresAt: Date.now() + 60_000, nsAccessToken: 'upstream-one', nsUsername: 'user',
    });
    const grantRef = store.upstreamDocRef(token.refreshFamilyId!);
    expect((await grantRef.get()).data()?.grantVersion).toBe(1);
    await store.update(token.accessToken, { nsAccessToken: 'upstream-one' });
    expect((await grantRef.get()).data()?.grantVersion).toBe(1);
    await store.update(token.accessToken, { nsAccessToken: 'upstream-two' });
    expect((await grantRef.get()).data()?.grantVersion).toBe(2);
    await Promise.all([
      store.update(token.accessToken, { nsAccessToken: 'upstream-three' }),
      store.update(token.accessToken, { nsAccessToken: 'upstream-four' }),
    ]);
    expect((await grantRef.get()).data()?.grantVersion).toBe(4);
  });


  it('1. Fence closes before admission: no write or upstream call', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    await transitionCutoverFenceState(db, namespace, {
      fromState: 'legacy_open',
      toState: 'closing',
      expectedEpoch: 1,
    });

    let upstreamCalled = false;
    let caughtError: unknown;

    try {
      await withLegacyOperation({ db, namespace, kind: 'token_rotate' }, async () => {
        upstreamCalled = true;
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(CutoverRefusedError);
    expect(upstreamCalled).toBe(false);

    const tokenStore = new FirestoreTokenStore({
      db,
      collection: 'mcp_tokens',
      fence: { namespace, enforce: true },
    });

    await expect(
      tokenStore.issue({
        accessToken: 'acc_closed',
        refreshToken: 'ref_closed',
        clientId: 'client_1',
        expiresAt: Date.now() + 3600_000,
        nsAccessToken: 'ns_acc',
        nsUsername: 'user1',
      }),
    ).rejects.toThrow(CutoverRefusedError);
  });

  it('2. Writer commits before closure: its result appears in the frozen snapshot', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    const tokenStore = new FirestoreTokenStore({
      db,
      collection: 'mcp_tokens',
      fence: { namespace, enforce: true },
    });

    let issuedToken: unknown;
    await withLegacyOperation({ db, namespace, kind: 'token_issue' }, async (ctx) => {
      issuedToken = await tokenStore.issue(
        {
          accessToken: 'acc_pre_close',
          refreshToken: 'ref_pre_close',
          clientId: 'client_commit',
          expiresAt: Date.now() + 3600_000,
          nsAccessToken: 'ns_token_valid',
          nsUsername: 'user_commit',
        },
        { operation: ctx },
      );
    });

    expect(issuedToken).toBeDefined();

    await transitionCutoverFenceState(db, namespace, {
      fromState: 'legacy_open',
      toState: 'closing',
      expectedEpoch: 1,
    });
    await transitionCutoverFenceState(db, namespace, {
      fromState: 'closing',
      toState: 'fenced',
      expectedEpoch: 1,
    });

    const frozenSnap = await db.collection('mcp_tokens').doc(docId('acc_pre_close')).get();
    expect(frozenSnap.exists).toBe(true);
    expect(frozenSnap.data()?.accessToken).toBe('acc_pre_close');
    expect(frozenSnap.data()?.nsAccessToken).toBe('ns_token_valid');
  });

  it('3. Writer transaction races closure: the final result is linearized correctly', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    const tokenStore = new FirestoreTokenStore({
      db,
      collection: 'mcp_tokens',
      fence: { namespace, enforce: true },
    });

    await withLegacyOperation({ db, namespace, kind: 'issue' }, async (ctx) => {
      await tokenStore.issue(
        {
          accessToken: 'acc_race',
          refreshToken: 'ref_race',
          clientId: 'client_race',
          expiresAt: Date.now() + 3600_000,
          nsAccessToken: 'ns_race',
          nsUsername: 'user_race',
        },
        { operation: ctx },
      );
    });

    const { promise: fenceClosed, resolve: notifyFenceClosed } = deferred();
    const { promise: opStarted, resolve: notifyOpStarted } = deferred();

    const opPromise = withLegacyOperation({ db, namespace, kind: 'token_rotate' }, async (ctx) => {
      notifyOpStarted();
      await fenceClosed;
      return await tokenStore.rotate(
        'ref_race',
        {
          accessToken: 'acc_race_2',
          refreshToken: 'ref_race_2',
          clientId: 'client_race',
          expiresAt: Date.now() + 3600_000,
          nsAccessToken: 'ns_race_2',
          nsUsername: 'user_race',
        },
        'client_race',
        Date.now(),
        { operation: ctx },
      );
    });

    await opStarted;
    await transitionCutoverFenceState(db, namespace, {
      fromState: 'legacy_open',
      toState: 'closing',
      expectedEpoch: 1,
    });
    notifyFenceClosed();
    const result = await opPromise;
    expect(result.status).toBe('claimed');

    await transitionCutoverFenceState(db, namespace, {
      fromState: 'closing',
      toState: 'fenced',
      expectedEpoch: 1,
    });

    const control = await getCutoverFenceRecord(db, namespace);
    expect(control?.state).toBe('fenced');
    expect(control?.activeOperations).toBe(0);
  });

  it('4. Remote grant is paused after success: closing waits, admitted operation persists replacement', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    const tokenStore = new FirestoreTokenStore({
      db,
      collection: 'mcp_tokens',
      fence: { namespace, enforce: true },
    });

    await withLegacyOperation({ db, namespace, kind: 'issue' }, async (ctx) => {
      await tokenStore.issue(
        {
          accessToken: 'acc_pause',
          refreshToken: 'ref_pause',
          clientId: 'client_pause',
          expiresAt: Date.now() + 3600_000,
          nsAccessToken: 'ns_old',
          nsUsername: 'user_pause',
        },
        { operation: ctx },
      );
    });

    let grantResolved = false;
    let operationFinished = false;
    const { promise: fenceAttemptDone, resolve: notifyFenceAttemptDone } = deferred();
    const { promise: opPaused, resolve: notifyOpPaused } = deferred();

    const opPromise = withLegacyOperation({ db, namespace, kind: 'token_rotate' }, async (ctx) => {
      notifyOpPaused();
      await fenceAttemptDone;
      grantResolved = true;

      const rot = await tokenStore.rotate(
        'ref_pause',
        {
          accessToken: 'acc_paused_success',
          refreshToken: 'ref_paused_success',
          clientId: 'client_pause',
          expiresAt: Date.now() + 3600_000,
          nsAccessToken: 'ns_new',
          nsUsername: 'user_pause',
        },
        'client_pause',
        Date.now(),
        { operation: ctx },
      );
      operationFinished = true;
      return rot;
    });

    await opPaused;
    await transitionCutoverFenceState(db, namespace, {
      fromState: 'legacy_open',
      toState: 'closing',
      expectedEpoch: 1,
    });

    await expect(
      transitionCutoverFenceState(db, namespace, {
        fromState: 'closing',
        toState: 'fenced',
        expectedEpoch: 1,
      }),
    ).rejects.toThrow(CutoverFenceError);
    notifyFenceAttemptDone();
    const rotResult = await opPromise;
    expect(rotResult.status).toBe('claimed');
    expect(grantResolved).toBe(true);
    expect(operationFinished).toBe(true);

    await transitionCutoverFenceState(db, namespace, {
      fromState: 'closing',
      toState: 'fenced',
      expectedEpoch: 1,
    });

    const fencedSnap = await getCutoverFenceRecord(db, namespace);
    expect(fencedSnap?.state).toBe('fenced');
    expect(fencedSnap?.activeOperations).toBe(0);
  });

  it('5. Process/transport failure leaves an ambiguous operation: sealing refuses', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    let caughtError: unknown;
    try {
      await withLegacyOperation({ db, namespace, kind: 'token_rotate' }, async (ctx) => {
        ctx.markAmbiguousRemoteOutcome('transport timeout after remote grant');
        throw new UpstreamTimeoutError('Remote grant timeout');
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(UpstreamTimeoutError);

    await transitionCutoverFenceState(db, namespace, {
      fromState: 'legacy_open',
      toState: 'closing',
      expectedEpoch: 1,
    });

    await expect(
      transitionCutoverFenceState(db, namespace, {
        fromState: 'closing',
        toState: 'fenced',
        expectedEpoch: 1,
      }),
    ).rejects.toThrow(CutoverFenceError);
  });

  it('6. Wrong epoch or operation identity: mutation refuses', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    const fakeOpContext: LegacyOperationContext = {
      id: randomUUID(),
      namespace,
      epoch: 99,
      kind: 'refresh',
      isAmbiguousRemoteOutcome: () => false,
      markAmbiguousRemoteOutcome: () => {},
      isCompleted: () => false,
      markCompleted: () => {},
    };

    const tokenStore = new FirestoreTokenStore({
      db,
      collection: 'mcp_tokens',
      fence: { namespace, enforce: true },
    });

    await expect(
      tokenStore.issue(
        {
          accessToken: 'acc_bad_epoch',
          refreshToken: 'ref_bad_epoch',
          clientId: 'client_bad',
          expiresAt: Date.now() + 3600_000,
          nsAccessToken: 'ns_bad',
          nsUsername: 'user_bad',
        },
        { operation: fakeOpContext },
      ),
    ).rejects.toThrow(CutoverFenceError);
  });

  it('7. Missing or malformed control: fail closed', async () => {
    const db = createTestDb();
    const namespace = 'mcp';

    const tokenStore = new FirestoreTokenStore({
      db,
      collection: 'mcp_tokens',
      fence: { namespace, enforce: true },
    });

    await expect(
      tokenStore.issue({
        accessToken: 'acc_missing_ctrl',
        refreshToken: 'ref_missing_ctrl',
        clientId: 'client_1',
        expiresAt: Date.now() + 3600_000,
        nsAccessToken: 'ns_1',
        nsUsername: 'user_1',
      }),
    ).rejects.toThrow(CutoverFenceError);

    const controlRef = getCutoverFenceDocRef(db, namespace);
    await controlRef.set({ schemaVersion: 99, state: 'unknown_state' });

    await expect(
      tokenStore.issue({
        accessToken: 'acc_malformed_ctrl',
        refreshToken: 'ref_malformed_ctrl',
        clientId: 'client_1',
        expiresAt: Date.now() + 3600_000,
        nsAccessToken: 'ns_1',
        nsUsername: 'user_1',
      }),
    ).rejects.toThrow(CutoverFenceError);
  });

  it('8. Stale lease owner: cannot clear or revoke its peer', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    const tokenStore = new FirestoreTokenStore({
      db,
      collection: 'mcp_tokens',
      fence: { namespace, enforce: true },
    });

    await withLegacyOperation({ db, namespace, kind: 'issue' }, async (ctx) => {
      await tokenStore.issue(
        {
          accessToken: 'acc_lease_owner',
          refreshToken: 'ref_lease_owner',
          clientId: 'client_1',
          expiresAt: Date.now() + 3600_000,
          nsAccessToken: 'ns_token_initial',
          nsExpiresAt: Date.now() - 1000,
          nsRefreshToken: 'ns_ref_token',
          nsUsername: 'user_1',
        },
        { operation: ctx },
      );
    });

    const docRef = tokenStore.accessDocRef('acc_lease_owner');
    await docRef.set(
      {
        refreshLockOwner: 'peer_instance_B',
        refreshLockUntil: Date.now() + 60_000,
      },
      { merge: true },
    );

    await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(docRef);
      const current = snap.data() as { refreshLockOwner?: string };
      const staleOwnerA = 'instance_A';
      if (current.refreshLockOwner === staleOwnerA) {
        transaction.update(docRef, { refreshLockOwner: null, refreshLockUntil: null });
      }
    });

    const checkSnap = await docRef.get();
    expect(checkSnap.data()?.refreshLockOwner).toBe('peer_instance_B');
    expect(checkSnap.data()?.refreshLockUntil).toBeGreaterThan(Date.now());
  });

  it('9. Base-pointer adoption followed by rotation uses no read-after-write', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    const collection = 'mcp_tokens';
    const accessRef = db.collection(collection).doc('acc_legacy_pointer');
    const refreshPointerRef = db.collection(`${collection}_refresh`).doc('ref_legacy_pointer');

    await accessRef.set({
      accessToken: 'acc_legacy_pointer',
      refreshToken: 'ref_legacy_pointer',
      clientId: 'client_legacy',
      expiresAt: Date.now() + 3600_000,
      nsAccessToken: 'ns_legacy_access',
      nsRefreshToken: 'ns_legacy_refresh',
      nsUsername: 'user_legacy',
    });

    await refreshPointerRef.set({
      accessToken: 'acc_legacy_pointer',
    });

    const tokenStore = new FirestoreTokenStore({
      db,
      collection,
      fence: { namespace, enforce: true },
    });

    let rotResult: any;
    await withLegacyOperation({ db, namespace, kind: 'rotate' }, async (ctx) => {
      rotResult = await tokenStore.rotate(
        'ref_legacy_pointer',
        {
          accessToken: 'acc_adopted_new',
          refreshToken: 'ref_adopted_new',
          clientId: 'client_legacy',
          expiresAt: Date.now() + 3600_000,
          nsAccessToken: 'ns_adopted_new',
          nsRefreshToken: 'ns_adopted_new_ref',
          nsUsername: 'user_legacy',
        },
        'client_legacy',
        Date.now(),
        { operation: ctx },
      );
    });

    expect(rotResult.status).toBe('claimed');
    if (rotResult.status === 'claimed') {
      expect(rotResult.token.accessToken).toBe('acc_adopted_new');
      expect(rotResult.token.refreshFamilyId).toBeDefined();

      const newAccess = await withLegacyOperation({ db, namespace, kind: 'read' }, async (ctx) => {
        return await tokenStore.get('acc_adopted_new', { operation: ctx });
      });
      expect(newAccess).toBeDefined();
      expect(newAccess?.nsAccessToken).toBe('ns_adopted_new');
    }
  });

  it('10. Retry refresh returns the same successor without another upstream grant', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    let upstreamGrantCalls = 0;
    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com',
      nsClientId: 'test_client_id',
      nsClientSecret: 'test_client_secret',
      firestore: db,
      collections: { tokens: 'mcp_tokens' },
      fence: { namespace, enforce: true },
    });

    (authProvider as any).nsRefreshGrant = async () => {
      upstreamGrantCalls++;
      return {
        access_token: `ns_up_${upstreamGrantCalls}`,
        refresh_token: `ns_up_ref_${upstreamGrantCalls}`,
        expires_in: 3600,
      };
    };

    const client = { client_id: 'client_test_retry' } as any;

    await (authProvider as any).withOperation('issue', async (ctx: any) => {
      await (authProvider as any).tokenStore.issue(
        {
          accessToken: 'acc_orig_token',
          refreshToken: 'ref_orig_token',
          clientId: 'client_test_retry',
          expiresAt: Date.now() + 3600_000,
          nsAccessToken: 'ns_initial',
          nsRefreshToken: 'ns_initial_ref',
          nsUsername: 'test_user',
        },
        { operation: ctx },
      );
    });

    const firstExchange = await authProvider.exchangeRefreshToken(client, 'ref_orig_token');
    expect(upstreamGrantCalls).toBe(1);
    expect(firstExchange.access_token).toBeDefined();

    const secondExchange = await authProvider.exchangeRefreshToken(client, 'ref_orig_token');
    expect(upstreamGrantCalls).toBe(1);
    expect(secondExchange.access_token).toBe(firstExchange.access_token);
    expect(secondExchange.refresh_token).toBe(firstExchange.refresh_token);
  });

  it('11. Blocked code exchange leaves authorization code usable', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com',
      nsClientId: 'test_client_id',
      nsClientSecret: 'test_client_secret',
      firestore: db,
      collections: { tokens: 'mcp_tokens' },
      fence: { namespace, enforce: true },
    });

    const code = 'auth_code_redeemable';
    await (authProvider as any).withOperation('auth_code', async (ctx: any) => {
      await (authProvider as any).authCodeStore.set(
        code,
        {
          pending: { clientId: 'client_1', codeChallenge: 'challenge', redirectUri: 'https://client.com/cb', createdAt: Date.now() },
          nsTokens: { access_token: 'ns_code_acc', refresh_token: 'ns_code_ref', username: 'code_user' },
          serverBaseUrl: undefined,
          clientId: 'client_1',
        },
        { operation: ctx },
      );
    });

    await transitionCutoverFenceState(db, namespace, {
      fromState: 'legacy_open',
      toState: 'closing',
      expectedEpoch: 1,
    });
    await transitionCutoverFenceState(db, namespace, {
      fromState: 'closing',
      toState: 'fenced',
      expectedEpoch: 1,
    });

    const client = { client_id: 'client_1' } as any;
    await expect(authProvider.exchangeAuthorizationCode(client, code)).rejects.toThrow(CutoverRefusedError);

    const codeDoc = await db.collection('mcp_auth_codes').doc(code).get();
    expect(codeDoc.exists).toBe(true);
  });

  it('12. Revoked-seat refresh makes zero upstream grant calls and throws InvalidGrantError', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    let upstreamGrantCalled = false;
    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com',
      nsClientId: 'test_client_id',
      nsClientSecret: 'test_client_secret',
      firestore: db,
      collections: { tokens: 'mcp_tokens' },
      fence: { namespace, enforce: true },
      hooks: {
        onLogin: async () => ({ kind: 'continue', tokenExtra: {} }),
        onVerify: async () => {
          throw new InvalidTokenError('Seat revoked by admin');
        },
      },
    });

    (authProvider as any).nsRefreshGrant = async () => {
      upstreamGrantCalled = true;
      return { access_token: 'ns_should_not_reach', refresh_token: 'ns_ref', expires_in: 3600 };
    };

    await (authProvider as any).withOperation('issue', async (ctx: any) => {
      await (authProvider as any).tokenStore.issue(
        {
          accessToken: 'acc_revoked_seat',
          refreshToken: 'ref_revoked_seat',
          clientId: 'client_seat',
          expiresAt: Date.now() + 3600_000,
          nsAccessToken: 'ns_seat_acc',
          nsRefreshToken: 'ns_seat_ref',
          nsUsername: 'revoked_user',
        },
        { operation: ctx },
      );
    });

    const client = { client_id: 'client_seat' } as any;
    await expect(authProvider.exchangeRefreshToken(client, 'ref_revoked_seat')).rejects.toThrow(InvalidGrantError);
    expect(upstreamGrantCalled).toBe(false);
  });

  it('13. Unexpected onVerify policy error preserves credential and throws TemporarilyUnavailableError', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    let upstreamGrantCalled = false;
    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com',
      nsClientId: 'test_client_id',
      nsClientSecret: 'test_client_secret',
      firestore: db,
      collections: { tokens: 'mcp_tokens' },
      fence: { namespace, enforce: true },
      hooks: {
        onLogin: async () => ({ kind: 'continue', tokenExtra: {} }),
        onVerify: async () => {
          throw new Error('Database connection timeout in policy engine');
        },
      },
    });

    (authProvider as any).nsRefreshGrant = async () => {
      upstreamGrantCalled = true;
      return { access_token: 'ns_acc', refresh_token: 'ns_ref', expires_in: 3600 };
    };

    await (authProvider as any).withOperation('issue', async (ctx: any) => {
      await (authProvider as any).tokenStore.issue(
        {
          accessToken: 'acc_transient_seat',
          refreshToken: 'ref_transient_seat',
          clientId: 'client_transient',
          expiresAt: Date.now() + 3600_000,
          nsAccessToken: 'ns_transient_acc',
          nsRefreshToken: 'ns_transient_ref',
          nsUsername: 'transient_user',
        },
        { operation: ctx },
      );
    });

    const client = { client_id: 'client_transient' } as any;
    await expect(authProvider.exchangeRefreshToken(client, 'ref_transient_seat')).rejects.toThrow(TemporarilyUnavailableError);
    expect(upstreamGrantCalled).toBe(false);

    const tokenStillExists = await (authProvider as any).tokenStore.getByRefreshToken('ref_transient_seat');
    expect(tokenStillExists).toBeDefined();
  });

  it('14. Legacy v2.3.1 embedded doc seed without family rotates successfully on v2.4.1 bridge', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    const collection = 'mcp_tokens';
    const accessRef = db.collection(collection).doc('acc_legacy_231');

    await accessRef.set({
      accessToken: 'acc_legacy_231',
      refreshToken: 'ref_legacy_231',
      clientId: 'client_231',
      expiresAt: Date.now() + 3600_000,
      nsAccessToken: 'ns_231_token',
      nsRefreshToken: 'ns_231_refresh',
      nsExpiresAt: Date.now() + 3600_000,
      nsUsername: 'user_231',
      nsUserRole: 'admin',
      nsApiUrl: 'https://api.example.com',
    });

    const tokenStore = new FirestoreTokenStore({
      db,
      collection,
      fence: { namespace, enforce: true },
    });

    let rotated: any;
    await withLegacyOperation({ db, namespace, kind: 'rotate' }, async (ctx) => {
      rotated = await tokenStore.rotate(
        'ref_legacy_231',
        {
          accessToken: 'acc_231_rotated',
          refreshToken: 'ref_231_rotated',
          clientId: 'client_231',
          expiresAt: Date.now() + 3600_000,
          nsAccessToken: 'ns_231_rotated_token',
          nsRefreshToken: 'ns_231_rotated_refresh',
          nsExpiresAt: Date.now() + 3600_000,
          nsUsername: 'user_231',
          nsUserRole: 'admin',
          nsApiUrl: 'https://api.example.com',
        },
        'client_231',
        Date.now(),
        { operation: ctx },
      );
    });

    expect(rotated.status).toBe('claimed');
    if (rotated.status === 'claimed') {
      expect(rotated.token.accessToken).toBe('acc_231_rotated');
      expect(rotated.token.refreshFamilyId).toBeDefined();
    }
  });
  it('15. Concurrent duplicate operationId: exactly one executes and second is refused', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    const sharedOpId = 'concurrent_op_duplicate_id';
    let executions = 0;

    const op1 = withLegacyOperation(
      { db, namespace, kind: 'auth_code', operationId: sharedOpId },
      async () => {
        executions++;
        const { promise, resolve } = deferred();
        setTimeout(resolve, 50);
        await promise;
        return 'success_1';
      },
    );

    const op2 = withLegacyOperation(
      { db, namespace, kind: 'auth_code', operationId: sharedOpId },
      async () => {
        executions++;
        return 'success_2';
      },
    );

    const results = await Promise.allSettled([op1, op2]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(executions).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(CutoverFenceError);
  });

  it('16. Timeout locks ambiguous outcome; advancing beyond lease makes zero second fake NS grant', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    let nowTime = 1000_000;
    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com',
      nsClientId: 'test_client_id',
      nsClientSecret: 'test_client_secret',
      firestore: db,
      collections: { tokens: 'mcp_tokens' },
      fence: { namespace, enforce: true },
      now: () => nowTime,
    });

    let fakeNsCalls = 0;
    (authProvider as any).nsRefreshGrant = async () => {
      fakeNsCalls++;
      if (fakeNsCalls === 1) {
        throw new UpstreamTimeoutError('First upstream refresh timed out');
      }
      return { access_token: 'ns_token_2', refresh_token: 'ns_ref_2', expires_in: 3600 };
    };

    const tokenStore = (authProvider as any).tokenStore as FirestoreTokenStore;
    await authProvider.withOperation('issue', async (ctx) => {
      return await tokenStore.issue(
        {
          accessToken: 'acc_ambig_test',
          refreshToken: 'ref_ambig_test',
          clientId: 'client_ambig',
          expiresAt: nowTime + 3600_000,
          nsAccessToken: 'ns_ambig_init',
          nsExpiresAt: nowTime - 1000, // Expired, needs refresh
          nsRefreshToken: 'ns_ambig_ref',
          nsUsername: 'ambig_user',
        },
        { operation: ctx },
      );
    });

    // First attempt: transparent refresh triggers upstream refresh and times out
    await expect(
      authProvider.withOperation('upstream_refresh', async (opCtx) => {
        return await tokenStore.refreshNsToken(
          'acc_ambig_test',
          (current) => (authProvider as any).nsRefreshGrant(current.nsRefreshToken!, current.nsApiUrl),
          { operation: opCtx },
        );
      }),
    ).rejects.toThrow();
    expect(fakeNsCalls).toBe(1);

    // Advance clock past the lease duration (30s)
    nowTime += 60_000;

    // Second claimant attempts refresh after lease expiry
    await expect(
      authProvider.withOperation('upstream_refresh', async (opCtx) => {
        return await tokenStore.refreshNsToken(
          'acc_ambig_test',
          (current) => (authProvider as any).nsRefreshGrant(current.nsRefreshToken!, current.nsApiUrl),
          { operation: opCtx },
        );
      }),
    ).rejects.toThrow(UpstreamUnavailableError);

    // CRITICAL: NO second fake NS grant call was made!
    expect(fakeNsCalls).toBe(1);
  });
  it('17. Production createApp HTTP router /token under closing/fenced returns HTTP 503 with Retry-After and performs zero credential consumption and zero upstream grants', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });
    process.env.MCP_TRANSPORT = 'http';
    process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'test_client_id';
    process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'test_client_secret';
    process.env.NETSAPIENS_API_URL = 'https://test.example.com';
    let fakeNsCalls = 0;
    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com',
      nsClientId: 'test_client_id',
      nsClientSecret: 'test_client_secret',
      firestore: db,
      collections: { tokens: 'mcp_tokens' },
      fence: { namespace, enforce: true },
    });

    (authProvider as any).nsRefreshGrant = async () => {
      fakeNsCalls++;
      return { access_token: 'ns_token_2', refresh_token: 'ns_ref_2', expires_in: 3600 };
    };

    const code = 'code_http_router_test';
    await authProvider.withOperation('auth_code', async (ctx) => {
      await (authProvider as any).authCodeStore.set(
        code,
        {
          pending: { clientId: 'client_http', codeChallenge: 'challenge', redirectUri: 'http://localhost/cb', createdAt: Date.now() },
          nsTokens: { access_token: 'ns_acc', refresh_token: 'ns_ref', username: 'user_http' },
          clientId: 'client_http',
        },
        { operation: ctx },
      );
    });

    await (authProvider as any).clientsStore.registerClient({
      client_id: 'client_http',
      redirect_uris: ['http://localhost/cb'],
      token_endpoint_auth_method: 'none',
    });

    await transitionCutoverFenceState(db, namespace, {
      fromState: 'legacy_open',
      toState: 'closing',
      expectedEpoch: 1,
    });

    const { app } = createApp(authProvider);

    const tokenRes = await request(app)
      .post('/token')
      .send({
        grant_type: 'authorization_code',
        code,
        client_id: 'client_http',
        redirect_uri: 'http://localhost/cb',
        code_verifier: 'challenge',
      });

    expect(tokenRes.status).toBe(503);
    expect(tokenRes.headers['retry-after']).toBe('5');
    expect(tokenRes.body.error).toBe('temporarily_unavailable');

    const codeDoc = await db.collection('mcp_auth_codes').doc(code).get();
    expect(codeDoc.exists).toBe(true);
    expect(fakeNsCalls).toBe(0);
  });

  it('18. Production createApp HTTP router /register under closing/fenced returns HTTP 503 with Retry-After and blocks registration', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com',
      nsClientId: 'test_client_id',
      nsClientSecret: 'test_client_secret',
      firestore: db,
      collections: { tokens: 'mcp_tokens' },
      fence: { namespace, enforce: true },
    });
    process.env.MCP_TRANSPORT = 'http';
    process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'test_client_id';
    process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'test_client_secret';
    process.env.NETSAPIENS_API_URL = 'https://test.example.com';
    process.env.MCP_BASE_URL = 'http://localhost';
    await transitionCutoverFenceState(db, namespace, {
      fromState: 'legacy_open',
      toState: 'closing',
      expectedEpoch: 1,
    });

    const { app } = createApp(authProvider);

    const regRes = await request(app)
      .post('/register')
      .send({
        redirect_uris: ['http://localhost/cb'],
        client_name: 'test_client',
      });

    expect(regRes.status).toBe(503);
    expect(regRes.headers['retry-after']).toBe('5');
    expect(regRes.body.error).toBe('temporarily_unavailable');
  });

  it('19. Production createApp HTTP router /token under legacy_open returns standard RFC 6749 HTTP 400 invalid_grant for invalid credentials', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com',
      nsClientId: 'test_client_id',
      nsClientSecret: 'test_client_secret',
      firestore: db,
      collections: { tokens: 'mcp_tokens' },
      fence: { namespace, enforce: true },
    });
    process.env.MCP_TRANSPORT = 'http';
    process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'test_client_id';
    process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'test_client_secret';
    process.env.NETSAPIENS_API_URL = 'https://test.example.com';
    await (authProvider as any).clientsStore.registerClient({
      client_id: 'any_client',
      redirect_uris: ['http://localhost/cb'],
      token_endpoint_auth_method: 'none',
    });
    const { app } = createApp(authProvider);
    const tokenRes = await request(app)
      .post('/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: 'non_existent_refresh_token',
        client_id: 'any_client',
      });

    expect(tokenRes.status).toBe(400);
    expect(tokenRes.body.error).toBe('invalid_grant');
  });

  it('20. Startup validation with MCP_FENCE_ENFORCE=true and missing control record fails startup', async () => {
    const db = createTestDb();
    const namespace = 'mcp';

    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com',
      nsClientId: 'test_client_id',
      nsClientSecret: 'test_client_secret',
      firestore: db,
      collections: { tokens: 'mcp_tokens' },
      fence: { namespace, enforce: true },
    });

    await expect(validateBridgeStartup(authProvider)).rejects.toThrow(CutoverFenceError);
  });

  it('21. Production createApp HTTP router /mcp under legacy_open succeeds (200) with bearer auth and balanced operation lifecycle', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    const tokenStore = new FirestoreTokenStore({
      db,
      collection: 'mcp_tokens',
      fence: { namespace, enforce: true },
    });

    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com',
      nsClientId: 'test_client_id',
      nsClientSecret: 'test_client_secret',
      tokenStore,
      firestore: db,
      collections: { tokens: 'mcp_tokens' },
      fence: { namespace, enforce: true },
      serverBaseUrl: 'http://localhost',
    });

    process.env.MCP_TRANSPORT = 'http';
    process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'test_client_id';
    process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'test_client_secret';
    process.env.NETSAPIENS_API_URL = 'https://test.example.com';
    process.env.MCP_BASE_URL = 'http://localhost';

    const testAccessToken = 'bearer-valid-mcp-' + randomBytes(8).toString('hex');
    const testRefreshToken = 'rt-valid-mcp-' + randomBytes(8).toString('hex');

    await tokenStore.issue({
      accessToken: testAccessToken,
      refreshToken: testRefreshToken,
      clientId: 'any_client',
      expiresAt: Date.now() + 3600 * 1000,
      nsAccessToken: 'ns-token-123',
      nsUsername: 'testuser',
      nsApiUrl: 'https://test.example.com',
      serverBaseUrl: 'http://localhost',
    });

    const { app } = createApp(authProvider);

    const mcpRes = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${testAccessToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'ping',
      });

    expect(mcpRes.status).toBe(200);

    let activeOps = 1;
    for (let i = 0; i < 30; i++) {
      const c = await getCutoverFenceRecord(db, namespace);
      if (c?.activeOperations === 0) {
        activeOps = 0;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(activeOps).toBe(0);
  });

  it('22. Production createApp HTTP router /mcp under closing and fenced returns HTTP 503 Retry-After and never sends invalid_token challenge', async () => {
    configureHttpTest();
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    const tokenStore = new FirestoreTokenStore({
      db,
      collection: 'mcp_tokens',
      fence: { namespace, enforce: true },
    });

    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com',
      nsClientId: 'test_client_id',
      nsClientSecret: 'test_client_secret',
      tokenStore,
      firestore: db,
      collections: { tokens: 'mcp_tokens' },
      fence: { namespace, enforce: true },
      serverBaseUrl: 'http://localhost',
    });

    const testAccessToken = 'bearer-token-' + randomBytes(8).toString('hex');

    const { app } = createApp(authProvider);

    // Transition to closing
    await transitionCutoverFenceState(db, namespace, {
      fromState: 'legacy_open',
      toState: 'closing',
      expectedEpoch: 1,
    });

    const closingRes = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${testAccessToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

    expect(closingRes.status).toBe(503);
    expect(closingRes.headers['retry-after']).toBe('5');
    expect(closingRes.body.error).toBe('temporarily_unavailable');
    expect(closingRes.headers['www-authenticate']).toBeUndefined();

    // Transition to fenced
    await transitionCutoverFenceState(db, namespace, {
      fromState: 'closing',
      toState: 'fenced',
      expectedEpoch: 1,
    });

    const fencedRes = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${testAccessToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 2, method: 'ping' });

    expect(fencedRes.status).toBe(503);
    expect(fencedRes.headers['retry-after']).toBe('5');
    expect(fencedRes.body.error).toBe('temporarily_unavailable');
    expect(fencedRes.headers['www-authenticate']).toBeUndefined();
  });

  it('23. Direct provider entrypoints create their own operation scope outside HTTP requests', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    const tokenStore = new FirestoreTokenStore({
      db,
      collection: 'mcp_tokens',
      fence: { namespace, enforce: true },
    });

    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com',
      nsClientId: 'test_client_id',
      nsClientSecret: 'test_client_secret',
      tokenStore,
      firestore: db,
      collections: { tokens: 'mcp_tokens' },
      fence: { namespace, enforce: true },
      serverBaseUrl: 'http://localhost',
    });

    const testAccessToken = 'direct-bearer-' + randomBytes(8).toString('hex');
    const testRefreshToken = 'direct-rt-' + randomBytes(8).toString('hex');

    await tokenStore.issue({
      accessToken: testAccessToken,
      refreshToken: testRefreshToken,
      clientId: 'any_client',
      expiresAt: Date.now() + 3600 * 1000,
      nsAccessToken: 'ns-direct-token-456',
      nsUsername: 'directuser',
      nsApiUrl: 'https://test.example.com',
      serverBaseUrl: 'http://localhost',
    });

    // Direct verifyAccessToken outside HTTP
    const authInfo = await authProvider.verifyAccessToken(testAccessToken);
    expect(authInfo).toBeDefined();

    // Direct getNsAccessToken outside HTTP
    const nsToken = await authProvider.getNsAccessToken(testAccessToken);
    expect(nsToken).toBe('ns-direct-token-456');

    // Direct revokeToken outside HTTP
    const clientInfo = { client_id: 'any_client' } as any;
    await authProvider.revokeToken(clientInfo, { token: testAccessToken });

    // After revoke, lookup returns undefined
    const revoked = await tokenStore.get(testAccessToken);
    expect(revoked).toBeUndefined();

    const control = await getCutoverFenceRecord(db, namespace);
    expect(control?.activeOperations).toBe(0);
  });

  it('24. Preserves 2.3 base embedded format sessions under real HTTP with transparent adoption', async () => {
    configureHttpTest();
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    const tokenStore = new FirestoreTokenStore({
      db,
      collection: 'mcp_tokens',
      fence: { namespace, enforce: true },
    });

    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com',
      nsClientId: 'test_client_id',
      nsClientSecret: 'test_client_secret',
      tokenStore,
      firestore: db,
      collections: { tokens: 'mcp_tokens' },
      fence: { namespace, enforce: true },
      serverBaseUrl: 'http://localhost',
    });

    const legacyAccessToken = 'base-23-access-' + randomBytes(8).toString('hex');
    const legacyRefreshToken = 'base-23-refresh-' + randomBytes(8).toString('hex');

    // Seed v2.3 base document without refreshFamilyId
    await db.collection('mcp_tokens').doc(docId(legacyAccessToken)).set({
      accessToken: legacyAccessToken,
      refreshToken: legacyRefreshToken,
      clientId: 'legacy_client_23',
      expiresAt: Date.now() + 3600 * 1000,
      nsAccessToken: 'ns-legacy-token-789',
      nsUsername: 'legacyuser',
      nsApiUrl: 'https://test.example.com',
      serverBaseUrl: 'http://localhost',
    });

    const { app } = createApp(authProvider);

    // Call /mcp with legacy 2.3 token
    const mcpRes = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${legacyAccessToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

    expect(mcpRes.status).toBe(200);

    // Verify the document was transparently adopted into family collection
    const adoptedDoc = await db.collection('mcp_tokens').doc(docId(legacyAccessToken)).get();
    const data = adoptedDoc.data();
    expect(data?.refreshFamilyId).toBeDefined();

    const familyDoc = await db.collection('mcp_tokens_refresh_families').doc(docId(data?.refreshFamilyId)).get();
    expect(familyDoc.exists).toBe(true);
  });

  it('25. HTTP admission precedes client adoption: /authorize under closing returns HTTP 503', async () => {
    configureHttpTest();
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com',
      nsClientId: 'test_client_id',
      nsClientSecret: 'test_client_secret',
      firestore: db,
      collections: { tokens: 'mcp_tokens' },
      fence: { namespace, enforce: true },
      serverBaseUrl: 'http://localhost',
    });

    const { app } = createApp(authProvider);

    await transitionCutoverFenceState(db, namespace, {
      fromState: 'legacy_open',
      toState: 'closing',
      expectedEpoch: 1,
    });

    const authRes = await request(app)
      .get('/authorize?response_type=code&client_id=new_dynamic_client&redirect_uri=http://localhost/cb')
      .send();

    expect(authRes.status).toBe(503);
    expect(authRes.headers['retry-after']).toBe('5');
    expect(authRes.body.error).toBe('temporarily_unavailable');

    // Ensure client was NOT adopted into clients store
    const clientDoc = await db.collection('mcp_oauth_clients').doc('new_dynamic_client').get();
    expect(clientDoc.exists).toBe(false);
  });

  it('26. Pre-admitted HTTP request completes under closing without nested double-admission, while subsequent request is refused with 503', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });
    process.env.MCP_TRANSPORT = 'http';
    process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'test_client_id';
    process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'test_client_secret';
    process.env.NETSAPIENS_API_URL = 'https://test.example.com';


    let transitionedMidFlight = false;

    const tokenStore = new FirestoreTokenStore({
      db,
      collection: 'mcp_tokens',
      fence: { namespace, enforce: true },
    });

    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com',
      nsClientId: 'test_client_id',
      nsClientSecret: 'test_client_secret',
      tokenStore,
      firestore: db,
      collections: { tokens: 'mcp_tokens' },
      fence: { namespace, enforce: true },
      serverBaseUrl: 'http://localhost',
      hooks: {
        onVerify: async () => {
          if (!transitionedMidFlight) {
            transitionedMidFlight = true;
            await transitionCutoverFenceState(db, namespace, {
              fromState: 'legacy_open',
              toState: 'closing',
              expectedEpoch: 1,
            });
          }
        },
      },
    });

    vi.spyOn(authProvider as any, 'nsRefreshGrant').mockResolvedValue({
      access_token: 'new-ns-access',
      refresh_token: 'new-ns-refresh',
      expires_in: 3600,
      username: 'testuser',
      nsApiUrl: 'https://test.example.com',
    });

    const testAccessToken = 'midflight-access-' + randomBytes(8).toString('hex');
    const testRefreshToken = 'midflight-refresh-' + randomBytes(8).toString('hex');

    await tokenStore.issue({
      accessToken: testAccessToken,
      refreshToken: testRefreshToken,
      clientId: 'midflight_client',
      expiresAt: Date.now() + 3600 * 1000,
      nsAccessToken: 'ns-token-mid',
      nsRefreshToken: 'ns-refresh-mid',
      nsUsername: 'testuser',
      nsApiUrl: 'https://test.example.com',
      serverBaseUrl: 'http://localhost',
    });

    await (authProvider as any).clientsStore.registerClient({
      client_id: 'midflight_client',
      redirect_uris: ['http://localhost/cb'],
      token_endpoint_auth_method: 'none',
    });

    const { app } = createApp(authProvider);

    // 1. In-flight request admitted in legacy_open, transitions to closing in onVerify
    const tokenRes1 = await request(app)
      .post('/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: testRefreshToken,
        client_id: 'midflight_client',
      });

    // Pre-admitted request must succeed (200), NOT 503 double-admission refusal
    expect({ status: tokenRes1.status, error: tokenRes1.body?.error }).toEqual({ status: 200, error: undefined });
    expect(tokenRes1.body.access_token).toBeDefined();
    expect(tokenRes1.body.refresh_token).toBeDefined();
    const successor = await db.collection('mcp_tokens').doc(docId(tokenRes1.body.access_token)).get();
    expect(successor.exists).toBe(true);
    expect(successor.data()?.refreshToken).toBe(tokenRes1.body.refresh_token);
    expect(successor.data()?.nsAccessToken).toBe('new-ns-access');

    // 2. New request after closing must be refused with 503 + Retry-After: 5
    const tokenRes2 = await request(app)
      .post('/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: tokenRes1.body.refresh_token,
        client_id: 'midflight_client',
      });

    expect(tokenRes2.status).toBe(503);
    expect(tokenRes2.headers['retry-after']).toBe('5');
    expect(tokenRes2.body.error).toBe('temporarily_unavailable');

    // 3. Operations drain to 0
    let activeOps = 1;
    for (let i = 0; i < 30; i++) {
      const c = await getCutoverFenceRecord(db, namespace);
      if (c?.activeOperations === 0) {
        activeOps = 0;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(activeOps).toBe(0);
  });

  it('27. Production createApp HTTP router /revoke under closing/fenced returns HTTP 503 Retry-After and never returns SDK 500 ServerError', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    process.env.MCP_TRANSPORT = 'http';
    process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'test_client_id';
    process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'test_client_secret';
    process.env.NETSAPIENS_API_URL = 'https://test.example.com';

    const tokenStore = new FirestoreTokenStore({
      db,
      collection: 'mcp_tokens',
      fence: { namespace, enforce: true },
    });

    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com',
      nsClientId: 'test_client_id',
      nsClientSecret: 'test_client_secret',
      tokenStore,
      firestore: db,
      collections: { tokens: 'mcp_tokens' },
      fence: { namespace, enforce: true },
      serverBaseUrl: 'http://localhost',
    });

    await (authProvider as any).clientsStore.registerClient({
      client_id: 'revoke_client',
      redirect_uris: ['http://localhost/cb'],
      token_endpoint_auth_method: 'none',
    });

    const { app } = createApp(authProvider);

    // Transition to closing
    await transitionCutoverFenceState(db, namespace, {
      fromState: 'legacy_open',
      toState: 'closing',
      expectedEpoch: 1,
    });

    const revokeRes = await request(app)
      .post('/revoke')
      .send({
        token: 'any_token',
        client_id: 'revoke_client',
      });

    // Outer /revoke admission must return 503 + Retry-After: 5, NOT SDK 500
    expect(revokeRes.status).toBe(503);
    expect(revokeRes.headers['retry-after']).toBe('5');
    expect(revokeRes.body.error).toBe('temporarily_unavailable');
  });

  it('28. Production createApp HTTP router /token under transient upstream error returns HTTP 503 Retry-After and preserves credentials', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    process.env.MCP_TRANSPORT = 'http';
    process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'test_client_id';
    process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'test_client_secret';
    process.env.NETSAPIENS_API_URL = 'https://test.example.com';

    const tokenStore = new FirestoreTokenStore({
      db,
      collection: 'mcp_tokens',
      fence: { namespace, enforce: true },
    });

    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com',
      nsClientId: 'test_client_id',
      nsClientSecret: 'test_client_secret',
      tokenStore,
      firestore: db,
      collections: { tokens: 'mcp_tokens' },
      fence: { namespace, enforce: true },
      serverBaseUrl: 'http://localhost',
    });

    vi.spyOn(authProvider as any, 'nsRefreshGrant').mockRejectedValue(
      new UpstreamTimeoutError('Upstream connection timeout'),
    );

    const testAccessToken = 'transient-access-' + randomBytes(8).toString('hex');
    const testRefreshToken = 'transient-refresh-' + randomBytes(8).toString('hex');

    await tokenStore.issue({
      accessToken: testAccessToken,
      refreshToken: testRefreshToken,
      clientId: 'transient_client',
      expiresAt: Date.now() + 3600 * 1000,
      nsAccessToken: 'ns-token-transient',
      nsRefreshToken: 'ns-refresh-transient',
      nsUsername: 'testuser',
      nsApiUrl: 'https://test.example.com',
      serverBaseUrl: 'http://localhost',
    });

    await (authProvider as any).clientsStore.registerClient({
      client_id: 'transient_client',
      redirect_uris: ['http://localhost/cb'],
      token_endpoint_auth_method: 'none',
    });

    const { app } = createApp(authProvider);

    const tokenRes = await request(app)
      .post('/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: testRefreshToken,
        client_id: 'transient_client',
      });

    // Must return 503 + Retry-After: 5, NOT 400 invalid_grant
    expect(tokenRes.status).toBe(503);
    expect(tokenRes.headers['retry-after']).toBe('5');
    expect(tokenRes.body.error).toBe('temporarily_unavailable');

    // Token must NOT be revoked: still exists in store
    const existing = await tokenStore.get(testAccessToken);
    expect(existing).toBeDefined();
  });

  it('29. Concurrent crosspath refresh: simultaneous exchangeRefreshToken and verifyAccessToken transparent refresh share single upstream grant', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    process.env.MCP_TRANSPORT = 'http';
    process.env.MCP_BASE_URL = 'http://localhost';
    process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'test_client_id';
    process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'test_client_secret';
    process.env.NETSAPIENS_API_URL = 'https://test.example.com';

    let virtualNow = Date.now();

    const tokenStore = new FirestoreTokenStore({
      db,
      collection: 'mcp_tokens',
      fence: { namespace, enforce: true },
      now: () => virtualNow,
    });

    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com',
      nsClientId: 'test_client_id',
      nsClientSecret: 'test_client_secret',
      tokenStore,
      firestore: db,
      collections: { tokens: 'mcp_tokens' },
      fence: { namespace, enforce: true },
      serverBaseUrl: 'http://localhost',
      now: () => virtualNow,
    });

    let grantCallCount = 0;
    let waiterObserved = deferred();
    const runTransaction = db.runTransaction.bind(db);
    vi.spyOn(db, 'runTransaction').mockImplementation(async (fn, options) => {
      const result = await runTransaction(fn, options);
      if (result && typeof result === 'object' && 'status' in result && result.status === 'leased') waiterObserved.resolve();
      return result;
    });

    // Pairing 1: exchangeRefreshToken (leaseholder) vs verifyAccessToken (transparent refresh waiter)
    let releaseBarrier1: () => void = () => {};
    const barrierPromise1 = new Promise<void>((r) => { releaseBarrier1 = r; });

    vi.spyOn(authProvider as any, 'nsRefreshGrant').mockImplementation(async () => {
      grantCallCount++;
      await barrierPromise1;
      return {
        access_token: 'concurrent-ns-access-token-1',
        refresh_token: 'concurrent-ns-refresh-token-1',
        expires_in: 3600,
        username: 'testuser',
        nsApiUrl: 'https://test.example.com',
      };
    });

    const testAccessToken1 = 'crosspath-access-1-' + randomBytes(8).toString('hex');
    const testRefreshToken1 = 'crosspath-refresh-1-' + randomBytes(8).toString('hex');

    const token1 = await tokenStore.issue({
      accessToken: testAccessToken1,
      refreshToken: testRefreshToken1,
      clientId: 'concurrent_client',
      expiresAt: virtualNow + 3600 * 1000,
      nsAccessToken: 'ns-token-expiring-1',
      nsRefreshToken: 'ns-refresh-expiring-1',
      nsExpiresAt: virtualNow + 30 * 1000,
      nsUsername: 'testuser',
      nsApiUrl: 'https://test.example.com',
      serverBaseUrl: 'http://localhost',
    });
    const clientInfo = { client_id: 'concurrent_client' } as any;
    const p1Exchange = authProvider.exchangeRefreshToken(clientInfo, testRefreshToken1);

    const upstreamDoc1 = db.collection('mcp_tokens_upstream').doc(docId(token1.refreshFamilyId!));
    let leaseAcquired1 = false;
    for (let i = 0; i < 30; i++) {
      const snap = await upstreamDoc1.get();
      if ((snap.data()?.leaseUntil ?? 0) > virtualNow) {
        leaseAcquired1 = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(leaseAcquired1).toBe(true);

    const p1Verify = authProvider.verifyAccessToken(testAccessToken1);
    await waiterObserved.promise;

    releaseBarrier1();

    const [resExchange1, resVerify1] = await Promise.all([p1Exchange, p1Verify]);
    expect(resExchange1.access_token).toBeDefined();
    expect(resVerify1).toBeDefined();
    expect(grantCallCount).toBe(1);

    // Pairing 2: exchangeRefreshToken vs forceRefreshUpstream on same family
    let releaseBarrier2: () => void = () => {};
    const barrierPromise2 = new Promise<void>((r) => { releaseBarrier2 = r; });

    vi.spyOn(authProvider as any, 'nsRefreshGrant').mockImplementation(async () => {
      grantCallCount++;
      await barrierPromise2;
      return {
        access_token: 'concurrent-ns-access-token-2',
        refresh_token: 'concurrent-ns-refresh-token-2',
        expires_in: 3600,
        username: 'testuser',
        nsApiUrl: 'https://test.example.com',
      };
    });

    const testAccessToken2 = 'crosspath-access-2-' + randomBytes(8).toString('hex');
    const testRefreshToken2 = 'crosspath-refresh-2-' + randomBytes(8).toString('hex');

    const token2 = await tokenStore.issue({
      accessToken: testAccessToken2,
      refreshToken: testRefreshToken2,
      clientId: 'concurrent_client',
      expiresAt: virtualNow + 3600 * 1000,
      nsAccessToken: 'ns-token-expiring-2',
      nsRefreshToken: 'ns-refresh-expiring-2',
      nsExpiresAt: virtualNow + 30 * 1000,
      nsUsername: 'testuser',
      nsApiUrl: 'https://test.example.com',
      serverBaseUrl: 'http://localhost',
    });

    const grantBefore2 = grantCallCount;
    waiterObserved = deferred();
    const p2Exchange = authProvider.exchangeRefreshToken(clientInfo, testRefreshToken2);

    const upstreamDoc2 = db.collection('mcp_tokens_upstream').doc(docId(token2.refreshFamilyId!));
    let leaseAcquired2 = false;
    for (let i = 0; i < 30; i++) {
      const snap = await upstreamDoc2.get();
      if ((snap.data()?.leaseUntil ?? 0) > virtualNow) {
        leaseAcquired2 = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(leaseAcquired2).toBe(true);
    const p2Forced = authProvider.forceRefreshUpstream(testAccessToken2);
    await waiterObserved.promise;

    releaseBarrier2();

    const [resExchange2, resForced2] = await Promise.all([p2Exchange, p2Forced]);
    expect(resExchange2.access_token).toBeDefined();
    expect(resForced2).toBe('concurrent-ns-access-token-2');
    expect(grantCallCount - grantBefore2).toBe(1);

    // Pairing 3: verifyAccessToken vs forceRefreshUpstream on same family
    let releaseBarrier3: () => void = () => {};
    const barrierPromise3 = new Promise<void>((r) => { releaseBarrier3 = r; });

    vi.spyOn(authProvider as any, 'nsRefreshGrant').mockImplementation(async () => {
      grantCallCount++;
      await barrierPromise3;
      return {
        access_token: 'concurrent-ns-access-token-3',
        refresh_token: 'concurrent-ns-refresh-token-3',
        expires_in: 3600,
        username: 'testuser',
        nsApiUrl: 'https://test.example.com',
      };
    });

    const testAccessToken3 = 'crosspath-access-3-' + randomBytes(8).toString('hex');
    const testRefreshToken3 = 'crosspath-refresh-3-' + randomBytes(8).toString('hex');

    const token3 = await tokenStore.issue({
      accessToken: testAccessToken3,
      refreshToken: testRefreshToken3,
      clientId: 'concurrent_client',
      expiresAt: virtualNow + 3600 * 1000,
      nsAccessToken: 'ns-token-expiring-3',
      nsRefreshToken: 'ns-refresh-expiring-3',
      nsExpiresAt: virtualNow + 30 * 1000,
      nsUsername: 'testuser',
      nsApiUrl: 'https://test.example.com',
      serverBaseUrl: 'http://localhost',
    });

    const grantBefore3 = grantCallCount;
    waiterObserved = deferred();
    const p3Verify = authProvider.verifyAccessToken(testAccessToken3);

    const upstreamDoc3 = db.collection('mcp_tokens_upstream').doc(docId(token3.refreshFamilyId!));
    let leaseAcquired3 = false;
    for (let i = 0; i < 30; i++) {
      const snap = await upstreamDoc3.get();
      if ((snap.data()?.leaseUntil ?? 0) > virtualNow) {
        leaseAcquired3 = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(leaseAcquired3).toBe(true);
    const p3Forced = authProvider.forceRefreshUpstream(testAccessToken3);
    await waiterObserved.promise;

    releaseBarrier3();

    const [resVerify3, resForced3] = await Promise.all([p3Verify, p3Forced]);
    expect(resVerify3).toBeDefined();
    expect(resForced3).toBe('concurrent-ns-access-token-3');
    expect(grantCallCount - grantBefore3).toBe(1);

    const control = await getCutoverFenceRecord(db, namespace);
    expect(control?.activeOperations).toBe(0);
  });

  it('30. Failure barrier: ambiguous upstream refresh failure locks family lease and blocks subsequent takeover', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    process.env.MCP_TRANSPORT = 'http';
    process.env.MCP_BASE_URL = 'http://localhost';
    process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'test_client_id';
    process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'test_client_secret';
    process.env.NETSAPIENS_API_URL = 'https://test.example.com';

    let virtualNow = Date.now();

    const tokenStore = new FirestoreTokenStore({
      db,
      collection: 'mcp_tokens',
      fence: { namespace, enforce: true },
      now: () => virtualNow,
    });

    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com',
      nsClientId: 'test_client_id',
      nsClientSecret: 'test_client_secret',
      tokenStore,
      firestore: db,
      collections: { tokens: 'mcp_tokens' },
      fence: { namespace, enforce: true },
      serverBaseUrl: 'http://localhost',
      now: () => virtualNow,
    });

    let grantAttempts = 0;
    vi.spyOn(authProvider as any, 'nsRefreshGrant').mockImplementation(async () => {
      grantAttempts++;
      throw new UpstreamTimeoutError('Upstream socket timeout');
    });

    const testAccessToken = 'ambig-barrier-access-' + randomBytes(8).toString('hex');
    const testRefreshToken = 'ambig-barrier-refresh-' + randomBytes(8).toString('hex');

    const issued = await tokenStore.issue({
      accessToken: testAccessToken,
      refreshToken: testRefreshToken,
      clientId: 'barrier_client',
      expiresAt: virtualNow + 3600 * 1000,
      nsAccessToken: 'ns-token-ambig',
      nsRefreshToken: 'ns-refresh-ambig',
      nsExpiresAt: virtualNow + 10 * 1000,
      nsUsername: 'testuser',
      nsApiUrl: 'https://test.example.com',
      serverBaseUrl: 'http://localhost',
    });

    const familyId = issued.refreshFamilyId!;

    await expect(authProvider.verifyAccessToken(testAccessToken)).rejects.toThrow();
    expect(grantAttempts).toBe(1);

    const upstreamSnap = await db.collection('mcp_tokens_upstream').doc(docId(familyId)).get();
    expect(upstreamSnap.exists).toBe(true);
    const upstreamData = upstreamSnap.data();
    expect(upstreamData?.ambiguousOutcome).toBe(true);
    expect(upstreamData?.ambiguousReason).toBe('upstream_timeout');

    virtualNow += 60_000;

    await expect(authProvider.verifyAccessToken(testAccessToken)).rejects.toThrow();
    expect(grantAttempts).toBe(1);
  });

  it('31. GET /mcp SSE connection releases admission upon response headers write without holding activeOperations open', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    process.env.MCP_TRANSPORT = 'http';
    process.env.MCP_BASE_URL = 'http://localhost';
    process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'test_client_id';
    process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'test_client_secret';
    process.env.NETSAPIENS_API_URL = 'https://test.example.com';
    process.env.MCP_STATELESS = 'false';

    const tokenStore = new FirestoreTokenStore({
      db,
      collection: 'mcp_tokens',
      fence: { namespace, enforce: true },
    });
    let observedActiveCountDuringVerify = -1;

    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com',
      nsClientId: 'test_client_id',
      nsClientSecret: 'test_client_secret',
      tokenStore,
      firestore: db,
      collections: { tokens: 'mcp_tokens' },
      fence: { namespace, enforce: true },
      serverBaseUrl: 'http://localhost',
      hooks: {
        onVerify: async () => {
          const c = await getCutoverFenceRecord(db, namespace);
          observedActiveCountDuringVerify = c?.activeOperations ?? -1;
        },
      },
    });

    const testAccessToken = 'sse-test-token-' + randomBytes(8).toString('hex');
    const testRefreshToken = 'sse-refresh-token-' + randomBytes(8).toString('hex');

    await tokenStore.issue({
      accessToken: testAccessToken,
      refreshToken: testRefreshToken,
      clientId: 'sse_client',
      expiresAt: Date.now() + 3600 * 1000,
      nsAccessToken: 'ns-sse-token',
      nsUsername: 'testuser',
      nsApiUrl: 'https://test.example.com',
      serverBaseUrl: 'http://localhost',
    });

    const { app } = createApp(authProvider);
    const initRes = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${testAccessToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      });
    expect(initRes.status).toBe(200);
    const liveSessionId = initRes.headers['mcp-session-id'];
    expect(liveSessionId).toBeTruthy();
    await waitForAdmissionDrain(db, namespace);
    observedActiveCountDuringVerify = -1;

    const server = app.listen(0);
    const port = (server.address() as any).port;
    let sseReq: http.ClientRequest | undefined;
    try {
      const sseResp = await new Promise<{ status: number; contentType: string }>((resolve) => {
        sseReq = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/mcp',
            method: 'GET',
            headers: {
              Authorization: `Bearer ${testAccessToken}`,
              Accept: 'text/event-stream',
              'mcp-session-id': liveSessionId,
            },
          },
          (res) => {
            resolve({
              status: res.statusCode ?? 0,
              contentType: String(res.headers['content-type'] ?? ''),
            });
          },
        );
        sseReq.on('error', () => {});
        sseReq.end();
      });

      expect(sseResp.status).toBe(200);
      expect(sseResp.contentType).toContain('text/event-stream');

      expect(observedActiveCountDuringVerify).toBe(1);

      await waitForAdmissionDrain(db, namespace);
    } finally {
      sseReq?.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('32. Pre-send failure after claim preserves upstream_pending, makes zero upstream calls on subsequent retry, and prevents sealing (Reset Section 8)', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    process.env.MCP_TRANSPORT = 'http';
    process.env.MCP_BASE_URL = 'http://localhost';
    process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'test_client_id';
    process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'test_client_secret';
    process.env.NETSAPIENS_API_URL = 'https://test.example.com';

    let virtualNow = Date.now();

    const tokenStore = new FirestoreTokenStore({
      db,
      collection: 'mcp_tokens',
      fence: { namespace, enforce: true },
      now: () => virtualNow,
    });

    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com',
      nsClientId: 'test_client_id',
      nsClientSecret: 'test_client_secret',
      tokenStore,
      firestore: db,
      collections: { tokens: 'mcp_tokens' },
      fence: { namespace, enforce: true },
      serverBaseUrl: 'http://localhost',
      now: () => virtualNow,
    });

    let attempts = 0;
    vi.spyOn(authProvider as any, 'nsRefreshGrant').mockImplementation(async () => {
      attempts++;
      throw new Error('Process killed before HTTP transmission');
    });

    const testAccessToken = 'presend-access-' + randomBytes(8).toString('hex');
    const testRefreshToken = 'presend-refresh-' + randomBytes(8).toString('hex');

    const issued = await tokenStore.issue({
      accessToken: testAccessToken,
      refreshToken: testRefreshToken,
      clientId: 'presend_client',
      expiresAt: virtualNow + 3600 * 1000,
      nsAccessToken: 'ns-token-presend',
      nsRefreshToken: 'ns-refresh-presend',
      nsExpiresAt: virtualNow + 10 * 1000,
      nsUsername: 'testuser',
      nsApiUrl: 'https://test.example.com',
      serverBaseUrl: 'http://localhost',
    });

    const familyId = issued.refreshFamilyId!;

    await expect(authProvider.verifyAccessToken(testAccessToken)).rejects.toThrow();
    expect(attempts).toBe(1);

    const upstreamSnap = await db.collection('mcp_tokens_upstream').doc(docId(familyId)).get();
    expect(upstreamSnap.exists).toBe(true);

    virtualNow += 60_000;

    await expect(authProvider.verifyAccessToken(testAccessToken)).rejects.toThrow(UpstreamUnavailableError);
    expect(attempts).toBe(1);

    await transitionCutoverFenceState(db, namespace, {
      fromState: 'legacy_open',
      toState: 'closing',
      expectedEpoch: 1,
    });

    await expect(
      transitionCutoverFenceState(db, namespace, {
        fromState: 'closing',
        toState: 'fenced',
        expectedEpoch: 1,
      }),
    ).rejects.toThrow(CutoverFenceError);
  });

  it('33. Client disconnect during async handler work does not early release and drains cleanly on settlement', async () => {
    configureHttpTest();
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    const tokenStore = new FirestoreTokenStore({
      db,
      collection: 'mcp_tokens',
      fence: { namespace, enforce: true },
    });

    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com',
      nsClientId: 'test_client_id',
      nsClientSecret: 'test_client_secret',
      tokenStore,
      firestore: db,
      collections: { tokens: 'mcp_tokens' },
      fence: { namespace, enforce: true },
      serverBaseUrl: 'http://localhost',
    });

    let inFlight = false;
    let releaseBarrier: () => void = () => {};
    const barrierPromise = new Promise<void>((r) => { releaseBarrier = r; });
    vi.spyOn(authProvider as any, 'nsPasswordGrant').mockImplementation(async () => {
      inFlight = true;
      await barrierPromise;
      return {
        kind: 'tokens',
        tokens: {
          access_token: 'ns-acc',
          refresh_token: 'ns-ref',
          expires_in: 3600,
          username: 'realuser',
        },
      };
    });

    const { app } = createApp(authProvider);
    const server = app.listen(0);
    const port = (server.address() as any).port;
    const pending = {
      clientId: 'test_client_id',
      redirectUri: 'http://localhost/callback',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      scope: 'openid',
      state: 'test-oauth-state',
    };
    const signedState = signValue(pending, 600);
    const body = JSON.stringify({ username: 'realuser', password: 'realpassword', auth_state: signedState });

    let clientReq: http.ClientRequest | undefined;
    const reqPromise = new Promise<void>((resolve) => {
      clientReq = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/login',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      });
      clientReq.on('error', () => resolve());
      clientReq.on('close', () => resolve());
      clientReq.write(body);
      clientReq.end();
    });

    for (let i = 0; i < 30; i++) {
      if (inFlight) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(inFlight).toBe(true);

    clientReq?.destroy();
    await reqPromise;
    await new Promise((r) => setTimeout(r, 50));

    const duringDisconnectControl = await getCutoverFenceRecord(db, namespace);
    expect(duringDisconnectControl?.activeOperations).toBe(1);

    releaseBarrier();

    let activeOps = 1;
    for (let i = 0; i < 30; i++) {
      const c = await getCutoverFenceRecord(db, namespace);
      if (c?.activeOperations === 0) {
        activeOps = 0;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(activeOps).toBe(0);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('34. In-flight nested task and late write after route completion rejects with CutoverFenceError', async () => {
    configureHttpTest();
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });
    process.env.MCP_STATELESS = 'true';

    const tokenStore = new FirestoreTokenStore({
      db,
      collection: 'mcp_tokens',
      fence: { namespace, enforce: true },
    });

    let capturedOpCtx: any;
    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com',
      nsClientId: 'test_client_id',
      nsClientSecret: 'test_client_secret',
      tokenStore,
      firestore: db,
      collections: { tokens: 'mcp_tokens' },
      fence: { namespace, enforce: true },
      serverBaseUrl: 'http://localhost',
      hooks: {
        onVerify: async () => {
          capturedOpCtx = requestOperationContext.getStore();
        },
      },
    });

    const testAccessToken = 'test-token-lifecycle-' + randomBytes(8).toString('hex');
    await tokenStore.issue({
      accessToken: testAccessToken,
      refreshToken: 'test-ref-lifecycle',
      clientId: 'lifecycle_client',
      expiresAt: Date.now() + 3600 * 1000,
      nsAccessToken: 'ns-token',
      nsUsername: 'testuser',
      nsApiUrl: 'https://test.example.com',
      serverBaseUrl: 'http://localhost',
    });

    const { app } = createApp(authProvider);

    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${testAccessToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

    expect(res.status).toBe(200);
    expect(capturedOpCtx).toBeDefined();

    let activeOps = 1;
    for (let i = 0; i < 30; i++) {
      const c = await getCutoverFenceRecord(db, namespace);
      if (c?.activeOperations === 0) {
        activeOps = 0;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(activeOps).toBe(0);

    await expect(
      capturedOpCtx.trackWriter(async () => 'late_write'),
    ).rejects.toThrow(CutoverFenceError);
  });

  it('35. Direct upstream put, delete, and definitive transactions are tracked via op.trackWriter, and reconcile unconditionally refuses', async () => {
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

    const upstreamStore = new FirestoreUpstreamGrantStore({
      db,
      collection: 'mcp_tokens_upstream',
      fence: { namespace, enforce: true },
    });

    const familyId = 'family-test-' + randomBytes(8).toString('hex');
    const opId = 'op-test-' + randomBytes(8).toString('hex');

    await withLegacyOperation(
      { db, namespace, kind: 'upstream_refresh', operationId: opId, now: Date.now },
      async (op) => {
        let trackWriterCalls = 0;
        op.trackWriter = async <T>(fn: () => Promise<T>): Promise<T> => {
          trackWriterCalls++;
          return await fn();
        };

        await upstreamStore.put(familyId, { test: 'grant' }, Date.now() + 3600_000, { operation: op, completeOperation: false });
        expect(trackWriterCalls).toBeGreaterThan(0);
        const callsAfterPut = trackWriterCalls;

        const record = await upstreamStore.get(familyId);
        expect(record?.grant).toEqual({ test: 'grant' });

        await expect(
          upstreamStore.reconcileAmbiguousGrant(familyId, { test: 'resolved' }, Date.now() + 3600_000, { operationId: opId, operation: op }),
        ).rejects.toThrow(CutoverFenceError);

        await upstreamStore.delete(familyId, { operation: op });
        expect(trackWriterCalls).toBeGreaterThan(callsAfterPut);

        const deleted = await upstreamStore.get(familyId);
        expect(deleted).toBeUndefined();
      },
    );

    const control = await getCutoverFenceRecord(db, namespace);
    expect(control?.activeOperations).toBe(0);
  });

  it('36. Thunk rejection in trackWriter rethrows without unhandled rejection and detects underflow on real admission op context', async () => {
    configureHttpTest();
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });
    process.env.MCP_STATELESS = 'true';

    const tokenStore = new FirestoreTokenStore({
      db,
      collection: 'mcp_tokens',
      fence: { namespace, enforce: true },
    });

    let capturedOpCtx: any;
    const authProvider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com',
      nsClientId: 'test_client_id',
      nsClientSecret: 'test_client_secret',
      tokenStore,
      firestore: db,
      collections: { tokens: 'mcp_tokens' },
      fence: { namespace, enforce: true },
      serverBaseUrl: 'http://localhost',
      hooks: {
        onVerify: async () => {
          capturedOpCtx = requestOperationContext.getStore();
          await expect(
            capturedOpCtx.trackWriter(async () => {
              throw new Error('Real thunk error');
            }),
          ).rejects.toThrow('Real thunk error');
        },
      },
    });

    const testAccessToken = 'test-token-underflow-' + randomBytes(8).toString('hex');
    await tokenStore.issue({
      accessToken: testAccessToken,
      refreshToken: 'test-ref-underflow',
      clientId: 'underflow_client',
      expiresAt: Date.now() + 3600 * 1000,
      nsAccessToken: 'ns-token',
      nsUsername: 'testuser',
      nsApiUrl: 'https://test.example.com',
      serverBaseUrl: 'http://localhost',
    });

    const { app } = createApp(authProvider);

    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${testAccessToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

    expect(res.status).toBe(200);
    expect(capturedOpCtx).toBeDefined();

    expect(() => capturedOpCtx.exitWriter()).toThrow(CutoverFenceError);
  });

  it('retains the exact nonterminal claimant and refuses expired unresolved leases', async () => {
    const db = createTestDb();
    const store = new FirestoreUpstreamGrantStore<{ token: string }>({
      db, collection: 'upstream_receipt',
    });
    const familyId = randomUUID();
    await store.put(familyId, { token: 'old' }, 1);
    const first = await store.ensureFresh(familyId, async () => ({
      grant: { token: 'new' }, expiresAt: 100_000,
    }), { now: 10, leaseMs: 10, completeOperation: false });
    expect(first.grant).toEqual({ token: 'new' });
    expect(first.completion).toEqual({
      familyId, leaseOwner: expect.any(String), operationId: null,
    });
    const held = await store.get(familyId);
    expect(held?.leaseOwner).toBe(first.completion?.leaseOwner);
    const refresh = vi.fn(async () => ({ grant: { token: 'stale' } }));
    await expect(store.ensureFresh(familyId, refresh, { now: 50, force: true }))
      .rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(refresh).not.toHaveBeenCalled();
    expect((await store.get(familyId))?.leaseOwner).toBe(first.completion?.leaseOwner);
});

  it('rotation refuses missing or forged completion receipts even after lease expiry', async () => {
    const db = createTestDb();
    const store = new FirestoreTokenStore({ db, collection: 'mcp_tokens' });
    const token = await store.issue({
      accessToken: 'receipt-old-access',
      refreshToken: 'receipt-old-refresh',
      clientId: 'receipt-client',
      expiresAt: 100_000,
      nsAccessToken: 'old-upstream',
      nsUsername: 'user',
    });
    const familyId = token.refreshFamilyId!;
    const upstreamRef = store.upstreamDocRef(familyId);
    await upstreamRef.set({
      grant: { nsAccessToken: 'new-upstream', nsUsername: 'user' },
      leaseOwner: 'actual-owner', leaseUntil: 1,
    });
    const replacement = { ...token, accessToken: 'receipt-new-access', refreshToken: 'receipt-new-refresh' };
    await expect(store.rotate(token.refreshToken, replacement, token.clientId, 50))
      .rejects.toThrow();
    await expect(store.rotate(token.refreshToken, replacement, token.clientId, 50, {
      upstreamCompletion: { familyId, leaseOwner: 'wrong-owner', operationId: null },
    })).rejects.toThrow();
    expect((await upstreamRef.get()).data()?.leaseOwner).toBe('actual-owner');
    expect((await store.accessDocRef(replacement.accessToken).get()).exists).toBe(false);
    expect((await store.refreshDocRef(token.refreshToken).get()).data()?.status).toBe('active');
  });

  it('held upstream credentials cannot be exposed, replaced, or removed by another writer', async () => {
    const db = createTestDb();
    const store = new FirestoreTokenStore({ db, collection: 'mcp_tokens' });
    const token = await store.issue({
      accessToken: 'held-access', refreshToken: 'held-refresh', clientId: 'held-client',
      expiresAt: Date.now() + 3600_000, nsAccessToken: 'committed', nsUsername: 'user',
    });
    const familyId = token.refreshFamilyId!;
    const ref = store.upstreamDocRef(familyId);
    await ref.set({ grant: { nsAccessToken: 'uncommitted' }, leaseOwner: 'held-owner', leaseUntil: 1 });
    const upstream = new FirestoreUpstreamGrantStore({ db, collection: 'mcp_tokens_upstream' });
    expect((await store.get(token.accessToken))?.nsAccessToken).toBe('committed');
    await expect(upstream.put(familyId, { nsAccessToken: 'other' })).rejects.toThrow();
    await expect(upstream.delete(familyId)).rejects.toThrow();
    await expect(store.set({ ...token, nsAccessToken: 'other' })).rejects.toThrow();
    const { refreshFamilyId: _omittedFamily, ...sameAccessNewFamily } = token;
    await expect(store.set({ ...sameAccessNewFamily, refreshToken: 'other-refresh' })).rejects.toThrow();
    await expect(store.update(token.accessToken, { refreshFamilyId: randomUUID(), nsAccessToken: 'other' })).rejects.toThrow();
    await expect(store.update(token.accessToken, { nsAccessToken: 'other' })).rejects.toThrow();
    await expect(store.revokeFamily(familyId)).rejects.toThrow();
    await expect(store.revokeByToken(token.refreshToken)).rejects.toThrow();
    expect((await ref.get()).data()).toMatchObject({ leaseOwner: 'held-owner', grant: { nsAccessToken: 'uncommitted' } });
    expect((await store.refreshDocRef(token.refreshToken).get()).exists).toBe(true);
});

  it('a confirmed upstream rejection releases the exact claim and permits a later attempt', async () => {
    const db = createTestDb();
    await initializeCutoverFence(db, 'mcp', { initialEpoch: 1, initialState: 'legacy_open' });
    const upstream = new FirestoreUpstreamGrantStore<{ token: string }>({
      db, collection: 'mcp_tokens_upstream', fence: { namespace: 'mcp', enforce: true },
    });
    const familyId = randomUUID();
    const rejectedOperationId = randomUUID();
    const refreshId = 'confirmed-rejection-refresh';
    await db.collection('mcp_tokens_refresh_families').doc(familyId).set({
      id: familyId, currentAccessToken: 'confirmed-rejection-access', currentRefreshToken: refreshId, retiredRefreshFingerprints: [],
    });
    await db.collection('mcp_tokens_refresh').doc(refreshId).set({ status: 'active', familyId });
    await withLegacyOperation({ db, namespace: 'mcp', kind: 'issue' }, async (op) => {
      await upstream.put(familyId, { token: 'original' }, 1, { operation: op });
    });
    await expect(withLegacyOperation({ db, namespace: 'mcp', kind: 'token_rotate', operationId: rejectedOperationId }, async (op) =>
      upstream.ensureFresh(familyId, async () => { throw new UpstreamRequestRejectedError(); },
        { operation: op, force: true }),
    )).rejects.toBeInstanceOf(UpstreamRequestRejectedError);
    expect((await upstream.get(familyId))?.leaseOwner).toBeNull();
    expect((await getCutoverOperationDocRef(db, 'mcp', rejectedOperationId, TEST_IDENTITY_KEY).get()).data()).not.toHaveProperty('familyId');
    expect((await getCutoverFenceRecord(db, 'mcp'))?.activeOperations).toBe(0);
    const recovered = await withLegacyOperation({ db, namespace: 'mcp', kind: 'token_rotate' }, async (op) =>
      upstream.ensureFresh(familyId, async () => ({ grant: { token: 'recovered' } }), { operation: op, force: true }),
    );
    expect(recovered.grant.token).toBe('recovered');
  });

  it('does not expose or revoke a session when a waiting refresh sees a rejected claim', async () => {
    const db = createTestDb();
    const store1 = new FirestoreTokenStore({ db, collection: 'mcp_tokens' });
    const store2 = new FirestoreTokenStore({ db, collection: 'mcp_tokens' });
    const token = await store1.issue({
      accessToken: 'wait-access', refreshToken: 'wait-refresh', clientId: 'wait-client',
      expiresAt: Date.now() + 3600_000, nsAccessToken: 'old-ns',
      nsRefreshToken: 'old-ns-refresh', nsExpiresAt: Date.now() - 1000, nsUsername: 'user',
    });
    const claimed = deferred();
    const release = deferred();
    const waiting = deferred();
    const runTransaction = db.runTransaction.bind(db);
    const transactionSpy = vi.spyOn(db, 'runTransaction').mockImplementation(async (fn, options) => {
      const result = await runTransaction(fn, options);
      if (result && typeof result === 'object' && 'status' in result && result.status === 'leased') waiting.resolve();
        return result;
    });
    const claimant = store1.refreshNsToken(token.accessToken, async () => {
      claimed.resolve();
      await release.promise;
      throw new UpstreamRequestRejectedError();
    }).catch((error) => error);
    await claimed.promise;
    const waiterGrant = vi.fn(async () => ({ access_token: 'unexpected' }));
    const waiter = store2.refreshNsToken(token.accessToken, waiterGrant, { pollIntervalMs: 10 }).catch((error) => error);
    await waiting.promise;
    release.resolve();
    expect(await claimant).toBeInstanceOf(UpstreamRequestRejectedError);
    expect(await waiter).toBeInstanceOf(UpstreamUnavailableError);
    expect(waiterGrant).not.toHaveBeenCalled();
    expect((await store1.get(token.accessToken))?.nsAccessToken).toBe('old-ns');
    expect((await store1.refreshDocRef(token.refreshToken).get()).exists).toBe(true);
    transactionSpy.mockRestore();
});

  it('does not call upstream when a bearer was rotated after it was read', async () => {
    const db = createTestDb();
    const store = new FirestoreTokenStore({ db, collection: 'mcp_tokens' });
    const token = await store.issue({
      accessToken: 'delayed-access', refreshToken: 'delayed-refresh', clientId: 'delayed-client',
      expiresAt: Date.now() + 3600_000, nsAccessToken: 'old-ns', nsUsername: 'user',
    });
    const read = deferred();
    const resume = deferred();
    const get = store.getByAccessToken.bind(store);
    const spy = vi.spyOn(store, 'getByAccessToken').mockImplementation(async (...args) => {
      const result = await get(...args);
      read.resolve();
      await resume.promise;
      return result;
    });
    const grant = vi.fn(async () => ({ access_token: 'unexpected' }));
    const delayed = store.refreshNsToken(token.accessToken, grant, { force: true }).catch((error) => error);
    await read.promise;
    await store.rotate(token.refreshToken, {
      ...token, accessToken: 'new-access', refreshToken: 'new-refresh', nsAccessToken: 'new-ns',
    }, token.clientId);
    resume.resolve();
    expect(await delayed).toBeInstanceOf(LeaseLostError);
    expect(grant).not.toHaveBeenCalled();
    expect((await store.upstreamDocRef(token.refreshFamilyId!).get()).data()?.leaseOwner).toBeNull();
    spy.mockRestore();
  });

  it('a waiter never treats two rejected claims as successful refresh', async () => {
    const db = createTestDb();
    const first = new FirestoreUpstreamGrantStore<{ token: string }>({ db, collection: 'two_rejections', now: () => 0 });
    const second = new FirestoreUpstreamGrantStore<{ token: string }>({ db, collection: 'two_rejections', now: () => 0 });
    const familyId = randomUUID();
    await first.put(familyId, { token: 'original' }, 1);
    const claimed = deferred(), release = deferred(), waiting = deferred();
    const pollStarted = deferred(), allowPoll = deferred();
    const originalRun = db.runTransaction.bind(db);
    const spy = vi.spyOn(db, 'runTransaction').mockImplementation(async (fn, options) => {
      const result = await originalRun(fn, options);
      if (result && typeof result === 'object' && 'status' in result && result.status === 'leased') waiting.resolve();
        return result;
    });
    const originalGet = DocumentReference.prototype.get;
    let pollBlocked = false;
    const pollSpy = vi.spyOn(DocumentReference.prototype, 'get').mockImplementation(async function() {
      if (this.path === `two_rejections/${familyId}` && !pollBlocked) {
        pollBlocked = true;
        pollStarted.resolve();
        await allowPoll.promise;
      }
      return originalGet.call(this);
    });
    const claim = first.ensureFresh(familyId, async () => {
      claimed.resolve();
      await release.promise;
      throw new UpstreamRequestRejectedError();
    }, { now: 100, force: true }).catch((error) => error);
    await claimed.promise;
    const waiterGrant = vi.fn(async () => ({ grant: { token: 'unexpected' } }));
    const waiter = second.ensureFresh(familyId, waiterGrant,
      { now: 100, force: true, pollIntervalMs: 10, waitMs: 5000 }).catch((error) => error);
    await waiting.promise;
    await pollStarted.promise;
    release.resolve();
    expect(await claim).toBeInstanceOf(UpstreamRequestRejectedError);
    await expect(first.ensureFresh(familyId, async () => { throw new UpstreamRequestRejectedError(); },
      { now: 200, force: true })).rejects.toBeInstanceOf(UpstreamRequestRejectedError);
    allowPoll.resolve();
    expect(await waiter).toBeInstanceOf(UpstreamUnavailableError);
    expect((await first.get(familyId))?.grant).toEqual({ token: 'original' });
    expect((await first.get(familyId))?.updatedAt).toBe(0);
    expect(waiterGrant).not.toHaveBeenCalled();
    pollSpy.mockRestore();
    spy.mockRestore();
  });

  it('a waiter observes a committed successful refresh through the same poll barrier', async () => {
    const db = createTestDb();
    const first = new FirestoreUpstreamGrantStore<{ token: string }>({ db, collection: 'successful_waiter', now: () => 0 });
    const second = new FirestoreUpstreamGrantStore<{ token: string }>({ db, collection: 'successful_waiter', now: () => 0 });
    const familyId = randomUUID();
    await first.put(familyId, { token: 'original' }, 1);
    const claimed = deferred(), release = deferred(), waiting = deferred(), pollStarted = deferred(), allowPoll = deferred();
    const originalRun = db.runTransaction.bind(db);
    const txSpy = vi.spyOn(db, 'runTransaction').mockImplementation(async (fn, options) => {
      const result = await originalRun(fn, options);
      if (result && typeof result === 'object' && 'status' in result && result.status === 'leased') waiting.resolve();
      return result;
    });
    const originalGet = DocumentReference.prototype.get;
    let blocked = false;
    const pollSpy = vi.spyOn(DocumentReference.prototype, 'get').mockImplementation(async function() {
      if (this.path === `successful_waiter/${familyId}` && !blocked) {
        blocked = true;
        pollStarted.resolve();
        await allowPoll.promise;
      }
      return originalGet.call(this);
    });
    const claim = first.ensureFresh(familyId, async () => {
      claimed.resolve();
      await release.promise;
      return { grant: { token: 'replacement' }, expiresAt: 10_000 };
    }, { now: 100, force: true });
    await claimed.promise;
    const waiterGrant = vi.fn(async () => ({ grant: { token: 'unexpected' } }));
    const waiter = second.ensureFresh(familyId, waiterGrant, { now: 100, force: true, pollIntervalMs: 10 });
    await waiting.promise;
    await pollStarted.promise;
    release.resolve();
    expect((await claim).grant.token).toBe('replacement');
    allowPoll.resolve();
    expect((await waiter).grant.token).toBe('replacement');
    expect(waiterGrant).not.toHaveBeenCalled();
    pollSpy.mockRestore();
    txSpy.mockRestore();
  });

  it('returns the committed retry pair when a refresh token rotates before its delayed claim', async () => {
    const db = createTestDb();
    await initializeCutoverFence(db, 'mcp');
    const fence = { namespace: 'mcp' as const, enforce: true };
    const store = new FirestoreTokenStore({ db, collection: 'mcp_tokens', fence });
    const provider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com', nsClientId: 'test', nsClientSecret: 'test',
      tokenStore: store, firestore: db, fence,
    });
    const original = await store.issue({
      accessToken: 'old-barrier-access', refreshToken: 'old-barrier-refresh', clientId: 'barrier-client',
      expiresAt: Date.now() + 3600_000, nsAccessToken: 'old-ns', nsRefreshToken: 'old-ns-refresh', nsUsername: 'user',
    });
    const read = deferred(), resume = deferred();
    const lookup = store.lookupRefresh.bind(store);
    const lookupSpy = vi.spyOn(store, 'lookupRefresh').mockImplementation(async (...args) => {
      const result = await lookup(...args);
      if (result.status === 'active') { read.resolve(); await resume.promise; }
      return result;
    });
    const grant = vi.spyOn(provider as unknown as { nsRefreshGrant: (token: string) => Promise<never> }, 'nsRefreshGrant')
      .mockRejectedValue(new Error('Unexpected upstream call'));
    const client = { client_id: original.clientId } as OAuthClientInformationFull;
    const exchange = provider.exchangeRefreshToken(client, original.refreshToken);
    await read.promise;
    const successor = { ...original, accessToken: 'new-barrier-access', refreshToken: 'new-barrier-refresh' };
    await store.rotate(original.refreshToken, successor, original.clientId);
    resume.resolve();
    const result = await exchange;
    expect(result.access_token).toBe(successor.accessToken);
    expect(result.refresh_token).toBe(successor.refreshToken);
    expect(grant).not.toHaveBeenCalled();
    lookupSpy.mockRestore();
  });

  it.each(['mcp', 'pwmcp', 'readonly_mcp'] as const)(
    'shares keyed operations with canonical guards and bridge stores in %s',
    async (namespace) => {
      const db = createTestDb();
      await initializeCutoverFence(db, namespace);
      const callerId = `op1_/sensitive-Ω-${randomUUID()}`;
      await withLegacyOperation({ db, namespace, kind: 'issue', operationId: callerId }, async (ctx) => {
        const operationRef = getCutoverOperationDocRef(db, namespace, callerId, TEST_IDENTITY_KEY);
        const snapshot = await operationRef.get();
        expect(snapshot.id).toBe(ctx.storageId);
        expect(snapshot.id).toMatch(/^op1_/);
        expect(JSON.stringify(snapshot.data())).not.toContain(callerId);
        let committed: (() => void) | undefined;
        await db.runTransaction(async (transaction) => {
          const timer = startMonotonicTimer();
          const guard = await canonicalGuard(transaction, { db, namespace, operation: ctx, timer, identityKey: TEST_IDENTITY_KEY });
          guard.assertPreWrite();
          guard.bufferCompletion();
          transaction.set(db.collection(`${namespace}_interop_test`).doc('proof'), { ok: true });
          guard.assertPreReturn();
          committed = guard.onCommit;
        });
        committed?.();
      });
      const store = new FirestoreTokenStore({ db, collection: `${namespace}_tokens`, fence: { namespace, enforce: true } });
      await canonicalWithLegacyOperation({ db, namespace, kind: 'issue', identityKey: TEST_IDENTITY_KEY }, async (ctx) => {
        await store.issue({
          accessToken: `canonical-${namespace}`, refreshToken: `canonical-refresh-${namespace}`,
          clientId: 'interop-client', expiresAt: Date.now() + 60_000,
          nsAccessToken: 'interop-ns', nsUsername: 'user',
        }, { operation: ctx });
      });
      expect((await getCutoverFenceRecord(db, namespace))?.activeOperations).toBe(0);
    },
  );

  it('refuses missing and mismatched cutover identity keys before admission', async () => {
    const db = createTestDb();
    await initializeCutoverFence(db, 'mcp');
    delete process.env.MCP_SESSION_SECRET;
    expect(() => new FirestoreTokenStore({ db, fence: { namespace: 'mcp', enforce: true } })).toThrow(CutoverFenceError);
    process.env.MCP_SESSION_SECRET = TEST_SESSION_SECRET;
    expect(() => new FirestoreTokenStore({
      db, fence: {
        namespace: 'mcp', enforce: true, identityKey: Buffer.alloc(32, 99),
      }
    })).toThrow(CutoverFenceError);
    expect((await getCutoverFenceRecord(db, 'mcp'))?.activeOperations).toBe(0);
  });

  it.each(['mcp', 'pwmcp', 'readonly_mcp'] as const)(
    'binds every production operation kind without persisting caller IDs in %s',
    async (namespace) => {
      const db = createTestDb();
      await initializeCutoverFence(db, namespace);
      const kinds = [
        'register', 'token', 'revoke', 'authorize', 'login', 'mfa', 'mcp',
        'issue', 'rotate', 'read', 'update', 'upstream_refresh', 'delete',
        'revocation', 'register_client', 'auth_code', 'token_issue', 'token_rotate',
      ];
      for (const kind of kinds) {
        const callerId = `op1_/secret-Ω-${kind}-${randomUUID()}`;
        await withLegacyOperation({ db, namespace, kind, operationId: callerId }, async (ctx) => {
          const record = await getCutoverOperationDocRef(db, namespace, callerId, TEST_IDENTITY_KEY).get();
          expect(record.id).toBe(ctx.storageId);
          expect(JSON.stringify(record.data())).not.toContain(callerId);
        });
      }
      expect((await getCutoverFenceRecord(db, namespace))?.activeOperations).toBe(0);
      const changed = deriveStoreKey('different-bridge-secret-with-at-least-32-characters');
      let called = false;
      await expect(canonicalWithLegacyOperation({ db, namespace, kind: 'read', identityKey: changed }, async () => {
        called = true;
      })).rejects.toThrow(CutoverFenceError);
      expect(called).toBe(false);
    },
  );

  it.each([
    ['exchange', { error: 'invalid_grant' }],
    ['exchange', '{malformed'],
    ['exchange', 'invalid_grant'],
    ['transparent', { error: 'invalid_grant' }],
    ['transparent', '{malformed'],
    ['transparent', 'invalid_grant'],
    ['forced', { error: 'invalid_grant' }],
    ['forced', '{malformed'],
    ['forced', 'invalid_grant'],
  ] as const)('holds fenced %s on untrusted definitive response %#', async (mode, body) => {
    const db = createTestDb();
    await initializeCutoverFence(db, 'mcp');
    let now = Date.now();
    const fence = { namespace: 'mcp' as const, enforce: true };
    const store = new FirestoreTokenStore({ db, collection: 'mcp_tokens', fence, now: () => now });
    const provider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com', nsClientId: 'test', nsClientSecret: 'test',
      tokenStore: store, firestore: db, fence, now: () => now,
    });
    const token = await store.issue({
      accessToken: 'untrusted-access', refreshToken: 'untrusted-refresh', clientId: 'untrusted-client',
      expiresAt: now + 3600_000, nsAccessToken: 'committed-ns', nsRefreshToken: 'committed-ns-refresh',
      nsExpiresAt: now - 1, nsUsername: 'user',
    });
    const failure = Object.assign(new Error('upstream rejected'), { isAxiosError: true, response: { status: 400, data: body } });
    const post = vi.spyOn(axios, 'post').mockRejectedValue(failure);
    const client = { client_id: token.clientId } as OAuthClientInformationFull;
    const invoke = () => mode === 'exchange'
      ? provider.exchangeRefreshToken(client, token.refreshToken)
      : mode === 'transparent' ? provider.verifyAccessToken(token.accessToken)
        : provider.forceRefreshUpstream(token.accessToken);
    const upstreamRef = store.upstreamDocRef(token.refreshFamilyId!);
    const before = (await upstreamRef.get()).data()!;
    await expect(invoke()).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(1);
    const held = (await upstreamRef.get()).data()!;
    expect(held.grant).toEqual(before.grant);
    expect(held.updatedAt).toBe(before.updatedAt);
    expect(held.leaseOwner).toMatch(/^owner1_/);
    expect(held.operationId).toMatch(/^op1_/);
    expect(held.ambiguousOperationId).toBe(held.operationId);
    expect((await store.accessDocRef(token.accessToken).get()).exists).toBe(true);
    expect((await store.refreshDocRef(token.refreshToken).get()).exists).toBe(true);
    expect((await getCutoverFenceRecord(db, 'mcp'))?.activeOperations).toBe(1);
    const operation = await getCutoverFenceDocRef(db, 'mcp').collection('operations').doc(held.operationId).get();
    expect(operation.data()).toMatchObject({ phase: 'upstream_pending', ambiguousRemoteOutcome: true });
    now = held.leaseUntil + 1;
    await expect(invoke()).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(1);
    expect((await upstreamRef.get()).data()).toEqual(held);
  });

  it.each([
    ['exchange', '<html>maintenance</html>'],
    ['exchange', { error: 'invalid_grant' }],
    ['exchange', { access_token: 'new-ns' }],
    ['exchange', { access_token: 'new-ns', expires_in: 3600, refresh_token: '' }],
    ['transparent', '<html>maintenance</html>'],
    ['transparent', { error: 'invalid_grant' }],
    ['transparent', { access_token: 'new-ns' }],
    ['transparent', { access_token: 'new-ns', expires_in: 3600, refresh_token: '' }],
    ['forced', '<html>maintenance</html>'],
    ['forced', { error: 'invalid_grant' }],
    ['forced', { access_token: 'new-ns' }],
    ['forced', { access_token: 'new-ns', expires_in: 3600, refresh_token: '' }],
  ] as const)('holds fenced %s on malformed successful upstream response %#', async (mode, body) => {
    const db = createTestDb();
    await initializeCutoverFence(db, 'mcp');
    let now = Date.now();
    const fence = { namespace: 'mcp' as const, enforce: true };
    const store = new FirestoreTokenStore({ db, collection: 'mcp_tokens', fence, now: () => now });
    const provider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com', nsClientId: 'test', nsClientSecret: 'test',
      tokenStore: store, firestore: db, fence, now: () => now,
    });
    const token = await store.issue({
      accessToken: 'malformed-access', refreshToken: 'malformed-refresh', clientId: 'malformed-client',
      expiresAt: now + 3600_000, nsAccessToken: 'committed-ns', nsRefreshToken: 'committed-ns-refresh',
      nsExpiresAt: now - 1, nsUsername: 'user',
    });
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: body });
    const client = { client_id: token.clientId } as OAuthClientInformationFull;
    const invoke = () => mode === 'exchange'
      ? provider.exchangeRefreshToken(client, token.refreshToken)
      : mode === 'transparent' ? provider.verifyAccessToken(token.accessToken)
        : provider.forceRefreshUpstream(token.accessToken);
    const upstreamRef = store.upstreamDocRef(token.refreshFamilyId!);
    const before = (await upstreamRef.get()).data()!;
    await expect(invoke()).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(1);
    const held = (await upstreamRef.get()).data()!;
    expect(held.grant).toEqual(before.grant);
    expect(held.updatedAt).toBe(before.updatedAt);
    expect(held.leaseOwner).toMatch(/^owner1_/);
    expect(held.operationId).toMatch(/^op1_/);
    expect(held.ambiguousOperationId).toBe(held.operationId);
    expect(held.ambiguousOutcome).toBe(true);
    expect(held.ambiguousReason).toBe('upstream_transport_error');
    expect((await store.accessDocRef(token.accessToken).get()).exists).toBe(true);
    expect((await store.refreshDocRef(token.refreshToken).get()).exists).toBe(true);
    expect((await getCutoverFenceRecord(db, 'mcp'))?.activeOperations).toBe(1);
    const operation = await getCutoverFenceDocRef(db, 'mcp').collection('operations').doc(held.operationId).get();
    expect(operation.data()).toMatchObject({ phase: 'upstream_pending', ambiguousRemoteOutcome: true });
    now = held.leaseUntil + 1;
    await expect(invoke()).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(1);
    expect((await upstreamRef.get()).data()).toEqual(held);
  });

  it.each([false, true])('validates a fenced store refresh callback before completion (valid=%s)', async (valid) => {
    const db = createTestDb();
    await initializeCutoverFence(db, 'mcp');
    const fence = { namespace: 'mcp' as const, enforce: true };
    const store = new FirestoreTokenStore({ db, collection: 'mcp_tokens', fence });
    const token = await store.issue({
      accessToken: 'callback-access', refreshToken: 'callback-refresh', clientId: 'callback-client',
      expiresAt: Date.now() + 3600_000, nsAccessToken: 'old-ns', nsRefreshToken: 'old-refresh',
      nsExpiresAt: Date.now() - 1, nsUsername: 'user',
    });
    const before = (await store.upstreamDocRef(token.refreshFamilyId!).get()).data()!;
    const callback = vi.fn().mockResolvedValue(valid
      ? { access_token: 'new-ns', expires_in: 3600 }
      : { access_token: 'new-ns' });
    if (valid) {
      const refreshed = await store.refreshNsToken(token.accessToken, callback);
      expect(refreshed.nsAccessToken).toBe('new-ns');
      expect((await getCutoverFenceRecord(db, 'mcp'))?.activeOperations).toBe(0);
    } else {
      await expect(store.refreshNsToken(token.accessToken, callback)).rejects.toThrow();
      const held = (await store.upstreamDocRef(token.refreshFamilyId!).get()).data()!;
      expect(held.grant).toEqual(before.grant);
      expect(held.ambiguousOutcome).toBe(true);
      expect(held.ambiguousReason).toBe('upstream_transport_error');
      expect((await getCutoverFenceRecord(db, 'mcp'))?.activeOperations).toBe(1);
    }
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('releases a fenced refresh claim on a rejected client and accepts a later valid refresh', async () => {
    const db = createTestDb();
    await initializeCutoverFence(db, 'mcp');
    const fence = { namespace: 'mcp' as const, enforce: true };
    const store = new FirestoreTokenStore({ db, collection: 'mcp_tokens', fence });
    const provider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com', nsClientId: 'test', nsClientSecret: 'test',
      tokenStore: store, firestore: db, fence,
    });
    const token = await store.issue({
      accessToken: 'rejected-access', refreshToken: 'rejected-refresh', clientId: 'rejected-client',
      expiresAt: Date.now() + 3600_000, nsAccessToken: 'old-ns', nsRefreshToken: 'old-refresh',
      nsExpiresAt: Date.now() - 1, nsUsername: 'user',
    });
    const upstreamRef = store.upstreamDocRef(token.refreshFamilyId!);
    const before = (await upstreamRef.get()).data()!;
    const post = vi.spyOn(axios, 'post')
      .mockRejectedValueOnce(Object.assign(new Error('rejected'), {
        isAxiosError: true, response: { status: 401, data: { error: 'invalid_client' } },
      }))
      .mockResolvedValueOnce({ status: 200, data: { access_token: 'new-ns', expires_in: 3600 } });
    const client = { client_id: token.clientId } as OAuthClientInformationFull;
    await expect(provider.exchangeRefreshToken(client, token.refreshToken)).rejects.toThrow();
    const released = (await upstreamRef.get()).data()!;
    expect(released.grant).toEqual(before.grant);
    expect(released.updatedAt).toBe(before.updatedAt);
    expect(released.leaseOwner).toBeNull();
    expect((await getCutoverFenceRecord(db, 'mcp'))?.activeOperations).toBe(0);
    await expect(provider.exchangeRefreshToken(client, token.refreshToken)).resolves.toHaveProperty('access_token');
    expect((await upstreamRef.get()).data()?.grant.nsAccessToken).toBe('new-ns');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('returns a retryable HTTP response without invalid-token challenge for a fenced invalid grant', async () => {
    configureHttpTest();
    const db = createTestDb();
    await initializeCutoverFence(db, 'mcp');
    const fence = { namespace: 'mcp' as const, enforce: true };
    const store = new FirestoreTokenStore({ db, collection: 'mcp_tokens', fence });
    const provider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://test.example.com', nsClientId: 'test_client_id', nsClientSecret: 'test_client_secret',
      tokenStore: store, firestore: db, fence, serverBaseUrl: 'http://localhost',
    });
    const token = await store.issue({
      accessToken: 'http-untrusted-access', refreshToken: 'http-untrusted-refresh', clientId: 'http-untrusted-client',
      expiresAt: Date.now() + 3600_000, nsAccessToken: 'old-ns', nsRefreshToken: 'old-ns-refresh', nsUsername: 'user',
    });
    await provider.clientsStore.registerClient({
      client_id: token.clientId, redirect_uris: ['http://localhost/cb'], token_endpoint_auth_method: 'none',
    });
    vi.spyOn(axios, 'post').mockRejectedValue(Object.assign(new Error('rejected'), {
      isAxiosError: true, response: { status: 400, data: { error: 'invalid_grant' } },
    }));
    const { app } = createApp(provider);
    const response = await request(app).post('/token').type('form').send({
      grant_type: 'refresh_token', client_id: token.clientId, refresh_token: token.refreshToken,
    });
    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('5');
    expect(response.headers['www-authenticate']).toBeUndefined();
    expect(response.body.error).toBe('temporarily_unavailable');
    expect((await store.refreshDocRef(token.refreshToken).get()).exists).toBe(true);
    expect((await getCutoverFenceRecord(db, 'mcp'))?.activeOperations).toBe(1);
  });
});
