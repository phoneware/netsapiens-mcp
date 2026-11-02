import type { Firestore, Transaction, DocumentReference, CollectionReference } from '@google-cloud/firestore';

export const SUPPORTED_CUTOVER_NAMESPACES: readonly ['mcp', 'pwmcp', 'readonly_mcp'];
export type SupportedCutoverNamespace = (typeof SUPPORTED_CUTOVER_NAMESPACES)[number];

export function isSupportedCutoverNamespace(namespace: string): namespace is SupportedCutoverNamespace;
export function assertSupportedCutoverNamespace(namespace: string): asserts namespace is SupportedCutoverNamespace;

export class CutoverFenceError extends Error {
  readonly kitCode: 'cutover_fence_error';
  constructor(message: string);
}

export class CutoverRefusedError extends Error {
  readonly kitCode: 'cutover_refused';
  readonly cutoverState?: string;
  readonly epoch?: number;
  constructor(message: string, details?: { cutoverState?: string; epoch?: number });
}

export function isCutoverFenceError(err: unknown): err is CutoverFenceError;
export function isCutoverRefusedError(err: unknown): err is CutoverRefusedError;

export function sanitizeId(id: string): string;

export const PHYSICAL_COUNT_KEYS: readonly [
  'families',
  'tokens',
  'refresh',
  'upstream',
  'authCodes',
  'resumeTokens',
  'oauthClients',
  'clients',
];

export const TARGET_COUNT_KEYS: readonly [
  'families',
  'tokens',
  'refresh',
  'upstream',
  'authCodes',
  'resumeTokens',
  'retiredRefreshTokens',
  'oauthClients',
];

export const CLASSIFICATION_KEYS: readonly [
  'pr56Families',
  'baseFormatTokens',
  'authCodes',
  'resumeTokens',
  'clients',
];

export const REASON_KEYS: readonly [
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

export type CutoverFenceState =
  | 'legacy_open'
  | 'closing'
  | 'fenced'
  | 'migrating'
  | 'v3_ready'
  | 'v3_active';

export const ALLOWED_STATE_TRANSITIONS: Readonly<Record<CutoverFenceState, readonly CutoverFenceState[]>>;

export const REQUIRED_IDENTITY_KEYS: readonly string[];
export const REQUIRED_OWNERSHIP_MARKER_KEYS: readonly string[];
export const REQUIRED_PREPARED_MANIFEST_KEYS: readonly string[];
export const REQUIRED_FINAL_MANIFEST_KEYS: readonly string[];
export const REQUIRED_CANDIDATE_KEYS: readonly string[];
export const REQUIRED_RECEIPT_KEYS: readonly string[];
export const APPROVED_GRAPH_PROJECTOR_ID: 'netsapiens-mcp/v2-v3-projector';
export const APPROVED_GRAPH_PROJECTOR_VERSION: 1;
export const NONEMPTY_PROJECTOR_KEYS: readonly ['projectorId', 'projectorVersion', 'projectorDigest'];
export function getMeasuredProjectorDigest(): string;
export function getCutoverDistinctCollectionNames(namespace: string): {
  source: Record<string, string>;
  target: Record<string, string>;
  distinct: readonly string[];
};
export function getSourceCollectionAllowlist(namespace?: string): string[];
export function getTargetCollectionAllowlist(namespace?: string): string[];
export function isTargetFormatRow(collection: string, data: unknown, rawId?: string): boolean;
export function computeKeyedDocId(storeKey: Buffer | Uint8Array | string, purpose: string, namespace: string, epoch: number, collection: string, rawId: string): string;
export function computeSourceRecordDigest(storeKey: Buffer | Uint8Array | string, namespace: string, epoch: number, collection: string, sourceId: string, data: unknown): string;
export function computeTargetRecordDigest(storeKey: Buffer | Uint8Array | string, namespace: string, epoch: number, collection: string, targetId: string, data: unknown): string;
export function computeSourceInventoryDigest(storeKey: Buffer | Uint8Array | string, namespace: string, epoch: number, sourceDescriptors: Array<{ collection: string; id: string; recordDigest: string }>): string;
export function computeTargetInventoryDigest(storeKey: Buffer | Uint8Array | string, namespace: string, epoch: number, targetDescriptors: Array<{ collection: string; id: string; recordDigest: string }>): string;
export function computeLogicalInventoryDigest(storeKey: Buffer | Uint8Array | string, namespace: string, epoch: number, logicalItems: Array<[string, string]>): string;

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
  codeArtifact?: string;
  codeSha?: string;
  lastTransitionReason?: string;
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
  operationId: string;
  namespace: SupportedCutoverNamespace;
  epoch: number;
  kind: string;
  phase: LegacyOperationPhase;
  createdAt: number;
  updatedAt: number;
  leaseExpiresAt?: number;
  ambiguousRemoteOutcome?: boolean;
  ambiguousReason?: string;
  familyId?: string;
  metadata?: Record<string, unknown>;
}

