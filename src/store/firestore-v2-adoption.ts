import { randomUUID } from 'node:crypto';
import { createCodec } from './codec.js';
import { firestoreCollections, type FirestoreLike } from './firestore.js';
import type { AccessRow, FamilyRow, RefreshPointerRow, StoredToken, UpstreamGrantRow } from './types.js';
import { ACCESS_RETENTION_MS, accessAad, familyAad, refreshAad, upstreamAad } from './store.js';
import { StoreUnavailableError } from './codec.js';

function defined<T>(value: T): T {
  if (Array.isArray(value)) return value.filter(v => v !== undefined).map(defined) as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, defined(v)])) as T;
  }
  return value;
}

export interface FirestoreAdoptionReport {
  scanned: number;
  migrated: number;
  skipped: number;
  errors: number;
}

export interface CutoverFenceDoc {
  status: 'open' | 'fenced' | 'migrated';
  fencedAt?: number;
  migratedAt?: number;
  fenceEpoch?: number;
}

export class CutoverFencedError extends Error {
  constructor(message = 'Legacy token mutations are fenced for v3 migration') {
    super(message);
    this.name = 'CutoverFencedError';
  }
}

export async function checkCutoverFence(options: {
  db: FirestoreLike;
  namespace: string;
}): Promise<CutoverFenceDoc> {
  const { db, namespace } = options;
  const snap = await db.collection(`${namespace}_meta`).doc('cutover_fence').get();
  if (!snap.exists) {
    return { status: 'open' };
  }
  return snap.data() as unknown as CutoverFenceDoc;
}

export async function engageCutoverFence(options: {
  db: FirestoreLike;
  namespace: string;
}): Promise<CutoverFenceDoc> {
  const { db, namespace } = options;
  const docRef = db.collection(`${namespace}_meta`).doc('cutover_fence');
  const now = Date.now();
  const fence: CutoverFenceDoc = {
    status: 'fenced',
    fencedAt: now,
    fenceEpoch: now,
  };
  await docRef.set(defined(fence as unknown as Record<string, unknown>));
  return fence;
}

export async function releaseCutoverFence(options: {
  db: FirestoreLike;
  namespace: string;
}): Promise<CutoverFenceDoc> {
  const { db, namespace } = options;
  const docRef = db.collection(`${namespace}_meta`).doc('cutover_fence');
  const fence: CutoverFenceDoc = {
    status: 'open',
  };
  await docRef.set(defined(fence as unknown as Record<string, unknown>));
  return fence;
}

export async function assertLegacyWritePermitted(options: {
  db: FirestoreLike;
  namespace: string;
  tx?: any;
}): Promise<void> {
  const { db, namespace, tx } = options;
  const docRef = db.collection(`${namespace}_meta`).doc('cutover_fence');
  const snap = tx ? await tx.get(docRef) : await docRef.get();
  if (snap && snap.exists) {
    const fence = snap.data() as unknown as CutoverFenceDoc;
    if (fence.status === 'fenced' || fence.status === 'migrated') {
      throw new CutoverFencedError(`Legacy write refused: namespace ${namespace} is ${fence.status}`);
    }
  }
}

