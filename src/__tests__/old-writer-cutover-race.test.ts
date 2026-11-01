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

  it('reconciles same family when old 2.x writer rotates F->R2 after v3 already adopted F->R1', async () => {
    const db = new MockFirestore();
    const namespace = 'mcp';
    const familyId = 'fam-reconcile-race';
    const clientId = 'client-reconcile';

    // 1. Initial legacy state with R1
    await db.collection(`${namespace}_tokens_refresh_families`).doc(familyId).set({
      id: familyId,
      currentAccessToken: 'A1',
      currentRefreshToken: 'R1',
      retiredRefreshFingerprints: [],
      updatedAt: 1000,
    });
    await db.collection(`${namespace}_tokens_refresh`).doc('R1').set({
      accessToken: 'A1',
      familyId,
      status: 'active',
      token: {
        accessToken: 'A1',
        refreshToken: 'R1',
        clientId,
        expiresAt: Date.now() + 3600_000,
        nsAccessToken: 'ns-tok-1',
        nsRefreshToken: 'ns-ref-1',
        nsUsername: 'reconcile-user@domain.com',
      },
    });
    await db.collection(`${namespace}_tokens_upstream`).doc(familyId).set({
      grant: { access_token: 'ns-tok-1', refresh_token: 'ns-ref-1', username: 'reconcile-user@domain.com' },
      expiresAt: Date.now() + 3600_000,
      updatedAt: 1000,
    });

    // 2. Preflight adopts F with R1 into v3
    await ensureFirestoreAdopted({ db, namespace, key });
    const store = createFirestoreStore({ db, namespace, key });

    // Verify v3 has R1
    const lookupR1Before = await store.sessions.lookupRefresh('R1', clientId, Date.now());
    expect(lookupR1Before.status).toBe('active');

    // 3. Old 2.x instance in Cloud Run rotates F in legacy: R1 -> R2!
    await db.collection(`${namespace}_tokens_refresh_families`).doc(familyId).set({
      id: familyId,
      currentAccessToken: 'A2',
      currentRefreshToken: 'R2',
      previousAccessToken: 'A1',
      previousRefreshToken: 'R1',
      retiredRefreshFingerprints: [],
      updatedAt: 2000,
    });
    await db.collection(`${namespace}_tokens_refresh`).doc('R1').set({
      accessToken: 'A1',
      familyId,
      status: 'consumed',
      consumedAt: 2000,
    });
    await db.collection(`${namespace}_tokens_refresh`).doc('R2').set({
      accessToken: 'A2',
      familyId,
      status: 'active',
      token: {
        accessToken: 'A2',
        refreshToken: 'R2',
        clientId,
        expiresAt: Date.now() + 3600_000,
        nsAccessToken: 'ns-tok-2',
        nsRefreshToken: 'ns-ref-2',
        nsUsername: 'reconcile-user@domain.com',
        extra: { seatId: 'seat-reconciled' },
      },
    });
    await db.collection(`${namespace}_tokens_upstream`).doc(familyId).set({
      grant: { access_token: 'ns-tok-2', refresh_token: 'ns-ref-2', username: 'reconcile-user@domain.com' },
      expiresAt: Date.now() + 3600_000,
      updatedAt: 2000,
    });

    // 4. Client presents R2 to v3!
    // v3 must atomically reconcile F: advance generation, adopt R2, consume R1, and serve R2!
    const lookupR2 = await store.sessions.lookupRefresh('R2', clientId, Date.now());
    expect(lookupR2.status).toBe('active');
    if (lookupR2.status === 'active') {
      expect(lookupR2.session.clientId).toBe(clientId);
      expect(lookupR2.session.nsAccessToken).toBe('ns-tok-2');
      expect(lookupR2.session.extra?.seatId).toBe('seat-reconciled');
    }
  });

  it('adopts pre-PR56 base-format refresh pointer { accessToken } without familyId upon refresh', async () => {
    const db = new MockFirestore();
    const namespace = 'mcp';
    const clientId = 'base-client-99';

    await ensureFirestoreAdopted({ db, namespace, key });
    const store = createFirestoreStore({ db, namespace, key });

    // Pre-PR56 base format: tokens_refresh has doc(refreshToken) = { accessToken: 'base-acc' } (no familyId!)
    const baseRefresh = 'base-refresh-token-xyz';
    const baseAccess = 'base-access-token-xyz';

    await db.collection(`${namespace}_tokens_refresh`).doc(baseRefresh.replace(/[\/.]/g, '_')).set({
      accessToken: baseAccess,
    });
    await db.collection(`${namespace}_tokens`).doc(baseAccess.replace(/[\/.]/g, '_')).set({
      accessToken: baseAccess,
      refreshToken: baseRefresh,
      clientId,
      expiresAt: Date.now() + 3600_000,
      nsAccessToken: 'ns-base-tok',
      nsRefreshToken: 'ns-base-ref',
      nsUsername: 'base@domain.com',
      seatId: 'seat-base-123',
    });

    // Client presents baseRefresh to v3 lookupRefresh
    const lookup = await store.sessions.lookupRefresh(baseRefresh, clientId, Date.now());
    expect(lookup.status).toBe('active');
    if (lookup.status === 'active') {
      expect(lookup.session.clientId).toBe(clientId);
      expect(lookup.session.extra?.seatId).toBe('seat-base-123');
      expect(lookup.session.nsUsername).toBe('base@domain.com');
      expect(lookup.session.nsAccessToken).toBe('ns-base-tok');
    }
  });
});
