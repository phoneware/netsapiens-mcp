import { createHash, randomUUID } from 'node:crypto';
import { createCodec, type Codec } from './codec.js';
import {
  accessAad,
  familyAad,
  upstreamAad,
  codeUnitCompare,
  compareDescriptors,
  safeDocEntry,
  startMonotonicTimer,
} from './row-format.js';
import {
  encodeSessionsRow,
  encodeRefreshFamiliesRow,
  encodeUpstreamRow,
  encodeRefreshRow,
  encodeAuthCodesRow,
  encodeResumeTokensRow,
  encodeOAuthClientsRow,
} from './row-codec.js';
import {
  PROJECTOR_ID,
  PROJECTOR_VERSION,
  projectSourceLogical,
  projectTargetLogical,
  sanitizeId,
} from './netsapiens-projector.mjs';
import {
  CutoverFenceError,
  CutoverRefusedError,
} from './errors.js';
import {
  C,
  D,
  H,
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
  transitionCutoverFenceState,
  validateCompleteMigrationPlan,
  validateReceipt,
  computeKeyedDocId,
  computeSourceRecordDigest,
  computeTargetRecordDigest,
  computeSourceInventoryDigest,
  computeTargetInventoryDigest,
  computeReceiptSetDigest,
  computeLogicalInventoryDigest,
  computeEstimatedFirestoreDocSize,
  prepareMigrationInTransaction,
  finalizeMigrationInTransaction,
  activateMigrationInTransaction,
  markIrreversibleInTransaction,
  getCutoverDistinctCollectionNames,
  isTargetFormatRow,
  parseCutoverFenceRecord,
  validateMigrationIdentityFields,
  getMeasuredProjectorDigest,
} from '../cutover/canonical-core.mjs';
import type { FirestoreLike } from './firestore.js';

export type SupportedNamespace = (typeof SUPPORTED_CUTOVER_NAMESPACES)[number];

export interface MigrationContext {
  db: FirestoreLike;
  FieldPath: { documentId(): any };
  key: Uint8Array | Buffer;
  namespace: SupportedNamespace;
  expectedEpoch: number;
  migrationRunId: string;
  codeSha: string;
  codeArtifact: string;
  packageIntegrity: string;
  protocolDigest: string;
  assemblyDigest: string;
  indexSchemaDigest: string;
}

export function assertValidMigrationContext(options: unknown): asserts options is MigrationContext {
  if (!options || typeof options !== 'object') {
    throw new CutoverFenceError('MigrationContext must be an object');
  }
  const opts = options as Record<string, unknown>;
  const requiredFields = [
    'db',
    'FieldPath',
    'key',
    'namespace',
    'expectedEpoch',
    'migrationRunId',
    'codeSha',
    'codeArtifact',
    'packageIntegrity',
    'protocolDigest',
    'assemblyDigest',
    'indexSchemaDigest',
  ];
  for (const field of requiredFields) {
    if (opts[field] === undefined || opts[field] === null) {
      throw new CutoverFenceError(`MigrationContext missing required field: ${field}`);
    }
  }
  if (typeof opts.db !== 'object' || typeof (opts.db as any).collection !== 'function' || typeof (opts.db as any).runTransaction !== 'function') {
    throw new CutoverFenceError('MigrationContext db must be a Firestore-like object with collection and runTransaction methods');
  }
  if (typeof opts.FieldPath !== 'object' || typeof (opts.FieldPath as any).documentId !== 'function') {
    throw new CutoverFenceError('MigrationContext FieldPath must be an adapter object with documentId() method');
  }
  if (!Buffer.isBuffer(opts.key) && !(opts.key instanceof Uint8Array)) {
    throw new CutoverFenceError('MigrationContext key must be a Uint8Array or Buffer');
  }
  if ((opts.key as Uint8Array).length < 16) {
    throw new CutoverFenceError('MigrationContext key must be at least 16 bytes');
  }
  assertSupportedCutoverNamespace(opts.namespace as string);
  if (typeof opts.expectedEpoch !== 'number' || !Number.isInteger(opts.expectedEpoch) || opts.expectedEpoch < 1) {
    throw new CutoverFenceError('MigrationContext expectedEpoch must be a positive integer');
  }
  if (typeof opts.migrationRunId !== 'string' || !opts.migrationRunId.trim()) {
    throw new CutoverFenceError('MigrationContext migrationRunId must be a non-empty string');
  }
  if (typeof opts.codeSha !== 'string' || !/^[0-9a-f]{40}$/.test(opts.codeSha)) {
    throw new CutoverFenceError('MigrationContext codeSha must be a 40-character lowercase hex string');
  }
  if (typeof opts.codeArtifact !== 'string' || !opts.codeArtifact.trim()) {
    throw new CutoverFenceError('MigrationContext codeArtifact must be a non-empty string');
  }
  if (typeof opts.packageIntegrity !== 'string' || !opts.packageIntegrity.trim()) {
    throw new CutoverFenceError('MigrationContext packageIntegrity must be a non-empty string');
  }
  if (typeof opts.protocolDigest !== 'string' || !/^[0-9a-f]{64}$/.test(opts.protocolDigest)) {
    throw new CutoverFenceError('MigrationContext protocolDigest must be a 64-character lowercase hex string');
  }
  if (typeof opts.assemblyDigest !== 'string' || !/^[0-9a-f]{64}$/.test(opts.assemblyDigest)) {
    throw new CutoverFenceError('MigrationContext assemblyDigest must be a 64-character lowercase hex string');
  }
  if (typeof opts.indexSchemaDigest !== 'string' || !/^[0-9a-f]{64}$/.test(opts.indexSchemaDigest)) {
    throw new CutoverFenceError('MigrationContext indexSchemaDigest must be a 64-character lowercase hex string');
  }
}

function computeDocDepth(obj: unknown, currentDepth = 1): number {
  if (!obj || typeof obj !== 'object' || obj instanceof Date) return currentDepth;
  let maxDepth = currentDepth;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      maxDepth = Math.max(maxDepth, computeDocDepth(item, currentDepth + 1));
    }
  } else {
    for (const val of Object.values(obj)) {
      maxDepth = Math.max(maxDepth, computeDocDepth(val, currentDepth + 1));
    }
  }
  return maxDepth;
}

function countIndexMetrics(val: unknown): { entries: number; bytes: number } {
  let entries = 0;
  let bytes = 0;
  function traverse(v: unknown, pathLen = 0) {
    if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string' || v instanceof Date) {
      entries += 2;
      bytes += (pathLen + 8);
    } else if (Array.isArray(v)) {
      for (const item of v) {
        entries += 1;
        bytes += (pathLen + 8);
        traverse(item, pathLen);
      }
    } else if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        traverse(child, pathLen + Buffer.byteLength(k, 'utf8') + 1);
      }
    }
  }
  traverse(val);
  return { entries, bytes };
}

function computeCandidateId(storeKey: Uint8Array | Buffer, namespace: string, epoch: number, kind: string, sortedSourceIds: string[]): string {
  return H(storeKey, 'candidate-id', namespace, epoch, [kind, sortedSourceIds]);
}

function computeCandidateLogicalDigest(storeKey: Uint8Array | Buffer, namespace: string, epoch: number, kind: string, logicalProjection: unknown): string {
  return H(storeKey, 'logical-record', namespace, epoch, [kind, logicalProjection]);
}

