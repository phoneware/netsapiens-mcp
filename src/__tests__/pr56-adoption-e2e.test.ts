import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createFirestoreStore, type FirestoreLike } from '../store/firestore.js';
import { deriveStoreKey } from '../store/codec.js';
import { NetSapiensAuthProvider } from '../auth/netsapiens-auth-provider.js';
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

describe('PR56 Firestore Adoption E2E: TTL-deleted access doc + nested grant shape', () => {
  const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const key = deriveStoreKey(secret);

  it('adopts PR56 session where access doc is absent, preserves clientId and seatId, and exchanges successfully', async () => {
    const db = new MockFirestore();
    const namespace = 'mcp';

    const legacyRefreshToken = 'tok-refresh-valid';
    const legacyAccessToken = 'tok-access-expired';
    const familyId = 'fam-1';
    const expectedClientId = 'pr56-surviving-client';

    // 1. Seed PR #56 legacy families collection
    await db.collection(`${namespace}_tokens_refresh_families`).doc(familyId).set({
      id: familyId,
      currentAccessToken: legacyAccessToken,
      currentRefreshToken: legacyRefreshToken,
      retiredRefreshFingerprints: [],
      updatedAt: Date.now(),
    });

    // 2. Seed PR #56 legacy refresh collection (contains authoritative embedded token)
    await db.collection(`${namespace}_tokens_refresh`).doc(legacyRefreshToken).set({
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
    });

    // 3. Seed PR #56 legacy upstream collection (nested grant map)
    await db.collection(`${namespace}_tokens_upstream`).doc(familyId).set({
      grant: {
        access_token: 'ns-tok-upstream',
        refresh_token: 'ns-ref-upstream',
        username: 'alice@domain.com',
        user_role: 'admin',
        api_url: 'https://ns.example.com',
      },
      expiresAt: Date.now() + 3600_000,
      updatedAt: Date.now(),
    });

    // 4. Access document in `${namespace}_tokens` is ABSENT (TTL-deleted)
    // db.collection(`${namespace}_tokens`).doc(legacyAccessToken) is NOT created!

    // 5. Initialize fence in fenced state, execute adoption, and transition to v3_active
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
      migrationRunId: 'pr56-run',
      codeSha: '3edf8a262e9d06f4849318b1e0d09f197738bff9',
      codeArtifact: 'us-docker.pkg.dev/project/image@sha256:' + 'a'.repeat(64),
      packageIntegrity: 'sha512-' + 'b'.repeat(86) + '==',
      protocolDigest: '85fabba35757a2b2596f54774a6bfcf28dc9efbab89b506206baedc1f889b452',
      assemblyDigest: 'c'.repeat(64),
      indexSchemaDigest: 'd'.repeat(64),
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

    // 6. Verify lookupRefresh correctly resolves clientId and seatId from the active refresh pointer
    const lookup = await store.sessions.lookupRefresh(legacyRefreshToken, expectedClientId, Date.now());
    expect(lookup.status).toBe('active');
    if (lookup.status === 'active') {
      expect(lookup.session.clientId).toBe(expectedClientId);
      expect(lookup.session.extra?.seatId).toBe('seat-42');
      expect(lookup.session.nsUsername).toBe('alice@domain.com');
      expect(lookup.session.nsAccessToken).toBe('ns-tok-upstream');
      expect(lookup.session.nsRefreshToken).toBe('ns-ref-upstream');
    }

    // 7. Verify that presenting a mismatched client ID rejects the lookup
    const wrongClientLookup = await store.sessions.lookupRefresh(legacyRefreshToken, 'wrong-client', Date.now());
    expect(wrongClientLookup.status).toBe('missing');

    // 8. Test end-to-end /token refresh exchange via NetSapiensAuthProvider
    const provider = new NetSapiensAuthProvider({
      platforms: [{ id: 'default', label: 'Default', apiUrl: 'https://ns.example.com' }],
      nsApiUrl: 'https://ns.example.com',
      nsClientId: 'test-client',
      nsClientSecret: 'test-secret',
      serverBaseUrl: 'http://localhost:3000',
      store,
    });

    vi.spyOn(axios, 'post').mockResolvedValueOnce({
      data: { access_token: 'ns-tok-new', refresh_token: 'ns-ref-new', expires_in: 3600 },
    });

    const tokens = await provider.exchangeRefreshToken(
      { client_id: expectedClientId } as any,
      legacyRefreshToken,
    );

    expect(tokens.access_token).toBeDefined();
    expect(tokens.refresh_token).toBeDefined();
    expect(tokens.token_type).toBe('Bearer');

    // 9. Verify new session has the correct clientId and preserved seatId
    const newSession = await store.sessions.get(tokens.access_token);
    expect(newSession).toBeDefined();
    expect(newSession?.clientId).toBe(expectedClientId);
    expect(newSession?.extra?.seatId).toBe('seat-42');
    expect(newSession?.nsAccessToken).toBe('ns-tok-new');
  });
});
