import { createHash, randomUUID } from 'node:crypto';
import { createCodec, type Codec } from './codec.js';
import {
  accessAad,
  familyAad,
  upstreamAad,
  codeUnitCompare,
  compareDescriptors,
  safeDocEntry,
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
  computeKeyedDocId,
  computeSourceRecordDigest,
  computeSourceInventoryDigest,
  computeLogicalInventoryDigest,
  computeCandidateId,
  computeCandidateLogicalDigest,
  computeEstimatedFirestoreDocSize,
  prepareMigrationInTransaction,
  finalizeMigrationInTransaction,
  activateMigrationInTransaction,
  getCutoverDistinctCollectionNames,
  isTargetFormatRow,
} from './cutover-protocol.mjs';
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
  assemblyDigest?: string;
  indexSchemaDigest?: string;
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
  ];
  for (const field of requiredFields) {
    if (opts[field] === undefined || opts[field] === null) {
      throw new CutoverFenceError(\`MigrationContext missing required field: \${field}\`);
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
  assemblyDigest?: string;
  indexSchemaDigest?: string;
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
    now,
  } = params;

  const assemblyDigest = params.assemblyDigest || protocolDigest;
  const indexSchemaDigest = params.indexSchemaDigest || protocolDigest;

  const codec = createCodec(storeKey);

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

  // 1. Process families
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
    const retiredFingerprints = Array.from(new Set(rawRetired.filter((fp: unknown) => typeof fp === 'string' && fp.length > 0)));

    let retiredConflict = false;
    for (const fp of retiredFingerprints) {
      if (claimedRetiredFingerprints.has(fp)) {
        reasons.conflictingClaims++;
        retiredConflict = true;
        break;
      }
      claimedRetiredFingerprints.add(fp);
    }
    if (retiredConflict) continue;

    const newAccessId = codec.id('session', accessId);
    const newRefreshId = codec.id('refresh', currentRefId);

    const candSources = [
      {
        collection: 'families',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'families', familyId),
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'families', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'families', familyId), famData),
      },
      {
        collection: 'refresh',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'refresh', currentRefId),
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'refresh', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'refresh', currentRefId), curRefDoc),
      },
      {
        collection: 'upstream',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'upstream', familyId),
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'upstream', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'upstream', familyId), upstreamById.get(familyId)),
      },
      {
        collection: 'tokens',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'tokens', accessId),
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'tokens', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'tokens', accessId), tokensById.get(accessId) || {}),
      },
    ];

    if (famData.previousRefreshToken) {
      const prevId = famData.previousRefreshToken;
      const prevDoc = refreshById.get(prevId) || {};
      candSources.push({
        collection: 'refresh',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'refresh', prevId),
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'refresh', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'refresh', prevId), prevDoc),
      });
    }

    candSources.sort(compareDescriptors);

    const candTargets = [
      { collection: 'families', id: computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'families', familyId) },
      { collection: 'tokens', id: computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'tokens', newAccessId) },
      { collection: 'refresh', id: computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'refresh', newRefreshId) },
      { collection: 'upstream', id: computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'upstream', familyId) },
    ];
    if (famData.previousRefreshToken) {
      const prevRefTargetId = codec.id('refresh', famData.previousRefreshToken);
      candTargets.push({ collection: 'refresh', id: computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'refresh', prevRefTargetId) });
    }
    for (const fp of retiredFingerprints) {
      candTargets.push({ collection: 'retiredRefreshTokens', id: computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'retiredRefreshTokens', fp) });
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
    const upRow = encodeUpstreamRow(codec, familyId, grantVersion, logicalProjection, now);
    const refRow = encodeRefreshRow(newRefreshId, familyId, generation, now);
    const accRow = encodeSessionsRow(codec, newAccessId, familyId, logicalProjection, now);

    const targetDocsMap = new Map();
    targetDocsMap.set('refreshFamilies', famRow);
    targetDocsMap.set('upstreamGrants', upRow);
    targetDocsMap.set('refreshTokens', refRow);
    targetDocsMap.set('sessions', accRow);

    const targetPostimageByTargetId = new Map();
    targetPostimageByTargetId.set(candTargets[0].id, famRow);
    targetPostimageByTargetId.set(candTargets[1].id, accRow);
    targetPostimageByTargetId.set(candTargets[2].id, refRow);
    targetPostimageByTargetId.set(candTargets[3].id, upRow);

    if (famData.previousRefreshToken) {
      const prevRefreshId = codec.id('refresh', famData.previousRefreshToken);
      const prevRefDoc = refreshById.get(famData.previousRefreshToken) || {};
      const prevRefreshRow = {
        id: prevRefreshId,
        familyId,
        status: 'consumed',
        generation: Math.max(1, generation - 1),
        consumedAt: prevRefDoc.consumedAt || now,
        successorSealed: codec.seal({ accessToken: accessId, refreshToken: currentRefId }, \`successor:\${prevRefreshId}\`),
      };
      targetDocsMap.set('prevRefreshTokens', prevRefreshRow);
      const prevTgtId = computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'refresh', prevRefreshId);
      targetPostimageByTargetId.set(prevTgtId, prevRefreshRow);
    }

    for (const fp of retiredFingerprints) {
      const retRow = {
        fingerprint: fp,
        familyId,
        retiredAt: now,
      };
      const retTgtId = computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'retiredRefreshTokens', fp);
      targetPostimageByTargetId.set(retTgtId, retRow);
    }

    // Verify logical projection equivalence
    const targetLogicalProjection = projectTargetLogical(
      { id: candidateId, kind: 'pr56Families', sources: candSources, targets: candTargets, logicalDigest: '' },
      targetDocsMap,
      codec,
    );
    if (C(logicalProjection) !== C(targetLogicalProjection)) {
      throw new CutoverFenceError(\`Logical projection equivalence check failed for candidate \${candidateId}\`);
    }

    // Order postimages strictly matching candTargets order
    const prospectiveTargetPostimages = candTargets.map((t) => {
      const post = targetPostimageByTargetId.get(t.id);
      if (!post) throw new CutoverFenceError(\`Missing prospective target postimage for target \${t.collection}:\${t.id}\`);
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
      prospectiveTargetPostimages,
      sourceActions: candSources.map((s) => ({ collection: s.collection, id: s.id, action: 'delete' })),
      targetRows: {
        refreshFamilies: famRow,
        upstreamGrants: upRow,
        refreshTokens: refRow,
        sessions: accRow,
      },
    });
  }

  // 2. Process auth_codes
  for (const codeDoc of authCodesDocs) {
    const codeId = codeDoc.id;
    const cData = codeDoc.data() || {};
    const candSources = [
      {
        collection: 'authCodes',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'authCodes', codeId),
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'authCodes', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'authCodes', codeId), cData),
      },
    ];
    const candTargets = [
      { collection: 'authCodes', id: computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'authCodes', codeId) },
    ];
    const sortedSourceIds = candSources.map((s) => s.id).sort(codeUnitCompare);
    const candidateId = computeCandidateId(storeKey, namespace, epoch, 'authCodes', sortedSourceIds);

    const sourcesMap = new Map();
    sourcesMap.set('authCodes', safeDocEntry(codeId, cData));

    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: 'authCodes', sources: candSources, targets: candTargets, logicalDigest: '' },
      sourcesMap,
      codec,
    );
    const logicalDigest = computeCandidateLogicalDigest(storeKey, namespace, epoch, 'authCodes', logicalProjection);

    const codeRow = encodeAuthCodesRow(codeId, logicalProjection, now);
    const prospectiveTargetPostimages = [codeRow];

    const targetDocsMap = new Map();
    targetDocsMap.set('authCodes', codeRow);
    const targetLogicalProjection = projectTargetLogical(
      { id: candidateId, kind: 'authCodes', sources: candSources, targets: candTargets, logicalDigest: '' },
      targetDocsMap,
      codec,
    );
    if (C(logicalProjection) !== C(targetLogicalProjection)) {
      throw new CutoverFenceError(\`Logical projection equivalence check failed for authCode \${candidateId}\`);
    }

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
      prospectiveTargetPostimages,
      sourceActions: [{ collection: 'authCodes', id: candSources[0].id, action: 'replace' }],
      targetRows: { authCodes: codeRow },
    });
  }

  // 3. Process resume_tokens
  for (const resDoc of resumeDocs) {
    const resId = resDoc.id;
    const rData = resDoc.data() || {};
    const candSources = [
      {
        collection: 'resumeTokens',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'resumeTokens', resId),
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'resumeTokens', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'resumeTokens', resId), rData),
      },
    ];
    const candTargets = [
      { collection: 'resumeTokens', id: computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'resumeTokens', resId) },
    ];
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

    const resRow = encodeResumeTokensRow(resId, logicalProjection, now);
    const prospectiveTargetPostimages = [resRow];

    const targetDocsMap = new Map();
    targetDocsMap.set('resumeTokens', resRow);
    const targetLogicalProjection = projectTargetLogical(
      { id: candidateId, kind: 'resumeTokens', sources: candSources, targets: candTargets, logicalDigest: '' },
      targetDocsMap,
      codec,
    );
    if (C(logicalProjection) !== C(targetLogicalProjection)) {
      throw new CutoverFenceError(\`Logical projection equivalence check failed for resumeToken \${candidateId}\`);
    }

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
      prospectiveTargetPostimages,
      sourceActions: [{ collection: 'resumeTokens', id: candSources[0].id, action: 'replace' }],
      targetRows: { resumeTokens: resRow },
    });
  }

  // 4. Process oauth_clients / clients
  const clientDocsMap = new Map<string, any>();
  for (const doc of clientsDocs) clientDocsMap.set(doc.id, doc.data() || {});
  for (const doc of oauthClientsDocs) clientDocsMap.set(doc.id, doc.data() || {});

  for (const [clientId, cData] of clientDocsMap.entries()) {
    const candSources = [
      {
        collection: 'oauthClients',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'oauthClients', clientId),
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'oauthClients', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'oauthClients', clientId), cData),
      },
    ];
    const candTargets = [
      { collection: 'oauthClients', id: computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'oauthClients', clientId) },
    ];
    const sortedSourceIds = candSources.map((s) => s.id).sort(codeUnitCompare);
    const candidateId = computeCandidateId(storeKey, namespace, epoch, 'clients', sortedSourceIds);

    const sourcesMap = new Map();
    sourcesMap.set('clients', safeDocEntry(clientId, cData));

    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: 'clients', sources: candSources, targets: candTargets, logicalDigest: '' },
      sourcesMap,
      codec,
    );
    const logicalDigest = computeCandidateLogicalDigest(storeKey, namespace, epoch, 'clients', logicalProjection);

    const clientRow = encodeOAuthClientsRow(clientId, logicalProjection, now);
    const prospectiveTargetPostimages = [clientRow];

    const targetDocsMap = new Map();
    targetDocsMap.set('oauthClients', clientRow);
    const targetLogicalProjection = projectTargetLogical(
      { id: candidateId, kind: 'clients', sources: candSources, targets: candTargets, logicalDigest: '' },
      targetDocsMap,
      codec,
    );
    if (C(logicalProjection) !== C(targetLogicalProjection)) {
      throw new CutoverFenceError(\`Logical projection equivalence check failed for client \${candidateId}\`);
    }

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
      prospectiveTargetPostimages,
      sourceActions: [{ collection: 'oauthClients', id: candSources[0].id, action: 'replace' }],
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

  // Construct planSpec and planDigest per Section 5
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
      sourceActions: candidates[idx].sourceActions,
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
      projectorDigest: protocolDigest,
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
      preparedDigest: '0'.repeat(64),
      candidateId: c.id,
      candidateDigest: '0'.repeat(64),
      disposition: 'written',
      sourceAfter: c.sources.map((s: any) => ({ collection: s.collection, id: s.id, recordDigest: s.recordDigest })),
      targetAfter: c.targets.map((t: any) => ({ collection: t.collection, id: t.id, recordDigest: '0'.repeat(64) })),
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
      sourceActions: c.sourceActions,
      receiptUpperBound,
      transaction: {
        estimatedCommitBytes: Math.max(100, itemCommitBytes),
        estimatedReadDurationMs: 50,
      },
    };
  });

  const finalUpperBound = {
    ...prepared,
    kind: 'final',
    completedAt: now,
    targetCounts: expectedTargetCounts,
    migrated: candidateCommitments.length,
    skipped: 0,
    errors: 0,
    targetInventoryDigest: '0'.repeat(64),
    targetLogicalDigest: sourceLogicalDigest,
    receiptSetDigest: '0'.repeat(64),
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
    adoptedAt: now,
    migrationManifestDigest: '0'.repeat(64),
    sourceInventoryDigest,
    targetInventoryDigest: '0'.repeat(64),
    scanned: candidateCommitments.length,
    migrated: candidateCommitments.length,
    skipped: 0,
    errors: 0,
    targetCounts: expectedTargetCounts,
    ...(totalPhysicalRecords > 0 ? {
      projectorId: PROJECTOR_ID,
      projectorVersion: PROJECTOR_VERSION,
      projectorDigest: protocolDigest,
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
  let indexEntries = (countIndexMetrics as any)(plan.prepared).entries;
  let indexBytes = (countIndexMetrics as any)(plan.prepared).bytes;

  for (const item of plan.items) {
    estimatedFirestoreSize += computeEstimatedFirestoreDocSize(item.receiptUpperBound);
    depth = Math.max(depth, computeDocDepth(item.receiptUpperBound));
    indexEntries += (countIndexMetrics as any)(item.receiptUpperBound).entries;
    indexBytes += (countIndexMetrics as any)(item.receiptUpperBound).bytes;

    for (const post of item.prospectiveTargetPostimages) {
      estimatedFirestoreSize += computeEstimatedFirestoreDocSize(post);
      depth = Math.max(depth, computeDocDepth(post));
      indexEntries += (countIndexMetrics as any)(post).entries;
      indexBytes += (countIndexMetrics as any)(post).bytes;
    }
  }

  estimatedFirestoreSize += computeEstimatedFirestoreDocSize(plan.finalization.finalUpperBound);
  estimatedFirestoreSize += computeEstimatedFirestoreDocSize(plan.finalization.markerUpperBound);
  depth = Math.max(depth, computeDocDepth(plan.finalization.finalUpperBound), computeDocDepth(plan.finalization.markerUpperBound));
  indexEntries += (countIndexMetrics as any)(plan.finalization.finalUpperBound).entries + (countIndexMetrics as any)(plan.finalization.markerUpperBound).entries;
  indexBytes += (countIndexMetrics as any)(plan.finalization.finalUpperBound).bytes + (countIndexMetrics as any)(plan.finalization.markerUpperBound).bytes;

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
      throw new CutoverFenceError(\`Unknown option '\${k}' passed to inspectFirestoreLegacyMigration\`);
    }
  }

  const { db, FieldPath, key, namespace, expectedEpoch, migrationRunId, codeSha, codeArtifact, packageIntegrity, protocolDigest, assemblyDigest, indexSchemaDigest } = options;
  const storeKey = key;
  const docIdField = FieldPath.documentId();

  return await db.runTransaction(async (transaction: any) => {
    const startTime = Date.now();
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);
    if (control.epoch !== expectedEpoch) {
      throw new CutoverFenceError(\`Epoch mismatch in inspect: expected \${expectedEpoch}, got \${control.epoch}\`);
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

    const duration = Date.now() - startTime;
    if (duration > 16_000) {
      throw new CutoverFenceError(\`Preflight scan exceeded 16,000 ms lock deadline (\${duration} ms)\`);
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

    const preflight = computePreflightSummaryFromPlan(plan, sourceInventoryDigest, planDigest);
    const prospectiveWritten = Object.values(expectedTargetCounts).reduce((a, b) => a + b, 0);

    return {
      sourceInventoryDigest,
      scanned: candidates.length,
      prospectiveWritten,
      prospectiveRetained: 0,
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
      throw new CutoverFenceError(\`Unknown option '\${k}' passed to adoptFirestoreLegacyTokens\`);
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

  // Phase 1: Preparation in transaction
  const prepResult = await db.runTransaction(async (transaction: any) => {
    const startTime = Date.now();
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);
    if (control.epoch !== expectedEpoch) {
      throw new CutoverFenceError(\`Epoch mismatch in adopt: expected \${expectedEpoch}, got \${control.epoch}\`);
    }
    if (control.state !== 'fenced') {
      throw new CutoverRefusedError(\`Cannot adopt: cutover state is '\${control.state}', expected 'fenced'\`, {
        cutoverState: control.state,
        epoch: control.epoch,
      });
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

    const duration = Date.now() - startTime;
    if (duration > 16_000) {
      throw new CutoverFenceError(\`Preflight scan exceeded 16,000 ms lock deadline (\${duration} ms)\`);
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

    if (sourceInventoryDigest !== expectedSourceInventoryDigest) {
      throw new CutoverFenceError(
        \`Source inventory digest mismatch: expected \${expectedSourceInventoryDigest}, observed \${sourceInventoryDigest}\`,
      );
    }

    if (dryRun) {
      return {
        dryRun: true,
        scanned: candidates.length,
        migrated: 0,
        skipped: 0,
        errors: 0,
      };
    }

    // Write prepared manifest + transition control to migrating
    await prepareMigrationInTransaction(transaction, db, {
      namespace,
      prepDoc: plan.prepared,
      storeKey,
      FieldPath,
    });

    return {
      dryRun: false,
      candidates,
      plan,
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

  const { candidates, plan } = prepResult;
  const now = Date.now();

  // Phase 2: Execute each item in its own transaction with receipt
  for (const itemPlan of plan.items) {
    const candidate = candidates.find((c: any) => c.id === itemPlan.candidateId);
    if (!candidate) throw new CutoverFenceError(\`Candidate \${itemPlan.candidateId} missing from execution plan\`);

    await db.runTransaction(async (transaction: any) => {
      const control = await readCutoverFenceInTransaction(transaction, db, namespace);
      if (control.state !== 'migrating') {
        throw new CutoverFenceError(\`Cannot execute item: state must be 'migrating', got '\${control.state}'\`);
      }
      if (control.migrationRunId !== migrationRunId) {
        throw new CutoverFenceError('migrationRunId mismatch during item transaction');
      }

      // Write target documents
      if (candidate.kind === 'pr56Families') {
        const rows = candidate.targetRows;
        transaction.set(db.collection(\`\${namespace}_refresh_families\`).doc(rows.refreshFamilies.id), rows.refreshFamilies);
        transaction.set(db.collection(\`\${namespace}_upstream\`).doc(rows.upstreamGrants.id), rows.upstreamGrants);
        transaction.set(db.collection(\`\${namespace}_refresh\`).doc(rows.refreshTokens.id), rows.refreshTokens);
        transaction.set(db.collection(\`\${namespace}_sessions\`).doc(rows.sessions.id), rows.sessions);
      } else if (candidate.kind === 'authCodes') {
        transaction.set(db.collection(\`\${namespace}_auth_codes\`).doc(candidate.targetRows.authCodes.code), candidate.targetRows.authCodes);
      } else if (candidate.kind === 'resumeTokens') {
        transaction.set(db.collection(\`\${namespace}_resume_tokens\`).doc(candidate.targetRows.resumeTokens.id), candidate.targetRows.resumeTokens);
      } else if (candidate.kind === 'clients') {
        transaction.set(db.collection(\`\${namespace}_oauth_clients\`).doc(candidate.targetRows.oauthClients.client_id), candidate.targetRows.oauthClients);
      }

      // Write receipt
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
        planDigest: plan.prepared.planDigest,
        kind: 'receipt',
        preparedDigest: D('manifest', namespace, control.epoch, plan.prepared),
        candidateId: candidate.id,
        candidateDigest: D('candidate', namespace, control.epoch, candidate),
        disposition: 'written',
        sourceAfter: candidate.sources.map((s: any) => ({ collection: s.collection, id: s.id, recordDigest: s.recordDigest })),
        targetAfter: candidate.targets.map((t: any) => ({ collection: t.collection, id: t.id, recordDigest: '0'.repeat(64) })),
        logicalDigest: candidate.logicalDigest,
        completedAt: now,
      };

      const receiptRef = db.collection(\`\${namespace}_meta\`).doc('cutover_fence').collection('operations').doc(\`receipt_\${candidate.id}\`);
      transaction.set(receiptRef, receiptDoc);
    });
  }

  // Phase 3: Finalization transaction
  await db.runTransaction(async (transaction: any) => {
    const finalDoc = {
      ...plan.prepared,
      kind: 'final',
      completedAt: Date.now(),
      targetCounts: plan.prepared.expectedTargetCounts,
      migrated: candidates.length,
      skipped: 0,
      errors: 0,
      targetInventoryDigest: '0'.repeat(64),
      targetLogicalDigest: plan.prepared.sourceLogicalDigest,
      receiptSetDigest: '0'.repeat(64),
    };

    const finalManifestDigest = D('manifest', namespace, expectedEpoch, finalDoc);

    const markerDoc = {
      schemaVersion: 2,
      namespace,
      epoch: expectedEpoch,
      migrationRunId,
      codeSha,
      codeArtifact,
      packageIntegrity,
      protocolDigest,
      assemblyDigest,
      indexSchemaDigest,
      encoderVersion: 1,
      planDigest: plan.prepared.planDigest,
      kind: 'ownership',
      adoptedAt: Date.now(),
      migrationManifestDigest: finalManifestDigest,
      sourceInventoryDigest: plan.prepared.sourceInventoryDigest,
      targetInventoryDigest: '0'.repeat(64),
      scanned: candidates.length,
      migrated: candidates.length,
      skipped: 0,
      errors: 0,
      targetCounts: plan.prepared.expectedTargetCounts,
      ...(plan.prepared.totalPhysicalRecords > 0 ? {
        projectorId: PROJECTOR_ID,
        projectorVersion: PROJECTOR_VERSION,
        projectorDigest: protocolDigest,
      } : {}),
    };

    await finalizeMigrationInTransaction(transaction, db, {
      namespace,
      finalDoc,
      markerDoc,
      storeKey,
      FieldPath,
    });
  });

  return {
    scanned: candidates.length,
    migrated: candidates.length,
    skipped: 0,
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
      throw new CutoverFenceError(\`Unknown option '\${k}' passed to activateFirestoreMigration\`);
    }
  }

  const { db, FieldPath, key, namespace, expectedEpoch, migrationRunId, codeSha, codeArtifact, packageIntegrity, protocolDigest } = context;

  return await db.runTransaction(async (transaction: any) => {
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);

    // Read final manifest internally per Section 6
    const finalRef = db.collection(\`\${namespace}_meta\`).doc(\`migration_manifest_\${expectedEpoch}\`);
    const finalSnap = await transaction.get(finalRef);

    let migrationManifestDigest = control.migrationManifestDigest;
    let planDigest = '';

    if (finalSnap.exists) {
      const f = finalSnap.data();
      migrationManifestDigest = D('manifest', namespace, expectedEpoch, f);
      planDigest = f.planDigest || '';
    }

    if (control.state === 'v3_active') {
      if (control.epoch !== expectedEpoch) {
        throw new CutoverFenceError(\`Epoch mismatch for namespace \${namespace}: expected \${expectedEpoch}, got \${control.epoch}\`);
      }
      if (control.migrationRunId && control.migrationRunId !== migrationRunId) {
        throw new CutoverFenceError(\`migrationRunId mismatch for namespace \${namespace}: expected \${migrationRunId}, got \${control.migrationRunId}\`);
      }
      return {
        status: 'already_active',
        epoch: control.epoch,
        migrationRunId: control.migrationRunId || migrationRunId,
        migrationManifestDigest: control.migrationManifestDigest || migrationManifestDigest || '',
        planDigest,
      };
    }

    if (control.state !== 'v3_ready') {
      throw new CutoverFenceError(\`Cannot activate namespace \${namespace}: state must be v3_ready, got \${control.state}\`);
    }

    const res = await activateMigrationInTransaction(transaction, db, {
      ...context,
      storeKey: key,
      migrationManifestDigest: migrationManifestDigest || control.migrationManifestDigest,
    });

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
  const { db, namespace, expectedEpoch } = context;
  const control = await getCutoverFenceRecord(db, namespace);
  if (!control) {
    return { state: 'uninitialized', epoch: expectedEpoch };
  }

  let planDigest: string | undefined;
  let sourceInventoryDigest: string | undefined;

  const finalRef = db.collection(\`\${namespace}_meta\`).doc(\`migration_manifest_\${control.epoch}\`);
  const finalSnap = await finalRef.get();
  if (finalSnap.exists) {
    const f = finalSnap.data() as Record<string, unknown>;
    planDigest = f.planDigest as string | undefined;
    sourceInventoryDigest = f.sourceInventoryDigest as string | undefined;
  }

  return {
    state: control.state,
    epoch: control.epoch,
    migrationRunId: control.migrationRunId,
    migrationManifestDigest: control.migrationManifestDigest,
    planDigest,
    sourceInventoryDigest,
  };
}