export function extractCandidatesAndPlan(params: {
  sourceDocsByKey: Map<string, any[]>;
  storeKey: Uint8Array | Buffer;
  namespace: string;
  epoch: number;
  runId: string;
  codeSha: string;
  codeArtifact: string;
  packageIntegrity: string;
  protocolDigest: string;
  assemblyDigest: string;
  indexSchemaDigest: string;
  now: number;
}) {
  const {
    sourceDocsByKey,
    storeKey,
    namespace,
    epoch,
    runId,
    codeSha,
    codeArtifact,
    packageIntegrity,
    protocolDigest,
    assemblyDigest,
    indexSchemaDigest,
    now,
  } = params;

  const codec = createCodec(storeKey);
  const measuredProjectorDigest = getMeasuredProjectorDigest();

  const physicalCounts: Record<string, number> = {};
  for (const k of PHYSICAL_COUNT_KEYS) physicalCounts[k] = 0;
  const classifications: Record<string, number> = {};
  for (const k of CLASSIFICATION_KEYS) classifications[k] = 0;
  const reasons: Record<string, number> = {};
  for (const k of REASON_KEYS) reasons[k] = 0;
  const expectedTargetCounts: Record<string, number> = {};
  for (const k of TARGET_COUNT_KEYS) expectedTargetCounts[k] = 0;

  for (const k of PHYSICAL_COUNT_KEYS) {
    physicalCounts[k] = (sourceDocsByKey.get(k) || []).length;
  }

  const familiesDocs = sourceDocsByKey.get('families') || [];
  const tokensDocs = sourceDocsByKey.get('tokens') || [];
  const refreshDocs = sourceDocsByKey.get('refresh') || [];
  const upstreamDocs = sourceDocsByKey.get('upstream') || [];
  const authCodesDocs = sourceDocsByKey.get('authCodes') || [];
  const resumeDocs = sourceDocsByKey.get('resumeTokens') || [];
  const oauthClientsDocs = sourceDocsByKey.get('oauthClients') || [];
  const clientsDocs = sourceDocsByKey.get('clients') || [];

  const familiesById = new Map<string, any>();
  for (const d of familiesDocs) familiesById.set(d.id, d.data() || {});
  const tokensById = new Map<string, any>();
  for (const d of tokensDocs) tokensById.set(d.id, d.data() || {});
  const refreshById = new Map<string, any>();
  for (const d of refreshDocs) refreshById.set(d.id, d.data() || {});
  const upstreamById = new Map<string, any>();
  for (const d of upstreamDocs) upstreamById.set(d.id, d.data() || {});

  const candidates: any[] = [];
  const candidateCommitments: any[] = [];
  const claimedAccessIds = new Set<string>();
  const claimedRefreshIds = new Set<string>();
  const claimedRetiredFingerprints = new Set<string>();

  // 1. Process families (pr56Families)
  for (const famDoc of familiesDocs) {
    const familyId = famDoc.id;
    const famData = famDoc.data() || {};

    if (!upstreamById.has(familyId)) {
      reasons.missingUpstreamGrants++;
      continue;
    }
    const currentRefId = famData.currentRefreshToken;
    if (!currentRefId || !refreshById.has(currentRefId)) {
      reasons.missingRefreshPointers++;
      continue;
    }
    const curRefDoc = refreshById.get(currentRefId) || {};
    const curRefFamId = curRefDoc.familyId ?? curRefDoc.family_id;
    if (curRefFamId !== familyId || curRefDoc.status !== 'active') {
      reasons.malformedRecords++;
      continue;
    }
    if (claimedRefreshIds.has(currentRefId)) {
      reasons.conflictingClaims++;
      continue;
    }
    claimedRefreshIds.add(currentRefId);

    const accessId = famData.currentAccessToken ?? curRefDoc.token?.accessToken;
    if (!accessId || typeof accessId !== 'string' || !accessId.trim()) {
      reasons.missingAccessTokens++;
      continue;
    }
    if (claimedAccessIds.has(accessId)) {
      reasons.conflictingClaims++;
      continue;
    }
    claimedAccessIds.add(accessId);

    if (famData.previousRefreshToken) {
      const prevRefId = famData.previousRefreshToken;
      if (prevRefId === currentRefId || claimedRefreshIds.has(prevRefId)) {
        reasons.conflictingClaims++;
        continue;
      }
      claimedRefreshIds.add(prevRefId);
    }

    const rawRetired = Array.isArray(famData.retiredRefreshFingerprints)
      ? famData.retiredRefreshFingerprints
      : (Array.isArray(famData.retiredTokens) ? famData.retiredTokens : []);
    const seenFp = new Set();
    const retiredFingerprints = [];
    let retiredConflict = false;
    for (const fp of rawRetired) {
      if (typeof fp === 'string' && fp.length > 0) {
        if (seenFp.has(fp) || claimedRetiredFingerprints.has(fp)) {
          reasons.conflictingClaims++;
          retiredConflict = true;
          break;
        }
        seenFp.add(fp);
        claimedRetiredFingerprints.add(fp);
        retiredFingerprints.push(fp);
      }
    }
    if (retiredConflict) continue;
    retiredFingerprints.sort(codeUnitCompare);

    const newAccessId = codec.id('session', accessId);
    const newRefreshId = codec.id('refresh', currentRefId);

    const candSources = [
      {
        collection: 'families',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'families', familyId),
        rawId: familyId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'families', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'families', familyId), famData),
      },
      {
        collection: 'refresh',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'refresh', currentRefId),
        rawId: currentRefId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'refresh', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'refresh', currentRefId), curRefDoc),
      },
      {
        collection: 'upstream',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'upstream', familyId),
        rawId: familyId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'upstream', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'upstream', familyId), upstreamById.get(familyId)),
      },
      {
        collection: 'tokens',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'tokens', accessId),
        rawId: accessId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'tokens', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'tokens', accessId), tokensById.get(accessId) || {}),
      },
    ];

    if (famData.previousRefreshToken) {
      const prevId = famData.previousRefreshToken;
      const prevDoc = refreshById.get(prevId) || {};
      candSources.push({
        collection: 'refresh',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'refresh', prevId),
        rawId: prevId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'refresh', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'refresh', prevId), prevDoc),
      });
    }

    candSources.sort(compareDescriptors);

    const famTargetId = computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'families', familyId);
    const accTargetId = computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'tokens', newAccessId);
    const refTargetId = computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'refresh', newRefreshId);
    const upTargetId = computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'upstream', familyId);

    const candTargets = [
      { collection: 'families', id: famTargetId, rawId: familyId },
      { collection: 'tokens', id: accTargetId, rawId: newAccessId },
      { collection: 'refresh', id: refTargetId, rawId: newRefreshId },
      { collection: 'upstream', id: upTargetId, rawId: familyId },
    ];
    let prevRefTargetId: string | undefined;
    if (famData.previousRefreshToken) {
      const prevRefId = codec.id('refresh', famData.previousRefreshToken);
      prevRefTargetId = computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'refresh', prevRefId);
      candTargets.push({ collection: 'refresh', id: prevRefTargetId, rawId: prevRefId });
    }
    for (const fp of retiredFingerprints) {
      const retTgtId = computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'retiredRefreshTokens', fp);
      candTargets.push({ collection: 'retiredRefreshTokens', id: retTgtId, rawId: fp });
    }
    candTargets.sort(compareDescriptors);

    const sortedSourceIds = candSources.map((s) => s.id).sort(codeUnitCompare);
    const candidateId = computeCandidateId(storeKey, namespace, epoch, 'pr56Families', sortedSourceIds);

    const sourcesMap = new Map();
    sourcesMap.set('families', safeDocEntry(familyId, famData));
    sourcesMap.set('refresh', safeDocEntry(currentRefId, curRefDoc));
    sourcesMap.set('upstream', safeDocEntry(familyId, upstreamById.get(familyId)));
    sourcesMap.set('tokens', safeDocEntry(accessId, tokensById.get(accessId) || {}));
    if (famData.previousRefreshToken) {
      const prevId = famData.previousRefreshToken;
      sourcesMap.set('prevRefresh', safeDocEntry(prevId, refreshById.get(prevId) || {}));
    }

    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: 'pr56Families', sources: candSources, targets: candTargets, logicalDigest: '' },
      sourcesMap,
      codec,
    );
    const logicalDigest = computeCandidateLogicalDigest(storeKey, namespace, epoch, 'pr56Families', logicalProjection);

    const generation = typeof famData.generation === 'number' ? famData.generation : 1;
    const grantVersion = typeof upstreamById.get(familyId)?.grantVersion === 'number' ? upstreamById.get(familyId).grantVersion : 1;

    const famRow = encodeRefreshFamiliesRow(codec, familyId, generation, newRefreshId, newAccessId, logicalProjection, retiredFingerprints, famData.status, now);
    const upRow = encodeUpstreamRow(codec, familyId, grantVersion, {
      nsAccessToken: logicalProjection.upstream.nsAccessToken,
      nsRefreshToken: logicalProjection.upstream.nsRefreshToken,
      nsUsername: logicalProjection.upstream.nsUsername,
      nsUserRole: logicalProjection.upstream.nsUserRole,
      nsApiUrl: logicalProjection.upstream.nsApiUrl,
      nsExpiresAt: logicalProjection.upstream.nsExpiresAt,
    }, now);
    const refRow = encodeRefreshRow(newRefreshId, familyId, generation, now);
    const accRow = encodeSessionsRow(codec, newAccessId, familyId, {
      expiresAt: logicalProjection.expiresAt,
      clientId: logicalProjection.clientId,
      serverBaseUrl: logicalProjection.serverBaseUrl,
      extra: logicalProjection.extra,
    }, now);

    const targetDocsMap = new Map();
    targetDocsMap.set('families', famRow);
    targetDocsMap.set('upstream', upRow);
    targetDocsMap.set('activeRefresh', refRow);
    targetDocsMap.set('tokens', accRow);

    const postimageByTargetId = new Map();
    postimageByTargetId.set(famTargetId, famRow);
    postimageByTargetId.set(accTargetId, accRow);
    postimageByTargetId.set(refTargetId, refRow);
    postimageByTargetId.set(upTargetId, upRow);

    let prevRefreshRow: any = null;
    if (famData.previousRefreshToken) {
      const prevRefId = codec.id('refresh', famData.previousRefreshToken);
      const prevRefDoc = refreshById.get(famData.previousRefreshToken) || {};
      prevRefreshRow = {
        id: prevRefId,
        familyId,
        status: 'consumed' as const,
        generation: Math.max(1, generation - 1),
        consumedAt: prevRefDoc.consumedAt || now,
        successorSealed: codec.seal({ accessToken: accessId, refreshToken: currentRefId }, `successor:${prevRefId}`),
        v: 2,
      };
      targetDocsMap.set('prevRefresh', prevRefreshRow);
      postimageByTargetId.set(prevRefTargetId, prevRefreshRow);
    }

    const retiredRows: any[] = [];
    for (const fp of retiredFingerprints) {
      const retRow = {
        fingerprint: fp,
        familyId,
        retiredAt: now,
        v: 2,
      };
      retiredRows.push(retRow);
      const retTgtId = computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'retiredRefreshTokens', fp);
      postimageByTargetId.set(retTgtId, retRow);
    }
    if (retiredFingerprints.length > 0) {
      targetDocsMap.set('retiredRefresh', { ids: retiredFingerprints });
    }

    // Verify logical projection equivalence
    const targetLogicalProjection = projectTargetLogical(
      { id: candidateId, kind: 'pr56Families', sources: candSources, targets: candTargets, logicalDigest: '' },
      targetDocsMap,
      codec,
    );
    if (C(logicalProjection) !== C(targetLogicalProjection)) {
      throw new CutoverFenceError(`Logical projection equivalence check failed for candidate ${sanitizeId(candidateId)}`);
    }

    // Map postimages strictly according to sorted candTargets
    const prospectiveTargetPostimages = candTargets.map((t) => {
      const post = postimageByTargetId.get(t.id);
      if (!post) throw new CutoverFenceError(`Missing prospective target postimage for target ${t.collection}:${sanitizeId(t.id)}`);
      return post;
    });

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
      sources: candSources.map((s) => ({ collection: s.collection, id: s.id, recordDigest: s.recordDigest })),
      targets: candTargets.map((t) => ({ collection: t.collection, id: t.id })),
      logicalDigest,
    };
    candidateCommitments.push(candCommitment);

    candidates.push({
      id: candidateId,
      kind: 'pr56Families',
      commitment: candCommitment,
      sources: candSources,
      targets: candTargets,
      logicalDigest,
      prospectiveTargetPostimages,
      postimageByTargetId,
      sourceActions: candSources.map((s) => ({ collection: s.collection, id: s.id, rawId: s.rawId, action: 'delete' })),
      targetRows: {
        refreshFamilies: famRow,
        upstreamGrants: upRow,
        refreshTokens: refRow,
        sessions: accRow,
        prevRefresh: prevRefreshRow,
        retiredRefresh: retiredRows,
      },
    });
  }

  // 2. Process baseFormatTokens (tokens not claimed by any family)
  for (const tokDoc of tokensDocs) {
    const accessId = tokDoc.id;
    if (claimedAccessIds.has(accessId)) continue;
    claimedAccessIds.add(accessId);

    const tokData = tokDoc.data() || {};
    const familyId = codec.id('family', accessId);
    const refreshId = codec.id('refresh', tokData.refreshToken || accessId);
    const newAccessId = codec.id('session', accessId);

    const candSources = [
      {
        collection: 'tokens',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'tokens', accessId),
        rawId: accessId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'tokens', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'tokens', accessId), tokData),
      },
    ];
    if (tokData.refreshToken && refreshById.has(tokData.refreshToken)) {
      const refDoc = refreshById.get(tokData.refreshToken);
      candSources.push({
        collection: 'refresh',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'refresh', tokData.refreshToken),
        rawId: tokData.refreshToken,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'refresh', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'refresh', tokData.refreshToken), refDoc),
      });
      claimedRefreshIds.add(tokData.refreshToken);
    }
    candSources.sort(compareDescriptors);

    const famTargetId = computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'families', familyId);
    const accTargetId = computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'tokens', newAccessId);
    const refTargetId = computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'refresh', refreshId);
    const upTargetId = computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'upstream', familyId);

    const candTargets = [
      { collection: 'families', id: famTargetId, rawId: familyId },
      { collection: 'tokens', id: accTargetId, rawId: newAccessId },
      { collection: 'refresh', id: refTargetId, rawId: refreshId },
      { collection: 'upstream', id: upTargetId, rawId: familyId },
    ];
    candTargets.sort(compareDescriptors);

    const sortedSourceIds = candSources.map((s) => s.id).sort(codeUnitCompare);
    const candidateId = computeCandidateId(storeKey, namespace, epoch, 'baseFormatTokens', sortedSourceIds);

    const sourcesMap = new Map();
    sourcesMap.set('tokens', safeDocEntry(accessId, tokData));
    if (tokData.refreshToken && refreshById.has(tokData.refreshToken)) {
      sourcesMap.set('refresh', safeDocEntry(tokData.refreshToken, refreshById.get(tokData.refreshToken)));
    }

    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: 'baseFormatTokens', sources: candSources, targets: candTargets, logicalDigest: '' },
      sourcesMap,
      codec,
    );
    const logicalDigest = computeCandidateLogicalDigest(storeKey, namespace, epoch, 'baseFormatTokens', logicalProjection);

    const famRow = encodeRefreshFamiliesRow(codec, familyId, 1, refreshId, newAccessId, logicalProjection, [], 'active', now);
    const upRow = encodeUpstreamRow(codec, familyId, 1, {
      nsAccessToken: logicalProjection.upstream.nsAccessToken,
      nsRefreshToken: logicalProjection.upstream.nsRefreshToken,
      nsUsername: logicalProjection.upstream.nsUsername,
      nsUserRole: logicalProjection.upstream.nsUserRole,
      nsApiUrl: logicalProjection.upstream.nsApiUrl,
      nsExpiresAt: logicalProjection.upstream.nsExpiresAt,
    }, now);
    const refRow = encodeRefreshRow(refreshId, familyId, 1, now);
    const accRow = encodeSessionsRow(codec, newAccessId, familyId, {
      expiresAt: logicalProjection.expiresAt,
      clientId: logicalProjection.clientId,
      serverBaseUrl: logicalProjection.serverBaseUrl,
      extra: logicalProjection.extra,
    }, now);

    const targetDocsMap = new Map();
    targetDocsMap.set('families', famRow);
    targetDocsMap.set('upstream', upRow);
    targetDocsMap.set('activeRefresh', refRow);
    targetDocsMap.set('tokens', accRow);

    const postimageByTargetId = new Map();
    postimageByTargetId.set(famTargetId, famRow);
    postimageByTargetId.set(accTargetId, accRow);
    postimageByTargetId.set(refTargetId, refRow);
    postimageByTargetId.set(upTargetId, upRow);

    const targetLogicalProjection = projectTargetLogical(
      { id: candidateId, kind: 'baseFormatTokens', sources: candSources, targets: candTargets, logicalDigest: '' },
      targetDocsMap,
      codec,
    );
    if (C(logicalProjection) !== C(targetLogicalProjection)) {
      throw new CutoverFenceError(`Logical projection equivalence check failed for candidate ${sanitizeId(candidateId)}`);
    }

    const prospectiveTargetPostimages = candTargets.map((t) => postimageByTargetId.get(t.id));

    expectedTargetCounts.families++;
    expectedTargetCounts.tokens++;
    expectedTargetCounts.refresh++;
    expectedTargetCounts.upstream++;

    classifications.baseFormatTokens++;

    const candCommitment = {
      id: candidateId,
      kind: 'baseFormatTokens',
      sources: candSources.map((s) => ({ collection: s.collection, id: s.id, recordDigest: s.recordDigest })),
      targets: candTargets.map((t) => ({ collection: t.collection, id: t.id })),
      logicalDigest,
    };
    candidateCommitments.push(candCommitment);

    candidates.push({
      id: candidateId,
      kind: 'baseFormatTokens',
      commitment: candCommitment,
      sources: candSources,
      targets: candTargets,
      logicalDigest,
      prospectiveTargetPostimages,
      postimageByTargetId,
      sourceActions: candSources.map((s) => ({ collection: s.collection, id: s.id, rawId: s.rawId, action: 'delete' })),
      targetRows: {
        refreshFamilies: famRow,
        upstreamGrants: upRow,
        refreshTokens: refRow,
        sessions: accRow,
      },
    });
  }

  // 3. Process auth_codes
  for (const codeDoc of authCodesDocs) {
    const rawCode = codeDoc.id;
    const cData = codeDoc.data() || {};
    const candSources = [
      {
        collection: 'authCodes',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'authCodes', rawCode),
        rawId: rawCode,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'authCodes', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'authCodes', rawCode), cData),
      },
    ];
    const hmacCodeId = codec.id('code', rawCode);
    const targetId = computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'authCodes', hmacCodeId);
    const candTargets = [
      { collection: 'authCodes', id: targetId, rawId: hmacCodeId },
    ];
    candSources.sort(compareDescriptors);
    candTargets.sort(compareDescriptors);

    const sortedSourceIds = candSources.map((s) => s.id).sort(codeUnitCompare);
    const candidateId = computeCandidateId(storeKey, namespace, epoch, 'authCodes', sortedSourceIds);

    const sourcesMap = new Map();
    sourcesMap.set('authCodes', safeDocEntry(rawCode, cData));

    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: 'authCodes', sources: candSources, targets: candTargets, logicalDigest: '' },
      sourcesMap,
      codec,
    );
    const logicalDigest = computeCandidateLogicalDigest(storeKey, namespace, epoch, 'authCodes', logicalProjection);

    const codeRow = encodeAuthCodesRow(
      codec,
      rawCode,
      {
        pending: {
          clientId: logicalProjection.clientId,
          codeChallenge: logicalProjection.codeChallenge,
          redirectUri: logicalProjection.redirectUri,
          createdAt: logicalProjection.createdAt,
          state: logicalProjection.state,
          scopes: logicalProjection.scopes,
        },
        nsTokens: {
          access_token: logicalProjection.nsAccessToken,
          refresh_token: logicalProjection.nsRefreshToken,
          username: logicalProjection.nsUsername,
          nsUserRole: logicalProjection.nsUserRole,
          nsApiUrl: logicalProjection.nsApiUrl,
        },
        clientId: logicalProjection.clientId,
        serverBaseUrl: logicalProjection.serverBaseUrl,
        extra: logicalProjection.extra,
      },
      logicalProjection.expiresAt,
      now,
    );

    const targetDocsMap = new Map();
    targetDocsMap.set('authCodes', codeRow);
    const targetLogicalProjection = projectTargetLogical(
      { id: candidateId, kind: 'authCodes', sources: candSources, targets: candTargets, logicalDigest: '' },
      targetDocsMap,
      codec,
    );
    if (C(logicalProjection) !== C(targetLogicalProjection)) {
      throw new CutoverFenceError(`Logical projection equivalence check failed for authCode ${sanitizeId(candidateId)}`);
    }

    const prospectiveTargetPostimages = [codeRow];
    const postimageByTargetId = new Map([[targetId, codeRow]]);

    expectedTargetCounts.authCodes++;
    classifications.authCodes++;

    const candCommitment = {
      id: candidateId,
      kind: 'authCodes',
      sources: candSources.map((s) => ({ collection: s.collection, id: s.id, recordDigest: s.recordDigest })),
      targets: candTargets.map((t) => ({ collection: t.collection, id: t.id })),
      logicalDigest,
    };
    candidateCommitments.push(candCommitment);

    candidates.push({
      id: candidateId,
      kind: 'authCodes',
      commitment: candCommitment,
      sources: candSources,
      targets: candTargets,
      logicalDigest,
      prospectiveTargetPostimages,
      postimageByTargetId,
      sourceActions: [{ collection: 'authCodes', id: candSources[0].id, rawId: rawCode, action: 'delete' }],
      targetRows: { authCodes: codeRow },
    });
  }

  // 4. Process resume_tokens
  for (const resDoc of resumeDocs) {
    const resId = resDoc.id;
    const rData = resDoc.data() || {};
    const candSources = [
      {
        collection: 'resumeTokens',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'resumeTokens', resId),
        rawId: resId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'resumeTokens', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'resumeTokens', resId), rData),
      },
    ];
    const targetId = computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'resumeTokens', resId);
    const candTargets = [
      { collection: 'resumeTokens', id: targetId, rawId: resId },
    ];
    candSources.sort(compareDescriptors);
    candTargets.sort(compareDescriptors);

    const sortedSourceIds = candSources.map((s) => s.id).sort(codeUnitCompare);
    const candidateId = computeCandidateId(storeKey, namespace, epoch, 'resumeTokens', sortedSourceIds);

    const sourcesMap = new Map();
    sourcesMap.set('resumeTokens', safeDocEntry(resId, rData));

    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: 'resumeTokens', sources: candSources, targets: candTargets, logicalDigest: '' },
      sourcesMap,
      codec,
    );
    const logicalDigest = computeCandidateLogicalDigest(storeKey, namespace, epoch, 'resumeTokens', logicalProjection);

    const resRow = encodeResumeTokensRow(resId, logicalProjection.consumedAt, logicalProjection.expiresAt, now);

    const targetDocsMap = new Map();
    targetDocsMap.set('resumeTokens', resRow);
    const targetLogicalProjection = projectTargetLogical(
      { id: candidateId, kind: 'resumeTokens', sources: candSources, targets: candTargets, logicalDigest: '' },
      targetDocsMap,
      codec,
    );
    if (C(logicalProjection) !== C(targetLogicalProjection)) {
      throw new CutoverFenceError(`Logical projection equivalence check failed for resumeToken ${sanitizeId(candidateId)}`);
    }

    const prospectiveTargetPostimages = [resRow];
    const postimageByTargetId = new Map([[targetId, resRow]]);

    expectedTargetCounts.resumeTokens++;
    classifications.resumeTokens++;

    const candCommitment = {
      id: candidateId,
      kind: 'resumeTokens',
      sources: candSources.map((s) => ({ collection: s.collection, id: s.id, recordDigest: s.recordDigest })),
      targets: candTargets.map((t) => ({ collection: t.collection, id: t.id })),
      logicalDigest,
    };
    candidateCommitments.push(candCommitment);

    candidates.push({
      id: candidateId,
      kind: 'resumeTokens',
      commitment: candCommitment,
      sources: candSources,
      targets: candTargets,
      logicalDigest,
      prospectiveTargetPostimages,
      postimageByTargetId,
      sourceActions: [{ collection: 'resumeTokens', id: candSources[0].id, rawId: resId, action: 'replace' }],
      targetRows: { resumeTokens: resRow },
    });
  }

  // 5. Process clients / oauth_clients preserving dual-source identity
  const allClientIds = new Set<string>();
  const clientDocsById = new Map<string, any>();
  const oauthClientDocsById = new Map<string, any>();

  for (const doc of clientsDocs) {
    allClientIds.add(doc.id);
    clientDocsById.set(doc.id, doc.data() || {});
  }
  for (const doc of oauthClientsDocs) {
    allClientIds.add(doc.id);
    oauthClientDocsById.set(doc.id, doc.data() || {});
  }

  for (const clientId of Array.from(allClientIds).sort(codeUnitCompare)) {
    const candSources = [];
    if (clientDocsById.has(clientId)) {
      const d = clientDocsById.get(clientId);
      candSources.push({
        collection: 'clients',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'clients', clientId),
        rawId: clientId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'clients', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'clients', clientId), d),
      });
    }
    if (oauthClientDocsById.has(clientId)) {
      const d = oauthClientDocsById.get(clientId);
      candSources.push({
        collection: 'oauthClients',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'oauthClients', clientId),
        rawId: clientId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'oauthClients', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'oauthClients', clientId), d),
      });
    }
    candSources.sort(compareDescriptors);

    const targetId = computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'oauthClients', clientId);
    const candTargets = [
      { collection: 'oauthClients', id: targetId, rawId: clientId },
    ];
    candTargets.sort(compareDescriptors);

    const sortedSourceIds = candSources.map((s) => s.id).sort(codeUnitCompare);
    const candidateId = computeCandidateId(storeKey, namespace, epoch, 'clients', sortedSourceIds);

    const sourcesMap = new Map();
    if (clientDocsById.has(clientId)) sourcesMap.set('clients', safeDocEntry(clientId, clientDocsById.get(clientId)));
    if (oauthClientDocsById.has(clientId)) sourcesMap.set('oauthClients', safeDocEntry(clientId, oauthClientDocsById.get(clientId)));

    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: 'clients', sources: candSources, targets: candTargets, logicalDigest: '' },
      sourcesMap,
      codec,
    );
    const logicalDigest = computeCandidateLogicalDigest(storeKey, namespace, epoch, 'clients', logicalProjection);

    const clientRow = encodeOAuthClientsRow(clientId, {
      client_name: logicalProjection.clientName,
      redirect_uris: logicalProjection.redirectUris,
      token_endpoint_auth_method: logicalProjection.tokenEndpointAuthMethod,
      client_secret: logicalProjection.clientSecret,
      grant_types: logicalProjection.grantTypes,
      response_types: logicalProjection.responseTypes,
      client_uri: logicalProjection.clientUri,
      logo_uri: logicalProjection.logoUri,
      scope: logicalProjection.scope,
      client_id_issued_at: logicalProjection.clientIdIssuedAt,
    }, now);

    const targetDocsMap = new Map();
    targetDocsMap.set('clients', clientRow);
    const targetLogicalProjection = projectTargetLogical(
      { id: candidateId, kind: 'clients', sources: candSources, targets: candTargets, logicalDigest: '' },
      targetDocsMap,
      codec,
    );
    if (C(logicalProjection) !== C(targetLogicalProjection)) {
      throw new CutoverFenceError(`Logical projection equivalence check failed for client ${sanitizeId(candidateId)}`);
    }

    const prospectiveTargetPostimages = [clientRow];
    const postimageByTargetId = new Map([[targetId, clientRow]]);

    expectedTargetCounts.oauthClients++;
    classifications.clients++;

    const candCommitment = {
      id: candidateId,
      kind: 'clients',
      sources: candSources.map((s) => ({ collection: s.collection, id: s.id, recordDigest: s.recordDigest })),
      targets: candTargets.map((t) => ({ collection: t.collection, id: t.id })),
      logicalDigest,
    };
    candidateCommitments.push(candCommitment);

    candidates.push({
      id: candidateId,
      kind: 'clients',
      commitment: candCommitment,
      sources: candSources,
      targets: candTargets,
      logicalDigest,
      prospectiveTargetPostimages,
      postimageByTargetId,
      sourceActions: candSources.map((s) => ({ collection: s.collection, id: s.id, rawId: s.rawId, action: s.collection === 'clients' ? 'delete' : 'replace' })),
      targetRows: { oauthClients: clientRow },
    });
  }

  // Source logical digest
  candidateCommitments.sort((a, b) => codeUnitCompare(a.id, b.id));
  const sourceLogicalItems = candidateCommitments.map((c) => [c.id, c.logicalDigest] as [string, string]);
  const sourceLogicalDigest = computeLogicalInventoryDigest(storeKey, namespace, epoch, sourceLogicalItems);

  // Source descriptors
  const allSourceDescriptors: Array<{ collection: string; id: string; recordDigest: string }> = [];
  for (const [colKey, docs] of sourceDocsByKey.entries()) {
    for (const d of docs) {
      const sourceId = computeKeyedDocId(storeKey, 'source-id', namespace, epoch, colKey, d.id);
      const recDigest = computeSourceRecordDigest(storeKey, namespace, epoch, colKey, sourceId, d.data() || {});
      allSourceDescriptors.push({ collection: colKey, id: sourceId, recordDigest: recDigest });
    }
  }
  allSourceDescriptors.sort(compareDescriptors);
  const sourceInventoryDigest = computeSourceInventoryDigest(storeKey, namespace, epoch, allSourceDescriptors);

  // Construct non-secret planSpec per Section 5 (NO rawId!)
  const totalPhysicalRecords = Object.values(physicalCounts).reduce((a, b) => a + b, 0);

  const planSpec = {
    schemaVersion: 2,
    namespace,
    epoch,
    runId,
    codeSha,
    codeArtifact,
    packageIntegrity,
    protocolDigest,
    assemblyDigest,
    indexSchemaDigest,
    encoderVersion: 1,
    candidates: candidateCommitments.map((c, idx) => ({
      candidateId: c.id,
      kind: c.kind,
      sources: c.sources,
      targets: c.targets,
      logicalDigest: c.logicalDigest,
      sourceActions: candidates[idx].sourceActions.map((sa: any) => ({
        collection: sa.collection,
        id: sa.id,
        action: sa.action,
      })),
      targetBounds: candidates[idx].prospectiveTargetPostimages.map((img: any) => ({
        sizeBytes: computeEstimatedFirestoreDocSize(img),
        depth: computeDocDepth(img),
        indexEntries: countIndexMetrics(img).entries,
        indexBytes: countIndexMetrics(img).bytes,
      })),
    })),
    expectedTargetCounts,
    physicalCounts,
  };

  const planDigest = D('plan', namespace, epoch, planSpec);

  const prepared = {
    schemaVersion: 2,
    namespace,
    epoch,
    migrationRunId: runId,
    codeSha,
    codeArtifact,
    packageIntegrity,
    protocolDigest,
    assemblyDigest,
    indexSchemaDigest,
    encoderVersion: 1,
    planDigest,
    planSpec,
    kind: 'prepared',
    preparedAt: now,
    physicalCounts,
    classifications,
    reasons,
    totalPhysicalRecords,
    scanned: candidateCommitments.length,
    expectedTargetCounts,
    sourceInventoryDigest,
    sourceLogicalDigest,
    candidateCommitments,
    ...(totalPhysicalRecords > 0 ? {
      projectorId: PROJECTOR_ID,
      projectorVersion: PROJECTOR_VERSION,
      projectorDigest: measuredProjectorDigest,
    } : {}),
  };

  const preparation = {
    estimatedCommitBytes: Math.max(100, computeEstimatedFirestoreDocSize(prepared) + 200),
    estimatedReadDurationMs: 100,
  };

  const items = candidates.map((c) => {
    const receiptUpperBound = {
      schemaVersion: 2,
      namespace,
      epoch,
      migrationRunId: runId,
      codeSha,
      codeArtifact,
      packageIntegrity,
      protocolDigest,
      assemblyDigest,
      indexSchemaDigest,
      encoderVersion: 1,
      planDigest,
      kind: 'receipt',
      preparedDigest: D('prepared', namespace, epoch, prepared),
      candidateId: c.id,
      candidateDigest: D('candidate', namespace, epoch, c.commitment),
      disposition: 'written',
      sourceAfter: c.sources.map((s: any) => ({ collection: s.collection, id: s.id, recordDigest: s.recordDigest })),
      targetAfter: c.targets.map((t: any) => {
        const post = c.postimageByTargetId.get(t.id);
        const recDigest = computeTargetRecordDigest(storeKey, namespace, epoch, t.collection, t.id, post);
        return { collection: t.collection, id: t.id, recordDigest: recDigest };
      }),
      logicalDigest: c.logicalDigest,
      completedAt: now,
    };

    const targetPostimages = c.prospectiveTargetPostimages || [];
    let itemCommitBytes = computeEstimatedFirestoreDocSize(receiptUpperBound);
    for (const post of targetPostimages) {
      itemCommitBytes += computeEstimatedFirestoreDocSize(post);
    }

    return {
      candidateId: c.id,
      sourceReferences: c.sources.map((s: any) => ({ collection: s.collection, id: s.id })),
      targetReferences: c.targets.map((t: any) => ({ collection: t.collection, id: t.id })),
      prospectiveTargetPostimages: targetPostimages,
      sourceActions: c.sourceActions.map((sa: any) => ({ collection: sa.collection, id: sa.id, action: sa.action })),
      receiptUpperBound,
      transaction: {
        estimatedCommitBytes: Math.max(100, itemCommitBytes),
        estimatedReadDurationMs: 50,
      },
    };
  });

  const finalUpperBound = {
    schemaVersion: 2,
    namespace,
    epoch,
    migrationRunId: runId,
    codeSha,
    codeArtifact,
    packageIntegrity,
    protocolDigest,
    assemblyDigest,
    indexSchemaDigest,
    encoderVersion: 1,
    planDigest,
    kind: 'final',
    preparedDigest: D('prepared', namespace, epoch, prepared),
    completedAt: now,
    physicalCounts,
    classifications,
    reasons,
    totalPhysicalRecords,
    targetCounts: expectedTargetCounts,
    scanned: candidateCommitments.length,
    migrated: candidateCommitments.length,
    skipped: 0,
    errors: 0,
    sourceInventoryDigest,
    targetInventoryDigest: '0'.repeat(64),
    sourceLogicalDigest,
    targetLogicalDigest: sourceLogicalDigest,
    receiptSetDigest: '0'.repeat(64),
    ...(totalPhysicalRecords > 0 ? {
      projectorId: PROJECTOR_ID,
      projectorVersion: PROJECTOR_VERSION,
      projectorDigest: measuredProjectorDigest,
    } : {}),
  };

  const markerUpperBound = {
    schemaVersion: 2,
    namespace,
    epoch,
    migrationRunId: runId,
    codeSha,
    codeArtifact,
    packageIntegrity,
    protocolDigest,
    assemblyDigest,
    indexSchemaDigest,
    encoderVersion: 1,
    planDigest,
    kind: 'ownership',
    preparedDigest: D('prepared', namespace, epoch, prepared),
    migrationManifestDigest: '0'.repeat(64),
    emptyNamespace: totalPhysicalRecords === 0,
    adoptedAt: now,
    ...(totalPhysicalRecords > 0 ? {
      projectorId: PROJECTOR_ID,
      projectorVersion: PROJECTOR_VERSION,
      projectorDigest: measuredProjectorDigest,
    } : {}),
  };

  const controlUpperBound = {
    schemaVersion: 2,
    namespace,
    epoch,
    state: 'v3_ready',
    activeOperations: 0,
    irreversible: totalPhysicalRecords > 0,
    emptyNamespace: totalPhysicalRecords === 0,
    migrationRunId: runId,
    migrationManifestDigest: '0'.repeat(64),
    codeSha,
    codeArtifact,
    updatedAt: now,
  };

  const finalization = {
    finalUpperBound,
    markerUpperBound,
    controlUpperBound,
    transaction: {
      estimatedCommitBytes: Math.max(100, computeEstimatedFirestoreDocSize(finalUpperBound) + computeEstimatedFirestoreDocSize(markerUpperBound) + computeEstimatedFirestoreDocSize(controlUpperBound)),
      estimatedReadDurationMs: 200,
    },
  };

  const activationControlUpperBound = {
    ...controlUpperBound,
    state: 'v3_active',
  };

  const activation = {
    controlUpperBound: activationControlUpperBound,
    transaction: {
      estimatedCommitBytes: Math.max(100, computeEstimatedFirestoreDocSize(activationControlUpperBound)),
      estimatedReadDurationMs: 100,
    },
  };

  const plan = {
    prepared,
    preparation,
    items,
    finalization,
    activation,
  };

  // Validate complete plan against 80% limits!
  validateCompleteMigrationPlan(plan);

  return {
    candidates,
    candidateCommitments,
    sourceInventoryDigest,
    sourceLogicalDigest,
    physicalCounts,
    expectedTargetCounts,
    planSpec,
    planDigest,
    plan,
  };
}

