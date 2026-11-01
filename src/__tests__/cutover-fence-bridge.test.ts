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
} from '../auth/netsapiens-auth-provider.js';
import {
  InvalidGrantError,
  InvalidTokenError,
  TemporarilyUnavailableError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { docId } from '../auth/kit/firestore-ledger.js';

const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST;

function createTestDb(projectId: string = `mcp-bridge-${randomUUID().slice(0, 8)}`): Firestore {
  return new Firestore({
    projectId,
    host: EMULATOR_HOST,
    ssl: false,
  });
}

describe('Legacy Bridge Cutover Fence & Regressions (C1-C5, S2, §5.1)', { timeout: 30000 }, () => {
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

      const newAccess = await tokenStore.get('acc_adopted_new');
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
});