export interface LegacyOperationContext {
  readonly id: string;
  readonly namespace: SupportedCutoverNamespace;
  readonly epoch: number;
  readonly kind: string;
  isAmbiguousRemoteOutcome(): boolean;
  getAmbiguousReason?(): string | undefined;
  markAmbiguousRemoteOutcome(reason?: string): void;
  clearAmbiguousRemoteOutcome(): void;
  isCompleted(): boolean;
  markCompleted(): void;
}

export function getCutoverFenceDocRef(db: Firestore, namespace: string): DocumentReference;
export function getCutoverOperationsColRef(db: Firestore, namespace: string): CollectionReference;
export function getCutoverOperationDocRef(db: Firestore, namespace: string, operationId: string): DocumentReference;

export function stripUndefined<T>(obj: T): T;
export function canonicalJsonStringify(val: unknown): string;
export function rfc8785CanonicalJson(val: unknown): string;
export function normalizeValue(val: unknown): unknown[];
export function C(value: unknown): string;
export function deriveKey(storeKey: Buffer | Uint8Array | string): Buffer;
export function frame(purpose: string, namespace: string, epoch: number, value: unknown): string;
export function F(purpose: string, namespace: string, epoch: number, value: unknown): string;
export function D(purpose: string, namespace: string, epoch: number, value: unknown): string;
export function H(storeKey: Buffer | Uint8Array | string, purpose: string, namespace: string, epoch: number, value: unknown): string;
export function computeManifestDigest(manifest: Record<string, unknown>, namespace?: string, epoch?: number): string;
export function computeProtocolDigest(moduleSource: Buffer | Uint8Array | string): string;

export const FIRESTORE_MAX_DOCUMENT_SIZE_BYTES: number;
export const FIRESTORE_MAX_REQUEST_SIZE_BYTES: number;
export const FIRESTORE_MAX_INDEX_ENTRIES: number;
export const FIRESTORE_MAX_INDEX_BYTES: number;
export const FIRESTORE_MAX_NESTING_DEPTH: number;
export const FIRESTORE_MAX_FIELD_TRANSFORMS: number;
export const FIRESTORE_TRANSACTION_READ_DEADLINE_MS: number;

export const PREFLIGHT_MAX_DOC_BYTES: number;
export const PREFLIGHT_MAX_REQUEST_BYTES: number;
export const PREFLIGHT_MAX_INDEX_ENTRIES: number;
export const PREFLIGHT_MAX_INDEX_BYTES: number;
export const PREFLIGHT_MAX_NESTING_DEPTH: number;
export const PREFLIGHT_MAX_FIELD_TRANSFORMS: number;

export function computeEstimatedFirestoreDocSize(obj: unknown): number;
export function validateMigrationPreflightLimits(
  prep: Record<string, unknown>,
  options?: {
    finalDoc?: Record<string, unknown>;
    markerDoc?: Record<string, unknown>;
    receipts?: unknown[];
    items?: unknown[];
    readDurationMs?: number;
  },
): {
  sizeBytes: number;
  estFirestoreSize: number;
  depth: number;
  indexEntries: number;
  indexBytes: number;
};

export interface ProspectiveDocBudgetMetrics {
  estFirestoreSize: number;
  depth: number;
  indexEntries: number;
  indexBytes: number;
  transforms: number;
}

export interface TransactionBudgetPlanMetrics {
  commitBytes: number;
  readDurationMs?: number;
}

export interface CompleteMigrationPlanValidationResult {
  valid: boolean;
  preparedMetrics: ProspectiveDocBudgetMetrics;
  itemsCount: number;
}