function computePreflightSummaryFromPlan(plan: any, sourceInventoryDigest: string, planDigest: string) {
  let estimatedFirestoreSize = computeEstimatedFirestoreDocSize(plan.prepared);
  let depth = computeDocDepth(plan.prepared);
  let indexEntries = countIndexMetrics(plan.prepared).entries;
  let indexBytes = countIndexMetrics(plan.prepared).bytes;

  for (const item of plan.items) {
    estimatedFirestoreSize += computeEstimatedFirestoreDocSize(item.receiptUpperBound);
    depth = Math.max(depth, computeDocDepth(item.receiptUpperBound));
    indexEntries += countIndexMetrics(item.receiptUpperBound).entries;
    indexBytes += countIndexMetrics(item.receiptUpperBound).bytes;

    for (const post of item.prospectiveTargetPostimages) {
      estimatedFirestoreSize += computeEstimatedFirestoreDocSize(post);
      depth = Math.max(depth, computeDocDepth(post));
      indexEntries += countIndexMetrics(post).entries;
      indexBytes += countIndexMetrics(post).bytes;
    }
  }

  estimatedFirestoreSize += computeEstimatedFirestoreDocSize(plan.finalization.finalUpperBound);
  estimatedFirestoreSize += computeEstimatedFirestoreDocSize(plan.finalization.markerUpperBound);
  depth = Math.max(depth, computeDocDepth(plan.finalization.finalUpperBound), computeDocDepth(plan.finalization.markerUpperBound));
  indexEntries += countIndexMetrics(plan.finalization.finalUpperBound).entries + countIndexMetrics(plan.finalization.markerUpperBound).entries;
  indexBytes += countIndexMetrics(plan.finalization.finalUpperBound).bytes + countIndexMetrics(plan.finalization.markerUpperBound).bytes;

  return {
    scanned: plan.items.length,
    sourceInventoryDigest,
    planDigest,
    estimatedFirestoreSize,
    depth,
    indexEntries,
    indexBytes,
    readDeadlineMs: 16000,
  };
}

