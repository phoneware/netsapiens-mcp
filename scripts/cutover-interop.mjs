import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const requireAt = (root) => createRequire(join(root, 'package.json'));
const load = async (root, specifier) => import(pathToFileURL(requireAt(root).resolve(specifier)).href);

// The caller installs each tarball into a distinct consumer root: the bridge and
// migration package deliberately have the same npm name.
export async function runCutoverInterop({ migrationRoot, bridgeRoot, canonicalRoot }) {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host || !/^(localhost|127\.0\.0\.1):[0-9]+$/.test(host)) {
    throw new Error('cutover-interop requires a loopback FIRESTORE_EMULATOR_HOST');
  }
  const migration = await load(migrationRoot, 'netsapiens-mcp/cutover-protocol');
  const bridge = await load(bridgeRoot, 'netsapiens-mcp/lib');
  const canonical = await load(canonicalRoot, '@phoneware/mcp-oauth-kit/cutover-protocol');
  const { Firestore } = requireAt(migrationRoot)('@google-cloud/firestore');
  const secret = 'cutover-interop-session-secret-for-isolated-proof-only';
  process.env.MCP_SESSION_SECRET = secret;
  const key = canonical.deriveStoreKey(secret);
  assert.deepEqual(bridge.deriveStoreKey(secret), key);
  assert.deepEqual(migration.deriveStoreKey(secret), key);
  assert.deepEqual(canonical.deriveStoreKey(secret), key);
  const otherKey = canonical.deriveStoreKey(`${secret}-different`);
  const makeDb = () => new Firestore({ projectId: `cutover-proof-${randomUUID()}`, host, ssl: false });

  for (const namespace of ['mcp', 'pwmcp', 'readonly_mcp']) {
    const db = makeDb();
    try {
      await canonical.initializeCutoverFence(db, namespace);
      const kinds = ['token', 'login', 'upstream_refresh'];
      const ids = ['slash/name', 'unicode-\u96ea', 'secret-like-value', 'op1_prefix'];
      for (const kind of kinds) {
        for (const id of ids) {
          const operationId = `${id}-${randomUUID()}`;
          await bridge.withLegacyOperation({ db, namespace, kind, operationId, identityKey: key }, async (operation) => {
            let onCommit;
            await db.runTransaction(async (transaction) => {
              const guard = await canonical.checkMutationGuardInTransaction(transaction, {
                db, namespace, operation, timer: canonical.startMonotonicTimer(),
              });
              guard.bufferCompletion();
              onCommit = guard.onCommit;
            });
            onCommit();
          });
          const operations = await migration.getCutoverOperationsColRef(db, namespace).get();
          for (const doc of operations.docs) {
            assert.notEqual(doc.id, operationId);
            assert.equal(JSON.stringify(doc.data()).includes(operationId), false);
          }
        }
      }
      await bridge.withLegacyOperation({ db, namespace, kind: 'read', identityKey: key }, async (operation) => {
        await canonical.releaseLegacyOperation(db, operation);
        assert.equal(operation.isCompleted(), true);
      });
      await assert.rejects(canonical.withLegacyOperation({ db, namespace, kind: 'token', identityKey: otherKey }, async () => { }));

      const ledger = new bridge.FirestoreTokenLedger({ db, collection: `${namespace}_tokens`, fence: { namespace, enforce: true } });
      await canonical.withLegacyOperation({ db, namespace, kind: 'token_issue', identityKey: key }, async (operation) => {
        await ledger.issue({ accessToken: `access-${randomUUID()}`, refreshToken: `refresh-${randomUUID()}`, clientId: 'consumer', expiresAt: Date.now() + 60000 }, { operation });
      });

      for (const [admission, claimant, completion] of [[bridge, bridge, canonical], [canonical, canonical, bridge], [migration, migration, canonical]]) {
        const familyId = randomUUID();
        const refreshId = randomUUID();
        const family = db.collection(`${namespace}_tokens_refresh_families`).doc(familyId);
        const pointer = db.collection(`${namespace}_tokens_refresh`).doc(refreshId);
        const grant = db.collection(`${namespace}_tokens_upstream`).doc(familyId);
        await family.set({ id: familyId, generation: 3, currentRefreshToken: refreshId });
        await pointer.set({ familyId, status: 'active' });
        await grant.set({ grantVersion: 7, grant: { token: 'original' } });
        await admission.withLegacyOperation({ db, namespace, kind: 'upstream_refresh', identityKey: key }, async (operation) => {
          const claim = await db.runTransaction((transaction) => claimant.claimUpstreamGrantInTransaction(transaction, db, {
            namespace, epoch: operation.epoch, familyId, operationId: operation.id, identityKey: key,
            claimOwner: randomUUID(), expectedFamilyGeneration: 3, expectedGrantVersion: 7,
            expectedKind: operation.kind, timer: claimant.startMonotonicTimer(),
          }));
          const durableGrant = JSON.stringify((await grant.get()).data());
          assert.equal(durableGrant.includes(claim.claimOwner), false);
          assert.equal(durableGrant.includes(operation.id), false);
          const opRef = canonical.getCutoverOperationDocRef(db, namespace, operation.id, key);
          const controlRef = canonical.getCutoverFenceDocRef(db, namespace);
          const refs = [family, pointer, grant, opRef, controlRef];
          const snapshot = () => Promise.all(refs.map(async (ref) => (await ref.get()).data()));
          const before = await snapshot();
          const badClaims = [
            { ...claim, claimOwner: randomUUID() },
            { ...claim, operationId: randomUUID() },
            { ...claim, familyId: randomUUID() },
            { ...claim, familyGeneration: 4 },
            { ...claim, grantVersion: 8 },
            { ...claim, leaseExpiresAt: claim.leaseExpiresAt + 1 },
          ];
          for (const pendingClaim of badClaims) {
            await assert.rejects(db.runTransaction(async (transaction) => {
              await completion.checkMutationGuardInTransaction(transaction, {
                db, namespace, operation, pendingClaim, identityKey: key,
                timer: completion.startMonotonicTimer(),
              });
            }));
            assert.deepEqual(await snapshot(), before);
          }
          await assert.rejects(db.runTransaction(async (transaction) => {
            await completion.checkMutationGuardInTransaction(transaction, {
              db, namespace, operation, pendingClaim: claim, identityKey: otherKey,
              timer: completion.startMonotonicTimer(),
            });
          }));
          assert.deepEqual(await snapshot(), before);
          let onCommit;
          await db.runTransaction(async (transaction) => {
            const guard = await completion.checkMutationGuardInTransaction(transaction, {
              db, namespace, operation, pendingClaim: claim, identityKey: key,
              timer: completion.startMonotonicTimer(),
            });
            guard.bufferCompletion();
            transaction.update(grant, { leaseOwner: null, leaseUntil: null, leaseExpiresAt: null, operationId: null, ambiguousOperationId: null });
            onCommit = guard.onCommit;
          });
          onCommit();
          assert.equal(operation.isCompleted(), true);
        });
      }
      assert.equal((await canonical.getCutoverFenceRecord(db, namespace)).activeOperations, 0);
    } finally {
      await db.terminate();
    }
  }

  for (const phase of ['admitted', 'completed']) {
    const db = makeDb();
    try {
      const namespace = 'mcp';
      await canonical.initializeCutoverFence(db, namespace);
      const raw = canonical.getCutoverOperationsColRef(db, namespace).doc(`raw-${randomUUID()}`);
      await raw.set({ phase, operationId: raw.id });
      const before = (await raw.get()).data();
      const control = await canonical.getCutoverFenceRecord(db, namespace);
      await assert.rejects(bridge.withLegacyOperation({ db, namespace, kind: 'token', identityKey: key }, async () => { }));
      assert.deepEqual((await raw.get()).data(), before);
      assert.deepEqual(await canonical.getCutoverFenceRecord(db, namespace), control);
    } finally {
      await db.terminate();
    }
  }
}
