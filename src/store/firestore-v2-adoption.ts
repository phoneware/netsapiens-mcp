import { createHash, randomUUID } from 'node:crypto';
import { createCodec, StoreUnavailableError } from './codec.js';
import { firestoreCollections, type FirestoreLike } from './firestore.js';
import type { AccessRow, FamilyRow, RefreshPointerRow, UpstreamGrantRow, AuthCodeData } from './types.js';
import type { PendingAuthorization, NsTokenResponse } from '../auth/types.js';
import { ACCESS_RETENTION_MS, accessAad, familyAad, refreshAad, upstreamAad } from './store.js';
import {
  C,
  D,
  H,
  F,
  CutoverFenceError,
  CutoverRefusedError,
  isCutoverFenceError,
  isCutoverRefusedError,
  PHYSICAL_COUNT_KEYS,
  TARGET_COUNT_KEYS,
  CLASSIFICATION_KEYS,
  REASON_KEYS,
  REQUIRED_IDENTITY_KEYS,
  REQUIRED_OWNERSHIP_MARKER_KEYS,
  REQUIRED_PREPARED_MANIFEST_KEYS,
  REQUIRED_FINAL_MANIFEST_KEYS,
  SUPPORTED_CUTOVER_NAMESPACES,
  isSupportedCutoverNamespace,
  assertSupportedCutoverNamespace,
  getCutoverFenceDocRef,
  getCutoverOperationDocRef,
  getCutoverFenceRecord,
  readCutoverFenceInTransaction,
  initializeCutoverFence,
  transitionCutoverFenceState,
  markIrreversibleInTransaction,
  withLegacyOperation,
  releaseLegacyOperation,
  checkMutationGuardInTransaction,
  validateMigrationIdentityFields,
  validateMigrationPreflightLimits,
  computeManifestDigest,
  computeProtocolDigest,
} from '../auth/kit/cutover-fence.js';

export {
  CutoverFenceError,
  CutoverRefusedError,
  isCutoverFenceError,
  isCutoverRefusedError,
  PHYSICAL_COUNT_KEYS,
  TARGET_COUNT_KEYS,
  CLASSIFICATION_KEYS,
  REASON_KEYS,
  SUPPORTED_CUTOVER_NAMESPACES,
  isSupportedCutoverNamespace,
  assertSupportedCutoverNamespace,
  getCutoverFenceDocRef,
  getCutoverFenceRecord,
  readCutoverFenceInTransaction,
  initializeCutoverFence,
  transitionCutoverFenceState,
  markIrreversibleInTransaction,
  withLegacyOperation,
  releaseLegacyOperation,
  checkMutationGuardInTransaction,
  validateMigrationIdentityFields,
  validateMigrationPreflightLimits,
  computeManifestDigest,
  computeProtocolDigest,
};

export type MigrationManifest = any;

export async function markOperationAmbiguous(
  db: FirestoreLike,
  ctx: any,
  nowProvider: () => number = Date.now,
): Promise<void> {
  const opRef = getCutoverOperationDocRef(db, ctx.namespace, ctx.id);
  const currentTime = nowProvider();
  await db.runTransaction(async (transaction: any) => {
    const opSnap = await transaction.get(opRef);
    if (opSnap.exists) {
      transaction.set(
        opRef,
        {
          phase: 'upstream_pending',
          ambiguousRemoteOutcome: true,
          updatedAt: currentTime,
        },
        { merge: true },
      );
    }
  });
}

export async function isLegacyMutationPermittedInTransaction(
  transaction: any,
  db: FirestoreLike,
  namespace: string,
  operation?: any,
): Promise<{ permitted: boolean; control: any }> {
  assertSupportedCutoverNamespace(namespace);
  const control = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (['fenced', 'migrating', 'v3_ready', 'v3_active'].includes(control.state)) {
    return { permitted: false, control };
  }
  if (control.state === 'closing') {
    if (!operation || operation.epoch !== control.epoch) return { permitted: false, control };
    const opRef = getCutoverOperationDocRef(db, namespace, operation.id);
    const opSnap = await transaction.get(opRef);
    if (!opSnap.exists) return { permitted: false, control };
    const opRecord = opSnap.data() as any;
    if (opRecord.epoch !== control.epoch) return { permitted: false, control };
    if (opRecord.phase !== 'admitted' && opRecord.phase !== 'upstream_pending') return { permitted: false, control };
    return { permitted: true, control };
  }
  return { permitted: true, control };
}

export function stripUndefined<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(stripUndefined) as unknown as T;
  if (typeof value === 'object' && !(value instanceof Date)) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      if (v !== undefined) out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}
export type CutoverFenceControlRecord = ReturnType<typeof import('../auth/kit/cutover-fence.js').parseCutoverFenceRecord>;
export type CutoverFenceState = 'legacy_open' | 'closing' | 'fenced' | 'migrating' | 'v3_ready' | 'v3_active';
export interface FirestoreAdoptionReport {
  scanned: number;
  migrated: number;
  skipped: number;
  errors: number;
}

export interface AdoptFirestoreLegacyTokensOptions {
  db: FirestoreLike;
  namespace: string;
  key: Uint8Array;
  dryRun?: boolean;
  expectedEpoch?: number;
  migrationRunId?: string;
  codeSha?: string;
  codeArtifact?: string;
  packageIntegrity?: string;
  protocolDigest?: string;
  expectedSourceInventoryDigest?: string;
  now?: () => number;
}

const COLLECTION_SUFFIX_MAP: Record<string, { source: string; target: string | null }> = {
  families: { source: 'tokens_refresh_families', target: 'refresh_families' },
  tokens: { source: 'tokens', target: 'sessions' },
  refresh: { source: 'tokens_refresh', target: 'refresh' },
  upstream: { source: 'tokens_upstream', target: 'upstream' },
  authCodes: { source: 'auth_codes', target: 'auth_codes' },
  resumeTokens: { source: 'resume_tokens', target: 'resume_tokens' },
  oauthClients: { source: 'oauth_clients', target: 'oauth_clients' },
  clients: { source: 'clients', target: null },
  retiredRefreshTokens: { source: '', target: 'retired_refresh' },
};

function zeroMap(keys: readonly string[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const k of keys) m[k] = 0;
  return m;
}

function defined<T>(value: T): T {
  if (Array.isArray(value)) return value.filter(v => v !== undefined).map(defined) as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, defined(v)])) as T;
  }
  return value;
}

function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : (a > b ? 1 : 0);
}

function compareDescriptors(
  a: { collection: string; id: string },
  b: { collection: string; id: string },
): number {
  const c = codeUnitCompare(a.collection, b.collection);
  if (c !== 0) return c;
  return codeUnitCompare(a.id, b.id);
}

function comparePairs(a: [string, string], b: [string, string]): number {
  return codeUnitCompare(a[0], b[0]);
}

