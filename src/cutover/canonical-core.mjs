import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  PROJECTOR_ID,
  PROJECTOR_VERSION,
  createCodec,
  projectSourceLogical,
  projectTargetLogical,
} from '../store/netsapiens-projector.mjs';

export const SUPPORTED_CUTOVER_NAMESPACES = ['mcp', 'pwmcp', 'readonly_mcp'];

export function isSupportedCutoverNamespace(namespace) {
  return SUPPORTED_CUTOVER_NAMESPACES.includes(namespace);
}

export function assertSupportedCutoverNamespace(namespace) {
  if (!isSupportedCutoverNamespace(namespace)) {
    throw new CutoverFenceError(
      `Unsupported cutover namespace: ${namespace}. Supported namespaces are: ${SUPPORTED_CUTOVER_NAMESPACES.join(', ')}`,
    );
  }
}

export class CutoverFenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CutoverFenceError';
    this.kitCode = 'cutover_fence_error';
    Object.defineProperty(this, 'kitCode', { value: 'cutover_fence_error', enumerable: true });
  }
}

export class CutoverRefusedError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'CutoverRefusedError';
    this.kitCode = 'cutover_refused';
    this.cutoverState = details?.cutoverState;
    this.epoch = details?.epoch;
  }
}

export function isCutoverFenceError(err) {
  return Boolean(
    err &&
      typeof err === 'object' &&
      (err.kitCode === 'cutover_fence_error' || err.name === 'CutoverFenceError'),
  );
}

export function isCutoverRefusedError(err) {
  return Boolean(
    err &&
      typeof err === 'object' &&
      err.kitCode === 'cutover_refused',
  );
}

export function sanitizeId(id) {
  if (typeof id !== 'string' || !id) return '[sanitized]';
  return createHash('sha256').update(id).digest('hex').slice(0, 12);
}

export const PHYSICAL_COUNT_KEYS = [
  'families',
  'tokens',
  'refresh',
  'upstream',
  'authCodes',
  'resumeTokens',
  'oauthClients',
  'clients',
];

export const TARGET_COUNT_KEYS = [
  'families',
  'tokens',
  'refresh',
  'upstream',
  'authCodes',
  'resumeTokens',
  'retiredRefreshTokens',
  'oauthClients',
];

export const CLASSIFICATION_KEYS = [
  'pr56Families',
  'baseFormatTokens',
  'authCodes',
  'resumeTokens',
  'clients',
];

export const CANDIDATE_KIND_TO_CLASSIFICATION = {
  family: 'pr56Families',
  base: 'baseFormatTokens',
  code: 'authCodes',
  resume: 'resumeTokens',
  client: 'clients',
  pr56Families: 'pr56Families',
  baseFormatTokens: 'baseFormatTokens',
  authCodes: 'authCodes',
  resumeTokens: 'resumeTokens',
  clients: 'clients',
};

export const REASON_KEYS = [
  'orphanAccessTokens',
  'orphanRefreshPointers',
  'orphanUpstreamGrants',
  'conflictingClaims',
  'missingAccessTokens',
  'missingUpstreamGrants',
  'missingRefreshPointers',
  'partialTargets',
  'malformedRecords',
];

export const ALLOWED_STATE_TRANSITIONS = {
  legacy_open: ['closing'],
  closing: ['legacy_open', 'fenced'],
  fenced: ['closing'],
  migrating: [],
  v3_ready: [],
  v3_active: [],
};

export const REQUIRED_IDENTITY_KEYS = [
  'schemaVersion',
  'namespace',
  'epoch',
  'migrationRunId',
  'codeSha',
  'codeArtifact',
  'packageIntegrity',
  'protocolDigest',
  'assemblyDigest',
  'indexSchemaDigest',
  'encoderVersion',
  'planDigest',
];

export const REQUIRED_OWNERSHIP_MARKER_KEYS = [
  ...REQUIRED_IDENTITY_KEYS,
  'kind',
  'preparedDigest',
  'migrationManifestDigest',
  'emptyNamespace',
  'adoptedAt',
];

export const REQUIRED_PREPARED_MANIFEST_KEYS = [
  ...REQUIRED_IDENTITY_KEYS,
  'kind',
  'preparedAt',
  'physicalCounts',
  'classifications',
  'reasons',
  'totalPhysicalRecords',
  'scanned',
  'expectedTargetCounts',
  'sourceInventoryDigest',
  'sourceLogicalDigest',
  'candidateCommitments',
  'planSpec',
];
export const REQUIRED_FINAL_MANIFEST_KEYS = [
  ...REQUIRED_IDENTITY_KEYS,
  'kind',
  'preparedDigest',
  'completedAt',
  'physicalCounts',
  'classifications',
  'reasons',
  'totalPhysicalRecords',
  'targetCounts',
  'scanned',
  'migrated',
  'skipped',
  'errors',
  'sourceInventoryDigest',
  'targetInventoryDigest',
  'sourceLogicalDigest',
  'targetLogicalDigest',
  'receiptSetDigest',
];

export const REQUIRED_CANDIDATE_KEYS = [
  'id',
  'kind',
  'sources',
  'targets',
  'logicalDigest',
];

export const REQUIRED_RECEIPT_KEYS = [
  ...REQUIRED_IDENTITY_KEYS,
  'kind',
  'preparedDigest',
  'candidateId',
  'candidateDigest',
  'disposition',
  'sourceAfter',
  'targetAfter',
  'logicalDigest',
  'completedAt',
];

export const APPROVED_GRAPH_PROJECTOR_ID = PROJECTOR_ID;
export const APPROVED_GRAPH_PROJECTOR_VERSION = PROJECTOR_VERSION;
export const NONEMPTY_PROJECTOR_KEYS = ['projectorId', 'projectorVersion', 'projectorDigest'];

const APPROVED_PROJECTOR_SHA256 = '51892d399b95546bdc247cd5e07a20db90677353e208b6124763ea57549a8da0';

export function getMeasuredProjectorDigest() {
  return APPROVED_PROJECTOR_SHA256;
}

export function validateMapKeysExact(obj, allowedKeys, label = 'object') {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new CutoverFenceError(`${label} must be a non-null object`);
  }
  const actualKeys = Object.keys(obj);
  const allowedSet = new Set(allowedKeys);
  for (const k of actualKeys) {
    if (!allowedSet.has(k)) {
      throw new CutoverFenceError(`Unexpected extra field '${k}' in ${label}`);
    }
  }
  for (const k of allowedKeys) {
    if (!(k in obj) || obj[k] === undefined) {
      throw new CutoverFenceError(`Missing required field '${k}' in ${label}`);
    }
  }
}

export function validateMigrationIdentityFields(doc, expectedNamespace, expectedEpoch, expectedRunId) {
  if (!doc || typeof doc !== 'object') {
    throw new CutoverFenceError('Migration manifest must be an object');
  }
  if (doc.schemaVersion !== 2 && doc.schemaVersion !== 1) {
    throw new CutoverFenceError(`Unsupported manifest schemaVersion: expected 2, got ${doc.schemaVersion}`);
  }
  if (doc.namespace !== expectedNamespace) {
    throw new CutoverFenceError(
      `Manifest namespace mismatch: expected ${expectedNamespace}, got ${doc.namespace}`,
    );
  }
  if (doc.epoch !== expectedEpoch) {
    throw new CutoverFenceError(`Manifest epoch mismatch: expected ${expectedEpoch}, got ${doc.epoch}`);
  }
  if (expectedRunId && doc.migrationRunId !== expectedRunId) {
    throw new CutoverFenceError(
      `Manifest migrationRunId mismatch: expected ${expectedRunId}, got ${doc.migrationRunId}`,
    );
  }
  if (typeof doc.codeSha !== 'string' || !/^[0-9a-f]{40}$/.test(doc.codeSha)) {
    throw new CutoverFenceError(`Invalid codeSha in manifest: ${doc.codeSha}`);
  }
  if (typeof doc.codeArtifact !== 'string' || !doc.codeArtifact.trim()) {
    throw new CutoverFenceError('Invalid codeArtifact in manifest');
  }
  if (typeof doc.packageIntegrity !== 'string' || !doc.packageIntegrity.trim()) {
    throw new CutoverFenceError('Invalid packageIntegrity in manifest');
  }
  if (typeof doc.protocolDigest !== 'string' || !/^[0-9a-f]{64}$/.test(doc.protocolDigest)) {
    throw new CutoverFenceError(`Invalid protocolDigest in manifest: ${doc.protocolDigest}`);
  }
  if (typeof doc.assemblyDigest !== 'string' || !/^[0-9a-f]{64}$/.test(doc.assemblyDigest)) {
    throw new CutoverFenceError(`Invalid assemblyDigest in manifest: ${doc.assemblyDigest}`);
  }
  if (typeof doc.indexSchemaDigest !== 'string' || !/^[0-9a-f]{64}$/.test(doc.indexSchemaDigest)) {
    throw new CutoverFenceError(`Invalid indexSchemaDigest in manifest: ${doc.indexSchemaDigest}`);
  }
  if (doc.encoderVersion !== 1) {
    throw new CutoverFenceError(`Unsupported encoderVersion: expected 1, got ${doc.encoderVersion}`);
  }
  if (typeof doc.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(doc.planDigest)) {
    throw new CutoverFenceError(`Invalid planDigest in manifest: ${doc.planDigest}`);
  }
}

function validateCandidateProjection(kind, candidateId, proj) {
  if (!proj || typeof proj !== 'object' || Array.isArray(proj)) {
    throw new CutoverFenceError(`Projector must return a plain non-null object for candidate ${candidateId}`);
  }
  const keys = Object.keys(proj);
  if (keys.length === 0) {
    throw new CutoverFenceError(`Projector returned empty projection for candidate ${candidateId}`);
  }
  if (kind === 'clients' || kind === 'client') {
    if (typeof proj.clientId !== 'string' || !proj.clientId) {
      throw new CutoverFenceError(`Projector projection for ${kind} candidate ${candidateId} missing required clientId`);
    }
  } else if (kind === 'pr56Families' || kind === 'family') {
    if (typeof proj.familyId !== 'string' || typeof proj.generation !== 'number') {
      throw new CutoverFenceError(`Projector projection for ${kind} candidate ${candidateId} missing required familyId or generation`);
    }
  } else if (kind === 'baseFormatTokens' || kind === 'base') {
    if (typeof proj.familyId !== 'string' && typeof proj.accessTokenId !== 'string' && typeof proj.accessToken !== 'string') {
      throw new CutoverFenceError(`Projector projection for ${kind} candidate ${candidateId} missing required familyId or accessTokenId`);
    }
  } else if (kind === 'authCodes' || kind === 'code') {
    if (typeof proj.codeId !== 'string' && typeof proj.code !== 'string') {
      throw new CutoverFenceError(`Projector projection for ${kind} candidate ${candidateId} missing required codeId`);
    }
  } else if (kind === 'resumeTokens' || kind === 'resume') {
    if (typeof proj.resumeId !== 'string' && typeof proj.resumeTokenId !== 'string' && typeof proj.token !== 'string') {
      throw new CutoverFenceError(`Projector projection for ${kind} candidate ${candidateId} missing required resumeId`);
    }
  }
}

export function getCutoverDistinctCollectionNames(namespace) {
  assertSupportedCutoverNamespace(namespace);
  return {
    source: {
      families: `${namespace}_tokens_refresh_families`,
      tokens: `${namespace}_tokens`,
      refresh: `${namespace}_tokens_refresh`,
      upstream: `${namespace}_tokens_upstream`,
      authCodes: `${namespace}_auth_codes`,
      resumeTokens: `${namespace}_resume_tokens`,
      oauthClients: `${namespace}_oauth_clients`,
      clients: `${namespace}_clients`,
    },
    target: {
      families: `${namespace}_refresh_families`,
      tokens: `${namespace}_sessions`,
      refresh: `${namespace}_refresh`,
      upstream: `${namespace}_upstream`,
      authCodes: `${namespace}_auth_codes`,
      resumeTokens: `${namespace}_resume_tokens`,
      retiredRefreshTokens: `${namespace}_retired_refresh`,
      oauthClients: `${namespace}_oauth_clients`,
    },
    distinct: [
      `${namespace}_tokens_refresh_families`,
      `${namespace}_tokens`,
      `${namespace}_tokens_refresh`,
      `${namespace}_tokens_upstream`,
      `${namespace}_auth_codes`,
      `${namespace}_resume_tokens`,
      `${namespace}_oauth_clients`,
      `${namespace}_clients`,
      `${namespace}_refresh_families`,
      `${namespace}_sessions`,
      `${namespace}_refresh`,
      `${namespace}_upstream`,
      `${namespace}_retired_refresh`,
    ],
  };
}

export function getSourceCollectionAllowlist(namespace) {
  if (namespace !== undefined) assertSupportedCutoverNamespace(namespace);
  return [...PHYSICAL_COUNT_KEYS];
}

export function getTargetCollectionAllowlist(namespace) {
  if (namespace !== undefined) assertSupportedCutoverNamespace(namespace);
  return [...TARGET_COUNT_KEYS];
}

export function isTargetFormatRow(collection, data, rawId = '') {
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) {
    throw new CutoverFenceError(`Malformed document in '${collection}/${rawId}': data must be a non-null object`);
  }

  if (collection.endsWith('_auth_codes')) {
    const isTarget = typeof data.sealed === 'string';
    const isSource = !data.sealed && (data.code !== undefined || data.clientId !== undefined || data.redirectUri !== undefined || data.expiresAt !== undefined);
    if (isTarget && !isSource) return true;
    if (isSource && !isTarget) return false;
    throw new CutoverFenceError(`Ambiguous auth_codes document format in '${collection}/${rawId}'`);
  }

  if (collection.endsWith('_resume_tokens')) {
    const isTarget = data.v === 2 || data.ttlAt !== undefined || data._mcp_format === 'v3_target';
    const isSource = data.v === undefined && data.ttlAt === undefined && data._mcp_format === undefined && (data.consumedAt !== undefined || data.expiresAt !== undefined || data.token !== undefined);
    if (isTarget && !isSource) return true;
    if (isSource && !isTarget) return false;
    throw new CutoverFenceError(`Ambiguous resume_tokens document format in '${collection}/${rawId}'`);
  }

  if (collection.endsWith('_oauth_clients')) {
    const hasClientId = typeof data.client_id === 'string' || typeof data.clientId === 'string';
    if (!hasClientId) {
      throw new CutoverFenceError(`Ambiguous oauth_clients document format in '${collection}/${rawId}': missing client_id`);
    }
    if (data._targetFormat !== undefined) {
      throw new CutoverFenceError(`Ambiguous oauth_clients document format in '${collection}/${rawId}': reserved field _targetFormat present`);
    }
    const isTarget = data._mcp_format === 'v3_target';
    const isSource = data._mcp_format === undefined;
    if (isTarget && !isSource) return true;
    if (isSource && !isTarget) return false;
    throw new CutoverFenceError(`Ambiguous oauth_clients document format in '${collection}/${rawId}'`);
  }

  if (data._mcp_format === 'v3_target' || data.format === 'v3') return true;
  return false;
}

export function getCutoverFenceDocRef(db, namespace) {
  return db.collection(`${namespace}_meta`).doc('cutover_fence');
}

export function getCutoverOperationsColRef(db, namespace) {
  assertSupportedCutoverNamespace(namespace);
  return db.collection(`${namespace}_meta`).doc('cutover_fence').collection('operations');
}

export function getCutoverOperationDocRef(db, namespace, operationId) {
  return getCutoverOperationsColRef(db, namespace).doc(operationId);
}

export function stripUndefined(record) {
  const result = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function validateNoLoneSurrogates(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= str.length) {
        throw new CutoverFenceError('Invalid lone high surrogate in string');
      }
      const next = str.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new CutoverFenceError('Invalid lone high surrogate in string');
      }
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CutoverFenceError('Invalid lone low surrogate in string');
    }
  }
}

export function normalizeValue(val) {
  if (val === null) return ['null'];
  if (typeof val === 'boolean') return ['boolean', val];
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) {
      throw new CutoverFenceError(`Cannot normalize non-finite number: ${val}`);
    }
    const normalizedNum = Object.is(val, -0) ? 0 : val;
    if (Number.isInteger(normalizedNum)) {
      if (!Number.isSafeInteger(normalizedNum)) {
        throw new CutoverFenceError(`Cannot normalize unsafe integer: ${normalizedNum}`);
      }
    }
    return ['number', normalizedNum];
  }
  if (typeof val === 'string') {
    validateNoLoneSurrogates(val);
    return ['string', val];
  }
  if (val instanceof Date) {
    const ms = val.getTime();
    if (Number.isNaN(ms)) {
      throw new CutoverFenceError('Invalid Date object');
    }
    const seconds = Math.floor(ms / 1000);
    const nanoseconds = (ms - seconds * 1000) * 1_000_000;
    return ['timestamp', String(seconds), nanoseconds];
  }
  if (
    val &&
    typeof val === 'object' &&
    (val.constructor?.name === 'Timestamp' ||
      (typeof val.toMillis === 'function' &&
        typeof val.seconds === 'number' &&
        typeof val.nanoseconds === 'number' &&
        Object.keys(val).every((k) =>
          ['seconds', 'nanoseconds', '_seconds', '_nanoseconds'].includes(k),
        )))
  ) {
    if (
      !Number.isSafeInteger(val.seconds) ||
      !Number.isSafeInteger(val.nanoseconds) ||
      val.nanoseconds < 0 ||
      val.nanoseconds >= 1_000_000_000
    ) {
      throw new CutoverFenceError('Invalid Firestore Timestamp field ranges');
    }
    return ['timestamp', String(val.seconds), val.nanoseconds];
  }
  if (val instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(val))) {
    return ['bytes', Buffer.from(val).toString('base64')];
  }
  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) {
      if (!(i in val)) {
        throw new CutoverFenceError(`Sparse arrays are not supported at index ${i}`);
      }
    }
    return ['array', val.map(normalizeValue)];
  }
  if (typeof val === 'object') {
    if (val.constructor && val.constructor !== Object && val.constructor.name !== 'Object') {
      throw new CutoverFenceError(`Unsupported object class: ${val.constructor.name}`);
    }
    const keys = Object.keys(val).sort(canonicalCompare);
    return ['map', keys.map((k) => {
      validateNoLoneSurrogates(k);
      return [k, normalizeValue(val[k])];
    })];
  }
  throw new CutoverFenceError(`Unsupported type for canonical normalization: ${typeof val}`);
}

export function rfc8785CanonicalJson(val) {
  if (val === null) return 'null';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) {
      throw new CutoverFenceError(`Cannot serialize non-finite number: ${val}`);
    }
    return Object.is(val, -0) ? '0' : String(val);
  }
  if (typeof val === 'string') {
    validateNoLoneSurrogates(val);
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return '[' + val.map(rfc8785CanonicalJson).join(',') + ']';
  }
  if (typeof val === 'object') {
    const keys = Object.keys(val).sort(canonicalCompare);
    return '{' + keys.map((k) => {
      validateNoLoneSurrogates(k);
      return JSON.stringify(k) + ':' + rfc8785CanonicalJson(val[k]);
    }).join(',') + '}';
  }
  throw new CutoverFenceError(`Unsupported type for canonical JSON: ${typeof val}`);
}

export function C(value) {
  return rfc8785CanonicalJson(normalizeValue(value));
}

export function canonicalJsonStringify(val) {
  return C(val);
}

export function canonicalCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function deriveKey(storeKey) {
  const rawKey = typeof storeKey === 'string' ? Buffer.from(storeKey, 'utf8') : storeKey;
  return createHmac('sha256', rawKey).update(Buffer.from('netsapiens-mcp/cutover/v2', 'utf8')).digest();
}

export function frame(purpose, namespace, epoch, value) {
  const framedObj = [
    'netsapiens-mcp/cutover',
    2,
    purpose,
    namespace,
    epoch,
    value,
  ];
  return C(framedObj);
}

export const F = frame;

export function D(purpose, namespace, epoch, value) {
  const payload = frame(purpose, namespace, epoch, value);
  return createHash('sha256').update(Buffer.from(payload, 'utf8')).digest('hex');
}

export function H(storeKey, purpose, namespace, epoch, value) {
  if (!storeKey || (typeof storeKey !== 'string' && !Buffer.isBuffer(storeKey) && !(storeKey instanceof Uint8Array))) {
    throw new CutoverFenceError('storeKey is REQUIRED for keyed HMAC operations');
  }
  const K = deriveKey(storeKey);
  const payload = frame(purpose, namespace, epoch, value);
  return createHmac('sha256', K).update(Buffer.from(payload, 'utf8')).digest('hex');
}

export function computeKeyedDocId(storeKey, purpose, namespace, epoch, collectionKey, rawId) {
  return H(storeKey, purpose, namespace, epoch, [collectionKey, rawId]);
}

export function computeSourceRecordDigest(storeKey, namespace, epoch, collectionKey, sourceId, data) {
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) {
    throw new CutoverFenceError(`Malformed source data in '${collectionKey}/${sourceId}'`);
  }
  return H(storeKey, 'source-record', namespace, epoch, [collectionKey, sourceId, data]);
}

export function computeTargetRecordDigest(storeKey, namespace, epoch, collectionKey, targetId, data) {
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) {
    throw new CutoverFenceError(`Malformed target data in '${collectionKey}/${targetId}'`);
  }
  return H(storeKey, 'target-record', namespace, epoch, [collectionKey, targetId, data]);
}

export function computeSourceInventoryDigest(storeKey, namespace, epoch, sourceDescriptors) {
  const sorted = [...sourceDescriptors].sort((a, b) => {
    if (a.collection !== b.collection) return canonicalCompare(a.collection, b.collection);
    return canonicalCompare(a.id, b.id);
  });
  return H(storeKey, 'source-inventory', namespace, epoch, sorted);
}

export function computeTargetInventoryDigest(storeKey, namespace, epoch, targetDescriptors) {
  const sorted = [...targetDescriptors].sort((a, b) => {
    if (a.collection !== b.collection) return canonicalCompare(a.collection, b.collection);
    return canonicalCompare(a.id, b.id);
  });
  return H(storeKey, 'target-inventory', namespace, epoch, sorted);
}

export function computeLogicalInventoryDigest(storeKey, namespace, epoch, logicalItems) {
  const sorted = [...logicalItems].sort((a, b) => canonicalCompare(a[0], b[0]));
  return H(storeKey, 'logical-inventory', namespace, epoch, sorted);
}

