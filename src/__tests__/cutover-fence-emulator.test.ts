import { afterAll, describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { connect } from 'node:net';
import { Firestore } from '@google-cloud/firestore';
import {
  initializeCutoverFence,
  getCutoverFenceRecord,
  transitionCutoverFenceState,
  withLegacyOperation,
  startMonotonicTimer,
  checkMutationGuardInTransaction,
  CutoverRefusedError,
} from '../store/firestore-v2-adoption.js';
import { deriveStoreKey } from '../store/codec.js';

const host = process.env.FIRESTORE_EMULATOR_HOST;
const required = process.env.NSMCP_REQUIRE_FIRESTORE_EMULATOR === '1';
const EMULATOR_HOST = host ?? '';

// Same gate as firestore.test.ts: a configured or required emulator must be reachable. The suite never
// falls back to a default host or to live Firestore.
async function checkEmulator(): Promise<void> {
  if (!host) throw new Error('FIRESTORE_EMULATOR_HOST is required when NSMCP_REQUIRE_FIRESTORE_EMULATOR=1');
  const url = new URL(`http://${host}`);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const socket = connect({ host: url.hostname, port: Number(url.port) });
  socket.setTimeout(2000);
  socket.once('connect', () => { socket.destroy(); resolve(); });
  socket.once('error', (error) => { socket.destroy(); reject(new Error(`Firestore emulator unreachable at ${host}: ${error.message}`)); });
  socket.once('timeout', () => { socket.destroy(); reject(new Error(`Firestore emulator unreachable at ${host}: timeout`)); });
  await promise;
}
const PROJECT_ID = 'nsmcp-cutover-fence-isolated';

describe('Firestore emulator availability for the cutover fence', () => {
  it('requires a reachable emulator when requested', async () => { if (required || host) await checkEmulator(); });
});

describe.skipIf(!host)('Real Firestore Emulator Cutover Fence & Adoption Proof (Supported Namespace "mcp")', () => {
  let db: Firestore;
  const namespace = 'mcp'; // strictly supported namespace
  const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const key = deriveStoreKey(secret);

  const clearEmulator = async () => {
    const url = `http://${EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
    const response = await fetch(url, { method: 'DELETE' });
    if (!response.ok) throw new Error(`Firestore emulator reset failed at ${EMULATOR_HOST}: HTTP ${response.status}`);
  };

  beforeAll(async () => {
    await checkEmulator();
    process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;
    db = new Firestore({ projectId: PROJECT_ID });
    await clearEmulator();
  });

  afterAll(async () => {
    await db?.terminate();
  });

  beforeEach(async () => {
    await clearEmulator();
  });

  it('admits legacy operations without persisting their caller identity and fences new admissions', async () => {
    // 1. Initialize control in real Firestore
    const init = await initializeCutoverFence(db, namespace, { initialEpoch: 1 });
    expect(init.state).toBe('legacy_open');
    expect(init.epoch).toBe(1);

    // Seed legacy family in real Firestore
    const now = Date.now();
    await db.collection(`${namespace}_tokens_refresh_families`).doc('fam-real-1').set({
      currentRefreshToken: 'ref-real-1',
      currentAccessToken: 'acc-real-1',
      clientId: 'client-real',
      scope: 'read',
      createdAt: now,
      updatedAt: now,
    });
    await db.collection(`${namespace}_tokens_refresh`).doc('ref-real-1').set({
      familyId: 'fam-real-1',
      status: 'active',
      createdAt: now,
    });
    await db.collection(`${namespace}_tokens_upstream`).doc('fam-real-1').set({
      nsAccessToken: 'ns-tok-real',
      nsRefreshToken: 'ns-ref-real',
      nsUsername: 'user@domain.com',
      updatedAt: now,
    });
    await db.collection(`${namespace}_tokens`).doc('acc-real-1').set({
      familyId: 'fam-real-1',
      accessToken: 'acc-real-1',
      clientId: 'client-real',
      expiresAt: now + 3600_000,
    });

    // 2. withLegacyOperation admits operation during legacy_open in real Firestore
    const callerId = 'arbitrary/secret-like-id';
    let storageId = '';
    let executedOp = false;
    await withLegacyOperation({ db, namespace, identityKey: key, kind: 'token', operationId: callerId }, async (ctx) => {
      expect(ctx.id).toBe(callerId);
      expect(ctx.storageId).toMatch(/^op1_[0-9a-f]{64}$/);
      storageId = ctx.storageId;
      expect(ctx.epoch).toBe(1);
      executedOp = true;
      const guard = await db.runTransaction(async (tx) => {
        const timer = startMonotonicTimer();
        const guard = await checkMutationGuardInTransaction(tx, { db, namespace, operation: ctx, timer, identityKey: key });
        expect(guard.control.state).toBe('legacy_open');
        guard.bufferCompletion();
        guard.assertPreReturn();
        return guard;
      });
      guard.onCommit();
    });
    expect(executedOp).toBe(true);
    const durable = await db.collection(`${namespace}_meta`).doc('cutover_fence').collection('operations').doc(storageId).get();
    expect(durable.exists).toBe(true);
    expect(JSON.stringify(durable.data())).not.toContain(callerId);

    // 3. Transition to closing: new admissions refused
    await transitionCutoverFenceState(db, namespace, {
      fromState: 'legacy_open',
      toState: 'closing',
      expectedEpoch: 1,
    });

    await expect(
      withLegacyOperation({ db, namespace, identityKey: key, kind: 'token' }, async () => { }),
    ).rejects.toThrow(CutoverRefusedError);

    // 4. Transition to fenced
    await transitionCutoverFenceState(db, namespace, {
      fromState: 'closing',
      toState: 'fenced',
      expectedEpoch: 1,
    });
    expect((await getCutoverFenceRecord(db, namespace))?.state).toBe('fenced');
  });

});