export async function inspectFirestoreLegacyMigration(options: MigrationContext): Promise<{
  sourceInventoryDigest: string;
  scanned: number;
  prospectiveWritten: number;
  prospectiveRetained: number;
  planDigest: string;
  preflight: {
    scanned: number;
    sourceInventoryDigest: string;
    planDigest: string;
    estimatedFirestoreSize: number;
    depth: number;
    indexEntries: number;
    indexBytes: number;
    readDeadlineMs: number;
  };
}> {
  assertValidMigrationContext(options);
  const allowedKeys = new Set([
    'db',
    'FieldPath',
    'key',
    'namespace',
    'expectedEpoch',
    'migrationRunId',
    'codeSha',
    'codeArtifact',
    'packageIntegrity',
    'protocolDigest',
    'assemblyDigest',
    'indexSchemaDigest',
  ]);
  for (const k of Object.keys(options)) {
    if (!allowedKeys.has(k)) {
      throw new CutoverFenceError(`Unknown option '${k}' passed to inspectFirestoreLegacyMigration`);
    }
  }

  const { db, FieldPath, key, namespace, expectedEpoch, migrationRunId, codeSha, codeArtifact, packageIntegrity, protocolDigest, assemblyDigest, indexSchemaDigest } = options;
  const storeKey = key;
  const docIdField = FieldPath.documentId();

  return await db.runTransaction(async (transaction: any) => {
    const timer = startMonotonicTimer();
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);
    if (control.epoch !== expectedEpoch) {
      throw new CutoverFenceError(`Epoch mismatch in inspect: expected ${expectedEpoch}, got ${control.epoch}`);
    }

    const { source: sourceNames, target: targetNames } = getCutoverDistinctCollectionNames(namespace);
    const distinctColNames = Array.from(new Set([...Object.values(sourceNames), ...Object.values(targetNames)])).sort();

    const sourceDocsByKey = new Map<string, any[]>();
    for (const k of PHYSICAL_COUNT_KEYS) sourceDocsByKey.set(k, []);
    const targetDocsByKey = new Map<string, any[]>();
    for (const k of TARGET_COUNT_KEYS) targetDocsByKey.set(k, []);

    const sourcePhysicalToKey: Record<string, string> = {};
    for (const [k, name] of Object.entries(sourceNames)) sourcePhysicalToKey[name] = k;
    const targetPhysicalToKey: Record<string, string> = {};
    for (const [k, name] of Object.entries(targetNames)) targetPhysicalToKey[name] = k;

    for (const colName of distinctColNames) {
      const q = typeof db.collection(colName).orderBy === 'function'
        ? db.collection(colName).orderBy(docIdField)
        : db.collection(colName);
      const snap = await transaction.get(q);
      const isSourceCol = colName in sourcePhysicalToKey;
      const isTargetCol = colName in targetPhysicalToKey;

      if (isSourceCol && !isTargetCol) {
        const colKey = sourcePhysicalToKey[colName];
        sourceDocsByKey.set(colKey, snap.docs);
      } else if (isTargetCol && !isSourceCol) {
        const colKey = targetPhysicalToKey[colName];
        targetDocsByKey.set(colKey, snap.docs);
      } else if (isSourceCol && isTargetCol) {
        const srcKey = sourcePhysicalToKey[colName];
        const tgtKey = targetPhysicalToKey[colName];
        const sDocs = [];
        const tDocs = [];
        for (const doc of snap.docs) {
          const data = doc.data() || {};
          if (isTargetFormatRow(tgtKey, data, doc.id)) {
            tDocs.push(doc);
          } else {
            sDocs.push(doc);
          }
        }
        sourceDocsByKey.set(srcKey, sDocs);
        targetDocsByKey.set(tgtKey, tDocs);
      }
    }

    const { candidates, sourceInventoryDigest, expectedTargetCounts, planSpec, planDigest, plan } = extractCandidatesAndPlan({
      sourceDocsByKey,
      storeKey,
      namespace,
      epoch: control.epoch,
      runId: migrationRunId,
      codeSha,
      codeArtifact,
      packageIntegrity,
      protocolDigest,
      assemblyDigest,
      indexSchemaDigest,
      now: Date.now(),
    });

    timer.assertUnderDeadline(16_000, 'Preflight scan');

    let prospectiveRetained = 0;
    for (const [colKey, docs] of targetDocsByKey.entries()) {
      for (const d of docs) {
        if (isTargetFormatRow(colKey, d.data(), d.id)) {
          prospectiveRetained++;
        }
      }
    }

    const preflight = computePreflightSummaryFromPlan(plan, sourceInventoryDigest, planDigest);
    const prospectiveWritten = Object.values(expectedTargetCounts).reduce((a, b) => a + b, 0);

    return {
      sourceInventoryDigest,
      scanned: candidates.length,
      prospectiveWritten,
      prospectiveRetained,
      planDigest,
      preflight,
    };
  });
}