export function validateProspectiveDocBudget(doc: unknown, label?: string): ProspectiveDocBudgetMetrics;
export function validateTransactionBudgetPlan(txPlan: unknown, label?: string): TransactionBudgetPlanMetrics;
export function validateCompleteMigrationPlan(plan: unknown): CompleteMigrationPlanValidationResult;

export function validateMapKeysExact(obj: unknown, allowedKeys: readonly string[] | string[], label?: string): void;
export function validateMigrationIdentityFields(doc: unknown, expectedNamespace: string, expectedEpoch: number, expectedRunId?: string): void;
export function validateCandidateCommitments(
  candidates: unknown[],
  prepDoc: Record<string, unknown>,
  expectedNamespace: string,
  expectedEpoch: number,
  expectedRunId: string,
): void;

export function validateReceipt(
  receipt: unknown,
  expectedNamespace: string,
  expectedEpoch: number,
  expectedRunId: string,
): void;

export function computeReceiptDigest(receipt: Record<string, unknown>): string;
export function computePlanDigest(namespace: string, epoch: number, planSpec: unknown): string;
export function computeReceiptSetDigest(receipts: Record<string, unknown>[], namespace: string, epoch: number): string;

export function parseCutoverFenceRecord(data: unknown, namespace: string): CutoverFenceControlRecord;
export function readCutoverFenceInTransaction(transaction: Transaction, db: Firestore, namespace: string): Promise<CutoverFenceControlRecord>;
export function getCutoverFenceRecord(db: Firestore, namespace: string): Promise<CutoverFenceControlRecord | undefined>;

export interface InitializeCutoverFenceOptions {
  initialEpoch?: number;
  initialState?: 'legacy_open';
  now?: () => number;
}
export function initializeCutoverFence(db: Firestore, namespace: string, options?: InitializeCutoverFenceOptions): Promise<CutoverFenceControlRecord>;

export interface CutoverTransitionParams {
  expectedEpoch: number;
  toState: CutoverFenceState;
  fromState?: CutoverFenceState | CutoverFenceState[];
  migrationRunId?: string;
  migrationManifestDigest?: string;
  emptyNamespace?: boolean;
  nextEpoch?: number;
  now?: () => number;
  allowIdempotent?: boolean;
}
export function transitionCutoverFenceState(db: Firestore, namespace: string, params: CutoverTransitionParams): Promise<CutoverFenceControlRecord>;

export function markIrreversibleInTransaction(
  transaction: Transaction,
  db: Firestore,
  namespace: string,
  expectedEpoch: number,
  migrationRunId?: string,
  nowProvider?: () => number,
): Promise<CutoverFenceControlRecord>;

export interface LegacyOperationMetadata {
  readonly [key: string]: unknown;
  readonly revision?: string;
  readonly attempt?: number;
  readonly phase?: string;
  readonly reconciled?: boolean;
}

export interface WithLegacyOperationOptions {
  db: Firestore;
  namespace: SupportedCutoverNamespace;
  kind: string;
  operationId?: string;
  leaseMs?: number;
  metadata?: LegacyOperationMetadata;
  now?: () => number;
}
export function withLegacyOperation<R>(
  options: WithLegacyOperationOptions,
  fn: (ctx: LegacyOperationContext) => Promise<R>,
): Promise<R>;

export function releaseLegacyOperation(
  db: Firestore,
  ctx: LegacyOperationContext,
  outcome?: 'completed' | 'failed',
  nowProvider?: () => number,
): Promise<void>;

export function markOperationAmbiguous(
  db: Firestore,
  ctx: LegacyOperationContext,
  nowProvider?: () => number,
): Promise<void>;

export interface GuardMutationOptions {
  db: Firestore;
  namespace: SupportedCutoverNamespace;
  operation: LegacyOperationContext;
  completeOperation?: boolean;
  now?: () => number;
}

export interface GuardMutationResult {
  control: CutoverFenceControlRecord;
  operation: LegacyOperationRecord;
  bufferCompletion: (now?: number) => void;
  onCommit: () => void;
}

export function checkMutationGuardInTransaction(
  transaction: Transaction,
  options: GuardMutationOptions,
): Promise<GuardMutationResult>;

export function isLegacyMutationPermittedInTransaction(
  transaction: Transaction,
  db: Firestore,
  namespace: string,
  operation?: LegacyOperationContext,
): Promise<{ permitted: boolean; control: CutoverFenceControlRecord }>;

