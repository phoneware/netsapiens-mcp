import type { Firestore, Transaction, DocumentReference, CollectionReference } from '@google-cloud/firestore';
import type { FirestoreLike } from './firestore.js';

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
export interface MonotonicTimer {
  elapsedMs(): number;
  assertUnderDeadline(label?: string): void;
}
export function startMonotonicTimer(): MonotonicTimer;

export function isCutoverFenceError(err: unknown): err is CutoverFenceError;
export function isCutoverRefusedError(err: unknown): err is CutoverRefusedError;

export type CutoverFenceState =
  | 'legacy_open'
  | 'closing'
  | 'fenced'
  | 'migrating'
  | 'v3_ready'
  | 'v3_active';

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

export function parseCutoverFenceRecord(data: unknown, namespace: string): CutoverFenceControlRecord;
export function readCutoverFenceInTransaction(transaction: Transaction | any, db: Firestore | FirestoreLike, namespace: string): Promise<CutoverFenceControlRecord>;
export function getCutoverFenceRecord(db: Firestore | FirestoreLike, namespace: string): Promise<CutoverFenceControlRecord | undefined>;

export interface InitializeCutoverFenceOptions {
  initialEpoch?: number;
  initialState?: 'legacy_open';
  now?: () => number;
}
export function initializeCutoverFence(db: Firestore | FirestoreLike, namespace: string, options?: InitializeCutoverFenceOptions): Promise<CutoverFenceControlRecord>;

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
export function transitionCutoverFenceState(db: Firestore | FirestoreLike, namespace: string, params: CutoverTransitionParams): Promise<CutoverFenceControlRecord>;

export function getCutoverFenceDocRef(db: Firestore | FirestoreLike, namespace: string): DocumentReference | any;
export function getCutoverOperationsColRef(db: Firestore | FirestoreLike, namespace: string): CollectionReference | any;
export function getCutoverOperationDocRef(db: Firestore | FirestoreLike, namespace: string, operationId: string): DocumentReference | any;

export function markIrreversibleInTransaction(
  transaction: Transaction | any,
  db: Firestore | FirestoreLike,
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
  db: Firestore | FirestoreLike;
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
  db: Firestore | FirestoreLike,
  ctx: LegacyOperationContext,
  outcome?: 'completed' | 'failed',
  nowProvider?: () => number,
): Promise<void>;

export function markOperationAmbiguous(
  db: Firestore | FirestoreLike,
  ctx: LegacyOperationContext,
  nowProvider?: () => number,
): Promise<void>;

export interface GuardMutationOptions {
  db: Firestore | FirestoreLike;
  namespace: SupportedCutoverNamespace;
  operation: LegacyOperationContext;
  completeOperation?: boolean;
  now?: () => number;
  timer: MonotonicTimer;
}

export interface GuardMutationResult {
  control: CutoverFenceControlRecord;
  operation: LegacyOperationRecord;
  bufferCompletion: (now?: number) => void;
  onCommit: () => void;
}

export function checkMutationGuardInTransaction(
  transaction: Transaction | any,
  options: GuardMutationOptions,
): Promise<GuardMutationResult>;

export function isLegacyMutationPermittedInTransaction(
  transaction: Transaction | any,
  db: Firestore | FirestoreLike,
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
  timer: MonotonicTimer;
}

export function claimUpstreamGrantInTransaction(
  transaction: Transaction | any,
  db: Firestore | FirestoreLike,
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
  timer: MonotonicTimer;
}

export function reconcileUpstreamGrantInTransaction(
  transaction: Transaction | any,
  db: Firestore | FirestoreLike,
  options: ReconcileUpstreamGrantOptions,
): Promise<{ status: 'ambiguous_pending'; operationId: string; familyId: string }>;

export interface MigrationContext {
  db: Firestore | FirestoreLike;
  FieldPath: { documentId(): any };
  key: Uint8Array | Buffer;
  namespace: SupportedCutoverNamespace;
  expectedEpoch: number;
  migrationRunId: string;
  codeSha: string;
  codeArtifact: string;
  packageIntegrity: string;
  protocolDigest: string;
}

export function assertValidMigrationContext(options: unknown): asserts options is MigrationContext;

export function inspectFirestoreLegacyMigration(
  options: MigrationContext,
): Promise<{
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
  epoch: number;
  migrationRunId: string;
  migrationManifestDigest: string;
  planDigest: string;
}>;

export function getFirestoreMigrationStatus(
  options: MigrationContext,
): Promise<{
  state: string;
  epoch: number;
  migrationRunId?: string;
  migrationManifestDigest?: string;
  planDigest?: string;
  sourceInventoryDigest?: string;
}>;