export async function adoptFirestoreLegacyTokens(options: MigrationContext & {
  dryRun: boolean;
  expectedSourceInventoryDigest: string;
}): Promise<{
  scanned: number;
  migrated: number;
  skipped: number;
  errors: number;
}> {
  assertValidMigrationContext(options);
  const allowedKeys = new Set([
    'db',
    'FieldPath',
    'key',
    'namespace',
    'expectedEpoch',
    'migrationRunId',
    'codeSha',
    'codeArtifact',
    'packageIntegrity',
    'protocolDigest',
    'assemblyDigest',
    'indexSchemaDigest',
    'dryRun',
    'expectedSourceInventoryDigest',
  ]);
  for (const k of Object.keys(options)) {
    if (!allowedKeys.has(k)) {
      throw new CutoverFenceError(`Unknown option '${k}' passed to adoptFirestoreLegacyTokens`);
    }
  }

  if (typeof options.dryRun !== 'boolean') {
    throw new CutoverFenceError('adoptFirestoreLegacyTokens requires boolean dryRun option');
  }
  if (typeof options.expectedSourceInventoryDigest !== 'string' || !/^[0-9a-f]{64}$/.test(options.expectedSourceInventoryDigest)) {
    throw new CutoverFenceError('adoptFirestoreLegacyTokens requires 64-character lowercase hex expectedSourceInventoryDigest');
  }

  const { db, FieldPath, key, namespace, expectedEpoch, migrationRunId, codeSha, codeArtifact, packageIntegrity, protocolDigest, assemblyDigest, indexSchemaDigest, dryRun, expectedSourceInventoryDigest } = options;
  const storeKey = key;
  const docIdField = FieldPath.documentId();

  // Phase 1: Preparation in transaction (supporting restart per Section 5)
  const prepResult = await db.runTransaction(async (transaction: any) => {
    const timer = startMonotonicTimer();
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);
    if (control.epoch !== expectedEpoch) {
      throw new CutoverFenceError(`Epoch mismatch in adopt: expected ${expectedEpoch}, got ${control.epoch}`);
    }

    const { source: sourceNames, target: targetNames } = getCutoverDistinctCollectionNames(namespace);
    const distinctColNames = Array.from(new Set([...Object.values(sourceNames), ...Object.values(targetNames)])).sort();

    const sourceDocsByKey = new Map<string, any[]>();
    for (const k of PHYSICAL_COUNT_KEYS) sourceDocsByKey.set(k, []);

    const sourcePhysicalToKey: Record<string, string> = {};
    for (const [k, name] of Object.entries(sourceNames)) sourcePhysicalToKey[name] = k;
    const targetPhysicalToKey: Record<string, string> = {};
    for (const [k, name] of Object.entries(targetNames)) targetPhysicalToKey[name] = k;

    for (const colName of distinctColNames) {
      const q = typeof db.collection(colName).orderBy === 'function'
        ? db.collection(colName).orderBy(docIdField)
        : db.collection(colName);
      const snap = await transaction.get(q);
      const isSourceCol = colName in sourcePhysicalToKey;
      const isTargetCol = colName in targetPhysicalToKey;

      if (isSourceCol && !isTargetCol) {
        const colKey = sourcePhysicalToKey[colName];
        sourceDocsByKey.set(colKey, snap.docs);
      } else if (isSourceCol && isTargetCol) {
        const srcKey = sourcePhysicalToKey[colName];
        const tgtKey = targetPhysicalToKey[colName];
        const sDocs = [];
        for (const doc of snap.docs) {
          const data = doc.data() || {};
          if (!isTargetFormatRow(tgtKey, data, doc.id)) {
            sDocs.push(doc);
          }
        }
        sourceDocsByKey.set(srcKey, sDocs);
      }
    }

    const { candidates, sourceInventoryDigest, plan } = extractCandidatesAndPlan({
      sourceDocsByKey,
      storeKey,
      namespace,
      epoch: control.epoch,
      runId: migrationRunId,
      codeSha,
      codeArtifact,
      packageIntegrity,
      protocolDigest,
      assemblyDigest,
      indexSchemaDigest,
      now: Date.now(),
    });

    // Restart/resumption check per Section 5
    if (control.state === 'migrating') {
      if (control.migrationRunId !== migrationRunId) {
        throw new CutoverFenceError(`Cannot resume migration for namespace ${namespace}: migrationRunId mismatch`);
      }
      const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${control.epoch}`);
      const prepSnap = await transaction.get(prepRef);
      if (!prepSnap.exists) {
        throw new CutoverFenceError(`Prepared manifest missing during resume of migrating namespace ${namespace}`);
      }
      const prepDoc = prepSnap.data();
      timer.assertUnderDeadline(16_000, 'Preparation resume check');
      return {
        dryRun: false,
        isResume: true,
        candidates,
        prepared: prepDoc,
        planSpec: prepDoc.planSpec,
      };
    }

    if (control.state !== 'fenced') {
      throw new CutoverRefusedError(`Cannot adopt: cutover state is '${control.state}', expected 'fenced'`, {
        cutoverState: control.state,
        epoch: control.epoch,
      });
    }

    if (sourceInventoryDigest !== expectedSourceInventoryDigest) {
      throw new CutoverFenceError(
        `Source inventory digest mismatch: expected ${expectedSourceInventoryDigest}, observed ${sourceInventoryDigest}`,
      );
    }

    if (dryRun) {
      timer.assertUnderDeadline(16_000, 'Dry run inspection');
      return {
        dryRun: true,
        scanned: candidates.length,
        migrated: 0,
        skipped: 0,
        errors: 0,
      };
    }

    timer.assertUnderDeadline(16_000, 'Preparation attempt');

    // Write prepared manifest + transition control to migrating
    await prepareMigrationInTransaction(transaction, db, {
      namespace,
      prepDoc: plan.prepared,
      storeKey,
      FieldPath,
    });

    timer.assertUnderDeadline(16_000, 'Preparation commit');

    return {
      dryRun: false,
      isResume: false,
      candidates,
      plan,
      prepared: plan.prepared,
    };
  });

  if (prepResult.dryRun) {
    return {
      scanned: prepResult.scanned,
      migrated: prepResult.migrated,
      skipped: prepResult.skipped,
      errors: prepResult.errors,
    };
  }

  const { candidates, prepared } = prepResult;
  const now = Date.now();
  let migratedCount = 0;
  let skippedCount = 0;

  // Phase 2: Execute each item in its own atomic transaction with exact receipt and latch
  for (const c of candidates) {
    const itemResult = await db.runTransaction(async (transaction: any) => {
      const timer = startMonotonicTimer();
      const control = await readCutoverFenceInTransaction(transaction, db, namespace);
      if (control.state !== 'migrating') {
        throw new CutoverFenceError(`Cannot execute item: state must be 'migrating', got '${control.state}'`);
      }
      if (control.migrationRunId !== migrationRunId) {
        throw new CutoverFenceError('migrationRunId mismatch during item transaction');
      }

      const colMap: Record<string, string> = {
        families: `${namespace}_tokens_refresh_families`,
        tokens: `${namespace}_tokens`,
        refresh: `${namespace}_tokens_refresh`,
        upstream: `${namespace}_tokens_upstream`,
        authCodes: `${namespace}_auth_codes`,
        resumeTokens: `${namespace}_resume_tokens`,
        oauthClients: `${namespace}_oauth_clients`,
        clients: `${namespace}_clients`,
      };

      const targetColMap: Record<string, string> = {
        families: `${namespace}_refresh_families`,
        tokens: `${namespace}_sessions`,
        refresh: `${namespace}_refresh`,
        upstream: `${namespace}_upstream`,
        authCodes: `${namespace}_auth_codes`,
        resumeTokens: `${namespace}_resume_tokens`,
        oauthClients: `${namespace}_oauth_clients`,
        retiredRefreshTokens: `${namespace}_retired_refresh`,
      };

      // Check existing receipt (idempotency/restart) with postimage verification
      const receiptRef = db.collection(`${namespace}_meta`).doc(`migration_receipt_${control.epoch}_${c.id}`);
      const receiptSnap = await transaction.get(receiptRef);
      if (receiptSnap.exists) {
        const rData = receiptSnap.data();
        if (rData && rData.candidateId === c.id && rData.kind === 'receipt') {
          validateReceipt(rData, namespace, control.epoch, control.migrationRunId);
          // Verify that all targets from receipt exist in Firestore matching targetAfter digests
          for (const t of rData.targetAfter) {
            const physicalCol = targetColMap[t.collection];
            if (physicalCol) {
              const post = c.postimageByTargetId?.get(t.id);
              const docId = post?.id || post?.code || post?.client_id || post?.fingerprint || t.rawId;
              const targetSnap = await transaction.get(db.collection(physicalCol).doc(docId));
              if (!targetSnap.exists) {
                throw new CutoverFenceError(`Receipt exists for ${sanitizeId(c.id)} but target '${t.collection}/${sanitizeId(docId)}' missing in Firestore`);
              }
              const recDigest = computeTargetRecordDigest(storeKey, namespace, control.epoch, t.collection, t.id, targetSnap.data());
              if (recDigest !== t.recordDigest) {
                throw new CutoverFenceError(`Receipt exists for ${sanitizeId(c.id)} but target '${t.collection}/${sanitizeId(docId)}' recordDigest mismatch`);
              }
            }
          }
          timer.assertUnderDeadline(16_000, 'Item retry check');
          return { status: rData.disposition === 'retained' ? 'retained' : 'written' };
        }
      }

      // Read source documents and verify preimages
      for (const s of c.sources) {
        const physicalCol = colMap[s.collection];
        if (physicalCol && s.rawId) {
          const docSnap = await transaction.get(db.collection(physicalCol).doc(s.rawId));
          if (!docSnap.exists) {
            throw new CutoverFenceError(`Source document '${s.collection}/${sanitizeId(s.rawId)}' disappeared concurrently`);
          }
          const recDigest = computeSourceRecordDigest(storeKey, namespace, control.epoch, s.collection, s.id, docSnap.data() || {});
          if (recDigest !== s.recordDigest) {
            throw new CutoverFenceError(`Source document '${s.collection}/${sanitizeId(s.rawId)}' modified concurrently after preparation`);
          }
        }
      }

      // Fail before any buffered delete unless every target postimage is present
      for (const t of c.targets) {
        const post = c.postimageByTargetId?.get(t.id);
        const physicalCol = targetColMap[t.collection];
        if (!post || !physicalCol) {
          throw new CutoverFenceError(`Missing prospective target postimage or mapping for target ${t.collection}:${sanitizeId(t.id)}`);
        }
      }

      // Check retained path: read target documents first before overwrite
      let allTargetsAlreadyRetained = true;
      for (const t of c.targets) {
        const post = c.postimageByTargetId.get(t.id);
        const physicalCol = targetColMap[t.collection];
        const docId = post.id || post.code || post.client_id || post.fingerprint || t.rawId;
        const targetSnap = await transaction.get(db.collection(physicalCol).doc(docId));
        if (!targetSnap.exists) {
          allTargetsAlreadyRetained = false;
        } else {
          const existingDigest = computeTargetRecordDigest(storeKey, namespace, control.epoch, t.collection, t.id, targetSnap.data());
          const postDigest = computeTargetRecordDigest(storeKey, namespace, control.epoch, t.collection, t.id, post);
          if (existingDigest !== postDigest) {
            allTargetsAlreadyRetained = false;
          }
        }
      }

      timer.assertUnderDeadline(16_000, 'Item transaction attempt');

      // Call irreversible latch before first v3 target write
      if (control.emptyNamespace !== true) {
        await markIrreversibleInTransaction(transaction, db, namespace, control.epoch, migrationRunId, () => now);
      }

      // Execute source actions (deletions / replacements)
      for (const sa of c.sourceActions) {
        const physicalCol = colMap[sa.collection];
        if (physicalCol && sa.rawId && sa.action === 'delete') {
          transaction.delete(db.collection(physicalCol).doc(sa.rawId));
        }
      }

      // Write target documents if not already completely retained
      if (!allTargetsAlreadyRetained) {
        for (const t of c.targets) {
          const post = c.postimageByTargetId.get(t.id);
          const physicalCol = targetColMap[t.collection];
          const docId = post.id || post.code || post.client_id || post.fingerprint || t.rawId;
          transaction.set(db.collection(physicalCol).doc(docId), post);
        }
      }

      // Write exact receipt
      const targetAfter = c.targets.map((t: any) => {
        const post = c.postimageByTargetId.get(t.id);
        const recDigest = computeTargetRecordDigest(storeKey, namespace, control.epoch, t.collection, t.id, post);
        return { collection: t.collection, id: t.id, recordDigest: recDigest };
      });

      const sourceAfter = c.sources.map((s: any) => {
        const sa = c.sourceActions?.find((a: any) => a.collection === s.collection && a.id === s.id);
        return {
          collection: s.collection,
          id: s.id,
          recordDigest: (sa?.action === 'delete' || sa?.action === 'replace') ? null : s.recordDigest,
        };
      });

      const disposition = allTargetsAlreadyRetained ? ('retained' as const) : ('written' as const);

      const receiptDoc = {
        schemaVersion: 2,
        namespace,
        epoch: control.epoch,
        migrationRunId,
        codeSha,
        codeArtifact,
        packageIntegrity,
        protocolDigest,
        assemblyDigest,
        indexSchemaDigest,
        encoderVersion: 1,
        planDigest: prepared.planDigest,
        kind: 'receipt',
        preparedDigest: D('prepared', namespace, control.epoch, prepared),
        candidateId: c.id,
        candidateDigest: D('candidate', namespace, control.epoch, c.commitment || c),
        disposition,
        sourceAfter,
        targetAfter,
        logicalDigest: c.logicalDigest,
        completedAt: now,
      };

      transaction.set(receiptRef, receiptDoc);
      timer.assertUnderDeadline(16_000, 'Item transaction commit');
      return { status: disposition };
    });

    if (itemResult.status === 'retained') {
      skippedCount++;
    } else {
      migratedCount++;
    }
  }

  // Phase 3: Finalization transaction (reads actual targets and receipts, writes final & marker, transitions to v3_ready)
  await db.runTransaction(async (transaction: any) => {
    const timer = startMonotonicTimer();
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);
    if (control.state !== 'migrating') {
      throw new CutoverFenceError(`Cannot finalize: state must be 'migrating', got '${control.state}'`);
    }

    // Read all receipts
    const receiptsCol = db.collection(`${namespace}_meta`);
    const lowerBound = `migration_receipt_${control.epoch}_`;
    const upperBound = `migration_receipt_${control.epoch}\``;
    const receiptsSnap = await transaction.get(receiptsCol.orderBy(docIdField).startAt(lowerBound).endBefore(upperBound));
    const actualReceipts = receiptsSnap.docs.map((d: any) => d.data());

    // Read all target collections to compute targetInventoryDigest
    const targetDescriptors: Array<{ collection: string; id: string; recordDigest: string }> = [];

    const targetPhysicalToKey: Record<string, string> = {
      [`${namespace}_refresh_families`]: 'families',
      [`${namespace}_sessions`]: 'tokens',
      [`${namespace}_refresh`]: 'refresh',
      [`${namespace}_upstream`]: 'upstream',
      [`${namespace}_auth_codes`]: 'authCodes',
      [`${namespace}_resume_tokens`]: 'resumeTokens',
      [`${namespace}_retired_refresh`]: 'retiredRefreshTokens',
      [`${namespace}_oauth_clients`]: 'oauthClients',
    };

    for (const [physicalName, colKey] of Object.entries(targetPhysicalToKey)) {
      const snap = await transaction.get(db.collection(physicalName).orderBy(docIdField));
      for (const d of snap.docs) {
        const data = d.data() || {};
        const targetId = computeKeyedDocId(storeKey, 'target-id', namespace, control.epoch, colKey, d.id);
        const recDigest = computeTargetRecordDigest(storeKey, namespace, control.epoch, colKey, targetId, data);
        targetDescriptors.push({ collection: colKey, id: targetId, recordDigest: recDigest });
      }
    }
    targetDescriptors.sort(compareDescriptors);

    const targetInventoryDigest = computeTargetInventoryDigest(storeKey, namespace, control.epoch, targetDescriptors);
    const receiptSetDigest = computeReceiptSetDigest(actualReceipts, namespace, control.epoch);

    const finalDoc = {
      schemaVersion: 2,
      namespace,
      epoch: control.epoch,
      migrationRunId,
      codeSha,
      codeArtifact,
      packageIntegrity,
      protocolDigest,
      assemblyDigest,
      indexSchemaDigest,
      encoderVersion: 1,
      planDigest: prepared.planDigest,
      kind: 'final',
      preparedDigest: D('prepared', namespace, control.epoch, prepared),
      completedAt: Date.now(),
      physicalCounts: prepared.physicalCounts,
      classifications: prepared.classifications,
      reasons: prepared.reasons,
      totalPhysicalRecords: prepared.totalPhysicalRecords,
      targetCounts: prepared.expectedTargetCounts,
      scanned: candidates.length,
      migrated: migratedCount,
      skipped: skippedCount,
      errors: 0,
      sourceInventoryDigest: prepared.sourceInventoryDigest,
      targetInventoryDigest,
      sourceLogicalDigest: prepared.sourceLogicalDigest,
      targetLogicalDigest: prepared.sourceLogicalDigest,
      receiptSetDigest,
      ...(prepared.totalPhysicalRecords > 0 ? {
        projectorId: PROJECTOR_ID,
        projectorVersion: PROJECTOR_VERSION,
        projectorDigest: getMeasuredProjectorDigest(),
      } : {}),
    };

    const finalManifestDigest = D('final', namespace, control.epoch, finalDoc);

    const markerDoc = {
      schemaVersion: 2,
      namespace,
      epoch: control.epoch,
      migrationRunId,
      codeSha,
      codeArtifact,
      packageIntegrity,
      protocolDigest,
      assemblyDigest,
      indexSchemaDigest,
      encoderVersion: 1,
      planDigest: prepared.planDigest,
      kind: 'ownership',
      preparedDigest: D('prepared', namespace, control.epoch, prepared),
      migrationManifestDigest: finalManifestDigest,
      emptyNamespace: prepared.totalPhysicalRecords === 0,
      adoptedAt: Date.now(),
      ...(prepared.totalPhysicalRecords > 0 ? {
        projectorId: PROJECTOR_ID,
        projectorVersion: PROJECTOR_VERSION,
        projectorDigest: getMeasuredProjectorDigest(),
      } : {}),
    };

    timer.assertUnderDeadline(16_000, 'Finalization attempt');

    await finalizeMigrationInTransaction(transaction, db, {
      namespace,
      finalDoc,
      markerDoc,
      storeKey,
      FieldPath,
    });

    timer.assertUnderDeadline(16_000, 'Finalization commit');
  });

  return {
    scanned: candidates.length,
    migrated: migratedCount,
    skipped: skippedCount,
    errors: 0,
  };
}

