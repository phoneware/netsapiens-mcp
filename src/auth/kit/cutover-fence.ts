
export class CutoverFenceError extends Error {
  readonly kitCode = "cutover_fence_error";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CutoverFenceError";
  }
}

export class CutoverRefusedError extends Error {
  readonly kitCode = "cutover_refused";
  readonly retryAfterSeconds: number;
  readonly cutoverState?: string;
  readonly epoch?: number;

  constructor(
    message: string = "Cutover in progress; operation temporarily unavailable",
    options?: { cause?: unknown; retryAfterSeconds?: number; cutoverState?: string; epoch?: number },
  ) {
    super(message, options);
    this.name = "CutoverRefusedError";
    this.retryAfterSeconds = options?.retryAfterSeconds ?? 30;
    this.cutoverState = options?.cutoverState;
    this.epoch = options?.epoch;
  }
}

export function isCutoverFenceError(err: unknown): err is CutoverFenceError {
  return Boolean(
    err &&
      typeof err === 'object' &&
      (err as any).kitCode === 'cutover_fence_error',
  );
}

export function isCutoverRefusedError(err: unknown): err is CutoverRefusedError {
  return Boolean(
    err &&
      typeof err === 'object' &&
      (err as any).kitCode === 'cutover_refused',
  );
}
export function stripUndefined<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(stripUndefined) as unknown as T;
  if (typeof value === "object" && !(value instanceof Date)) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      if (v !== undefined) out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}

import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { FirestoreLike } from '../../store/firestore.js';

export const PHYSICAL_COUNT_KEYS = [
  'families',
  'tokens',
  'refresh',
  'upstream',
  'authCodes',
  'resumeTokens',
  'oauthClients',
  'clients',
] as const;

export const TARGET_COUNT_KEYS = [
  'families',
  'tokens',
  'refresh',
  'upstream',
  'authCodes',
  'resumeTokens',
  'retiredRefreshTokens',
  'oauthClients',
] as const;

export const CLASSIFICATION_KEYS = [
  'pr56Families',
  'baseFormatTokens',
  'authCodes',
  'resumeTokens',
  'clients',
] as const;

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
] as const;

export const REQUIRED_IDENTITY_KEYS = [
  'schemaVersion',
  'namespace',
  'epoch',
  'migrationRunId',
  'codeSha',
  'codeArtifact',
  'packageIntegrity',
  'protocolDigest',
] as const;

export const REQUIRED_OWNERSHIP_MARKER_KEYS = [
  ...REQUIRED_IDENTITY_KEYS,
  'kind',
  'preparedDigest',
  'migrationManifestDigest',
  'emptyNamespace',
  'adoptedAt',
] as const;

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
] as const;

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
] as const;

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
] as const;

export function validateNoLoneSurrogates(str: string): void {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= str.length) {
        throw new CutoverFenceError(`Invalid lone high surrogate at index ${i}`);
      }
      const next = str.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new CutoverFenceError(`Invalid lone high surrogate at index ${i}`);
      }
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CutoverFenceError(`Invalid lone low surrogate at index ${i}`);
    }
  }
}

export function normalizeValue(val: unknown): unknown[] {
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
    typeof (val as any).toMillis === 'function' &&
    typeof (val as any).seconds === 'number' &&
    typeof (val as any).nanoseconds === 'number'
  ) {
    const ts = val as { seconds: number; nanoseconds: number };
    if (
      !Number.isSafeInteger(ts.seconds) ||
      !Number.isSafeInteger(ts.nanoseconds) ||
      ts.nanoseconds < 0 ||
      ts.nanoseconds >= 1_000_000_000
    ) {
      throw new CutoverFenceError('Invalid Firestore Timestamp field ranges');
    }
    return ['timestamp', String(ts.seconds), ts.nanoseconds];
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
    const keys = Object.keys(val).sort();
    return ['map', keys.map((k) => {
      validateNoLoneSurrogates(k);
      return [k, normalizeValue((val as Record<string, unknown>)[k])];
    })];
  }
  throw new CutoverFenceError(`Unsupported type for canonical normalization: ${typeof val}`);
}

export function rfc8785CanonicalJson(val: unknown): string {
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
    const keys = Object.keys(val).sort();
    return '{' + keys.map((k) => {
      validateNoLoneSurrogates(k);
      return JSON.stringify(k) + ':' + rfc8785CanonicalJson((val as Record<string, unknown>)[k]);
    }).join(',') + '}';
  }
  throw new CutoverFenceError(`Unsupported type for canonical JSON: ${typeof val}`);
}

export function C(value: unknown): string {
  return rfc8785CanonicalJson(normalizeValue(value));
}

export function canonicalJsonStringify(val: unknown): string {
  return C(val);
}

export function deriveKey(storeKey: string | Uint8Array): Buffer {
  const rawKey = typeof storeKey === 'string' ? Buffer.from(storeKey, 'utf8') : storeKey;
  return createHmac('sha256', rawKey).update(Buffer.from('netsapiens-mcp/cutover/v2', 'utf8')).digest();
}

