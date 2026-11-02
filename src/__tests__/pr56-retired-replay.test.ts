import { describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createFirestoreStore, type FirestoreLike } from '../store/firestore.js';
import { createMemoryBackend } from '../store/memory.js';
import { createStore } from '../store/store.js';
import { deriveStoreKey } from '../store/codec.js';
import {
  initializeCutoverFence,
  getCutoverFenceRecord,
  transitionCutoverFenceState,
} from '../auth/kit/cutover-fence.js';
import { adoptFirestoreLegacyTokens, computeSourceInventoryDigest } from '../store/firestore-v2-adoption.js';

class MockFirestore implements FirestoreLike {
  private collections = new Map<string, Map<string, Record<string, unknown>>>();

  private getCol(name: string): Map<string, Record<string, unknown>> {
    if (!this.collections.has(name)) {
      this.collections.set(name, new Map());
    }
    return this.collections.get(name)!;
  }

  collection(path: string): any {
    const col = this.getCol(path);
    return {
      doc: (id: string) => ({
        id,
        get: async () => ({
          id,
          exists: col.has(id),
          data: () => col.get(id),
        }),
        set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
          if (opts?.merge && col.has(id)) {
            col.set(id, { ...col.get(id), ...data });
          } else {
            col.set(id, data);
          }
        },
        delete: async () => {
          col.delete(id);
        },
      }),
      get: async () => ({
        empty: col.size === 0,
        docs: Array.from(col.entries()).map(([id, data]) => ({
          id,
          exists: true,
          data: () => data,
        })),
      }),
      where: (field: string, op: string, value: any) => {
        const query = {
          limit: (_n: number) => query,
          get: async () => {
            const matched = Array.from(col.entries()).filter(([, d]) => {
              if (op === 'in' && Array.isArray(value)) return value.includes(d[field]);
              return d[field] === value;
            });
            return {
              empty: matched.length === 0,
              docs: matched.map(([id, data]) => ({
                id,
                exists: true,
                data: () => data,
              })),
            };
          },
        };
        return query;
      },
    };
  }

  async runTransaction<T>(cb: (tx: any) => Promise<T>): Promise<T> {
    const tx = {
      get: async (docRef: any) => docRef.get(),
      set: (docRef: any, data: any, opts?: { merge?: boolean }) => docRef.set(data, opts),
      delete: (docRef: any) => docRef.delete(),
    };
    return cb(tx);
  }
}

describe('PR56 Retired Refresh Token Replay Detection', () => {
  const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const key = deriveStoreKey(secret);

  it('detects replay when an old PR56 retired token (SHA-256 base64url fingerprint) is presented and revokes family', async () => {
    const db = new MockFirestore();
    const namespace = 'mcp';

    const oldRetiredToken = 'old-pr56-token-123';
    const legacyShaFingerprint = createHash('sha256').update(oldRetiredToken).digest('base64url');

    const currentActiveRefresh = 'current-pr56-refresh';
    const currentActiveAccess = 'current-pr56-access';
    const familyId = 'fam-with-retired-history';
    const clientId = 'pr56-client';

    // 1. Seed PR56 legacy family with retiredRefreshFingerprints containing the SHA-256 fingerprint
    await db.collection(`${namespace}_tokens_refresh_families`).doc(familyId).set({
      id: familyId,
      currentAccessToken: currentActiveAccess,
      currentRefreshToken: currentActiveRefresh,
      retiredRefreshFingerprints: [legacyShaFingerprint],
      updatedAt: Date.now(),
    });

    // 2. Seed active refresh pointer
    await db.collection(`${namespace}_tokens_refresh`).doc(currentActiveRefresh).set({
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
    });

    // 3. Seed upstream grant
    await db.collection(`${namespace}_tokens_upstream`).doc(familyId).set({
      grant: {
        access_token: 'ns-tok',
        refresh_token: 'ns-ref',
        username: 'alice@domain.com',
      },
      expiresAt: Date.now() + 3600_000,
      updatedAt: Date.now(),
    });
    // 4. Initialize fence in fenced state, execute adoption, and transition to v3_active
    await initializeCutoverFence(db, namespace, { initialEpoch: 1 });
    await transitionCutoverFenceState(db, namespace, { fromState: 'legacy_open', toState: 'closing', expectedEpoch: 1 });
    await transitionCutoverFenceState(db, namespace, { fromState: 'closing', toState: 'fenced', expectedEpoch: 1 });
    const ctrlFenced = await getCutoverFenceRecord(db, namespace);
    const report = await adoptFirestoreLegacyTokens({
      db,
      FieldPath: { documentId: () => '__name__' },
      namespace,
      key,
      dryRun: false,
      expectedEpoch: ctrlFenced!.epoch,
      migrationRunId: 'pr56-retired-run',
      codeSha: '3edf8a262e9d06f4849318b1e0d09f197738bff9',
      codeArtifact: 'us-docker.pkg.dev/project/image@sha256:' + 'a'.repeat(64),
      packageIntegrity: 'sha512-' + 'b'.repeat(86) + '==',
      protocolDigest: '85fabba35757a2b2596f54774a6bfcf28dc9efbab89b506206baedc1f889b452',
      expectedSourceInventoryDigest: await computeSourceInventoryDigest(db, namespace, key, ctrlFenced!.epoch),
    });
    expect(report.errors).toBe(0);
    expect(report.migrated).toBe(1);

    const ctrl = await getCutoverFenceRecord(db, namespace);
    await transitionCutoverFenceState(db, namespace, {
      fromState: 'v3_ready',
      toState: 'v3_active',
      expectedEpoch: ctrl!.epoch,
      migrationRunId: ctrl!.migrationRunId!,
      migrationManifestDigest: ctrl!.migrationManifestDigest!,
    });

    // Open v3 store
    const store = createFirestoreStore({ db, namespace, key });
    // 5. Present the old retired token (from before cutover)
    const replayLookup = await store.sessions.lookupRefresh(oldRetiredToken, clientId, Date.now());

    // Must be detected as replay!
    expect(replayLookup.status).toBe('replay');
    if (replayLookup.status === 'replay') {
      expect(replayLookup.familyId).toBe(familyId);
    }

    // 6. Verify family is now REVOKED and upstream credentials deleted
    const activeLookup = await store.sessions.lookupRefresh(currentActiveRefresh, clientId, Date.now());
    expect(activeLookup.status).toBe('missing'); // Family was revoked!

    const session = await store.sessions.get(currentActiveAccess);
    expect(session).toBeUndefined(); // Active session deleted on revocation!
  });
});