export async function activateFirestoreMigration(context: MigrationContext): Promise<{
  status: 'activated' | 'already_active';
  epoch: number;
  migrationRunId: string;
  migrationManifestDigest: string;
  planDigest: string;
}> {
  assertValidMigrationContext(context);
  const allowedKeys = new Set([
    'db',
    'FieldPath',
    'key',
    'namespace',
    'expectedEpoch',
    'migrationRunId',
    'codeSha',
    'codeArtifact',
    'packageIntegrity',
    'protocolDigest',
    'assemblyDigest',
    'indexSchemaDigest',
  ]);
  for (const k of Object.keys(context)) {
    if (!allowedKeys.has(k)) {
      throw new CutoverFenceError(`Unknown option '${k}' passed to activateFirestoreMigration`);
    }
  }

  const { db, namespace, expectedEpoch, migrationRunId, key } = context;

  return await db.runTransaction(async (transaction: any) => {
    const timer = startMonotonicTimer();
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);

    // Read final manifest internally per Section 6
    const finalRef = db.collection(`${namespace}_meta`).doc(`migration_manifest_${expectedEpoch}`);
    const finalSnap = await transaction.get(finalRef);

    let migrationManifestDigest = control.migrationManifestDigest;
    let planDigest = '';

    if (finalSnap.exists) {
      const f = finalSnap.data();
      migrationManifestDigest = D('final', namespace, expectedEpoch, f);
      planDigest = f.planDigest || '';
    }

    if (control.state === 'v3_active') {
      if (control.epoch !== expectedEpoch) {
        throw new CutoverFenceError(`Epoch mismatch for namespace ${namespace}: expected ${expectedEpoch}, got ${control.epoch}`);
      }
      if (control.migrationRunId && control.migrationRunId !== migrationRunId) {
        throw new CutoverFenceError(`migrationRunId mismatch for namespace ${namespace}: expected ${migrationRunId}, got ${control.migrationRunId}`);
      }
      timer.assertUnderDeadline(16_000, 'Activation check');
      const res = await activateMigrationInTransaction(transaction, db, {
        ...context,
        storeKey: key,
        migrationManifestDigest: migrationManifestDigest || control.migrationManifestDigest,
      });
      timer.assertUnderDeadline(16_000, 'Activation check commit');
      return {
        status: 'already_active',
        epoch: control.epoch,
        migrationRunId: control.migrationRunId || migrationRunId,
        migrationManifestDigest: control.migrationManifestDigest || migrationManifestDigest || '',
        planDigest,
      };
    }

    if (control.state !== 'v3_ready') {
      throw new CutoverFenceError(`Cannot activate namespace ${namespace}: state must be v3_ready, got ${control.state}`);
    }

    timer.assertUnderDeadline(16_000, 'Activation attempt');

    const res = await activateMigrationInTransaction(transaction, db, {
      ...context,
      storeKey: key,
      migrationManifestDigest: migrationManifestDigest || control.migrationManifestDigest,
    });

    timer.assertUnderDeadline(16_000, 'Activation commit');

    return {
      status: 'activated',
      epoch: control.epoch,
      migrationRunId,
      migrationManifestDigest: res.control?.migrationManifestDigest || migrationManifestDigest || '',
      planDigest,
    };
  });
}

