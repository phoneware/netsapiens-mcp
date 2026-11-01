import { createHash, randomUUID } from 'node:crypto';
import { createCodec } from './codec.js';
import { firestoreCollections, type FirestoreLike } from './firestore.js';
import type { AccessRow, FamilyRow, RefreshPointerRow, StoredToken, UpstreamGrantRow } from './types.js';
import { ACCESS_RETENTION_MS, accessAad, familyAad, refreshAad, upstreamAad } from './store.js';
import { StoreUnavailableError } from './codec.js';
import {
  type CutoverFenceControlRecord,
  type CutoverFenceState,
  getCutoverFenceDocRef,
  readCutoverFenceInTransaction,
  getCutoverFenceRecord,
  transitionCutoverFenceState,
  markIrreversibleInTransaction,
  isSupportedCutoverNamespace,
  CutoverFenceError,
  CutoverRefusedError,
  stripUndefined,
} from '../auth/kit/cutover-fence.js';

export {
  type CutoverFenceControlRecord,
  type CutoverFenceState,
  type CutoverFenceConfig,
  type LegacyOperationPhase,
  type LegacyOperationRecord,
  type LegacyOperationContext,
  getCutoverFenceDocRef,
  readCutoverFenceInTransaction,
  getCutoverFenceRecord,
  initializeCutoverFence,
  transitionCutoverFenceState,
  markIrreversibleInTransaction,
  withLegacyOperation,
  releaseLegacyOperation,
  markOperationAmbiguous,
  checkMutationGuardInTransaction,
  isLegacyMutationPermittedInTransaction,
  CutoverFenceError,
  CutoverRefusedError,
  SUPPORTED_CUTOVER_NAMESPACES,
  isSupportedCutoverNamespace,
} from '../auth/kit/cutover-fence.js';

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

export interface MigrationManifest {
  schemaVersion: 1;
  runId: string;
  epoch: number;
  namespace: string;
  physicalCounts: {
    families: number;
    tokens: number;
    refresh: number;
    upstream: number;
    authCodes: number;
    resumeTokens: number;
  };
  classifications: {
    pr56Families: number;
    baseFormatTokens: number;
    authCodes: number;
    resumeTokens: number;
  };
  reasons: {
    orphanAccessTokens: number;
    orphanRefreshPointers: number;
    orphanUpstreamGrants: number;
    conflictingClaims: number;
    missingAccessTokens: number;
    missingUpstreamGrants: number;
    missingRefreshPointers: number;
    partialTargets: number;
    malformedRecords: number;
  };
  digests: {
    sourceInventoryDigest: string;
    targetInventoryDigest: string;
  };
  scanned: number;
  migrated: number;
  skipped: number;
  errors: number;
  completedAt: number;
}

