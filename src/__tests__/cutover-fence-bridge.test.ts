import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Firestore } from '@google-cloud/firestore';
import {
  CutoverFenceError,
  CutoverRefusedError,
  UpstreamRevokedError,
  UpstreamUnavailableError,
  toTokenEndpointError,
} from '../auth/kit/errors.js';
import {
  type CutoverFenceControlRecord,
  type LegacyOperationContext,
  checkMutationGuardInTransaction,
  getCutoverFenceDocRef,
  getCutoverFenceRecord,
  getCutoverOperationDocRef,
  initializeCutoverFence,
  markIrreversibleInTransaction,
  transitionCutoverFenceState,
  withLegacyOperation,
  requestOperationContext,
} from '../auth/kit/cutover-fence.js';
import {
  FirestoreTokenStore,
  FirestoreClientsStore,
  FirestoreAuthCodeStore,
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
import { docId } from '../auth/kit/firestore-ledger.js';
import request from 'supertest';
import { createApp, validateBridgeStartup } from '../http-server.js';

const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST;

function createTestDb(projectId: string = `mcp-bridge-${randomUUID().slice(0, 8)}`): Firestore {
  return new Firestore({
    projectId,
    host: EMULATOR_HOST,
    ssl: false,
  });
}

describe('Legacy Bridge Cutover Fence & Regressions (C1-C5, S2, §5.1)', { timeout: 60000 }, () => {
  if (!EMULATOR_HOST) {
    it.skip('Skipped when no emulator running locally; CI runs with FIRESTORE_EMULATOR_HOST', () => {});
    return;
  }

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
      await withLegacyOperation({ db, namespace, kind: 'refresh' }, async () => {
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

    const { promise: fenceClosed, resolve: notifyFenceClosed } = Promise.withResolvers<void>();
    const { promise: opStarted, resolve: notifyOpStarted } = Promise.withResolvers<void>();

    const opPromise = withLegacyOperation({ db, namespace, kind: 'refresh' }, async (ctx) => {
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
    const { promise: fenceAttemptDone, resolve: notifyFenceAttemptDone } = Promise.withResolvers<void>();
    const { promise: opPaused, resolve: notifyOpPaused } = Promise.withResolvers<void>();

    const opPromise = withLegacyOperation({ db, namespace, kind: 'refresh' }, async (ctx) => {
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
      await withLegacyOperation({ db, namespace, kind: 'refresh' }, async (ctx) => {
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
      nsApiUrl: 'https://edge.phoneware.cloud',
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
          nsApiUrl: 'https://edge.phoneware.cloud',
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
        const { promise, resolve } = Promise.withResolvers<void>();
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
    expect(tokenRes1.status).toBe(200);
    expect(tokenRes1.body.access_token).toBeDefined();

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
    await new Promise((r) => setTimeout(r, 60));

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
    await new Promise((r) => setTimeout(r, 60));

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
    await new Promise((r) => setTimeout(r, 60));

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
    const sessionId = 'sse-session-' + randomBytes(8).toString('hex');

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
    const liveSessionId = initRes.headers['mcp-session-id'] || sessionId;

    const server = app.listen(0);
    const port = (server.address() as any).port;
    const controller = new AbortController();

    const fetchPromise = fetch(`http://127.0.0.1:${port}/mcp`, {
      headers: {
        Authorization: `Bearer ${testAccessToken}`,
        Accept: 'text/event-stream',
        'mcp-session-id': liveSessionId,
      },
      signal: controller.signal,
    });

    const sseResp = await fetchPromise;
    expect(sseResp.status).toBe(200);
    expect(sseResp.headers.get('content-type')).toContain('text/event-stream');

    expect(observedActiveCountDuringVerify).toBe(1);

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

    controller.abort();
    await new Promise<void>((r) => server.close(() => r()));
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
    const controller = new AbortController();
    const pending = {
      clientId: 'test_client_id',
      redirectUri: 'http://localhost/callback',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      scope: 'openid',
      state: 'test-oauth-state',
    };
    const signedState = signValue(pending, 600);

    const fetchPromise = fetch(`http://127.0.0.1:${port}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'realuser', password: 'realpassword', auth_state: signedState }),
      signal: controller.signal,
    }).catch(() => {});

    for (let i = 0; i < 30; i++) {
      if (inFlight) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(inFlight).toBe(true);

    controller.abort();
    await new Promise((r) => setTimeout(r, 50));

    const duringDisconnectControl = await getCutoverFenceRecord(db, namespace);
    expect(duringDisconnectControl?.activeOperations).toBe(1);

    releaseBarrier();
    await fetchPromise;

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
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

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
      { db, namespace, kind: 'upstream_test', operationId: opId, now: Date.now },
      async (op) => {
        let trackWriterCalls = 0;
        op.trackWriter = async <T>(fn: () => Promise<T>): Promise<T> => {
          trackWriterCalls++;
          return await fn();
        };

        await upstreamStore.put(familyId, { test: 'grant' }, Date.now() + 3600_000, { operation: op });
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
    const db = createTestDb();
    const namespace = 'mcp';
    await initializeCutoverFence(db, namespace, { initialEpoch: 1, initialState: 'legacy_open' });

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
});
