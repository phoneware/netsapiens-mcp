import { createHash, randomUUID } from 'node:crypto';
import { createCodec, type Codec } from './codec.js';
import { subjectRefsForFamily, subjectSpecFor, type SubjectSpec } from './subject-descriptor.js';
import {
  accessAad,
  familyAad,
  upstreamAad,
  codeUnitCompare,
  compareDescriptors,
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
  buildSourceProjectionMap,
  buildTargetProjectionMap,
  projectSourceLogical,
  projectTargetLogical,
  sanitizeId,
} from './netsapiens-projector.mjs';
import {
  CutoverFenceError,
  CutoverRefusedError,
  isCutoverFenceError,
} from './errors.js';
import {
  startMonotonicTimer,
  C,
  D,
  H,
  PHYSICAL_COUNT_KEYS,
  TARGET_COUNT_KEYS,
  CLASSIFICATION_KEYS,
  REASON_KEYS,
  REQUIRED_IDENTITY_KEYS,
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
  computePlanDigest,
  computeEstimatedFirestoreDocSize,
  prepareMigrationInTransaction,
  finalizeMigrationInTransaction,
  activateMigrationInTransaction,
  markIrreversibleInTransaction,
  getCutoverDistinctCollectionNames,
  isTargetFormatRow,
  parseCutoverFenceRecord,
  validateMigrationIdentityFields,
} from '../cutover/canonical-core.mjs';
import * as canonicalCoreVerify from '../cutover/canonical-core.mjs';
import type { PreparationIdentityExpectation } from '../cutover/canonical-core.mjs';
import type { FirestoreLike } from './firestore-like.js';
import { assertCredentialUnchanged, assertProtectedContext, getProtectedBinding } from './protected-binding.js';
import { assertActivationObservation, assertPreparationObservation } from './fresh-index-observation.js';
import { canonicalJson } from '../cutover/dsse-verifier-core.mjs';
import { assertPreparedIdentity, NONEMPTY_PROJECTOR_KEYS, REQUIRED_PREPARED_MANIFEST_KEYS, validateMapKeysExact } from '../cutover/canonical-core.mjs';
import { PROJECTOR_ID, PROJECTOR_VERSION } from './netsapiens-projector.mjs';
import type { ProtectedBinding } from './protected-binding.js';
import { observeFreshIndexes } from './fresh-index-producer.js';
import { concreteFieldPaths, type SignedIndexPolicy } from './index-coverage.js';

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
}


// Single source of the prospective write list for preparation. Physical group
// names come from the canonical target registry, never from the request.
function prospectiveWrites(
  namespace: string,
  plan: {
    readonly prepared: unknown;
    readonly items: ReadonlyArray<{
      readonly targetReferences: ReadonlyArray<{ readonly collection: string }>;
      readonly prospectiveTargetPostimages: readonly unknown[];
      readonly receiptUpperBound: unknown;
    }>;
    readonly finalization: { readonly finalUpperBound: unknown; readonly markerUpperBound: unknown; readonly controlUpperBound: unknown };
  },
): Array<{ group: string; document: unknown }> {
  const targets = getCutoverDistinctCollectionNames(namespace).target as Record<string, string>;
  const writes: Array<{ group: string; document: unknown }> = [];
  for (const item of plan.items) {
    if (item.targetReferences.length !== item.prospectiveTargetPostimages.length) {
      throw new CutoverRefusedError('Prospective target postimages do not match target references');
    }
    item.targetReferences.forEach((reference, index) => {
      const group = targets[reference.collection];
      if (!group) throw new CutoverRefusedError('Unknown prospective target collection');
      writes.push({ group, document: item.prospectiveTargetPostimages[index] });
    });
    writes.push({ group: `${namespace}_meta`, document: item.receiptUpperBound });
  }
  writes.push(
    { group: `${namespace}_meta`, document: plan.prepared },
    { group: `${namespace}_meta`, document: plan.finalization.finalUpperBound },
    { group: `${namespace}_meta`, document: plan.finalization.markerUpperBound },
    { group: `${namespace}_meta`, document: plan.finalization.controlUpperBound },
  );
  return writes;
}

// Preparation snapshot. The complete plan, the expected identity, the signed index manifest
// and the authenticated binding must describe one snapshot before any write is budgeted.
// Nothing here reads the request. Any mismatch refuses; nothing is repaired.
export type PreparationIdentity = PreparationIdentityExpectation;

export interface PreparationInputs {
  readonly completePlan: Parameters<typeof prospectiveWrites>[1];
  readonly expectedIdentity: PreparationIdentity;
  readonly sourceInventoryDigest: string;
}


// The signed index manifest is the copy the authenticated binding carries. It is the only
// manifest the observation is checked against, so it is taken from the binding and must hash
// to the identity's indexSchemaDigest. Returns the binding for the observation check.
function assertPreparationInputs(db: object, inputs: PreparationInputs): ProtectedBinding {
  const binding = getProtectedBinding(db);
  if (!binding) throw new CutoverRefusedError('Protected migration context required for preparation');
  const { completePlan, expectedIdentity, sourceInventoryDigest } = inputs;
  const prepared = completePlan.prepared as Record<string, unknown>;
  // Core validates the plan's shape and budgets. These checks cover what the plan was built from.
  validateCompleteMigrationPlan(completePlan);
  // The reviewed core's identity check: the prepared document carries the approved identity field for field.
  assertPreparedIdentity(prepared, expectedIdentity, expectedIdentity.namespace);
  if (prepared.planDigest !== computePlanDigest(expectedIdentity.namespace, expectedIdentity.epoch, prepared.planSpec as object)) {
    throw new CutoverRefusedError('Prepared plan digest does not match its planSpec');
  }
  if (prepared.sourceInventoryDigest !== sourceInventoryDigest) {
    throw new CutoverRefusedError('Prepared plan source inventory differs from the snapshot');
  }
  if (expectedIdentity.namespace !== binding.namespace || expectedIdentity.epoch !== binding.expectedEpoch ||
    expectedIdentity.migrationRunId !== binding.migrationRunId || expectedIdentity.codeSha !== binding.codeSha ||
    expectedIdentity.codeArtifact !== binding.codeArtifact || expectedIdentity.packageIntegrity !== binding.packageIntegrity ||
    expectedIdentity.protocolDigest !== binding.protocolDigest || expectedIdentity.assemblyDigest !== binding.assemblyDigest ||
    expectedIdentity.indexSchemaDigest !== binding.indexSchemaDigest) {
    throw new CutoverRefusedError('Expected identity differs from the authenticated binding');
  }
  const manifestText = canonicalJson(binding.indexSchema);
  if (createHash('sha256').update(Buffer.from(manifestText, 'utf8')).digest('hex') !== expectedIdentity.indexSchemaDigest) {
    throw new CutoverRefusedError('Signed index manifest does not match the expected index schema digest');
  }
  return binding;
}

// Preparation gate: the snapshot first, then fresh observation, inventory digest, budgets and coverage.
function assertPreparationGate(db: object, inputs: PreparationInputs): void {
  const binding = assertPreparationInputs(db, inputs);
  assertPreparationObservation({
    db,
    binding,
    inventoryDigest: inputs.sourceInventoryDigest,
    writes: prospectiveWrites(inputs.expectedIdentity.namespace, inputs.completePlan),
    subjectRefsGroup: binding.subjectDescriptor !== null ? `${inputs.expectedIdentity.namespace}_refresh_families` : undefined,
  });
}

export function assertValidMigrationContext(options: unknown, extraFields: readonly string[] = []): asserts options is MigrationContext {
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
      throw new CutoverFenceError(`MigrationContext missing required field: ${field}`);
    }
  }
  if (typeof opts.db !== 'object' || typeof (opts.db as any).collection !== 'function' || typeof (opts.db as any).runTransaction !== 'function') {
    throw new CutoverFenceError('MigrationContext db must be a Firestore-like object with collection and runTransaction methods');
  }
  if ((typeof opts.FieldPath !== 'object' && typeof opts.FieldPath !== 'function') || typeof (opts.FieldPath as any).documentId !== 'function') {
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
  const allowedFields = new Set([
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
    ...extraFields,
  ]);
  for (const k of Object.keys(opts)) {
    if (!allowedFields.has(k)) {
      throw new CutoverFenceError(`Unknown option '${k}' passed to MigrationContext`);
    }
  }
}

// The bootstrap digests come only from the authenticated protected binding for this handle (spec N2, P3).
// The legacy file loader and its test fallbacks are gone. A handle without a protected context refuses.
function protectedBootstrapBindings(db: object): { assemblyDigest: string; indexSchemaDigest: string } {
  const binding = getProtectedBinding(db);
  if (!binding) throw new CutoverRefusedError('Protected migration context required for bootstrap bindings');
  return { assemblyDigest: binding.assemblyDigest, indexSchemaDigest: binding.indexSchemaDigest };
}

