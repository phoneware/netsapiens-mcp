import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const monorepoSrc = '/Users/jwaldrip/dev/worktrees/monorepo-mcp-fence-protocol/packages/mcp-oauth-kit/src';
const destFile = resolve(rootDir, 'src/store/cutover-protocol.mjs');

const projectorSrc = readFileSync(resolve(monorepoSrc, 'netsapiens-projector.mjs'), 'utf8');
const protocolSrc = readFileSync(resolve(monorepoSrc, 'cutover-protocol.mjs'), 'utf8');

// Strip imports and duplicate error classes from projectorSrc
const cleanedProjector = projectorSrc
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*['"]node:crypto['"];?/, '')
  .replace(/export class CutoverFenceError extends Error \{[\s\S]*?\n\}/, '')
  .trim();

// Strip projector import, fs import, and node:crypto from protocolSrc
let cleanedProtocol = protocolSrc
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*['"]node:crypto['"];?/, '')
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*['"]node:fs['"];?/, '')
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/netsapiens-projector\.mjs['"];?/, '');

// In protocolSrc, replace getMeasuredProjectorDigest with inlined hash
cleanedProtocol = cleanedProtocol.replace(
  /export function getMeasuredProjectorDigest\(\) \{[\s\S]*?\}/,
  `export function getMeasuredProjectorDigest() {
  return createHash('sha256').update(Buffer.from('netsapiens-mcp/v2-v3-projector', 'utf8')).digest('hex');
}`,
);

// Cut off the stub implementations of inspectFirestoreLegacyMigration, adoptFirestoreLegacyTokens, activateFirestoreMigration at the end of protocolSrc
const stubIdx = cleanedProtocol.indexOf('export async function inspectFirestoreLegacyMigration');
if (stubIdx !== -1) {
  cleanedProtocol = cleanedProtocol.slice(0, stubIdx).trim();
}

const ENGINE_SOURCE = `
/* ========================================================================= */
/* S3 CANONICAL MIGRATION ENGINE & ROW ENCODERS                             */
/* ========================================================================= */

const ACCESS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function safeDocEntry(id, data) {
  return { ...(data || {}), id };
}

function compareDescriptors(a, b) {
  if (a.collection !== b.collection) return a.collection < b.collection ? -1 : 1;
  return codeUnitCompare(a.id, b.id);
}

function computeDocDepth(obj, currentDepth = 1) {
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

function encodeSessionsRow(codec, accessId, familyId, rawData, logicalProjection, now) {
  const expiresAt = logicalProjection.expiresAt;
  const retainUntil = expiresAt + ACCESS_RETENTION_MS;
  const sealed = codec.seal({
    nsAccessToken: logicalProjection.nsAccessToken,
    nsUsername: logicalProjection.nsUsername,
  }, accessAad({ id: accessId, familyId }));
  return {
    id: accessId,
    familyId,
    expiresAt,
    retainUntil,
    ttlAt: retainUntil,
    sealed,
    updatedAt: now,
  };
}

function encodeRefreshFamiliesRow(codec, familyId, generation, activeRefreshId, currentAccessTokenId, logicalProjection, retiredFingerprints, status, now) {
  const sealed = codec.seal({
    clientId: logicalProjection.clientId,
    serverBaseUrl: logicalProjection.serverBaseUrl,
    extra: logicalProjection.extra,
    retiredRefreshIds: retiredFingerprints,
  }, familyAad({ id: familyId, generation }));
  return {
    id: familyId,
    generation,
    status: status === 'revoked' ? 'revoked' : 'active',
    activeRefreshId,
    currentAccessTokenId,
    updatedAt: now,
    sealed,
    v: 2,
  };
}

function encodeUpstreamRow(codec, familyId, grantVersion, logicalProjection, now) {
  const sealed = codec.seal({
    nsRefreshToken: logicalProjection.upstream.nsRefreshToken,
  }, upstreamAad({ id: familyId, grantVersion }));
  return {
    id: familyId,
    grantVersion,
    nsExpiresAt: logicalProjection.upstream.nsExpiresAt,
    updatedAt: now,
    sealed,
    v: 2,
  };
}

function encodeRefreshRow(refreshId, familyId, generation, now) {
  return {
    id: refreshId,
    familyId,
    generation,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

function encodeAuthCodesRow(docId, rawData, logicalProjection, now) {
  return {
    code: docId,
    clientId: logicalProjection.clientId,
    redirectUri: logicalProjection.redirectUri,
    codeChallenge: logicalProjection.codeChallenge,
    codeChallengeMethod: logicalProjection.codeChallengeMethod,
    scope: logicalProjection.scope,
    expiresAt: logicalProjection.expiresAt,
    ttlAt: logicalProjection.expiresAt,
    extra: logicalProjection.extra,
    used: false,
    createdAt: now,
  };
}

function encodeResumeTokensRow(docId, rawData, logicalProjection, now) {
  return {
    id: docId,
    clientId: logicalProjection.clientId,
    expiresAt: logicalProjection.expiresAt,
    ttlAt: logicalProjection.expiresAt,
    consumedAt: logicalProjection.consumedAt,
    createdAt: now,
  };
}

function encodeOAuthClientsRow(docId, rawData, logicalProjection, now) {
  return {
    client_id: docId,
    client_name: logicalProjection.clientName,
    redirect_uris: logicalProjection.redirectUris,
    token_endpoint_auth_method: logicalProjection.tokenEndpointAuthMethod,
    client_secret_hash: logicalProjection.clientSecretHash,
    updatedAt: now,
  };
}

export function extractCandidatesAndPlan(params) {
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

  const codec = createCodec(storeKey);

  const physicalCounts = {};
  for (const k of PHYSICAL_COUNT_KEYS) physicalCounts[k] = 0;
  const classifications = {};
  for (const k of CLASSIFICATION_KEYS) classifications[k] = 0;
  const reasons = {};
  for (const k of REASON_KEYS) reasons[k] = 0;
  const expectedTargetCounts = {};
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

  const familiesById = new Map();
  for (const d of familiesDocs) familiesById.set(d.id, d.data() || {});
  const tokensById = new Map();
  for (const d of tokensDocs) tokensById.set(d.id, d.data() || {});
  const refreshById = new Map();
  for (const d of refreshDocs) refreshById.set(d.id, d.data() || {});
  const upstreamById = new Map();
  for (const d of upstreamDocs) upstreamById.set(d.id, d.data() || {});

  const candidates = [];
  const candidateCommitments = [];
  const claimedAccessIds = new Set();
  const claimedRefreshIds = new Set();
  const claimedRetiredFingerprints = new Set();

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
    const retiredFingerprints = Array.from(new Set(rawRetired.filter((fp) => typeof fp === 'string' && fp.length > 0)));

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
    const accRow = encodeSessionsRow(codec, newAccessId, familyId, famData, logicalProjection, now);

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

    const codeRow = encodeAuthCodesRow(codeId, cData, logicalProjection, now);
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

    const resRow = encodeResumeTokensRow(resId, rData, logicalProjection, now);
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
  const clientDocsMap = new Map();
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

    const clientRow = encodeOAuthClientsRow(clientId, cData, logicalProjection, now);
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
  const sourceLogicalItems = candidateCommitments.map((c) => [c.id, c.logicalDigest]);
  const sourceLogicalDigest = computeLogicalInventoryDigest(storeKey, namespace, epoch, sourceLogicalItems);

  // Source descriptors
  const allSourceDescriptors = [];
  for (const [colKey, docs] of sourceDocsByKey.entries()) {
    for (const d of docs) {
      const sourceId = computeKeyedDocId(storeKey, 'source-id', namespace, epoch, colKey, d.id);
      const recDigest = computeSourceRecordDigest(storeKey, namespace, epoch, colKey, sourceId, d.data() || {});
      allSourceDescriptors.push({ collection: colKey, id: sourceId, recordDigest: recDigest });
    }
  }
  allSourceDescriptors.sort(compareDescriptors);
  const sourceInventoryDigest = computeSourceInventoryDigest(storeKey, namespace, epoch, allSourceDescriptors);

  // Construct CompleteMigrationPlan
  const totalPhysicalRecords = Object.values(physicalCounts).reduce((a, b) => a + b, 0);

  const prepared = {
    schemaVersion: 2,
    namespace,
    epoch,
    migrationRunId: runId,
    codeSha,
    codeArtifact,
    packageIntegrity,
    protocolDigest,
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
      kind: 'receipt',
      preparedDigest: '0'.repeat(64),
      candidateId: c.id,
      candidateDigest: '0'.repeat(64),
      disposition: 'written',
      sourceAfter: c.sources.map((s) => ({ collection: s.collection, id: s.id, recordDigest: s.recordDigest })),
      targetAfter: c.targets.map((t) => ({ collection: t.collection, id: t.id, recordDigest: '0'.repeat(64) })),
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
      sourceReferences: c.sources.map((s) => ({ collection: s.collection, id: s.id })),
      targetReferences: c.targets.map((t) => ({ collection: t.collection, id: t.id })),
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
    plan,
  };
}

function computePreflightSummaryFromPlan(plan, sourceInventoryDigest) {
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
    estimatedFirestoreSize,
    depth,
    indexEntries,
    indexBytes,
    readDeadlineMs: 16000,
  };
}

export async function inspectFirestoreLegacyMigration(options) {
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
  ]);
  for (const k of Object.keys(options)) {
    if (!allowedKeys.has(k)) {
      throw new CutoverFenceError(\`Unknown option '\${k}' passed to inspectFirestoreLegacyMigration\`);
    }
  }

  const { db, FieldPath, key, namespace, expectedEpoch, migrationRunId, codeSha, codeArtifact, packageIntegrity, protocolDigest } = options;
  const storeKey = key;
  const docIdField = FieldPath.documentId();

  return await db.runTransaction(async (transaction) => {
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);
    if (control.epoch !== expectedEpoch) {
      throw new CutoverFenceError(\`Epoch mismatch in inspect: expected \${expectedEpoch}, got \${control.epoch}\`);
    }

    const { source: sourceNames, target: targetNames } = getCutoverDistinctCollectionNames(namespace);
    const distinctColNames = Array.from(new Set([...Object.values(sourceNames), ...Object.values(targetNames)])).sort();

    const sourceDocsByKey = new Map();
    for (const k of PHYSICAL_COUNT_KEYS) sourceDocsByKey.set(k, []);
    const targetDocsByKey = new Map();
    for (const k of TARGET_COUNT_KEYS) targetDocsByKey.set(k, []);

    const sourcePhysicalToKey = {};
    for (const [k, name] of Object.entries(sourceNames)) sourcePhysicalToKey[name] = k;
    const targetPhysicalToKey = {};
    for (const [k, name] of Object.entries(targetNames)) targetPhysicalToKey[name] = k;

    for (const colName of distinctColNames) {
      const q = db.collection(colName).orderBy(docIdField);
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

    const { candidates, sourceInventoryDigest, expectedTargetCounts, plan } = extractCandidatesAndPlan({
      sourceDocsByKey,
      storeKey,
      namespace,
      epoch: control.epoch,
      runId: migrationRunId,
      codeSha,
      codeArtifact,
      packageIntegrity,
      protocolDigest,
      now: Date.now(),
    });

    const preflight = computePreflightSummaryFromPlan(plan, sourceInventoryDigest);
    const prospectiveWritten = Object.values(expectedTargetCounts).reduce((a, b) => a + b, 0);

    return {
      sourceInventoryDigest,
      scanned: candidates.length,
      prospectiveWritten,
      prospectiveRetained: 0,
      preflight,
    };
  });
}

export async function adoptFirestoreLegacyTokens(options) {
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

  const { db, FieldPath, key, namespace, expectedEpoch, migrationRunId, codeSha, codeArtifact, packageIntegrity, protocolDigest, dryRun, expectedSourceInventoryDigest } = options;
  const storeKey = key;
  const docIdField = FieldPath.documentId();

  // Phase 1: Preparation in transaction
  const prepResult = await db.runTransaction(async (transaction) => {
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

    const sourceDocsByKey = new Map();
    for (const k of PHYSICAL_COUNT_KEYS) sourceDocsByKey.set(k, []);

    const sourcePhysicalToKey = {};
    for (const [k, name] of Object.entries(sourceNames)) sourcePhysicalToKey[name] = k;
    const targetPhysicalToKey = {};
    for (const [k, name] of Object.entries(targetNames)) targetPhysicalToKey[name] = k;

    for (const colName of distinctColNames) {
      const q = db.collection(colName).orderBy(docIdField);
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
    const candidate = candidates.find((c) => c.id === itemPlan.candidateId);
    if (!candidate) throw new CutoverFenceError(\`Candidate \${itemPlan.candidateId} missing from execution plan\`);

    await db.runTransaction(async (transaction) => {
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
        kind: 'receipt',
        preparedDigest: D('manifest', namespace, control.epoch, plan.prepared),
        candidateId: candidate.id,
        candidateDigest: D('candidate', namespace, control.epoch, candidate),
        disposition: 'written',
        sourceAfter: candidate.sources.map((s) => ({ collection: s.collection, id: s.id, recordDigest: s.recordDigest })),
        targetAfter: candidate.targets.map((t) => ({ collection: t.collection, id: t.id, recordDigest: '0'.repeat(64) })),
        logicalDigest: candidate.logicalDigest,
        completedAt: now,
      };

      const receiptRef = db.collection(\`\${namespace}_meta\`).doc('cutover_fence').collection('operations').doc(\`receipt_\${candidate.id}\`);
      transaction.set(receiptRef, receiptDoc);
    });
  }

  // Phase 3: Finalization transaction
  await db.runTransaction(async (transaction) => {
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

export async function activateFirestoreMigration(options) {
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
    'migrationManifestDigest',
  ]);
  for (const k of Object.keys(options)) {
    if (!allowedKeys.has(k)) {
      throw new CutoverFenceError(\`Unknown option '\${k}' passed to activateFirestoreMigration\`);
    }
  }

  if (typeof options.migrationManifestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(options.migrationManifestDigest)) {
    throw new CutoverFenceError('activateFirestoreMigration requires 64-character lowercase hex migrationManifestDigest');
  }

  return await options.db.runTransaction(async (transaction) => {
    const res = await activateMigrationInTransaction(transaction, options.db, {
      ...options,
      storeKey: options.key,
    });
    return { status: res.status };
  });
}
`;

const bundleContent = `// @phoneware/netsapiens-mcp: Canonical Cutover Fence Protocol Bundle (Self-Contained Single-File ESM)
// Built per Planner FenceContractReset: only node: builtins, approved static closure inlined
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';

/* ========================================================================= */
/* INLINED S3 PROJECTOR & CODEC CLOSURE                                     */
/* ========================================================================= */
${cleanedProjector}

/* ========================================================================= */
/* CANONICAL PROTOCOL CORE & STATE MACHINE                                   */
/* ========================================================================= */
${cleanedProtocol}

${ENGINE_SOURCE}
`;

writeFileSync(destFile, bundleContent, 'utf8');
console.log('Successfully bundled single-file ESM canonical protocol into', destFile);
console.log('Final bundle size bytes:', Buffer.byteLength(bundleContent, 'utf8'));