export async function getFirestoreMigrationStatus(context: MigrationContext): Promise<{
  state: string;
  epoch: number;
  migrationRunId?: string;
  migrationManifestDigest?: string;
  planDigest?: string;
  sourceInventoryDigest?: string;
}> {
  assertValidMigrationContext(context);
  const allowedKeys = new Set([
    'db',
    'FieldPath',
    'key',
    'namespace',
    'expectedEpoch',
    'migrationRunId',
    'codeSha',
    'codeArtifact',
    'packageIntegrity',
    'protocolDigest',
    'assemblyDigest',
    'indexSchemaDigest',
  ]);
  for (const k of Object.keys(context)) {
    if (!allowedKeys.has(k)) {
      throw new CutoverFenceError(`Unknown option '${k}' passed to getFirestoreMigrationStatus`);
    }
  }

  const { db, namespace, expectedEpoch, migrationRunId, codeArtifact, protocolDigest } = context;

  return await db.runTransaction(async (transaction: any) => {
    const timer = startMonotonicTimer();
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);

    let planDigest: string | undefined;
    let sourceInventoryDigest: string | undefined;

    if (control.state === 'v3_ready' || control.state === 'v3_active') {
      if (control.epoch !== expectedEpoch) {
        throw new CutoverFenceError(`Status epoch mismatch: expected ${expectedEpoch}, got ${control.epoch}`);
      }
      const markerRef = db.collection(`${namespace}_meta`).doc('v2_adopted');
      const markerSnap = await transaction.get(markerRef);
      if (!markerSnap.exists) {
        throw new CutoverFenceError('Immutable migration marker missing at v2_adopted');
      }
      const marker = markerSnap.data();
      validateMigrationIdentityFields(marker, namespace, expectedEpoch, migrationRunId);
      if (marker.codeArtifact !== codeArtifact || marker.protocolDigest !== protocolDigest) {
        throw new CutoverFenceError('Immutable migration marker artifact/protocolDigest mismatch');
      }

      const finalRef = db.collection(`${namespace}_meta`).doc(`migration_manifest_${control.epoch}`);
      const finalSnap = await transaction.get(finalRef);
      if (finalSnap.exists) {
        const f = finalSnap.data() as Record<string, unknown>;
        planDigest = f.planDigest as string | undefined;
        sourceInventoryDigest = f.sourceInventoryDigest as string | undefined;
      }
    }

    timer.assertUnderDeadline(16_000, 'Status check');

    return {
      state: control.state,
      epoch: control.epoch,
      migrationRunId: control.migrationRunId,
      migrationManifestDigest: control.migrationManifestDigest,
      planDigest,
      sourceInventoryDigest,
    };
  });
}