export function computeManifestDigest(manifest, namespace, epoch) {
  if (!manifest || typeof manifest !== 'object') {
    throw new CutoverFenceError('Manifest must be an object');
  }
  const ns = namespace ?? manifest.namespace;
  const ep = epoch ?? manifest.epoch;
  if (!ns || !ep) {
    throw new CutoverFenceError('namespace and epoch are required to compute manifest digest');
  }
  return D('final', ns, ep, manifest);
}

export function computeProtocolDigest(moduleSource) {
  const buf = typeof moduleSource === 'string' ? Buffer.from(moduleSource, 'utf8') : moduleSource;
  return createHash('sha256').update(buf).digest('hex');
}

export const FIRESTORE_MAX_DOCUMENT_SIZE_BYTES = 1_048_576;
export const FIRESTORE_MAX_REQUEST_SIZE_BYTES = 10_485_760;
export const FIRESTORE_MAX_INDEX_ENTRIES = 40_000;
export const FIRESTORE_MAX_INDEX_BYTES = 8_388_608;
export const FIRESTORE_MAX_NESTING_DEPTH = 20;
export const FIRESTORE_MAX_FIELD_TRANSFORMS = 500;
export const FIRESTORE_TRANSACTION_READ_DEADLINE_MS = 16_000;

export function startMonotonicTimer() {
  const start = process.hrtime.bigint();
  return {
    elapsedMs() {
      return Number(process.hrtime.bigint() - start) / 1_000_000;
    },
    assertUnderDeadline(label = 'Transaction callback') {
      const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
      if (ms > FIRESTORE_TRANSACTION_READ_DEADLINE_MS) {
        throw new CutoverFenceError(
          `${label} elapsed duration (${Math.round(ms)} ms) exceeds 16,000 ms lock deadline`,
        );
      }
    },
  };
}

export const PREFLIGHT_MAX_DOC_BYTES = Math.floor((4 * FIRESTORE_MAX_DOCUMENT_SIZE_BYTES) / 5);
export const PREFLIGHT_MAX_REQUEST_BYTES = Math.floor((4 * FIRESTORE_MAX_REQUEST_SIZE_BYTES) / 5);
export const PREFLIGHT_MAX_INDEX_ENTRIES = Math.floor((4 * FIRESTORE_MAX_INDEX_ENTRIES) / 5);
export const PREFLIGHT_MAX_INDEX_BYTES = Math.floor((4 * FIRESTORE_MAX_INDEX_BYTES) / 5);
export const PREFLIGHT_MAX_NESTING_DEPTH = Math.floor((4 * FIRESTORE_MAX_NESTING_DEPTH) / 5);
export const PREFLIGHT_MAX_FIELD_TRANSFORMS = Math.floor((4 * FIRESTORE_MAX_FIELD_TRANSFORMS) / 5);

export function computeEstimatedFirestoreDocSize(obj) {
  let size = 32;
  function calc(val, nameLen = 0) {
    size += nameLen + 1;
    if (val === null || typeof val === 'boolean') {
      size += 1;
    } else if (typeof val === 'number') {
      size += 8;
    } else if (typeof val === 'string') {
      size += Buffer.byteLength(val, 'utf8') + 1;
    } else if (val instanceof Date || (val && typeof val === 'object' && typeof val.seconds === 'number')) {
      size += 8;
    } else if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
      size += val.length;
    } else if (Array.isArray(val)) {
      for (const item of val) calc(item, 0);
    } else if (val && typeof val === 'object') {
      for (const [k, v] of Object.entries(val)) {
        calc(v, Buffer.byteLength(k, 'utf8') + 1);
      }
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    calc(v, Buffer.byteLength(k, 'utf8') + 1);
  }
  return size;
}

function getMaxDepth(val, currentDepth = 1) {
  if (val && typeof val === 'object') {
    let max = currentDepth;
    const entries = Array.isArray(val) ? val : Object.values(val);
    for (const item of entries) {
      if (item && typeof item === 'object') {
        const d = getMaxDepth(item, currentDepth + 1);
        if (d > max) max = d;
      }
    }
    return max;
  }
  return currentDepth;
}

function countIndexMetrics(val) {
  let entries = 0;
  let bytes = 0;
  function traverse(v, pathLen = 0) {
    if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string' || v instanceof Date) {
      entries += 2;
      bytes += (pathLen + 8);
    } else if (Array.isArray(v)) {
      for (const item of v) {
        entries += 1;
        bytes += (pathLen + 8);
        traverse(item, pathLen);
      }
    } else if (v && typeof val === 'object') {
      for (const [k, child] of Object.entries(v)) {
        traverse(child, pathLen + Buffer.byteLength(k, 'utf8') + 1);
      }
    }
  }
  traverse(val);
  return { entries, bytes };
}

export function validateMigrationPreflightLimits(prep, options = {}) {
  const jsonStr = C(prep);
  const sizeBytes = Buffer.byteLength(jsonStr, 'utf8');
  if (sizeBytes > PREFLIGHT_MAX_DOC_BYTES) {
    throw new CutoverFenceError(
      `Prepared migration manifest canonical size (${sizeBytes} bytes) exceeds 80% limit (${PREFLIGHT_MAX_DOC_BYTES} bytes)`,
    );
  }
  const estFirestoreSize = computeEstimatedFirestoreDocSize(prep);
  if (estFirestoreSize > PREFLIGHT_MAX_DOC_BYTES) {
    throw new CutoverFenceError(
      `Prepared migration manifest estimated Firestore storage size (${estFirestoreSize} bytes) exceeds 80% limit (${PREFLIGHT_MAX_DOC_BYTES} bytes)`,
    );
  }

  const depth = getMaxDepth(prep);
  if (depth > PREFLIGHT_MAX_NESTING_DEPTH) {
    throw new CutoverFenceError(
      `Prepared migration manifest nesting depth (${depth}) exceeds 80% budget (${PREFLIGHT_MAX_NESTING_DEPTH})`,
    );
  }

  const indexMetrics = countIndexMetrics(prep);
  if (indexMetrics.entries > PREFLIGHT_MAX_INDEX_ENTRIES) {
    throw new CutoverFenceError(
      `Prepared migration manifest index entries (${indexMetrics.entries}) exceeds 80% budget (${PREFLIGHT_MAX_INDEX_ENTRIES})`,
    );
  }
  if (indexMetrics.bytes > PREFLIGHT_MAX_INDEX_BYTES) {
    throw new CutoverFenceError(
      `Prepared migration manifest index bytes (${indexMetrics.bytes}) exceeds 80% budget (${PREFLIGHT_MAX_INDEX_BYTES})`,
    );
  }

  if (options.fullReadset) {
    let fullBytes = estFirestoreSize;
    let fullEntries = indexMetrics.entries;
    for (const item of options.fullReadset) {
      if (item) {
        fullBytes += computeEstimatedFirestoreDocSize(item);
        fullEntries += countIndexMetrics(item).entries;
      }
    }
    if (fullBytes > PREFLIGHT_MAX_REQUEST_BYTES) {
      throw new CutoverFenceError(`Full readset estimated size (${fullBytes} bytes) exceeds 80% request budget`);
    }
    if (fullEntries > PREFLIGHT_MAX_INDEX_ENTRIES) {
      throw new CutoverFenceError(`Full readset index entries (${fullEntries}) exceeds 80% budget`);
    }
  }

  if (options.finalDoc) {
    const finalSize = computeEstimatedFirestoreDocSize(options.finalDoc);
    if (finalSize > PREFLIGHT_MAX_DOC_BYTES) {
      throw new CutoverFenceError(`finalDoc size (${finalSize} bytes) exceeds 80% budget`);
    }
  }
  if (options.markerDoc) {
    const markerSize = computeEstimatedFirestoreDocSize(options.markerDoc);
    if (markerSize > PREFLIGHT_MAX_DOC_BYTES) {
      throw new CutoverFenceError(`markerDoc size (${markerSize} bytes) exceeds 80% budget`);
    }
  }
  if (options.readDurationMs !== undefined) {
    if (options.readDurationMs > FIRESTORE_TRANSACTION_READ_DEADLINE_MS) {
      throw new CutoverFenceError(
        `Preflight read duration (${options.readDurationMs} ms) exceeds 16,000 ms lock deadline`,
      );
    }
  }

  return { sizeBytes, estFirestoreSize, depth, indexEntries: indexMetrics.entries, indexBytes: indexMetrics.bytes };
}
export function validateProspectiveDocBudget(doc, label = 'Document') {
  if (!doc || typeof doc !== 'object') {
    throw new CutoverFenceError(`${label} is missing or not an object`);
  }
  const estFirestoreSize = computeEstimatedFirestoreDocSize(doc);
  if (estFirestoreSize > PREFLIGHT_MAX_DOC_BYTES) {
    throw new CutoverFenceError(
      `${label} estimated Firestore size (${estFirestoreSize} bytes) exceeds 80% document budget (${PREFLIGHT_MAX_DOC_BYTES} bytes)`,
    );
  }
  const depth = getMaxDepth(doc);
  if (depth > PREFLIGHT_MAX_NESTING_DEPTH) {
    throw new CutoverFenceError(
      `${label} nesting depth (${depth}) exceeds 80% budget (${PREFLIGHT_MAX_NESTING_DEPTH})`,
    );
  }
  const indexMetrics = countIndexMetrics(doc);
  if (indexMetrics.entries > PREFLIGHT_MAX_INDEX_ENTRIES) {
    throw new CutoverFenceError(
      `${label} index entries (${indexMetrics.entries}) exceeds 80% budget (${PREFLIGHT_MAX_INDEX_ENTRIES})`,
    );
  }
  if (indexMetrics.bytes > PREFLIGHT_MAX_INDEX_BYTES) {
    throw new CutoverFenceError(
      `${label} index bytes (${indexMetrics.bytes}) exceeds 80% budget (${PREFLIGHT_MAX_INDEX_BYTES})`,
    );
  }
  const transforms = doc._transformsCount ?? 0;
  if (transforms > PREFLIGHT_MAX_FIELD_TRANSFORMS) {
    throw new CutoverFenceError(
      `${label} field transforms (${transforms}) exceeds 80% budget (${PREFLIGHT_MAX_FIELD_TRANSFORMS})`,
    );
  }
  return { estFirestoreSize, depth, indexEntries: indexMetrics.entries, indexBytes: indexMetrics.bytes, transforms };
}

export function validateTransactionBudgetPlan(txPlan, label = 'Transaction') {
  if (!txPlan || typeof txPlan !== 'object') {
    throw new CutoverFenceError(`${label} transaction budget plan is missing or not an object`);
  }
  const commitBytes = txPlan.estimatedCommitBytes ?? txPlan.commitBytes;
  if (typeof commitBytes !== 'number' || !Number.isSafeInteger(commitBytes) || commitBytes <= 0 || commitBytes > PREFLIGHT_MAX_REQUEST_BYTES) {
    throw new CutoverFenceError(
      `${label} estimated commit bytes (${commitBytes}) must be a positive integer <= 80% request budget (${PREFLIGHT_MAX_REQUEST_BYTES})`,
    );
  }
  const readDurationMs = txPlan.estimatedReadDurationMs ?? txPlan.readDurationMs;
  if (typeof readDurationMs !== 'number' || !Number.isFinite(readDurationMs) || readDurationMs <= 0 || readDurationMs > FIRESTORE_TRANSACTION_READ_DEADLINE_MS) {
    throw new CutoverFenceError(
      `${label} estimated read duration (${readDurationMs} ms) must be positive and <= 16,000 ms lock deadline`,
    );
  }
  return { commitBytes, readDurationMs };
}

export function validateCompleteMigrationPlan(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new CutoverFenceError('CompleteMigrationPlan must be a non-null object');
  }

  // 1. Prepared manifest budget
  if (!plan.prepared || typeof plan.prepared !== 'object') {
    throw new CutoverFenceError('CompleteMigrationPlan missing required prepared document');
  }
  const preparedMetrics = validateProspectiveDocBudget(plan.prepared, 'Prepared manifest');

  // 2. Preparation transaction budget
  validateTransactionBudgetPlan(plan.preparation, 'Preparation');

  // 3. Items validation
  if (!Array.isArray(plan.items)) {
    throw new CutoverFenceError('CompleteMigrationPlan missing required items array');
  }
  const candidateCommitments = plan.prepared.candidateCommitments || [];
  if (plan.items.length !== candidateCommitments.length) {
    throw new CutoverFenceError(
      `CompleteMigrationPlan items count (${plan.items.length}) does not match prepared candidates count (${candidateCommitments.length})`,
    );
  }

  const seenCandidateIds = new Set();
  for (let i = 0; i < plan.items.length; i++) {
    const item = plan.items[i];
    if (!item || typeof item !== 'object') {
      throw new CutoverFenceError(`Item plan at index ${i} is missing or not an object`);
    }
    if (typeof item.candidateId !== 'string' || !item.candidateId.trim()) {
      throw new CutoverFenceError(`Item plan at index ${i} missing candidateId`);
    }
    if (seenCandidateIds.has(item.candidateId)) {
      throw new CutoverFenceError(`Duplicate item plan for candidateId '${item.candidateId}'`);
    }
    seenCandidateIds.add(item.candidateId);

    const matchingCandidate = candidateCommitments.find((c) => c.id === item.candidateId);
    if (!matchingCandidate) {
      throw new CutoverFenceError(`Item plan candidateId '${item.candidateId}' not found in prepared candidates`);
    }

    if (!Array.isArray(item.sourceReferences) || !Array.isArray(item.targetReferences)) {
      throw new CutoverFenceError(`Item plan ${item.candidateId} missing sourceReferences or targetReferences array`);
    }
    if (item.sourceReferences.length !== matchingCandidate.sources.length) {
      throw new CutoverFenceError(`Item plan ${item.candidateId} sourceReferences count mismatch`);
    }
    for (let sIdx = 0; sIdx < matchingCandidate.sources.length; sIdx++) {
      const expectedS = matchingCandidate.sources[sIdx];
      const actualS = item.sourceReferences[sIdx];
      if (!actualS || actualS.collection !== expectedS.collection || actualS.id !== expectedS.id) {
        throw new CutoverFenceError(`Item plan ${item.candidateId} sourceReferences[${sIdx}] mismatch: expected '${expectedS.collection}:${expectedS.id}'`);
      }
    }

    if (item.targetReferences.length !== matchingCandidate.targets.length) {
      throw new CutoverFenceError(`Item plan ${item.candidateId} targetReferences count mismatch`);
    }
    for (let tIdx = 0; tIdx < matchingCandidate.targets.length; tIdx++) {
      const expectedT = matchingCandidate.targets[tIdx];
      const actualT = item.targetReferences[tIdx];
      if (!actualT || actualT.collection !== expectedT.collection || actualT.id !== expectedT.id) {
        throw new CutoverFenceError(`Item plan ${item.candidateId} targetReferences[${tIdx}] mismatch: expected '${expectedT.collection}:${expectedT.id}'`);
      }
    }

    if (!Array.isArray(item.sourceActions) || item.sourceActions.length === 0) {
      throw new CutoverFenceError(`Item plan ${item.candidateId} missing non-empty sourceActions`);
    }

    if (!Array.isArray(item.prospectiveTargetPostimages) || item.prospectiveTargetPostimages.length !== matchingCandidate.targets.length) {
      throw new CutoverFenceError(`Item plan ${item.candidateId} prospectiveTargetPostimages count must equal targets count (${matchingCandidate.targets.length})`);
    }
    for (let j = 0; j < item.prospectiveTargetPostimages.length; j++) {
      validateProspectiveDocBudget(
        item.prospectiveTargetPostimages[j],
        `Candidate ${item.candidateId} target postimage [${j}]`,
      );
    }

    validateProspectiveDocBudget(item.receiptUpperBound, `Candidate ${item.candidateId} receipt upper bound`);
    validateTransactionBudgetPlan(item.transaction, `Candidate ${item.candidateId} item transaction`);
  }
  for (const c of candidateCommitments) {
    if (!seenCandidateIds.has(c.id)) {
      throw new CutoverFenceError(`Prepared candidate '${c.id}' has no corresponding item plan`);
    }
  }

  // 4. Finalization validation
  if (!plan.finalization || typeof plan.finalization !== 'object') {
    throw new CutoverFenceError('CompleteMigrationPlan missing required finalization section');
  }
  validateProspectiveDocBudget(plan.finalization.finalUpperBound, 'Final manifest upper bound');
  validateProspectiveDocBudget(plan.finalization.markerUpperBound, 'Marker document upper bound');
  validateProspectiveDocBudget(plan.finalization.controlUpperBound, 'Finalization control upper bound');
  validateTransactionBudgetPlan(plan.finalization.transaction, 'Finalization');

  // 5. Activation validation
  if (!plan.activation || typeof plan.activation !== 'object') {
    throw new CutoverFenceError('CompleteMigrationPlan missing required activation section');
  }
  validateProspectiveDocBudget(plan.activation.controlUpperBound, 'Activation control upper bound');
  validateTransactionBudgetPlan(plan.activation.transaction, 'Activation');

  return {
    valid: true,
    preparedMetrics,
    itemsCount: plan.items.length,
  };
}

export function validateCandidateCommitments(candidates, prepDoc, expectedNamespace, expectedEpoch, expectedRunId) {
  if (!Array.isArray(candidates)) {
    throw new CutoverFenceError('candidateCommitments must be an array');
  }
  const candidateIds = new Set();
  const sourceKeys = new Set();
  const targetKeys = new Set();
  const kindCounts = {};
  for (const k of CLASSIFICATION_KEYS) kindCounts[k] = 0;

  const allowedSources = getSourceCollectionAllowlist(expectedNamespace);
  const allowedTargets = getTargetCollectionAllowlist(expectedNamespace);

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c || typeof c !== 'object') {
      throw new CutoverFenceError(`candidateCommitments[${i}] must be an object`);
    }
    validateMapKeysExact(c, REQUIRED_CANDIDATE_KEYS, `candidateCommitments[${i}]`);
    if (typeof c.id !== 'string' || !/^[0-9a-f]{64}$/.test(c.id)) {
      throw new CutoverFenceError(`candidateCommitments[${i}].id must be 64-char hex`);
    }
    const classificationKind = CANDIDATE_KIND_TO_CLASSIFICATION[c.kind];
    if (!classificationKind || !CLASSIFICATION_KEYS.includes(classificationKind)) {
      throw new CutoverFenceError(`candidateCommitments[${i}].kind must map to valid classification (${CLASSIFICATION_KEYS.join(', ')})`);
    }
    kindCounts[classificationKind] = (kindCounts[classificationKind] ?? 0) + 1;

    if (!Array.isArray(c.sources) || c.sources.length === 0) {
      throw new CutoverFenceError(`candidateCommitments[${i}].sources must be a non-empty array`);
    }
    if (!Array.isArray(c.targets)) {
      throw new CutoverFenceError(`candidateCommitments[${i}].targets must be an array`);
    }
    if (!/^[0-9a-f]{64}$/.test(c.logicalDigest)) {
      throw new CutoverFenceError(`candidateCommitments[${i}].logicalDigest must be 64-char hex`);
    }

    if (candidateIds.has(c.id)) {
      throw new CutoverFenceError(`Duplicate candidate id '${c.id}' in candidateCommitments`);
    }
    candidateIds.add(c.id);

    // Verify sources: exact {collection, id, recordDigest} sorted by collection then id
    let prevSourceKey = '';
    for (const s of c.sources) {
      if (!s || typeof s !== 'object') {
        throw new CutoverFenceError(`Invalid source descriptor in candidate ${c.id}`);
      }
      validateMapKeysExact(s, ['collection', 'id', 'recordDigest'], `candidate ${c.id} source`);
      if (typeof s.collection !== 'string' || typeof s.id !== 'string' || !/^[0-9a-f]{64}$/.test(s.id) || !/^[0-9a-f]{64}$/.test(s.recordDigest)) {
        throw new CutoverFenceError(`Invalid source descriptor formats in candidate ${c.id}`);
      }
      if (!allowedSources.includes(s.collection)) {
        throw new CutoverFenceError(`Candidate ${c.id} source collection '${s.collection}' not in allowlist`);
      }
      const sKey = `${s.collection}:${s.id}`;
      if (sKey < prevSourceKey) {
        throw new CutoverFenceError(`Candidate ${c.id} sources must be sorted by collection then id`);
      }
      prevSourceKey = sKey;
      if (sourceKeys.has(sKey)) {
        throw new CutoverFenceError(`Duplicate source record '${sKey}' across candidateCommitments`);
      }
      sourceKeys.add(sKey);
    }

    // Verify targets: exact {collection, id} sorted by collection then id
    let prevTargetKey = '';
    for (const t of c.targets) {
      if (!t || typeof t !== 'object') {
        throw new CutoverFenceError(`Invalid target descriptor in candidate ${c.id}`);
      }
      validateMapKeysExact(t, ['collection', 'id'], `candidate ${c.id} target`);
      if (typeof t.collection !== 'string' || typeof t.id !== 'string' || !/^[0-9a-f]{64}$/.test(t.id)) {
        throw new CutoverFenceError(`Invalid target descriptor formats in candidate ${c.id}`);
      }
      if (!allowedTargets.includes(t.collection)) {
        throw new CutoverFenceError(`Candidate ${c.id} target collection '${t.collection}' not in allowlist`);
      }
      const tKey = `${t.collection}:${t.id}`;
      if (tKey < prevTargetKey) {
        throw new CutoverFenceError(`Candidate ${c.id} targets must be sorted by collection then id`);
      }
      prevTargetKey = tKey;
      if (targetKeys.has(tKey)) {
        throw new CutoverFenceError(`Duplicate target record '${tKey}' across candidateCommitments`);
      }
      targetKeys.add(tKey);
    }
  }

  if (prepDoc && prepDoc.classifications) {
    for (const k of CLASSIFICATION_KEYS) {
      if (prepDoc.classifications[k] !== (kindCounts[k] ?? 0)) {
        throw new CutoverFenceError(`Partition count mismatch for '${k}': prepDoc has ${prepDoc.classifications[k]}, candidates have ${kindCounts[k] ?? 0}`);
      }
    }
  }
}