export interface ClaimUpstreamGrantOptions {
  namespace: SupportedCutoverNamespace;
  epoch: number;
  familyId: string;
  operationId: string;
  claimOwner: string;
  expectedFamilyGeneration: number;
  expectedGrantVersion: number;
  expectedKind: string;
  leaseMs?: number;
  nowProvider?: () => number;
  collection?: string;
  familyCollection?: string;
  refreshCollection?: string;
}

export function claimUpstreamGrantInTransaction(
  transaction: Transaction,
  db: Firestore,
  options: ClaimUpstreamGrantOptions,
): Promise<{
  status: 'claimed';
  familyId: string;
  operationId: string;
  claimOwner: string;
  familyGeneration: number;
  grantVersion: number;
  leaseExpiresAt: number;
  grant: any;
}>;

export interface ReconcileUpstreamGrantOptions {
  namespace: SupportedCutoverNamespace;
  familyId: string;
  operationId: string;
  claimOwner: string;
  expectedFamilyGeneration: number;
  expectedGrantVersion: number;
  outcome: 'success' | 'revoked' | 'transient_timeout' | 'fatal_error';
  evidence?: { provider: string; timestamp: number; [key: string]: unknown };
  replacementGrant?: { accessToken: string; refreshToken?: string; [key: string]: unknown };
  nowProvider?: () => number;
  collection?: string;
  familyCollection?: string;
  refreshCollection?: string;
}

export function reconcileUpstreamGrantInTransaction(
  transaction: Transaction,
  db: Firestore,
  options: ReconcileUpstreamGrantOptions,
): Promise<{ status: 'ambiguous_pending'; operationId: string; familyId: string }>;

export interface CandidateCommitment {
  id: string;
  kind: string;
  sources: Array<{ collection: string; id: string; recordDigest: string }>;
  targets: Array<{ collection: string; id: string }>;
  logicalDigest: string;
}


export interface MigrationContext {
  db: Firestore;
  FieldPath: { documentId(): unknown };
  key: Uint8Array | Buffer;
  namespace: SupportedCutoverNamespace;
  expectedEpoch: number;
  migrationRunId: string;
  codeSha: string;
  codeArtifact: string;
  packageIntegrity: string;
  protocolDigest: string;
  assemblyDigest: string;
  indexSchemaDigest: string;
}

export interface CompleteMigrationPlan {
  prepared: Record<string, unknown>;
  preparation: { estimatedCommitBytes: number; estimatedReadDurationMs?: number };
  items: Array<{
    candidateId: string;
    sourceReferences: Array<{ collection: string; id: string }>;
    targetReferences: Array<{ collection: string; id: string }>;
    prospectiveTargetPostimages: Array<Record<string, unknown>>;
    sourceActions?: unknown[];
    receiptUpperBound: Record<string, unknown>;
    transaction: { estimatedCommitBytes: number; estimatedReadDurationMs?: number };
  }>;
  finalization: {
    finalUpperBound: Record<string, unknown>;
    markerUpperBound: Record<string, unknown>;
    controlUpperBound: Record<string, unknown>;
    transaction: { estimatedCommitBytes: number; estimatedReadDurationMs?: number };
  };
  activation: {
    controlUpperBound: Record<string, unknown>;
    transaction: { estimatedCommitBytes: number; estimatedReadDurationMs?: number };
  };
}

export function assertValidMigrationContext(options: unknown): asserts options is MigrationContext;

export function inspectFirestoreLegacyMigration(
  options: MigrationContext,
): Promise<{
  sourceInventoryDigest: string;
  scanned: number;
  prospectiveWritten: number;
  prospectiveRetained: number;
  preflight: {
    scanned: number;
    sourceInventoryDigest: string;
    estimatedFirestoreSize: number;
    depth: number;
    indexEntries: number;
    indexBytes: number;
  };
}>;

export function adoptFirestoreLegacyTokens(
  options: MigrationContext & {
    dryRun: boolean;
    expectedSourceInventoryDigest: string;
  },
): Promise<{
  scanned: number;
  migrated: number;
  skipped: number;
  errors: number;
}>;

export function activateFirestoreMigration(
  options: MigrationContext,
): Promise<{
  status: 'activated' | 'already_active';
}>;

export function getFirestoreMigrationStatus(
  options: MigrationContext,
): Promise<CutoverFenceControlRecord>;