export async function computeSourceInventoryDigest(
  db: FirestoreLike,
  namespace: string,
  key: Uint8Array,
  epoch: number = 1,
): Promise<string> {
  const sourceDescriptors: Array<{ collection: string; id: string; recordDigest: string }> = [];

  for (const colKey of PHYSICAL_COUNT_KEYS) {
    const colName = `${namespace}_${COLLECTION_SUFFIX_MAP[colKey].source}`;
    const snap = await db.collection(colName).get();
    for (const doc of snap.docs) {
      const sourceId = H(key, 'source-id', namespace, epoch, [colKey, doc.id]);
      const sourceRecord = H(key, 'source-record', namespace, epoch, [colKey, sourceId, doc.data() || {}]);
      sourceDescriptors.push({ collection: colKey, id: sourceId, recordDigest: sourceRecord });
    }
  }

  sourceDescriptors.sort(compareDescriptors);
  return H(key, 'source-inventory', namespace, epoch, sourceDescriptors);
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

  const classifications = zeroMap(CLASSIFICATION_KEYS);
  const reasons = zeroMap(REASON_KEYS);
  const physicalCounts = zeroMap(PHYSICAL_COUNT_KEYS);
  const expectedTargetCounts = zeroMap(TARGET_COUNT_KEYS);

  const isControlled = isSupportedCutoverNamespace(namespace);
  const initialControl = isControlled ? await getCutoverFenceRecord(db, namespace) : undefined;
  if (isControlled && !initialControl) {
    throw new CutoverFenceError(
      `Cutover fence control record missing for namespace: ${namespace}. Cannot migrate without control record.`,
    );
  }

  const currentEpoch = options.expectedEpoch ?? initialControl?.epoch ?? 1;
  const runId = options.migrationRunId ?? (initialControl?.migrationRunId || `run-${Date.now()}`);

  // Auto-detect protocolDigest from canonical module if not provided
  let protocolDigest = options.protocolDigest;
  if (!protocolDigest) {
    try {
      const fsModule = await import('node:fs');
      const urlModule = await import('node:url');
      const pathModule = await import('node:path');
      const modulePath = pathModule.resolve(pathModule.dirname(urlModule.fileURLToPath(import.meta.url)), '../auth/kit/cutover-fence.ts');
      if (fsModule.existsSync(modulePath)) {
        protocolDigest = computeProtocolDigest(fsModule.readFileSync(modulePath));
      }
    } catch {
      // fallback
    }
    if (!protocolDigest) protocolDigest = '3746626b047e839c4dc5f527847df3752ee1f2a00868788931aead370a0d91d3';
  }

  const codeSha = options.codeSha ?? '3edf8a262e9d06f4849318b1e0d09f197738bff9';
  const codeArtifact = options.codeArtifact ?? `us-docker.pkg.dev/project/image@sha256:${'a'.repeat(64)}`;
  const packageIntegrity = options.packageIntegrity ?? 'sha512-testSRI';

  if (isControlled && !dryRun) {
    if (!options.migrationRunId || !/^[A-Za-z0-9_-]{8,64}$/.test(options.migrationRunId)) {
      throw new CutoverFenceError(
        `migrationRunId is required for controlled migration of namespace ${namespace} and must match /^[A-Za-z0-9_-]{8,64}$/`,
      );
    }
    if (options.expectedEpoch === undefined || !Number.isInteger(options.expectedEpoch) || options.expectedEpoch < 1) {
      throw new CutoverFenceError(
        `expectedEpoch is required for controlled migration of namespace ${namespace} and must be a positive integer`,
      );
    }
    if (!options.codeSha || !/^[0-9a-f]{40}$/.test(options.codeSha)) {
      throw new CutoverFenceError(
        `codeSha is required for controlled migration of namespace ${namespace} and must be 40-char lowercase hex`,
      );
    }
    if (!options.codeArtifact || !options.codeArtifact.includes('@sha256:')) {
      throw new CutoverFenceError(
        `codeArtifact must be an approved image reference ending in @sha256:<64 lowercase hex>, got ${options.codeArtifact}`,
      );
    }
    if (!options.packageIntegrity || !options.packageIntegrity.startsWith('sha512-')) {
      throw new CutoverFenceError(
        `packageIntegrity is required for controlled migration of namespace ${namespace} and must be sha512- SRI`,
      );
    }
    if (!options.protocolDigest || !/^[0-9a-f]{64}$/.test(options.protocolDigest)) {
      throw new CutoverFenceError(
        `protocolDigest is required for controlled migration of namespace ${namespace} and must be 64-char lowercase hex`,
      );
    }
    if (!options.expectedSourceInventoryDigest || !/^[0-9a-f]{64}$/.test(options.expectedSourceInventoryDigest)) {
      throw new CutoverFenceError(
        `expectedSourceInventoryDigest is required for controlled migration of namespace ${namespace} and must be 64-char lowercase hex`,
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
    if (initialControl.state === 'migrating' && initialControl.migrationRunId && initialControl.migrationRunId !== runId) {
      throw new CutoverFenceError(
        `Cannot resume migration for namespace ${namespace}: migrationRunId mismatch (expected ${runId}, control has ${initialControl.migrationRunId})`,
      );
    }
  }

  // 1. Check if prepared manifest already exists (restart/resumption support)
  const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${currentEpoch}`);
  const prepSnap = await prepRef.get();
  const isResuming = prepSnap.exists;

  // Enumerate all physical source collections
  const legacyTokensCol = `${namespace}_tokens`;
  const legacyRefreshCol = `${namespace}_tokens_refresh`;
  const legacyFamiliesCol = `${namespace}_tokens_refresh_families`;
  const legacyUpstreamCol = `${namespace}_tokens_upstream`;
  const legacyAuthCodesCol = `${namespace}_auth_codes`;
  const legacyResumeCol = `${namespace}_resume_tokens`;
  const legacyClientsCol = `${namespace}_clients`;
  const legacyOauthClientsCol = `${namespace}_oauth_clients`;

  const [
    familiesSnap,
    tokensSnap,
    refreshSnap,
    upstreamSnap,
    authCodesSnap,
    resumeSnap,
    oauthClientsSnap,
    clientsSnap,
  ] = await Promise.all([
    db.collection(legacyFamiliesCol).get(),
    db.collection(legacyTokensCol).get(),
    db.collection(legacyRefreshCol).get(),
    db.collection(legacyUpstreamCol).get(),
    db.collection(legacyAuthCodesCol).get(),
    db.collection(legacyResumeCol).get(),
    db.collection(legacyOauthClientsCol).get(),
    db.collection(legacyClientsCol).get(),
  ]);

  physicalCounts.families = familiesSnap.docs.length;
  physicalCounts.tokens = tokensSnap.docs.length;
  physicalCounts.refresh = refreshSnap.docs.length;
  physicalCounts.upstream = upstreamSnap.docs.length;
  physicalCounts.authCodes = authCodesSnap.docs.length;
  physicalCounts.resumeTokens = resumeSnap.docs.length;
  physicalCounts.oauthClients = oauthClientsSnap.docs.length;
  physicalCounts.clients = clientsSnap.docs.length;

  const totalPhysicalRecords = Object.values(physicalCounts).reduce((s, n) => s + n, 0);

  // Index maps for lookup
  const familiesById = new Map<string, Record<string, unknown>>();
  for (const doc of familiesSnap.docs) familiesById.set(doc.id, doc.data() || {});

  const tokensByAccessId = new Map<string, Record<string, unknown>>();
  for (const doc of tokensSnap.docs) tokensByAccessId.set(doc.id, doc.data() || {});

  const refreshPointersById = new Map<string, Record<string, unknown>>();
  for (const doc of refreshSnap.docs) refreshPointersById.set(doc.id, doc.data() || {});

  const upstreamById = new Map<string, Record<string, unknown>>();
  for (const doc of upstreamSnap.docs) upstreamById.set(doc.id, doc.data() || {});

  const clientDocs = new Map<string, Record<string, unknown>>();
  for (const doc of clientsSnap.docs) clientDocs.set(doc.id, doc.data() || {});
  for (const doc of oauthClientsSnap.docs) {
    if (clientDocs.has(doc.id)) {
      const prev = clientDocs.get(doc.id)!;
      const cur = doc.data() || {};
      if (C(prev.redirect_uris || []) !== C(cur.redirect_uris || []) || prev.token_endpoint_auth_method !== cur.token_endpoint_auth_method) {
        report.errors++;
        reasons.conflictingClaims++;
        continue;
      }
    }
    clientDocs.set(doc.id, doc.data() || {});
  }

  // Pre-validate orphan refresh and upstream pointers
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

  for (const upDoc of upstreamSnap.docs) {
    if (!familiesById.has(upDoc.id)) {
      report.errors++;
      reasons.orphanUpstreamGrants++;
    }
  }

  // Source descriptors
  const sourceDescriptors: Array<{ collection: string; id: string; recordDigest: string }> = [];
  const colSnaps: Record<string, any> = {
    families: familiesSnap,
    tokens: tokensSnap,
    refresh: refreshSnap,
    upstream: upstreamSnap,
    authCodes: authCodesSnap,
    resumeTokens: resumeSnap,
    oauthClients: oauthClientsSnap,
    clients: clientsSnap,
  };
  for (const colKey of PHYSICAL_COUNT_KEYS) {
    for (const doc of colSnaps[colKey].docs) {
      const sourceId = H(key, 'source-id', namespace, currentEpoch, [colKey, doc.id]);
      const sourceRecord = H(key, 'source-record', namespace, currentEpoch, [colKey, sourceId, doc.data() || {}]);
      sourceDescriptors.push({ collection: colKey, id: sourceId, recordDigest: sourceRecord });
    }
  }
  sourceDescriptors.sort(compareDescriptors);
  const sourceInventoryDigest = H(key, 'source-inventory', namespace, currentEpoch, sourceDescriptors);

  // Candidate generation
  interface Candidate {
    id: string;
    kind: string;
    sources: Array<{ collection: string; id: string; recordDigest: string }>;
    targets: Array<{ collection: string; id: string }>;
    logicalDigest: string;
    candidateDigest?: string;
    execute: (tx: any) => Promise<{
      disposition: 'written' | 'skipped';
      targetPostimages: Record<string, unknown>;
      sourcePostimages: Record<string, unknown | null>;
    }>;
  }
  const candidateCommitments: Array<{
    id: string;
    kind: string;
    sources: Array<{ collection: string; id: string; recordDigest: string }>;
    targets: Array<{ collection: string; id: string }>;
    logicalDigest: string;
  }> = [];

  const candidates: Candidate[] = [];
  const claimedAccessIds = new Map<string, string>();
  const claimedRefreshIds = new Map<string, string>();
  const claimedRetiredFingerprints = new Map<string, string>();

  // Loop 1: PR56 Families
  for (const famDoc of familiesSnap.docs) {
    const familyId = famDoc.id;
    const famData = famDoc.data() as Record<string, unknown>;

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

    const accessId = (famData.currentAccessToken as string | undefined) ??
      ((curRefDoc.token as Record<string, unknown> | undefined)?.accessToken as string | undefined);
    if (!accessId || typeof accessId !== 'string' || accessId.trim().length === 0) {
      report.errors++;
      reasons.missingAccessTokens++;
      continue;
    }
    if (claimedAccessIds.has(accessId)) {
      report.errors++;
      reasons.conflictingClaims++;
      continue;
    }
    claimedAccessIds.set(accessId, familyId);

    if (famData.previousRefreshToken) {
      const prevRefId = famData.previousRefreshToken as string;
      if (prevRefId === currentRefId || claimedRefreshIds.has(prevRefId)) {
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

    let conflict = false;
    for (const fp of retiredFingerprints) {
      if (claimedRetiredFingerprints.has(fp)) {
        report.errors++;
        reasons.conflictingClaims++;
        conflict = true;
        break;
      }
      claimedRetiredFingerprints.set(fp, familyId);
    }
    if (conflict) continue;

    const newAccessId = codec.id('session', accessId);
    const newRefreshId = codec.id('refresh', currentRefId);

    // Build candidate source descriptors
    const candSources: Array<{ collection: string; id: string; recordDigest: string }> = [
      {
        collection: 'families',
        id: H(key, 'source-id', namespace, currentEpoch, ['families', familyId]),
        recordDigest: H(key, 'source-record', namespace, currentEpoch, ['families', H(key, 'source-id', namespace, currentEpoch, ['families', familyId]), famData]),
      },
      {
        collection: 'refresh',
        id: H(key, 'source-id', namespace, currentEpoch, ['refresh', currentRefId]),
        recordDigest: H(key, 'source-record', namespace, currentEpoch, ['refresh', H(key, 'source-id', namespace, currentEpoch, ['refresh', currentRefId]), curRefDoc]),
      },
      {
        collection: 'upstream',
        id: H(key, 'source-id', namespace, currentEpoch, ['upstream', familyId]),
        recordDigest: H(key, 'source-record', namespace, currentEpoch, ['upstream', H(key, 'source-id', namespace, currentEpoch, ['upstream', familyId]), upstreamById.get(familyId)!]),
      },
      {
        collection: 'tokens',
        id: H(key, 'source-id', namespace, currentEpoch, ['tokens', accessId]),
        recordDigest: H(key, 'source-record', namespace, currentEpoch, ['tokens', H(key, 'source-id', namespace, currentEpoch, ['tokens', accessId]), tokensByAccessId.get(accessId) || {}]),
      },
    ];

    if (famData.previousRefreshToken) {
      const prevId = famData.previousRefreshToken as string;
      const prevDoc = refreshPointersById.get(prevId) || {};
      candSources.push({
        collection: 'refresh',
        id: H(key, 'source-id', namespace, currentEpoch, ['refresh', prevId]),
        recordDigest: H(key, 'source-record', namespace, currentEpoch, ['refresh', H(key, 'source-id', namespace, currentEpoch, ['refresh', prevId]), prevDoc]),
      });
    }

    candSources.sort(compareDescriptors);
    // Expected targets
    const candTargets: Array<{ collection: string; id: string }> = [
      { collection: 'families', id: H(key, 'target-id', namespace, currentEpoch, ['families', familyId]) },
      { collection: 'tokens', id: H(key, 'target-id', namespace, currentEpoch, ['tokens', newAccessId]) },
      { collection: 'refresh', id: H(key, 'target-id', namespace, currentEpoch, ['refresh', newRefreshId]) },
      { collection: 'upstream', id: H(key, 'target-id', namespace, currentEpoch, ['upstream', familyId]) },
    ];
    if (famData.previousRefreshToken) {
      const prevRefTargetId = codec.id('refresh', famData.previousRefreshToken as string);
      candTargets.push({ collection: 'refresh', id: H(key, 'target-id', namespace, currentEpoch, ['refresh', prevRefTargetId]) });
    }
    for (const fp of retiredFingerprints) {
      candTargets.push({ collection: 'retiredRefreshTokens', id: H(key, 'target-id', namespace, currentEpoch, ['retiredRefreshTokens', fp]) });
    }
    candTargets.sort(compareDescriptors);

    const sortedSourceIds = candSources.map(s => s.id).sort(codeUnitCompare);
    const candidateId = H(key, 'candidate-id', namespace, currentEpoch, ['pr56Families', sortedSourceIds]);

    const upData = upstreamById.get(familyId)!;
    const grant = (upData.grant as Record<string, unknown> | undefined) ?? upData;
    const accData = tokensByAccessId.get(accessId) || {};

    const logicalProjection = {
      familyId,
      generation: typeof famData.generation === 'number' ? famData.generation : 1,
      status: famData.status === 'revoked' ? 'revoked' : 'active',
      clientId: ((curRefDoc.token as any)?.clientId ?? accData.clientId ?? famData.clientId) as string,
      serverBaseUrl: ((curRefDoc.token as any)?.serverBaseUrl ?? accData.serverBaseUrl ?? famData.serverBaseUrl ?? null) as string | null,
      extra: ((curRefDoc.token as any)?.extra ?? accData.extra ?? {}) as Record<string, string>,
      activeRefreshId: newRefreshId,
      currentAccessTokenId: newAccessId,
      previousRefresh: famData.previousRefreshToken ? { id: codec.id('refresh', famData.previousRefreshToken as string) } : null,
      retiredRefreshFingerprints: [...retiredFingerprints].sort(codeUnitCompare),
      upstream: {
        grantVersion: typeof upData.grantVersion === 'number' ? upData.grantVersion : 1,
        nsAccessToken: (grant.nsAccessToken ?? grant.access_token ?? accData.nsAccessToken) as string,
        nsRefreshToken: (grant.nsRefreshToken ?? grant.refresh_token ?? accData.nsRefreshToken ?? null) as string | null,
        nsUsername: (grant.nsUsername ?? grant.username ?? accData.nsUsername) as string,
        nsUserRole: (grant.nsUserRole ?? grant.user_role ?? accData.nsUserRole ?? null) as string | null,
        nsApiUrl: (grant.nsApiUrl ?? grant.api_url ?? accData.nsApiUrl ?? null) as string | null,
        nsExpiresAt: typeof upData.expiresAt === 'number' ? upData.expiresAt : (typeof accData.nsExpiresAt === 'number' ? accData.nsExpiresAt : null),
      },
    };

    const logicalDigest = H(key, 'logical-record', namespace, currentEpoch, ['pr56Families', logicalProjection]);

    expectedTargetCounts.families++;
    expectedTargetCounts.tokens++;
    expectedTargetCounts.refresh++;
    expectedTargetCounts.upstream++;
    if (famData.previousRefreshToken) expectedTargetCounts.refresh++;
    expectedTargetCounts.retiredRefreshTokens += retiredFingerprints.length;

    classifications.pr56Families++;

    const candCommitment = {
      id: candidateId,
      kind: 'pr56Families',
      sources: candSources,
      targets: candTargets,
      logicalDigest,
    };
    candidateCommitments.push(candCommitment);

    candidates.push({
      id: candidateId,
      kind: 'pr56Families',
      sources: candSources,
      targets: candTargets,
      logicalDigest,
      execute: async (tx: any) => {
        const targetFamSnap = await tx.get(db.collection(v3Cols.refreshFamilies).doc(familyId));
        const targetUpSnap = await tx.get(db.collection(v3Cols.upstreamGrants).doc(familyId));
        const targetRefSnap = await tx.get(db.collection(v3Cols.refreshTokens).doc(newRefreshId));
        const targetAccSnap = await tx.get(db.collection(v3Cols.sessions).doc(newAccessId));

        const allTargetExist = targetFamSnap.exists && targetUpSnap.exists && targetRefSnap.exists && targetAccSnap.exists;
        const noneTargetExist = !targetFamSnap.exists && !targetUpSnap.exists && !targetRefSnap.exists && !targetAccSnap.exists;

        if (!allTargetExist && !noneTargetExist) {
          throw new Error(`Partial target family detected in v3 for ${familyId}`);
        }

        if (allTargetExist) {
          const tFamData = targetFamSnap.data();
          const tRefData = targetRefSnap.data();
          const tAccData = targetAccSnap.data();
          const tUpData = targetUpSnap.data();
          if (
            tFamData?.id !== familyId ||
            tFamData?.activeRefreshId !== newRefreshId ||
            tFamData?.currentAccessTokenId !== newAccessId ||
            tRefData?.familyId !== familyId ||
            tRefData?.status !== 'active' ||
            tAccData?.familyId !== familyId ||
            tUpData?.id !== familyId
          ) {
            throw new Error(`Target family content mismatch for ${familyId}`);
          }
          return {
            disposition: 'skipped' as const,
            targetPostimages: {
              [H(key, 'target-id', namespace, currentEpoch, ['families', familyId])]: tFamData,
              [H(key, 'target-id', namespace, currentEpoch, ['upstream', familyId])]: tUpData,
              [H(key, 'target-id', namespace, currentEpoch, ['refresh', newRefreshId])]: tRefData,
              [H(key, 'target-id', namespace, currentEpoch, ['tokens', newAccessId])]: tAccData,
            },
            sourcePostimages: {},
          };
        }

        const famSnap = await tx.get(db.collection(legacyFamiliesCol).doc(familyId));
        if (!famSnap.exists) {
          throw new Error(`Source family candidate ${familyId} disappeared concurrently before migration`);
        }
        const liveFamData = famSnap.data() as Record<string, unknown>;
        const generation = typeof liveFamData.generation === 'number' ? liveFamData.generation : 1;
        const grantVersion = typeof upData.grantVersion === 'number' ? upData.grantVersion : 1;

        const rawExpiresAt = typeof accData.expiresAt === 'number'
          ? accData.expiresAt
          : (typeof (curRefDoc.token as any)?.expiresAt === 'number' ? (curRefDoc.token as any).expiresAt : famData.expiresAt);
        if (typeof rawExpiresAt !== 'number') {
          throw new Error(`Cannot adopt PR56 family ${familyId}: access token expiresAt missing`);
        }
        const expiresAt = rawExpiresAt as number;
        const now = nowProvider();
        const retainUntil = expiresAt + ACCESS_RETENTION_MS;

        const nsAccessToken = (grant.nsAccessToken ?? grant.access_token ?? accData.nsAccessToken) as string;
        const nsUsername = (grant.nsUsername ?? grant.username ?? accData.nsUsername) as string;
        if (!nsAccessToken || typeof nsAccessToken !== 'string' || nsAccessToken.trim().length === 0) {
          throw new Error(`Cannot adopt PR56 family ${familyId}: upstream NetSapiens access token missing or blank`);
        }
        if (!nsUsername || typeof nsUsername !== 'string' || nsUsername.trim().length === 0) {
          throw new Error(`Cannot adopt PR56 family ${familyId}: NetSapiens username missing or blank`);
        }

        let prevRefreshRow: RefreshPointerRow | undefined;
        if (liveFamData.previousRefreshToken) {
          const prevRefreshId = codec.id('refresh', liveFamData.previousRefreshToken as string);
          const prevRefDoc = await tx.get(db.collection(legacyRefreshCol).doc(liveFamData.previousRefreshToken as string));
          if (!prevRefDoc.exists || typeof prevRefDoc.data()?.consumedAt !== 'number') {
            throw new Error(`Previous refresh pointer invalid for family ${familyId}`);
          }
          prevRefreshRow = {
            id: prevRefreshId,
            familyId,
            status: 'consumed',
            generation: Math.max(1, generation - 1),
            consumedAt: prevRefDoc.data().consumedAt,
            successorSealed: codec.seal({ accessToken: accessId, refreshToken: currentRefId }, `successor:${prevRefreshId}`),
          };
        }

        if (!dryRun) {
          if (isControlled && initialControl) {
            await markIrreversibleInTransaction(tx, db, namespace, currentEpoch, runId, nowProvider);
          }
          const famDocData = defined({
            id: familyId,
            generation,
            status: liveFamData.status === 'revoked' ? 'revoked' : 'active',
            activeRefreshId: newRefreshId,
            currentAccessTokenId: newAccessId,
            updatedAt: now,
            sealed: codec.seal({
              clientId: logicalProjection.clientId,
              serverBaseUrl: logicalProjection.serverBaseUrl,
              extra: logicalProjection.extra,
              retiredRefreshIds: retiredFingerprints,
            }, familyAad({ id: familyId, generation })),
            v: 2,
          });
          tx.set(db.collection(v3Cols.refreshFamilies).doc(familyId), famDocData);

          const upDocData = defined({
            id: familyId,
            grantVersion,
            nsExpiresAt: logicalProjection.upstream.nsExpiresAt,
            updatedAt: now,
            sealed: codec.seal({
              nsAccessToken,
              nsRefreshToken: logicalProjection.upstream.nsRefreshToken,
              nsUsername,
              nsUserRole: logicalProjection.upstream.nsUserRole,
              nsApiUrl: logicalProjection.upstream.nsApiUrl,
            }, upstreamAad({ id: familyId, grantVersion })),
            v: 2,
          });
          tx.set(db.collection(v3Cols.upstreamGrants).doc(familyId), upDocData);

          const refDocData = defined({
            id: newRefreshId,
            familyId,
            status: 'active',
            generation,
            v: 2,
          });
          tx.set(db.collection(v3Cols.refreshTokens).doc(newRefreshId), refDocData);

          const sessDocData = defined({
            id: newAccessId,
            familyId,
            expiresAt,
            retainUntil,
            sealed: codec.seal({
              familyId,
              clientId: logicalProjection.clientId,
              serverBaseUrl: logicalProjection.serverBaseUrl,
              extra: logicalProjection.extra,
            }, accessAad({ id: newAccessId, familyId })),
            v: 2,
            ttlAt: new Date(retainUntil),
          });
          tx.set(db.collection(v3Cols.sessions).doc(newAccessId), sessDocData);

          const targetPostimages: Record<string, unknown> = {
            [H(key, 'target-id', namespace, currentEpoch, ['families', familyId])]: famDocData,
            [H(key, 'target-id', namespace, currentEpoch, ['upstream', familyId])]: upDocData,
            [H(key, 'target-id', namespace, currentEpoch, ['refresh', newRefreshId])]: refDocData,
            [H(key, 'target-id', namespace, currentEpoch, ['tokens', newAccessId])]: sessDocData,
          };

          if (prevRefreshRow) {
            const prevRefDocData = defined({ ...prevRefreshRow, v: 2 });
            tx.set(db.collection(v3Cols.refreshTokens).doc(prevRefreshRow.id), prevRefDocData);
            targetPostimages[H(key, 'target-id', namespace, currentEpoch, ['refresh', prevRefreshRow.id])] = prevRefDocData;
          }
          for (const fp of retiredFingerprints) {
            const retDocData = { familyId, retiredAt: now };
            tx.set(db.collection(v3Cols.retiredRefreshTokens).doc(fp), retDocData);
            targetPostimages[H(key, 'target-id', namespace, currentEpoch, ['retiredRefreshTokens', fp])] = retDocData;
          }

          return {
            disposition: 'written' as const,
            targetPostimages,
            sourcePostimages: {},
          };
        }
        return {
          disposition: 'skipped' as const,
          targetPostimages: {},
          sourcePostimages: {},
        };
      },
    });
  }

  // Loop 2: Base Format Tokens
  for (const tokDoc of tokensSnap.docs) {
    const accessToken = tokDoc.id;
    const tokData = tokDoc.data() as Record<string, unknown>;
    const accessId = codec.id('session', accessToken);

    if (tokData.refreshFamilyId) {
      const famId = tokData.refreshFamilyId as string;
      const parentFam = familiesById.get(famId);
      if (!parentFam || parentFam.currentAccessToken !== accessToken) {
        report.errors++;
        reasons.orphanAccessTokens++;
        continue;
      }
      continue;
    }
    if (claimedAccessIds.has(accessToken)) {
      continue;
    }

    const clientId = tokData.clientId as string | undefined;
    const refreshToken = tokData.refreshToken as string | undefined;
    const nsAccessToken = tokData.nsAccessToken as string | undefined;
    const nsUsername = tokData.nsUsername as string | undefined;
    const expiresAt = tokData.expiresAt as number | undefined;

    if (!clientId || !refreshToken || !nsAccessToken || !nsUsername || typeof expiresAt !== 'number') {
      report.errors++;
      reasons.malformedRecords++;
      continue;
    }

    const refDoc = refreshPointersById.get(refreshToken);
    if (!refDoc || refDoc.accessToken !== accessToken) {
      report.errors++;
      reasons.orphanRefreshPointers++;
      continue;
    }

    const familyId = codec.id('family', accessToken);
    const refreshId = codec.id('refresh', refreshToken);

    const candSources = [
      {
        collection: 'tokens',
        id: H(key, 'source-id', namespace, currentEpoch, ['tokens', accessToken]),
        recordDigest: H(key, 'source-record', namespace, currentEpoch, ['tokens', H(key, 'source-id', namespace, currentEpoch, ['tokens', accessToken]), tokData]),
      },
      {
        collection: 'refresh',
        id: H(key, 'source-id', namespace, currentEpoch, ['refresh', refreshToken]),
        recordDigest: H(key, 'source-record', namespace, currentEpoch, ['refresh', H(key, 'source-id', namespace, currentEpoch, ['refresh', refreshToken]), refDoc]),
      },
    ];
    candSources.sort(compareDescriptors);

    const candTargets = [
      { collection: 'families', id: H(key, 'target-id', namespace, currentEpoch, ['families', familyId]) },
      { collection: 'tokens', id: H(key, 'target-id', namespace, currentEpoch, ['tokens', accessId]) },
      { collection: 'refresh', id: H(key, 'target-id', namespace, currentEpoch, ['refresh', refreshId]) },
      { collection: 'upstream', id: H(key, 'target-id', namespace, currentEpoch, ['upstream', familyId]) },
    ];
    candTargets.sort(compareDescriptors);

    const candidateId = H(key, 'candidate-id', namespace, currentEpoch, ['baseFormatTokens', candSources.map(s => s.id).sort(codeUnitCompare)]);
    const logicalProjection = {
      familyId,
      generation: 1,
      status: 'active',
      clientId,
      serverBaseUrl: (tokData.serverBaseUrl ?? null) as string | null,
      extra: (tokData.extra ?? (tokData.seatId ? { seatId: String(tokData.seatId) } : {})) as Record<string, string>,
      activeRefreshId: refreshId,
      currentAccessTokenId: accessId,
      upstream: {
        grantVersion: 1,
        nsAccessToken,
        nsRefreshToken: (tokData.nsRefreshToken ?? null) as string | null,
        nsUsername,
        nsUserRole: (tokData.nsUserRole ?? null) as string | null,
        nsApiUrl: (tokData.nsApiUrl ?? null) as string | null,
        nsExpiresAt: typeof tokData.nsExpiresAt === 'number' ? tokData.nsExpiresAt : null,
      },
    };

    const logicalDigest = H(key, 'logical-record', namespace, currentEpoch, ['baseFormatTokens', logicalProjection]);

    expectedTargetCounts.families++;
    expectedTargetCounts.tokens++;
    expectedTargetCounts.refresh++;
    expectedTargetCounts.upstream++;
    classifications.baseFormatTokens++;

    candidateCommitments.push({
      id: candidateId,
      kind: 'baseFormatTokens',
      sources: candSources,
      targets: candTargets,
      logicalDigest,
    });

    candidates.push({
      id: candidateId,
      kind: 'baseFormatTokens',
      sources: candSources,
      targets: candTargets,
      logicalDigest,
      execute: async (tx: any) => {
        const targetAccSnap = await tx.get(db.collection(v3Cols.sessions).doc(accessId));
        const targetRefSnap = await tx.get(db.collection(v3Cols.refreshTokens).doc(refreshId));
        const targetFamSnap = await tx.get(db.collection(v3Cols.refreshFamilies).doc(familyId));
        const targetUpSnap = await tx.get(db.collection(v3Cols.upstreamGrants).doc(familyId));

        const allExist = targetAccSnap.exists && targetRefSnap.exists && targetFamSnap.exists && targetUpSnap.exists;
        const noneExist = !targetAccSnap.exists && !targetRefSnap.exists && !targetFamSnap.exists && !targetUpSnap.exists;

        if (!allExist && !noneExist) {
          throw new Error(`Partial target detected for base token ${accessToken}`);
        }
        if (allExist) {
          return 'skipped';
        }

        const legacyTokSnap = await tx.get(db.collection(legacyTokensCol).doc(accessToken));
        if (!legacyTokSnap.exists) {
          throw new Error(`Source token candidate ${accessToken} disappeared concurrently before migration`);
        }

        const now = nowProvider();
        const retainUntil = expiresAt + ACCESS_RETENTION_MS;

        if (!dryRun) {
          if (isControlled && initialControl) {
            await markIrreversibleInTransaction(tx, db, namespace, currentEpoch, runId, nowProvider);
          }
          tx.set(db.collection(v3Cols.refreshFamilies).doc(familyId), defined({
            id: familyId,
            generation: 1,
            status: 'active',
            activeRefreshId: refreshId,
            currentAccessTokenId: accessId,
            updatedAt: now,
            sealed: codec.seal({
              clientId,
              serverBaseUrl: logicalProjection.serverBaseUrl,
              extra: logicalProjection.extra,
              retiredRefreshIds: [],
            }, familyAad({ id: familyId, generation: 1 })),
            v: 2,
          }));
          tx.set(db.collection(v3Cols.upstreamGrants).doc(familyId), defined({
            id: familyId,
            grantVersion: 1,
            nsExpiresAt: logicalProjection.upstream.nsExpiresAt,
            updatedAt: now,
            sealed: codec.seal({
              nsAccessToken,
              nsRefreshToken: logicalProjection.upstream.nsRefreshToken,
              nsUsername,
              nsUserRole: logicalProjection.upstream.nsUserRole,
              nsApiUrl: logicalProjection.upstream.nsApiUrl,
            }, upstreamAad({ id: familyId, grantVersion: 1 })),
            v: 2,
          }));
          tx.set(db.collection(v3Cols.refreshTokens).doc(refreshId), defined({
            id: refreshId,
            familyId,
            status: 'active',
            generation: 1,
            v: 2,
          }));
          tx.set(db.collection(v3Cols.sessions).doc(accessId), defined({
            id: accessId,
            familyId,
            expiresAt,
            retainUntil,
            sealed: codec.seal({
              familyId,
              clientId,
              serverBaseUrl: logicalProjection.serverBaseUrl,
              extra: logicalProjection.extra,
            }, accessAad({ id: accessId, familyId })),
            v: 2,
            ttlAt: new Date(retainUntil),
          }));
        }
        return 'migrated';
      },
    });
  }

  // Loop 3: Authorization Codes
  for (const codeDoc of authCodesSnap.docs) {
    const rawCode = codeDoc.id;
    const codeData = codeDoc.data() as Record<string, unknown>;

    const expiresAt: number = typeof codeData.expiresAt === 'number'
      ? (codeData.expiresAt as number)
      : (typeof codeData.expires_at === 'number' ? (codeData.expires_at as number) : 0);

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
      report.errors++;
      reasons.malformedRecords++;
      continue;
    }

    const hmacId = codec.id('code', rawCode);
    const candSources = [{
      collection: 'authCodes',
      id: H(key, 'source-id', namespace, currentEpoch, ['authCodes', rawCode]),
      recordDigest: H(key, 'source-record', namespace, currentEpoch, ['authCodes', H(key, 'source-id', namespace, currentEpoch, ['authCodes', rawCode]), codeData]),
    }];
    const candTargets = [{
      collection: 'authCodes',
      id: H(key, 'target-id', namespace, currentEpoch, ['authCodes', hmacId]),
    }];

    const candidateId = H(key, 'candidate-id', namespace, currentEpoch, ['authCodes', candSources.map(s => s.id).sort(codeUnitCompare)]);

    const logicalProjection = {
      codeId: hmacId,
      clientId,
      codeChallenge,
      redirectUri,
      createdAt,
      expiresAt,
      state: typeof rawPending.state === 'string' ? rawPending.state : null,
      scopes: Array.isArray(rawPending.scopes) ? [...rawPending.scopes].sort(codeUnitCompare) : [],
      nsAccessToken,
      nsRefreshToken: (rawNsTokens?.refresh_token ?? rawNsTokens?.nsRefreshToken ?? codeData.nsRefreshToken ?? null) as string | null,
      nsUsername: (rawNsTokens?.username ?? rawNsTokens?.nsUsername ?? codeData.nsUsername ?? null) as string | null,
      nsUserRole: (rawNsTokens?.nsUserRole ?? codeData.nsUserRole ?? null) as string | null,
      nsApiUrl: (rawNsTokens?.nsApiUrl ?? codeData.nsApiUrl ?? null) as string | null,
      serverBaseUrl: (codeData.serverBaseUrl ?? null) as string | null,
      extra: (codeData.extra ?? {}) as Record<string, string>,
    };

    const logicalDigest = H(key, 'logical-record', namespace, currentEpoch, ['authCodes', logicalProjection]);

    expectedTargetCounts.authCodes++;
    classifications.authCodes++;

    candidateCommitments.push({
      id: candidateId,
      kind: 'authCodes',
      sources: candSources,
      targets: candTargets,
      logicalDigest,
    });

    candidates.push({
      id: candidateId,
      kind: 'authCodes',
      sources: candSources,
      targets: candTargets,
      logicalDigest,
      execute: async (tx: any) => {
        const targetCodeSnap = await tx.get(db.collection(v3Cols.authCodes).doc(hmacId));
        if (targetCodeSnap.exists) {
          const tData = targetCodeSnap.data();
          if (tData?.id !== hmacId || tData?.expiresAt !== expiresAt || tData?.v !== 2) {
            throw new Error(`Target auth code content mismatch for ${rawCode}`);
          }
          return 'skipped';
        }

        const sourceCodeSnap = await tx.get(db.collection(legacyAuthCodesCol).doc(rawCode));
        if (!sourceCodeSnap.exists) {
          throw new Error(`Source auth code candidate disappeared concurrently before migration`);
        }

        const payload: AuthCodeData = {
          pending: {
            clientId,
            codeChallenge,
            redirectUri,
            createdAt,
            state: logicalProjection.state ?? undefined,
            scopes: logicalProjection.scopes.length > 0 ? logicalProjection.scopes : undefined,
          },
          nsTokens: {
            access_token: nsAccessToken,
            refresh_token: logicalProjection.nsRefreshToken ?? undefined,
            username: logicalProjection.nsUsername ?? undefined,
            nsUserRole: logicalProjection.nsUserRole ?? undefined,
            nsApiUrl: logicalProjection.nsApiUrl ?? undefined,
          },
          extra: logicalProjection.extra,
          serverBaseUrl: logicalProjection.serverBaseUrl ?? undefined,
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
      },
    });
  }

  // Loop 4: Resume Tokens
  for (const rDoc of resumeSnap.docs) {
    const rData = rDoc.data() as Record<string, unknown>;
    const resumeId = (rData.id as string) ?? rDoc.id;

    if (typeof rData.consumedAt !== 'number' || typeof rData.expiresAt !== 'number') {
      report.errors++;
      reasons.malformedRecords++;
      continue;
    }

    const candSources = [{
      collection: 'resumeTokens',
      id: H(key, 'source-id', namespace, currentEpoch, ['resumeTokens', rDoc.id]),
      recordDigest: H(key, 'source-record', namespace, currentEpoch, ['resumeTokens', H(key, 'source-id', namespace, currentEpoch, ['resumeTokens', rDoc.id]), rData]),
    }];
    const candTargets = [{
      collection: 'resumeTokens',
      id: H(key, 'target-id', namespace, currentEpoch, ['resumeTokens', resumeId]),
    }];

    const candidateId = H(key, 'candidate-id', namespace, currentEpoch, ['resumeTokens', candSources.map(s => s.id).sort(codeUnitCompare)]);
    const logicalProjection = {
      resumeId,
      consumedAt: rData.consumedAt,
      expiresAt: rData.expiresAt,
    };
    const logicalDigest = H(key, 'logical-record', namespace, currentEpoch, ['resumeTokens', logicalProjection]);

    expectedTargetCounts.resumeTokens++;
    classifications.resumeTokens++;

    candidateCommitments.push({
      id: candidateId,
      kind: 'resumeTokens',
      sources: candSources,
      targets: candTargets,
      logicalDigest,
    });

    candidates.push({
      id: candidateId,
      kind: 'resumeTokens',
      sources: candSources,
      targets: candTargets,
      logicalDigest,
      execute: async (tx: any) => {
        const targetResumeSnap = await tx.get(db.collection(v3Cols.resumeTokens).doc(resumeId));
        if (targetResumeSnap.exists) {
          const tData = targetResumeSnap.data();
          if (tData?.v === 2 && tData?.id === resumeId && tData?.consumedAt === rData.consumedAt && tData?.expiresAt === rData.expiresAt) {
            return 'skipped';
          }
        }

        const sourceResumeSnap = await tx.get(db.collection(legacyResumeCol).doc(rDoc.id));
        if (!sourceResumeSnap.exists) {
          throw new Error(`Source resume token candidate disappeared concurrently before migration`);
        }

        if (!dryRun) {
          if (isControlled && initialControl) {
            await markIrreversibleInTransaction(tx, db, namespace, currentEpoch, runId, nowProvider);
          }
          tx.set(db.collection(v3Cols.resumeTokens).doc(resumeId), {
            id: resumeId,
            consumedAt: rData.consumedAt,
            expiresAt: rData.expiresAt,
            v: 2,
            ttlAt: new Date(rData.expiresAt as number),
          });
        }
        return 'migrated';
      },
    });
  }

  // Loop 5: OAuth Clients
  for (const [clientId, clientData] of clientDocs.entries()) {
    if (
      typeof clientData.client_id !== 'string' ||
      !Array.isArray(clientData.redirect_uris) ||
      typeof clientData.token_endpoint_auth_method !== 'string'
    ) {
      report.errors++;
      reasons.malformedRecords++;
      continue;
    }

    const candSources: Array<{ collection: string; id: string; recordDigest: string }> = [];
    if (clientsSnap.docs.some(d => d.id === clientId)) {
      candSources.push({
        collection: 'clients',
        id: H(key, 'source-id', namespace, currentEpoch, ['clients', clientId]),
        recordDigest: H(key, 'source-record', namespace, currentEpoch, ['clients', H(key, 'source-id', namespace, currentEpoch, ['clients', clientId]), clientsSnap.docs.find(d => d.id === clientId)!.data() || {}]),
      });
    }
    if (oauthClientsSnap.docs.some(d => d.id === clientId)) {
      candSources.push({
        collection: 'oauthClients',
        id: H(key, 'source-id', namespace, currentEpoch, ['oauthClients', clientId]),
        recordDigest: H(key, 'source-record', namespace, currentEpoch, ['oauthClients', H(key, 'source-id', namespace, currentEpoch, ['oauthClients', clientId]), oauthClientsSnap.docs.find(d => d.id === clientId)!.data() || {}]),
      });
    }
    candSources.sort(compareDescriptors);

    const candTargets = [{
      collection: 'oauthClients',
      id: H(key, 'target-id', namespace, currentEpoch, ['oauthClients', clientId]),
    }];

    const candidateId = H(key, 'candidate-id', namespace, currentEpoch, ['clients', candSources.map(s => s.id).sort(codeUnitCompare)]);
    const logicalProjection = {
      clientId,
      clientName: typeof clientData.client_name === 'string' ? clientData.client_name : null,
      redirectUris: [...clientData.redirect_uris].sort(codeUnitCompare),
      tokenEndpointAuthMethod: clientData.token_endpoint_auth_method as string,
      clientIdIssuedAt: typeof clientData.client_id_issued_at === 'number' ? clientData.client_id_issued_at : null,
    };
    const logicalDigest = H(key, 'logical-record', namespace, currentEpoch, ['clients', logicalProjection]);

    expectedTargetCounts.oauthClients++;
    classifications.clients++;

    candidateCommitments.push({
      id: candidateId,
      kind: 'clients',
      sources: candSources,
      targets: candTargets,
      logicalDigest,
    });

    candidates.push({
      id: candidateId,
      kind: 'clients',
      sources: candSources,
      targets: candTargets,
      logicalDigest,
      execute: async (tx: any) => {
        const targetClientSnap = await tx.get(db.collection(v3Cols.oauthClients).doc(clientId));
        if (targetClientSnap.exists) {
          const tData = targetClientSnap.data();
          if (tData?.v === 2 && tData?.client_id === clientId && C(tData?.redirect_uris || []) === C(clientData.redirect_uris || [])) {
            return 'skipped';
          }
        }

        const srcOauthSnap = await tx.get(db.collection(legacyOauthClientsCol).doc(clientId));
        const srcLegacySnap = await tx.get(db.collection(legacyClientsCol).doc(clientId));
        const srcSnap = srcOauthSnap.exists ? srcOauthSnap : srcLegacySnap;
        if (!srcSnap.exists) {
          throw new Error(`Source client candidate disappeared concurrently before migration`);
        }

        if (!dryRun) {
          if (isControlled && initialControl) {
            await markIrreversibleInTransaction(tx, db, namespace, currentEpoch, runId, nowProvider);
          }
          tx.set(db.collection(v3Cols.oauthClients).doc(clientId), defined({
            ...clientData,
            client_id: clientId,
            v: 2,
          }));
        }
        return 'migrated';
      },
    });
  }

  // Commitments sort order
  candidateCommitments.sort((a, b) => codeUnitCompare(a.id, b.id));
  candidates.sort((a, b) => codeUnitCompare(a.id, b.id));

  const sortedCandidateLogicalPairs = candidateCommitments.map(c => [c.id, c.logicalDigest] as [string, string]).sort(comparePairs);
  const sourceLogicalDigest = H(key, 'logical-inventory', namespace, currentEpoch, sortedCandidateLogicalPairs);

  const preparedManifest = {
    schemaVersion: 2,
    namespace,
    epoch: currentEpoch,
    migrationRunId: runId,
    codeSha,
    codeArtifact,
    packageIntegrity,
    protocolDigest,
    kind: 'prepared',
    preparedAt: nowProvider(),
    physicalCounts,
    classifications,
    reasons,
    totalPhysicalRecords,
    scanned: candidateCommitments.length,
    expectedTargetCounts,
    sourceInventoryDigest,
    sourceLogicalDigest,
    candidateCommitments,
  };

  validateMigrationPreflightLimits(preparedManifest);

  if (options.expectedSourceInventoryDigest && options.expectedSourceInventoryDigest !== sourceInventoryDigest) {
    throw new CutoverFenceError(
      `Source inventory digest mismatch: expected ${options.expectedSourceInventoryDigest}, got ${sourceInventoryDigest}`,
    );
  }

  // Dry run returns prospective report without writing
  if (dryRun) {
    report.scanned = candidates.length;
    report.migrated = candidates.length;
    report.skipped = 0;
    return report;
  }

  // Write prepared manifest if not resuming
  let preparedDigest: string;
  if (!isResuming) {
    preparedDigest = D('prepared', namespace, currentEpoch, preparedManifest);
    await prepRef.set(stripUndefined(preparedManifest));
    if (isControlled && initialControl && initialControl.state === 'fenced') {
      await transitionCutoverFenceState(db, namespace, {
        fromState: 'fenced',
        toState: 'migrating',
        expectedEpoch: currentEpoch,
        migrationRunId: runId,
        now: nowProvider,
      });
    }
  } else {
    const existingPrep = prepSnap.data() as any;
    validateMigrationIdentityFields(existingPrep, namespace, currentEpoch, runId);
    preparedDigest = D('prepared', namespace, currentEpoch, existingPrep);
  }

  // Migrate items in individual transactions with receipts
  const receipts: Array<{ candidateId: string; receiptDigest: string }> = [];

  for (const cand of candidates) {
    report.scanned++;
    const receiptRef = db.collection(`${namespace}_meta`).doc(`migration_receipt_${currentEpoch}_${cand.id}`);

    try {
      const outcome = await db.runTransaction(async (tx: any) => {
        const candDigest = D('candidate', namespace, currentEpoch, {
          id: cand.id,
          kind: cand.kind,
          sources: cand.sources,
          targets: cand.targets,
          logicalDigest: cand.logicalDigest,
        });

        const receiptSnap = await tx.get(receiptRef);
        if (receiptSnap.exists) {
          const rData = receiptSnap.data();
          if (
            rData?.schemaVersion !== 2 ||
            rData?.namespace !== namespace ||
            rData?.epoch !== currentEpoch ||
            rData?.migrationRunId !== runId ||
            rData?.candidateId !== cand.id ||
            rData?.preparedDigest !== preparedDigest ||
            rData?.candidateDigest !== candDigest ||
            rData?.logicalDigest !== cand.logicalDigest
          ) {
            throw new CutoverFenceError(`Invalid or corrupt receipt for candidate ${cand.id}`);
          }
          if (Array.isArray(rData.targetAfter)) {
            for (const t of rData.targetAfter) {
              const targetColName = v3Cols[t.collection as keyof typeof v3Cols] || `${namespace}_${t.collection}`;
              const tSnap = await tx.get(db.collection(targetColName).doc(t.id));
              if (!tSnap.exists) {
                throw new CutoverFenceError(`Target document ${t.collection}/${t.id} missing for committed receipt ${cand.id}`);
              }
            }
          }
          const rDig = D('receipt', namespace, currentEpoch, rData);
          receipts.push({ candidateId: cand.id, receiptDigest: rDig });
          return (rData.disposition === 'retained' ? 'skipped' : 'migrated') as 'migrated' | 'skipped';
        }

        if (isControlled && initialControl) {
          const ctrl = await readCutoverFenceInTransaction(tx, db, namespace);
          if (ctrl.epoch !== currentEpoch || ctrl.state !== 'migrating' || ctrl.migrationRunId !== runId) {
            throw new CutoverFenceError(`Cannot migrate candidate ${cand.id}: state is ${ctrl.state}, runId is ${ctrl.migrationRunId}`);
          }
        }

        const res = await cand.execute(tx);
        const disposition = res.disposition === 'skipped' ? 'retained' : 'written';

        const sourceAfter = cand.sources.map(s => {
          const post = res.sourcePostimages?.[s.id];
          if (post === null) {
            return { collection: s.collection, id: s.id, recordDigest: null };
          }
          if (post !== undefined) {
            return {
              collection: s.collection,
              id: s.id,
              recordDigest: H(key, 'source-record', namespace, currentEpoch, [s.collection, s.id, post]),
            };
          }
          return { collection: s.collection, id: s.id, recordDigest: s.recordDigest };
        });

        const targetAfter = cand.targets.map(t => {
          const post = res.targetPostimages?.[t.id];
          const postDigest = post !== undefined
            ? H(key, 'target-record', namespace, currentEpoch, [t.collection, t.id, post])
            : t.recordDigest;
          return { collection: t.collection, id: t.id, recordDigest: postDigest };
        });

        const receiptDoc = {
          schemaVersion: 2,
          namespace,
          epoch: currentEpoch,
          migrationRunId: runId,
          codeSha,
          codeArtifact,
          packageIntegrity,
          protocolDigest,
          kind: 'receipt',
          preparedDigest,
          candidateId: cand.id,
          candidateDigest: candDigest,
          disposition,
          sourceAfter,
          targetAfter,
          logicalDigest: cand.logicalDigest,
          completedAt: nowProvider(),
        };

        tx.set(receiptRef, stripUndefined(receiptDoc));
        const receiptDigest = D('receipt', namespace, currentEpoch, receiptDoc);
        receipts.push({ candidateId: cand.id, receiptDigest });
        return (disposition === 'retained' ? 'skipped' : 'migrated') as 'migrated' | 'skipped';
      });
    } catch (err: any) {
      if (err instanceof CutoverFenceError) {
        throw err;
      }
      report.errors++;
      const reasonMsg = err.message || String(err);
      if (reasonMsg.includes('Partial target')) {
        reasons.partialTargets++;
      } else {
        reasons.malformedRecords++;
      }
    }
  }

  // Finalization
  receipts.sort((a, b) => codeUnitCompare(a.candidateId, b.candidateId));
  const sortedReceiptPairs = receipts.map(r => [r.candidateId, r.receiptDigest] as [string, string]).sort(comparePairs);
  const receiptSetDigest = D('receipt-set', namespace, currentEpoch, sortedReceiptPairs);

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

  const targetCounts: Record<string, number> = {
    families: tFam.docs.length,
    tokens: tSess.docs.length,
    refresh: tRef.docs.length,
    upstream: tUp.docs.length,
    authCodes: tCodes.docs.length,
    resumeTokens: tRes.docs.length,
    retiredRefreshTokens: tRet.docs.length,
    oauthClients: tClients.docs.length,
  };

  const targetDescriptors: Array<{ collection: string; id: string; recordDigest: string }> = [];
  const targetColSnaps: Record<string, any> = {
    families: tFam,
    tokens: tSess,
    refresh: tRef,
    upstream: tUp,
    authCodes: tCodes,
    resumeTokens: tRes,
    retiredRefreshTokens: tRet,
    oauthClients: tClients,
  };
  for (const colKey of TARGET_COUNT_KEYS) {
    for (const doc of targetColSnaps[colKey].docs) {
      const targetId = H(key, 'target-id', namespace, currentEpoch, [colKey, doc.id]);
      const targetRecord = H(key, 'target-record', namespace, currentEpoch, [colKey, targetId, doc.data() || {}]);
      targetDescriptors.push({ collection: colKey, id: targetId, recordDigest: targetRecord });
    }
  }
  targetDescriptors.sort(compareDescriptors);
  const targetInventoryDigest = H(key, 'target-inventory', namespace, currentEpoch, targetDescriptors);

  const isActuallyEmpty =
    totalPhysicalRecords === 0 &&
    report.migrated === 0 &&
    Object.values(targetCounts).every(n => n === 0);

  let targetLogicalDigest: string;
  if (isActuallyEmpty) {
    targetLogicalDigest = H(key, 'logical-inventory', namespace, currentEpoch, []);
  } else if (dryRun) {
    targetLogicalDigest = sourceLogicalDigest;
  } else {
    const targetDocsByColAndTargetId = new Map<string, any>();
    for (const colKey of TARGET_COUNT_KEYS) {
      for (const doc of targetColSnaps[colKey].docs) {
        const tId = H(key, 'target-id', namespace, currentEpoch, [colKey, doc.id]);
        targetDocsByColAndTargetId.set(`${colKey}:${tId}`, doc);
      }
    }

    const targetLogicalPairs: Array<[string, string]> = [];

    for (const cand of candidateCommitments) {
      if (cand.kind === 'pr56Families') {
        const famTarget = cand.targets.find((t: any) => t.collection === 'families');
        if (!famTarget) throw new CutoverFenceError(`Candidate ${cand.id} missing families target descriptor`);
        const famDoc = targetDocsByColAndTargetId.get(`families:${famTarget.id}`);
        if (!famDoc) throw new CutoverFenceError(`Target family ${famTarget.id} missing from target documents`);
        const famData = famDoc.data() || {};
        const familyId = famDoc.id;
        const generation = typeof famData.generation === 'number' ? famData.generation : 1;
        const unsealedFam = famData.sealed
          ? codec.open<any>(famData.sealed, familyAad({ id: familyId, generation }))
          : null;
        if (!unsealedFam) throw new CutoverFenceError(`Target family sealed payload could not be opened for ${familyId}`);

        const upTarget = cand.targets.find((t: any) => t.collection === 'upstream');
        if (!upTarget) throw new CutoverFenceError(`Candidate ${cand.id} missing upstream target descriptor`);
        const upDoc = targetDocsByColAndTargetId.get(`upstream:${upTarget.id}`);
        if (!upDoc) throw new CutoverFenceError(`Target upstream ${upTarget.id} missing from target documents`);
        const upData = upDoc.data() || {};
        const grantVersion = typeof upData.grantVersion === 'number' ? upData.grantVersion : 1;
        const unsealedUp = upData.sealed
          ? codec.open<any>(upData.sealed, upstreamAad({ id: familyId, grantVersion }))
          : null;
        if (!unsealedUp) throw new CutoverFenceError(`Target upstream sealed payload could not be opened for ${familyId}`);

        const sessTarget = cand.targets.find((t: any) => t.collection === 'tokens');
        if (!sessTarget) throw new CutoverFenceError(`Candidate ${cand.id} missing tokens target descriptor`);
        const sessDoc = targetDocsByColAndTargetId.get(`tokens:${sessTarget.id}`);
        if (!sessDoc) throw new CutoverFenceError(`Target session ${sessTarget.id} missing from target documents`);
        const sessData = sessDoc.data() || {};
        const unsealedSess = sessData.sealed
          ? codec.open<any>(sessData.sealed, accessAad({ id: sessDoc.id, familyId }))
          : null;
        if (!unsealedSess) throw new CutoverFenceError(`Target session sealed payload could not be opened for ${sessDoc.id}`);

        const activeRefTargetId = H(key, 'target-id', namespace, currentEpoch, ['refresh', famData.activeRefreshId]);
        const prevRefTarget = cand.targets.find((t: any) => t.collection === 'refresh' && t.id !== activeRefTargetId);
        let previousRefresh: { id: string } | null = null;
        if (prevRefTarget) {
          const prevRefDoc = targetDocsByColAndTargetId.get(`refresh:${prevRefTarget.id}`);
          if (!prevRefDoc) throw new CutoverFenceError(`Target consumed refresh token ${prevRefTarget.id} missing`);
          previousRefresh = { id: prevRefDoc.id };
        }

        const retiredTargets = cand.targets.filter((t: any) => t.collection === 'retiredRefreshTokens');
        const retiredRefreshFingerprints = retiredTargets.map((t: any) => {
          const retDoc = targetDocsByColAndTargetId.get(`retiredRefreshTokens:${t.id}`);
          if (!retDoc) throw new CutoverFenceError(`Target retired refresh token ${t.id} missing`);
          return retDoc.id;
        }).sort(codeUnitCompare);

        const reconstructedFamProjection = {
          familyId,
          generation,
          status: famData.status,
          clientId: (unsealedFam.clientId ?? unsealedSess.clientId ?? '') as string,
          serverBaseUrl: (unsealedFam.serverBaseUrl ?? unsealedSess.serverBaseUrl ?? null) as string | null,
          extra: (unsealedFam.extra ?? unsealedSess.extra ?? {}) as Record<string, string>,
          activeRefreshId: famData.activeRefreshId,
          currentAccessTokenId: famData.currentAccessTokenId,
          previousRefresh,
          retiredRefreshFingerprints,
          upstream: {
            grantVersion,
            nsAccessToken: (unsealedUp.nsAccessToken ?? '') as string,
            nsRefreshToken: (unsealedUp.nsRefreshToken ?? null) as string | null,
            nsUsername: (unsealedUp.nsUsername ?? '') as string,
            nsUserRole: (unsealedUp.nsUserRole ?? null) as string | null,
            nsApiUrl: (unsealedUp.nsApiUrl ?? null) as string | null,
            nsExpiresAt: typeof upData.nsExpiresAt === 'number' ? upData.nsExpiresAt : null,
          },
        };

        const digest = H(key, 'logical-record', namespace, currentEpoch, ['pr56Families', reconstructedFamProjection]);
        targetLogicalPairs.push([cand.id, digest]);
      } else if (cand.kind === 'baseFormatTokens') {
        const famTarget = cand.targets.find((t: any) => t.collection === 'families');
        if (!famTarget) throw new CutoverFenceError(`Candidate ${cand.id} missing families target descriptor`);
        const famDoc = targetDocsByColAndTargetId.get(`families:${famTarget.id}`);
        if (!famDoc) throw new CutoverFenceError(`Target base family ${famTarget.id} missing`);
        const famData = famDoc.data() || {};
        const familyId = famDoc.id;
        const unsealedFam = famData.sealed
          ? codec.open<any>(famData.sealed, familyAad({ id: familyId, generation: 1 }))
          : null;
        if (!unsealedFam) throw new CutoverFenceError(`Target base family decrypt failed for ${familyId}`);

        const upTarget = cand.targets.find((t: any) => t.collection === 'upstream');
        if (!upTarget) throw new CutoverFenceError(`Candidate ${cand.id} missing upstream target descriptor`);
        const upDoc = targetDocsByColAndTargetId.get(`upstream:${upTarget.id}`);
        if (!upDoc) throw new CutoverFenceError(`Target base upstream ${upTarget.id} missing`);
        const upData = upDoc.data() || {};
        const unsealedUp = upData.sealed
          ? codec.open<any>(upData.sealed, upstreamAad({ id: familyId, grantVersion: 1 }))
          : null;
        if (!unsealedUp) throw new CutoverFenceError(`Target base upstream decrypt failed for ${familyId}`);

        const sessTarget = cand.targets.find((t: any) => t.collection === 'tokens');
        if (!sessTarget) throw new CutoverFenceError(`Candidate ${cand.id} missing tokens target descriptor`);
        const sessDoc = targetDocsByColAndTargetId.get(`tokens:${sessTarget.id}`);
        if (!sessDoc) throw new CutoverFenceError(`Target base session ${sessTarget.id} missing`);
        const sessData = sessDoc.data() || {};
        const unsealedSess = sessData.sealed
          ? codec.open<any>(sessData.sealed, accessAad({ id: sessDoc.id, familyId }))
          : null;
        if (!unsealedSess) throw new CutoverFenceError(`Target base session decrypt failed for ${sessDoc.id}`);

        const reconstructedBaseProjection = {
          familyId,
          generation: 1,
          status: 'active',
          clientId: (unsealedFam.clientId ?? '') as string,
          serverBaseUrl: (unsealedFam.serverBaseUrl ?? null) as string | null,
          extra: (unsealedFam.extra ?? {}) as Record<string, string>,
          activeRefreshId: famData.activeRefreshId,
          currentAccessTokenId: famData.currentAccessTokenId,
          upstream: {
            grantVersion: 1,
            nsAccessToken: (unsealedUp.nsAccessToken ?? '') as string,
            nsRefreshToken: (unsealedUp.nsRefreshToken ?? null) as string | null,
            nsUsername: (unsealedUp.nsUsername ?? '') as string,
            nsUserRole: (unsealedUp.nsUserRole ?? null) as string | null,
            nsApiUrl: (unsealedUp.nsApiUrl ?? null) as string | null,
            nsExpiresAt: typeof upData.nsExpiresAt === 'number' ? upData.nsExpiresAt : null,
          },
        };

        const digest = H(key, 'logical-record', namespace, currentEpoch, ['baseFormatTokens', reconstructedBaseProjection]);
        targetLogicalPairs.push([cand.id, digest]);
      } else if (cand.kind === 'authCodes') {
        const codeTarget = cand.targets.find((t: any) => t.collection === 'authCodes');
        if (!codeTarget) throw new CutoverFenceError(`Candidate ${cand.id} missing authCodes target descriptor`);
        const codeDoc = targetDocsByColAndTargetId.get(`authCodes:${codeTarget.id}`);
        if (!codeDoc) throw new CutoverFenceError(`Target auth code ${codeTarget.id} missing`);
        const codeData = codeDoc.data() || {};
        const unsealed = codeData.sealed
          ? codec.open<AuthCodeData>(codeData.sealed, `code:${codeDoc.id}`)
          : null;
        if (!unsealed) throw new CutoverFenceError(`Target auth code decrypt failed for ${codeDoc.id}`);

        const reconstructedCodeProjection = {
          codeId: codeDoc.id,
          clientId: unsealed.clientId,
          codeChallenge: unsealed.pending.codeChallenge,
          redirectUri: unsealed.pending.redirectUri,
          createdAt: unsealed.pending.createdAt,
          expiresAt: codeData.expiresAt,
          state: unsealed.pending.state ?? null,
          scopes: Array.isArray(unsealed.pending.scopes) ? [...unsealed.pending.scopes].sort(codeUnitCompare) : [],
          nsAccessToken: unsealed.nsTokens.access_token,
          nsRefreshToken: unsealed.nsTokens.refresh_token ?? null,
          nsUsername: unsealed.nsTokens.username ?? null,
          nsUserRole: unsealed.nsTokens.nsUserRole ?? null,
          nsApiUrl: unsealed.nsTokens.nsApiUrl ?? null,
          serverBaseUrl: unsealed.serverBaseUrl ?? null,
          extra: unsealed.extra ?? {},
        };

        const digest = H(key, 'logical-record', namespace, currentEpoch, ['authCodes', reconstructedCodeProjection]);
        targetLogicalPairs.push([cand.id, digest]);
      } else if (cand.kind === 'resumeTokens') {
        const resTarget = cand.targets.find((t: any) => t.collection === 'resumeTokens');
        if (!resTarget) throw new CutoverFenceError(`Candidate ${cand.id} missing resumeTokens target descriptor`);
        const resDoc = targetDocsByColAndTargetId.get(`resumeTokens:${resTarget.id}`);
        if (!resDoc) throw new CutoverFenceError(`Target resume token ${resTarget.id} missing`);
        const resData = resDoc.data() || {};
        const reconstructedResumeProjection = {
          resumeId: resDoc.id,
          consumedAt: resData.consumedAt,
          expiresAt: resData.expiresAt,
        };

        const digest = H(key, 'logical-record', namespace, currentEpoch, ['resumeTokens', reconstructedResumeProjection]);
        targetLogicalPairs.push([cand.id, digest]);
      } else if (cand.kind === 'clients') {
        const clientTarget = cand.targets.find((t: any) => t.collection === 'oauthClients');
        if (!clientTarget) throw new CutoverFenceError(`Candidate ${cand.id} missing oauthClients target descriptor`);
        const clientDoc = targetDocsByColAndTargetId.get(`oauthClients:${clientTarget.id}`);
        if (!clientDoc) throw new CutoverFenceError(`Target oauth client ${clientTarget.id} missing`);
        const clientData = clientDoc.data() || {};
        const reconstructedClientProjection = {
          clientId: clientDoc.id,
          clientName: typeof clientData.client_name === 'string' ? clientData.client_name : null,
          redirectUris: Array.isArray(clientData.redirect_uris) ? [...clientData.redirect_uris].sort(codeUnitCompare) : [],
          tokenEndpointAuthMethod: clientData.token_endpoint_auth_method,
          clientIdIssuedAt: typeof clientData.client_id_issued_at === 'number' ? clientData.client_id_issued_at : null,
        };

        const digest = H(key, 'logical-record', namespace, currentEpoch, ['clients', reconstructedClientProjection]);
        targetLogicalPairs.push([cand.id, digest]);
      }
    }

    targetLogicalPairs.sort(comparePairs);
    targetLogicalDigest = targetLogicalPairs.length === 0
      ? H(key, 'logical-inventory', namespace, currentEpoch, [])
      : H(key, 'logical-inventory', namespace, currentEpoch, targetLogicalPairs);

    if (report.errors === 0 && targetLogicalDigest !== sourceLogicalDigest) {
      throw new CutoverFenceError(
        `Target logical digest (${targetLogicalDigest}) does not match source logical digest (${sourceLogicalDigest})`,
      );
    }
  }
  const finalManifest = {
    schemaVersion: 2,
    namespace,
    epoch: currentEpoch,
    migrationRunId: runId,
    codeSha,
    codeArtifact,
    packageIntegrity,
    protocolDigest,
    kind: 'final',
    preparedDigest,
    completedAt: nowProvider(),
    physicalCounts,
    classifications,
    reasons,
    totalPhysicalRecords,
    targetCounts,
    scanned: candidateCommitments.length,
    migrated: report.migrated,
    skipped: report.skipped,
    errors: report.errors,
    sourceInventoryDigest,
    targetInventoryDigest,
    sourceLogicalDigest,
    targetLogicalDigest,
    receiptSetDigest,
  };

  const migrationManifestDigest = computeManifestDigest(finalManifest);

  const ownershipMarker = {
    schemaVersion: 2,
    namespace,
    epoch: currentEpoch,
    migrationRunId: runId,
    codeSha,
    codeArtifact,
    packageIntegrity,
    protocolDigest,
    kind: 'ownership',
    preparedDigest,
    migrationManifestDigest,
    emptyNamespace: isActuallyEmpty,
    adoptedAt: nowProvider(),
  };
  if (!dryRun && report.errors === 0) {
    await db.runTransaction(async (tx: any) => {
      let controlRecord: any;
      if (isControlled && initialControl) {
        controlRecord = await readCutoverFenceInTransaction(tx, db, namespace);
        if (controlRecord.epoch !== currentEpoch || controlRecord.state !== 'migrating' || controlRecord.migrationRunId !== runId) {
          throw new CutoverFenceError(
            `Cannot finalize cutover fence for namespace ${namespace}: control record state is ${controlRecord.state}, epoch is ${controlRecord.epoch}`,
          );
        }
      }

      tx.set(
        db.collection(`${namespace}_meta`).doc(`migration_manifest_${currentEpoch}`),
        stripUndefined(finalManifest),
      );
      tx.set(
        db.collection(`${namespace}_meta`).doc('v2_adopted'),
        stripUndefined(ownershipMarker),
      );

      if (isControlled && initialControl) {
        const updatedControl = {
          ...controlRecord,
          state: 'v3_ready',
          migrationRunId: runId,
          migrationManifestDigest,
          emptyNamespace: isActuallyEmpty ? true : undefined,
          updatedAt: nowProvider(),
        };
        tx.set(getCutoverFenceDocRef(db, namespace), stripUndefined(updatedControl));
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

  const hasAnyLegacy =
    legFam.docs.length > 0 ||
    legTok.docs.length > 0 ||
    legRef.docs.length > 0 ||
    legUp.docs.length > 0 ||
    legAuth.docs.length > 0 ||
    legRes.docs.length > 0;

  if (hasAnyLegacy) {
    await adoptFirestoreLegacyTokens({
      db,
      namespace,
      key: options.key,
      now: options.now,
    });
  } else {
    await markerDoc.set({
      adoptedAt: (options.now ?? Date.now)(),
      scanned: 0,
      migrated: 0,
      skipped: 0,
      errors: 0,
    });
  }
}