function legacyDocId(token: string): string {
  if (typeof token !== 'string') return '';
  return token.replace(/\//g, '_').replace(/\./g, '_');
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

// Subject spec for a namespace from the bound, signed descriptor policy. Refuses without a
// protected context; an undeclared namespace refuses inside subjectSpecFor.
function subjectSpecForDb(db: object, namespace: string, storeKey: Uint8Array) {
  const binding = getProtectedBinding(db);
  if (!binding) throw new CutoverRefusedError('Protected migration context required for subject mapping');
  if (binding.namespace !== namespace) throw new CutoverRefusedError('Subject descriptor is bound to a different namespace');
  return subjectSpecFor(binding.subjectDescriptor, namespace, storeKey);
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
  subject?: SubjectSpec | null;
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
    subject = null,
  } = params;

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
  const upstreamById = new Map<string, any>();
  for (const d of upstreamDocs) upstreamById.set(d.id, d.data() || {});

  // Physical vs credential token resolution for access tokens and refresh pointers
  const malformedDocKeys = new Set<string>();
  // One shape for every credential-keyed legacy entry: its document, data, physical id and credential token.
  interface LegacyCredentialEntry { doc: any; data: any; physicalId: string; credentialToken: string }
  const tokensByCredential = new Map<string, LegacyCredentialEntry>();
  const tokensByPhysicalId = new Map<string, LegacyCredentialEntry>();
  for (const d of tokensDocs) {
    const data = d.data() || {};
    // Conflicting family ownership is never a valid source, including when one family selects
    // the token by currentAccessToken. Exclude it before indexing or claiming it.
    if (data.familyId != null && data.refreshFamilyId != null && data.familyId !== data.refreshFamilyId) {
      malformedDocKeys.add(`tokens:${d.id}`);
      reasons.conflictingClaims++;
      continue;
    }
    const credToken = data.accessToken ?? data.token?.accessToken;
    if (typeof credToken === 'string' && credToken.length > 0) {
      const expId = legacyDocId(credToken);
      if (d.id !== expId) {
        malformedDocKeys.add(`tokens:${d.id}`);
        reasons.malformedRecords++;
        continue;
      }
      if (tokensByPhysicalId.has(d.id)) {
        const existing = tokensByPhysicalId.get(d.id)!;
        if (existing.credentialToken !== credToken) {
          reasons.conflictingClaims++;
          continue;
        }
      }
      if (tokensByCredential.has(credToken)) {
        const existing = tokensByCredential.get(credToken)!;
        if (existing.physicalId !== d.id) {
          reasons.conflictingClaims++;
          continue;
        }
      }
      const entry = { doc: d, data, physicalId: d.id, credentialToken: credToken };
      tokensByCredential.set(credToken, entry);
      tokensByPhysicalId.set(d.id, entry);
    }
  }

  const refreshByCredential = new Map<string, LegacyCredentialEntry>();
  const refreshByPhysicalId = new Map<string, LegacyCredentialEntry>();

  for (const d of refreshDocs) {
    const data = d.data() || {};
    let credToken = data.refreshToken ?? data.token?.refreshToken;
    if (!credToken && data.accessToken) {
      const tok = tokensByCredential.get(data.accessToken);
      const rawRef = tok?.data?.refreshToken ?? tok?.data?.token?.refreshToken;
      if (rawRef && legacyDocId(rawRef) === d.id) {
        credToken = rawRef;
      } else {
        continue;
      }
    }
    if (typeof credToken === 'string' && credToken.length > 0) {
      const expId = legacyDocId(credToken);
      if (d.id !== expId) {
        malformedDocKeys.add(`refresh:${d.id}`);
        reasons.malformedRecords++;
        continue;
      }
      if (refreshByPhysicalId.has(d.id)) {
        const existing = refreshByPhysicalId.get(d.id)!;
        if (existing.credentialToken !== credToken) {
          reasons.conflictingClaims++;
          continue;
        }
      }
      if (refreshByCredential.has(credToken)) {
        const existing = refreshByCredential.get(credToken)!;
        if (existing.physicalId !== d.id) {
          reasons.conflictingClaims++;
          continue;
        }
      }
      const entry = { doc: d, data, physicalId: d.id, credentialToken: credToken };
      refreshByCredential.set(credToken, entry);
      refreshByPhysicalId.set(d.id, entry);
    }
  }

  const candidates: any[] = [];
  const candidateCommitments: any[] = [];
  const claimedAccessIds = new Set<string>();
  const claimedRefreshIds = new Set<string>();
  const claimedRetiredFingerprints = new Set<string>();
  const claimedRefreshDocIds = new Set<string>();
  const claimedTokenDocIds = new Set<string>();
  const claimedUpstreamDocIds = new Set<string>();
  // 1. Process families (pr56Families)
  for (const famDoc of familiesDocs) {
    const familyId = famDoc.id;
    const famData = famDoc.data() || {};

    if (!upstreamById.has(familyId)) {
      reasons.missingUpstreamGrants++;
      continue;
    }
    const currentRefToken = famData.currentRefreshToken;
    let curRefEntry = currentRefToken ? refreshByCredential.get(currentRefToken) : undefined;
    if (!curRefEntry && currentRefToken) {
      const byPhys = refreshByPhysicalId.get(legacyDocId(currentRefToken));
      if (byPhys && byPhys.credentialToken === currentRefToken) {
        curRefEntry = byPhys;
      }
    }
    if (!currentRefToken || !curRefEntry) {
      reasons.missingRefreshPointers++;
      continue;
    }
    const curRefDoc = curRefEntry.data || {};
    const curRefFamId = curRefDoc.familyId ?? curRefDoc.family_id;
    if (curRefFamId !== familyId || curRefDoc.status !== 'active') {
      malformedDocKeys.add(`families:${famDoc.id}`);
      reasons.malformedRecords++;
      continue;
    }
    if (claimedRefreshIds.has(curRefEntry.credentialToken)) {
      reasons.conflictingClaims++;
      continue;
    }
    claimedRefreshIds.add(curRefEntry.credentialToken);

    const accessId = famData.currentAccessToken ?? curRefDoc.accessToken ?? curRefDoc.token?.accessToken;
    let accessEntry = accessId ? tokensByCredential.get(accessId) : undefined;
    if (!accessEntry && accessId) {
      const byPhys = tokensByPhysicalId.get(legacyDocId(accessId));
      if (byPhys && byPhys.credentialToken === accessId) {
        accessEntry = byPhys;
      }
    }

    if (!accessId || typeof accessId !== 'string' || !accessId.trim() || !accessEntry) {
      reasons.missingAccessTokens++;
      continue;
    }
    const owners = [accessEntry.data.familyId, accessEntry.data.refreshFamilyId].filter(value => value != null);
    if (owners.some(value => typeof value !== 'string')) {
      reasons.malformedRecords++;
      continue;
    }
    if (owners.some(value => value !== familyId)) {
      reasons.conflictingClaims++;
      continue;
    }
    if (claimedAccessIds.has(accessEntry.credentialToken)) {
      reasons.conflictingClaims++;
      continue;
    }
    claimedAccessIds.add(accessEntry.credentialToken);

    let prevRefEntry: any = undefined;
    if (famData.previousRefreshToken) {
      const prevRefToken = famData.previousRefreshToken;
      prevRefEntry = refreshByCredential.get(prevRefToken);
      if (!prevRefEntry) {
        const byPhys = refreshByPhysicalId.get(legacyDocId(prevRefToken));
        if (byPhys && byPhys.credentialToken === prevRefToken) {
          prevRefEntry = byPhys;
        }
      }
      if (prevRefToken === currentRefToken || claimedRefreshIds.has(prevRefToken) || !prevRefEntry) {
        reasons.conflictingClaims++;
        continue;
      }
      claimedRefreshIds.add(prevRefToken);
    }

    const rawRetired = Array.isArray(famData.retiredRefreshFingerprints)
      ? famData.retiredRefreshFingerprints
      : (Array.isArray(famData.retiredTokens) ? famData.retiredTokens : []);
    const seenFp = new Set();
    const retiredFingerprints = [];
    let retiredConflict = false;
    for (const fp of rawRetired) {
      if (typeof fp !== 'string' || fp.length === 0) {
        malformedDocKeys.add(`families:${famDoc.id}`);
        reasons.malformedRecords++;
        retiredConflict = true;
        break;
      }
      if (seenFp.has(fp) || claimedRetiredFingerprints.has(fp)) {
        reasons.conflictingClaims++;
        retiredConflict = true;
        break;
      }
      seenFp.add(fp);
      claimedRetiredFingerprints.add(fp);
      retiredFingerprints.push(fp);
    }
    if (retiredConflict) continue;
    retiredFingerprints.sort(codeUnitCompare);

    const newAccessId = codec.id('session', accessEntry.credentialToken);
    const newRefreshId = codec.id('refresh', curRefEntry.credentialToken);

    const candSources = [
      {
        collection: 'families',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'families', familyId),
        rawId: familyId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'families', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'families', familyId), famData),
      },
      {
        collection: 'refresh',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'refresh', curRefEntry.physicalId),
        rawId: curRefEntry.physicalId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'refresh', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'refresh', curRefEntry.physicalId), curRefDoc),
      },
      {
        collection: 'upstream',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'upstream', familyId),
        rawId: familyId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'upstream', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'upstream', familyId), upstreamById.get(familyId)),
      },
      {
        collection: 'tokens',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'tokens', accessEntry.physicalId),
        rawId: accessEntry.physicalId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'tokens', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'tokens', accessEntry.physicalId), accessEntry.data || {}),
      },
    ];

    if (prevRefEntry) {
      candSources.push({
        collection: 'refresh',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'refresh', prevRefEntry.physicalId),
        rawId: prevRefEntry.physicalId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'refresh', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'refresh', prevRefEntry.physicalId), prevRefEntry.data || {}),
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
    if (prevRefEntry) {
      const prevRefId = codec.id('refresh', prevRefEntry.credentialToken);
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

    const sourceEntries = [
      { collection: 'families', physicalId: familyId, data: famData },
      { collection: 'refresh', physicalId: curRefEntry.physicalId, data: curRefDoc },
      { collection: 'upstream', physicalId: familyId, data: upstreamById.get(familyId) },
      { collection: 'tokens', physicalId: accessEntry.physicalId, data: accessEntry.data },
    ];
    if (prevRefEntry) sourceEntries.push({ collection: 'refresh', physicalId: prevRefEntry.physicalId, data: prevRefEntry.data });
    const sourcesMap = buildSourceProjectionMap({ id: candidateId, kind: 'pr56Families', targets: candTargets, logicalDigest: '' }, sourceEntries, codec);

    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: 'pr56Families', targets: candTargets, logicalDigest: '' },
      sourcesMap,
      codec,
      subject,
    );
    if (subjectRefsForFamily(subject, logicalProjection.extra, logicalProjection.status).problem) reasons.subject_value_missing++;
    const logicalDigest = computeCandidateLogicalDigest(storeKey, namespace, epoch, 'pr56Families', logicalProjection);

    const generation = typeof famData.generation === 'number' ? famData.generation : 1;
    const grantVersion = typeof upstreamById.get(familyId)?.grantVersion === 'number' ? upstreamById.get(familyId).grantVersion : 1;

    const famRow = encodeRefreshFamiliesRow(codec, familyId, generation, newRefreshId, newAccessId, logicalProjection, retiredFingerprints, famData.status, now, logicalProjection.subjectRefs);
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
    if (prevRefEntry) {
      const prevRefId = codec.id('refresh', prevRefEntry.credentialToken);
      const previousRefresh = logicalProjection.previousRefresh;
      if (!previousRefresh) throw new CutoverFenceError(`Previous refresh projection missing for candidate ${sanitizeId(candidateId)}`);
      prevRefreshRow = {
        id: prevRefId,
        familyId,
        status: 'consumed' as const,
        generation: Math.max(1, generation - 1),
        consumedAt: previousRefresh.consumedAt,
        successorSealed: codec.seal({ accessToken: accessId, refreshToken: currentRefToken }, `successor:${prevRefId}`),
        v: 2,
      };
      targetDocsMap.set('prevRefresh', prevRefreshRow);
      postimageByTargetId.set(prevRefTargetId, prevRefreshRow);
    }

    const retiredRows: any[] = [];
    for (const fp of retiredFingerprints) {
      // Historical fingerprints carry no retirement timestamp. Preserve the
      // replay index without inventing one; runtime lookup uses familyId.
      const retRow = { familyId };
      retiredRows.push({ fingerprint: fp });
      const retTgtId = computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'retiredRefreshTokens', fp);
      postimageByTargetId.set(retTgtId, retRow);
    }
    if (retiredFingerprints.length > 0) {
      targetDocsMap.set('retiredRefresh', { ids: retiredFingerprints });
    }

    // Verify logical projection equivalence
    const targetLogicalProjection = projectTargetLogical(
      { id: candidateId, kind: 'pr56Families', targets: candTargets, logicalDigest: '' },
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
    if (prevRefEntry) expectedTargetCounts.refresh++;
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

    claimedRefreshDocIds.add(curRefEntry.doc.id);
    if (prevRefEntry) claimedRefreshDocIds.add(prevRefEntry.doc.id);
    claimedTokenDocIds.add(accessEntry.doc.id);
    claimedUpstreamDocIds.add(familyId);

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
    const physicalId = tokDoc.id;
    const tokEntry = tokensByPhysicalId.get(physicalId) || tokensByCredential.get(physicalId);
    if (!tokEntry) continue;
    if (claimedAccessIds.has(tokEntry.credentialToken)) continue;
    claimedAccessIds.add(tokEntry.credentialToken);

    const tokData = tokEntry.data || {};
    // A family-linked token that no family claimed is an orphan, not a standalone base token.
    // Leave it unclaimed for the orphan census below; otherwise projection may throw on unrelated
    // missing base fields and never report the broken family link.
    if (tokData.refreshFamilyId != null || tokData.familyId != null) continue;
    const rawRefresh = tokData.refreshToken ?? tokData.token?.refreshToken;
    if (typeof rawRefresh !== 'string' || rawRefresh.length === 0 ||
      (tokData.refreshToken != null && tokData.token?.refreshToken != null && tokData.refreshToken !== tokData.token.refreshToken)) {
      malformedDocKeys.add(`tokens:${tokEntry.doc.id}`);
      reasons.malformedRecords++;
      continue;
    }
    const familyId = codec.id('family', tokEntry.credentialToken);
    const refreshId = codec.id('refresh', rawRefresh);
    const newAccessId = codec.id('session', tokEntry.credentialToken);

    const candSources = [
      {
        collection: 'tokens',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'tokens', tokEntry.physicalId),
        rawId: tokEntry.physicalId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'tokens', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'tokens', tokEntry.physicalId), tokData),
      },
    ];
    let baseRefEntry: any = undefined;
    if (rawRefresh) {
      const rawRef = rawRefresh;
      baseRefEntry = refreshByCredential.get(rawRef);
      if (!baseRefEntry) {
        const byPhys = refreshByPhysicalId.get(legacyDocId(rawRef));
        if (byPhys) {
          if (byPhys.credentialToken !== rawRef) {
            reasons.conflictingClaims++;
            continue;
          }
          baseRefEntry = byPhys;
        }
      }
      if (baseRefEntry) {
        if (claimedRefreshIds.has(baseRefEntry.credentialToken)) {
          reasons.conflictingClaims++;
          continue;
        }
        candSources.push({
          collection: 'refresh',
          id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'refresh', baseRefEntry.physicalId),
          rawId: baseRefEntry.physicalId,
          recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'refresh', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'refresh', baseRefEntry.physicalId), baseRefEntry.data || {}),
        });
        claimedRefreshIds.add(baseRefEntry.credentialToken);
      }
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

    const sourceEntries = [{ collection: 'tokens', physicalId: tokEntry.physicalId, data: tokData }];
    if (baseRefEntry) sourceEntries.push({ collection: 'refresh', physicalId: baseRefEntry.physicalId, data: baseRefEntry.data });
    const sourcesMap = buildSourceProjectionMap({ id: candidateId, kind: 'baseFormatTokens', targets: candTargets, logicalDigest: '' }, sourceEntries, codec);

    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: 'baseFormatTokens', targets: candTargets, logicalDigest: '' },
      sourcesMap,
      codec,
      subject,
    );
    if (subjectRefsForFamily(subject, logicalProjection.extra, logicalProjection.status).problem) reasons.subject_value_missing++;
    const logicalDigest = computeCandidateLogicalDigest(storeKey, namespace, epoch, 'baseFormatTokens', logicalProjection);

    const famRow = encodeRefreshFamiliesRow(codec, familyId, 1, refreshId, newAccessId, logicalProjection, [], 'active', now, logicalProjection.subjectRefs);
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
      { id: candidateId, kind: 'baseFormatTokens', targets: candTargets, logicalDigest: '' },
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

    claimedTokenDocIds.add(tokEntry.doc.id);
    if (baseRefEntry) claimedRefreshDocIds.add(baseRefEntry.doc.id);

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

    const sourcesMap = buildSourceProjectionMap({ id: candidateId, kind: 'authCodes', targets: candTargets, logicalDigest: '' }, [{ collection: 'authCodes', physicalId: rawCode, data: cData }], codec);

    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: 'authCodes', targets: candTargets, logicalDigest: '' },
      sourcesMap,
      codec,
      subject,
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
        used: logicalProjection.used,
      },
      logicalProjection.expiresAt,
      now,
    );

    const targetDocsMap = new Map();
    targetDocsMap.set('authCodes', codeRow);
    const targetLogicalProjection = projectTargetLogical(
      { id: candidateId, kind: 'authCodes', targets: candTargets, logicalDigest: '' },
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

    const sourcesMap = buildSourceProjectionMap({ id: candidateId, kind: 'resumeTokens', targets: candTargets, logicalDigest: '' }, [{ collection: 'resumeTokens', physicalId: resId, data: rData }], codec);

    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: 'resumeTokens', targets: candTargets, logicalDigest: '' },
      sourcesMap,
      codec,
      subject,
    );
    const logicalDigest = computeCandidateLogicalDigest(storeKey, namespace, epoch, 'resumeTokens', logicalProjection);

    const resRow = encodeResumeTokensRow(resId, logicalProjection.consumedAt, logicalProjection.expiresAt, now);

    const targetDocsMap = new Map();
    targetDocsMap.set('resumeTokens', resRow);
    const targetLogicalProjection = projectTargetLogical(
      { id: candidateId, kind: 'resumeTokens', targets: candTargets, logicalDigest: '' },
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

  // 5. Process clients / oauth_clients preserving dual-source identity and semantic equivalence
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
    const hasLegacyClient = clientDocsById.has(clientId);
    const hasOauthClient = oauthClientDocsById.has(clientId);

    if (hasLegacyClient) {
      const d = clientDocsById.get(clientId);
      candSources.push({
        collection: 'clients',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'clients', clientId),
        rawId: clientId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'clients', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'clients', clientId), d),
      });
    }
    if (hasOauthClient) {
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

    const sourceEntries = [];
    if (hasLegacyClient) sourceEntries.push({ collection: 'clients', physicalId: clientId, data: clientDocsById.get(clientId) });
    if (hasOauthClient) sourceEntries.push({ collection: 'oauthClients', physicalId: clientId, data: oauthClientDocsById.get(clientId) });
    const sourcesMap = buildSourceProjectionMap({ id: candidateId, kind: 'clients', targets: candTargets, logicalDigest: '' }, sourceEntries, codec);

    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: 'clients', targets: candTargets, logicalDigest: '' },
      sourcesMap,
      codec,
      subject,
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
      { id: candidateId, kind: 'clients', targets: candTargets, logicalDigest: '' },
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

  // Check unclaimed / orphan records for the reason census
  for (const doc of upstreamDocs) {
    if (!claimedUpstreamDocIds.has(doc.id) && !malformedDocKeys.has(`upstream:${doc.id}`)) {
      reasons.orphanUpstreamGrants++;
    }
  }
  for (const doc of refreshDocs) {
    if (!claimedRefreshDocIds.has(doc.id) && !malformedDocKeys.has(`refresh:${doc.id}`)) {
      reasons.orphanRefreshPointers++;
    }
  }
  for (const doc of tokensDocs) {
    if (!claimedTokenDocIds.has(doc.id) && !malformedDocKeys.has(`tokens:${doc.id}`)) {
      reasons.orphanAccessTokens++;
    }
  }
  // Canonical sorting of candidates by candidateId and identity joining
  candidates.sort((a, b) => codeUnitCompare(a.id, b.id));
  const candidateById = new Map(candidates.map((c) => [c.id, c]));
  if (candidateById.size !== candidates.length) {
    throw new CutoverFenceError('Duplicate candidateId detected in candidate extraction');
  }

  const sortedCommitments = candidates.map((c) => c.commitment);
  const sourceLogicalItems = sortedCommitments.map((c) => [c.id, c.logicalDigest] as [string, string]);
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
    candidates: sortedCommitments.map((c) => {
      const executionCand = candidateById.get(c.id);
      if (!executionCand) throw new CutoverFenceError(`Candidate ${sanitizeId(c.id)} missing from execution candidates`);
      return {
        candidateId: c.id,
        kind: c.kind,
        sources: c.sources,
        targets: c.targets,
        logicalDigest: c.logicalDigest,
        sourceActions: executionCand.sourceActions.map((sa: any) => ({
          collection: sa.collection,
          id: sa.id,
          action: sa.action,
        })),
        targetBounds: executionCand.prospectiveTargetPostimages.map((img: any) => ({
          sizeBytes: computeEstimatedFirestoreDocSize(img),
          depth: computeDocDepth(img),
          indexEntries: countIndexMetrics(img).entries,
          indexBytes: countIndexMetrics(img).bytes,
        })),
      };
    }),
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
    // Record-bearing plans carry the approved projector identity. The reviewed core requires this exact
    // triple once records exist, and requires projectorDigest to equal protocolDigest.
    ...(totalPhysicalRecords > 0
      ? { projectorId: PROJECTOR_ID, projectorVersion: PROJECTOR_VERSION, projectorDigest: protocolDigest }
      : {}),
  };

  const preparation = {
    estimatedCommitBytes: Math.max(100, computeEstimatedFirestoreDocSize(prepared) + 200),
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
  };

  const controlUpperBound = {
    schemaVersion: 1,
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
    classifications,
    reasons,
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
  physicalCounts: Record<string, number>;
  classifications: Record<string, number>;
  reasons: Record<string, number>;
  expectedTargetCounts: Record<string, number>;
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
  const binding = assertProtectedContext(options, { operation: 'inspect', options: {} });
  options = { ...options, key: binding.key };
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
      throw new CutoverFenceError(`Unknown option '${k}' passed to inspectFirestoreLegacyMigration`);
    }
  }

  const { db, FieldPath, key, namespace, expectedEpoch, migrationRunId, codeSha, codeArtifact, packageIntegrity, protocolDigest } = options;
  const { assemblyDigest, indexSchemaDigest } = protectedBootstrapBindings(db);
  const storeKey = key;
  const docIdField = FieldPath.documentId();

  return await db.runTransaction(async (transaction: any) => {
    const timer = startMonotonicTimer();
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);
    if (control.epoch !== expectedEpoch) {
      throw new CutoverFenceError(`Epoch mismatch in inspect: expected ${expectedEpoch}, got ${control.epoch}`);
    }
    if (control.state !== 'fenced') {
      throw new CutoverFenceError(`Inspect requires a fenced namespace: state is '${control.state}'`);
    }
    const codec = createCodec(storeKey);

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
          // Pass physical collection name to isTargetFormatRow
          if (isTargetFormatRow(colName, data)) {
            tDocs.push(doc);
          } else {
            sDocs.push(doc);
          }
        }
        sourceDocsByKey.set(srcKey, sDocs);
        targetDocsByKey.set(tgtKey, tDocs);
      }
    }

    const { candidates, sourceInventoryDigest, expectedTargetCounts, physicalCounts, classifications, reasons, planSpec, planDigest, plan } = extractCandidatesAndPlan({
      sourceDocsByKey,
      storeKey,
      namespace,
      subject: subjectSpecForDb(db, namespace, storeKey),
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

    timer.assertUnderDeadline('Preflight scan');

    const targetDocMapById = new Map<string, any>();
    for (const [colKey, docs] of targetDocsByKey.entries()) {
      for (const d of docs) {
        targetDocMapById.set(`${colKey}:${d.id}`, { collection: colKey, physicalId: d.id, data: d.data() || {} });
      }
    }

    let prospectiveRetained = 0;
    const claimedTargetIds = new Set<string>();

    for (const c of candidates) {
      const targetEntries = c.targets.map((target: { collection: string; rawId: string }) => targetDocMapById.get(`${target.collection}:${target.rawId}`)).filter(Boolean);
      const existingCount = targetEntries.length;

      if (existingCount === 0) {
        continue;
      }

      if (existingCount !== c.targets.length) {
        reasons.partialTargets++;
        for (const t of c.targets) {
          const key = `${t.collection}:${t.rawId}`;
          if (targetDocMapById.has(key)) claimedTargetIds.add(key);
        }
        continue;
      }

      // Only a stored-target decode or projection refusal is a partial target. Everything else propagates.
      let derivedDigest: string;
      try {
        const decodedLogical = projectTargetLogical(c, buildTargetProjectionMap(c, targetEntries), codec);
        derivedDigest = H(storeKey, 'logical-record', namespace, control.epoch, [c.kind, decodedLogical]);
      } catch (err) {
        if (!isCutoverFenceError(err)) throw err;
        reasons.partialTargets++;
        for (const t of c.targets) {
          const key = `${t.collection}:${t.rawId}`;
          if (targetDocMapById.has(key)) claimedTargetIds.add(key);
        }
        continue;
      }
      if (derivedDigest === c.logicalDigest) {
        prospectiveRetained++;
        for (const t of c.targets) {
          claimedTargetIds.add(`${t.collection}:${t.rawId}`);
        }
      } else {
        reasons.partialTargets++;
        for (const t of c.targets) {
          const key = `${t.collection}:${t.rawId}`;
          if (targetDocMapById.has(key)) claimedTargetIds.add(key);
        }
      }
    }

    for (const key of targetDocMapById.keys()) {
      if (!claimedTargetIds.has(key)) {
        reasons.partialTargets++;
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
      physicalCounts,
      classifications,
      reasons,
      expectedTargetCounts,
      preflight,
    };
  }, { readOnly: true });
}

