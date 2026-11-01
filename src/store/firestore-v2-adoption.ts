import { randomUUID } from 'node:crypto';
import { createCodec } from './codec.js';
import { firestoreCollections, type FirestoreLike } from './firestore.js';
import type { AccessRow, FamilyRow, RefreshPointerRow, StoredToken, UpstreamGrantRow } from './types.js';
import { ACCESS_RETENTION_MS, accessAad, familyAad, refreshAad, upstreamAad } from './store.js';

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
  details?: Array<{ id: string; status: 'migrated' | 'skipped' | 'error'; reason?: string }>;
}

export async function adoptFirestoreLegacyTokens(options: {
  db: FirestoreLike;
  namespace: string;
  key: Uint8Array;
  dryRun?: boolean;
}): Promise<FirestoreAdoptionReport> {
  const { db, namespace, key, dryRun = false } = options;
  const codec = createCodec(key);
  const v3Cols = firestoreCollections(namespace);

  const report: FirestoreAdoptionReport = {
    scanned: 0,
    migrated: 0,
    skipped: 0,
    errors: 0,
    details: [],
  };

  // Legacy collections:
  const legacyTokensCol = `${namespace}_tokens`;
  const legacyFamiliesCol = `${namespace}_tokens_refresh_families`;
  const legacyUpstreamCol = `${namespace}_tokens_upstream`;

  // 1. Check for PR56 style families
  try {
    const familiesSnap = await db.collection(legacyFamiliesCol).get();
    for (const famDoc of familiesSnap.docs) {
      report.scanned++;
      const famData = famDoc.data();
      const familyId = famDoc.id;

      if (!famData) {
        report.skipped++;
        continue;
      }

      // Check if already migrated to v3
      const existingV3 = await db.collection(v3Cols.refreshFamilies).doc(familyId).get();
      if (existingV3.exists) {
        report.skipped++;
        report.details?.push({ id: familyId, status: 'skipped', reason: 'already migrated' });
        continue;
      }

      // Read matching upstream doc
      const upDoc = await db.collection(legacyUpstreamCol).doc(familyId).get();
      const upData = upDoc.data() ?? {};

      // Read matching access doc
      const accessId = famData.currentAccessToken as string;
      const accDoc = accessId ? await db.collection(legacyTokensCol).doc(accessId).get() : undefined;
      const accData = accDoc?.data();

      const now = Date.now();
      const generation = typeof famData.generation === 'number' ? famData.generation : 1;
      const grantVersion = typeof upData.grantVersion === 'number' ? upData.grantVersion : 1;

      const newAccessId = accessId ? codec.id('session', accessId) : codec.id('session', randomUUID());
      const newRefreshId = famData.currentRefreshToken
        ? codec.id('refresh', famData.currentRefreshToken as string)
        : codec.id('refresh', randomUUID());

      const expiresAt = typeof accData?.expiresAt === 'number' ? accData.expiresAt : now + 3600_000;
      const retainUntil = expiresAt + ACCESS_RETENTION_MS;

      const familyRow: FamilyRow = {
        id: familyId,
        generation,
        status: (famData.status === 'revoked' ? 'revoked' : 'active'),
        activeRefreshId: newRefreshId,
        currentAccessTokenId: newAccessId,
        updatedAt: now,
        sealed: codec.seal({
          clientId: famData.clientId ?? accData?.clientId ?? 'migrated',
          serverBaseUrl: famData.serverBaseUrl ?? accData?.serverBaseUrl,
          extra: accData?.extra ?? {},
          retiredRefreshIds: Array.isArray(famData.retiredRefreshFingerprints) ? famData.retiredRefreshFingerprints : [],
        }, familyAad({ id: familyId, generation })),
      };

      const upstreamRow: UpstreamGrantRow = {
        id: familyId,
        grantVersion,
        nsExpiresAt: typeof upData.nsExpiresAt === 'number' ? upData.nsExpiresAt : undefined,
        updatedAt: now,
        sealed: codec.seal({
          nsAccessToken: upData.nsAccessToken ?? accData?.nsAccessToken ?? '',
          nsRefreshToken: upData.nsRefreshToken ?? accData?.nsRefreshToken,
          nsUsername: upData.nsUsername ?? accData?.nsUsername ?? '',
          nsUserRole: upData.nsUserRole ?? accData?.nsUserRole,
          nsApiUrl: upData.nsApiUrl ?? accData?.nsApiUrl,
        }, upstreamAad({ id: familyId, grantVersion })),
      };

      const accessRow: AccessRow = {
        id: newAccessId,
        familyId,
        expiresAt,
        retainUntil,
        sealed: codec.seal({
          familyId,
          clientId: famData.clientId ?? accData?.clientId ?? 'migrated',
          serverBaseUrl: famData.serverBaseUrl ?? accData?.serverBaseUrl,
          extra: accData?.extra ?? {},
        }, accessAad({ id: newAccessId, familyId })),
      };

      const refreshRow: RefreshPointerRow = {
        id: newRefreshId,
        familyId,
        status: 'active',
        generation,
      };

      if (!dryRun) {
        await db.runTransaction(async (tx) => {
          tx.set(db.collection(v3Cols.refreshFamilies).doc(familyId), defined({ ...familyRow, v: 2 }));
          tx.set(db.collection(v3Cols.upstreamGrants).doc(familyId), defined({ ...upstreamRow, v: 2 }));
          tx.set(db.collection(v3Cols.refreshTokens).doc(newRefreshId), defined({ ...refreshRow, v: 2 }));
          tx.set(db.collection(v3Cols.sessions).doc(newAccessId), defined({ ...accessRow, v: 2, ttlAt: new Date(retainUntil) }));
        });
      }

      report.migrated++;
      report.details?.push({ id: familyId, status: 'migrated' });
    }
  } catch (err: unknown) {
    report.errors++;
  }

  // 2. Check for unattached legacy tokens in <ns>_tokens
  try {
    const tokensSnap = await db.collection(legacyTokensCol).get();
    for (const tokDoc of tokensSnap.docs) {
      report.scanned++;
      const tokData = tokDoc.data();
      const accessToken = tokDoc.id;

      if (!tokData || !tokData.refreshToken) {
        report.skipped++;
        continue;
      }

      const accessId = codec.id('session', accessToken);
      const existingV3Access = await db.collection(v3Cols.sessions).doc(accessId).get();
      if (existingV3Access.exists) {
        report.skipped++;
        report.details?.push({ id: accessToken, status: 'skipped', reason: 'already migrated' });
        continue;
      }

      const familyId = (tokData.refreshFamilyId as string) || randomUUID();
      const refreshId = codec.id('refresh', tokData.refreshToken as string);
      const now = Date.now();
      const expiresAt = typeof tokData.expiresAt === 'number' ? tokData.expiresAt : now + 3600_000;
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
          clientId: tokData.clientId ?? 'migrated',
          serverBaseUrl: tokData.serverBaseUrl,
          extra: tokData.extra ?? (tokData.seatId ? { seatId: String(tokData.seatId) } : {}),
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
          clientId: tokData.clientId ?? 'migrated',
          serverBaseUrl: tokData.serverBaseUrl,
          extra: tokData.extra ?? (tokData.seatId ? { seatId: String(tokData.seatId) } : {}),
          retiredRefreshIds: [],
        }, familyAad({ id: familyId, generation })),
      };

      const upstreamRow: UpstreamGrantRow = {
        id: familyId,
        grantVersion,
        nsExpiresAt: typeof tokData.nsExpiresAt === 'number' ? tokData.nsExpiresAt : undefined,
        updatedAt: now,
        sealed: codec.seal({
          nsAccessToken: tokData.nsAccessToken ?? '',
          nsRefreshToken: tokData.nsRefreshToken,
          nsUsername: tokData.nsUsername ?? '',
          nsUserRole: tokData.nsUserRole,
          nsApiUrl: tokData.nsApiUrl,
        }, upstreamAad({ id: familyId, grantVersion })),
      };

      if (!dryRun) {
        await db.runTransaction(async (tx) => {
          tx.set(db.collection(v3Cols.refreshFamilies).doc(familyId), defined({ ...familyRow, v: 2 }));
          tx.set(db.collection(v3Cols.upstreamGrants).doc(familyId), defined({ ...upstreamRow, v: 2 }));
          tx.set(db.collection(v3Cols.refreshTokens).doc(refreshId), defined({ ...refreshRow, v: 2 }));
          tx.set(db.collection(v3Cols.sessions).doc(accessId), defined({ ...accessRow, v: 2, ttlAt: new Date(retainUntil) }));
        });
      }

      report.migrated++;
      report.details?.push({ id: accessToken, status: 'migrated' });
    }
  } catch (err: unknown) {
    report.errors++;
  }

  return report;
}
