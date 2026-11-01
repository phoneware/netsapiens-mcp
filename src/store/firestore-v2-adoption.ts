import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createCodec } from './codec.js';
import { firestoreCollections, type FirestoreLike } from './firestore.js';
import type { AccessRow, FamilyRow, RefreshPointerRow, StoredToken, UpstreamGrantRow, AuthCodeData } from './types.js';
import type { PendingAuthorization, NsTokenResponse } from '../auth/types.js';
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
    clients: number;
    oauthClients: number;
  };
  classifications: {
    pr56Families: number;
    baseFormatTokens: number;
    authCodes: number;
    resumeTokens: number;
    clients: number;
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
  codeSha?: string;
  codeArtifact?: string;
  packageIntegrity?: string;
  expectedSourceInventoryDigest?: string;
  completionState?: 'completed';
  targetCounts?: Record<string, number>;
  scanned: number;
  migrated: number;
  skipped: number;
  errors: number;
  completedAt: number;
}
function computeSourceRecordFingerprint(type: string, id: string, data: Record<string, unknown> | undefined, hmacKey: Buffer): string {
  const d = data || {};
  const hmac = createHmac('sha256', hmacKey);
  hmac.update(`type:${type}|id:${id}`);
  if (type === 'family') {
    hmac.update(`|curRef:${d.currentRefreshToken || ''}|curAcc:${d.currentAccessToken || ''}|gen:${d.generation || 1}`);
  } else if (type === 'refresh') {
    hmac.update(`|famId:${d.familyId || ''}|status:${d.status || ''}`);
  } else if (type === 'token') {
    hmac.update(`|client:${d.clientId || ''}|refFam:${d.refreshFamilyId || ''}`);
  } else if (type === 'upstream') {
    const grant = (d.grant as Record<string, unknown> | undefined) ?? d;
    hmac.update(`|user:${grant.username || d.nsUsername || ''}|ver:${d.grantVersion || 1}`);
  } else if (type === 'authCode') {
    hmac.update(`|exp:${d.expiresAt || d.expires_at || 0}`);
  } else if (type === 'client') {
    hmac.update(`|clientName:${d.client_name || ''}|issuedAt:${d.client_id_issued_at || 0}`);
  }
  return hmac.digest('hex');
}

function computeTargetRecordFingerprint(type: string, id: string, data: Record<string, unknown> | undefined, hmacKey: Buffer): string {
  const d = data || {};
  const hmac = createHmac('sha256', hmacKey);
  hmac.update(`type:target:${type}|id:${id}`);
  if (type === 'family') {
    hmac.update(`|activeRef:${d.activeRefreshId || ''}|acc:${d.currentAccessTokenId || ''}|gen:${d.generation || 1}`);
  } else if (type === 'refresh') {
    hmac.update(`|famId:${d.familyId || ''}|status:${d.status || ''}|gen:${d.generation || 1}`);
  } else if (type === 'session') {
    hmac.update(`|famId:${d.familyId || ''}|exp:${d.expiresAt || 0}`);
  } else if (type === 'upstream') {
    hmac.update(`|ver:${d.grantVersion || 1}`);
  } else if (type === 'authCode') {
    hmac.update(`|exp:${d.expiresAt || 0}`);
  } else if (type === 'resume') {
    hmac.update(`|cons:${d.consumedAt || 0}|exp:${d.expiresAt || 0}`);
  } else if (type === 'client') {
    hmac.update(`|clientName:${d.client_name || ''}|issuedAt:${d.client_id_issued_at || 0}`);
  }
  return hmac.digest('hex');
}

export interface AdoptFirestoreLegacyTokensOptions {
  db: FirestoreLike;
  namespace: string;
  key: Uint8Array;
  dryRun?: boolean;
  expectedEpoch?: number;
  migrationRunId?: string;
  runId?: string;
  codeSha?: string;
  codeArtifact?: string;
  packageIntegrity?: string;
  expectedSourceInventoryDigest?: string;
  now?: () => number;
}

