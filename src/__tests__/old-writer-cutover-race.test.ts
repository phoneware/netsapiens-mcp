import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createFirestoreStore, ensureFirestoreAdopted, type FirestoreLike } from '../store/firestore.js';
import { deriveStoreKey } from '../store/codec.js';

class MockFirestore implements FirestoreLike {
  public collections = new Map<string, Map<string, Record<string, unknown>>>();

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
        set: async (data: Record<string, unknown>) => {
          col.set(id, data);
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
      where: (field: string, _op: string, value: string) => ({
        get: async () => {
          const matched = Array.from(col.entries()).filter(([, d]) => d[field] === value);
          return {
            empty: matched.length === 0,
            docs: matched.map(([id, data]) => ({
              id,
              exists: true,
              data: () => data,
            })),
          };
        },
      }),
    };
  }

  async runTransaction<T>(cb: (tx: any) => Promise<T>): Promise<T> {
    const tx = {
      get: async (docRef: any) => docRef.get(),
      set: (docRef: any, data: any) => docRef.set(data),
      delete: (docRef: any) => docRef.delete(),
    };
    return cb(tx);
  }
}

describe('Old-Writer Rolling Cutover Race Protection', () => {
  const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const key = deriveStoreKey(secret);

  it('adopts legacy token written by an old 2.x instance AFTER the v2_adopted marker, preventing stranded sessions', async () => {
    const db = new MockFirestore();
    const namespace = 'mcp';

    // 1. Initial state: preflight adoption runs on existing database and sets v2_adopted marker
    await ensureFirestoreAdopted({ db, namespace, key });
    const markerSnap = await db.collection(`${namespace}_meta`).doc('v2_adopted').get();
    expect(markerSnap.exists).toBe(true);

    const store = createFirestoreStore({ db, namespace, key });

    // 2. An old 2.x instance (still draining in Cloud Run) handles a request and writes a new token
    // to the legacy collection AFTER the v2_adopted marker was created!
    const postMarkerAccessToken = 'post-marker-access-tok-123';
    const postMarkerRefreshToken = 'post-marker-refresh-tok-123';
    const legacyDocId = postMarkerAccessToken.replace(/[\/.]/g, '_');

    await db.collection(`${namespace}_tokens`).doc(legacyDocId).set({
      accessToken: postMarkerAccessToken,
      refreshToken: postMarkerRefreshToken,
      clientId: 'post-marker-client',
      expiresAt: Date.now() + 3600_000,
      nsAccessToken: 'ns-tok-late',
      nsRefreshToken: 'ns-ref-late',
      nsUsername: 'late-user@domain.com',
      seatId: 'seat-999',
    });

    // 3. User sends a request to v3 carrying the post-marker access token
    // v3 must NOT strand this session! Point-in-time single-doc fallback detects it,
    // transactionally migrates it, and serves it seamlessly!
    const session = await store.sessions.get(postMarkerAccessToken);
    expect(session).toBeDefined();
    expect(session?.clientId).toBe('post-marker-client');
    expect(session?.nsUsername).toBe('late-user@domain.com');
    expect(session?.nsAccessToken).toBe('ns-tok-late');
    expect(session?.extra?.seatId).toBe('seat-999');

    // 4. Verify that the session now lives in v3 sessions collection
    const v3AccessSnap = await db.collection(`${namespace}_sessions`).get();
    expect(v3AccessSnap.empty).toBe(false);

    // 5. Subsequent request hits v3 directly
    const sessionSecondRead = await store.sessions.get(postMarkerAccessToken);
    expect(sessionSecondRead).toBeDefined();
    expect(sessionSecondRead?.nsUsername).toBe('late-user@domain.com');

    // 6. Truly unknown/bogus bearer token returns undefined (401) without error
    const bogus = await store.sessions.get('completely_unknown_bearer');
    expect(bogus).toBeUndefined();
  });

  it('adopts PR56 legacy family written by an old 2.x instance AFTER the v2_adopted marker upon refresh lookup', async () => {
    const db = new MockFirestore();
    const namespace = 'mcp';

    await ensureFirestoreAdopted({ db, namespace, key });
    const store = createFirestoreStore({ db, namespace, key });

    const lateRefreshToken = 'late-pr56-refresh-999';
    const lateAccessToken = 'late-pr56-access-999';
    const lateFamilyId = 'late-fam-999';

    // Old instance wrote new family & refresh pointer after marker
    await db.collection(`${namespace}_tokens_refresh_families`).doc(lateFamilyId).set({
      id: lateFamilyId,
      currentAccessToken: lateAccessToken,
      currentRefreshToken: lateRefreshToken,
      retiredRefreshFingerprints: [],
      updatedAt: Date.now(),
    });

    await db.collection(`${namespace}_tokens_refresh`).doc(lateRefreshToken).set({
      accessToken: lateAccessToken,
      familyId: lateFamilyId,
      status: 'active',
      token: {
        accessToken: lateAccessToken,
        refreshToken: lateRefreshToken,
        clientId: 'post-marker-client',
        expiresAt: Date.now() + 3600_000,
        serverBaseUrl: 'http://localhost:3000',
        nsAccessToken: 'ns-late-tok',
        nsRefreshToken: 'ns-late-ref',
        nsUsername: 'late@domain.com',
        extra: { seatId: 'seat-888' },
      },
    });

    await db.collection(`${namespace}_tokens_upstream`).doc(lateFamilyId).set({
      grant: {
        access_token: 'ns-late-tok',
        refresh_token: 'ns-late-ref',
        username: 'late@domain.com',
      },
      expiresAt: Date.now() + 3600_000,
      updatedAt: Date.now(),
    });

    // Lookup refresh on v3
    const lookup = await store.sessions.lookupRefresh(lateRefreshToken, 'post-marker-client', Date.now());
    expect(lookup.status).toBe('active');
    if (lookup.status === 'active') {
      expect(lookup.session.clientId).toBe('post-marker-client');
      expect(lookup.session.extra?.seatId).toBe('seat-888');
      expect(lookup.session.nsUsername).toBe('late@domain.com');
    }
  });
});