export function frame(purpose: string, namespace: string, epoch: number, value: unknown): string {
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

export function D(purpose: string, namespace: string, epoch: number, value: unknown): string {
  const payload = frame(purpose, namespace, epoch, value);
  return createHash('sha256').update(Buffer.from(payload, 'utf8')).digest('hex');
}

export function H(storeKey: string | Uint8Array, purpose: string, namespace: string, epoch: number, value: unknown): string {
  const K = deriveKey(storeKey);
  const payload = frame(purpose, namespace, epoch, value);
  return createHmac('sha256', K).update(Buffer.from(payload, 'utf8')).digest('hex');
}

export function computeManifestDigest(manifest: any): string {
  if (!manifest || typeof manifest !== 'object') {
    throw new CutoverFenceError('Manifest must be an object');
  }
  const namespace = manifest.namespace;
  const epoch = manifest.epoch;
  return D('final', namespace, epoch, manifest);
}

export function computeProtocolDigest(moduleSource: string | Uint8Array): string {
  return createHash('sha256')
    .update(typeof moduleSource === 'string' ? Buffer.from(moduleSource, 'utf8') : moduleSource)
    .digest('hex');
}

export const FIRESTORE_MAX_DOCUMENT_SIZE_BYTES = 1_048_576;
export const FIRESTORE_MAX_REQUEST_SIZE_BYTES = 10_485_760;
export const FIRESTORE_MAX_INDEX_ENTRIES = 40_000;
export const FIRESTORE_MAX_INDEX_BYTES = 8_388_608;
export const FIRESTORE_MAX_NESTING_DEPTH = 20;
export const FIRESTORE_MAX_FIELD_TRANSFORMS = 500;
export const FIRESTORE_TRANSACTION_READ_DEADLINE_MS = 16_000;

export const PREFLIGHT_MAX_DOC_BYTES = Math.floor((4 * FIRESTORE_MAX_DOCUMENT_SIZE_BYTES) / 5);
export const PREFLIGHT_MAX_REQUEST_BYTES = Math.floor((4 * FIRESTORE_MAX_REQUEST_SIZE_BYTES) / 5);
export const PREFLIGHT_MAX_INDEX_ENTRIES = Math.floor((4 * FIRESTORE_MAX_INDEX_ENTRIES) / 5);
export const PREFLIGHT_MAX_INDEX_BYTES = Math.floor((4 * FIRESTORE_MAX_INDEX_BYTES) / 5);
export const PREFLIGHT_MAX_NESTING_DEPTH = Math.floor((4 * FIRESTORE_MAX_NESTING_DEPTH) / 5);
export const PREFLIGHT_MAX_FIELD_TRANSFORMS = Math.floor((4 * FIRESTORE_MAX_FIELD_TRANSFORMS) / 5);

export function computeEstimatedFirestoreDocSize(obj: any): number {
  let size = 32;
  function calc(val: any, nameLen = 0): void {
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

export function validateMigrationPreflightLimits(prep: any): { sizeBytes: number; estFirestoreSize: number } {
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
  return { sizeBytes, estFirestoreSize };
}

export function validateMigrationIdentityFields(
  record: any,
  expectedNamespace?: string,
  expectedEpoch?: number,
  expectedRunId?: string,
): void {
  if (!record || typeof record !== 'object') {
    throw new CutoverFenceError('Migration record must be an object');
  }
  if (record.schemaVersion !== 2) {
    throw new CutoverFenceError(`Invalid schemaVersion: expected 2, got ${record.schemaVersion}`);
  }
  if (!SUPPORTED_CUTOVER_NAMESPACES.includes(record.namespace)) {
    throw new CutoverFenceError(`Invalid namespace: ${record.namespace}`);
  }
  if (expectedNamespace && record.namespace !== expectedNamespace) {
    throw new CutoverFenceError(`Namespace mismatch: expected ${expectedNamespace}, got ${record.namespace}`);
  }
  if (!Number.isInteger(record.epoch) || record.epoch < 1) {
    throw new CutoverFenceError(`Invalid epoch: must be a positive integer, got ${record.epoch}`);
  }
  if (expectedEpoch !== undefined && record.epoch !== expectedEpoch) {
    throw new CutoverFenceError(`Epoch mismatch: expected ${expectedEpoch}, got ${record.epoch}`);
  }
  if (typeof record.migrationRunId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(record.migrationRunId)) {
    throw new CutoverFenceError(`Invalid migrationRunId: got '${record.migrationRunId}'`);
  }
  if (expectedRunId && record.migrationRunId !== expectedRunId) {
    throw new CutoverFenceError(`migrationRunId mismatch: expected ${expectedRunId}, got ${record.migrationRunId}`);
  }
  if (typeof record.codeSha !== 'string' || !/^[0-9a-f]{40}$/.test(record.codeSha)) {
    throw new CutoverFenceError(`Invalid codeSha: expected 40-char lowercase hex, got '${record.codeSha}'`);
  }
  if (typeof record.codeArtifact !== 'string' || !/^[a-zA-Z0-9_./-]+@sha256:[0-9a-f]{64}$/.test(record.codeArtifact)) {
    throw new CutoverFenceError(`Invalid codeArtifact: expected name@sha256:<64 hex>, got '${record.codeArtifact}'`);
  }
  if (typeof record.packageIntegrity !== 'string' || !/^sha512-[A-Za-z0-9+/=]{86,88}$/.test(record.packageIntegrity)) {
    throw new CutoverFenceError(`Invalid packageIntegrity: expected sha512- SRI, got '${record.packageIntegrity}'`);
  }
  if (typeof record.protocolDigest !== 'string' || !/^[0-9a-f]{64}$/.test(record.protocolDigest)) {
    throw new CutoverFenceError(`Invalid protocolDigest: expected 64-char lowercase hex, got '${record.protocolDigest}'`);
  }
}

export const SUPPORTED_CUTOVER_NAMESPACES = ['mcp', 'pwmcp', 'readonly_mcp'] as const;
export type SupportedCutoverNamespace = (typeof SUPPORTED_CUTOVER_NAMESPACES)[number];

export function isSupportedCutoverNamespace(namespace: string): namespace is SupportedCutoverNamespace {
  return (SUPPORTED_CUTOVER_NAMESPACES as readonly string[]).includes(namespace);
}

export function assertSupportedCutoverNamespace(
  namespace: string,
): asserts namespace is SupportedCutoverNamespace {
  if (!isSupportedCutoverNamespace(namespace)) {
    throw new CutoverFenceError(
      `Unsupported cutover namespace: ${namespace}. Supported namespaces are: ${SUPPORTED_CUTOVER_NAMESPACES.join(', ')}`,
    );
  }
}

export type CutoverFenceState =
  | 'legacy_open'
  | 'closing'
  | 'fenced'
  | 'migrating'
  | 'v3_ready'
  | 'v3_active';

export const ALLOWED_STATE_TRANSITIONS: Readonly<Record<CutoverFenceState, readonly CutoverFenceState[]>> = {
  legacy_open: ['closing'],
  closing: ['fenced', 'legacy_open'],
  fenced: ['migrating', 'closing'],
  migrating: ['v3_ready'],
  v3_ready: ['v3_active'],
  v3_active: [],
};

export interface CutoverFenceControlRecord {
  schemaVersion: 1;
  namespace: SupportedCutoverNamespace;
  epoch: number;
  state: CutoverFenceState;
  activeOperations: number;
  irreversible: boolean;
  migrationRunId?: string;
  migrationManifestDigest?: string;
  emptyNamespace?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export interface CutoverFenceConfig {
  namespace: SupportedCutoverNamespace;
  enforce: boolean;
}

export type LegacyOperationPhase =
  | 'admitted'
  | 'upstream_pending'
  | 'completed'
  | 'failed';

export interface LegacyOperationRecord {
  schemaVersion: 1;
  id: string;
  namespace: SupportedCutoverNamespace;
  epoch: number;
  kind: string;
  phase: LegacyOperationPhase;
  createdAt: number;
  updatedAt: number;
  leaseExpiresAt?: number;
  ambiguousRemoteOutcome?: boolean;
  familyId?: string;
  metadata?: Record<string, unknown>;
}

export interface LegacyOperationContext {
  readonly id: string;
  readonly namespace: SupportedCutoverNamespace;
  readonly epoch: number;
  readonly kind: string;
  isAmbiguousRemoteOutcome(): boolean;
  markAmbiguousRemoteOutcome(reason?: string): void;
  clearAmbiguousRemoteOutcome(): void;
  isCompleted(): boolean;
  markCompleted(): void;
}

export function getCutoverFenceDocRef(db: FirestoreLike, namespace: string): any {
  assertSupportedCutoverNamespace(namespace);
  return db.collection(`${namespace}_meta`).doc('cutover_fence');
}

export function getCutoverOperationsColRef(db: FirestoreLike, namespace: string): any {
  assertSupportedCutoverNamespace(namespace);
  const docRef = db.collection(`${namespace}_meta`).doc('cutover_fence'); return typeof (docRef as any).collection === 'function' ? (docRef as any).collection('operations') : db.collection(`${namespace}_meta/cutover_fence/operations`);
}

export function getCutoverOperationDocRef(
  db: FirestoreLike,
  namespace: string,
  operationId: string,
): any {
  assertSupportedCutoverNamespace(namespace);
  return getCutoverOperationsColRef(db, namespace).doc(operationId);
}

export function parseCutoverFenceRecord(data: unknown, namespace: string): CutoverFenceControlRecord {
  assertSupportedCutoverNamespace(namespace);
  if (!data || typeof data !== 'object') {
    throw new CutoverFenceError(
      `Cutover fence control record for namespace ${namespace} is missing or not an object`,
    );
  }
  const record = data as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw new CutoverFenceError(
      `Invalid cutover fence schemaVersion for namespace ${namespace}: expected 1, got ${String(record.schemaVersion)}`,
    );
  }
  if (record.namespace !== namespace) {
    throw new CutoverFenceError(
      `Namespace mismatch in cutover fence control record: expected ${namespace}, got ${String(record.namespace)}`,
    );
  }
  if (typeof record.epoch !== 'number' || !Number.isInteger(record.epoch) || record.epoch < 0) {
    throw new CutoverFenceError(
      `Invalid epoch in cutover fence record for namespace ${namespace}: ${String(record.epoch)}`,
    );
  }
  const validStates: readonly CutoverFenceState[] = [
    'legacy_open',
    'closing',
    'fenced',
    'migrating',
    'v3_ready',
    'v3_active',
  ];
  if (typeof record.state !== 'string' || !validStates.includes(record.state as CutoverFenceState)) {
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

  // Validate state-specific invariants
  if (
    record.state === 'legacy_open' ||
    record.state === 'closing' ||
    record.state === 'fenced' ||
    record.state === 'migrating'
  ) {
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
    if (typeof record.migrationRunId !== 'string' || !record.migrationRunId) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: migrating requires non-empty migrationRunId`,
      );
    }
    if (record.migrationManifestDigest !== undefined) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: migrating cannot have migrationManifestDigest before v3_ready`,
      );
    }
  } else if (record.state === 'v3_ready' || record.state === 'v3_active') {
    if (typeof record.migrationRunId !== 'string' || !record.migrationRunId) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: ${record.state} requires migrationRunId`,
      );
    }
    if (typeof record.migrationManifestDigest !== 'string' || !record.migrationManifestDigest) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: ${record.state} requires migrationManifestDigest`,
      );
    }
    if (record.emptyNamespace !== undefined && typeof record.emptyNamespace !== 'boolean') {
      throw new CutoverFenceError(
        `Invalid emptyNamespace field in cutover fence record for namespace ${namespace}: expected boolean, got ${typeof record.emptyNamespace}`,
      );
    }
    if (record.irreversible !== true) {
      if (record.emptyNamespace !== true) {
        throw new CutoverFenceError(
          `Invalid cutover fence invariants for namespace ${namespace}: ${record.state} must be irreversible: true unless emptyNamespace is true`,
        );
      }
    }
  }

  return {
    schemaVersion: 1,
    namespace,
    epoch: record.epoch,
    state: record.state as CutoverFenceState,
    activeOperations: record.activeOperations,
    irreversible: record.irreversible,
    migrationRunId: typeof record.migrationRunId === 'string' ? record.migrationRunId : undefined,
    migrationManifestDigest:
      typeof record.migrationManifestDigest === 'string' ? record.migrationManifestDigest : undefined,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : undefined,
    emptyNamespace: typeof record.emptyNamespace === 'boolean' ? record.emptyNamespace : undefined,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : undefined,
  };
}

