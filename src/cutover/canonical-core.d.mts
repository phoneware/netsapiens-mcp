// Compile-time declarations for the reviewed canonical core (src/cutover/canonical-core.mjs, blob 9075a35e…).
// The assembled protocol type-check resolves .mjs specifiers to this file, never to the build output. It
// imports only the protected closure's type modules, so it adds nothing to the closure.
//
// Every value below is an export of the reviewed core. Functions are loosely typed: their behaviour and
// argument shapes are proven by the core's tests and the emulator suites, not by these declarations. The
// interface types are not runtime values; they type the public re-exports that the core does not define.
import type { FirestoreLike } from '../store/firestore-like.js';
import type { SubjectDescriptor } from '../store/subject-descriptor.js';

export { CutoverFenceError, CutoverRefusedError, isCutoverFenceError, isCutoverRefusedError } from '../store/errors.js';

export interface CutoverFenceControlRecord {
  [key: string]: any;
  schemaVersion: 1;
  namespace: string;
  epoch: number;
  state: CutoverFenceState;
}
export type CutoverFenceState = string;
export interface LegacyOperationContext {
  [key: string]: any;
}
export interface WithLegacyOperationOptions {
  [key: string]: any;
}
export interface ClaimUpstreamGrantOptions {
  [key: string]: any;
}
export interface ReconcileUpstreamGrantOptions {
  [key: string]: any;
}

export const SUPPORTED_CUTOVER_NAMESPACES: readonly ['mcp', 'pwmcp', 'readonly_mcp'];
export const APPROVED_GRAPH_PROJECTOR_ID: string;
export const APPROVED_GRAPH_PROJECTOR_VERSION: number;
export const NONEMPTY_PROJECTOR_KEYS: readonly string[];
export const PHYSICAL_COUNT_KEYS: readonly string[];
export const TARGET_COUNT_KEYS: readonly string[];
export const CLASSIFICATION_KEYS: readonly string[];
export const CANDIDATE_KIND_TO_CLASSIFICATION: Readonly<Record<string, string>>;
export const REASON_KEYS: readonly string[];
export const ALLOWED_STATE_TRANSITIONS: Readonly<Record<string, readonly string[]>>;
export const REQUIRED_IDENTITY_KEYS: readonly string[];
export const REQUIRED_OWNERSHIP_MARKER_KEYS: readonly string[];
export const REQUIRED_PREPARED_MANIFEST_KEYS: readonly string[];
export const REQUIRED_FINAL_MANIFEST_KEYS: readonly string[];
export const REQUIRED_CANDIDATE_KEYS: readonly string[];
export const REQUIRED_RECEIPT_KEYS: readonly string[];
export const REQUIRED_PLAN_SPEC_KEYS: readonly string[];
export const CUTOVER_OPERATIONS_GROUP: string;
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
export const F: (...args: any[]) => any;