export function validateReceipt(receipt, expectedNamespace, expectedEpoch, expectedRunId) {
  if (!receipt || typeof receipt !== 'object') {
    throw new CutoverFenceError('Receipt must be an object');
  }
  validateMapKeysExact(receipt, REQUIRED_RECEIPT_KEYS, 'receipt');
  validateMigrationIdentityFields(receipt, expectedNamespace, expectedEpoch, expectedRunId);
  if (receipt.kind !== 'receipt') {
    throw new CutoverFenceError(`Receipt kind must be 'receipt', got '${receipt.kind}'`);
  }
  if (!/^[0-9a-f]{64}$/.test(receipt.preparedDigest)) {
    throw new CutoverFenceError(`Receipt preparedDigest must be 64-char hex, got '${receipt.preparedDigest}'`);
  }
  if (!/^[0-9a-f]{64}$/.test(receipt.candidateDigest)) {
    throw new CutoverFenceError(`Receipt candidateDigest must be 64-char hex, got '${receipt.candidateDigest}'`);
  }
  if (!/^[0-9a-f]{64}$/.test(receipt.logicalDigest)) {
    throw new CutoverFenceError(`Receipt logicalDigest must be 64-char hex, got '${receipt.logicalDigest}'`);
  }
  const validDispositions = ['written', 'retained'];
  if (!validDispositions.includes(receipt.disposition)) {
    throw new CutoverFenceError(
      `Receipt disposition must be one of [${validDispositions.join(', ')}], got '${receipt.disposition}'`,
    );
  }

  const allowedSources = getSourceCollectionAllowlist(expectedNamespace);
  const allowedTargets = getTargetCollectionAllowlist(expectedNamespace);

  if (!Array.isArray(receipt.sourceAfter)) {
    throw new CutoverFenceError('Receipt sourceAfter must be an array of source after-state descriptors');
  }
  for (const s of receipt.sourceAfter) {
    if (!s || typeof s !== 'object') {
      throw new CutoverFenceError('Invalid sourceAfter item in receipt');
    }
    validateMapKeysExact(s, ['collection', 'id', 'recordDigest'], 'receipt sourceAfter item');
    if (typeof s.collection !== 'string' || typeof s.id !== 'string' || !/^[0-9a-f]{64}$/.test(s.id)) {
      throw new CutoverFenceError('Invalid sourceAfter collection or id format');
    }
    if (!allowedSources.includes(s.collection)) {
      throw new CutoverFenceError(`Receipt sourceAfter collection '${s.collection}' not in allowlist`);
    }
    if (s.recordDigest !== null && (typeof s.recordDigest !== 'string' || !/^[0-9a-f]{64}$/.test(s.recordDigest))) {
      throw new CutoverFenceError('sourceAfter recordDigest must be 64-char hex or null');
    }
  }

  if (!Array.isArray(receipt.targetAfter)) {
    throw new CutoverFenceError('Receipt targetAfter must be an array of target after-state descriptors');
  }
  for (const t of receipt.targetAfter) {
    if (!t || typeof t !== 'object') {
      throw new CutoverFenceError('Invalid targetAfter item in receipt');
    }
    validateMapKeysExact(t, ['collection', 'id', 'recordDigest'], 'receipt targetAfter item');
    if (typeof t.collection !== 'string' || typeof t.id !== 'string' || !/^[0-9a-f]{64}$/.test(t.id) || typeof t.recordDigest !== 'string' || !/^[0-9a-f]{64}$/.test(t.recordDigest)) {
      throw new CutoverFenceError('Invalid targetAfter descriptor format in receipt');
    }
    if (!allowedTargets.includes(t.collection)) {
      throw new CutoverFenceError(`Receipt targetAfter collection '${t.collection}' not in allowlist`);
    }
  }

  if (!Number.isInteger(receipt.completedAt) || receipt.completedAt <= 0) {
    throw new CutoverFenceError('Receipt completedAt must be a positive integer timestamp');
  }
}

export function computeReceiptDigest(receipt) {
  validateReceipt(receipt, receipt.namespace, receipt.epoch, receipt.migrationRunId);
  return D('receipt', receipt.namespace, receipt.epoch, receipt);
}

export function computePlanDigest(namespace, epoch, planSpec) {
  if (!planSpec || typeof planSpec !== 'object') {
    throw new CutoverFenceError('planSpec must be a non-null object');
  }
  return D('plan', namespace, epoch, planSpec);
}

export function computeReceiptSetDigest(receipts, namespace, epoch) {
  if (!Array.isArray(receipts)) {
    throw new CutoverFenceError('Receipts must be an array');
  }
  const pairs = [];
  const candidateIds = new Set();
  for (const r of receipts) {
    if (r.namespace !== namespace || r.epoch !== epoch) {
      throw new CutoverFenceError('Receipt namespace or epoch mismatch in receipt set');
    }
    if (candidateIds.has(r.candidateId)) {
      throw new CutoverFenceError(`Duplicate candidate receipt in receipt set: ${r.candidateId}`);
    }
    candidateIds.add(r.candidateId);
    pairs.push([r.candidateId, computeReceiptDigest(r)]);
  }
  pairs.sort((a, b) => canonicalCompare(a[0], b[0]));
  return D('receipt-set', namespace, epoch, pairs);
}