export async function readCutoverFenceInTransaction(
  transaction: any,
  db: FirestoreLike,
  namespace: string,
): Promise<CutoverFenceControlRecord> {
  assertSupportedCutoverNamespace(namespace);
  const ref = getCutoverFenceDocRef(db, namespace);
  const snap = await transaction.get(ref);
  if (!snap.exists) {
    throw new CutoverFenceError(
      `Cutover fence control record missing for namespace: ${namespace}`,
    );
  }
  return parseCutoverFenceRecord(snap.data(), namespace);
}

export async function getCutoverFenceRecord(
  db: FirestoreLike,
  namespace: string,
): Promise<CutoverFenceControlRecord | undefined> {
  assertSupportedCutoverNamespace(namespace);
  const ref = getCutoverFenceDocRef(db, namespace);
  const snap = await ref.get();
  if (!snap.exists) return undefined;
  return parseCutoverFenceRecord(snap.data(), namespace);
}

export async function initializeCutoverFence(
  db: FirestoreLike,
  namespace: string,
  options?: {
    initialEpoch?: number;
    initialState?: 'legacy_open';
    now?: () => number;
  },
): Promise<CutoverFenceControlRecord> {
  assertSupportedCutoverNamespace(namespace);
  const requestedState = options?.initialState ?? 'legacy_open';
  if (requestedState !== 'legacy_open') {
    throw new CutoverFenceError(
      `Cannot initialize cutover fence in state '${requestedState}': initialization must be in 'legacy_open'`,
    );
  }
  const requestedEpoch = options?.initialEpoch ?? 1;
  if (!Number.isInteger(requestedEpoch) || requestedEpoch < 1) {
    throw new CutoverFenceError(
      `Invalid initialEpoch for namespace ${namespace}: must be a positive integer, got ${requestedEpoch}`,
    );
  }

  const now = options?.now ?? Date.now;
  const ref = getCutoverFenceDocRef(db, namespace);

  return await db.runTransaction(async (transaction) => {
    const markerRef = db.collection(`${namespace}_meta`).doc('v2_adopted');
    const markerSnap = await transaction.get(markerRef);
    if (markerSnap.exists) {
      throw new CutoverFenceError(
        `Cannot initialize cutover fence in legacy_open: durable v2_adopted marker already exists for namespace ${namespace}`,
      );
    }

    const snap = await transaction.get(ref);
    if (snap.exists) {
      const existing = parseCutoverFenceRecord(snap.data(), namespace);
      if (existing.epoch !== requestedEpoch) {
        throw new CutoverFenceError(
          `Cannot initialize cutover fence for namespace ${namespace}: existing epoch ${existing.epoch} does not match requested initialEpoch ${requestedEpoch}`,
        );
      }
      if (existing.state !== requestedState) {
        throw new CutoverFenceError(
          `Cannot initialize cutover fence for namespace ${namespace}: existing state '${existing.state}' does not match requested initialState '${requestedState}'`,
        );
      }
      return existing;
    }
    const currentTime = now();
    const initial: CutoverFenceControlRecord = {
      schemaVersion: 1,
      namespace,
      epoch: requestedEpoch,
      state: 'legacy_open',
      activeOperations: 0,
      irreversible: false,
      createdAt: currentTime,
      updatedAt: currentTime,
    };
    transaction.set(ref, stripUndefined(initial as unknown as Record<string, unknown>));
    return initial;
  });
}