export async function adoptFirestoreLegacyTokens(options: {
  db: FirestoreLike;
  namespace: string;
  key: Uint8Array;
  dryRun?: boolean;
  requireFence?: boolean;
}): Promise<FirestoreAdoptionReport> {
  const { db, namespace, key, dryRun = false, requireFence = false } = options;

  if (requireFence) {
    const fence = await checkCutoverFence({ db, namespace });
    if (fence.status !== 'fenced') {
      throw new StoreUnavailableError(`Cannot adopt legacy tokens: cutover fence is not engaged (current status: ${fence.status})`);
    }
  }
  const codec = createCodec(key);
  const v3Cols = firestoreCollections(namespace);

  const report: FirestoreAdoptionReport = {
    scanned: 0,
    migrated: 0,
    skipped: 0,
    errors: 0,
  };

  const legacyTokensCol = `${namespace}_tokens`;
  const legacyRefreshCol = `${namespace}_tokens_refresh`;
  const legacyFamiliesCol = `${namespace}_tokens_refresh_families`;
  const legacyUpstreamCol = `${namespace}_tokens_upstream`;

  // 1. Adopt established PR56 refresh families
  try {
    const familiesSnap = await db.collection(legacyFamiliesCol).get();
    for (const famDoc of familiesSnap.docs) {
      report.scanned++;
      const familyId = famDoc.id;

      try {
        const outcome = await db.runTransaction(async (tx) => {
          // Check if already migrated inside transaction
          const existingV3 = await tx.get(db.collection(v3Cols.refreshFamilies).doc(familyId));
          if (existingV3.exists) {
            return 'skipped';
          }

          // Read source legacy family inside transaction
          const famSnap = await tx.get(db.collection(legacyFamiliesCol).doc(familyId));
          if (!famSnap.exists) return 'skipped';
          const famData = famSnap.data() as Record<string, unknown>;

          // Read active refresh pointer inside transaction (AUTHORITATIVE FOR CLIENT BINDING)
          const currentRefreshToken = famData.currentRefreshToken as string | undefined;
          const refSnap = currentRefreshToken
            ? await tx.get(db.collection(legacyRefreshCol).doc(currentRefreshToken))
            : null;
          const refData = (refSnap?.exists ? refSnap.data() : null) as Record<string, unknown> | null;
          const embeddedToken = (refData?.token as Record<string, unknown> | undefined) ?? {};

          // Read upstream grant doc inside transaction (nested { grant: { ... } } or flat)
          const upSnap = await tx.get(db.collection(legacyUpstreamCol).doc(familyId));
          const upData = (upSnap.exists ? upSnap.data() : {}) as Record<string, unknown>;
          const grant = (upData.grant as Record<string, unknown> | undefined) ?? upData;

          // Read access doc inside transaction (may be absent due to Firestore TTL)
          const accessId = (famData.currentAccessToken as string | undefined) ?? (embeddedToken.accessToken as string | undefined);
          const accSnap = accessId ? await tx.get(db.collection(legacyTokensCol).doc(accessId)) : null;
          const accData = (accSnap?.exists ? accSnap.data() : null) as Record<string, unknown> | null;

          const clientId = (embeddedToken.clientId as string | undefined) ??
            (accData?.clientId as string | undefined) ??
            (famData.clientId as string | undefined);

          if (!clientId) {
            throw new Error(`Cannot adopt PR56 family ${familyId}: client binding missing across pointer, access, and family docs`);
          }

          const now = Date.now();
          const generation = typeof famData.generation === 'number' ? (famData.generation as number) : 1;
          const grantVersion = typeof upData.grantVersion === 'number' ? (upData.grantVersion as number) : 1;

          const rawAccessId = accessId || randomUUID();
          const newAccessId = codec.id('session', rawAccessId);
          const rawRefreshId = currentRefreshToken || (embeddedToken.refreshToken as string | undefined) || randomUUID();
          const newRefreshId = codec.id('refresh', rawRefreshId);

          const expiresAt = typeof accData?.expiresAt === 'number'
            ? (accData.expiresAt as number)
            : (typeof embeddedToken.expiresAt === 'number' ? (embeddedToken.expiresAt as number) : now + 3600_000);
          const retainUntil = expiresAt + ACCESS_RETENTION_MS;

          const serverBaseUrl = (embeddedToken.serverBaseUrl as string | undefined) ??
            (accData?.serverBaseUrl as string | undefined) ??
            (famData.serverBaseUrl as string | undefined);

          const extra = (embeddedToken.extra as Record<string, string> | undefined) ??
            (accData?.extra as Record<string, string> | undefined) ??
            {};

          const nsAccessToken = (grant.nsAccessToken ?? grant.access_token ?? embeddedToken.nsAccessToken ?? accData?.nsAccessToken ?? '') as string;
          const nsRefreshToken = (grant.nsRefreshToken ?? grant.refresh_token ?? embeddedToken.nsRefreshToken ?? accData?.nsRefreshToken) as string | undefined;
          const nsUsername = (grant.nsUsername ?? grant.username ?? embeddedToken.nsUsername ?? accData?.nsUsername ?? '') as string;
          const nsUserRole = (grant.nsUserRole ?? grant.user_role ?? grant.userRole ?? embeddedToken.nsUserRole ?? accData?.nsUserRole) as string | undefined;
          const nsApiUrl = (grant.nsApiUrl ?? grant.api_url ?? grant.apiUrl ?? embeddedToken.nsApiUrl ?? accData?.nsApiUrl) as string | undefined;
          const nsExpiresAt = typeof upData.expiresAt === 'number'
            ? (upData.expiresAt as number)
            : (typeof grant.expires_in === 'number'
              ? now + (grant.expires_in as number) * 1000
              : (typeof accData?.nsExpiresAt === 'number' ? (accData.nsExpiresAt as number) : (typeof embeddedToken.nsExpiresAt === 'number' ? (embeddedToken.nsExpiresAt as number) : undefined)));

          const retiredFingerprints = Array.isArray(famData.retiredRefreshFingerprints)
            ? (famData.retiredRefreshFingerprints as string[])
            : [];

          const familyRow: FamilyRow = {
            id: familyId,
            generation,
            status: (famData.status === 'revoked' ? 'revoked' : 'active'),
            activeRefreshId: newRefreshId,
            currentAccessTokenId: newAccessId,
            updatedAt: now,
            sealed: codec.seal({
              clientId,
              serverBaseUrl,
              extra,
              retiredRefreshIds: retiredFingerprints,
            }, familyAad({ id: familyId, generation })),
          };

          const upstreamRow: UpstreamGrantRow = {
            id: familyId,
            grantVersion,
            nsExpiresAt,
            updatedAt: now,
            sealed: codec.seal({
              nsAccessToken,
              nsRefreshToken,
              nsUsername,
              nsUserRole,
              nsApiUrl,
            }, upstreamAad({ id: familyId, grantVersion })),
          };

          const accessRow: AccessRow = {
            id: newAccessId,
            familyId,
            expiresAt,
            retainUntil,
            sealed: codec.seal({
              familyId,
              clientId,
              serverBaseUrl,
              extra,
            }, accessAad({ id: newAccessId, familyId })),
          };

          const refreshRow: RefreshPointerRow = {
            id: newRefreshId,
            familyId,
            status: 'active',
            generation,
          };

          let prevRefreshRow: RefreshPointerRow | undefined;
          if (famData.previousRefreshToken && currentRefreshToken && rawAccessId) {
            const prevRefreshId = codec.id('refresh', famData.previousRefreshToken as string);
            const prevRefDoc = await tx.get(db.collection(legacyRefreshCol).doc(famData.previousRefreshToken as string));
            const prevData = prevRefDoc.exists ? (prevRefDoc.data() as Record<string, unknown>) : null;
            const consumedAt = typeof prevData?.consumedAt === 'number' ? (prevData.consumedAt as number) : now;

            prevRefreshRow = {
              id: prevRefreshId,
              familyId,
              status: 'consumed',
              generation: Math.max(1, generation - 1),
              consumedAt,
              successorSealed: codec.seal({
                accessToken: rawAccessId,
                refreshToken: currentRefreshToken,
              }, `successor:${prevRefreshId}`),
            };
          }

          if (!dryRun) {
            tx.set(db.collection(v3Cols.refreshFamilies).doc(familyId), defined({ ...familyRow, v: 2 }));
            tx.set(db.collection(v3Cols.upstreamGrants).doc(familyId), defined({ ...upstreamRow, v: 2 }));
            tx.set(db.collection(v3Cols.refreshTokens).doc(newRefreshId), defined({ ...refreshRow, v: 2 }));
            tx.set(db.collection(v3Cols.sessions).doc(newAccessId), defined({ ...accessRow, v: 2, ttlAt: new Date(retainUntil) }));
            if (prevRefreshRow) {
              tx.set(db.collection(v3Cols.refreshTokens).doc(prevRefreshRow.id), defined({ ...prevRefreshRow, v: 2 }));
            }
            for (const fp of retiredFingerprints) {
              tx.set(db.collection(v3Cols.retiredRefreshTokens).doc(fp), {
                familyId,
                retiredAt: now,
              });
            }
          }
          return 'migrated';
        });
        if (outcome === 'skipped') {
          report.skipped++;
        } else {
          report.migrated++;
        }
      } catch (err: unknown) {
        report.errors++;
      }
    }
  } catch (err: unknown) {
    report.errors++;
  }

  // 2. Adopt unattached base-format token documents
  try {
    const tokensSnap = await db.collection(legacyTokensCol).get();
    for (const tokDoc of tokensSnap.docs) {
      report.scanned++;
      const accessToken = tokDoc.id;
      const accessId = codec.id('session', accessToken);

      try {
        const outcome = await db.runTransaction(async (tx) => {
          const existingV3Access = await tx.get(db.collection(v3Cols.sessions).doc(accessId));
          if (existingV3Access.exists) {
            return 'skipped';
          }

          const legacyTokSnap = await tx.get(db.collection(legacyTokensCol).doc(accessToken));
          if (!legacyTokSnap.exists) {
            return 'skipped';
          }
          const tokData = legacyTokSnap.data();
          if (!tokData || !tokData.refreshToken) {
            return 'skipped';
          }
          const familyId = (tokData.refreshFamilyId as string) || randomUUID();
          const refreshId = codec.id('refresh', tokData.refreshToken as string);
          const now = Date.now();
          const expiresAt = typeof tokData.expiresAt === 'number' ? (tokData.expiresAt as number) : now + 3600_000;
          const retainUntil = expiresAt + ACCESS_RETENTION_MS;
          const generation = 1;
          const grantVersion = 1;

          const accessRow: AccessRow = {
            id: accessId,
            familyId,
            expiresAt,
            retainUntil,
            sealed: codec.seal({
              familyId,
              clientId: (tokData.clientId ?? 'migrated') as string,
              serverBaseUrl: tokData.serverBaseUrl as string | undefined,
              extra: (tokData.extra ?? (tokData.seatId ? { seatId: String(tokData.seatId) } : {})) as Record<string, string>,
            }, accessAad({ id: accessId, familyId })),
          };

          const refreshRow: RefreshPointerRow = {
            id: refreshId,
            familyId,
            status: 'active',
            generation,
          };

          const familyRow: FamilyRow = {
            id: familyId,
            generation,
            status: 'active',
            activeRefreshId: refreshId,
            currentAccessTokenId: accessId,
            updatedAt: now,
            sealed: codec.seal({
              clientId: (tokData.clientId ?? 'migrated') as string,
              serverBaseUrl: tokData.serverBaseUrl as string | undefined,
              extra: (tokData.extra ?? (tokData.seatId ? { seatId: String(tokData.seatId) } : {})) as Record<string, string>,
              retiredRefreshIds: [],
            }, familyAad({ id: familyId, generation })),
          };

          const upstreamRow: UpstreamGrantRow = {
            id: familyId,
            grantVersion,
            nsExpiresAt: typeof tokData.nsExpiresAt === 'number' ? (tokData.nsExpiresAt as number) : undefined,
            updatedAt: now,
            sealed: codec.seal({
              nsAccessToken: (tokData.nsAccessToken ?? '') as string,
              nsRefreshToken: tokData.nsRefreshToken as string | undefined,
              nsUsername: (tokData.nsUsername ?? '') as string,
              nsUserRole: tokData.nsUserRole as string | undefined,
              nsApiUrl: tokData.nsApiUrl as string | undefined,
            }, upstreamAad({ id: familyId, grantVersion })),
          };

          if (!dryRun) {
            tx.set(db.collection(v3Cols.refreshFamilies).doc(familyId), defined({ ...familyRow, v: 2 }));
            tx.set(db.collection(v3Cols.upstreamGrants).doc(familyId), defined({ ...upstreamRow, v: 2 }));
            tx.set(db.collection(v3Cols.refreshTokens).doc(refreshId), defined({ ...refreshRow, v: 2 }));
            tx.set(db.collection(v3Cols.sessions).doc(accessId), defined({ ...accessRow, v: 2, ttlAt: new Date(retainUntil) }));
          }
          return 'migrated';
        });
        if (outcome === 'skipped') {
          report.skipped++;
        } else {
          report.migrated++;
        }
      } catch (err: unknown) {
        report.errors++;
      }
    }
  } catch (err: unknown) {
    report.errors++;
  }
  if (!dryRun && report.errors === 0) {
    const now = Date.now();
    await db.collection(`${namespace}_meta`).doc('cutover_fence').set({
      status: 'migrated',
      migratedAt: now,
    });
    await db.collection(`${namespace}_meta`).doc('v2_adopted').set({
      adoptedAt: now,
      scanned: report.scanned,
      migrated: report.migrated,
      skipped: report.skipped,
      errors: 0,
    });
  }
  return report;
}