export async function adoptFirestoreLegacyTokens(
  options: AdoptFirestoreLegacyTokensOptions,
): Promise<FirestoreAdoptionReport> {
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
    clients: 0,
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
  const effectiveRunId = options.migrationRunId ?? options.runId ?? initialControl?.migrationRunId;
  let currentEpoch = options.expectedEpoch ?? initialControl?.epoch ?? 1;
  let runId: string = effectiveRunId ?? `run-${Date.now()}`;

  if (isControlled && !dryRun) {
    if (!effectiveRunId) {
      throw new CutoverFenceError(
        `migrationRunId (or runId) is required for controlled migration of namespace ${namespace}`,
      );
    }
    if (options.expectedEpoch === undefined) {
      throw new CutoverFenceError(
        `expectedEpoch is required for controlled migration of namespace ${namespace}`,
      );
    }
    if (!options.codeSha) {
      throw new CutoverFenceError(
        `codeSha is required for controlled migration of namespace ${namespace}`,
      );
    }
    if (!options.codeArtifact || !/^.+@sha256:[a-f0-9]{64}$/.test(options.codeArtifact)) {
      throw new CutoverFenceError(
        `codeArtifact must be an approved image reference ending in @sha256:<64 lowercase hex>, got ${options.codeArtifact}`,
      );
    }
    if (!options.packageIntegrity) {
      throw new CutoverFenceError(
        `packageIntegrity is required for controlled migration of namespace ${namespace}`,
      );
    }
  }
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
      } else {
        if (effectiveRunId && initialControl.migrationRunId !== effectiveRunId) {
          throw new CutoverFenceError(
            `Cannot resume migration for namespace ${namespace}: migrationRunId mismatch (expected ${effectiveRunId}, control has ${initialControl.migrationRunId})`,
          );
        }
        if (!initialControl.migrationRunId) {
          throw new CutoverFenceError(
            `Cannot resume migration for namespace ${namespace}: control record missing migrationRunId`,
          );
        }
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
  const legacyClientsCol = `${namespace}_clients`;
  const legacyOauthClientsCol = `${namespace}_oauth_clients`;

  // Enumerate all physical source collections for candidate graph (no swallow, fail closed)
  const familiesSnap = await db.collection(legacyFamiliesCol).get();
  const tokensSnap = await db.collection(legacyTokensCol).get();
  const refreshSnap = await db.collection(legacyRefreshCol).get();
  const upstreamSnap = await db.collection(legacyUpstreamCol).get();
  const authCodesSnap = await db.collection(legacyAuthCodesCol).get();
  const resumeSnap = await db.collection(legacyResumeCol).get();
  const oauthClientsSnap = await db.collection(legacyOauthClientsCol).get();
  const clientsSnap = await db.collection(legacyClientsCol).get();

  const clientDocs = new Map<string, Record<string, unknown>>();
  for (const doc of clientsSnap.docs) {
    clientDocs.set(doc.id, doc.data() || {});
  }
  for (const doc of oauthClientsSnap.docs) {
    if (clientDocs.has(doc.id)) {
      const prev = clientDocs.get(doc.id)!;
      const cur = doc.data() || {};
      const prevUris = JSON.stringify(prev.redirect_uris || []);
      const curUris = JSON.stringify(cur.redirect_uris || []);
      if (prevUris !== curUris) {
        report.errors++;
        reasons.conflictingClaims++;
        continue;
      }
    }
    clientDocs.set(doc.id, doc.data() || {});
  }

  const physicalCounts = {
    families: familiesSnap.docs.length,
    tokens: tokensSnap.docs.length,
    refresh: refreshSnap.docs.length,
    upstream: upstreamSnap.docs.length,
    authCodes: authCodesSnap.docs.length,
    resumeTokens: resumeSnap.docs.length,
    clients: clientsSnap.docs.length,
    oauthClients: oauthClientsSnap.docs.length,
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

  // Check for orphan refresh pointers (Sol Finding 3 / NsmcpV3PrivatePreflight)
  for (const refDoc of refreshSnap.docs) {
    const rData = refDoc.data() as Record<string, unknown>;
    const famId = (rData.familyId as string | undefined) ?? (rData.family_id as string | undefined);
    if (famId) {
      if (!familiesById.has(famId)) {
        report.errors++;
        reasons.orphanRefreshPointers++;
      }
    } else {
      const accId = (rData.accessToken as string | undefined) ?? (rData.access_token as string | undefined);
      const parentTok = accId ? tokensByAccessId.get(accId) : undefined;
      if (!accId || !parentTok || parentTok.refreshToken !== refDoc.id) {
        report.errors++;
        reasons.orphanRefreshPointers++;
      }
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

    const rawRetired = Array.isArray(famData.retiredRefreshFingerprints)
      ? (famData.retiredRefreshFingerprints as string[])
      : (Array.isArray(famData.retiredTokens) ? (famData.retiredTokens as string[]) : []);
    const retiredFingerprints = Array.from(new Set(rawRetired.filter(fp => typeof fp === 'string' && fp.length > 0)));

    let conflictFound = false;
    for (const fp of retiredFingerprints) {
      if (claimedRetiredFingerprints.has(fp)) {
        report.errors++;
        reasons.conflictingClaims++;
        conflictFound = true;
        break;
      }
      claimedRetiredFingerprints.set(fp, familyId);
    }
    if (conflictFound) continue;
    try {
      const outcome = await db.runTransaction(async (tx) => {
        // Read control inside transaction if controlled
        if (isControlled && initialControl && !dryRun) {
          const ctrl = await readCutoverFenceInTransaction(tx, db, namespace);
          if (ctrl.epoch !== currentEpoch || ctrl.state !== 'migrating') {
            throw new CutoverFenceError(`Cannot migrate family ${familyId}: state is ${ctrl.state}; expected migrating`);
          }
          if (ctrl.migrationRunId !== runId) {
            throw new CutoverFenceError(`Cannot migrate family ${familyId}: migrationRunId mismatch (expected ${runId}, got ${ctrl.migrationRunId})`);
          }
        }
        const famSnap = await tx.get(db.collection(legacyFamiliesCol).doc(familyId));
        if (!famSnap.exists) return 'skipped';
        const liveFamData = famSnap.data() as Record<string, unknown>;

        const currentRefreshToken = liveFamData.currentRefreshToken as string | undefined;
        const refSnap = currentRefreshToken
          ? await tx.get(db.collection(legacyRefreshCol).doc(currentRefreshToken))
          : null;
        const refData = (refSnap?.exists ? refSnap.data() : null) as Record<string, unknown> | null;
        const embeddedToken = (refData?.token as Record<string, unknown> | undefined) ?? {};

        const upSnap = await tx.get(db.collection(legacyUpstreamCol).doc(familyId));
        const upData = (upSnap.exists ? upSnap.data() : {}) as Record<string, unknown>;
        const grant = (upData.grant as Record<string, unknown> | undefined) ?? upData;

        const accessId = (liveFamData.currentAccessToken as string | undefined) ?? (embeddedToken.accessToken as string | undefined);
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
          (liveFamData.clientId as string | undefined);

        if (!clientId) {
          throw new Error(`Cannot adopt PR56 family ${familyId}: clientId missing`);
        }

        const rawAccessId = accessId;
        const newAccessId = codec.id('session', rawAccessId);
        const rawRefreshId = currentRefreshToken || (embeddedToken.refreshToken as string);
        const newRefreshId = codec.id('refresh', rawRefreshId);

        const liveRetiredRaw = Array.isArray(liveFamData.retiredRefreshFingerprints)
          ? (liveFamData.retiredRefreshFingerprints as string[])
          : (Array.isArray(liveFamData.retiredTokens) ? (liveFamData.retiredTokens as string[]) : []);
        const liveRetiredFingerprints = Array.from(new Set(liveRetiredRaw.filter(fp => typeof fp === 'string' && fp.length > 0)));
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
          if (liveFamData.previousRefreshToken) {
            const prevRefreshId = codec.id('refresh', liveFamData.previousRefreshToken as string);
            const targetPrevRefSnap = await tx.get(db.collection(v3Cols.refreshTokens).doc(prevRefreshId));
            if (!targetPrevRefSnap.exists || targetPrevRefSnap.data()?.status !== 'consumed') {
              throw new Error(`Target previous refresh pointer missing or invalid for ${familyId}`);
            }
          }
          return 'migrated';
        }

        // Read previous refresh pointer if present
        let prevRefreshRow: RefreshPointerRow | undefined;
        if (liveFamData.previousRefreshToken) {
          const prevRefreshId = codec.id('refresh', liveFamData.previousRefreshToken as string);
          const prevRefDoc = await tx.get(db.collection(legacyRefreshCol).doc(liveFamData.previousRefreshToken as string));
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

        if (typeof accData?.expiresAt !== 'number' && typeof embeddedToken.expiresAt !== 'number') {
          throw new Error(`Cannot adopt PR56 family ${familyId}: access token expiresAt missing`);
        }
        const expiresAt = typeof accData?.expiresAt === 'number'
          ? (accData.expiresAt as number)
          : (embeddedToken.expiresAt as number);
        const retainUntil = expiresAt + ACCESS_RETENTION_MS;

        const serverBaseUrl = (embeddedToken.serverBaseUrl as string | undefined) ??
          (accData?.serverBaseUrl as string | undefined) ??
          (liveFamData.serverBaseUrl as string | undefined);

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
          if (ctrl.epoch !== currentEpoch || ctrl.state !== 'migrating') {
            throw new CutoverFenceError(`Cannot migrate token: state is ${ctrl.state}; expected migrating`);
          }
          if (ctrl.migrationRunId !== runId) {
            throw new CutoverFenceError(`Cannot migrate token: migrationRunId mismatch (expected ${runId}, got ${ctrl.migrationRunId})`);
          }
        }

        const legacyTokSnap = await tx.get(db.collection(legacyTokensCol).doc(accessToken));
        if (!legacyTokSnap.exists) {
          return 'skipped';
        }
        const data = legacyTokSnap.data();
        if (!data) {
          return 'skipped';
        }

        const clientId = data.clientId;
        if (typeof clientId !== 'string' || clientId.length === 0) {
          throw new Error(`Cannot adopt legacy token ${accessToken}: clientId is missing or invalid`);
        }

        const refreshToken = data.refreshToken;
        if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
          throw new Error(`Cannot adopt legacy token ${accessToken}: refreshToken is missing or invalid`);
        }

        const nsAccessToken = data.nsAccessToken;
        if (typeof nsAccessToken !== 'string' || nsAccessToken.length === 0) {
          throw new Error(`Cannot adopt legacy token ${accessToken}: nsAccessToken is missing or empty`);
        }

        const nsUsername = data.nsUsername;
        if (typeof nsUsername !== 'string' || nsUsername.length === 0) {
          throw new Error(`Cannot adopt legacy token ${accessToken}: nsUsername is missing or invalid`);
        }

        if (typeof data.expiresAt !== 'number') {
          throw new Error(`Cannot adopt legacy token ${accessToken}: expiresAt is missing or invalid`);
        }
        const expiresAt = data.expiresAt as number;
        const now = nowProvider();
        const retainUntil = expiresAt + ACCESS_RETENTION_MS;
        const generation = 1;
        const grantVersion = 1;

        const familyId = codec.id('family', accessToken);
        const refreshId = codec.id('refresh', refreshToken);

        // Bi-directional pointer check in tx (Sol Finding)
        const refSnap = await tx.get(db.collection(legacyRefreshCol).doc(refreshToken));
        if (!refSnap.exists) {
          throw new Error(`Matching refresh pointer document missing for base token ${accessToken}`);
        }
        const refData = refSnap.data() as Record<string, unknown>;
        if (refData.accessToken !== accessToken) {
          throw new Error(`Refresh pointer bijection mismatch for base token ${accessToken}`);
        }

        // Target verification (Sol Finding 4)
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
          const tFamData = targetFamSnap.data() as Record<string, unknown>;
          const tRefData = targetRefSnap.data() as Record<string, unknown>;
          const tAccData = targetAccSnap.data() as Record<string, unknown>;
          if (
            tFamData?.id !== familyId ||
            tFamData?.activeRefreshId !== refreshId ||
            tFamData?.currentAccessTokenId !== accessId ||
            tRefData?.familyId !== familyId ||
            tRefData?.status !== 'active' ||
            tAccData?.familyId !== familyId
          ) {
            throw new Error(`Target content mismatch for base token ${accessToken}`);
          }
          return 'migrated';
        }
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
            nsAccessToken,
            nsRefreshToken: data.nsRefreshToken as string | undefined,
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
          const outcome = await db.runTransaction(async (tx) => {
            if (isControlled && initialControl && !dryRun) {
              const ctrl = await readCutoverFenceInTransaction(tx, db, namespace);
              if (ctrl.epoch !== currentEpoch || ctrl.state !== 'migrating' || ctrl.migrationRunId !== runId) {
                throw new CutoverFenceError(`Cutover state changed concurrently during auth code migration`);
              }
            }

            // Reread source inside transaction (Finding 7)
            const sourceCodeSnap = await tx.get(db.collection(legacyAuthCodesCol).doc(rawCode));
            if (!sourceCodeSnap.exists) return 'skipped';
            const codeData = sourceCodeSnap.data() as Record<string, unknown>;

            // Read pending: could be nested (standard v2.4) or flat (legacy v2.3)
            const rawPending = (codeData.pending && typeof codeData.pending === 'object')
              ? (codeData.pending as Record<string, unknown>)
              : codeData;

            const clientId = (rawPending.clientId ?? rawPending.client_id ?? codeData.clientId ?? codeData.client_id) as string | undefined;
            const codeChallenge = (rawPending.codeChallenge ?? rawPending.code_challenge) as string | undefined;
            const redirectUri = (rawPending.redirectUri ?? rawPending.redirect_uri) as string | undefined;
            const createdAt = (rawPending.createdAt ?? rawPending.created_at) as number | undefined;

            const rawNsTokens = (codeData.nsTokens && typeof codeData.nsTokens === 'object')
              ? (codeData.nsTokens as Record<string, unknown>)
              : undefined;
            const nsAccessToken = (rawNsTokens?.access_token ?? rawNsTokens?.nsAccessToken ?? codeData.nsAccessToken) as string | undefined;

            if (
              !clientId || typeof clientId !== 'string' || clientId.length === 0 ||
              !codeChallenge || typeof codeChallenge !== 'string' || codeChallenge.length === 0 ||
              !redirectUri || typeof redirectUri !== 'string' || redirectUri.length === 0 ||
              typeof createdAt !== 'number' ||
              !nsAccessToken || typeof nsAccessToken !== 'string' || nsAccessToken.length === 0
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
              return 'skipped';
            }

            const pendingPayload: PendingAuthorization = {
              clientId,
              codeChallenge,
              redirectUri,
              createdAt,
              state: typeof rawPending.state === 'string' ? rawPending.state : undefined,
              scopes: Array.isArray(rawPending.scopes) ? (rawPending.scopes as string[]) : undefined,
              resource: rawPending.resource ? (rawPending.resource as any) : undefined,
            };

            const nsTokensPayload: NsTokenResponse = {
              access_token: nsAccessToken,
              refresh_token: (rawNsTokens?.refresh_token ?? rawNsTokens?.nsRefreshToken ?? codeData.nsRefreshToken) as string | undefined,
              expires_in: typeof rawNsTokens?.expires_in === 'number' ? (rawNsTokens.expires_in as number) : undefined,
              username: (rawNsTokens?.username ?? rawNsTokens?.nsUsername ?? codeData.nsUsername) as string | undefined,
              nsUserRole: (rawNsTokens?.nsUserRole ?? codeData.nsUserRole) as string | undefined,
              nsApiUrl: (rawNsTokens?.nsApiUrl ?? codeData.nsApiUrl) as string | undefined,
              scope: (rawNsTokens?.scope ?? codeData.scope) as string | undefined,
            };

            const payload: AuthCodeData = {
              pending: pendingPayload,
              nsTokens: nsTokensPayload,
              extra: codeData.extra as Record<string, string> | undefined,
              serverBaseUrl: codeData.serverBaseUrl as string | undefined,
              clientId,
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
            return 'migrated';
          });
          if (outcome === 'migrated') {
            classifications.authCodes++;
            report.migrated++;
          }
        } catch {
          report.errors++;
          reasons.malformedRecords++;
        }
      } else {
        report.skipped++;
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
          const outcome = await db.runTransaction(async (tx) => {
            if (isControlled && initialControl && !dryRun) {
              const ctrl = await readCutoverFenceInTransaction(tx, db, namespace);
              if (ctrl.epoch !== currentEpoch || (ctrl.state !== 'migrating' && ctrl.state !== 'fenced')) {
                throw new CutoverFenceError(`Cutover state changed concurrently during resume token migration`);
              }
            }

            // Reread source inside transaction (Finding 8)
            const sourceResumeSnap = await tx.get(db.collection(legacyResumeCol).doc(rDoc.id));
            if (!sourceResumeSnap.exists) return 'skipped';
            const rData = sourceResumeSnap.data() as Record<string, unknown>;

            if (typeof rData.consumedAt !== 'number' || typeof rData.expiresAt !== 'number') {
              throw new Error(`Malformed resume token ${rDoc.id}: consumedAt or expiresAt is not a number`);
            }

            const targetResumeSnap = await tx.get(db.collection(v3Cols.resumeTokens).doc(rDoc.id));
            if (targetResumeSnap.exists) {
              const tData = targetResumeSnap.data() as Record<string, unknown>;
              if (tData.v === 2) {
                return 'skipped';
              }
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
            return 'migrated';
          });
          if (outcome === 'migrated') {
            classifications.resumeTokens++;
            report.migrated++;
          }
        } catch {
          report.errors++;
          reasons.malformedRecords++;
        }
      }
    }
  }

  // 5. Migrate OAuth clients
  if (clientDocs.size > 0) {
    for (const [clientId, initialClientData] of clientDocs.entries()) {
      try {
        const outcome = await db.runTransaction(async (tx) => {
          if (isControlled && initialControl && !dryRun) {
            const ctrl = await readCutoverFenceInTransaction(tx, db, namespace);
            if (ctrl.epoch !== currentEpoch || ctrl.state !== 'migrating' || ctrl.migrationRunId !== runId) {
              throw new CutoverFenceError(`Cutover state changed concurrently during client migration`);
            }
          }
          // Reread source inside tx
          const srcOauthSnap = await tx.get(db.collection(legacyOauthClientsCol).doc(clientId));
          const srcLegacySnap = await tx.get(db.collection(legacyClientsCol).doc(clientId));
          const srcSnap = srcOauthSnap.exists ? srcOauthSnap : srcLegacySnap;
          if (!srcSnap.exists) return 'skipped';
          const clientData = srcSnap.data() as Record<string, unknown>;

          if (
            typeof clientData.client_id !== 'string' ||
            !Array.isArray(clientData.redirect_uris) ||
            typeof clientData.token_endpoint_auth_method !== 'string'
          ) {
            throw new Error(`Malformed client ${clientId}`);
          }

          // Target verification
          const targetClientSnap = await tx.get(db.collection(v3Cols.oauthClients).doc(clientId));
          if (targetClientSnap.exists) {
            const tData = targetClientSnap.data() as Record<string, unknown>;
            if (tData.client_id !== clientId || !Array.isArray(tData.redirect_uris)) {
              throw new Error(`Target client content mismatch for ${clientId}`);
            }
            if (!dryRun && isControlled && initialControl) {
              await markIrreversibleInTransaction(tx, db, namespace, currentEpoch, runId, nowProvider);
            }
            return 'migrated';
          }

          if (!dryRun) {
            if (isControlled && initialControl) {
              await markIrreversibleInTransaction(tx, db, namespace, currentEpoch, runId, nowProvider);
            }
            tx.set(db.collection(v3Cols.oauthClients).doc(clientId), defined({
              ...clientData,
              client_id: clientId,
            }));
          }
          return 'migrated';
        });
        if (outcome === 'migrated') {
          classifications.clients++;
          report.migrated++;
        } else {
          report.skipped++;
        }
      } catch {
        report.errors++;
        reasons.malformedRecords++;
      }
    }
  }

  // 6. Compute keyed inventory digests over ALL physical collections (Finding 6)
  const sourceHmacKey = createHmac('sha256', key).update('nsmcp:inventory:source:v1').digest();
  const targetHmacKey = createHmac('sha256', key).update('nsmcp:inventory:target:v1').digest();

  const sourceEntries: string[] = [
    ...familiesSnap.docs.map(d => computeSourceRecordFingerprint('family', d.id, d.data(), sourceHmacKey)),
    ...tokensSnap.docs.map(d => computeSourceRecordFingerprint('token', d.id, d.data(), sourceHmacKey)),
    ...refreshSnap.docs.map(d => computeSourceRecordFingerprint('refresh', d.id, d.data(), sourceHmacKey)),
    ...upstreamSnap.docs.map(d => computeSourceRecordFingerprint('upstream', d.id, d.data(), sourceHmacKey)),
    ...authCodesSnap.docs.map(d => computeSourceRecordFingerprint('authCode', d.id, d.data(), sourceHmacKey)),
    ...resumeSnap.docs.map(d => computeSourceRecordFingerprint('resume', d.id, d.data(), sourceHmacKey)),
    ...Array.from(clientDocs.entries()).map(([id, data]) => computeSourceRecordFingerprint('client', id, data, sourceHmacKey)),
  ].sort();
  const sourceInventoryDigest = createHmac('sha256', sourceHmacKey).update(sourceEntries.join('\n')).digest('hex');

  const [tFam, tUp, tRef, tSess, tCodes, tRes, tRet, tClients] = await Promise.all([
    db.collection(v3Cols.refreshFamilies).get(),
    db.collection(v3Cols.upstreamGrants).get(),
    db.collection(v3Cols.refreshTokens).get(),
    db.collection(v3Cols.sessions).get(),
    db.collection(v3Cols.authCodes).get(),
    db.collection(v3Cols.resumeTokens).get(),
    db.collection(v3Cols.retiredRefreshTokens).get(),
    db.collection(v3Cols.oauthClients).get(),
  ]);
  const targetEntries: string[] = [
    ...tFam.docs.map(d => computeTargetRecordFingerprint('family', d.id, d.data(), targetHmacKey)),
    ...tUp.docs.map(d => computeTargetRecordFingerprint('upstream', d.id, d.data(), targetHmacKey)),
    ...tRef.docs.map(d => computeTargetRecordFingerprint('refresh', d.id, d.data(), targetHmacKey)),
    ...tSess.docs.map(d => computeTargetRecordFingerprint('session', d.id, d.data(), targetHmacKey)),
    ...tCodes.docs.map(d => computeTargetRecordFingerprint('authCode', d.id, d.data(), targetHmacKey)),
    ...tRes.docs.map(d => computeTargetRecordFingerprint('resume', d.id, d.data(), targetHmacKey)),
    ...tRet.docs.map(d => computeTargetRecordFingerprint('retired', d.id, d.data(), targetHmacKey)),
    ...tClients.docs.map(d => computeTargetRecordFingerprint('client', d.id, d.data(), targetHmacKey)),
  ].sort();
  const targetInventoryDigest = createHmac('sha256', targetHmacKey).update(targetEntries.join('\n')).digest('hex');

  if (options.expectedSourceInventoryDigest && options.expectedSourceInventoryDigest !== sourceInventoryDigest) {
    throw new CutoverFenceError(
      `Source inventory digest mismatch: expected ${options.expectedSourceInventoryDigest}, got ${sourceInventoryDigest}`,
    );
  }

  const manifest: MigrationManifest = {
    schemaVersion: 1,
    runId,
    epoch: currentEpoch,
    namespace,
    codeSha: options.codeSha,
    codeArtifact: options.codeArtifact,
    packageIntegrity: options.packageIntegrity,
    expectedSourceInventoryDigest: options.expectedSourceInventoryDigest,
    completionState: 'completed',
    physicalCounts,
    targetCounts: {
      families: tFam.docs.length,
      tokens: tSess.docs.length,
      refresh: tRef.docs.length,
      upstream: tUp.docs.length,
      authCodes: tCodes.docs.length,
      resumeTokens: tRes.docs.length,
      retiredRefreshTokens: tRet.docs.length,
      oauthClients: tClients.docs.length,
    },
    classifications,
    reasons,
    digests: {
      sourceInventoryDigest,
      targetInventoryDigest,
    },
    scanned: report.scanned,
    migrated: classifications.pr56Families + classifications.baseFormatTokens + classifications.authCodes + classifications.resumeTokens + classifications.clients,
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
        if (ctrl.migrationRunId !== runId) {
          throw new CutoverFenceError(
            `Cannot finalize migration: control migrationRunId mismatch (expected ${runId}, got ${ctrl.migrationRunId})`,
          );
        }
        if (report.migrated > 0 && !ctrl.irreversible) {
          throw new CutoverFenceError(`Inconsistency: credentials were migrated but irreversible latch was not engaged`);
        }
        // C12: For empty namespaces (report.migrated === 0), irreversible remains false until first credential mutation
      }

      // Write migration manifest
      tx.set(
        db.collection(`${namespace}_meta`).doc(`migration_manifest_${currentEpoch}`),
        stripUndefined(manifest as unknown as Record<string, unknown>),
      );

      // Write v2_adopted marker
      const isActuallyEmpty = report.migrated === 0 && report.scanned === 0;
      tx.set(
        db.collection(`${namespace}_meta`).doc('v2_adopted'),
        stripUndefined({
          adoptedAt: nowProvider(),
          migrationRunId: runId,
          runId,
          epoch: currentEpoch,
          manifestDigest,
          migrationManifestDigest: manifestDigest,
          empty: isActuallyEmpty,
          emptyNamespace: isActuallyEmpty,
          totalAdopted: report.migrated,
          totalCandidateTokens: classifications.pr56Families + classifications.baseFormatTokens,
          totalCandidateCodes: classifications.authCodes,
          totalCandidateResumes: classifications.resumeTokens,
          totalCandidateClients: classifications.clients,
          scanned: report.scanned,
          migrated: report.migrated,
          skipped: report.skipped,
          errors: report.errors,
          codeSha: options.codeSha,
          codeArtifact: options.codeArtifact,
          packageIntegrity: options.packageIntegrity,
        }),
      );

      // Transition to v3_ready
      if (isControlled && initialControl && ctrl) {
        const ctrlRef = getCutoverFenceDocRef(db, namespace);
        tx.set(
          ctrlRef,
          stripUndefined({
            state: 'v3_ready',
            irreversible: ctrl.irreversible,
            emptyNamespace: isActuallyEmpty ? true : undefined,
            migrationRunId: runId,
            migrationManifestDigest: manifestDigest,
            updatedAt: nowProvider(),
            migratedAt: nowProvider(),
          }),
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
  const isControlled = isSupportedCutoverNamespace(namespace);

  if (isControlled) {
    const control = await getCutoverFenceRecord(db, namespace);
    if (!control || control.state !== 'v3_active') {
      const state = control?.state ?? 'uninitialized';
      throw new CutoverRefusedError(
        `Cutover state is ${state}; v3 operations require v3_active for namespace ${namespace}`,
        { cutoverState: state, epoch: control?.epoch },
      );
    }
    return;
  }

  // Non-controlled test namespaces only:
  const markerDoc = db.collection(`${namespace}_meta`).doc('v2_adopted');
  const snap = await markerDoc.get();
  if (snap.exists) return;

  const [legFam, legTok, legRef, legUp, legAuth, legRes] = await Promise.all([
    db.collection(`${namespace}_tokens_refresh_families`).get(),
    db.collection(`${namespace}_tokens`).get(),
    db.collection(`${namespace}_tokens_refresh`).get(),
    db.collection(`${namespace}_tokens_upstream`).get(),
    db.collection(`${namespace}_auth_codes`).get(),
    db.collection(`${namespace}_resume_tokens`).get(),
  ]);
  const hasLegacy = !legFam.empty || !legTok.empty || !legRef.empty || !legUp.empty || !legAuth.empty || !legRes.empty;

  if (hasLegacy) {
    throw new CutoverRefusedError(
      `Legacy credentials present for namespace ${namespace}. Explicit fenced cutover migration required; runtime auto-adoption is disabled.`,
    );
  }

  await markerDoc.set({ adoptedAt: (options.now ?? Date.now)(), skipped: true, scanned: 0, migrated: 0, errors: 0 });
}