export function parseCutoverFenceRecord(data, namespace) {
  assertSupportedCutoverNamespace(namespace);
  if (!data || typeof data !== 'object') {
    throw new CutoverFenceError(
      `Invalid cutover fence record for namespace ${namespace}: expected object, got ${typeof data}`,
    );
  }
  const record = data;

  const ALLOWED_CONTROL_KEYS = [
    'schemaVersion',
    'namespace',
    'epoch',
    'state',
    'activeOperations',
    'irreversible',
    'migrationRunId',
    'migrationManifestDigest',
    'emptyNamespace',
    'createdAt',
    'updatedAt',
    'codeArtifact',
    'codeSha',
    'lastTransitionReason',
  ];
  for (const key of Object.keys(record)) {
    if (!ALLOWED_CONTROL_KEYS.includes(key)) {
      throw new CutoverFenceError(
        `Unknown field '${key}' in cutover fence control record for namespace ${namespace}`,
      );
    }
  }

  if (record.schemaVersion !== 1) {
    throw new CutoverFenceError(
      `Unsupported schemaVersion for namespace ${namespace}: expected 1, got ${record.schemaVersion}`,
    );
  }
  if (record.namespace !== namespace) {
    throw new CutoverFenceError(
      `Namespace mismatch in cutover fence record: expected ${namespace}, got ${record.namespace}`,
    );
  }
  if (
    typeof record.epoch !== 'number' ||
    !Number.isInteger(record.epoch) ||
    record.epoch < 1
  ) {
    throw new CutoverFenceError(
      `Invalid epoch in cutover fence record for namespace ${namespace}: ${record.epoch}`,
    );
  }
  const validStates = ['legacy_open', 'closing', 'fenced', 'migrating', 'v3_ready', 'v3_active'];
  if (typeof record.state !== 'string' || !validStates.includes(record.state)) {
    throw new CutoverFenceError(
      `Invalid cutover fence state for namespace ${namespace}: ${String(record.state)}`,
    );
  }
  if (
    typeof record.activeOperations !== 'number' ||
    !Number.isInteger(record.activeOperations) ||
    record.activeOperations < 0
  ) {
    throw new CutoverFenceError(
      `Invalid activeOperations in cutover fence record for namespace ${namespace}: ${String(record.activeOperations)}`,
    );
  }
  if (typeof record.irreversible !== 'boolean') {
    throw new CutoverFenceError(
      `Invalid irreversible field in cutover fence record for namespace ${namespace}: expected boolean, got ${typeof record.irreversible}`,
    );
  }

  if (['legacy_open', 'closing', 'fenced', 'migrating'].includes(record.state)) {
    if (record.emptyNamespace !== undefined) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: ${record.state} cannot define emptyNamespace`,
      );
    }
  }

  if (record.state === 'legacy_open') {
    if (record.irreversible !== false) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: legacy_open cannot have irreversible: true`,
      );
    }
    if (record.migrationRunId !== undefined || record.migrationManifestDigest !== undefined) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: legacy_open cannot have migration markers`,
      );
    }
  } else if (record.state === 'closing' || record.state === 'fenced') {
    if (record.migrationRunId !== undefined || record.migrationManifestDigest !== undefined) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: ${record.state} cannot have migration markers`,
      );
    }
  } else if (record.state === 'migrating') {
    if (typeof record.migrationRunId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(record.migrationRunId)) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: migrating requires non-empty migrationRunId matching /^[A-Za-z0-9_-]{8,64}$/`,
      );
    }
    if (record.migrationManifestDigest !== undefined) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: migrating cannot have migrationManifestDigest before v3_ready`,
      );
    }
  } else if (record.state === 'v3_ready' || record.state === 'v3_active') {
    if (typeof record.migrationRunId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(record.migrationRunId)) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: ${record.state} requires migrationRunId matching /^[A-Za-z0-9_-]{8,64}$/`,
      );
    }
    if (typeof record.migrationManifestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(record.migrationManifestDigest)) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: ${record.state} requires migrationManifestDigest to be 64-char hex`,
      );
    }
    if (typeof record.emptyNamespace !== 'boolean') {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: ${record.state} requires emptyNamespace to be a boolean`,
      );
    }
    if (record.emptyNamespace === true) {
      if (record.irreversible !== false) {
        throw new CutoverFenceError(
          `Invalid cutover fence invariants for namespace ${namespace}: emptyNamespace requires irreversible: false`,
        );
      }
    } else {
      if (record.irreversible !== true) {
        throw new CutoverFenceError(
          `Invalid cutover fence invariants for namespace ${namespace}: non-empty ${record.state} requires irreversible: true`,
        );
      }
    }
  }

  if (record.codeSha !== undefined) {
    if (typeof record.codeSha !== 'string' || !/^[0-9a-f]{40}$/.test(record.codeSha)) {
      throw new CutoverFenceError(`Invalid codeSha in cutover fence record for namespace ${namespace}`);
    }
  }
  if (record.codeArtifact !== undefined) {
    if (typeof record.codeArtifact !== 'string' || !record.codeArtifact.trim()) {
      throw new CutoverFenceError(`Invalid codeArtifact in cutover fence record for namespace ${namespace}`);
    }
  }

  return {
    schemaVersion: 1,
    namespace,
    epoch: record.epoch,
    state: record.state,
    activeOperations: record.activeOperations,
    irreversible: record.irreversible,
    migrationRunId: typeof record.migrationRunId === 'string' ? record.migrationRunId : undefined,
    migrationManifestDigest:
      typeof record.migrationManifestDigest === 'string' ? record.migrationManifestDigest : undefined,
    emptyNamespace: typeof record.emptyNamespace === 'boolean' ? record.emptyNamespace : undefined,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : undefined,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : undefined,
    codeArtifact: typeof record.codeArtifact === 'string' ? record.codeArtifact : undefined,
    codeSha: typeof record.codeSha === 'string' ? record.codeSha : undefined,
    lastTransitionReason: typeof record.lastTransitionReason === 'string' ? record.lastTransitionReason : undefined,
  };
}

export async function readCutoverFenceInTransaction(transaction, db, namespace) {
  assertSupportedCutoverNamespace(namespace);
  const docRef = getCutoverFenceDocRef(db, namespace);
  const snap = await transaction.get(docRef);
  if (!snap.exists) {
    throw new CutoverFenceError(
      `Cutover fence record not initialized for namespace ${namespace} at ${namespace}_meta/cutover_fence`,
    );
  }
  return parseCutoverFenceRecord(snap.data(), namespace);
}

export async function getCutoverFenceRecord(db, namespace) {
  assertSupportedCutoverNamespace(namespace);
  const docRef = getCutoverFenceDocRef(db, namespace);
  const snap = await docRef.get();
  if (!snap.exists) {
    return undefined;
  }
  return parseCutoverFenceRecord(snap.data(), namespace);
}

export async function initializeCutoverFence(db, namespace, options = {}) {
  assertSupportedCutoverNamespace(namespace);
  const docRef = getCutoverFenceDocRef(db, namespace);
  const now = (options.now ?? Date.now)();

  const requestedInitialEpoch = options.initialEpoch ?? 1;
  if (
    typeof requestedInitialEpoch !== 'number' ||
    !Number.isInteger(requestedInitialEpoch) ||
    requestedInitialEpoch !== 1
  ) {
    throw new CutoverFenceError(
      `Initial epoch for namespace ${namespace} must be exactly 1, got ${requestedInitialEpoch}`,
    );
  }

  const requestedInitialState = options.initialState ?? 'legacy_open';
  if (requestedInitialState !== 'legacy_open') {
    throw new CutoverFenceError(
      `Initial state for namespace ${namespace} must be 'legacy_open', got '${requestedInitialState}'`,
    );
  }

  return await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(docRef);
    if (snap.exists) {
      const existing = parseCutoverFenceRecord(snap.data(), namespace);
      if (existing.epoch !== 1 || existing.state !== 'legacy_open') {
        throw new CutoverFenceError(
          `Cutover fence record for namespace ${namespace} already exists with epoch ${existing.epoch}, state ${existing.state}`,
        );
      }
      return existing;
    }

    const initial = {
      schemaVersion: 1,
      namespace,
      epoch: 1,
      state: 'legacy_open',
      activeOperations: 0,
      irreversible: false,
      createdAt: now,
      updatedAt: now,
    };
    transaction.set(docRef, initial);
    return initial;
  });
}

export async function transitionCutoverFenceState(db, namespace, params) {
  assertSupportedCutoverNamespace(namespace);
  const docRef = getCutoverFenceDocRef(db, namespace);
  const now = (params.now ?? Date.now)();

  if (['migrating', 'v3_ready', 'v3_active'].includes(params.toState)) {
    throw new CutoverFenceError(
      `Transition to '${params.toState}' must use atomic transaction helper (prepareMigrationInTransaction, finalizeMigrationInTransaction, or activateMigrationInTransaction)`,
    );
  }

  return await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(docRef);
    if (!snap.exists) {
      throw new CutoverFenceError(
        `Cannot transition: cutover fence record missing for namespace ${namespace}`,
      );
    }
    const current = parseCutoverFenceRecord(snap.data(), namespace);

    if (current.state === params.toState) {
      if (params.allowIdempotent) {
        return current;
      }
      throw new CutoverFenceError(
        `Idempotent transition rejected for namespace ${namespace}: already in state '${current.state}'`,
      );
    }

    if (params.fromState !== undefined) {
      const allowedFrom = Array.isArray(params.fromState) ? params.fromState : [params.fromState];
      if (!allowedFrom.includes(current.state)) {
        throw new CutoverFenceError(
          `Invalid fromState precondition for namespace ${namespace}: expected ${allowedFrom.join('|')}, got '${current.state}'`,
        );
      }
    }

    if (current.epoch !== params.expectedEpoch) {
      throw new CutoverFenceError(
        `Epoch mismatch on transition for namespace ${namespace}: expected ${params.expectedEpoch}, got ${current.epoch}`,
      );
    }

    const allowedNext = ALLOWED_STATE_TRANSITIONS[current.state] ?? [];
    if (!allowedNext.includes(params.toState)) {
      throw new CutoverFenceError(
        `Illegal cutover state transition for namespace ${namespace}: ${current.state} -> ${params.toState}`,
      );
    }

    if (params.toState === 'fenced') {
      const nonterminalOps = await transaction.get(
        getCutoverOperationsColRef(db, namespace).where('phase', 'in', ['admitted', 'upstream_pending']),
      );
      if (nonterminalOps.size !== current.activeOperations) {
        throw new CutoverFenceError(
          `Cannot transition to fenced: activeOperations counter (${current.activeOperations}) does not match nonterminal operations count (${nonterminalOps.size})`,
        );
      }
      if (nonterminalOps.size !== 0) {
        throw new CutoverFenceError(
          `Cannot transition to fenced for namespace ${namespace}: ${nonterminalOps.size} active or pending operations exist`,
        );
      }
      const ambiguousOps = await transaction.get(
        getCutoverOperationsColRef(db, namespace).where('ambiguousRemoteOutcome', '==', true),
      );
      if (!ambiguousOps.empty) {
        throw new CutoverFenceError(
          `Cannot transition to fenced for namespace ${namespace}: unresolved ambiguous remote operations exist`,
        );
      }
    } else if (params.toState === 'legacy_open') {
      if (current.irreversible) {
        throw new CutoverFenceError(
          `Cannot return to legacy_open for namespace ${namespace}: irreversible migration latch is engaged`,
        );
      }
      if (current.migrationRunId || current.emptyNamespace) {
        throw new CutoverFenceError(
          `Cannot return to legacy_open for namespace ${namespace}: migration ownership record exists`,
        );
      }
      const markerRef = db.collection(`${namespace}_meta`).doc('v2_adopted');
      const markerSnap = await transaction.get(markerRef);
      if (markerSnap.exists) {
        throw new CutoverFenceError(
          `Cannot return to legacy_open for namespace ${namespace}: durable v2_adopted ownership marker exists`,
        );
      }
      if (current.activeOperations !== 0) {
        throw new CutoverFenceError(
          `Cannot return to legacy_open for namespace ${namespace}: activeOperations is ${current.activeOperations}`,
        );
      }
    }

    if (params.nextEpoch !== undefined) {
      const allowedNext = params.toState === 'fenced' && current.state === 'closing'
        ? current.epoch + 1
        : current.epoch;
      if (params.nextEpoch !== allowedNext) {
        throw new CutoverFenceError(`Arbitrary nextEpoch is not permitted for transition to ${params.toState}`);
      }
    }

    const nextEpoch = params.toState === 'fenced' && current.state === 'closing'
      ? current.epoch + 1
      : current.epoch;

    const updated = {
      schemaVersion: 1,
      namespace,
      state: params.toState,
      epoch: nextEpoch,
      activeOperations: current.activeOperations,
      irreversible: current.irreversible,
      emptyNamespace: current.emptyNamespace,
      migrationRunId: params.migrationRunId ?? current.migrationRunId,
      migrationManifestDigest: params.migrationManifestDigest ?? current.migrationManifestDigest,
      createdAt: current.createdAt ?? now,
      updatedAt: now,
      codeArtifact: current.codeArtifact,
      codeSha: current.codeSha,
      lastTransitionReason: `Transitioned from ${current.state} to ${params.toState}`,
    };

    transaction.set(docRef, stripUndefined(updated));
    return updated;
  });
}

export async function markIrreversibleInTransaction(
  transaction,
  db,
  namespace,
  expectedEpoch,
  migrationRunId,
  nowProvider = Date.now,
) {
  assertSupportedCutoverNamespace(namespace);
  const current = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (current.state !== 'migrating') {
    throw new CutoverFenceError(
      `Cannot set irreversible latch for namespace ${namespace}: state must be 'migrating', got '${current.state}'`,
    );
  }
  if (current.epoch !== expectedEpoch) {
    throw new CutoverFenceError(
      `Epoch mismatch when setting irreversible latch for namespace ${namespace}: expected ${expectedEpoch}, got ${current.epoch}`,
    );
  }
  if (migrationRunId && current.migrationRunId !== migrationRunId) {
    throw new CutoverFenceError(
      `migrationRunId mismatch when setting irreversible latch: expected ${migrationRunId}, got ${current.migrationRunId}`,
    );
  }
  if (current.emptyNamespace === true) {
    throw new CutoverFenceError(
      `Cannot set irreversible latch for namespace ${namespace}: emptyNamespace must remain irreversible: false`,
    );
  }
  if (current.irreversible) {
    return current;
  }
  const currentTime = nowProvider();
  const updated = {
    ...current,
    irreversible: true,
    updatedAt: currentTime,
  };
  const ref = getCutoverFenceDocRef(db, namespace);
  transaction.set(ref, stripUndefined(updated), { merge: true });
  return updated;
}

export async function withLegacyOperation(options, fn) {
  assertSupportedCutoverNamespace(options.namespace);
  const now = options.now ?? Date.now;
  const opId = options.operationId ?? randomUUID();
  const opRef = getCutoverOperationDocRef(options.db, options.namespace, opId);
  const controlRef = getCutoverFenceDocRef(options.db, options.namespace);

  const opRecord = await options.db.runTransaction(async (transaction) => {
    const timer = startMonotonicTimer();
    const existingSnap = await transaction.get(opRef);
    if (existingSnap.exists) {
      throw new CutoverFenceError(
        `Operation with id '${sanitizeId(opId)}' already exists in namespace ${options.namespace}`,
      );
    }

    const control = await readCutoverFenceInTransaction(transaction, options.db, options.namespace);
    if (['fenced', 'migrating', 'v3_ready', 'v3_active'].includes(control.state)) {
      throw new CutoverRefusedError(
        `Cutover state is ${control.state}; new operations refused for namespace ${options.namespace}`,
        { cutoverState: control.state, epoch: control.epoch },
      );
    }
    if (control.state === 'closing') {
      throw new CutoverRefusedError(
        `Cutover state is closing; new admissions refused for namespace ${options.namespace}`,
        { cutoverState: control.state, epoch: control.epoch },
      );
    }

    const forbiddenKindTerms = ['token', 'password', 'upstream', 'secret', 'auth_code'];
    if (forbiddenKindTerms.some((t) => options.kind.toLowerCase().includes(t))) {
      throw new CutoverFenceError(`Operation kind must not contain sensitive credential terms: '${options.kind}'`);
    }

    if (options.metadata) {
      const allowedKeys = ['revision', 'attempt', 'phase', 'reconciled'];
      for (const [key, value] of Object.entries(options.metadata)) {
        if (!allowedKeys.includes(key)) {
          throw new CutoverFenceError(
            `Operation metadata key '${key}' is not in the allowlist (${allowedKeys.join(', ')})`,
          );
        }
        if (key === 'revision') {
          if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{1,32}$/.test(value)) {
            throw new CutoverFenceError(
              `Operation metadata 'revision' must be a safe identifier matching /^[a-zA-Z0-9._-]{1,32}$/, got '${String(value)}'`,
            );
          }
        } else if (key === 'phase') {
          if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{1,32}$/.test(value)) {
            throw new CutoverFenceError(
              `Operation metadata 'phase' must be a safe identifier matching /^[a-zA-Z0-9._-]{1,32}$/, got '${String(value)}'`,
            );
          }
        } else if (key === 'attempt') {
          if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) {
            throw new CutoverFenceError(
              `Operation metadata 'attempt' must be an integer between 1 and 100, got '${String(value)}'`,
            );
          }
        } else if (key === 'reconciled') {
          if (typeof value !== 'boolean') {
            throw new CutoverFenceError(
              `Operation metadata 'reconciled' must be a boolean, got '${String(value)}'`,
            );
          }
        }
      }
    }
    const currentTime = now();
    const createdRecord = {
      schemaVersion: 1,
      id: opId,
      operationId: opId,
      namespace: options.namespace,
      epoch: control.epoch,
      kind: options.kind,
      phase: 'admitted',
      leaseOwner: randomUUID(),
      leaseExpiresAt: currentTime + (options.leaseMs ?? 30_000),
      createdAt: currentTime,
      updatedAt: currentTime,
      metadata: options.metadata,
    };
    timer.assertUnderDeadline('withLegacyOperation admission reads');
    transaction.set(opRef, stripUndefined(createdRecord));
    transaction.set(
      controlRef,
      {
        activeOperations: control.activeOperations + 1,
        updatedAt: currentTime,
      },
      { merge: true },
    );

    timer.assertUnderDeadline('withLegacyOperation complete');
    return createdRecord;
  });

  let completedLocally = false;
  let ambiguousOutcome = false;
  let ambiguousReason;

  const ctx = {
    id: opId,
    namespace: options.namespace,
    epoch: opRecord.epoch,
    kind: options.kind,
    isAmbiguousRemoteOutcome: () => ambiguousOutcome,
    getAmbiguousReason: () => ambiguousReason,
    markAmbiguousRemoteOutcome: (reason) => {
      ambiguousOutcome = true;
      ambiguousReason = reason;
    },
    clearAmbiguousRemoteOutcome: () => {
      ambiguousOutcome = false;
      ambiguousReason = undefined;
    },
    isCompleted: () => completedLocally,
    markCompleted: () => {
      completedLocally = true;
    },
  };

  try {
    const result = await fn(ctx);
    if (!ctx.isCompleted() && !ctx.isAmbiguousRemoteOutcome()) {
      await releaseLegacyOperation(options.db, ctx, 'completed', now);
    }
    return result;
  } catch (err) {
    if (ctx.isAmbiguousRemoteOutcome()) {
      try {
        await options.db.runTransaction(async (transaction) => {
          const currentTime = now();
          transaction.set(
            opRef,
            stripUndefined({
              phase: 'upstream_pending',
              ambiguousRemoteOutcome: true,
              ambiguousReason: ctx.getAmbiguousReason(),
              updatedAt: currentTime,
            }),
            { merge: true },
          );
        });
      } catch (markErr) {
        if (err && typeof err === 'object') {
          err.markAmbiguousError = markErr;
        }
      }
    } else if (!ctx.isCompleted()) {
      try {
        await releaseLegacyOperation(options.db, ctx, 'failed', now);
      } catch (releaseErr) {
        if (err && typeof err === 'object') {
          err.releaseError = releaseErr;
        }
      }
    }
    throw err;
  }
}

export async function releaseLegacyOperation(db, ctx, outcome = 'completed', nowProvider = Date.now) {
  assertSupportedCutoverNamespace(ctx.namespace);
  if (outcome !== 'completed' && outcome !== 'failed') {
    throw new CutoverFenceError(`Invalid outcome for release: ${outcome}`);
  }
  const controlRef = getCutoverFenceDocRef(db, ctx.namespace);
  const opRef = getCutoverOperationDocRef(db, ctx.namespace, ctx.id);
  const currentTime = nowProvider();

  await db.runTransaction(async (transaction) => {
    const timer = startMonotonicTimer();
    const controlSnap = await transaction.get(controlRef);
    const opSnap = await transaction.get(opRef);

    if (!controlSnap.exists) {
      throw new CutoverFenceError(`Control record missing for namespace ${ctx.namespace}`);
    }
    if (!opSnap.exists) {
      throw new CutoverFenceError(`Operation record missing for operation ${sanitizeId(ctx.id)}`);
    }

    const control = parseCutoverFenceRecord(controlSnap.data(), ctx.namespace);
    const opData = opSnap.data();

    if (opData.schemaVersion !== 1) {
      throw new CutoverFenceError(`Invalid operation schemaVersion: expected 1, got ${opData.schemaVersion}`);
    }
    if (opData.id !== ctx.id || opData.operationId !== ctx.id) {
      throw new CutoverFenceError('Operation id mismatch on release');
    }
    if (opData.namespace !== ctx.namespace) {
      throw new CutoverFenceError(`Operation namespace mismatch: expected ${ctx.namespace}, got ${opData.namespace}`);
    }
    if (opData.kind !== ctx.kind) {
      throw new CutoverFenceError(`Operation kind mismatch on release: expected ${ctx.kind}, got ${opData.kind}`);
    }
    if (opData.epoch !== ctx.epoch) {
      throw new CutoverFenceError(
        `Epoch mismatch on release: context epoch ${ctx.epoch} != recorded epoch ${opData.epoch}`,
      );
    }

    if (opData.phase === 'completed' || opData.phase === 'failed') {
      return;
    }

    if (opData.phase === 'upstream_pending' || opData.ambiguousRemoteOutcome === true) {
      throw new CutoverFenceError(
        `Cannot release operation ${sanitizeId(ctx.id)} in phase ${opData.phase}; pending or ambiguous claims must be resolved`,
      );
    }

    if (control.activeOperations <= 0) {
      throw new CutoverFenceError(
        `Active operations underflow in namespace ${ctx.namespace}: recorded count is ${control.activeOperations}`,
      );
    }
    timer.assertUnderDeadline('releaseLegacyOperation reads');
    transaction.set(
      controlRef,
      {
        activeOperations: control.activeOperations - 1,
        updatedAt: currentTime,
      },
      { merge: true },
    );

    transaction.set(
      opRef,
      stripUndefined({ phase: outcome, ambiguousRemoteOutcome: false, updatedAt: currentTime }),
      { merge: true },
    );
    timer.assertUnderDeadline('releaseLegacyOperation complete');
  });

  ctx.markCompleted();
}

export async function markOperationAmbiguous(db, ctx, nowProvider = Date.now) {
  assertSupportedCutoverNamespace(ctx.namespace);
  const opRef = getCutoverOperationDocRef(db, ctx.namespace, ctx.id);
  const currentTime = nowProvider();

  await db.runTransaction(async (transaction) => {
    const timer = startMonotonicTimer();
    const opSnap = await transaction.get(opRef);
    if (!opSnap.exists) {
      throw new CutoverFenceError(`Operation record missing for operation ${sanitizeId(ctx.id)}`);
    }
    const opData = opSnap.data();
    if (opData.schemaVersion !== 1) {
      throw new CutoverFenceError(`Invalid operation schemaVersion: expected 1, got ${opData.schemaVersion}`);
    }
    if (opData.id !== ctx.id || opData.operationId !== ctx.id) {
      throw new CutoverFenceError('Operation id mismatch on mark ambiguous');
    }
    if (opData.namespace !== ctx.namespace) {
      throw new CutoverFenceError(`Operation namespace mismatch on mark ambiguous`);
    }
    if (opData.kind !== ctx.kind) {
      throw new CutoverFenceError(`Operation kind mismatch on mark ambiguous: expected ${ctx.kind}, got ${opData.kind}`);
    }
    if (opData.epoch !== ctx.epoch) {
      throw new CutoverFenceError(
        `Epoch mismatch on mark ambiguous: context epoch ${ctx.epoch} != recorded epoch ${opData.epoch}`,
      );
    }
    timer.assertUnderDeadline('markOperationAmbiguous reads');
    transaction.set(
      opRef,
      stripUndefined({
        phase: 'upstream_pending',
        ambiguousRemoteOutcome: true,
        updatedAt: currentTime,
      }),
      { merge: true },
    );
    timer.assertUnderDeadline('markOperationAmbiguous complete');
  });
}

export async function checkMutationGuardInTransaction(transaction, options) {
  const timer = startMonotonicTimer();
  assertSupportedCutoverNamespace(options.namespace);
  const control = await readCutoverFenceInTransaction(transaction, options.db, options.namespace);

  if (['fenced', 'migrating', 'v3_ready', 'v3_active'].includes(control.state)) {
    throw new CutoverRefusedError(
      `Cutover state is ${control.state}; mutations refused for namespace ${options.namespace}`,
      { cutoverState: control.state, epoch: control.epoch },
    );
  }

  if (!options.operation) {
    throw new CutoverFenceError(
      `Durable operation context is required for guarded mutation in namespace ${options.namespace}`,
    );
  }

  const opRef = getCutoverOperationDocRef(options.db, options.namespace, options.operation.id);
  const opSnap = await transaction.get(opRef);
  if (!opSnap.exists) {
    throw new CutoverFenceError(
      `Durable operation record missing for ${sanitizeId(options.operation.id)} in namespace ${options.namespace}`,
    );
  }
  const opRecord = opSnap.data();

  if (opRecord.schemaVersion !== 1) {
    throw new CutoverFenceError(`Invalid operation schemaVersion: expected 1, got ${opRecord.schemaVersion}`);
  }
  if (opRecord.id !== options.operation.id || opRecord.operationId !== options.operation.id) {
    throw new CutoverFenceError('Durable operation id mismatch');
  }
  if (opRecord.namespace !== options.namespace) {
    throw new CutoverFenceError(`Durable operation namespace mismatch: expected ${options.namespace}, got ${opRecord.namespace}`);
  }
  if (opRecord.kind !== options.operation.kind) {
    throw new CutoverFenceError(`Durable operation kind mismatch: expected ${options.operation.kind}, got ${opRecord.kind}`);
  }
  if (opRecord.epoch !== control.epoch) {
    throw new CutoverFenceError(
      `Operation epoch mismatch: operation epoch ${opRecord.epoch} != control epoch ${control.epoch}`,
    );
  }
  if (opRecord.phase !== 'admitted' && opRecord.phase !== 'upstream_pending') {
    throw new CutoverFenceError(
      `Operation ${sanitizeId(options.operation.id)} is already in phase ${opRecord.phase}; cannot be reused`,
    );
  }
  if (options.operation.isCompleted()) {
    throw new CutoverFenceError(
      `Operation ${sanitizeId(options.operation.id)} was marked completed locally; cannot be reused`,
    );
  }

  const completeOperation = options.completeOperation ?? true;
  let bufferedCompletionTime;

  return {
    control,
    operation: opRecord,
    bufferCompletion: (now = (options.now ?? Date.now)()) => {
      timer.assertUnderDeadline('checkMutationGuardInTransaction bufferCompletion');
      if (!options.operation || !completeOperation) {
        return;
      }
      bufferedCompletionTime = now;
      transaction.set(
        opRef,
        stripUndefined({
          phase: 'completed',
          ambiguousRemoteOutcome: false,
          updatedAt: bufferedCompletionTime,
        }),
        { merge: true },
      );

      const controlRef = getCutoverFenceDocRef(options.db, options.namespace);
      if (control.activeOperations <= 0) {
        throw new CutoverFenceError(
          `Active operations underflow in namespace ${options.namespace}: recorded count is ${control.activeOperations}`,
        );
      }
      transaction.set(
        controlRef,
        {
          activeOperations: control.activeOperations - 1,
          updatedAt: bufferedCompletionTime,
        },
        { merge: true },
      );
    },
    onCommit: () => {
      if (bufferedCompletionTime !== undefined && options.operation) {
        options.operation.markCompleted();
      }
    },
  };
}

export async function isLegacyMutationPermittedInTransaction(transaction, db, namespace, operation) {
  const timer = startMonotonicTimer();
  assertSupportedCutoverNamespace(namespace);
  const control = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (['fenced', 'migrating', 'v3_ready', 'v3_active'].includes(control.state)) {
    return { permitted: false, control };
  }
  if (!operation) {
    return { permitted: false, control };
  }
  const opRef = getCutoverOperationDocRef(db, namespace, operation.id);
  const opSnap = await transaction.get(opRef);
  if (!opSnap.exists) {
    return { permitted: false, control };
  }
  const opRecord = opSnap.data();
  if (opRecord.schemaVersion !== 1 || opRecord.id !== operation.id || opRecord.operationId !== operation.id) {
    return { permitted: false, control };
  }
  if (opRecord.namespace !== namespace || opRecord.epoch !== control.epoch) {
    return { permitted: false, control };
  }
  if (opRecord.kind !== operation.kind) {
    return { permitted: false, control };
  }
  if (opRecord.phase !== 'admitted' && opRecord.phase !== 'upstream_pending') {
    return { permitted: false, control };
  }
  timer.assertUnderDeadline('isLegacyMutationPermittedInTransaction');
  return { permitted: true, control };
}

export async function claimUpstreamGrantInTransaction(transaction, db, options) {
  const timer = startMonotonicTimer();
  const {
    namespace,
    epoch,
    familyId,
    operationId,
    claimOwner,
    expectedFamilyGeneration,
    expectedGrantVersion,
    expectedKind,
    leaseMs = 30_000,
    nowProvider = Date.now,
  } = options;
  assertSupportedCutoverNamespace(namespace);

  const expectedCollection = `${namespace}_tokens_upstream`;
  const expectedFamilyCollection = `${namespace}_tokens_refresh_families`;
  const expectedRefreshCollection = `${namespace}_tokens_refresh`;

  if (options.collection !== undefined && options.collection !== expectedCollection) {
    throw new CutoverFenceError(`Invalid legacy collection override '${options.collection}': exact '${expectedCollection}' required`);
  }
  if (options.familyCollection !== undefined && options.familyCollection !== expectedFamilyCollection) {
    throw new CutoverFenceError(`Invalid legacy familyCollection override '${options.familyCollection}': exact '${expectedFamilyCollection}' required`);
  }
  if (options.refreshCollection !== undefined && options.refreshCollection !== expectedRefreshCollection) {
    throw new CutoverFenceError(`Invalid legacy refreshCollection override '${options.refreshCollection}': exact '${expectedRefreshCollection}' required`);
  }

  const collection = expectedCollection;
  const familyCollection = expectedFamilyCollection;
  const refreshCollection = expectedRefreshCollection;
  if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 1) {
    throw new CutoverFenceError('epoch (positive integer) is required for claimUpstreamGrantInTransaction');
  }
  if (typeof familyId !== 'string' || !familyId.trim()) {
    throw new CutoverFenceError('familyId is required for claimUpstreamGrantInTransaction');
  }
  if (typeof operationId !== 'string' || !operationId.trim()) {
    throw new CutoverFenceError('operationId is required for claimUpstreamGrantInTransaction');
  }
  if (typeof claimOwner !== 'string' || !claimOwner.trim()) {
    throw new CutoverFenceError('claimOwner is required for claimUpstreamGrantInTransaction');
  }
  if (typeof expectedFamilyGeneration !== 'number' || !Number.isInteger(expectedFamilyGeneration) || expectedFamilyGeneration < 1) {
    throw new CutoverFenceError('expectedFamilyGeneration (positive integer) is required for claimUpstreamGrantInTransaction');
  }
  if (typeof expectedGrantVersion !== 'number' || !Number.isInteger(expectedGrantVersion) || expectedGrantVersion < 1) {
    throw new CutoverFenceError('expectedGrantVersion (positive integer) is required for claimUpstreamGrantInTransaction');
  }
  if (typeof expectedKind !== 'string' || !expectedKind.trim()) {
    throw new CutoverFenceError('expectedKind is required for claimUpstreamGrantInTransaction');
  }

  const now = nowProvider();
  const clampedLeaseMs = Math.max(5_000, Math.min(120_000, leaseMs));

  const control = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (['fenced', 'migrating', 'v3_ready', 'v3_active'].includes(control.state)) {
    throw new CutoverRefusedError(
      `Cutover state is ${control.state}; upstream claim refused for namespace ${namespace}`,
      { cutoverState: control.state, epoch: control.epoch },
    );
  }
  if (epoch !== control.epoch) {
    throw new CutoverFenceError(
      `Operation epoch mismatch for upstream claim in namespace ${namespace}: expected ${control.epoch}, got ${epoch}`,
    );
  }

  const opRef = getCutoverOperationDocRef(db, namespace, operationId);
  const opSnap = await transaction.get(opRef);
  if (!opSnap.exists) {
    throw new CutoverFenceError(`Durable operation record missing for upstream claim: ${sanitizeId(operationId)}`);
  }
  const opData = opSnap.data();
  if (opData.schemaVersion !== 1 || opData.id !== operationId || opData.operationId !== operationId) {
    throw new CutoverFenceError('Operation id mismatch on record');
  }
  if (opData.namespace !== namespace) {
    throw new CutoverFenceError(`Operation namespace mismatch: expected ${namespace}, got ${opData.namespace}`);
  }
  if (opData.kind !== expectedKind) {
    throw new CutoverFenceError(`Operation kind mismatch: expected ${expectedKind}, got ${opData.kind}`);
  }
  if (opData.epoch !== control.epoch) {
    throw new CutoverFenceError(`Operation record epoch mismatch: expected ${control.epoch}, got ${opData.epoch}`);
  }
  if (opData.phase !== 'admitted') {
    throw new CutoverFenceError(`Operation ${sanitizeId(operationId)} is in phase ${opData.phase}; claim refused`);
  }

  const familyRef = db.collection(familyCollection).doc(familyId);
  const familySnap = await transaction.get(familyRef);
  if (!familySnap.exists) {
    throw new CutoverFenceError(`Family record missing for claim: ${sanitizeId(familyId)}`);
  }
  const family = familySnap.data();
  const actualFamilyGen = typeof family.generation === 'number' ? family.generation : 1;
  if (typeof actualFamilyGen !== 'number' || actualFamilyGen !== expectedFamilyGeneration) {
    throw new CutoverFenceError(
      `Family generation mismatch: expected ${expectedFamilyGeneration}, got ${actualFamilyGen}`,
    );
  }

  const activePointerId = family.currentRefreshToken;
  if (typeof activePointerId !== 'string' || !activePointerId.trim()) {
    throw new CutoverFenceError(`Family missing active refresh pointer: ${sanitizeId(familyId)}`);
  }
  const pointerRef = db.collection(refreshCollection).doc(activePointerId);
  const pointerSnap = await transaction.get(pointerRef);
  if (!pointerSnap.exists) {
    throw new CutoverFenceError(`Active refresh pointer missing: ${sanitizeId(activePointerId)}`);
  }
  const pointer = pointerSnap.data();
  if (typeof pointer.familyId !== 'string' || pointer.familyId !== familyId) {
    throw new CutoverFenceError('Pointer family binding mismatch');
  }
  if (typeof pointer.status !== 'string' || pointer.status !== 'active') {
    throw new CutoverFenceError(`Current refresh pointer is not active: ${pointer.status}`);
  }

  const grantRef = db.collection(collection).doc(familyId);
  const grantSnap = await transaction.get(grantRef);
  if (!grantSnap.exists) {
    throw new CutoverFenceError(`Upstream grant missing for family: ${sanitizeId(familyId)}`);
  }
  const current = grantSnap.data();
  const actualGrantVersion = current.grantVersion ?? current.version ?? 1;
  if (actualGrantVersion !== expectedGrantVersion) {
    throw new CutoverFenceError(`Grant version mismatch: expected ${expectedGrantVersion}, got ${actualGrantVersion}`);
  }

  // Pre-send crash & pending claim lock check: lease expiry CANNOT release nonterminal claims!
  const holdingOpId = current.ambiguousOperationId ?? current.operationId;
  if (holdingOpId && holdingOpId !== operationId) {
    const priorOpRef = getCutoverOperationDocRef(db, namespace, holdingOpId);
    const priorOpSnap = await transaction.get(priorOpRef);
    if (!priorOpSnap.exists) {
      throw new CutoverFenceError(
        `Upstream grant is held by unknown operation ${sanitizeId(holdingOpId)}; fail closed`,
      );
    }
    const priorOp = priorOpSnap.data();
    if (priorOp.phase === 'upstream_pending' || priorOp.phase === 'admitted' || priorOp.ambiguousRemoteOutcome) {
      throw new CutoverFenceError(
        `Upstream grant is held by nonterminal operation ${sanitizeId(holdingOpId)} in phase ${priorOp.phase}; lease expiry cannot release nonterminal claims`,
      );
    }
  }

  if (current.ambiguousRemoteOutcome || current.ambiguousOutcome) {
    throw new CutoverFenceError(`Upstream grant for family ${sanitizeId(familyId)} has unresolved ambiguous outcome`);
  }

  const isLeaseActive = (typeof current.leaseExpiresAt === 'number' && current.leaseExpiresAt > now) ||
                        (typeof current.leaseUntil === 'number' && current.leaseUntil > now);
  if (current.leaseOwner && isLeaseActive) {
    if (current.leaseOwner !== claimOwner || current.ambiguousOperationId !== operationId) {
      throw new CutoverFenceError(`Upstream grant lease held by another claimant: ${current.leaseOwner}`);
    }
  }

  timer.assertUnderDeadline('claimUpstreamGrantInTransaction reads');
  transaction.set(
    opRef,
    stripUndefined({ phase: 'upstream_pending', familyId, updatedAt: now }),
    { merge: true },
  );
  transaction.set(
    grantRef,
    stripUndefined({
      leaseExpiresAt: now + clampedLeaseMs,
      leaseUntil: now + clampedLeaseMs,
      leaseOwner: claimOwner,
      ambiguousOperationId: operationId,
      operationId,
      familyGeneration: expectedFamilyGeneration,
      grantVersion: expectedGrantVersion,
      claimedAt: now,
      updatedAt: now,
    }),
    { merge: true },
  );

  timer.assertUnderDeadline('claimUpstreamGrantInTransaction complete');
  return {
    status: 'claimed',
    familyId,
    operationId,
    claimOwner,
    familyGeneration: expectedFamilyGeneration,
    grantVersion: expectedGrantVersion,
    leaseExpiresAt: now + clampedLeaseMs,
    grant: current.grant ? { hasGrant: true, expiresAt: current.expiresAt } : null,
  };
}

export async function reconcileUpstreamGrantInTransaction(transaction, db, options) {
  const timer = startMonotonicTimer();
  const {
    namespace,
    familyId,
    operationId,
    claimOwner,
    expectedFamilyGeneration,
    expectedGrantVersion,
    outcome,
    evidence,
    nowProvider = Date.now,
  } = options;
  assertSupportedCutoverNamespace(namespace);

  const expectedCollection = `${namespace}_tokens_upstream`;
  if (options.collection !== undefined && options.collection !== expectedCollection) {
    throw new CutoverFenceError(`Invalid legacy collection override '${options.collection}': exact '${expectedCollection}' required`);
  }
  const collection = expectedCollection;
  if (typeof familyId !== 'string' || !familyId.trim()) {
    throw new CutoverFenceError('familyId is required for upstream reconciliation');
  }
  if (typeof operationId !== 'string' || !operationId.trim()) {
    throw new CutoverFenceError('operationId is required for upstream reconciliation');
  }
  if (typeof claimOwner !== 'string' || !claimOwner.trim()) {
    throw new CutoverFenceError('claimOwner is required for upstream reconciliation');
  }
  if (typeof expectedFamilyGeneration !== 'number' || !Number.isInteger(expectedFamilyGeneration) || expectedFamilyGeneration < 1) {
    throw new CutoverFenceError('expectedFamilyGeneration (positive integer) is required for upstream reconciliation');
  }
  if (typeof expectedGrantVersion !== 'number' || !Number.isInteger(expectedGrantVersion) || expectedGrantVersion < 1) {
    throw new CutoverFenceError('expectedGrantVersion (positive integer) is required for upstream reconciliation');
  }

  const now = nowProvider();
  const control = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (['migrating', 'v3_ready', 'v3_active'].includes(control.state)) {
    throw new CutoverRefusedError(
      `Cannot reconcile legacy upstream grant: cutover state is ${control.state}`,
      { cutoverState: control.state, epoch: control.epoch },
    );
  }

  const opRef = getCutoverOperationDocRef(db, namespace, operationId);
  const opSnap = await transaction.get(opRef);
  if (!opSnap.exists) {
    throw new CutoverFenceError(`Operation record missing: ${sanitizeId(operationId)}`);
  }
  const opData = opSnap.data();
  if (opData.phase !== 'upstream_pending') {
    throw new CutoverFenceError(`Operation ${sanitizeId(operationId)} is in phase ${opData.phase}; expected upstream_pending`);
  }
  if (opData.familyId && opData.familyId !== familyId) {
    throw new CutoverFenceError(`Operation family mismatch: expected ${sanitizeId(familyId)}, got ${sanitizeId(opData.familyId)}`);
  }

  const docRef = db.collection(collection).doc(familyId);
  const snap = await transaction.get(docRef);
  if (!snap.exists) {
    throw new CutoverFenceError(`Upstream grant missing for family: ${sanitizeId(familyId)}`);
  }
  const current = snap.data();
  if (current.leaseOwner && current.leaseOwner !== claimOwner) {
    throw new CutoverFenceError(`Claim owner mismatch: expected ${current.leaseOwner}, got ${claimOwner}`);
  }
  if (current.ambiguousOperationId && current.ambiguousOperationId !== operationId) {
    throw new CutoverFenceError(`Ambiguous operation mismatch: expected ${current.ambiguousOperationId}, got ${operationId}`);
  }

  // Transient timeout is admissible to preserve ambiguity without terminalization
  if (outcome === 'transient_timeout') {
    const ALLOWED_AMBIGUOUS_REASONS = ['upstream_timeout', 'upstream_gateway_timeout', 'upstream_disconnect', 'transport_error'];
    const safeReason = typeof evidence?.reason === 'string' && ALLOWED_AMBIGUOUS_REASONS.includes(evidence.reason)
      ? evidence.reason
      : 'upstream_timeout';
    timer.assertUnderDeadline('reconcileUpstreamGrantInTransaction reads');
    transaction.set(
      opRef,
      stripUndefined({
        phase: 'upstream_pending',
        ambiguousRemoteOutcome: true,
        ambiguousReason: safeReason,
        updatedAt: now,
      }),
      { merge: true },
    );
    transaction.set(
      docRef,
      stripUndefined({
        ambiguousOutcome: true,
        ambiguousOperationId: operationId,
        ambiguousReason: safeReason,
        ambiguousAt: now,
        leaseUntil: now + 60_000,
        leaseExpiresAt: now + 60_000,
        updatedAt: now,
      }),
      { merge: true },
    );
    timer.assertUnderDeadline('reconcileUpstreamGrantInTransaction complete');
    return { status: 'ambiguous_pending', operationId, familyId };
  }

  // All other caller-supplied reconciliations unconditionally fail closed per C10 reset
  throw new CutoverFenceError(
    `Upstream grant reconciliation refused: trusted provider recovery mechanism is not established; operation ${sanitizeId(operationId)} remains held in upstream_pending`,
  );
}

export async function prepareMigrationInTransaction(transaction, db, options) {
  const timer = startMonotonicTimer();
  const { namespace, prepDoc } = options;
  assertSupportedCutoverNamespace(namespace);

  if (!options.storeKey || (typeof options.storeKey !== 'string' && !Buffer.isBuffer(options.storeKey) && !(options.storeKey instanceof Uint8Array))) {
    throw new CutoverFenceError('storeKey is REQUIRED for prepareMigrationInTransaction');
  }

  const control = await readCutoverFenceInTransaction(transaction, db, namespace);

  // FieldPath adapter is REQUIRED (no __name__ fallback)
  const FieldPath = options.FieldPath;
  if (!FieldPath || typeof FieldPath.documentId !== 'function') {
    throw new CutoverFenceError('FieldPath with documentId() is REQUIRED for prepareMigrationInTransaction');
  }
  const docIdField = FieldPath.documentId();

  // Idempotent retry after entering migrating
  if (control.state === 'migrating') {
    const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${control.epoch}`);
    const prepSnap = await transaction.get(prepRef);
    if (prepSnap.exists && C(prepSnap.data()) === C(prepDoc) && control.migrationRunId === prepDoc.migrationRunId) {
      return control;
    }
    throw new CutoverFenceError(
      'Already migrating with different manifest or runId; immutable retry violation',
    );
  }

  if (control.state !== 'fenced') {
    throw new CutoverFenceError(`Cannot prepare migration: state must be 'fenced', got '${control.state}'`);
  }
  if (control.activeOperations !== 0) {
    throw new CutoverFenceError(`Cannot prepare migration: activeOperations must be 0, got ${control.activeOperations}`);
  }

  const expectedPrepKeys = prepDoc.totalPhysicalRecords > 0
    ? [...REQUIRED_PREPARED_MANIFEST_KEYS, ...NONEMPTY_PROJECTOR_KEYS]
    : REQUIRED_PREPARED_MANIFEST_KEYS;
  validateMapKeysExact(prepDoc, expectedPrepKeys, 'prepared manifest');
  validateMigrationIdentityFields(prepDoc, namespace, control.epoch, prepDoc.migrationRunId);

  if (prepDoc.kind !== 'prepared') {
    throw new CutoverFenceError(`prepared manifest kind must be 'prepared', got '${prepDoc.kind}'`);
  }
  if (typeof prepDoc.preparedAt !== 'number' || !Number.isInteger(prepDoc.preparedAt) || prepDoc.preparedAt <= 0) {
    throw new CutoverFenceError('preparedAt must be a positive integer timestamp');
  }

  validateMapKeysExact(prepDoc.physicalCounts, PHYSICAL_COUNT_KEYS, 'prepared physicalCounts');
  validateMapKeysExact(prepDoc.expectedTargetCounts, TARGET_COUNT_KEYS, 'prepared expectedTargetCounts');
  validateMapKeysExact(prepDoc.classifications, CLASSIFICATION_KEYS, 'prepared classifications');
  validateMapKeysExact(prepDoc.reasons, REASON_KEYS, 'prepared reasons');

  const prepPhysicalSum = Object.values(prepDoc.physicalCounts).reduce((sum, n) => {
    if (!Number.isSafeInteger(n) || n < 0) throw new CutoverFenceError('Invalid physical count');
    return sum + n;
  }, 0);
  if (prepPhysicalSum !== prepDoc.totalPhysicalRecords) {
    throw new CutoverFenceError(
      `prepared totalPhysicalRecords must equal sum(physicalCounts): expected ${prepPhysicalSum}, got ${prepDoc.totalPhysicalRecords}`,
    );
  }

  const prepClassSum = Object.values(prepDoc.classifications).reduce((sum, n) => {
    if (!Number.isSafeInteger(n) || n < 0) throw new CutoverFenceError('Invalid classification count');
    return sum + n;
  }, 0);
  if (prepClassSum !== prepDoc.scanned || prepDoc.scanned !== prepDoc.candidateCommitments.length) {
    throw new CutoverFenceError(
      'prepared classifications sum must equal scanned and candidateCommitments.length',
    );
  }

  validateCandidateCommitments(prepDoc.candidateCommitments, prepDoc, namespace, control.epoch, prepDoc.migrationRunId);

  // Exact read strategy: query ALL 13 distinct collections once
  const distinctColNames = getCutoverDistinctCollectionNames(namespace).distinct;
  const readStart = Date.now();
  const rawColSnaps = new Map();

  for (const colName of distinctColNames) {
    const q = db.collection(colName).orderBy(docIdField);
    const snap = await transaction.get(q);
    rawColSnaps.set(colName, snap);
  }

  const readDurationMs = Date.now() - readStart;
  if (readDurationMs > FIRESTORE_TRANSACTION_READ_DEADLINE_MS) {
    throw new CutoverFenceError(`Preparation read duration (${readDurationMs} ms) exceeds 16,000 ms lock deadline`);
  }

  // Partition all 13 collections into normalized key buckets
  const sourcePhysicalToKey = {
    [`${namespace}_tokens_refresh_families`]: 'families',
    [`${namespace}_tokens`]: 'tokens',
    [`${namespace}_tokens_refresh`]: 'refresh',
    [`${namespace}_tokens_upstream`]: 'upstream',
    [`${namespace}_auth_codes`]: 'authCodes',
    [`${namespace}_resume_tokens`]: 'resumeTokens',
    [`${namespace}_oauth_clients`]: 'oauthClients',
    [`${namespace}_clients`]: 'clients',
  };

  const targetPhysicalToKey = {
    [`${namespace}_refresh_families`]: 'families',
    [`${namespace}_sessions`]: 'tokens',
    [`${namespace}_refresh`]: 'refresh',
    [`${namespace}_upstream`]: 'upstream',
    [`${namespace}_auth_codes`]: 'authCodes',
    [`${namespace}_resume_tokens`]: 'resumeTokens',
    [`${namespace}_retired_refresh`]: 'retiredRefreshTokens',
    [`${namespace}_oauth_clients`]: 'oauthClients',
  };

  const sourceDocsByKey = new Map();
  for (const k of PHYSICAL_COUNT_KEYS) sourceDocsByKey.set(k, []);

  const targetDocsByKey = new Map();
  for (const k of TARGET_COUNT_KEYS) targetDocsByKey.set(k, []);

  for (const [physicalName, snap] of rawColSnaps.entries()) {
    const isSourceCol = physicalName in sourcePhysicalToKey;
    const isTargetCol = physicalName in targetPhysicalToKey;

    if (isSourceCol && !isTargetCol) {
      const colKey = sourcePhysicalToKey[physicalName];
      sourceDocsByKey.set(colKey, snap.docs);
    } else if (isTargetCol && !isSourceCol) {
      const colKey = targetPhysicalToKey[physicalName];
      targetDocsByKey.set(colKey, snap.docs);
    } else if (isSourceCol && isTargetCol) {
      const sKey = sourcePhysicalToKey[physicalName];
      const tKey = targetPhysicalToKey[physicalName];
      for (const d of snap.docs) {
        if (isTargetFormatRow(physicalName, d.data(), d.id)) {
          targetDocsByKey.get(tKey).push(d);
        } else {
          sourceDocsByKey.get(sKey).push(d);
        }
      }
    }
  }

  // Build target key map from existing target collections: validate ID and client_id per real collection schema
  const existingTargetKeyedMap = new Map();
  for (const [colKey, docs] of targetDocsByKey.entries()) {
    for (const d of docs) {
      const data = d.data() || {};
      if (colKey !== 'oauthClients' && colKey !== 'clients') {
        if (typeof data.id === 'string' && data.id !== d.id) {
          throw new CutoverFenceError(`Document ID mismatch in ${colKey}/${d.id}: stored id '${data.id}' != docId '${d.id}'`);
        }
      } else {
        if (typeof data.client_id === 'string' && data.client_id !== d.id) {
          throw new CutoverFenceError(`client_id mismatch in ${colKey}/${d.id}: stored client_id '${data.client_id}' != docId '${d.id}'`);
        }
      }
      const targetId = computeKeyedDocId(options.storeKey, 'target-id', namespace, control.epoch, colKey, d.id);
      const recDigest = computeTargetRecordDigest(options.storeKey, namespace, control.epoch, colKey, targetId, data);
      existingTargetKeyedMap.set(`${colKey}:${targetId}`, { doc: d, rawId: d.id, recordDigest: recDigest, data: { ...data, id: d.id } });
    }
  }

  // Verify retained target graphs: contract permits retained equivalent targets, but they must be all-or-none complete and recordDigest equivalent
  for (const c of prepDoc.candidateCommitments) {
    let existingTargetsForCandidate = 0;
    for (const t of c.targets) {
      const targetKey = `${t.collection}:${t.id}`;
      if (existingTargetKeyedMap.has(targetKey)) {
        existingTargetsForCandidate++;
      }
    }
    if (existingTargetsForCandidate > 0) {
      if (existingTargetsForCandidate !== c.targets.length) {
        throw new CutoverFenceError(
          `Candidate ${c.id} has partial retained target graph in Firestore (${existingTargetsForCandidate}/${c.targets.length}); must be all-or-none complete`,
        );
      }
      for (const t of c.targets) {
        const targetKey = `${t.collection}:${t.id}`;
        const entry = existingTargetKeyedMap.get(targetKey);
        if (t.recordDigest && entry.recordDigest !== t.recordDigest) {
          throw new CutoverFenceError(
            `Retained target '${targetKey}' for candidate ${c.id} is not equivalent to candidate target recordDigest`,
          );
        }
      }
    }
  }

  // Ensure no unexpected extra targets exist
  const candidateTargetKeys = new Set();
  for (const c of prepDoc.candidateCommitments) {
    for (const t of c.targets) {
      candidateTargetKeys.add(`${t.collection}:${t.id}`);
    }
  }
  for (const targetKey of existingTargetKeyedMap.keys()) {
    if (!candidateTargetKeys.has(targetKey)) {
      throw new CutoverFenceError(`Cannot prepare migration: unexpected extra target '${targetKey}' exists prior to migration`);
    }
  }

  // Validate actual physical counts
  for (const k of PHYSICAL_COUNT_KEYS) {
    const actualCount = sourceDocsByKey.get(k).length;
    if (actualCount !== prepDoc.physicalCounts[k]) {
      throw new CutoverFenceError(
        `Physical collection count mismatch for '${k}': Firestore has ${actualCount}, prepared manifest has ${prepDoc.physicalCounts[k]}`,
      );
    }
  }

  // Build keyed ID map: (colKey, H("source-id", [colKey, rawId])) -> { doc, rawId, recordDigest, data }
  const sourceKeyedMap = new Map();
  const sourceDescriptors = [];
  for (const [colKey, docs] of sourceDocsByKey.entries()) {
    for (const d of docs) {
      const data = d.data() || {};
      if ((colKey === 'families' || colKey === 'resumeTokens') && typeof data.id === 'string' && data.id !== d.id) {
        throw new CutoverFenceError(`Document ID mismatch in ${colKey}/${d.id}: stored id '${data.id}' != docId '${d.id}'`);
      }
      if ((colKey === 'oauthClients' || colKey === 'clients') && typeof data.client_id === 'string' && data.client_id !== d.id) {
        throw new CutoverFenceError(`client_id mismatch in ${colKey}/${d.id}: stored client_id '${data.client_id}' != docId '${d.id}'`);
      }
      const sourceId = computeKeyedDocId(options.storeKey, 'source-id', namespace, control.epoch, colKey, d.id);
      const recDigest = computeSourceRecordDigest(options.storeKey, namespace, control.epoch, colKey, sourceId, data);
      sourceKeyedMap.set(`${colKey}:${sourceId}`, { doc: d, rawId: d.id, recordDigest: recDigest, data: { ...data, id: d.id } });
      sourceDescriptors.push({ collection: colKey, id: sourceId, recordDigest: recDigest });
    }
  }

  // Verify candidate commitments against Firestore source documents and check complete source partitioning
  const coveredSources = new Set();
  for (const c of prepDoc.candidateCommitments) {
    for (const s of c.sources) {
      const entry = sourceKeyedMap.get(`${s.collection}:${s.id}`);
      if (!entry) {
        throw new CutoverFenceError(`Candidate ${c.id} references source document '${s.collection}:${s.id}' not found in Firestore`);
      }
      if (entry.recordDigest !== s.recordDigest) {
        throw new CutoverFenceError(`Candidate ${c.id} source recordDigest mismatch for '${s.collection}:${s.id}'`);
      }
      coveredSources.add(`${s.collection}:${s.id}`);
    }
  }

  for (const key of sourceKeyedMap.keys()) {
    if (!coveredSources.has(key)) {
      throw new CutoverFenceError(`Extra source document '${key}' found in Firestore not partitioned into candidate commitments`);
    }
  }

  // Provenance-bound graph projector: nonempty migrations execute reviewed separate module verified against measured bytes
  if (prepDoc.totalPhysicalRecords > 0) {
    if (prepDoc.projectorId !== APPROVED_GRAPH_PROJECTOR_ID || prepDoc.projectorVersion !== APPROVED_GRAPH_PROJECTOR_VERSION) {
      throw new CutoverFenceError(
        `Projector identity mismatch: expected '${APPROVED_GRAPH_PROJECTOR_ID}' v${APPROVED_GRAPH_PROJECTOR_VERSION}, got '${prepDoc.projectorId}' v${prepDoc.projectorVersion}`,
      );
    }
    const measuredProjectorDigest = getMeasuredProjectorDigest();
    if (prepDoc.projectorDigest !== measuredProjectorDigest) {
      throw new CutoverFenceError(
        `Projector digest mismatch: manifest has ${prepDoc.projectorDigest}, deployed module byte SHA-256 is ${measuredProjectorDigest}`,
      );
    }

    const codec = createCodec(options.storeKey);

    for (const c of prepDoc.candidateCommitments) {
      const sourcesMap = new Map();
      if (c.kind === 'pr56Families') {
        const famDesc = c.sources.find((s) => s.collection === 'families');
        if (!famDesc) throw new CutoverFenceError(`Candidate ${c.id} missing families descriptor in sources`);
        const e = sourceKeyedMap.get(`${famDesc.collection}:${famDesc.id}`);
        if (!e) throw new CutoverFenceError(`Candidate ${c.id} missing families source document`);
        const famData = { ...(e.data || {}), id: e.rawId };
        sourcesMap.set('families', famData);

        // Exact active refresh selection: must have rawId === famData.currentRefreshToken AND status === 'active'
        const activeRefDesc = c.sources.find((s) => {
          if (s.collection !== 'refresh') return false;
          const entry = sourceKeyedMap.get(`refresh:${s.id}`);
          return entry && entry.rawId === famData.currentRefreshToken && entry.data?.status === 'active';
        });
        if (!activeRefDesc) {
          throw new CutoverFenceError(`Candidate ${c.id} missing active refresh descriptor in sources matching currentRefreshToken '${famData.currentRefreshToken}'`);
        }
        const re = sourceKeyedMap.get(`refresh:${activeRefDesc.id}`);
        if (!re) throw new CutoverFenceError(`Candidate ${c.id} missing active refresh document in sourceKeyedMap`);
        sourcesMap.set('refresh', { ...(re.data || {}), id: re.rawId });

        // Exact previous refresh selection: must have rawId === famData.previousRefreshToken AND status === 'consumed'
        if (famData.previousRefreshToken) {
          const prevRefDesc = c.sources.find((s) => {
            if (s.collection !== 'refresh') return false;
            const entry = sourceKeyedMap.get(`refresh:${s.id}`);
            return entry && entry.rawId === famData.previousRefreshToken && entry.data?.status === 'consumed';
          });
          if (!prevRefDesc) {
            throw new CutoverFenceError(`Candidate ${c.id} has previousRefreshToken '${famData.previousRefreshToken}' but missing previous refresh descriptor in sources`);
          }
          const pe = sourceKeyedMap.get(`refresh:${prevRefDesc.id}`);
          if (!pe) throw new CutoverFenceError(`Candidate ${c.id} missing previous refresh document in sourceKeyedMap`);
          if (typeof pe.data?.consumedAt !== 'number') {
            throw new CutoverFenceError(`Candidate ${c.id} previous refresh document '${pe.rawId}' missing numeric consumedAt`);
          }
          sourcesMap.set('prevRefresh', { ...(pe.data || {}), id: pe.rawId });
        }

        const upDesc = c.sources.find((s) => s.collection === 'upstream');
        if (!upDesc) throw new CutoverFenceError(`Candidate ${c.id} missing upstream descriptor in sources`);
        const ue = sourceKeyedMap.get(`${upDesc.collection}:${upDesc.id}`);
        if (!ue) throw new CutoverFenceError(`Candidate ${c.id} missing upstream source document`);
        sourcesMap.set('upstream', { ...(ue.data || {}), id: ue.rawId });

        const tokDesc = c.sources.find((s) => s.collection === 'tokens');
        if (tokDesc) {
          const te = sourceKeyedMap.get(`${tokDesc.collection}:${tokDesc.id}`);
          if (te) sourcesMap.set('tokens', { ...(te.data || {}), id: te.rawId });
        }
      } else if (c.kind === 'baseFormatTokens') {
        const tokDesc = c.sources.find((s) => s.collection === 'tokens');
        if (!tokDesc) throw new CutoverFenceError(`Candidate ${c.id} missing tokens descriptor in sources`);
        const te = sourceKeyedMap.get(`${tokDesc.collection}:${tokDesc.id}`);
        if (!te) throw new CutoverFenceError(`Candidate ${c.id} missing tokens source document`);
        sourcesMap.set('tokens', { ...(te.data || {}), id: te.rawId });

        const refDesc = c.sources.find((s) => s.collection === 'refresh');
        if (!refDesc) throw new CutoverFenceError(`Candidate ${c.id} missing refresh descriptor in sources`);
        const re = sourceKeyedMap.get(`${refDesc.collection}:${refDesc.id}`);
        if (!re) throw new CutoverFenceError(`Candidate ${c.id} missing refresh source document`);
        sourcesMap.set('refresh', { ...(re.data || {}), id: re.rawId });
      } else if (c.kind === 'authCodes') {
        const codeDesc = c.sources.find((s) => s.collection === 'authCodes');
        if (!codeDesc) throw new CutoverFenceError(`Candidate ${c.id} missing authCodes descriptor in sources`);
        const e = sourceKeyedMap.get(`${codeDesc.collection}:${codeDesc.id}`);
        if (!e) throw new CutoverFenceError(`Candidate ${c.id} missing authCodes source document`);
        sourcesMap.set('authCodes', { ...(e.data || {}), id: e.rawId });
      } else if (c.kind === 'resumeTokens') {
        const resDesc = c.sources.find((s) => s.collection === 'resumeTokens');
        if (!resDesc) throw new CutoverFenceError(`Candidate ${c.id} missing resumeTokens descriptor in sources`);
        const e = sourceKeyedMap.get(`${resDesc.collection}:${resDesc.id}`);
        if (!e) throw new CutoverFenceError(`Candidate ${c.id} missing resumeTokens source document`);
        sourcesMap.set('resumeTokens', { ...(e.data || {}), id: e.rawId });
      } else if (c.kind === 'clients') {
        const oauthDesc = c.sources.find((s) => s.collection === 'oauthClients');
        const clientDesc = c.sources.find((s) => s.collection === 'clients');
        const oauthEntry = oauthDesc ? sourceKeyedMap.get(`oauthClients:${oauthDesc.id}`) : null;
        const clientEntry = clientDesc ? sourceKeyedMap.get(`clients:${clientDesc.id}`) : null;
        if (oauthEntry && clientEntry) {
          const oData = oauthEntry.data || {};
          const cData = clientEntry.data || {};
          if (
            C(oData.redirect_uris || []) !== C(cData.redirect_uris || []) ||
            oData.token_endpoint_auth_method !== cData.token_endpoint_auth_method
          ) {
            throw new CutoverFenceError(`Conflicting claims between clients and oauthClients for clientId ${clientEntry.rawId}`);
          }
          sourcesMap.set('clients', { ...cData, ...oData, id: clientEntry.rawId });
        } else if (oauthEntry) {
          sourcesMap.set('clients', { ...(oauthEntry.data || {}), id: oauthEntry.rawId });
        } else if (clientEntry) {
          sourcesMap.set('clients', { ...(clientEntry.data || {}), id: clientEntry.rawId });
        }
      }

      const sourceResult = projectSourceLogical(c, sourcesMap, codec);
      validateCandidateProjection(c.kind, c.id, sourceResult);
      const derivedSourceLogicalDigest = H(options.storeKey, 'logical-record', namespace, control.epoch, [c.kind, sourceResult]);
      if (c.logicalDigest !== derivedSourceLogicalDigest) {
        throw new CutoverFenceError(
          `Candidate ${c.id} logicalDigest mismatch with projector-derived source logical digest`,
        );
      }

      // Check retained targets if present for this candidate
      const existingTargetsCount = c.targets.filter((t) => existingTargetKeyedMap.has(`${t.collection}:${t.id}`)).length;
      if (existingTargetsCount > 0) {
        const targetsMap = new Map();
        if (c.kind === 'pr56Families') {
          const famTarget = c.targets.find((t) => t.collection === 'families');
          let famData;
          if (famTarget) {
            const e = existingTargetKeyedMap.get(`${famTarget.collection}:${famTarget.id}`);
            if (e) {
              famData = { ...(e.data || {}), id: e.rawId };
              targetsMap.set('families', famData);
            }
          }
          const upTarget = c.targets.find((t) => t.collection === 'upstream');
          if (upTarget) {
            const e = existingTargetKeyedMap.get(`${upTarget.collection}:${upTarget.id}`);
            if (e) targetsMap.set('upstream', { ...(e.data || {}), id: e.rawId });
          }
          const sessTarget = c.targets.find((t) => t.collection === 'tokens');
          if (sessTarget) {
            const e = existingTargetKeyedMap.get(`${sessTarget.collection}:${sessTarget.id}`);
            if (e) targetsMap.set('tokens', { ...(e.data || {}), id: e.rawId });
          }
          const refreshTargets = c.targets.filter((t) => t.collection === 'refresh');
          for (const t of refreshTargets) {
            const e = existingTargetKeyedMap.get(`refresh:${t.id}`);
            if (e) {
              if (famData && (e.rawId === famData.activeRefreshId && e.data?.status === 'active')) {
                targetsMap.set('activeRefresh', { ...(e.data || {}), id: e.rawId });
              } else if (famData && (e.rawId !== famData.activeRefreshId && e.data?.status === 'consumed')) {
                targetsMap.set('prevRefresh', { ...(e.data || {}), id: e.rawId });
              }
            }
          }
          if (!targetsMap.has('activeRefresh')) {
            throw new CutoverFenceError(`Candidate ${c.id} missing active refresh target document matching activeRefreshId`);
          }
          if (famData && famData.previousRefreshToken && !targetsMap.has('prevRefresh')) {
            throw new CutoverFenceError(`Candidate ${c.id} has previousRefreshToken but missing prevRefresh target document`);
          }
          const retiredTargets = c.targets.filter((t) => t.collection === 'retiredRefreshTokens');
          const retiredIds = [];
          for (const t of retiredTargets) {
            const e = existingTargetKeyedMap.get(`retiredRefreshTokens:${t.id}`);
            if (!e) throw new CutoverFenceError(`Candidate ${c.id} missing retiredRefreshTokens target document in Firestore`);
            if (e.data?.familyId !== famData?.id) throw new CutoverFenceError(`Retired refresh token '${e.rawId}' familyId mismatch`);
            retiredIds.push(e.rawId);
          }
          targetsMap.set('retiredRefresh', { ids: retiredIds.sort(canonicalCompare) });
        } else if (c.kind === 'baseFormatTokens') {
          const famTarget = c.targets.find((t) => t.collection === 'families');
          if (famTarget) {
            const e = existingTargetKeyedMap.get(`${famTarget.collection}:${famTarget.id}`);
            if (e) targetsMap.set('families', { ...(e.data || {}), id: e.rawId });
          }
          const upTarget = c.targets.find((t) => t.collection === 'upstream');
          if (upTarget) {
            const e = existingTargetKeyedMap.get(`${upTarget.collection}:${upTarget.id}`);
            if (e) targetsMap.set('upstream', { ...(e.data || {}), id: e.rawId });
          }
          const sessTarget = c.targets.find((t) => t.collection === 'tokens');
          if (sessTarget) {
            const e = existingTargetKeyedMap.get(`${sessTarget.collection}:${sessTarget.id}`);
            if (e) targetsMap.set('tokens', { ...(e.data || {}), id: e.rawId });
          }
          const refTarget = c.targets.find((t) => t.collection === 'refresh');
          if (refTarget) {
            const e = existingTargetKeyedMap.get(`${refTarget.collection}:${refTarget.id}`);
            if (e) targetsMap.set('activeRefresh', { ...(e.data || {}), id: e.rawId });
          }
        } else if (c.kind === 'authCodes') {
          const codeTarget = c.targets.find((t) => t.collection === 'authCodes');
          if (codeTarget) {
            const e = existingTargetKeyedMap.get(`${codeTarget.collection}:${codeTarget.id}`);
            if (e) targetsMap.set('authCodes', { ...(e.data || {}), id: e.rawId });
          }
        } else if (c.kind === 'resumeTokens') {
          const resTarget = c.targets.find((t) => t.collection === 'resumeTokens');
          if (resTarget) {
            const e = existingTargetKeyedMap.get(`${resTarget.collection}:${resTarget.id}`);
            if (e) targetsMap.set('resumeTokens', { ...(e.data || {}), id: e.rawId });
          }
        } else if (c.kind === 'clients') {
          const clientTarget = c.targets.find((t) => t.collection === 'oauthClients' || t.collection === 'clients');
          if (clientTarget) {
            const e = existingTargetKeyedMap.get(`${clientTarget.collection}:${clientTarget.id}`);
            if (e) targetsMap.set('clients', { ...(e.data || {}), id: e.rawId });
          }
        }

        const targetResult = projectTargetLogical(c, targetsMap, codec);
        validateCandidateProjection(c.kind, c.id, targetResult);
        const derivedTargetLogicalDigest = H(options.storeKey, 'logical-record', namespace, control.epoch, [c.kind, targetResult]);
        if (derivedTargetLogicalDigest !== c.logicalDigest) {
          throw new CutoverFenceError(
            `Retained target graph for candidate ${c.id} is not logically equivalent to candidate commitment`,
          );
        }
      }
    }
  }

  // Recompute and verify sourceInventoryDigest from sorted exact descriptor objects { collection, id, recordDigest }
  const computedSourceInventory = computeSourceInventoryDigest(options.storeKey, namespace, control.epoch, sourceDescriptors);
  if (prepDoc.sourceInventoryDigest !== computedSourceInventory) {
    throw new CutoverFenceError('prepared manifest sourceInventoryDigest does not match computed source inventory');
  }

  // Recompute and verify sourceLogicalDigest from candidate commitments
  const sortedCandidateLogicalPairs = prepDoc.candidateCommitments
    .map((c) => [c.id, c.logicalDigest])
    .sort((a, b) => canonicalCompare(a[0], b[0]));
  const computedLogicalInventory = H(options.storeKey, 'logical-inventory', namespace, control.epoch, sortedCandidateLogicalPairs);
  if (prepDoc.sourceLogicalDigest !== computedLogicalInventory) {
    throw new CutoverFenceError('prepared manifest sourceLogicalDigest does not match computed logical inventory');
  }

  // Validate preflight full readset
  const allDocs = Array.from(rawColSnaps.values()).flatMap((s) => s.docs.map((d) => d.data()));
  validateMigrationPreflightLimits(prepDoc, { fullReadset: allDocs, readDurationMs });

  const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${control.epoch}`);
  const prepSnap = await transaction.get(prepRef);
  if (prepSnap.exists) {
    const existing = prepSnap.data();
    if (C(existing) !== C(prepDoc)) {
      throw new CutoverFenceError(
        'Prepared manifest already exists for this epoch with different content; immutable retry violation',
      );
    }
    return control;
  }

  timer.assertUnderDeadline('prepareMigrationInTransaction reads and verification');
  transaction.set(prepRef, stripUndefined(prepDoc));

  const controlRef = getCutoverFenceDocRef(db, namespace);
  const updatedControl = {
    ...control,
    state: 'migrating',
    migrationRunId: prepDoc.migrationRunId,
    migrationManifestDigest: undefined,
    updatedAt: prepDoc.preparedAt,
  };
  transaction.set(controlRef, stripUndefined(updatedControl));
  timer.assertUnderDeadline('prepareMigrationInTransaction complete');
  return updatedControl;
}

export async function finalizeMigrationInTransaction(transaction, db, options) {
  const timer = startMonotonicTimer();
  const { namespace, finalDoc, markerDoc } = options;
  assertSupportedCutoverNamespace(namespace);

  if (!options.storeKey || (typeof options.storeKey !== 'string' && !Buffer.isBuffer(options.storeKey) && !(options.storeKey instanceof Uint8Array))) {
    throw new CutoverFenceError('storeKey is REQUIRED for finalizeMigrationInTransaction');
  }

  const control = await readCutoverFenceInTransaction(transaction, db, namespace);

  // FieldPath adapter is REQUIRED (no __name__ fallback)
  const FieldPath = options.FieldPath;
  if (!FieldPath || typeof FieldPath.documentId !== 'function') {
    throw new CutoverFenceError('FieldPath with documentId() is REQUIRED for finalizeMigrationInTransaction');
  }
  const docIdField = FieldPath.documentId();

  // Idempotent retry after entering v3_ready
  if (control.state === 'v3_ready') {
    const finalRef = db.collection(`${namespace}_meta`).doc(`migration_manifest_${control.epoch}`);
    const markerRef = db.collection(`${namespace}_meta`).doc('v2_adopted');
    const finalSnap = await transaction.get(finalRef);
    const markerSnap = await transaction.get(markerRef);
    if (
      finalSnap.exists &&
      markerSnap.exists &&
      C(finalSnap.data()) === C(finalDoc) &&
      C(markerSnap.data()) === C(markerDoc) &&
      control.migrationManifestDigest === markerDoc.migrationManifestDigest
    ) {
      return control;
    }
    throw new CutoverFenceError(
      'Already in v3_ready state with different manifests; immutable retry violation',
    );
  }

  if (control.state !== 'migrating') {
    throw new CutoverFenceError(`Cannot finalize migration: state must be 'migrating', got '${control.state}'`);
  }
  if (control.activeOperations !== 0) {
    throw new CutoverFenceError(`Cannot finalize migration: activeOperations must be 0, got ${control.activeOperations}`);
  }
  if (markerDoc.emptyNamespace !== true && !control.irreversible) {
    throw new CutoverFenceError(
      `Cannot finalize migration for namespace ${namespace}: irreversible latch must be engaged before finalization`,
    );
  }

  const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${control.epoch}`);
  const prepSnap = await transaction.get(prepRef);
  if (!prepSnap.exists) {
    throw new CutoverFenceError(`Cannot finalize migration: prepared manifest missing for epoch ${control.epoch}`);
  }
  const prep = prepSnap.data();

  const expectedFinalKeys = finalDoc.totalPhysicalRecords > 0
    ? [...REQUIRED_FINAL_MANIFEST_KEYS, ...NONEMPTY_PROJECTOR_KEYS]
    : REQUIRED_FINAL_MANIFEST_KEYS;
  validateMapKeysExact(finalDoc, expectedFinalKeys, 'final manifest');
  validateMigrationIdentityFields(finalDoc, namespace, control.epoch, control.migrationRunId);
  if (finalDoc.kind !== 'final') {
    throw new CutoverFenceError(`final manifest kind must be 'final', got '${finalDoc.kind}'`);
  }
  if (typeof finalDoc.completedAt !== 'number' || !Number.isInteger(finalDoc.completedAt) || finalDoc.completedAt <= 0) {
    throw new CutoverFenceError('final manifest completedAt must be a positive integer timestamp');
  }

  const expectedMarkerKeys = markerDoc.emptyNamespace !== true
    ? [...REQUIRED_OWNERSHIP_MARKER_KEYS, ...NONEMPTY_PROJECTOR_KEYS]
    : REQUIRED_OWNERSHIP_MARKER_KEYS;
  validateMapKeysExact(markerDoc, expectedMarkerKeys, 'ownership marker');
  validateMigrationIdentityFields(markerDoc, namespace, control.epoch, control.migrationRunId);
  if (markerDoc.kind !== 'ownership') {
    throw new CutoverFenceError(`ownership marker kind must be 'ownership', got '${markerDoc.kind}'`);
  }
  if (typeof markerDoc.adoptedAt !== 'number' || !Number.isInteger(markerDoc.adoptedAt) || markerDoc.adoptedAt <= 0) {
    throw new CutoverFenceError('ownership marker adoptedAt must be a positive integer timestamp');
  }

  if (
    finalDoc.codeSha !== prep.codeSha ||
    finalDoc.codeArtifact !== prep.codeArtifact ||
    finalDoc.packageIntegrity !== prep.packageIntegrity ||
    finalDoc.protocolDigest !== prep.protocolDigest ||
    markerDoc.codeSha !== prep.codeSha ||
    markerDoc.codeArtifact !== prep.codeArtifact ||
    markerDoc.packageIntegrity !== prep.packageIntegrity ||
    markerDoc.protocolDigest !== prep.protocolDigest
  ) {
    throw new CutoverFenceError('Provenance mismatch across prepared, final, and marker manifests');
  }

  const computedPreparedDigest = D('prepared', namespace, control.epoch, prep);
  if (finalDoc.preparedDigest !== computedPreparedDigest) {
    throw new CutoverFenceError(
      `final manifest preparedDigest (${finalDoc.preparedDigest}) does not match computed prepared digest (${computedPreparedDigest})`,
    );
  }
  if (markerDoc.preparedDigest !== computedPreparedDigest) {
    throw new CutoverFenceError('ownership marker preparedDigest does not match computed prepared digest');
  }

  const computedFinalDigest = D('final', namespace, control.epoch, finalDoc);
  if (markerDoc.migrationManifestDigest !== computedFinalDigest) {
    throw new CutoverFenceError(
      `ownership marker migrationManifestDigest (${markerDoc.migrationManifestDigest}) does not match computed final digest (${computedFinalDigest})`,
    );
  }

  validateMapKeysExact(finalDoc.physicalCounts, PHYSICAL_COUNT_KEYS, 'final physicalCounts');
  validateMapKeysExact(finalDoc.targetCounts, TARGET_COUNT_KEYS, 'final targetCounts');
  validateMapKeysExact(finalDoc.classifications, CLASSIFICATION_KEYS, 'final classifications');
  validateMapKeysExact(finalDoc.reasons, REASON_KEYS, 'final reasons');

  if (finalDoc.errors !== 0) {
    throw new CutoverFenceError(`Cannot finalize migration: final errors must be 0, got ${finalDoc.errors}`);
  }
  for (const [rKey, rVal] of Object.entries(finalDoc.reasons)) {
    if (rVal !== 0) {
      throw new CutoverFenceError(`Cannot finalize migration: reason count '${rKey}' must be 0, got ${rVal}`);
    }
  }

  if (finalDoc.sourceLogicalDigest !== finalDoc.targetLogicalDigest) {
    throw new CutoverFenceError('Cannot finalize migration: sourceLogicalDigest must equal targetLogicalDigest');
  }
  if (finalDoc.sourceInventoryDigest !== prep.sourceInventoryDigest) {
    throw new CutoverFenceError('Cannot finalize migration: sourceInventoryDigest must match prepared');
  }
  if (finalDoc.sourceLogicalDigest !== prep.sourceLogicalDigest) {
    throw new CutoverFenceError('Cannot finalize migration: sourceLogicalDigest must match prepared');
  }

  if (C(finalDoc.physicalCounts) !== C(prep.physicalCounts)) {
    throw new CutoverFenceError('final physicalCounts do not match prepared physicalCounts');
  }
  if (C(finalDoc.targetCounts) !== C(prep.expectedTargetCounts)) {
    throw new CutoverFenceError('final targetCounts do not match prepared expectedTargetCounts');
  }
  if (C(finalDoc.classifications) !== C(prep.classifications)) {
    throw new CutoverFenceError('final classifications do not match prepared classifications');
  }
  if (C(finalDoc.reasons) !== C(prep.reasons)) {
    throw new CutoverFenceError('final reasons do not match prepared reasons');
  }

  const finalPhysicalSum = Object.values(finalDoc.physicalCounts).reduce((sum, n) => sum + n, 0);
  if (finalPhysicalSum !== finalDoc.totalPhysicalRecords) {
    throw new CutoverFenceError('final physicalCounts sum must equal totalPhysicalRecords');
  }

  const targetCountSum = Object.values(finalDoc.targetCounts).reduce((sum, n) => {
    if (!Number.isSafeInteger(n) || n < 0) throw new CutoverFenceError('Invalid target count');
    return sum + n;
  }, 0);

  if (markerDoc.emptyNamespace === true) {
    if (finalDoc.totalPhysicalRecords !== 0 || finalDoc.scanned !== 0 || finalDoc.migrated !== 0 || finalDoc.skipped !== 0 || finalDoc.errors !== 0) {
      throw new CutoverFenceError('Counts must be 0 for emptyNamespace final manifest');
    }
    if (prep.candidateCommitments.length !== 0) {
      throw new CutoverFenceError('candidateCommitments must be empty for emptyNamespace');
    }
    if (targetCountSum !== 0) {
      throw new CutoverFenceError('targetCounts sum must be 0 for emptyNamespace');
    }

    // Canonical empty hash equations
    const emptySourceInventory = H(options.storeKey, 'source-inventory', namespace, control.epoch, []);
    const emptyTargetInventory = H(options.storeKey, 'target-inventory', namespace, control.epoch, []);
    const emptyLogicalInventory = H(options.storeKey, 'logical-inventory', namespace, control.epoch, []);
    const emptyReceiptSet = D('receipt-set', namespace, control.epoch, []);

    if (prep.sourceInventoryDigest !== emptySourceInventory) {
      throw new CutoverFenceError('Empty namespace requires canonical empty sourceInventoryDigest');
    }
    if (prep.sourceLogicalDigest !== emptyLogicalInventory) {
      throw new CutoverFenceError('Empty namespace requires canonical empty sourceLogicalDigest');
    }
    if (finalDoc.targetInventoryDigest !== emptyTargetInventory) {
      throw new CutoverFenceError('Empty namespace requires canonical empty targetInventoryDigest');
    }
    if (finalDoc.receiptSetDigest !== emptyReceiptSet) {
      throw new CutoverFenceError('Empty namespace requires canonical empty receiptSetDigest');
    }
  } else {
    if (targetCountSum <= 0 && finalDoc.migrated > 0) {
      throw new CutoverFenceError('targetCounts sum must be greater than 0 for non-empty namespace');
    }
  }

  // Exact read strategy: query ALL 13 distinct collections once
  const distinctColNames = getCutoverDistinctCollectionNames(namespace).distinct;
  const rawColSnaps = new Map();

  for (const colName of distinctColNames) {
    const q = db.collection(colName).orderBy(docIdField);
    const snap = await transaction.get(q);
    rawColSnaps.set(colName, snap);
  }

  // Query receipts range
  const receiptsCol = db.collection(`${namespace}_meta`);
  const lowerBound = `migration_receipt_${control.epoch}_`;
  const upperBound = `migration_receipt_${control.epoch}\``;

  const receiptsQuery = receiptsCol
    .orderBy(docIdField)
    .startAt(lowerBound)
    .endBefore(upperBound);
  const receiptsSnap = await transaction.get(receiptsQuery);

  const actualReceipts = receiptsSnap.docs.map((d) => {
    const expectedPrefix = `migration_receipt_${control.epoch}_`;
    if (!d.id.startsWith(expectedPrefix)) {
      throw new CutoverFenceError(`Invalid receipt document ID: ${d.id}`);
    }
    const candidateIdSuffix = d.id.slice(expectedPrefix.length);
    const data = d.data();
    if (data.candidateId !== candidateIdSuffix) {
      throw new CutoverFenceError(
        `Receipt document ID suffix mismatch: expected ${candidateIdSuffix}, got ${data.candidateId}`,
      );
    }
    return data;
  });

  // Partition all 13 collections into normalized key buckets
  const sourcePhysicalToKey = {
    [`${namespace}_tokens_refresh_families`]: 'families',
    [`${namespace}_tokens`]: 'tokens',
    [`${namespace}_tokens_refresh`]: 'refresh',
    [`${namespace}_tokens_upstream`]: 'upstream',
    [`${namespace}_auth_codes`]: 'authCodes',
    [`${namespace}_resume_tokens`]: 'resumeTokens',
    [`${namespace}_oauth_clients`]: 'oauthClients',
    [`${namespace}_clients`]: 'clients',
  };

  const targetPhysicalToKey = {
    [`${namespace}_refresh_families`]: 'families',
    [`${namespace}_sessions`]: 'tokens',
    [`${namespace}_refresh`]: 'refresh',
    [`${namespace}_upstream`]: 'upstream',
    [`${namespace}_auth_codes`]: 'authCodes',
    [`${namespace}_resume_tokens`]: 'resumeTokens',
    [`${namespace}_retired_refresh`]: 'retiredRefreshTokens',
    [`${namespace}_oauth_clients`]: 'oauthClients',
  };

  const sourceDocsByKey = new Map();
  for (const k of PHYSICAL_COUNT_KEYS) sourceDocsByKey.set(k, []);

  const targetDocsByKey = new Map();
  for (const k of TARGET_COUNT_KEYS) targetDocsByKey.set(k, []);

  for (const [physicalName, snap] of rawColSnaps.entries()) {
    const isSourceCol = physicalName in sourcePhysicalToKey;
    const isTargetCol = physicalName in targetPhysicalToKey;

    if (isSourceCol && !isTargetCol) {
      const colKey = sourcePhysicalToKey[physicalName];
      sourceDocsByKey.set(colKey, snap.docs);
    } else if (isTargetCol && !isSourceCol) {
      const colKey = targetPhysicalToKey[physicalName];
      targetDocsByKey.set(colKey, snap.docs);
    } else if (isSourceCol && isTargetCol) {
      const sKey = sourcePhysicalToKey[physicalName];
      const tKey = targetPhysicalToKey[physicalName];
      for (const d of snap.docs) {
        if (isTargetFormatRow(physicalName, d.data(), d.id)) {
          targetDocsByKey.get(tKey).push(d);
        } else {
          sourceDocsByKey.get(sKey).push(d);
        }
      }
    }
  }

  // Build keyed maps for current state: validate ID and client_id per real collection schema
  const currentSourceKeyedMap = new Map();
  for (const [colKey, docs] of sourceDocsByKey.entries()) {
    for (const d of docs) {
      const data = d.data() || {};
      if ((colKey === 'families' || colKey === 'resumeTokens') && typeof data.id === 'string' && data.id !== d.id) {
        throw new CutoverFenceError(`Document ID mismatch in ${colKey}/${d.id}: stored id '${data.id}' != docId '${d.id}'`);
      }
      if ((colKey === 'oauthClients' || colKey === 'clients') && typeof data.client_id === 'string' && data.client_id !== d.id) {
        throw new CutoverFenceError(`client_id mismatch in ${colKey}/${d.id}: stored client_id '${data.client_id}' != docId '${d.id}'`);
      }
      const sourceId = computeKeyedDocId(options.storeKey, 'source-id', namespace, control.epoch, colKey, d.id);
      const recDigest = computeSourceRecordDigest(options.storeKey, namespace, control.epoch, colKey, sourceId, data);
      currentSourceKeyedMap.set(`${colKey}:${sourceId}`, { doc: d, rawId: d.id, recordDigest: recDigest, data: { ...data, id: d.id } });
    }
  }

  const currentTargetKeyedMap = new Map();
  const targetDescriptors = [];
  for (const [colKey, docs] of targetDocsByKey.entries()) {
    for (const d of docs) {
      const data = d.data() || {};
      if (colKey !== 'oauthClients' && colKey !== 'clients') {
        if (typeof data.id === 'string' && data.id !== d.id) {
          throw new CutoverFenceError(`Document ID mismatch in ${colKey}/${d.id}: stored id '${data.id}' != docId '${d.id}'`);
        }
      } else {
        if (typeof data.client_id === 'string' && data.client_id !== d.id) {
          throw new CutoverFenceError(`client_id mismatch in ${colKey}/${d.id}: stored client_id '${data.client_id}' != docId '${d.id}'`);
        }
      }
      const targetId = computeKeyedDocId(options.storeKey, 'target-id', namespace, control.epoch, colKey, d.id);
      const recDigest = computeTargetRecordDigest(options.storeKey, namespace, control.epoch, colKey, targetId, data);
      currentTargetKeyedMap.set(`${colKey}:${targetId}`, { doc: d, rawId: d.id, recordDigest: recDigest, data: { ...data, id: d.id } });
      targetDescriptors.push({ collection: colKey, id: targetId, recordDigest: recDigest });
    }
  }

  let writtenCount = 0;
  let retainedCount = 0;
  const receiptCandidateIds = new Set();
  const candidateMap = new Map(prep.candidateCommitments.map((c) => [c.id, c]));
  const expectedWrittenTargets = new Set();
  const retainedSources = new Set();

  for (const r of actualReceipts) {
    validateReceipt(r, namespace, control.epoch, control.migrationRunId);
    if (r.disposition === 'written') writtenCount++;
    if (r.disposition === 'retained') retainedCount++;

    if (receiptCandidateIds.has(r.candidateId)) {
      throw new CutoverFenceError(`Duplicate candidate receipt in finalization: ${r.candidateId}`);
    }
    receiptCandidateIds.add(r.candidateId);

    const c = candidateMap.get(r.candidateId);
    if (!c) {
      throw new CutoverFenceError(`Receipt candidateId '${r.candidateId}' does not match any committed candidate`);
    }

    if (r.preparedDigest !== computedPreparedDigest) {
      throw new CutoverFenceError(`Receipt preparedDigest mismatch for candidate ${r.candidateId}`);
    }
    const expectedCandDigest = D('candidate', namespace, control.epoch, c);
    if (r.candidateDigest !== expectedCandDigest) {
      throw new CutoverFenceError(`Receipt candidateDigest mismatch for candidate ${r.candidateId}`);
    }
    if (r.logicalDigest !== c.logicalDigest) {
      throw new CutoverFenceError(`Receipt logicalDigest mismatch for candidate ${r.candidateId}`);
    }

    // Exact reference set equality between receipt descriptors and candidate descriptors
    const rSourceKeys = r.sourceAfter.map((s) => `${s.collection}:${s.id}`).sort(canonicalCompare);
    const cSourceKeys = c.sources.map((s) => `${s.collection}:${s.id}`).sort(canonicalCompare);
    if (rSourceKeys.length !== cSourceKeys.length || !rSourceKeys.every((k, idx) => k === cSourceKeys[idx])) {
      throw new CutoverFenceError(`Receipt sourceAfter reference set mismatch for candidate ${r.candidateId}`);
    }

    const rTargetKeys = r.targetAfter.map((t) => `${t.collection}:${t.id}`).sort(canonicalCompare);
    const cTargetKeys = c.targets.map((t) => `${t.collection}:${t.id}`).sort(canonicalCompare);
    if (rTargetKeys.length !== cTargetKeys.length || !rTargetKeys.every((k, idx) => k === cTargetKeys[idx])) {
      throw new CutoverFenceError(`Receipt targetAfter reference set mismatch for candidate ${r.candidateId}`);
    }

    // Reconcile source after-state
    for (const s of r.sourceAfter) {
      const entry = currentSourceKeyedMap.get(`${s.collection}:${s.id}`);
      if (s.recordDigest === null) {
        if (entry) {
          throw new CutoverFenceError(`Source '${s.collection}:${s.id}' was marked deleted in receipt but still exists in Firestore`);
        }
      } else {
        if (!entry) {
          throw new CutoverFenceError(`Source '${s.collection}:${s.id}' was marked retained in receipt but does not exist in Firestore`);
        }
        if (entry.recordDigest !== s.recordDigest) {
          throw new CutoverFenceError(`Source '${s.collection}:${s.id}' recordDigest mismatch`);
        }
        retainedSources.add(`${s.collection}:${s.id}`);
      }
    }

    // Reconcile target after-state and postimages
    for (const t of r.targetAfter) {
      const targetKey = `${t.collection}:${t.id}`;
      expectedWrittenTargets.add(targetKey);

      const entry = currentTargetKeyedMap.get(targetKey);
      if (!entry) {
        throw new CutoverFenceError(`Missing target document '${targetKey}' in Firestore`);
      }
      if (entry.recordDigest !== t.recordDigest) {
        throw new CutoverFenceError(`Target document '${targetKey}' postimage recordDigest mismatch`);
      }
    }
  }

  // Reject extra sources in Firestore (every source document remaining in Firestore must be accounted for as retained in receipts)
  for (const sourceKey of currentSourceKeyedMap.keys()) {
    if (!retainedSources.has(sourceKey)) {
      throw new CutoverFenceError(`Extra source document '${sourceKey}' found in Firestore not accounted for as retained by receipts`);
    }
  }

  // Reject extra targets in Firestore target collections
  for (const targetKey of currentTargetKeyedMap.keys()) {
    if (!expectedWrittenTargets.has(targetKey)) {
      throw new CutoverFenceError(`Extra target document '${targetKey}' found in Firestore not accounted for by receipts`);
    }
  }

  // Provenance-bound graph projector: nonempty migrations execute reviewed separate module verified against measured bytes
  if (finalDoc.totalPhysicalRecords > 0) {
    if (finalDoc.projectorId !== prep.projectorId || finalDoc.projectorVersion !== prep.projectorVersion || finalDoc.projectorDigest !== prep.projectorDigest) {
      throw new CutoverFenceError('Final manifest projector identity or digest does not match prepared manifest');
    }
    if (markerDoc.projectorId !== finalDoc.projectorId || markerDoc.projectorVersion !== finalDoc.projectorVersion || markerDoc.projectorDigest !== finalDoc.projectorDigest) {
      throw new CutoverFenceError('Ownership marker projector identity or digest does not match final manifest');
    }

    const measuredProjectorDigest = getMeasuredProjectorDigest();
    if (finalDoc.projectorDigest !== measuredProjectorDigest) {
      throw new CutoverFenceError(
        `Projector digest mismatch: manifest has ${finalDoc.projectorDigest}, deployed module byte SHA-256 is ${measuredProjectorDigest}`,
      );
    }

    const codec = createCodec(options.storeKey);

    for (const r of actualReceipts) {
      const c = candidateMap.get(r.candidateId);
      const targetsMap = new Map();
      if (c.kind === 'pr56Families') {
        const famTarget = c.targets.find((t) => t.collection === 'families');
        let famData;
        if (famTarget) {
          const e = currentTargetKeyedMap.get(`${famTarget.collection}:${famTarget.id}`);
          if (e) {
            famData = { ...(e.data || {}), id: e.rawId };
            targetsMap.set('families', famData);
          }
        }
        const upTarget = c.targets.find((t) => t.collection === 'upstream');
        if (upTarget) {
          const e = currentTargetKeyedMap.get(`${upTarget.collection}:${upTarget.id}`);
          if (e) targetsMap.set('upstream', { ...(e.data || {}), id: e.rawId });
        }
        const sessTarget = c.targets.find((t) => t.collection === 'tokens');
        if (sessTarget) {
          const e = currentTargetKeyedMap.get(`${sessTarget.collection}:${sessTarget.id}`);
          if (e) targetsMap.set('tokens', { ...(e.data || {}), id: e.rawId });
        }
        const refreshTargets = c.targets.filter((t) => t.collection === 'refresh');
        for (const t of refreshTargets) {
          const e = currentTargetKeyedMap.get(`refresh:${t.id}`);
          if (e) {
            if (famData && (e.rawId === famData.activeRefreshId && e.data?.status === 'active')) {
              targetsMap.set('activeRefresh', { ...(e.data || {}), id: e.rawId });
            } else if (famData && (e.rawId !== famData.activeRefreshId && e.data?.status === 'consumed')) {
              targetsMap.set('prevRefresh', { ...(e.data || {}), id: e.rawId });
            }
          }
        }
        if (!targetsMap.has('activeRefresh')) {
          throw new CutoverFenceError(`Candidate ${c.id} missing active refresh target document matching activeRefreshId`);
        }
        if (famData && famData.previousRefreshToken && !targetsMap.has('prevRefresh')) {
          throw new CutoverFenceError(`Candidate ${c.id} has previousRefreshToken but missing prevRefresh target document`);
        }
        const retiredTargets = c.targets.filter((t) => t.collection === 'retiredRefreshTokens');
        const retiredIds = [];
        for (const t of retiredTargets) {
          const e = currentTargetKeyedMap.get(`retiredRefreshTokens:${t.id}`);
          if (!e) throw new CutoverFenceError(`Candidate ${c.id} missing retiredRefreshTokens target document in Firestore`);
          if (e.data?.familyId !== famData?.id) throw new CutoverFenceError(`Retired refresh token '${e.rawId}' familyId mismatch`);
          retiredIds.push(e.rawId);
        }
        targetsMap.set('retiredRefresh', { ids: retiredIds.sort(canonicalCompare) });
      } else if (c.kind === 'baseFormatTokens') {
        const famTarget = c.targets.find((t) => t.collection === 'families');
        if (famTarget) {
          const e = currentTargetKeyedMap.get(`${famTarget.collection}:${famTarget.id}`);
          if (e) targetsMap.set('families', { ...(e.data || {}), id: e.rawId });
        }
        const upTarget = c.targets.find((t) => t.collection === 'upstream');
        if (upTarget) {
          const e = currentTargetKeyedMap.get(`${upTarget.collection}:${upTarget.id}`);
          if (e) targetsMap.set('upstream', { ...(e.data || {}), id: e.rawId });
        }
        const sessTarget = c.targets.find((t) => t.collection === 'tokens');
        if (sessTarget) {
          const e = currentTargetKeyedMap.get(`${sessTarget.collection}:${sessTarget.id}`);
          if (e) targetsMap.set('tokens', { ...(e.data || {}), id: e.rawId });
        }
        const refTarget = c.targets.find((t) => t.collection === 'refresh');
        if (refTarget) {
          const e = currentTargetKeyedMap.get(`${refTarget.collection}:${refTarget.id}`);
          if (e) targetsMap.set('activeRefresh', { ...(e.data || {}), id: e.rawId });
        }
      } else if (c.kind === 'authCodes') {
        const codeTarget = c.targets.find((t) => t.collection === 'authCodes');
        if (codeTarget) {
          const e = currentTargetKeyedMap.get(`${codeTarget.collection}:${codeTarget.id}`);
          if (e) targetsMap.set('authCodes', { ...(e.data || {}), id: e.rawId });
        }
      } else if (c.kind === 'resumeTokens') {
        const resTarget = c.targets.find((t) => t.collection === 'resumeTokens');
        if (resTarget) {
          const e = currentTargetKeyedMap.get(`${resTarget.collection}:${resTarget.id}`);
          if (e) targetsMap.set('resumeTokens', { ...(e.data || {}), id: e.rawId });
        }
      } else if (c.kind === 'clients') {
        const clientTarget = c.targets.find((t) => t.collection === 'oauthClients' || t.collection === 'clients');
        if (clientTarget) {
          const e = currentTargetKeyedMap.get(`${clientTarget.collection}:${clientTarget.id}`);
          if (e) targetsMap.set('clients', { ...(e.data || {}), id: e.rawId });
        }
      }

      const targetResult = projectTargetLogical(c, targetsMap, codec);
      validateCandidateProjection(c.kind, r.candidateId, targetResult);
      const derivedTargetLogicalDigest = H(options.storeKey, 'logical-record', namespace, control.epoch, [c.kind, targetResult]);
      if (r.logicalDigest !== derivedTargetLogicalDigest) {
        throw new CutoverFenceError(
          `Receipt ${r.candidateId} logicalDigest mismatch with projector-derived target logical digest`,
        );
      }
    }
  }

  // Recompute and verify targetInventoryDigest from sorted exact descriptor objects
  const computedTargetInventory = computeTargetInventoryDigest(options.storeKey, namespace, control.epoch, targetDescriptors);
  if (finalDoc.targetInventoryDigest !== computedTargetInventory) {
    throw new CutoverFenceError('final manifest targetInventoryDigest does not match computed target inventory');
  }

  // Recompute and verify targetLogicalDigest
  const sortedReceiptLogicalPairs = actualReceipts
    .map((r) => [r.candidateId, r.logicalDigest])
    .sort((a, b) => canonicalCompare(a[0], b[0]));
  const computedTargetLogical = H(options.storeKey, 'logical-inventory', namespace, control.epoch, sortedReceiptLogicalPairs);
  if (finalDoc.targetLogicalDigest !== computedTargetLogical) {
    throw new CutoverFenceError('final manifest targetLogicalDigest does not match computed logical inventory');
  }

  // Verify target collection counts match finalDoc
  for (const k of TARGET_COUNT_KEYS) {
    const actualCount = targetDocsByKey.get(k).length;
    if (actualCount !== finalDoc.targetCounts[k]) {
      throw new CutoverFenceError(
        `Target count mismatch on finalization for '${k}': Firestore has ${actualCount}, finalDoc has ${finalDoc.targetCounts[k]}`,
      );
    }
  }

  if (finalDoc.migrated !== writtenCount) {
    throw new CutoverFenceError(`migrated count mismatch: finalDoc has ${finalDoc.migrated}, receipts have ${writtenCount}`);
  }
  if (finalDoc.skipped !== retainedCount) {
    throw new CutoverFenceError(`skipped count mismatch: finalDoc has ${finalDoc.skipped}, receipts have ${retainedCount}`);
  }
  if (finalDoc.scanned !== finalDoc.migrated + finalDoc.skipped) {
    throw new CutoverFenceError('Cannot finalize migration: final scanned must equal migrated + skipped');
  }
  if (actualReceipts.length !== prep.scanned) {
    throw new CutoverFenceError(`receipts count (${actualReceipts.length}) does not equal scanned (${prep.scanned})`);
  }

  const computedReceiptSetDigest = computeReceiptSetDigest(actualReceipts, namespace, control.epoch);
  if (finalDoc.receiptSetDigest !== computedReceiptSetDigest) {
    throw new CutoverFenceError(
      `receiptSetDigest mismatch: expected ${finalDoc.receiptSetDigest}, computed ${computedReceiptSetDigest}`,
    );
  }

  for (const c of prep.candidateCommitments) {
    if (!receiptCandidateIds.has(c.id)) {
      throw new CutoverFenceError(`Missing receipt for committed candidate ${c.id}`);
    }
  }

  const finalRef = db.collection(`${namespace}_meta`).doc(`migration_manifest_${control.epoch}`);
  const markerRef = db.collection(`${namespace}_meta`).doc('v2_adopted');

  const finalSnap = await transaction.get(finalRef);
  if (finalSnap.exists && C(finalSnap.data()) !== C(finalDoc)) {
    throw new CutoverFenceError('Final manifest already exists with different content; immutable retry violation');
  }
  const markerSnap = await transaction.get(markerRef);
  if (markerSnap.exists && C(markerSnap.data()) !== C(markerDoc)) {
    throw new CutoverFenceError('Ownership marker already exists with different content; immutable retry violation');
  }

  timer.assertUnderDeadline('finalizeMigrationInTransaction reads and verification');
  transaction.set(finalRef, stripUndefined(finalDoc));
  transaction.set(markerRef, stripUndefined(markerDoc));

  const controlRef = getCutoverFenceDocRef(db, namespace);
  const updatedControl = {
    ...control,
    state: 'v3_ready',
    emptyNamespace: markerDoc.emptyNamespace,
    migrationManifestDigest: markerDoc.migrationManifestDigest,
    irreversible: markerDoc.emptyNamespace === true ? false : control.irreversible,
    updatedAt: markerDoc.adoptedAt,
  };
  transaction.set(controlRef, stripUndefined(updatedControl));
  timer.assertUnderDeadline('finalizeMigrationInTransaction complete');
  return updatedControl;
}