export async function ensureFirestoreAdopted(options: {
  db: FirestoreLike;
  namespace: string;
  key: Uint8Array;
}): Promise<void> {
  const { db, namespace, key } = options;
  const markerDoc = db.collection(`${namespace}_meta`).doc('v2_adopted');
  const snap = await markerDoc.get();
  if (snap.exists) return;

  // Read without swallowing errors: network or permission failure MUST fail closed
  const legacyFamiliesSnap = await db.collection(`${namespace}_tokens_refresh_families`).get();
  const legacyTokensSnap = await db.collection(`${namespace}_tokens`).get();

  const hasLegacy = !legacyFamiliesSnap.empty || !legacyTokensSnap.empty;
  if (!hasLegacy) {
    await markerDoc.set({ adoptedAt: Date.now(), skipped: true, scanned: 0, migrated: 0, errors: 0 });
    return;
  }
  const report = await adoptFirestoreLegacyTokens({ db, namespace, key });
  if (report.errors > 0) {
    throw new StoreUnavailableError(`Firestore legacy adoption failed with ${report.errors} error(s); cannot start`);
  }
}

export async function adoptSingleLegacyToken(options: {
  db: FirestoreLike;
  namespace: string;
  key: Uint8Array;
  accessToken: string;
  tokData: Record<string, unknown>;
}): Promise<void> {
  const { db, namespace, key, accessToken, tokData } = options;
  const codec = createCodec(key);
  const v3Cols = firestoreCollections(namespace);
  const accessId = codec.id('session', accessToken);

  await db.runTransaction(async (tx) => {
    const existing = await tx.get(db.collection(v3Cols.sessions).doc(accessId));
    if (existing.exists) return;

    const familyId = (tokData.refreshFamilyId as string) || randomUUID();
    const refreshId = codec.id('refresh', tokData.refreshToken as string);
    const now = Date.now();
    const expiresAt = typeof tokData.expiresAt === 'number' ? (tokData.expiresAt as number) : now + 3600_000;
    const retainUntil = expiresAt + ACCESS_RETENTION_MS;
    const generation = 1;
    const grantVersion = 1;

    const accessRow: AccessRow = {
      id: accessId,
      familyId,
      expiresAt,
      retainUntil,
      sealed: codec.seal({
        familyId,
        clientId: (tokData.clientId ?? 'migrated') as string,
        serverBaseUrl: tokData.serverBaseUrl as string | undefined,
        extra: (tokData.extra ?? (tokData.seatId ? { seatId: String(tokData.seatId) } : {})) as Record<string, string>,
      }, accessAad({ id: accessId, familyId })),
    };

    const refreshRow: RefreshPointerRow = {
      id: refreshId,
      familyId,
      status: 'active',
      generation,
    };

    const familyRow: FamilyRow = {
      id: familyId,
      generation,
      status: 'active',
      activeRefreshId: refreshId,
      currentAccessTokenId: accessId,
      updatedAt: now,
      sealed: codec.seal({
        clientId: (tokData.clientId ?? 'migrated') as string,
        serverBaseUrl: tokData.serverBaseUrl as string | undefined,
        extra: (tokData.extra ?? (tokData.seatId ? { seatId: String(tokData.seatId) } : {})) as Record<string, string>,
        retiredRefreshIds: [],
      }, familyAad({ id: familyId, generation })),
    };

    const upstreamRow: UpstreamGrantRow = {
      id: familyId,
      grantVersion,
      nsExpiresAt: typeof tokData.nsExpiresAt === 'number' ? (tokData.nsExpiresAt as number) : undefined,
      updatedAt: now,
      sealed: codec.seal({
        nsAccessToken: (tokData.nsAccessToken ?? '') as string,
        nsRefreshToken: tokData.nsRefreshToken as string | undefined,
        nsUsername: (tokData.nsUsername ?? '') as string,
        nsUserRole: tokData.nsUserRole as string | undefined,
        nsApiUrl: tokData.nsApiUrl as string | undefined,
      }, upstreamAad({ id: familyId, grantVersion })),
    };

    tx.set(db.collection(v3Cols.refreshFamilies).doc(familyId), defined({ ...familyRow, v: 2 }));
    tx.set(db.collection(v3Cols.upstreamGrants).doc(familyId), defined({ ...upstreamRow, v: 2 }));
    tx.set(db.collection(v3Cols.refreshTokens).doc(refreshId), defined({ ...refreshRow, v: 2 }));
    tx.set(db.collection(v3Cols.sessions).doc(accessId), defined({ ...accessRow, v: 2, ttlAt: new Date(retainUntil) }));
  });
}

