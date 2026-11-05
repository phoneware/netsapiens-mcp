// Compile-time declarations for the reviewed canonical core (src/cutover/canonical-core.mjs). The assembled
// protocol type-check resolves .mjs specifiers to this file, never to the build output. It imports only the
// import-free store type module, so it adds nothing to the protected closure.
//
// Declarations here are loose by design. Each name is the exact export the public tree imports; their
// behaviour and value shapes are proven by the core's own tests and the emulator suites, not by these types.
import type { FirestoreLike } from '../store/firestore-like.js';

export class CutoverFenceError extends Error {
  readonly kitCode: string;
  constructor(message: string, options?: { cause?: unknown });
}

export class CutoverRefusedError extends Error {
  readonly kitCode: string;
  readonly retryAfterSeconds: number;
  readonly cutoverState?: string;
  constructor(message: string, details?: Record<string, unknown>);
}

export type CutoverFenceState = string;

export interface CutoverFenceControlRecord {
  [key: string]: any;
  schemaVersion: 1;
  namespace: string;
  epoch: number;
  state: CutoverFenceState;
}

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
export const CLASSIFICATION_KEYS: readonly string[];
export const PHYSICAL_COUNT_KEYS: readonly string[];
export const REASON_KEYS: readonly string[];
export const REQUIRED_IDENTITY_KEYS: readonly string[];
export const TARGET_COUNT_KEYS: readonly string[];

export function C(...args: any[]): any;
export function D(...args: any[]): any;
export function H(...args: any[]): any;

export function activateMigrationInTransaction(...args: any[]): any;
export function assertSupportedCutoverNamespace(...args: any[]): any;
export function checkMutationGuardInTransaction(...args: any[]): any;
export function checkV3MutationGuardInTransaction(...args: any[]): any;
export function claimUpstreamGrantInTransaction(...args: any[]): any;
export function computeEstimatedFirestoreDocSize(...args: any[]): any;
export function computeKeyedDocId(...args: any[]): any;
export function computeLogicalInventoryDigest(...args: any[]): any;
export function computePlanDigest(...args: any[]): any;
export function computeReceiptSetDigest(...args: any[]): any;
export function computeSourceInventoryDigest(...args: any[]): any;
export function computeSourceRecordDigest(...args: any[]): any;
export function computeTargetInventoryDigest(...args: any[]): any;
export function computeTargetRecordDigest(...args: any[]): any;
export function finalizeMigrationInTransaction(...args: any[]): any;
export function getCutoverDistinctCollectionNames(...args: any[]): any;
export function getCutoverFenceDocRef(db: FirestoreLike | any, namespace: string): any;
export function getCutoverFenceRecord(db: FirestoreLike | any, namespace: string): Promise<CutoverFenceControlRecord | undefined>;
export function getCutoverOperationDocRef(...args: any[]): any;
export function initializeCutoverFence(...args: any[]): Promise<CutoverFenceControlRecord>;
export function isLegacyMutationPermittedInTransaction(...args: any[]): any;
export function isSupportedCutoverNamespace(...args: any[]): boolean;
export function isTargetFormatRow(...args: any[]): any;
export function markIrreversibleInTransaction(...args: any[]): any;
export function markOperationAmbiguous(...args: any[]): any;
export function parseCutoverFenceRecord(data: unknown, namespace: string): CutoverFenceControlRecord;
export function prepareMigrationInTransaction(...args: any[]): any;
export function readCutoverFenceInTransaction(...args: any[]): Promise<CutoverFenceControlRecord>;
export function reconcileUpstreamGrantInTransaction(...args: any[]): any;
export function releaseLegacyOperation(...args: any[]): any;
export function startMonotonicTimer(...args: any[]): any;
export function transitionCutoverFenceState(...args: any[]): Promise<CutoverFenceControlRecord>;
export function validateCompleteMigrationPlan(...args: any[]): any;
export function validateMigrationIdentityFields(...args: any[]): any;
export function validateReceipt(...args: any[]): any;
export function withLegacyOperation(...args: any[]): any;