export async function activateMigrationInTransaction(transaction, db, options) {
  const timer = startMonotonicTimer();
  const { namespace, expectedEpoch, migrationRunId, migrationManifestDigest, codeArtifact, protocolDigest } = options;
  assertSupportedCutoverNamespace(namespace);

  if (!options.storeKey || (typeof options.storeKey !== 'string' && !Buffer.isBuffer(options.storeKey) && !(options.storeKey instanceof Uint8Array))) {
    throw new CutoverFenceError('storeKey is REQUIRED for activateMigrationInTransaction');
  }

  const control = await readCutoverFenceInTransaction(transaction, db, namespace);

  // FieldPath adapter is REQUIRED (no __name__ fallback)
  const FieldPath = options.FieldPath;
  if (!FieldPath || typeof FieldPath.documentId !== 'function') {
    throw new CutoverFenceError('FieldPath with documentId() is REQUIRED for activateMigrationInTransaction');
  }
  const docIdField = FieldPath.documentId();

  // Idempotent retry check on full immutable chain only (never mutable data collections)
  if (control.state === 'v3_active') {
    if (control.epoch !== expectedEpoch) {
      throw new CutoverFenceError(`Activation epoch mismatch: expected ${expectedEpoch}, got ${control.epoch}`);
    }
    if (control.migrationRunId !== migrationRunId) {
      throw new CutoverFenceError(
        `Already active control migrationRunId mismatch: expected ${migrationRunId}, got ${control.migrationRunId}`,
      );
    }
    if (control.migrationManifestDigest !== migrationManifestDigest) {
      throw new CutoverFenceError(
        `Already active control migrationManifestDigest mismatch: expected ${migrationManifestDigest}, got ${control.migrationManifestDigest}`,
      );
    }
    if (control.codeArtifact !== codeArtifact) {
      throw new CutoverFenceError(
        `Already active control codeArtifact mismatch: expected ${codeArtifact}, got ${control.codeArtifact}`,
      );
    }

    const markerRef = db.collection(`${namespace}_meta`).doc('v2_adopted');
    const markerSnap = await transaction.get(markerRef);
    if (!markerSnap.exists) {
      throw new CutoverFenceError('Already active but immutable migration marker is missing at v2_adopted');
    }
    const m = markerSnap.data();
    const expectedMarkerKeys = m.emptyNamespace !== true
      ? [...REQUIRED_OWNERSHIP_MARKER_KEYS, ...NONEMPTY_PROJECTOR_KEYS]
      : REQUIRED_OWNERSHIP_MARKER_KEYS;
    validateMapKeysExact(m, expectedMarkerKeys, 'ownership marker');
    validateMigrationIdentityFields(m, namespace, expectedEpoch, migrationRunId);
    if (m.kind !== 'ownership') {
      throw new CutoverFenceError(`Already active marker kind must be 'ownership', got '${m.kind}'`);
    }
    if (m.codeArtifact !== codeArtifact || m.protocolDigest !== protocolDigest || m.migrationManifestDigest !== migrationManifestDigest) {
      throw new CutoverFenceError('Already active immutable marker evidence mismatch');
    }

    const finalRef = db.collection(`${namespace}_meta`).doc(`migration_manifest_${expectedEpoch}`);
    const finalSnap = await transaction.get(finalRef);
    if (!finalSnap.exists) {
      throw new CutoverFenceError(`Already active but immutable final manifest missing at migration_manifest_${expectedEpoch}`);
    }
    const f = finalSnap.data();
    const expectedFinalKeys = f.totalPhysicalRecords > 0
      ? [...REQUIRED_FINAL_MANIFEST_KEYS, ...NONEMPTY_PROJECTOR_KEYS]
      : REQUIRED_FINAL_MANIFEST_KEYS;
    validateMapKeysExact(f, expectedFinalKeys, 'final manifest');
    validateMigrationIdentityFields(f, namespace, expectedEpoch, migrationRunId);
    if (f.kind !== 'final') {
      throw new CutoverFenceError(`Already active final manifest kind must be 'final', got '${f.kind}'`);
    }
    if (f.codeArtifact !== codeArtifact || f.protocolDigest !== protocolDigest || D('final', namespace, expectedEpoch, f) !== migrationManifestDigest) {
      throw new CutoverFenceError('Already active immutable final manifest evidence mismatch');
    }

    const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${expectedEpoch}`);
    const prepSnap = await transaction.get(prepRef);
    if (!prepSnap.exists) {
      throw new CutoverFenceError(`Already active but immutable prepared manifest missing at migration_prepared_${expectedEpoch}`);
    }
    const p = prepSnap.data();
    const expectedPrepKeys = p.totalPhysicalRecords > 0
      ? [...REQUIRED_PREPARED_MANIFEST_KEYS, ...NONEMPTY_PROJECTOR_KEYS]
      : REQUIRED_PREPARED_MANIFEST_KEYS;
    validateMapKeysExact(p, expectedPrepKeys, 'prepared manifest');
    validateMigrationIdentityFields(p, namespace, expectedEpoch, migrationRunId);
    if (p.kind !== 'prepared') {
      throw new CutoverFenceError(`Already active prep manifest kind must be 'prepared', got '${p.kind}'`);
    }
    if (D('prepared', namespace, expectedEpoch, p) !== f.preparedDigest) {
      throw new CutoverFenceError('Already active immutable prep manifest digest mismatch');
    }

    if (f.totalPhysicalRecords > 0) {
      if (m.projectorId !== f.projectorId || m.projectorVersion !== f.projectorVersion || m.projectorDigest !== f.projectorDigest) {
        throw new CutoverFenceError('Already active marker projector evidence mismatch with final manifest');
      }
      if (p.projectorId !== f.projectorId || p.projectorVersion !== f.projectorVersion || p.projectorDigest !== f.projectorDigest) {
        throw new CutoverFenceError('Already active prep projector evidence mismatch with final manifest');
      }
    }

    // Verify receipts range immutable chain
    const receiptsCol = db.collection(`${namespace}_meta`);
    const lowerBound = `migration_receipt_${expectedEpoch}_`;
    const upperBound = `migration_receipt_${expectedEpoch}\``;
    const receiptsSnap = await transaction.get(receiptsCol.orderBy(docIdField).startAt(lowerBound).endBefore(upperBound));
    if (receiptsSnap.size !== p.scanned) {
      throw new CutoverFenceError(`Already active receipts count (${receiptsSnap.size}) does not equal scanned count (${p.scanned})`);
    }
    const receipts = receiptsSnap.docs.map((d) => {
      const data = d.data();
      validateReceipt(data, namespace, expectedEpoch, migrationRunId);
      return data;
    });
    if (computeReceiptSetDigest(receipts, namespace, expectedEpoch) !== f.receiptSetDigest) {
      throw new CutoverFenceError('Already active immutable receiptSetDigest mismatch');
    }

    return { status: 'already_active', control };
  }

  const markerRef = db.collection(`${namespace}_meta`).doc('v2_adopted');
  const markerSnap = await transaction.get(markerRef);
  if (!markerSnap.exists) {
    throw new CutoverFenceError(`Cannot activate: marker missing at ${namespace}_meta/v2_adopted`);
  }
  const m = markerSnap.data();
  const expectedMarkerKeys = m.emptyNamespace !== true
    ? [...REQUIRED_OWNERSHIP_MARKER_KEYS, ...NONEMPTY_PROJECTOR_KEYS]
    : REQUIRED_OWNERSHIP_MARKER_KEYS;
  validateMapKeysExact(m, expectedMarkerKeys, 'ownership marker');
  validateMigrationIdentityFields(m, namespace, expectedEpoch, migrationRunId);
  if (m.kind !== 'ownership') {
    throw new CutoverFenceError(`marker kind must be 'ownership', got '${m.kind}'`);
  }
  if (m.codeArtifact !== codeArtifact) {
    throw new CutoverFenceError(`Cannot activate: marker codeArtifact mismatch: expected ${codeArtifact}, got ${m.codeArtifact}`);
  }
  if (m.protocolDigest !== protocolDigest) {
    throw new CutoverFenceError(`Cannot activate: marker protocolDigest mismatch: expected ${protocolDigest}, got ${m.protocolDigest}`);
  }
  if (m.migrationManifestDigest !== migrationManifestDigest) {
    throw new CutoverFenceError('Cannot activate: marker migrationManifestDigest mismatch');
  }

  const finalRef = db.collection(`${namespace}_meta`).doc(`migration_manifest_${expectedEpoch}`);
  const finalSnap = await transaction.get(finalRef);
  if (!finalSnap.exists) {
    throw new CutoverFenceError(`Cannot activate: final manifest missing at ${namespace}_meta/migration_manifest_${expectedEpoch}`);
  }
  const f = finalSnap.data();
  const expectedFinalKeys = f.totalPhysicalRecords > 0
    ? [...REQUIRED_FINAL_MANIFEST_KEYS, ...NONEMPTY_PROJECTOR_KEYS]
    : REQUIRED_FINAL_MANIFEST_KEYS;
  validateMapKeysExact(f, expectedFinalKeys, 'final manifest');
  validateMigrationIdentityFields(f, namespace, expectedEpoch, migrationRunId);
  if (f.kind !== 'final') {
    throw new CutoverFenceError(`Final manifest kind must be 'final', got '${f.kind}'`);
  }
  if (f.codeArtifact !== codeArtifact || f.protocolDigest !== protocolDigest) {
    throw new CutoverFenceError('Cannot activate: final manifest codeArtifact or protocolDigest mismatch');
  }
  const computedFinalDigest = D('final', namespace, expectedEpoch, f);
  if (computedFinalDigest !== migrationManifestDigest) {
    throw new CutoverFenceError(
      `Cannot activate: computed final digest (${computedFinalDigest}) does not match expected (${migrationManifestDigest})`,
    );
  }

  const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${expectedEpoch}`);
  const prepSnap = await transaction.get(prepRef);
  if (!prepSnap.exists) {
    throw new CutoverFenceError(`Cannot activate: prepared manifest missing at ${namespace}_meta/migration_prepared_${expectedEpoch}`);
  }
  const p = prepSnap.data();
  const expectedPrepKeys = p.totalPhysicalRecords > 0
    ? [...REQUIRED_PREPARED_MANIFEST_KEYS, ...NONEMPTY_PROJECTOR_KEYS]
    : REQUIRED_PREPARED_MANIFEST_KEYS;
  validateMapKeysExact(p, expectedPrepKeys, 'prepared manifest');
  validateMigrationIdentityFields(p, namespace, expectedEpoch, migrationRunId);
  if (p.kind !== 'prepared') {
    throw new CutoverFenceError(`Prepared manifest kind must be 'prepared', got '${p.kind}'`);
  }
  const computedPrepDigest = D('prepared', namespace, expectedEpoch, p);
  if (computedPrepDigest !== f.preparedDigest) {
    throw new CutoverFenceError('Cannot activate: prepared digest does not match final manifest preparedDigest');
  }

  if (f.totalPhysicalRecords > 0) {
    if (m.projectorId !== f.projectorId || m.projectorVersion !== f.projectorVersion || m.projectorDigest !== f.projectorDigest) {
      throw new CutoverFenceError('Marker projector evidence mismatch with final manifest');
    }
    if (p.projectorId !== f.projectorId || p.projectorVersion !== f.projectorVersion || p.projectorDigest !== f.projectorDigest) {
      throw new CutoverFenceError('Prepared manifest projector evidence mismatch with final manifest');
    }
  }

  // Reread receipt set range in Firestore to verify readiness before activation
  const receiptsCol = db.collection(`${namespace}_meta`);
  const lowerBound = `migration_receipt_${expectedEpoch}_`;
  const upperBound = `migration_receipt_${expectedEpoch}\``;

  const receiptsQuery = receiptsCol.orderBy(docIdField).startAt(lowerBound).endBefore(upperBound);
  const receiptsSnap = await transaction.get(receiptsQuery);
  if (receiptsSnap.size !== p.scanned) {
    throw new CutoverFenceError(
      `Cannot activate: receipt count (${receiptsSnap.size}) does not equal prepared scanned count (${p.scanned})`,
    );
  }

  // Validate each receipt in range and recompute receiptSetDigest
  const activateReceipts = receiptsSnap.docs.map((d) => {
    const data = d.data();
    validateReceipt(data, namespace, expectedEpoch, migrationRunId);
    return data;
  });
  const computedRSD = computeReceiptSetDigest(activateReceipts, namespace, expectedEpoch);
  if (f.receiptSetDigest !== computedRSD) {
    throw new CutoverFenceError(
      `Cannot activate: receiptSetDigest mismatch in Firestore receipts`,
    );
  }

  // Query ALL 13 distinct collections using FieldPath.documentId()
  const distinctColNames = getCutoverDistinctCollectionNames(namespace).distinct;
  const rawColSnaps = new Map();

  for (const colName of distinctColNames) {
    const q = db.collection(colName).orderBy(docIdField);
    const snap = await transaction.get(q);
    rawColSnaps.set(colName, snap);
  }

  const targetPhysicalToKey = {
    [`${namespace}_refresh_families`]: 'families',
    [`${namespace}_sessions`]: 'tokens',
    [`${namespace}_refresh`]: 'refresh',
    [`${namespace}_upstream`]: 'upstream',
    [`${namespace}_auth_codes`]: 'authCodes',
    [`${namespace}_resume_tokens`]: 'resumeTokens',
    [`${namespace}_retired_refresh`]: 'retiredRefreshTokens',
    [`${namespace}_oauth_clients`]: 'oauthClients',
  };

  const targetDocsByKey = new Map();
  for (const k of TARGET_COUNT_KEYS) targetDocsByKey.set(k, []);

  for (const [physicalName, snap] of rawColSnaps.entries()) {
    if (physicalName in targetPhysicalToKey) {
      const colKey = targetPhysicalToKey[physicalName];
      const isOverlap = physicalName.endsWith('_auth_codes') || physicalName.endsWith('_resume_tokens') || physicalName.endsWith('_oauth_clients');
      if (isOverlap) {
        for (const d of snap.docs) {
          if (isTargetFormatRow(physicalName, d.data(), d.id)) {
            targetDocsByKey.get(colKey).push(d);
          }
        }
      } else {
        targetDocsByKey.set(colKey, snap.docs);
      }
    }
  }

  const currentTargetKeyedMap = new Map();
  for (const [colKey, docs] of targetDocsByKey.entries()) {
    for (const d of docs) {
      const data = d.data() || {};
      if (colKey !== 'oauthClients' && colKey !== 'clients') {
        if (typeof data.id === 'string' && data.id !== d.id) {
          throw new CutoverFenceError(`Document ID mismatch in ${colKey}/${d.id}: stored id '${data.id}' != docId '${d.id}'`);
        }
      } else {
        if (typeof data.client_id === 'string' && data.client_id !== d.id) {
          throw new CutoverFenceError(`client_id mismatch in ${colKey}/${d.id}: stored client_id '${data.client_id}' != docId '${d.id}'`);
        }
      }
      const targetId = computeKeyedDocId(options.storeKey, 'target-id', namespace, expectedEpoch, colKey, d.id);
      const recDigest = computeTargetRecordDigest(options.storeKey, namespace, expectedEpoch, colKey, targetId, data);
      currentTargetKeyedMap.set(`${colKey}:${targetId}`, { doc: d, rawId: d.id, recordDigest: recDigest, data: { ...data, id: d.id } });
    }
  }

  // Verify that all targets from receipts exist in target collections with matching postimage
  const expectedWrittenTargets = new Set();
  for (const r of activateReceipts) {
    for (const t of r.targetAfter) {
      const targetKey = `${t.collection}:${t.id}`;
      expectedWrittenTargets.add(targetKey);
      const entry = currentTargetKeyedMap.get(targetKey);
      if (!entry) {
        throw new CutoverFenceError(`Cannot activate: target document '${targetKey}' missing from Firestore`);
      }
      if (entry.recordDigest !== t.recordDigest) {
        throw new CutoverFenceError(`Cannot activate: target document '${targetKey}' postimage recordDigest mismatch`);
      }
    }
  }

  // Reject extra targets
  for (const targetKey of currentTargetKeyedMap.keys()) {
    if (!expectedWrittenTargets.has(targetKey)) {
      throw new CutoverFenceError(`Cannot activate: extra target document '${targetKey}' found in Firestore`);
    }
  }

  // Check target counts
  for (const k of TARGET_COUNT_KEYS) {
    const actualCount = targetDocsByKey.get(k).length;
    if (actualCount !== f.targetCounts[k]) {
      throw new CutoverFenceError(
        `Cannot activate: target count mismatch for '${k}': Firestore has ${actualCount}, finalDoc has ${f.targetCounts[k]}`,
      );
    }
  }

  // Verify readiness equations
  if (f.errors !== 0) {
    throw new CutoverFenceError('Cannot activate: final manifest errors must be 0');
  }
  for (const [rK, rV] of Object.entries(f.reasons)) {
    if (rV !== 0) {
      throw new CutoverFenceError(`Cannot activate: final manifest reason '${rK}' must be 0, got ${rV}`);
    }
  }
  if (f.sourceLogicalDigest !== f.targetLogicalDigest) {
    throw new CutoverFenceError('Cannot activate: sourceLogicalDigest must equal targetLogicalDigest');
  }
  if (C(f.targetCounts) !== C(p.expectedTargetCounts)) {
    throw new CutoverFenceError('Cannot activate: final targetCounts must match prepared expectedTargetCounts');
  }

  if (control.state !== 'v3_ready') {
    throw new CutoverFenceError(`Cannot activate migration: state must be 'v3_ready', got '${control.state}'`);
  }
  if (control.activeOperations !== 0) {
    throw new CutoverFenceError(`Cannot activate migration: activeOperations must be 0, got ${control.activeOperations}`);
  }
  if (control.emptyNamespace !== true && !control.irreversible) {
    throw new CutoverFenceError('Cannot activate migration: irreversible latch must be true for non-empty namespace');
  }
  if (control.epoch !== expectedEpoch) {
    throw new CutoverFenceError(`Activation epoch mismatch: expected ${expectedEpoch}, got ${control.epoch}`);
  }
  if (control.migrationRunId !== migrationRunId) {
    throw new CutoverFenceError(`Activation runId mismatch: expected ${migrationRunId}, got ${control.migrationRunId}`);
  }
  if (control.migrationManifestDigest !== migrationManifestDigest) {
    throw new CutoverFenceError(
      `Activation digest mismatch: expected ${migrationManifestDigest}, got ${control.migrationManifestDigest}`,
    );
  }

  timer.assertUnderDeadline('activateMigrationInTransaction reads and verification');
  const controlRef = getCutoverFenceDocRef(db, namespace);
  const updatedControl = {
    ...control,
    state: 'v3_active',
    epoch: control.epoch,
    emptyNamespace: control.emptyNamespace,
    irreversible: control.emptyNamespace === true ? false : control.irreversible,
    codeArtifact,
    codeSha: m.codeSha,
    updatedAt: Date.now(),
  };
  transaction.set(controlRef, stripUndefined(updatedControl));
  timer.assertUnderDeadline('activateMigrationInTransaction complete');
  return { status: 'activated', control: updatedControl };
}