// Fields each prospective group writes, from the concrete paths of the plan's
// documents. The fresh observation must cover exactly these before preparation.
function requiredFieldsFromPlan(namespace: string, plan: Parameters<typeof prospectiveWrites>[1], subjectBound: boolean): Record<string, string[]> {
  const required = new Map<string, Set<string>>();
  for (const write of prospectiveWrites(namespace, plan)) {
    const paths = required.get(write.group) ?? new Set<string>();
    for (const path of concreteFieldPaths(write.document).multiplicity.keys()) paths.add(path);
    required.set(write.group, paths);
  }
  // A bound descriptor always needs the subject reference field, whether or not this run writes rows.
  if (subjectBound) {
    const refreshFamilies = `${namespace}_refresh_families`;
    const paths = required.get(refreshFamilies) ?? new Set<string>();
    paths.add('subjectRefs');
    required.set(refreshFamilies, paths);
  }
  return Object.fromEntries([...required].map(([group, paths]) => [group, [...paths].sort()]));
}

// Reads every distinct source and target collection inside the caller's transaction
// and builds the candidates, source inventory digest and plan. Both the read-only
// observation pass and the preparation write transaction use it, so they cannot
// diverge.
async function readPreparationInputs(transaction: any, input: {
  db: any;
  namespace: string;
  epoch: number;
  storeKey: Uint8Array;
  FieldPath: any;
  migrationRunId: string;
  codeSha: string;
  codeArtifact: string;
  packageIntegrity: string;
  protocolDigest: string;
  assemblyDigest: string;
  indexSchemaDigest: string;
}) {
  const { db, namespace, epoch, storeKey, FieldPath, migrationRunId, codeSha, codeArtifact, packageIntegrity, protocolDigest, assemblyDigest, indexSchemaDigest } = input;
  const docIdField = FieldPath.documentId();
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
        // Pass physical colName to isTargetFormatRow
        if (!isTargetFormatRow(colName, data)) {
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
    subject: subjectSpecForDb(db, namespace, storeKey),
    epoch,
    runId: migrationRunId,
    codeSha,
    codeArtifact,
    packageIntegrity,
    protocolDigest,
    assemblyDigest,
    indexSchemaDigest,
    now: Date.now(),
  });

  return { candidates, sourceInventoryDigest, plan };
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
  assertValidMigrationContext(options, ['dryRun', 'expectedSourceInventoryDigest']);
  const binding = assertProtectedContext(options, {
    operation: 'adopt',
    options: { dryRun: options.dryRun, expectedSourceInventoryDigest: options.expectedSourceInventoryDigest },
  });
  options = { ...options, key: binding.key };
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
      throw new CutoverFenceError(`Unknown option '${k}' passed to adoptFirestoreLegacyTokens`);
    }
  }

  if (typeof options.dryRun !== 'boolean') {
    throw new CutoverFenceError('adoptFirestoreLegacyTokens requires boolean dryRun option');
  }
  if (typeof options.expectedSourceInventoryDigest !== 'string' || !/^[0-9a-f]{64}$/.test(options.expectedSourceInventoryDigest)) {
    throw new CutoverFenceError('adoptFirestoreLegacyTokens requires 64-character lowercase hex expectedSourceInventoryDigest');
  }

  const { db, FieldPath, key, namespace, expectedEpoch, migrationRunId, codeSha, codeArtifact, packageIntegrity, protocolDigest, dryRun, expectedSourceInventoryDigest } = options;
  const { assemblyDigest, indexSchemaDigest } = protectedBootstrapBindings(db);
  const storeKey = key;
  const codec = createCodec(storeKey);
  const docIdField = FieldPath.documentId();

  // Phase 0: a read-only pass builds the plan the preparation would write, so the
  // fresh observation covers exactly the fields that plan writes. Phase 1 rebuilds
  // the plan inside its transaction and checks it against that observation again.
  // A namespace that is not fenced, or whose plan has errors, has nothing to observe.
  const observed = await db.runTransaction(async (transaction: any) => {
    const timer = startMonotonicTimer();
    assertCredentialUnchanged(db);
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);
    if (control.epoch !== expectedEpoch || control.state !== 'fenced') return null;
    const inputs = await readPreparationInputs(transaction, {
      db, namespace, epoch: control.epoch, storeKey, FieldPath, migrationRunId, codeSha, codeArtifact,
      packageIntegrity, protocolDigest, assemblyDigest, indexSchemaDigest,
    });
    timer.assertUnderDeadline('Preparation observation scan');
    if (inputs.sourceInventoryDigest !== expectedSourceInventoryDigest) {
      throw new CutoverFenceError(`Source inventory digest mismatch: expected ${expectedSourceInventoryDigest}, observed ${inputs.sourceInventoryDigest}`);
    }
    const errors = Object.values(inputs.plan.prepared.reasons || {}).reduce((a: number, b: any) => a + (typeof b === 'number' ? b : 0), 0);
    if (errors > 0) return null;
    return { sourceInventoryDigest: inputs.sourceInventoryDigest, requiredFields: requiredFieldsFromPlan(namespace, inputs.plan, subjectSpecForDb(db, namespace, storeKey) !== null) };
  });
  if (observed !== null) {
    await observeFreshIndexes({ db, purpose: 'preparation', requiredFields: observed.requiredFields, sourceInventoryDigest: observed.sourceInventoryDigest });
  }
  // Phase 1: Preparation in transaction (supporting restart per Section 5)
  // The preparation transaction's three outcomes, each with exactly the fields that outcome has.
  type PrepareResult =
    | { dryRun: true; scanned: number; migrated: number; skipped: number; errors: number }
    | { dryRun: false; isResume: true; prepared: any; planSpec: any }
    | { dryRun: false; isResume: false; candidates: any[]; plan: any; prepared: any };
  const prepResult: PrepareResult = await db.runTransaction(async (transaction: any): Promise<PrepareResult> => {
    const timer = startMonotonicTimer();
    assertCredentialUnchanged(db);
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);
    if (control.epoch !== expectedEpoch) {
      throw new CutoverFenceError(`Epoch mismatch in adopt: expected ${expectedEpoch}, got ${control.epoch}`);
    }

    // Restart/resumption check FIRST before any source scanning
    if (control.state === 'migrating') {
      if (dryRun) {
        throw new CutoverFenceError('Dry-run inspection cannot resume a migration already in progress');
      }
      if (control.migrationRunId !== migrationRunId) {
        throw new CutoverFenceError(`Cannot resume migration for namespace ${namespace}: migrationRunId mismatch`);
      }
      const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${control.epoch}`);
      const prepSnap = await transaction.get(prepRef);
      if (!prepSnap.exists) {
        throw new CutoverFenceError(`Prepared manifest missing during resume of migrating namespace ${namespace}`);
      }
      const prepDoc = prepSnap.data();
      validateMigrationIdentityFields(prepDoc, namespace, expectedEpoch, migrationRunId);
      if (prepDoc.kind !== 'prepared' || prepDoc.sourceInventoryDigest !== expectedSourceInventoryDigest ||
        prepDoc.codeSha !== codeSha || prepDoc.codeArtifact !== codeArtifact ||
        prepDoc.packageIntegrity !== packageIntegrity || prepDoc.protocolDigest !== protocolDigest ||
        prepDoc.assemblyDigest !== assemblyDigest || prepDoc.indexSchemaDigest !== indexSchemaDigest) {
        throw new CutoverFenceError('Prepared manifest identity or inventory mismatch during resume');
      }
      if (prepDoc.encoderVersion !== 1 || prepDoc.namespace !== namespace || prepDoc.epoch !== expectedEpoch ||
        prepDoc.migrationRunId !== migrationRunId || control.migrationRunId !== migrationRunId) {
        throw new CutoverFenceError('Prepared manifest identity does not match the control record during resume');
      }
      // The reviewed core's identity check, the same one its migrating branch applies before it accepts a stored doc.
      assertPreparedIdentity(prepDoc, {
        namespace, epoch: expectedEpoch, migrationRunId, codeSha, codeArtifact, packageIntegrity,
        protocolDigest, assemblyDigest, indexSchemaDigest, encoderVersion: 1,
      }, namespace);

      // The stored manifest carries exactly the core's key list, plus the projector keys once records exist.
      validateMapKeysExact(
        prepDoc,
        prepDoc.totalPhysicalRecords > 0 ? [...REQUIRED_PREPARED_MANIFEST_KEYS, ...NONEMPTY_PROJECTOR_KEYS] : REQUIRED_PREPARED_MANIFEST_KEYS,
        'prepared manifest',
      );
      // Validate planSpec binding
      const computedPlanDigest = computePlanDigest(namespace, control.epoch, prepDoc.planSpec);
      if (prepDoc.planDigest !== computedPlanDigest) {
        throw new CutoverFenceError('prepDoc.planDigest does not match computePlanDigest(prepDoc.planSpec)');
      }

      timer.assertUnderDeadline('Preparation resume check');
      return {
        dryRun: false,
        isResume: true,
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

    // A fenced namespace must not already hold a prepared manifest. One that does is an inconsistent state, and
    // the engine refuses it rather than overwriting or resuming it.
    const existingPreparedRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${control.epoch}`);
    if ((await transaction.get(existingPreparedRef)).exists) {
      throw new CutoverFenceError(`Inconsistent state: prepared manifest exists while cutover state is 'fenced' for namespace ${namespace}`);
    }
    timer.assertUnderDeadline('Fenced prepared check');


    const { candidates, sourceInventoryDigest, plan } = await readPreparationInputs(transaction, {
      db, namespace, epoch: control.epoch, storeKey, FieldPath, migrationRunId, codeSha, codeArtifact,
      packageIntegrity, protocolDigest, assemblyDigest, indexSchemaDigest,
    });
    timer.assertUnderDeadline('Preparation source scan');

    const preparationBinding = getProtectedBinding(db);
    if (!preparationBinding) throw new CutoverRefusedError('Protected migration context required for preparation');
    assertSupportedCutoverNamespace(preparationBinding.namespace);
    // Every identity field comes from the authenticated binding. The gate compares the prepared plan against it.
    const preparationIdentity: PreparationIdentity = {
      namespace: preparationBinding.namespace,
      epoch: preparationBinding.expectedEpoch,
      migrationRunId: preparationBinding.migrationRunId,
      codeSha: preparationBinding.codeSha,
      codeArtifact: preparationBinding.codeArtifact,
      packageIntegrity: preparationBinding.packageIntegrity,
      protocolDigest: preparationBinding.protocolDigest,
      assemblyDigest: preparationBinding.assemblyDigest,
      indexSchemaDigest: preparationBinding.indexSchemaDigest,
      indexPolicyDigest: preparationBinding.indexPolicyDigest,
      encoderVersion: 1,
    };
    if (sourceInventoryDigest !== expectedSourceInventoryDigest) {
      throw new CutoverFenceError(
        `Source inventory digest mismatch: expected ${expectedSourceInventoryDigest}, observed ${sourceInventoryDigest}`,
      );
    }

    const totalErrors = Object.values(plan.prepared.reasons || {}).reduce((a: number, b: any) => a + (typeof b === 'number' ? b : 0), 0);

    if (dryRun) {
      timer.assertUnderDeadline('Dry run inspection');
      if (totalErrors === 0) {
        assertPreparationGate(db, { completePlan: plan, expectedIdentity: preparationIdentity, sourceInventoryDigest });
      }
      return {
        dryRun: true,
        scanned: candidates.length,
        migrated: 0,
        skipped: 0,
        errors: totalErrors,
      };
    }

    if (totalErrors > 0) {
      throw new CutoverFenceError(
        `Cannot prepare migration for namespace ${namespace}: detected ${totalErrors} error(s) in source inventory (${JSON.stringify(plan.prepared.reasons)})`,
      );
    }

    timer.assertUnderDeadline('Preparation attempt');

    // Write prepared manifest + transition control to migrating
    assertPreparationGate(db, { completePlan: plan, expectedIdentity: preparationIdentity, sourceInventoryDigest });
    await prepareMigrationInTransaction(transaction, db, {
      namespace,
      prepDoc: plan.prepared,
      storeKey,
      FieldPath,
      timer,
      completePlan: plan,
      expectedIdentity: preparationIdentity,
      indexManifest: preparationBinding.indexSchema,
      protectedBinding: {
        profile: preparationBinding.profile,
        project: preparationBinding.project,
        database: preparationBinding.database,
        subjectDescriptor: preparationBinding.subjectDescriptor,
      },
    });

    timer.assertUnderDeadline('Preparation commit');

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

  const { prepared, isResume } = prepResult;
  // A resume rebuilds candidates from the sources before any use (below), so its placeholder is never read.
  let candidates: any[] = prepResult.isResume ? [] : prepResult.candidates;
  let migratedCount = 0;
  let skippedCount = 0;

  // On resume: reconstruct candidates from sources if resuming
  if (isResume) {
    // Read source docs to reconstruct pending candidates
    const { source: sourceNames, target: targetNames } = getCutoverDistinctCollectionNames(namespace);
    type Reference = { collection: string; id: string; recordDigest: string | null };
    type Commitment = { id: string; logicalDigest: string; sources: Reference[]; targets: Reference[] };
    type Receipt = Record<string, unknown> & {
      candidateId: string; preparedDigest: string; candidateDigest: string; logicalDigest: string;
      sourceAfter: Reference[]; targetAfter: Reference[]; disposition: 'written' | 'retained';
    };
    const sourceDocsByKey = new Map<string, Array<{ id: string; data(): Record<string, unknown> | undefined }>>();
    const sourceAfter = new Map<string, string>();
    const targetAfter = new Map<string, string>();
    const targetNamesSet = new Set(Object.values(targetNames));
    const sourceNamesSet = new Set(Object.values(sourceNames));
    for (const [k, colName] of Object.entries(sourceNames)) {
      const snap = await db.collection(colName).orderBy(docIdField).get();
      const docs = targetNamesSet.has(colName)
        ? snap.docs.filter(d => !isTargetFormatRow(colName, d.data()))
        : snap.docs;
      sourceDocsByKey.set(k, docs);
      for (const d of docs) {
        const id = computeKeyedDocId(storeKey, 'source-id', namespace, expectedEpoch, k, d.id);
        sourceAfter.set(`${k}:${id}`, computeSourceRecordDigest(storeKey, namespace, expectedEpoch, k, id, d.data()));
      }
    }
    for (const [k, colName] of Object.entries(targetNames)) {
      const snap = await db.collection(colName).orderBy(docIdField).get();
      const docs = sourceNamesSet.has(colName)
        ? snap.docs.filter(d => isTargetFormatRow(colName, d.data()))
        : snap.docs;
      for (const d of docs) {
        const id = computeKeyedDocId(storeKey, 'target-id', namespace, expectedEpoch, k, d.id);
        targetAfter.set(`${k}:${id}`, computeTargetRecordDigest(storeKey, namespace, expectedEpoch, k, id, d.data()));
      }
    }
    const receipts = await db.collection(`${namespace}_meta`).orderBy(docIdField)
      .startAt(`migration_receipt_${expectedEpoch}_`).endBefore(`migration_receipt_${expectedEpoch}\``).get();
    const commitments = new Map<string, Commitment>(
      (prepared.candidateCommitments as Commitment[]).map(c => [c.id, c]),
    );
    const completed = new Set<string>();
    for (const receiptSnapshot of receipts.docs) {
      const data = receiptSnapshot.data();
      validateReceipt(data, namespace, expectedEpoch, migrationRunId);
      const receipt = data as Receipt;
      const commitment = commitments.get(receipt.candidateId);
      if (!commitment || completed.has(receipt.candidateId) ||
        receiptSnapshot.id !== `migration_receipt_${expectedEpoch}_${receipt.candidateId}` ||
        receipt.preparedDigest !== D('prepared', namespace, expectedEpoch, prepared) ||
        receipt.candidateDigest !== D('candidate', namespace, expectedEpoch, commitment) ||
        receipt.logicalDigest !== commitment.logicalDigest ||
        REQUIRED_IDENTITY_KEYS.some((key: string) => receipt[key] !== prepared[key])) {
        throw new CutoverFenceError('Resume receipt does not match its prepared candidate');
      }
      const plans = prepared.planSpec.candidates as Array<{
        candidateId: string; sourceActions: Array<{ collection: string; id: string; action: string }>;
      }>;
      const itemPlan = plans.find(item => item.candidateId === receipt.candidateId);
      const refs = (items: Reference[]) => items.map(item => `${item.collection}:${item.id}`).sort(codeUnitCompare);
      if (!itemPlan || C(refs(receipt.sourceAfter)) !== C(refs(commitment.sources)) ||
        C(refs(receipt.targetAfter)) !== C(refs(commitment.targets))) {
        throw new CutoverFenceError('Resume receipt does not cover its prepared references');
      }
      for (const source of receipt.sourceAfter) {
        const action = itemPlan.sourceActions.find(a => a.collection === source.collection && a.id === source.id);
        const before = commitment.sources.find(s => s.collection === source.collection && s.id === source.id);
        const expected = action?.action === 'retain' ? before?.recordDigest : null;
        if (!action || source.recordDigest !== expected ||
          (sourceAfter.get(`${source.collection}:${source.id}`) ?? null) !== expected) {
          throw new CutoverFenceError('Resume receipt source postimage mismatch');
        }
      }
      for (const target of receipt.targetAfter) {
        if (targetAfter.get(`${target.collection}:${target.id}`) !== target.recordDigest) {
          throw new CutoverFenceError('Resume receipt target postimage mismatch');
        }
      }
      completed.add(receipt.candidateId);
      if (receipt.disposition === 'retained') skippedCount++;
      else migratedCount++;
    }

    const reconstructed = extractCandidatesAndPlan({
      sourceDocsByKey,
      storeKey,
      namespace,
      subject: subjectSpecForDb(db, namespace, storeKey),
      epoch: expectedEpoch,
      runId: migrationRunId,
      codeSha,
      codeArtifact,
      packageIntegrity,
      protocolDigest,
      assemblyDigest,
      indexSchemaDigest,
      now: Date.now(),
    });
    candidates = reconstructed.candidates;
    if (Object.values(reconstructed.reasons).some(count => count !== 0) ||
      candidates.length + completed.size !== commitments.size ||
      candidates.some(c => completed.has(c.id) || C(c.commitment) !== C(commitments.get(c.id)))) {
      throw new CutoverFenceError('Resume source inventory does not match the pending prepared candidates');
    }
  }

  const now = Date.now();

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

  const expectedPreparedDigest = D('prepared', namespace, expectedEpoch, prepared);

  // Phase 2: Execute each item in its own atomic transaction with exact receipt and latch
  for (const c of candidates) {
    const itemResult = await db.runTransaction(async (transaction: any) => {
      const timer = startMonotonicTimer();
      assertCredentialUnchanged(db);
      const control = await readCutoverFenceInTransaction(transaction, db, namespace);
      if (control.epoch !== expectedEpoch) throw new CutoverFenceError('Migration epoch changed before item transaction');
      if (control.state !== 'migrating') {
        throw new CutoverFenceError(`Cannot execute item: state must be 'migrating', got '${control.state}'`);
      }
      if (control.migrationRunId !== migrationRunId) {
        throw new CutoverFenceError('migrationRunId mismatch during item transaction');
      }

      // Read and validate prepared manifest in transaction
      const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${control.epoch}`);
      const prepSnap = await transaction.get(prepRef);
      if (!prepSnap.exists) {
        throw new CutoverFenceError(`Prepared manifest missing in item transaction for namespace ${namespace}`);
      }
      const prepDoc = prepSnap.data();
      validateMigrationIdentityFields(prepDoc, namespace, expectedEpoch, migrationRunId);
      if (prepDoc.migrationRunId !== migrationRunId || prepDoc.epoch !== control.epoch) {
        throw new CutoverFenceError('migration_prepared identity mismatch in item transaction');
      }
      if (prepDoc.codeSha !== codeSha || prepDoc.codeArtifact !== codeArtifact || prepDoc.protocolDigest !== protocolDigest) {
        throw new CutoverFenceError('migration_prepared provenance mismatch in item transaction');
      }
      if (D('prepared', namespace, control.epoch, prepDoc) !== expectedPreparedDigest) {
        throw new CutoverFenceError('Prepared manifest changed before item transaction');
      }
      const candidateCommitment = prepDoc.candidateCommitments?.find((item: any) => item.id === c.id);
      if (!candidateCommitment) {
        throw new CutoverFenceError(`Candidate ${sanitizeId(c.id)} not bound in prepared manifest commitments`);
      }
      if (!c.commitment || C(candidateCommitment) !== C(c.commitment)) {
        throw new CutoverFenceError('Candidate commitment changed before item transaction');
      }

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
          timer.assertUnderDeadline('Item retry check');
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
      const prospectiveEntries = c.targets.map((t: { collection: string; id: string; rawId: string }) => ({
        collection: t.collection, physicalId: t.rawId, data: c.postimageByTargetId.get(t.id),
      }));
      const prospectiveLogical = projectTargetLogical(c, buildTargetProjectionMap(c, prospectiveEntries), codec);
      if (H(storeKey, 'logical-record', namespace, control.epoch, [c.kind, prospectiveLogical]) !== c.logicalDigest) {
        throw new CutoverFenceError('Candidate target postimages do not match the source projection');
      }

      // Check retained path: read target documents first before overwrite
      // Decode existing targets using projector rather than comparing randomized ciphertext bytes
      let allTargetsAlreadyRetained = true;
      let hasAnyTarget = false;
      const existingTargetEntries: Array<{ collection: string; physicalId: string; data: Record<string, unknown> }> = [];
      const retainedTargetRows = new Map<string, unknown>();

      for (const t of c.targets) {
        const physicalCol = targetColMap[t.collection];
        const docId = t.rawId;
        if (computeKeyedDocId(storeKey, 'target-id', namespace, control.epoch, t.collection, docId) !== t.id) throw new CutoverFenceError('Candidate target identity changed');
        const targetSnap = await transaction.get(db.collection(physicalCol).doc(docId));

        if (targetSnap.exists) {
          hasAnyTarget = true;
          existingTargetEntries.push({ collection: t.collection, physicalId: docId, data: targetSnap.data() || {} });
          retainedTargetRows.set(t.id, targetSnap.data());
        } else {
          allTargetsAlreadyRetained = false;
        }
      }

      if (hasAnyTarget) {
        if (!allTargetsAlreadyRetained) {
          throw new CutoverFenceError(`Conflicting partial target graph detected for candidate ${sanitizeId(c.id)}; cannot overwrite`);
        }
        try {
          const existingLogical = projectTargetLogical(c, buildTargetProjectionMap(c, existingTargetEntries), codec);
          if (C(existingLogical) !== C(c.logicalDigest)) {
            // Check if logical digest matches
            const derivedDigest = H(storeKey, 'logical-record', namespace, control.epoch, [c.kind, existingLogical]);
            if (derivedDigest !== c.logicalDigest) {
              throw new CutoverFenceError(`Conflicting target document content detected for candidate ${sanitizeId(c.id)}; cannot overwrite`);
            }
          }
        } catch (err: any) {
          throw new CutoverFenceError(`Conflicting target document format detected for candidate ${sanitizeId(c.id)}: ${err.message}`);
        }
      }

      timer.assertUnderDeadline('Item transaction attempt');

      // All transaction reads must precede any buffered writes or deletes
      if (control.emptyNamespace !== true) {
        await markIrreversibleInTransaction(transaction, db, namespace, control.epoch, migrationRunId, () => now, timer);
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
          const docId = t.rawId;
          transaction.set(db.collection(physicalCol).doc(docId), post);
        }
      }
      // Write exact receipt
      const targetAfter = c.targets.map((t: any) => {
        const post = allTargetsAlreadyRetained ? retainedTargetRows.get(t.id) : c.postimageByTargetId.get(t.id);
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
        preparedDigest: D('prepared', namespace, control.epoch, prepDoc),
        candidateId: c.id,
        candidateDigest: D('candidate', namespace, control.epoch, c.commitment || c),
        disposition,
        sourceAfter,
        targetAfter,
        logicalDigest: c.logicalDigest,
        completedAt: now,
      };

      transaction.set(receiptRef, receiptDoc);
      timer.assertUnderDeadline('Item transaction commit');
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
    assertCredentialUnchanged(db);
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
    const targetRowsById = new Map<string, Record<string, unknown> & { id: string }>();
    const targetCounts: Record<string, number> = Object.fromEntries(TARGET_COUNT_KEYS.map((key: string) => [key, 0]));

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
        if (['authCodes', 'resumeTokens', 'oauthClients'].includes(colKey) &&
          !isTargetFormatRow(physicalName, data)) continue;
        const targetId = computeKeyedDocId(storeKey, 'target-id', namespace, control.epoch, colKey, d.id);
        const recDigest = computeTargetRecordDigest(storeKey, namespace, control.epoch, colKey, targetId, data);
        targetDescriptors.push({ collection: colKey, id: targetId, recordDigest: recDigest });
        targetCounts[colKey]++;
        targetRowsById.set(`${colKey}:${targetId}`, { ...data, id: d.id });
      }
    }
    targetDescriptors.sort(compareDescriptors);
    const logicalItems: Array<[string, string]> = [];
    const commitments = prepared.candidateCommitments as Array<{
      id: string; kind: string; logicalDigest: string; targets: Array<{ collection: string; id: string }>;
    }>;
    for (const candidate of commitments) {
      const targets = new Map<string, Record<string, unknown>>();
      const retiredIds: string[] = [];
      const rows = candidate.targets.map(ref => {
        const row = targetRowsById.get(`${ref.collection}:${ref.id}`);
        if (!row) throw new CutoverFenceError('Final target graph is incomplete');
        return { ref, row };
      });
      const family = rows.find(({ ref }) => ref.collection === 'families')?.row;
      for (const { ref, row } of rows) {
        if (ref.collection === 'refresh') {
          if (!family || row.familyId !== family.id) throw new CutoverFenceError('Final refresh family mismatch');
          const role = row.id === family.activeRefreshId ? 'activeRefresh' : 'prevRefresh';
          if (targets.has(role)) throw new CutoverFenceError('Duplicate final refresh role');
          targets.set(role, row);
        } else if (ref.collection === 'retiredRefreshTokens') {
          if (!family || row.familyId !== family.id) throw new CutoverFenceError('Final retired refresh family mismatch');
          retiredIds.push(row.id);
        } else {
          const role = ref.collection === 'oauthClients' ? 'clients' : ref.collection;
          if (targets.has(role)) throw new CutoverFenceError('Duplicate final target role');
          targets.set(role, row);
        }
      }
      if (retiredIds.length) targets.set('retiredRefresh', { ids: retiredIds.sort(codeUnitCompare) });
      const logical = projectTargetLogical(candidate, targets, codec);
      const digest = H(storeKey, 'logical-record', namespace, control.epoch, [candidate.kind, logical]);
      if (digest !== candidate.logicalDigest) throw new CutoverFenceError('Final target semantic mismatch');
      logicalItems.push([candidate.id, digest]);
    }
    const targetLogicalDigest = computeLogicalInventoryDigest(storeKey, namespace, control.epoch, logicalItems);

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
      targetCounts,
      scanned: prepared.scanned,
      migrated: migratedCount,
      skipped: skippedCount,
      errors: 0,
      sourceInventoryDigest: prepared.sourceInventoryDigest,
      targetInventoryDigest,
      sourceLogicalDigest: prepared.sourceLogicalDigest,
      targetLogicalDigest,
      receiptSetDigest,
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
    };

    timer.assertUnderDeadline('Finalization attempt');

    await finalizeMigrationInTransaction(transaction, db, {
      namespace,
      finalDoc,
      markerDoc,
      storeKey,
      FieldPath,
      timer,
    });

    timer.assertUnderDeadline('Finalization commit');
  });

  return {
    scanned: prepared.scanned,
    migrated: migratedCount,
    skipped: skippedCount,
    errors: 0,
  };
}

export async function verifyActiveFirestoreMigration(
  context: MigrationContext & { migrationManifestDigest: string },
): Promise<{ status: 'active'; emptyNamespace: boolean; planDigest: string }> {
  assertValidMigrationContext(context, ['migrationManifestDigest']);
  const binding = assertProtectedContext(context, { operation: 'verifyActive', options: { migrationManifestDigest: context.migrationManifestDigest } });
  context = { ...context, key: binding.key };
  if (typeof context.migrationManifestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(context.migrationManifestDigest)) {
    throw new CutoverFenceError('migrationManifestDigest must be a 64-character lowercase hex string');
  }
  // Read-only: verification never writes, so it takes a read-only transaction and holds no
  // write locks. The reviewed core supplies the verification; refuse while it is absent.
  const verifyActive = (canonicalCoreVerify as Record<string, unknown>).verifyActiveMigrationInTransaction;
  if (typeof verifyActive !== 'function') {
    throw new CutoverRefusedError('Active verification requires verifyActiveMigrationInTransaction from the reviewed canonical core, which this build does not export');
  }
  return context.db.runTransaction(async transaction => {
    const timer = startMonotonicTimer();
    const result = await (verifyActive as (...args: unknown[]) => Promise<{ status: 'active'; emptyNamespace: boolean; planDigest: string }>)(transaction, context.db, {
      ...context,
      storeKey: context.key,
      timer,
    });
    timer.assertUnderDeadline('Active ownership verification');
    return result;
  }, { readOnly: true });
}

export async function activateFirestoreMigration(context: MigrationContext & { migrationManifestDigest: string }): Promise<{
  status: 'activated' | 'already_active';
  epoch: number;
  migrationRunId: string;
  migrationManifestDigest: string;
  planDigest: string;
}> {
  assertValidMigrationContext(context, ['migrationManifestDigest']);
  const binding = assertProtectedContext(context, { operation: 'activate', options: { migrationManifestDigest: context.migrationManifestDigest } });
  context = { ...context, key: binding.key };
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
  for (const k of Object.keys(context)) {
    if (!allowedKeys.has(k)) {
      throw new CutoverFenceError(`Unknown option '${k}' passed to activateFirestoreMigration`);
    }
  }

  const { db, namespace, expectedEpoch, migrationRunId, key, migrationManifestDigest } = context;
  if (!/^[0-9a-f]{64}$/.test(migrationManifestDigest)) {
    throw new CutoverFenceError('migrationManifestDigest must be a 64-character lowercase hex string');
  }
  // Only a v3_ready namespace needs a fresh observation. It is read before the
  // transaction, because Admin REST reads cannot run inside it. The transaction
  // still refuses when no matching observation is recorded.
  const fenceBefore = await getCutoverFenceRecord(db, namespace);
  if (fenceBefore?.state === 'v3_ready') {
    await observeFreshIndexes({ db, purpose: 'activation', requiredFields: {}, sourceInventoryDigest: null });
  }
  return await db.runTransaction(async (transaction: any) => {
    const timer = startMonotonicTimer();
    assertCredentialUnchanged(db);
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);

    if (control.epoch !== expectedEpoch || control.migrationRunId !== migrationRunId ||
      control.migrationManifestDigest !== migrationManifestDigest) {
      throw new CutoverFenceError('Activation control identity or manifest digest mismatch');
    }
    if (control.state !== 'v3_ready' && control.state !== 'v3_active') {
      throw new CutoverFenceError(`Cannot activate namespace ${namespace}: state must be v3_ready or v3_active`);
    }
    if (control.state === 'v3_ready') {
      const binding = getProtectedBinding(db);
      if (!binding) throw new CutoverRefusedError('Protected migration context required for activation');
      assertActivationObservation(db, binding);
    }
    const finalSnap = await transaction.get(db.collection(`${namespace}_meta`).doc(`migration_manifest_${expectedEpoch}`));
    if (!finalSnap.exists) throw new CutoverFenceError('Final migration manifest is missing');
    const finalDoc = finalSnap.data() as Record<string, unknown>;
    validateMigrationIdentityFields(finalDoc, namespace, expectedEpoch, migrationRunId);
    if (D('final', namespace, expectedEpoch, finalDoc) !== migrationManifestDigest ||
      typeof finalDoc.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(finalDoc.planDigest)) {
      throw new CutoverFenceError('Final migration manifest digest or plan binding mismatch');
    }
    if (control.state === 'v3_ready') {
      const { assemblyDigest, indexSchemaDigest } = protectedBootstrapBindings(context.db);
      if (finalDoc.assemblyDigest !== assemblyDigest || finalDoc.indexSchemaDigest !== indexSchemaDigest) {
        throw new CutoverFenceError('Final migration manifest bootstrap bindings mismatch');
      }
    }

    timer.assertUnderDeadline('Activation attempt');

    const res = await activateMigrationInTransaction(transaction, db, {
      ...context,
      storeKey: key,
      migrationManifestDigest,
      timer,
    });
    timer.assertUnderDeadline('Activation commit');

    return {
      status: res.status,
      epoch: control.epoch,
      migrationRunId,
      migrationManifestDigest,
      planDigest: finalDoc.planDigest as string,
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
  const binding = assertProtectedContext(context, { operation: 'status', options: {} });
  context = { ...context, key: binding.key };
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
      const marker = markerSnap.data() as Record<string, unknown>;
      validateMigrationIdentityFields(marker, namespace, expectedEpoch, migrationRunId);
      if (marker.codeArtifact !== codeArtifact || marker.protocolDigest !== protocolDigest) {
        throw new CutoverFenceError('Immutable migration marker artifact/protocolDigest mismatch');
      }

      // Verify bootstrap bindings only when v3_ready (before activation)
      if (control.state === 'v3_ready') {
        const { assemblyDigest, indexSchemaDigest } = protectedBootstrapBindings(context.db);
        if (marker.assemblyDigest !== assemblyDigest || marker.indexSchemaDigest !== indexSchemaDigest) {
          throw new CutoverFenceError('Immutable migration marker bootstrap bindings mismatch');
        }
      }

      const finalRef = db.collection(`${namespace}_meta`).doc(`migration_manifest_${control.epoch}`);
      const finalSnap = await transaction.get(finalRef); // IN TRANSACTION SNAPSHOT!
      if (finalSnap.exists) {
        const f = finalSnap.data() as Record<string, unknown>;
        if (control.state === 'v3_ready') {
          const { assemblyDigest, indexSchemaDigest } = protectedBootstrapBindings(context.db);
          if (f.assemblyDigest !== assemblyDigest || f.indexSchemaDigest !== indexSchemaDigest) {
            throw new CutoverFenceError('Final migration manifest bootstrap bindings mismatch');
          }
        }
        planDigest = f.planDigest as string | undefined;
        sourceInventoryDigest = f.sourceInventoryDigest as string | undefined;
      }
    }

    timer.assertUnderDeadline('Status check');

    return {
      state: control.state,
      epoch: control.epoch,
      migrationRunId: control.migrationRunId,
      migrationManifestDigest: control.migrationManifestDigest,
      planDigest,
      sourceInventoryDigest,
    };
  }, { readOnly: true });
}