export function isSupportedCutoverNamespace(namespace: unknown): boolean;
export function assertSupportedCutoverNamespace(namespace: unknown): void;
export function sanitizeId(id: unknown): string;
export function validateMapKeysExact(...args: any[]): any;
export function validateMigrationIdentityFields(...args: any[]): any;
export function getCutoverDistinctCollectionNames(namespace: string): any;
export function getSourceCollectionAllowlist(...args: any[]): any;
export function getTargetCollectionAllowlist(...args: any[]): any;
export function isTargetFormatRow(collection: string, data: unknown): boolean;
export function getCutoverFenceDocRef(db: FirestoreLike | any, namespace: string): any;
export function getCutoverOperationsColRef(...args: any[]): any;
export function operationStorageId(...args: any[]): any;
export function getCutoverOperationDocRef(...args: any[]): any;
export function normalizeValue(...args: any[]): any;
export function rfc8785CanonicalJson(value: unknown): string;
export function C(value: unknown): string;
export function canonicalJsonStringify(value: unknown): string;
export function canonicalCompare(a: unknown, b: unknown): number;
export function deriveKey(...args: any[]): any;
export function frame(...args: any[]): any;
export function D(purpose: string, namespace: string, epoch: number, value: unknown): string;
export function H(storeKey: Uint8Array | string | Buffer, purpose: string, namespace: string, epoch: number, value: unknown): string;
export function computeKeyedDocId(...args: any[]): any;
export function computeSourceRecordDigest(...args: any[]): any;
export function computeTargetRecordDigest(...args: any[]): any;
export function computeSourceInventoryDigest(...args: any[]): any;
export function computeTargetInventoryDigest(...args: any[]): any;
export function computeLogicalInventoryDigest(...args: any[]): any;
export function computeManifestDigest(...args: any[]): any;
export function computeProtocolDigest(moduleSource: string | Uint8Array): string;
export function startMonotonicTimer(): any;
export function isMonotonicTimer(timer: unknown): boolean;
export function computeEstimatedFirestoreDocSize(obj: unknown): number;
export function validateMigrationPreflightLimits(...args: any[]): any;
export function validateProspectiveDocBudget(...args: any[]): any;
export function validateTransactionBudgetPlan(...args: any[]): any;
export function validateCompleteMigrationPlan(plan: unknown): any;
export function validateCandidateCommitments(...args: any[]): any;
export function validateReceipt(receipt: unknown, expectedNamespace: string, expectedEpoch: number, expectedRunId: string): any;
export function computeReceiptDigest(receipt: unknown): string;
export function computePlanDigest(namespace: string, epoch: number, planSpec: unknown): string;
export function computeReceiptSetDigest(receipts: unknown[], namespace: string, epoch: number): string;
export function parseCutoverFenceRecord(data: unknown, namespace: string): CutoverFenceControlRecord;
export function readCutoverFenceInTransaction(...args: any[]): Promise<CutoverFenceControlRecord>;
export function getCutoverFenceRecord(db: FirestoreLike | any, namespace: string): Promise<CutoverFenceControlRecord | undefined>;
export function initializeCutoverFence(...args: any[]): Promise<CutoverFenceControlRecord>;
export function transitionCutoverFenceState(...args: any[]): Promise<CutoverFenceControlRecord>;
export function markIrreversibleInTransaction(...args: any[]): Promise<any>;
export function withLegacyOperation(...args: any[]): Promise<any>;
export function releaseLegacyOperation(...args: any[]): Promise<any>;
export function markOperationAmbiguous(...args: any[]): Promise<any>;
export function checkV3MutationGuardInTransaction(...args: any[]): Promise<any>;
export function checkMutationGuardInTransaction(...args: any[]): Promise<any>;
export function isLegacyMutationPermittedInTransaction(...args: any[]): Promise<any>;
export function claimUpstreamGrantInTransaction(...args: any[]): Promise<any>;
export function reconcileUpstreamGrantInTransaction(...args: any[]): Promise<any>;
export function verifyIndexManifestDigests(...args: any[]): any;
export function assertPreparedIdentity(...args: any[]): any;
export function assertSubjectRefsPresent(...args: any[]): any;
export interface PrepareProtectedBinding {
  readonly profile: 'production' | 'emulator';
  readonly project: string;
  readonly database: string;
  readonly subjectDescriptor: SubjectDescriptor | null;
}
export interface PrepareExpectedIdentity {
  readonly namespace: string;
  readonly epoch: number;
  readonly migrationRunId: string;
  readonly codeSha: string;
  readonly codeArtifact: string;
  readonly packageIntegrity: string;
  readonly protocolDigest: string;
  readonly assemblyDigest: string;
  readonly indexSchemaDigest: string;
  readonly indexPolicyDigest: string;
  readonly encoderVersion: number;
}
// The §3.3 seam options, exactly. The core refuses any other key at runtime; this type makes tsc refuse it first.
export interface PrepareMigrationOptions {
  readonly namespace: string;
  readonly prepDoc: unknown;
  readonly storeKey: Uint8Array | string;
  readonly FieldPath: unknown;
  readonly timer: unknown;
  readonly completePlan: unknown;
  readonly expectedIdentity: PrepareExpectedIdentity;
  readonly indexManifest: unknown;
  readonly protectedBinding: PrepareProtectedBinding;
}
export function prepareMigrationInTransaction(
  transaction: unknown,
  db: unknown,
  options: PrepareMigrationOptions,
): Promise<CutoverFenceControlRecord>;
export function finalizeMigrationInTransaction(...args: any[]): Promise<any>;
export function activateMigrationInTransaction(...args: any[]): Promise<any>;
export function verifyActiveMigrationInTransaction(...args: any[]): Promise<any>;
export function getCutoverCollectionRegistry(namespace: string): any;
export function validateCompleteMigrationPlanForIdentity(...args: any[]): any;
export function getCutoverRuntimeCollectionScope(namespace: string): any;
export function assertValidMigrationContext(...args: any[]): any;