export function assertValidMigrationContext(options) {
  if (!options || typeof options !== 'object') {
    throw new CutoverFenceError('MigrationContext must be a non-null object');
  }
  const REQUIRED_CONTEXT_FIELDS = [
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
  for (const field of REQUIRED_CONTEXT_FIELDS) {
    if (options[field] === undefined || options[field] === null) {
      throw new CutoverFenceError(`MigrationContext missing required field: ${field}`);
    }
  }
  if (typeof options.db !== 'object' || typeof options.db.collection !== 'function' || typeof options.db.runTransaction !== 'function') {
    throw new CutoverFenceError('MigrationContext db must be a Firestore-like object with collection and runTransaction methods');
  }
  if (typeof options.FieldPath !== 'object' || typeof options.FieldPath.documentId !== 'function') {
    throw new CutoverFenceError('MigrationContext FieldPath must be an adapter object with documentId() method');
  }
  if (!Buffer.isBuffer(options.key) && !(options.key instanceof Uint8Array)) {
    throw new CutoverFenceError('MigrationContext key must be a Uint8Array or Buffer');
  }
  if (options.key.length < 16) {
    throw new CutoverFenceError('MigrationContext key must be at least 16 bytes');
  }
  assertSupportedCutoverNamespace(options.namespace);
  if (typeof options.expectedEpoch !== 'number' || !Number.isInteger(options.expectedEpoch) || options.expectedEpoch < 1) {
    throw new CutoverFenceError('MigrationContext expectedEpoch must be a positive integer');
  }
  if (typeof options.migrationRunId !== 'string' || !options.migrationRunId.trim()) {
    throw new CutoverFenceError('MigrationContext migrationRunId must be a non-empty string');
  }
  if (typeof options.codeSha !== 'string' || !/^[0-9a-f]{40}$/.test(options.codeSha)) {
    throw new CutoverFenceError('MigrationContext codeSha must be a 40-character lowercase hex string');
  }
  if (typeof options.codeArtifact !== 'string' || !options.codeArtifact.trim()) {
    throw new CutoverFenceError('MigrationContext codeArtifact must be a non-empty string');
  }
  if (typeof options.packageIntegrity !== 'string' || !options.packageIntegrity.trim()) {
    throw new CutoverFenceError('MigrationContext packageIntegrity must be a non-empty string');
  }
  if (typeof options.protocolDigest !== 'string' || !/^[0-9a-f]{64}$/.test(options.protocolDigest)) {
    throw new CutoverFenceError('MigrationContext protocolDigest must be a 64-character lowercase hex string');
  }
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
      throw new CutoverFenceError(`Unknown option '${k}' passed to inspectFirestoreLegacyMigration`);
    }
  }
  throw new CutoverFenceError('inspectFirestoreLegacyMigration requires integration with S3 migration engine plan constructor');
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
      throw new CutoverFenceError(`Unknown option '${k}' passed to adoptFirestoreLegacyTokens`);
    }
  }

  if (typeof options.dryRun !== 'boolean') {
    throw new CutoverFenceError('adoptFirestoreLegacyTokens requires boolean dryRun option');
  }
  if (typeof options.expectedSourceInventoryDigest !== 'string' || !/^[0-9a-f]{64}$/.test(options.expectedSourceInventoryDigest)) {
    throw new CutoverFenceError('adoptFirestoreLegacyTokens requires 64-character lowercase hex expectedSourceInventoryDigest');
  }

  throw new CutoverFenceError('adoptFirestoreLegacyTokens requires integration with bundled S3 migration engine; fake success prohibited');
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
  ]);
  for (const k of Object.keys(options)) {
    if (!allowedKeys.has(k)) {
      throw new CutoverFenceError(`Unknown option '${k}' passed to activateFirestoreMigration`);
    }
  }

  return await options.db.runTransaction(async (transaction) => {
    const finalRef = options.db.collection(`${options.namespace}_meta`).doc(`migration_manifest_${options.expectedEpoch}`);
    const finalSnap = await transaction.get(finalRef);
    if (!finalSnap.exists) {
      throw new CutoverFenceError(`Final migration manifest missing at migration_manifest_${options.expectedEpoch}`);
    }
    const finalDoc = finalSnap.data();
    const migrationManifestDigest = D('final', options.namespace, options.expectedEpoch, finalDoc);

    const res = await activateMigrationInTransaction(transaction, options.db, {
      ...options,
      storeKey: options.key,
      migrationManifestDigest,
    });
    return { status: res.status };
  });
}