export async function adoptSingleLegacyFamily(options: {
  db: FirestoreLike;
  namespace: string;
  key: Uint8Array;
  familyId: string;
}): Promise<void> {
  const { db, namespace, key, familyId } = options;
  const codec = createCodec(key);
  const v3Cols = firestoreCollections(namespace);
  const legacyTokensCol = `${namespace}_tokens`;
  const legacyRefreshCol = `${namespace}_tokens_refresh`;
  const legacyFamiliesCol = `${namespace}_tokens_refresh_families`;
  const legacyUpstreamCol = `${namespace}_tokens_upstream`;

  await db.runTransaction(async (tx) => {
    const famSnap = await tx.get(db.collection(legacyFamiliesCol).doc(familyId));
    if (!famSnap.exists) return;
    const famData = famSnap.data() as Record<string, unknown>;

    const currentRefreshToken = famData.currentRefreshToken as string | undefined;
    const rawRefreshId = currentRefreshToken || randomUUID();
    const newRefreshId = codec.id('refresh', rawRefreshId);

    const existingV3 = await tx.get(db.collection(v3Cols.refreshFamilies).doc(familyId));
    let previousActiveRefreshId: string | undefined;
    let generation = typeof famData.generation === 'number' ? (famData.generation as number) : 1;

    if (existingV3.exists) {
      const existingFam = existingV3.data() as unknown as FamilyRow;
      if (existingFam.activeRefreshId === newRefreshId) {
        return; // Already up to date
      }
      generation = Math.max(generation, existingFam.generation + 1);
      previousActiveRefreshId = existingFam.activeRefreshId;
    }
    const refSnap = currentRefreshToken
      ? await tx.get(db.collection(legacyRefreshCol).doc(currentRefreshToken))
      : null;
    const refData = (refSnap?.exists ? refSnap.data() : null) as Record<string, unknown> | null;
    const embeddedToken = (refData?.token as Record<string, unknown> | undefined) ?? {};

    const upSnap = await tx.get(db.collection(legacyUpstreamCol).doc(familyId));
    const upData = (upSnap.exists ? upSnap.data() : {}) as Record<string, unknown>;
    const grant = (upData.grant as Record<string, unknown> | undefined) ?? upData;

    const accessId = (famData.currentAccessToken as string | undefined) ?? (embeddedToken.accessToken as string | undefined);
    const accSnap = accessId ? await tx.get(db.collection(legacyTokensCol).doc(accessId)) : null;
    const accData = (accSnap?.exists ? accSnap.data() : null) as Record<string, unknown> | null;

    const clientId = (embeddedToken.clientId as string | undefined) ??
      (accData?.clientId as string | undefined) ??
      (famData.clientId as string | undefined);

    if (!clientId) {
      throw new Error(`Cannot adopt PR56 family ${familyId}: client binding missing`);
    }

    const now = Date.now();
    const grantVersion = typeof upData.grantVersion === 'number' ? (upData.grantVersion as number) : 1;


    const rawAccessId = accessId || randomUUID();
    const newAccessId = codec.id('session', rawAccessId);


    const expiresAt = typeof accData?.expiresAt === 'number'
      ? (accData.expiresAt as number)
      : (typeof embeddedToken.expiresAt === 'number' ? (embeddedToken.expiresAt as number) : now + 3600_000);
    const retainUntil = expiresAt + ACCESS_RETENTION_MS;

    const serverBaseUrl = (embeddedToken.serverBaseUrl as string | undefined) ??
      (accData?.serverBaseUrl as string | undefined) ??
      (famData.serverBaseUrl as string | undefined);

    const extra = (embeddedToken.extra as Record<string, string> | undefined) ??
      (accData?.extra as Record<string, string> | undefined) ??
      {};

    const nsAccessToken = (grant.nsAccessToken ?? grant.access_token ?? embeddedToken.nsAccessToken ?? accData?.nsAccessToken ?? '') as string;
    const nsRefreshToken = (grant.nsRefreshToken ?? grant.refresh_token ?? embeddedToken.nsRefreshToken ?? accData?.nsRefreshToken) as string | undefined;
    const nsUsername = (grant.nsUsername ?? grant.username ?? embeddedToken.nsUsername ?? accData?.nsUsername ?? '') as string;
    const nsUserRole = (grant.nsUserRole ?? grant.user_role ?? grant.userRole ?? embeddedToken.nsUserRole ?? accData?.nsUserRole) as string | undefined;
    const nsApiUrl = (grant.nsApiUrl ?? grant.api_url ?? grant.apiUrl ?? embeddedToken.nsApiUrl ?? accData?.nsApiUrl) as string | undefined;
    const nsExpiresAt = typeof upData.expiresAt === 'number'
      ? (upData.expiresAt as number)
      : (typeof grant.expires_in === 'number'
        ? now + (grant.expires_in as number) * 1000
        : (typeof accData?.nsExpiresAt === 'number' ? (accData.nsExpiresAt as number) : (typeof embeddedToken.nsExpiresAt === 'number' ? (embeddedToken.nsExpiresAt as number) : undefined)));

    const retiredFingerprints = Array.isArray(famData.retiredRefreshFingerprints)
      ? (famData.retiredRefreshFingerprints as string[])
      : [];

    const familyRow: FamilyRow = {
      id: familyId,
      generation,
      status: (famData.status === 'revoked' ? 'revoked' : 'active'),
      activeRefreshId: newRefreshId,
      currentAccessTokenId: newAccessId,
      updatedAt: now,
      sealed: codec.seal({
        clientId,
        serverBaseUrl,
        extra,
        retiredRefreshIds: retiredFingerprints,
      }, familyAad({ id: familyId, generation })),
    };

    const upstreamRow: UpstreamGrantRow = {
      id: familyId,
      grantVersion,
      nsExpiresAt,
      updatedAt: now,
      sealed: codec.seal({
        nsAccessToken,
        nsRefreshToken,
        nsUsername,
        nsUserRole,
        nsApiUrl,
      }, upstreamAad({ id: familyId, grantVersion })),
    };

    const accessRow: AccessRow = {
      id: newAccessId,
      familyId,
      expiresAt,
      retainUntil,
      sealed: codec.seal({
        familyId,
        clientId,
        serverBaseUrl,
        extra,
      }, accessAad({ id: newAccessId, familyId })),
    };

    const refreshRow: RefreshPointerRow = {
      id: newRefreshId,
      familyId,
      status: 'active',
      generation,
    };

    tx.set(db.collection(v3Cols.refreshFamilies).doc(familyId), defined({ ...familyRow, v: 2 }));
    tx.set(db.collection(v3Cols.upstreamGrants).doc(familyId), defined({ ...upstreamRow, v: 2 }));
    tx.set(db.collection(v3Cols.refreshTokens).doc(newRefreshId), defined({ ...refreshRow, v: 2 }));
    tx.set(db.collection(v3Cols.sessions).doc(newAccessId), defined({ ...accessRow, v: 2, ttlAt: new Date(retainUntil) }));

    if (previousActiveRefreshId && previousActiveRefreshId !== newRefreshId) {
      tx.set(db.collection(v3Cols.refreshTokens).doc(previousActiveRefreshId), defined({
        id: previousActiveRefreshId,
        familyId,
        status: 'consumed',
        generation: Math.max(1, generation - 1),
        consumedAt: now,
        successorSealed: codec.seal({
          accessToken: rawAccessId,
          refreshToken: currentRefreshToken!,
        }, `successor:${previousActiveRefreshId}`),
        v: 2,
      }));
    }

    if (famData.previousRefreshToken && currentRefreshToken && rawAccessId) {
      const prevRefreshId = codec.id('refresh', famData.previousRefreshToken as string);
      const prevRefDoc = await tx.get(db.collection(legacyRefreshCol).doc(famData.previousRefreshToken as string));
      const prevData = prevRefDoc.exists ? (prevRefDoc.data() as Record<string, unknown>) : null;
      const consumedAt = typeof prevData?.consumedAt === 'number' ? (prevData.consumedAt as number) : now;

      tx.set(db.collection(v3Cols.refreshTokens).doc(prevRefreshId), defined({
        id: prevRefreshId,
        familyId,
        status: 'consumed',
        generation: Math.max(1, generation - 1),
        consumedAt,
        successorSealed: codec.seal({
          accessToken: rawAccessId,
          refreshToken: currentRefreshToken,
        }, `successor:${prevRefreshId}`),
        v: 2,
      }));
    }
    for (const fp of retiredFingerprints) {
      tx.set(db.collection(v3Cols.retiredRefreshTokens).doc(fp), {
        familyId,
        retiredAt: now,
      });
    }
  });
}