export interface CutoverTransitionParams {
  fromState?: CutoverFenceState | CutoverFenceState[];
  toState: CutoverFenceState;
  expectedEpoch: number;
  nextEpoch?: number;
  migrationRunId?: string;
  migrationManifestDigest?: string;
  emptyNamespace?: boolean;
  allowIdempotent?: boolean;
  now?: () => number;
}

export async function transitionCutoverFenceState(
  db: FirestoreLike,
  namespace: string,
  params: CutoverTransitionParams,
): Promise<CutoverFenceControlRecord> {
  assertSupportedCutoverNamespace(namespace);
  const now = params.now ?? Date.now;
  const ref = getCutoverFenceDocRef(db, namespace);

  return await db.runTransaction(async (transaction) => {
    const current = await readCutoverFenceInTransaction(transaction, db, namespace);

    if (current.epoch !== params.expectedEpoch) {
      throw new CutoverFenceError(
        `Epoch mismatch for namespace ${namespace}: expected ${params.expectedEpoch}, got ${current.epoch}`,
      );
    }

    if (params.emptyNamespace !== undefined && params.toState !== 'v3_ready') {
      throw new CutoverFenceError(
        `Invalid emptyNamespace parameter for transition to ${params.toState}: emptyNamespace flag is only allowed on transition to v3_ready`,
      );
    }

    if (current.state === params.toState) {
      if (params.emptyNamespace !== undefined && current.emptyNamespace !== params.emptyNamespace) {
        throw new CutoverFenceError(
          `Idempotent transition failed for namespace ${namespace}: emptyNamespace mismatch`,
        );
      }
      if (params.migrationRunId && current.migrationRunId !== params.migrationRunId) {
        throw new CutoverFenceError(
          `Idempotent transition failed for namespace ${namespace}: migrationRunId mismatch`,
        );
      }
      if (
        params.migrationManifestDigest &&
        current.migrationManifestDigest !== params.migrationManifestDigest
      ) {
        throw new CutoverFenceError(
          `Idempotent transition failed for namespace ${namespace}: migrationManifestDigest mismatch`,
        );
      }
      if (params.allowIdempotent !== false) {
        return current;
      }
      throw new CutoverFenceError(
        `Cutover fence for namespace ${namespace} already in target state ${params.toState}`,
      );
    }

    // Verify allowed state transition according to the strict state graph
    const allowed = ALLOWED_STATE_TRANSITIONS[current.state];
    if (!allowed.includes(params.toState)) {
      throw new CutoverFenceError(
        `Invalid state transition for namespace ${namespace}: cannot transition from ${current.state} to ${params.toState}`,
      );
    }

    if (params.fromState) {
      const fromList = Array.isArray(params.fromState) ? params.fromState : [params.fromState];
      if (!fromList.includes(current.state)) {
        throw new CutoverFenceError(
          `Invalid caller fromState for namespace ${namespace}: current state is ${current.state}, expected one of ${fromList.join(', ')}`,
        );
      }
    }

    if (params.toState === 'fenced') {
      if (current.activeOperations !== 0) {
        throw new CutoverFenceError(
          `Cannot transition to fenced for namespace ${namespace}: activeOperations is ${current.activeOperations}`,
        );
      }
      const pendingOps = await transaction.get(
        getCutoverOperationsColRef(db, namespace).where('phase', 'in', ['admitted', 'upstream_pending']).limit(1),
      );
      if (!pendingOps.empty) {
        throw new CutoverFenceError(
          `Cannot transition to fenced for namespace ${namespace}: active or pending operations exist`,
        );
      }
      const ambiguousOps = await transaction.get(
        getCutoverOperationsColRef(db, namespace).where('ambiguousRemoteOutcome', '==', true).limit(1),
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
    } else if (params.toState === 'migrating') {
      if (!params.migrationRunId || typeof params.migrationRunId !== 'string') {
        throw new CutoverFenceError(
          `Cannot transition to migrating for namespace ${namespace}: non-empty migrationRunId is required`,
        );
      }
    } else if (params.toState === 'v3_ready') {
      if (!current.migrationRunId) {
        throw new CutoverFenceError(
          `Cannot transition to v3_ready for namespace ${namespace}: current state has no migrationRunId`,
        );
      }
      if (params.migrationRunId && current.migrationRunId !== params.migrationRunId) {
        throw new CutoverFenceError(
          `Cannot transition to v3_ready for namespace ${namespace}: migrationRunId mismatch`,
        );
      }
      if (!params.migrationManifestDigest || typeof params.migrationManifestDigest !== 'string') {
        throw new CutoverFenceError(
          `Cannot transition to v3_ready for namespace ${namespace}: non-empty migrationManifestDigest is required`,
        );
      }
      if (params.emptyNamespace === true) {
        const markerRef = db.collection(`${namespace}_meta`).doc('v2_adopted');
        const markerSnap = await transaction.get(markerRef);
        if (!markerSnap.exists) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: missing durable ownership marker ${namespace}_meta/v2_adopted`,
          );
        }
        const m = markerSnap.data() as Record<string, unknown>;

        // 1. schemaVersion check
        if (m.schemaVersion !== 1) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: malformed or mismatched empty ownership marker (schemaVersion must be 1, got ${String(m.schemaVersion)})`,
          );
        }

        // 2. Strict allowed top-level keys
        const ALLOWED_MARKER_KEYS: Record<string, true> = {
          schemaVersion: true,
          adoptedAt: true,
          migrationRunId: true,
          runId: true,
          epoch: true,
          manifestDigest: true,
          migrationManifestDigest: true,
          sourceInventoryDigest: true,
          targetInventoryDigest: true,
          empty: true,
          emptyNamespace: true,
          totalAdopted: true,
          totalCandidateTokens: true,
          totalCandidateCodes: true,
          totalCandidateResumes: true,
          totalCandidateClients: true,
          totalPhysicalRecords: true,
          scanned: true,
          migrated: true,
          skipped: true,
          errors: true,
          physicalCounts: true,
          targetCounts: true,
          classifications: true,
          reasons: true,
          codeSha: true,
          codeArtifact: true,
          packageIntegrity: true,
        };
        for (const k of Object.keys(m)) {
          if (!ALLOWED_MARKER_KEYS[k]) {
            throw new CutoverFenceError(
              `Cannot transition to v3_ready with emptyNamespace for ${namespace}: unexpected field '${k}' in ownership marker`,
            );
          }
        }

        const runId = (m.runId ?? m.migrationRunId) as string | undefined;
        const manifestDigest = (m.manifestDigest ?? m.migrationManifestDigest) as string | undefined;
        const epoch = m.epoch as number | undefined;

        if (m.emptyNamespace !== true && m.empty !== true) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: marker emptyNamespace must be true`,
          );
        }
        if (!runId || runId !== current.migrationRunId) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: malformed or mismatched empty ownership marker (runId mismatch, expected ${current.migrationRunId}, got ${runId})`,
          );
        }
        if (!manifestDigest || manifestDigest !== params.migrationManifestDigest) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: malformed or mismatched empty ownership marker (manifestDigest mismatch, expected ${params.migrationManifestDigest}, got ${manifestDigest})`,
          );
        }
        if (epoch !== current.epoch) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: malformed or mismatched empty ownership marker (epoch mismatch, expected ${current.epoch}, got ${epoch})`,
          );
        }

        // Required provenance and digest fields
        if (typeof m.sourceInventoryDigest !== 'string' || !m.sourceInventoryDigest) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: marker missing sourceInventoryDigest`,
          );
        }
        if (typeof m.targetInventoryDigest !== 'string' || !m.targetInventoryDigest) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: marker missing targetInventoryDigest`,
          );
        }
        if (typeof m.codeSha !== 'string' || !m.codeSha) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: marker missing codeSha`,
          );
        }
        if (typeof m.codeArtifact !== 'string' || !m.codeArtifact) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: marker missing codeArtifact`,
          );
        }
        if (typeof m.packageIntegrity !== 'string' || !m.packageIntegrity) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: marker missing packageIntegrity`,
          );
        }

        // Validate top-level count fields are present and zero:
        const topLevelZeroCounts = [
          'totalAdopted',
          'totalCandidateTokens',
          'totalCandidateCodes',
          'totalCandidateResumes',
          'totalCandidateClients',
          'totalPhysicalRecords',
          'scanned',
          'migrated',
          'skipped',
          'errors',
        ];
        for (const k of topLevelZeroCounts) {
          const val = m[k];
          if (val === undefined || typeof val !== 'number' || val !== 0) {
            throw new CutoverFenceError(
              `Cannot transition to v3_ready with emptyNamespace for ${namespace}: marker count '${k}' must be 0, got ${String(val)}`,
            );
          }
        }

        // Validate required nested count maps are present and have exact key sets with all zeroes:
        const exactMapKeys: Record<string, string[]> = {
          physicalCounts: ['families', 'tokens', 'refresh', 'upstream', 'authCodes', 'resumeTokens', 'oauthClients', 'clients'],
          targetCounts: ['families', 'tokens', 'refresh', 'upstream', 'authCodes', 'resumeTokens', 'retiredRefreshTokens', 'oauthClients'],
          classifications: ['pr56Families', 'baseFormatTokens', 'authCodes', 'resumeTokens', 'clients'],
        };
        for (const [mapKey, requiredKeys] of Object.entries(exactMapKeys)) {
          const mapVal = m[mapKey];
          if (!mapVal || typeof mapVal !== 'object') {
            throw new CutoverFenceError(
              `Cannot transition to v3_ready with emptyNamespace for ${namespace}: marker missing required map '${mapKey}'`,
            );
          }
          const rec = mapVal as Record<string, unknown>;
          const actualKeys = Object.keys(rec);
          if (actualKeys.length !== requiredKeys.length || !requiredKeys.every((k) => actualKeys.includes(k))) {
            throw new CutoverFenceError(
              `Cannot transition to v3_ready with emptyNamespace for ${namespace}: marker map '${mapKey}' key mismatch (expected exact ${requiredKeys.join(', ')}, got ${actualKeys.join(', ')})`,
            );
          }
          for (const key of requiredKeys) {
            const val = rec[key];
            if (val === undefined || typeof val !== 'number' || val !== 0) {
              throw new CutoverFenceError(
                `Cannot transition to v3_ready with emptyNamespace for ${namespace}: marker count '${mapKey}.${key}' must be 0, got ${String(val)}`,
              );
            }
          }
        }

        // Validate physicalCounts sum matches totalPhysicalRecords (both must be 0)
        const markerPhysicalSum = Object.values(m.physicalCounts as Record<string, number>).reduce((sum, n) => sum + n, 0);
        if (markerPhysicalSum !== m.totalPhysicalRecords || m.totalPhysicalRecords !== 0) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: marker physicalCounts sum (${markerPhysicalSum}) contradicts totalPhysicalRecords (${m.totalPhysicalRecords})`,
          );
        }

        // Bind actual prepared manifest:
        const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${current.epoch}`);
        const prepSnap = await transaction.get(prepRef);
        if (!prepSnap.exists) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: missing prepared manifest ${namespace}_meta/migration_prepared_${current.epoch}`,
          );
        }
        const prep = prepSnap.data() as Record<string, unknown>;
        if (prep.schemaVersion !== 1) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: prepared manifest schemaVersion must be 1, got ${String(prep.schemaVersion)}`,
          );
        }
        if (prep.status !== 'prepared') {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: prepared manifest status must be 'prepared', got '${String(prep.status)}'`,
          );
        }
        const prepRunId = (prep.runId ?? prep.migrationRunId) as string | undefined;
        if (prepRunId !== current.migrationRunId) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: prepared manifest runId mismatch`,
          );
        }
        if (prep.epoch !== current.epoch) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: prepared manifest epoch mismatch`,
          );
        }
        if (prep.sourceInventoryDigest !== m.sourceInventoryDigest) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: prepared manifest sourceInventoryDigest mismatch`,
          );
        }
        if (prep.codeSha !== m.codeSha || prep.codeArtifact !== m.codeArtifact || prep.packageIntegrity !== m.packageIntegrity) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: prepared manifest provenance mismatch`,
          );
        }
        if (prep.totalPhysicalRecords !== 0) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: prepared manifest totalPhysicalRecords must be 0`,
          );
        }
        if (prep.physicalCounts && typeof prep.physicalCounts === 'object') {
          const prepPhysicalSum = Object.values(prep.physicalCounts as Record<string, number>).reduce((sum, n) => sum + n, 0);
          if (prepPhysicalSum !== prep.totalPhysicalRecords || prep.totalPhysicalRecords !== 0) {
            throw new CutoverFenceError(
              `Cannot transition to v3_ready with emptyNamespace for ${namespace}: prepared manifest physicalCounts sum (${prepPhysicalSum}) contradicts totalPhysicalRecords (${prep.totalPhysicalRecords})`,
            );
          }
        }
        if (!Array.isArray(prep.candidateCommitments) || prep.candidateCommitments.length !== 0) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: prepared manifest candidateCommitments must be empty array`,
          );
        }

        // Bind actual final migration manifest:
        const finalManifestRef = db.collection(`${namespace}_meta`).doc(`migration_manifest_${current.epoch}`);
        const finalManifestSnap = await transaction.get(finalManifestRef);
        if (!finalManifestSnap.exists) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: missing final migration manifest ${namespace}_meta/migration_manifest_${current.epoch}`,
          );
        }
        const finalManifest = finalManifestSnap.data() as Record<string, unknown>;
        if (finalManifest.schemaVersion !== 1) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: final manifest schemaVersion must be 1, got ${String(finalManifest.schemaVersion)}`,
          );
        }
        if (finalManifest.completionState !== 'completed') {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: final manifest completionState must be 'completed', got '${String(finalManifest.completionState)}'`,
          );
        }
        const finalRunId = (finalManifest.runId ?? finalManifest.migrationRunId) as string | undefined;
        if (finalRunId !== current.migrationRunId) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: final manifest runId mismatch`,
          );
        }
        if (finalManifest.epoch !== current.epoch) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: final manifest epoch mismatch`,
          );
        }
        const finalTargetDigest = (finalManifest.digests as Record<string, string> | undefined)?.targetInventoryDigest ?? finalManifest.targetInventoryDigest;
        if (!finalTargetDigest || finalTargetDigest !== m.targetInventoryDigest) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: target inventory digest mismatch between marker and final manifest`,
          );
        }
        const finalSourceDigest = (finalManifest.digests as Record<string, string> | undefined)?.sourceInventoryDigest ?? finalManifest.sourceInventoryDigest;
        if (!finalSourceDigest || finalSourceDigest !== m.sourceInventoryDigest) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: source inventory digest mismatch between marker and final manifest`,
          );
        }
        if (finalManifest.codeSha !== m.codeSha || finalManifest.codeArtifact !== m.codeArtifact || finalManifest.packageIntegrity !== m.packageIntegrity) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: final manifest provenance mismatch`,
          );
        }
        if (finalManifest.scanned !== 0 || finalManifest.migrated !== 0 || finalManifest.skipped !== 0 || finalManifest.errors !== 0) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: final manifest counts must be 0 for empty namespace`,
          );
        }
        const computedDigest = createHash('sha256').update(JSON.stringify(finalManifest)).digest('hex');
        if (computedDigest !== params.migrationManifestDigest) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: computed final manifest digest (${computedDigest}) does not match migrationManifestDigest (${params.migrationManifestDigest})`,
          );
        }
      } else if (!current.irreversible) {
        throw new CutoverFenceError(
          `Cannot transition to v3_ready for namespace ${namespace}: irreversible latch must have been engaged by the first credential write during migration`,
        );
      }
    } else if (params.toState === 'v3_active') {
      if (!current.migrationRunId || !current.migrationManifestDigest) {
        throw new CutoverFenceError(
          `Cannot transition to v3_active for namespace ${namespace}: missing migrationRunId or migrationManifestDigest`,
        );
      }
      if (params.migrationRunId && current.migrationRunId !== params.migrationRunId) {
        throw new CutoverFenceError(
          `Cannot transition to v3_active for namespace ${namespace}: migrationRunId mismatch`,
        );
      }
      if (
        params.migrationManifestDigest &&
        current.migrationManifestDigest !== params.migrationManifestDigest
      ) {
        throw new CutoverFenceError(
          `Cannot transition to v3_active for namespace ${namespace}: migrationManifestDigest mismatch`,
        );
      }
    }

    const nextEpoch = params.nextEpoch !== undefined ? params.nextEpoch : current.epoch;
    if (nextEpoch < current.epoch) {
      throw new CutoverFenceError(
        `Next epoch (${nextEpoch}) cannot be less than current epoch (${current.epoch})`,
      );
    }

    const currentTime = now();
    const updated: CutoverFenceControlRecord = {
      ...current,
      state: params.toState,
      epoch: nextEpoch,
      irreversible: current.irreversible,
      emptyNamespace: params.toState === 'v3_ready' ? params.emptyNamespace : current.emptyNamespace,
      migrationRunId: params.migrationRunId ?? current.migrationRunId,
      migrationManifestDigest: params.migrationManifestDigest ?? current.migrationManifestDigest,
      updatedAt: currentTime,
    };

    transaction.set(ref, stripUndefined(updated as unknown as Record<string, unknown>));
    return updated;
  });
}