export async function adoptFirestoreLegacyTokens(options: {
  db: FirestoreLike;
  namespace: string;
  key: Uint8Array;
  dryRun?: boolean;
  expectedEpoch?: number;
  now?: () => number;
}): Promise<FirestoreAdoptionReport> {
  const { db, namespace, key, dryRun = false } = options;
  const nowProvider = options.now ?? Date.now;
  const codec = createCodec(key);
  const v3Cols = firestoreCollections(namespace);

  const report: FirestoreAdoptionReport = {
    scanned: 0,
    migrated: 0,
    skipped: 0,
    errors: 0,
  };

  const classifications = {
    pr56Families: 0,
    baseFormatTokens: 0,
    authCodes: 0,
    resumeTokens: 0,
  };

  const reasons = {
    orphanAccessTokens: 0,
    orphanRefreshPointers: 0,
    orphanUpstreamGrants: 0,
    conflictingClaims: 0,
    missingAccessTokens: 0,
    missingUpstreamGrants: 0,
    missingRefreshPointers: 0,
    partialTargets: 0,
    malformedRecords: 0,
  };

  const isControlled = isSupportedCutoverNamespace(namespace);
  const initialControl = isControlled ? await getCutoverFenceRecord(db, namespace) : undefined;
  if (isControlled && !initialControl) {
    throw new CutoverFenceError(
      `Cutover fence control record missing for namespace: ${namespace}. Cannot migrate without control record.`,
    );
  }
  let currentEpoch = options.expectedEpoch ?? initialControl?.epoch ?? 1;
  let runId: string = randomUUID();

  // C7: Validate fence state machine
  if (isControlled && initialControl) {
    if (initialControl.state !== 'fenced' && initialControl.state !== 'migrating') {
      throw new CutoverFenceError(
        `Cannot migrate namespace ${namespace}: state is ${initialControl.state}; must be fenced or migrating`,
      );
    }
    if (options.expectedEpoch !== undefined && initialControl.epoch !== options.expectedEpoch) {
      throw new CutoverFenceError(
        `Epoch mismatch for namespace ${namespace}: expected ${options.expectedEpoch}, got ${initialControl.epoch}`,
      );
    }
    currentEpoch = initialControl.epoch;

    if (!dryRun) {
      if (initialControl.state === 'fenced') {
        await transitionCutoverFenceState(db, namespace, {
          fromState: 'fenced',
          toState: 'migrating',
          expectedEpoch: currentEpoch,
          migrationRunId: runId,
          now: nowProvider,
        });
      } else if (initialControl.migrationRunId) {
        runId = initialControl.migrationRunId;
      }
    }
  }

  const legacyTokensCol = `${namespace}_tokens`;
  const legacyRefreshCol = `${namespace}_tokens_refresh`;
  const legacyFamiliesCol = `${namespace}_tokens_refresh_families`;
  const legacyUpstreamCol = `${namespace}_tokens_upstream`;
  const legacyAuthCodesCol = `${namespace}_auth_codes`;
  const legacyResumeCol = `${namespace}_resume_tokens`;

  // Enumerate all physical source collections for candidate graph (no swallow, fail closed)
  const familiesSnap = await db.collection(legacyFamiliesCol).get();
  const tokensSnap = await db.collection(legacyTokensCol).get();
  const refreshSnap = await db.collection(legacyRefreshCol).get();
  const upstreamSnap = await db.collection(legacyUpstreamCol).get();
  const authCodesSnap = await db.collection(legacyAuthCodesCol).get();
  const resumeSnap = await db.collection(legacyResumeCol).get();
  const physicalCounts = {
    families: familiesSnap.docs.length,
    tokens: tokensSnap.docs.length,
    refresh: refreshSnap.docs.length,
    upstream: upstreamSnap.docs.length,
    authCodes: authCodesSnap.docs.length,
    resumeTokens: resumeSnap.docs.length,
  };

  const familiesById = new Map<string, Record<string, unknown>>();
  for (const doc of familiesSnap.docs) {
    familiesById.set(doc.id, doc.data() as Record<string, unknown>);
  }

  const refreshPointersById = new Map<string, Record<string, unknown>>();
  for (const doc of refreshSnap.docs) {
    refreshPointersById.set(doc.id, doc.data() as Record<string, unknown>);
  }

  const upstreamById = new Map<string, Record<string, unknown>>();
  for (const doc of upstreamSnap.docs) {
    upstreamById.set(doc.id, doc.data() as Record<string, unknown>);
  }

  const tokensByAccessId = new Map<string, Record<string, unknown>>();
  for (const doc of tokensSnap.docs) {
    tokensByAccessId.set(doc.id, doc.data() as Record<string, unknown>);
  }

  // Check for orphan refresh pointers (Sol Finding 3)
  for (const refDoc of refreshSnap.docs) {
    const rData = refDoc.data() as Record<string, unknown>;
    const famId = (rData.familyId as string | undefined) ?? (rData.family_id as string | undefined);
    if (!famId || !familiesById.has(famId)) {
      report.errors++;
      reasons.orphanRefreshPointers++;
    }
  }

  // Check for orphan upstream grants (Sol Finding 3)
  for (const upDoc of upstreamSnap.docs) {
    if (!familiesById.has(upDoc.id)) {
      report.errors++;
      reasons.orphanUpstreamGrants++;
    }
  }

  // Ownership maps to detect duplicate/conflicting IDs across families (Sol Finding 3)
  const claimedAccessIds = new Map<string, string>(); // accessId -> familyId
  const claimedRefreshIds = new Map<string, string>(); // refreshId -> familyId
  const claimedRetiredFingerprints = new Map<string, string>(); // fingerprint -> familyId

  // 1. Adopt established PR56 refresh families
  for (const famDoc of familiesSnap.docs) {
    report.scanned++;
    const familyId = famDoc.id;
    const famData = famDoc.data() as Record<string, unknown>;

    // Pre-validate family integrity
    if (!upstreamById.has(familyId)) {
      report.errors++;
      reasons.missingUpstreamGrants++;
      continue;
    }
    const currentRefId = famData.currentRefreshToken as string | undefined;
    if (!currentRefId || !refreshPointersById.has(currentRefId)) {
      report.errors++;
      reasons.missingRefreshPointers++;
      continue;
    }
    const curRefDoc = refreshPointersById.get(currentRefId)!;
    const curRefFamId = (curRefDoc.familyId as string | undefined) ?? (curRefDoc.family_id as string | undefined);
    if (curRefFamId !== familyId || curRefDoc.status !== 'active') {
      report.errors++;
      reasons.malformedRecords++;
      continue;
    }
    if (claimedRefreshIds.has(currentRefId)) {
      report.errors++;
      reasons.conflictingClaims++;
      continue;
    }
    claimedRefreshIds.set(currentRefId, familyId);

    // Validate access token
    const accessId = (famData.currentAccessToken as string | undefined) ??
      ((curRefDoc.token as Record<string, unknown> | undefined)?.accessToken as string | undefined);
    if (accessId) {
      if (claimedAccessIds.has(accessId)) {
        report.errors++;
        reasons.conflictingClaims++;
        continue;
      }
      claimedAccessIds.set(accessId, familyId);
    } else {
      report.errors++;
      reasons.malformedRecords++;
      continue;
    }

    if (famData.previousRefreshToken) {
      const prevRefId = famData.previousRefreshToken as string;
      if (prevRefId === currentRefId) {
        report.errors++;
        reasons.malformedRecords++;
        continue;
      }
      if (!refreshPointersById.has(prevRefId)) {
        report.errors++;
        reasons.missingRefreshPointers++;
        continue;
      }
      const prevRefDoc = refreshPointersById.get(prevRefId)!;
      const prevRefFamId = (prevRefDoc.familyId as string | undefined) ?? (prevRefDoc.family_id as string | undefined);
      if (prevRefFamId !== familyId || prevRefDoc.status !== 'consumed') {
        report.errors++;
        reasons.malformedRecords++;
        continue;
      }
      if (claimedRefreshIds.has(prevRefId)) {
        report.errors++;
        reasons.conflictingClaims++;
        continue;
      }
      claimedRefreshIds.set(prevRefId, familyId);
    }

    if (Array.isArray(famData.retiredTokens)) {
      let conflictFound = false;
      for (const fp of famData.retiredTokens) {
        if (typeof fp === 'string') {
          if (claimedRetiredFingerprints.has(fp)) {
            report.errors++;
            reasons.conflictingClaims++;
            conflictFound = true;
            break;
          }
          claimedRetiredFingerprints.set(fp, familyId);
        }
      }
      if (conflictFound) continue;
    }
    try {
      const outcome = await db.runTransaction(async (tx) => {
        // Read control inside transaction if controlled
        if (isControlled && initialControl && !dryRun) {
          const ctrl = await readCutoverFenceInTransaction(tx, db, namespace);
          if (ctrl.epoch !== currentEpoch || (ctrl.state !== 'migrating' && ctrl.state !== 'fenced')) {
            throw new CutoverFenceError(`Cutover state changed concurrently during family migration`);
          }
        }

        // Read source records
        const famSnap = await tx.get(db.collection(legacyFamiliesCol).doc(familyId));
        if (!famSnap.exists) return 'skipped';

        const currentRefreshToken = famData.currentRefreshToken as string | undefined;
        const refSnap = currentRefreshToken
          ? await tx.get(db.collection(legacyRefreshCol).doc(currentRefreshToken))
          : null;
        const refData = (refSnap?.exists ? refSnap.data() : null) as Record<string, unknown> | null;
        const embeddedToken = (refData?.token as Record<string, unknown> | undefined) ?? {};

        const upSnap = await tx.get(db.collection(legacyUpstreamCol).doc(familyId));
        const upData = (upSnap.exists ? upSnap.data() : {}) as Record<string, unknown>;
        const grant = (upData.grant as Record<string, unknown> | undefined) ?? upData;

        const accessId = (famData.currentAccessToken as string | undefined) ?? (embeddedToken.accessToken as string | undefined);
        if (!accessId) {
          throw new Error(`Cannot adopt PR56 family ${familyId}: access token identifier missing`);
        }
        if (!currentRefreshToken && !embeddedToken.refreshToken) {
          throw new Error(`Cannot adopt PR56 family ${familyId}: refresh token identifier missing`);
        }

        const accSnap = await tx.get(db.collection(legacyTokensCol).doc(accessId));
        const accData = (accSnap.exists ? accSnap.data() : null) as Record<string, unknown> | null;

        const clientId = (embeddedToken.clientId as string | undefined) ??
          (accData?.clientId as string | undefined) ??
          (famData.clientId as string | undefined);

        if (!clientId) {
          throw new Error(`Cannot adopt PR56 family ${familyId}: clientId missing`);
        }

        const rawAccessId = accessId;
        const newAccessId = codec.id('session', rawAccessId);
        const rawRefreshId = currentRefreshToken || (embeddedToken.refreshToken as string);
        const newRefreshId = codec.id('refresh', rawRefreshId);

        // Target verification (Finding 2: detect partial target families)
        const targetFamSnap = await tx.get(db.collection(v3Cols.refreshFamilies).doc(familyId));
        const targetUpSnap = await tx.get(db.collection(v3Cols.upstreamGrants).doc(familyId));
        const targetRefSnap = await tx.get(db.collection(v3Cols.refreshTokens).doc(newRefreshId));
        const targetAccSnap = await tx.get(db.collection(v3Cols.sessions).doc(newAccessId));

        const targetStates = [targetFamSnap.exists, targetUpSnap.exists, targetRefSnap.exists, targetAccSnap.exists];
        const allTargetExist = targetStates.every(Boolean);
        const noneTargetExist = targetStates.every(e => !e);

        if (!allTargetExist && !noneTargetExist) {
          throw new Error(`Partial target family detected in v3 for ${familyId}`);
        }
        if (allTargetExist) {
          const tFamData = targetFamSnap.data() as Record<string, unknown>;
          const tRefData = targetRefSnap.data() as Record<string, unknown>;
          const tAccData = targetAccSnap.data() as Record<string, unknown>;
          if (
            tFamData?.id !== familyId ||
            tFamData?.activeRefreshId !== newRefreshId ||
            tFamData?.currentAccessTokenId !== newAccessId ||
            tRefData?.familyId !== familyId ||
            tRefData?.status !== 'active' ||
            tAccData?.familyId !== familyId
          ) {
            throw new Error(`Target family content mismatch for ${familyId}`);
          }
          if (famData.previousRefreshToken) {
            const prevRefreshId = codec.id('refresh', famData.previousRefreshToken as string);
            const targetPrevRefSnap = await tx.get(db.collection(v3Cols.refreshTokens).doc(prevRefreshId));
            if (!targetPrevRefSnap.exists || targetPrevRefSnap.data()?.status !== 'consumed') {
              throw new Error(`Target previous refresh pointer missing or invalid for ${familyId}`);
            }
          }
          return 'skipped';
        }

        // Read previous refresh pointer if present
        let prevRefreshRow: RefreshPointerRow | undefined;
        if (famData.previousRefreshToken) {
          const prevRefreshId = codec.id('refresh', famData.previousRefreshToken as string);
          const prevRefDoc = await tx.get(db.collection(legacyRefreshCol).doc(famData.previousRefreshToken as string));
          if (!prevRefDoc.exists) {
            throw new Error(`Missing previous refresh pointer document for family ${familyId}`);
          }
          const prevData = prevRefDoc.data() as Record<string, unknown>;
          if (typeof prevData?.consumedAt !== 'number') {
            throw new Error(`Previous refresh pointer missing consumedAt for family ${familyId}`);
          }
          const consumedAt = prevData.consumedAt;
          const generation = typeof famData.generation === 'number' ? (famData.generation as number) : 1;

          prevRefreshRow = {
            id: prevRefreshId,
            familyId,
            status: 'consumed',
            generation: Math.max(1, generation - 1),
            consumedAt,
            successorSealed: codec.seal({
              accessToken: rawAccessId,
              refreshToken: rawRefreshId,
            }, `successor:${prevRefreshId}`),
          };
        }

        // All reads complete. Derive write data.
        const now = nowProvider();
        const generation = typeof famData.generation === 'number' ? (famData.generation as number) : 1;
        const grantVersion = typeof upData.grantVersion === 'number' ? (upData.grantVersion as number) : 1;

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

        const nsAccessToken = (grant.nsAccessToken ?? grant.access_token ?? embeddedToken.nsAccessToken ?? accData?.nsAccessToken) as string | undefined;
        const nsRefreshToken = (grant.nsRefreshToken ?? grant.refresh_token ?? embeddedToken.nsRefreshToken ?? accData?.nsRefreshToken) as string | undefined;
        const nsUsername = (grant.nsUsername ?? grant.username ?? embeddedToken.nsUsername ?? accData?.nsUsername) as string | undefined;
        const nsUserRole = (grant.nsUserRole ?? grant.user_role ?? grant.userRole ?? embeddedToken.nsUserRole ?? accData?.nsUserRole) as string | undefined;
        const nsApiUrl = (grant.nsApiUrl ?? grant.api_url ?? grant.apiUrl ?? embeddedToken.nsApiUrl ?? accData?.nsApiUrl) as string | undefined;

        if (!nsAccessToken && !nsRefreshToken) {
          throw new Error(`Cannot adopt PR56 family ${familyId}: upstream NetSapiens credentials missing`);
        }
        if (!nsUsername) {
          throw new Error(`Cannot adopt PR56 family ${familyId}: NetSapiens username missing`);
        }

        const nsExpiresAt = typeof upData.expiresAt === 'number'
          ? (upData.expiresAt as number)
          : (typeof grant.expires_in === 'number'
            ? now + (grant.expires_in as number) * 1000
            : (typeof accData?.nsExpiresAt === 'number' ? (accData.nsExpiresAt as number) : (typeof embeddedToken.nsExpiresAt === 'number' ? (embeddedToken.nsExpiresAt as number) : undefined)));

        const rawRetired = Array.isArray(famData.retiredRefreshFingerprints) ? (famData.retiredRefreshFingerprints as string[]) : [];
        const retiredFingerprints = Array.from(new Set(rawRetired));

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
            nsAccessToken: nsAccessToken || '',
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

        // Buffer writes (at end of transaction)
        if (!dryRun) {
          if (isControlled && initialControl) {
            await markIrreversibleInTransaction(tx, db, namespace, currentEpoch, runId, nowProvider);
          }
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
        classifications.pr56Families++;
      }
    } catch (err: unknown) {
      report.errors++;
      reasons.malformedRecords++;
    }
  }

  // 2. Adopt unattached base-format token documents
  for (const tokDoc of tokensSnap.docs) {
    report.scanned++;
    const accessToken = tokDoc.id;
    const tokData = tokDoc.data() as Record<string, unknown>;
    const accessId = codec.id('session', accessToken);

    // If family-linked, verify family exists AND matches current access token
    if (tokData.refreshFamilyId) {
      const famId = tokData.refreshFamilyId as string;
      const parentFam = familiesById.get(famId);
      if (!parentFam) {
        // Orphan family-linked token!
        report.errors++;
        reasons.orphanAccessTokens++;
        continue;
      }
      if (parentFam.currentAccessToken !== accessToken) {
        // Family exists, but does not match this token as current!
        report.errors++;
        reasons.orphanAccessTokens++;
        continue;
      }
      // Family exists and matches current access token: handled in loop 1
      report.skipped++;
      continue;
    }

    // If already claimed by a family via currentAccessToken:
    if (claimedAccessIds.has(accessToken)) {
      report.skipped++;
      continue;
    }

    try {
      const outcome = await db.runTransaction(async (tx) => {
        if (isControlled && initialControl && !dryRun) {
          const ctrl = await readCutoverFenceInTransaction(tx, db, namespace);
          if (ctrl.epoch !== currentEpoch || (ctrl.state !== 'migrating' && ctrl.state !== 'fenced')) {
            throw new CutoverFenceError(`Cutover state changed concurrently during token migration`);
          }
        }

        const legacyTokSnap = await tx.get(db.collection(legacyTokensCol).doc(accessToken));
        if (!legacyTokSnap.exists) {
          return 'skipped';
        }
        const data = legacyTokSnap.data();
        if (!data || !data.refreshToken) {
          return 'skipped';
        }

        const clientId = data.clientId as string | undefined;
        if (!clientId) {
          throw new Error(`Cannot adopt legacy token ${accessToken}: clientId is missing`);
        }

        const nsAccessToken = data.nsAccessToken as string | undefined;
        const nsRefreshToken = data.nsRefreshToken as string | undefined;
        const nsUsername = data.nsUsername as string | undefined;
        if (!nsAccessToken && !nsRefreshToken) {
          throw new Error(`Cannot adopt legacy token ${accessToken}: upstream tokens missing`);
        }
        if (!nsUsername) {
          throw new Error(`Cannot adopt legacy token ${accessToken}: nsUsername is missing`);
        }

        const familyId = codec.id('family', accessToken);
        const refreshId = codec.id('refresh', data.refreshToken as string);

        const targetAccSnap = await tx.get(db.collection(v3Cols.sessions).doc(accessId));
        const targetRefSnap = await tx.get(db.collection(v3Cols.refreshTokens).doc(refreshId));
        const targetFamSnap = await tx.get(db.collection(v3Cols.refreshFamilies).doc(familyId));
        const targetUpSnap = await tx.get(db.collection(v3Cols.upstreamGrants).doc(familyId));

        const targetStates = [targetAccSnap.exists, targetRefSnap.exists, targetFamSnap.exists, targetUpSnap.exists];
        const allExist = targetStates.every(Boolean);
        const noneExist = targetStates.every(e => !e);
        if (!allExist && !noneExist) {
          throw new Error(`Partial target detected for base token ${accessToken}`);
        }
        if (allExist) {
          return 'skipped';
        }

        const now = nowProvider();
        const expiresAt = typeof data.expiresAt === 'number' ? (data.expiresAt as number) : now + 3600_000;
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
            clientId,
            serverBaseUrl: data.serverBaseUrl as string | undefined,
            extra: (data.extra ?? (data.seatId ? { seatId: String(data.seatId) } : {})) as Record<string, string>,
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
            clientId,
            serverBaseUrl: data.serverBaseUrl as string | undefined,
            extra: (data.extra ?? (data.seatId ? { seatId: String(data.seatId) } : {})) as Record<string, string>,
            retiredRefreshIds: [],
          }, familyAad({ id: familyId, generation })),
        };

        const upstreamRow: UpstreamGrantRow = {
          id: familyId,
          grantVersion,
          nsExpiresAt: typeof data.nsExpiresAt === 'number' ? (data.nsExpiresAt as number) : undefined,
          updatedAt: now,
          sealed: codec.seal({
            nsAccessToken: nsAccessToken || '',
            nsRefreshToken,
            nsUsername,
            nsUserRole: data.nsUserRole as string | undefined,
            nsApiUrl: data.nsApiUrl as string | undefined,
          }, upstreamAad({ id: familyId, grantVersion })),
        };

        if (!dryRun) {
          if (isControlled && initialControl) {
            await markIrreversibleInTransaction(tx, db, namespace, currentEpoch, runId, nowProvider);
          }
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
        classifications.baseFormatTokens++;
      }
    } catch (err: unknown) {
      report.errors++;
      reasons.malformedRecords++;
    }
  }

  // 3. Convert legacy authorization codes
  if (authCodesSnap.docs.length > 0) {
    for (const codeDoc of authCodesSnap.docs) {
      const rawCode = codeDoc.id;
      const initialCodeData = codeDoc.data() as Record<string, unknown>;
      if (!initialCodeData) continue;

      const expiresAt = typeof initialCodeData.expiresAt === 'number'
        ? (initialCodeData.expiresAt as number)
        : (typeof initialCodeData.expires_at === 'number' ? (initialCodeData.expires_at as number) : 0);

      if (expiresAt > nowProvider()) {
        try {
          await db.runTransaction(async (tx) => {
            if (isControlled && initialControl && !dryRun) {
              const ctrl = await readCutoverFenceInTransaction(tx, db, namespace);
              if (ctrl.epoch !== currentEpoch || (ctrl.state !== 'migrating' && ctrl.state !== 'fenced')) {
                throw new CutoverFenceError(`Cutover state changed concurrently during auth code migration`);
              }
            }

            // Reread source inside transaction (Finding 7)
            const sourceCodeSnap = await tx.get(db.collection(legacyAuthCodesCol).doc(rawCode));
            if (!sourceCodeSnap.exists) return;
            const codeData = sourceCodeSnap.data() as Record<string, unknown>;

            const clientId = (codeData.clientId ?? codeData.client_id) as string | undefined;
            const codeChallenge = (codeData.codeChallenge ?? codeData.code_challenge) as string | undefined;
            const redirectUri = (codeData.redirectUri ?? codeData.redirect_uri) as string | undefined;
            const createdAt = (codeData.createdAt ?? codeData.created_at) as number | undefined;
            const nsTokens = codeData.nsTokens as Record<string, unknown> | undefined;
            const nsAccessToken = (nsTokens?.access_token ?? codeData.nsAccessToken) as string | undefined;

            if (
              !clientId || typeof clientId !== 'string' ||
              !codeChallenge || typeof codeChallenge !== 'string' ||
              !redirectUri || typeof redirectUri !== 'string' ||
              typeof createdAt !== 'number' ||
              !nsAccessToken || typeof nsAccessToken !== 'string'
            ) {
              throw new Error(`Malformed auth code ${rawCode}: missing required fields or empty upstream token`);
            }

            const hmacId = codec.id('code', rawCode);
            const targetCodeSnap = await tx.get(db.collection(v3Cols.authCodes).doc(hmacId));
            if (targetCodeSnap.exists) {
              const targetData = targetCodeSnap.data() as Record<string, unknown>;
              if (targetData.id !== hmacId) {
                throw new Error(`Target auth code ID mismatch for ${rawCode}`);
              }
              return;
            }

            const payload = {
              pending: {
                clientId,
                codeChallenge,
                redirectUri,
                createdAt,
              },
              nsTokens: nsTokens ?? { access_token: nsAccessToken },
              extra: codeData.extra as Record<string, string> | undefined,
              serverBaseUrl: codeData.serverBaseUrl as string | undefined,
            };

            if (!dryRun) {
              if (isControlled && initialControl) {
                await markIrreversibleInTransaction(tx, db, namespace, currentEpoch, runId, nowProvider);
              }
              tx.set(db.collection(v3Cols.authCodes).doc(hmacId), {
                id: hmacId,
                expiresAt,
                sealed: codec.seal(payload, `code:${hmacId}`),
                v: 2,
                ttlAt: new Date(expiresAt),
              });
              tx.delete(db.collection(legacyAuthCodesCol).doc(rawCode));
            }
          });
          classifications.authCodes++;
        } catch {
          report.errors++;
          reasons.malformedRecords++;
        }
      }
    }
  }

  // 4. Retain resume tokens
  if (resumeSnap.docs.length > 0) {
    for (const rDoc of resumeSnap.docs) {
      const initialRData = rDoc.data() as Record<string, unknown>;
      if (!initialRData) continue;
      const expiresAt = typeof initialRData.expiresAt === 'number' ? (initialRData.expiresAt as number) : 0;
      if (expiresAt > nowProvider()) {
        try {
          await db.runTransaction(async (tx) => {
            if (isControlled && initialControl && !dryRun) {
              const ctrl = await readCutoverFenceInTransaction(tx, db, namespace);
              if (ctrl.epoch !== currentEpoch || (ctrl.state !== 'migrating' && ctrl.state !== 'fenced')) {
                throw new CutoverFenceError(`Cutover state changed concurrently during resume token migration`);
              }
            }

            // Reread source inside transaction (Finding 8)
            const sourceResumeSnap = await tx.get(db.collection(legacyResumeCol).doc(rDoc.id));
            if (!sourceResumeSnap.exists) return;
            const rData = sourceResumeSnap.data() as Record<string, unknown>;

            if (typeof rData.consumedAt !== 'number' || typeof rData.expiresAt !== 'number') {
              throw new Error(`Malformed resume token ${rDoc.id}: consumedAt or expiresAt is not a number`);
            }

            const targetResumeSnap = await tx.get(db.collection(v3Cols.resumeTokens).doc(rDoc.id));
            if (targetResumeSnap.exists) {
              const tData = targetResumeSnap.data() as Record<string, unknown>;
              if (tData.id !== rDoc.id) {
                throw new Error(`Target resume token ID mismatch for ${rDoc.id}`);
              }
              return;
            }

            if (!dryRun) {
              if (isControlled && initialControl) {
                await markIrreversibleInTransaction(tx, db, namespace, currentEpoch, runId, nowProvider);
              }
              tx.set(db.collection(v3Cols.resumeTokens).doc(rDoc.id), {
                id: rDoc.id,
                consumedAt: rData.consumedAt,
                expiresAt: rData.expiresAt,
                v: 2,
                ttlAt: new Date(rData.expiresAt),
              });
            }
          });
          classifications.resumeTokens++;
        } catch {
          report.errors++;
          reasons.malformedRecords++;
        }
      }
    }
  }

  // 5. Compute keyed inventory digests over ALL physical collections (Finding 6)
  const sourceEntries: string[] = [
    ...familiesSnap.docs.map(d => `source:${legacyFamiliesCol}:${d.id}`),
    ...tokensSnap.docs.map(d => `source:${legacyTokensCol}:${d.id}`),
    ...refreshSnap.docs.map(d => `source:${legacyRefreshCol}:${d.id}`),
    ...upstreamSnap.docs.map(d => `source:${legacyUpstreamCol}:${d.id}`),
    ...authCodesSnap.docs.map(d => `source:${legacyAuthCodesCol}:${d.id}`),
    ...resumeSnap.docs.map(d => `source:${legacyResumeCol}:${d.id}`),
  ].sort();
  const sourceInventoryDigest = createHash('sha256').update(sourceEntries.join('\n')).digest('hex');

  // For target inventory digest: ACTUALLY READ target collections from Firestore (Finding 6)
  const [tFam, tUp, tRef, tSess, tCodes, tRes, tRet] = await Promise.all([
    db.collection(v3Cols.refreshFamilies).get().catch(() => ({ docs: [] })),
    db.collection(v3Cols.upstreamGrants).get().catch(() => ({ docs: [] })),
    db.collection(v3Cols.refreshTokens).get().catch(() => ({ docs: [] })),
    db.collection(v3Cols.sessions).get().catch(() => ({ docs: [] })),
    db.collection(v3Cols.authCodes).get().catch(() => ({ docs: [] })),
    db.collection(v3Cols.resumeTokens).get().catch(() => ({ docs: [] })),
    db.collection(v3Cols.retiredRefreshTokens).get().catch(() => ({ docs: [] })),
  ]);
  const targetEntries: string[] = [
    ...tFam.docs.map(d => `target:${v3Cols.refreshFamilies}:${d.id}`),
    ...tUp.docs.map(d => `target:${v3Cols.upstreamGrants}:${d.id}`),
    ...tRef.docs.map(d => `target:${v3Cols.refreshTokens}:${d.id}`),
    ...tSess.docs.map(d => `target:${v3Cols.sessions}:${d.id}`),
    ...tCodes.docs.map(d => `target:${v3Cols.authCodes}:${d.id}`),
    ...tRes.docs.map(d => `target:${v3Cols.resumeTokens}:${d.id}`),
    ...tRet.docs.map(d => `target:${v3Cols.retiredRefreshTokens}:${d.id}`),
  ].sort();
  const targetInventoryDigest = createHash('sha256').update(targetEntries.join('\n')).digest('hex');
  const manifest: MigrationManifest = {
    schemaVersion: 1,
    runId,
    epoch: currentEpoch,
    namespace,
    physicalCounts,
    classifications,
    reasons,
    digests: {
      sourceInventoryDigest,
      targetInventoryDigest,
    },
    scanned: report.scanned,
    migrated: report.migrated,
    skipped: report.skipped,
    errors: report.errors,
    completedAt: nowProvider(),
  };

  const manifestJson = JSON.stringify(manifest);
  const manifestDigest = createHash('sha256').update(manifestJson).digest('hex');

  // If dryRun, do NOT write manifest, marker, or transition state
  if (!dryRun && report.errors === 0) {
    await db.runTransaction(async (tx) => {
      // Read control record first
      let ctrl: CutoverFenceControlRecord | undefined;
      if (isControlled && initialControl) {
        ctrl = await readCutoverFenceInTransaction(tx, db, namespace);
        if (ctrl.epoch !== currentEpoch || ctrl.state !== 'migrating') {
          throw new CutoverFenceError(`Cannot finalize migration: state is ${ctrl.state}; expected migrating`);
        }
        if (report.migrated > 0 && !ctrl.irreversible) {
          throw new CutoverFenceError(`Inconsistency: credentials were migrated but irreversible latch was not engaged`);
        }
      }

      // Write migration manifest
      tx.set(
        db.collection(`${namespace}_meta`).doc(`migration_manifest_${currentEpoch}`),
        manifest as unknown as Record<string, unknown>,
      );

      // Write v2_adopted marker
      tx.set(
        db.collection(`${namespace}_meta`).doc('v2_adopted'),
        {
          adoptedAt: nowProvider(),
          runId,
          epoch: currentEpoch,
          manifestDigest,
          ...report,
        },
      );

      // Transition to v3_ready
      if (isControlled && initialControl && ctrl) {
        const ctrlRef = getCutoverFenceDocRef(db, namespace);
        tx.set(
          ctrlRef,
          {
            state: 'v3_ready',
            irreversible: ctrl.irreversible,
            migrationRunId: runId,
            migrationManifestDigest: manifestDigest,
            updatedAt: nowProvider(),
            migratedAt: nowProvider(),
          },
          { merge: true },
        );
      }
    });
  }
  return report;
}

export async function ensureFirestoreAdopted(options: {
  db: FirestoreLike;
  namespace: string;
  key: Uint8Array;
  now?: () => number;
}): Promise<void> {
  const { db, namespace } = options;

  const markerDoc = db.collection(`${namespace}_meta`).doc('v2_adopted');
  const snap = await markerDoc.get();
  if (snap.exists) return;

  const legacyFamiliesSnap = await db.collection(`${namespace}_tokens_refresh_families`).get();
  const legacyTokensSnap = await db.collection(`${namespace}_tokens`).get();
  const hasLegacy = !legacyFamiliesSnap.empty || !legacyTokensSnap.empty;

  const isControlled = isSupportedCutoverNamespace(namespace);
  if (isControlled) {
    const control = await getCutoverFenceRecord(db, namespace);
    if (!control || (control.state !== 'v3_active' && control.state !== 'v3_ready')) {
      const state = control?.state ?? 'uninitialized';
      throw new CutoverRefusedError(
        `Cutover state is ${state}; v3 operations require v3_active for namespace ${namespace}`,
        { cutoverState: state, epoch: control?.epoch },
      );
    }
  }
  if (hasLegacy) {
    throw new CutoverRefusedError(
      `Legacy credentials present for namespace ${namespace}. Explicit fenced cutover migration required; runtime auto-adoption is disabled.`,
    );
  }

  // No legacy data present: write adopted marker
  await markerDoc.set({ adoptedAt: (options.now ?? Date.now)(), skipped: true, scanned: 0, migrated: 0, errors: 0 });
}