export async function getFirestoreMigrationStatus(options) {
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
      throw new CutoverFenceError(`Unknown option '${k}' passed to getFirestoreMigrationStatus`);
    }
  }

  const { db, namespace, expectedEpoch, migrationRunId, codeArtifact, protocolDigest } = options;
  const docRef = getCutoverFenceDocRef(db, namespace);
  const snap = await docRef.get();
  if (!snap.exists) {
    throw new CutoverFenceError(`Cutover fence control record missing for namespace '${namespace}'`);
  }
  const control = parseCutoverFenceRecord(snap.data(), namespace);

  // If in v3_ready or v3_active, validate immutable evidence
  if (control.state === 'v3_ready' || control.state === 'v3_active') {
    if (control.epoch !== expectedEpoch) {
      throw new CutoverFenceError(`Status epoch mismatch: expected ${expectedEpoch}, got ${control.epoch}`);
    }
    const markerRef = db.collection(`${namespace}_meta`).doc('v2_adopted');
    const markerSnap = await markerRef.get();
    if (!markerSnap.exists) {
      throw new CutoverFenceError('Immutable migration marker missing at v2_adopted');
    }
    const marker = markerSnap.data();
    validateMigrationIdentityFields(marker, namespace, expectedEpoch, migrationRunId);
    if (marker.codeArtifact !== codeArtifact || marker.protocolDigest !== protocolDigest) {
      throw new CutoverFenceError('Immutable migration marker artifact/protocolDigest mismatch');
    }
  }

  return control;
}