export async function markIrreversibleInTransaction(
  transaction: any,
  db: FirestoreLike,
  namespace: string,
  expectedEpoch: number,
  migrationRunId?: string,
  nowProvider: () => number = Date.now,
): Promise<CutoverFenceControlRecord> {
  assertSupportedCutoverNamespace(namespace);
  const current = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (!['migrating', 'v3_ready', 'v3_active'].includes(current.state)) {
    throw new CutoverFenceError(
      `Cannot set irreversible latch for namespace ${namespace}: state must be 'migrating', 'v3_ready', or 'v3_active', got '${current.state}'`,
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
  if (current.irreversible) {
    return current;
  }
  const currentTime = nowProvider();
  const updated: CutoverFenceControlRecord = {
    ...current,
    irreversible: true,
    emptyNamespace: false,
    updatedAt: currentTime,
  };
  const ref = getCutoverFenceDocRef(db, namespace);
  transaction.set(ref, stripUndefined(updated as unknown as Record<string, unknown>), { merge: true });
  return updated;
}

export interface LegacyOperationMetadata {
  readonly [key: string]: unknown;
  readonly revision?: string;
  readonly attempt?: number;
  readonly phase?: string;
  readonly reconciled?: boolean;
}

export interface WithLegacyOperationOptions {
  db: FirestoreLike;
  namespace: SupportedCutoverNamespace;
  kind: string;
  operationId?: string;
  leaseMs?: number;
  metadata?: LegacyOperationMetadata;
  now?: () => number;
}

export async function withLegacyOperation<R>(
  options: WithLegacyOperationOptions,
  fn: (ctx: LegacyOperationContext) => Promise<R>,
): Promise<R> {
  assertSupportedCutoverNamespace(options.namespace);
  const now = options.now ?? Date.now;
  const opId = options.operationId ?? randomUUID();
  const controlRef = getCutoverFenceDocRef(options.db, options.namespace);
  const opRef = getCutoverOperationDocRef(options.db, options.namespace, opId);

  const opRecord = await options.db.runTransaction(async (transaction) => {
    const control = await readCutoverFenceInTransaction(transaction, options.db, options.namespace);

    if (control.state !== 'legacy_open' || control.irreversible) {
      throw new CutoverRefusedError(
        `Cutover state is ${control.state} (irreversible=${control.irreversible}); admissions closed for namespace ${options.namespace}`,
        { cutoverState: control.state, epoch: control.epoch },
      );
    }

    const existingOp = await transaction.get(opRef);
    if (existingOp.exists) {
      const existingRecord = existingOp.data() as LegacyOperationRecord;
      throw new CutoverFenceError(
        `Operation ID ${opId} already exists in phase ${existingRecord.phase}; duplicate admission rejected`,
      );
    }

    if (!options.kind || typeof options.kind !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(options.kind)) {
      throw new CutoverFenceError(
        `Invalid operation kind: kind must match /^[a-zA-Z0-9_-]{1,64}$/, got '${String(options.kind)}'`,
      );
    }
    const forbiddenKindTerms = ['password', 'secret', 'credential'];
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
    const createdRecord: LegacyOperationRecord = {
      schemaVersion: 1,
      id: opId,
      namespace: options.namespace,
      epoch: control.epoch,
      kind: options.kind,
      phase: 'admitted',
      createdAt: currentTime,
      updatedAt: currentTime,
      leaseExpiresAt: options.leaseMs ? currentTime + options.leaseMs : undefined,
      ambiguousRemoteOutcome: false,
      metadata: options.metadata ? stripUndefined(options.metadata) : undefined,
    };

    transaction.set(
      controlRef,
      { activeOperations: control.activeOperations + 1, updatedAt: currentTime },
      { merge: true },
    );
    transaction.set(opRef, stripUndefined(createdRecord as unknown as Record<string, unknown>));

    return createdRecord;
  });

  let ambiguous = false;
  let completed = false;

  const ctx: LegacyOperationContext = {
    id: opId,
    namespace: options.namespace,
    epoch: opRecord.epoch,
    kind: options.kind,
    isAmbiguousRemoteOutcome: () => ambiguous,
    markAmbiguousRemoteOutcome: () => {
      ambiguous = true;
    },
    clearAmbiguousRemoteOutcome: () => {
      ambiguous = false;
    },
    isCompleted: () => completed,
    markCompleted: () => {
      completed = true;
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
      await markOperationAmbiguous(options.db, ctx, now).catch(() => {});
    } else if (!ctx.isCompleted()) {
      await releaseLegacyOperation(options.db, ctx, 'failed', now).catch(() => {});
    }
    throw err;
  }
}

export async function releaseLegacyOperation(
  db: FirestoreLike,
  ctx: LegacyOperationContext,
  terminalPhase: 'completed' | 'failed',
  nowProvider: () => number = Date.now,
): Promise<void> {
  assertSupportedCutoverNamespace(ctx.namespace);
  const controlRef = getCutoverFenceDocRef(db, ctx.namespace);
  const opRef = getCutoverOperationDocRef(db, ctx.namespace, ctx.id);
  const currentTime = nowProvider();

  await db.runTransaction(async (transaction) => {
    const controlSnap = await transaction.get(controlRef);
    const opSnap = await transaction.get(opRef);

    if (!controlSnap.exists) {
      throw new CutoverFenceError(`Control record missing for namespace ${ctx.namespace}`);
    }
    if (!opSnap.exists) {
      throw new CutoverFenceError(`Operation record missing for operation ${ctx.id}`);
    }

    const opRecord = opSnap.data() as LegacyOperationRecord;
    if (opRecord.phase === 'completed' || opRecord.phase === 'failed') {
      return;
    }

    const control = parseCutoverFenceRecord(controlSnap.data(), ctx.namespace);
    if (control.activeOperations <= 0) {
      throw new CutoverFenceError(
        `Active operations underflow on release for namespace ${ctx.namespace}: count is ${control.activeOperations}`,
      );
    }

    transaction.set(
      controlRef,
      { activeOperations: control.activeOperations - 1, updatedAt: currentTime },
      { merge: true },
    );
    transaction.set(
      opRef,
      { phase: terminalPhase, updatedAt: currentTime },
      { merge: true },
    );
  });

  ctx.markCompleted();
}

export async function markOperationAmbiguous(
  db: FirestoreLike,
  ctx: LegacyOperationContext,
  nowProvider: () => number = Date.now,
): Promise<void> {
  assertSupportedCutoverNamespace(ctx.namespace);
  const opRef = getCutoverOperationDocRef(db, ctx.namespace, ctx.id);
  const currentTime = nowProvider();

  await db.runTransaction(async (transaction) => {
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

export interface GuardMutationOptions {
  db: FirestoreLike;
  namespace: SupportedCutoverNamespace;
  operation?: LegacyOperationContext;
  completeOperation?: boolean;
  now?: () => number;
}

export interface GuardMutationResult {
  control: CutoverFenceControlRecord;
  operation?: LegacyOperationRecord;
  bufferCompletion: (now?: number) => void;
  onCommit: () => void;
}

export async function checkMutationGuardInTransaction(
  transaction: any,
  options: GuardMutationOptions,
): Promise<GuardMutationResult> {
  assertSupportedCutoverNamespace(options.namespace);
  const control = await readCutoverFenceInTransaction(transaction, options.db, options.namespace);

  if (['fenced', 'migrating', 'v3_ready', 'v3_active'].includes(control.state)) {
    throw new CutoverRefusedError(
      `Cutover state is ${control.state}; mutations refused for namespace ${options.namespace}`,
      { cutoverState: control.state, epoch: control.epoch },
    );
  }

  let opRecord: LegacyOperationRecord | undefined;

  if (control.state === 'closing') {
    if (!options.operation) {
      throw new CutoverRefusedError(
        `Cutover is closing; unadmitted mutation refused for namespace ${options.namespace}`,
        { cutoverState: control.state, epoch: control.epoch },
      );
    }
    if (options.operation.epoch !== control.epoch) {
      throw new CutoverFenceError(
        `Operation epoch mismatch during closing for namespace ${options.namespace}: expected ${control.epoch}, got ${options.operation.epoch}`,
      );
    }
    const opRef = getCutoverOperationDocRef(options.db, options.namespace, options.operation.id);
    const opSnap = await transaction.get(opRef);
    if (!opSnap.exists) {
      throw new CutoverFenceError(
        `Operation record ${options.operation.id} missing during closing`,
      );
    }
    opRecord = opSnap.data() as LegacyOperationRecord;
    if (opRecord.epoch !== control.epoch) {
      throw new CutoverFenceError(
        `Operation record epoch mismatch: expected ${control.epoch}, got ${opRecord.epoch}`,
      );
    }
    if (opRecord.phase !== 'admitted' && opRecord.phase !== 'upstream_pending') {
      throw new CutoverFenceError(
        `Operation ${options.operation.id} is in phase ${opRecord.phase}; mutation not permitted`,
      );
    }
  } else if (control.state === 'legacy_open') {
    if (!options.operation) {
      throw new CutoverFenceError(
        `Durable operation context is required for fence-enforced mutations in namespace ${options.namespace}`,
      );
    }
    if (options.operation.epoch !== control.epoch) {
      throw new CutoverFenceError(
        `Operation epoch mismatch: expected ${control.epoch}, got ${options.operation.epoch}`,
      );
    }
      const opRef = getCutoverOperationDocRef(options.db, options.namespace, options.operation.id);
      const opSnap = await transaction.get(opRef);
      if (!opSnap.exists) {
        throw new CutoverFenceError(
          `Operation record ${options.operation.id} missing`,
        );
      }
      opRecord = opSnap.data() as LegacyOperationRecord;
      if (opRecord.epoch !== control.epoch) {
        throw new CutoverFenceError(
          `Operation record epoch mismatch: expected ${control.epoch}, got ${opRecord.epoch}`,
        );
      }
      if (opRecord.phase !== 'admitted' && opRecord.phase !== 'upstream_pending') {
        throw new CutoverFenceError(
          `Operation ${options.operation.id} is already in phase ${opRecord.phase}; cannot be reused for mutation`,
        );
      }
  }

  const shouldComplete = options.operation && options.completeOperation !== false;
  const opToComplete = options.operation;
  let completionBuffered = false;

  return {
    control,
    operation: opRecord,
    bufferCompletion: (customNow?: number) => {
      if (!shouldComplete || !opToComplete) return;
      if (opRecord && (opRecord.phase === 'completed' || opRecord.phase === 'failed')) {
        return;
      }
      if (control.activeOperations <= 0) {
        throw new CutoverFenceError(
          `Active operations underflow on completion for namespace ${options.namespace}: count is ${control.activeOperations}`,
        );
      }
      completionBuffered = true;
      const currentTime = customNow ?? (options.now ? options.now() : Date.now());
      const controlRef = getCutoverFenceDocRef(options.db, options.namespace);
      const opRef = getCutoverOperationDocRef(options.db, options.namespace, opToComplete.id);

      transaction.set(
        opRef,
        { phase: 'completed', updatedAt: currentTime },
        { merge: true },
      );
      transaction.set(
        controlRef,
        {
          activeOperations: control.activeOperations - 1,
          updatedAt: currentTime,
        },
        { merge: true },
      );
    },
    onCommit: () => {
      if (completionBuffered && shouldComplete && opToComplete) {
        opToComplete.markCompleted();
      }
    },
  };
}

export async function isLegacyMutationPermittedInTransaction(
  transaction: any,
  db: FirestoreLike,
  namespace: string,
  operation?: LegacyOperationContext,
): Promise<{ permitted: boolean; control: CutoverFenceControlRecord }> {
  assertSupportedCutoverNamespace(namespace);
  const control = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (['fenced', 'migrating', 'v3_ready', 'v3_active'].includes(control.state)) {
    return { permitted: false, control };
  }
  if (control.state === 'closing') {
    if (!operation || operation.epoch !== control.epoch) {
      return { permitted: false, control };
    }
    const opRef = getCutoverOperationDocRef(db, namespace, operation.id);
    const opSnap = await transaction.get(opRef);
    if (!opSnap.exists) {
      return { permitted: false, control };
    }
    const opRecord = opSnap.data() as LegacyOperationRecord;
    if (
      opRecord.epoch !== control.epoch ||
      (opRecord.phase !== 'admitted' && opRecord.phase !== 'upstream_pending')
    ) {
      return { permitted: false, control };
    }
  }
  return { permitted: true, control };
}
