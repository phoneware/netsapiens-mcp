export {
  SUPPORTED_CUTOVER_NAMESPACES, assertSupportedCutoverNamespace,
  checkMutationGuardInTransaction, claimUpstreamGrantInTransaction,
  getCutoverFenceDocRef, getCutoverFenceRecord, getCutoverOperationDocRef,
  getCutoverOperationsColRef, initializeCutoverFence, isLegacyMutationPermittedInTransaction,
  isSupportedCutoverNamespace, markIrreversibleInTransaction, markOperationAmbiguous,
  parseCutoverFenceRecord, readCutoverFenceInTransaction, reconcileUpstreamGrantInTransaction,
  releaseLegacyOperation, startMonotonicTimer, transitionCutoverFenceState, withLegacyOperation,
  CutoverFenceError, CutoverRefusedError, isCutoverFenceError, isCutoverRefusedError,
} from '../cutover/canonical-core.mjs';
export type {
  SupportedCutoverNamespace, CutoverFenceState, CutoverFenceControlRecord, CutoverFenceConfig,
  LegacyOperationPhase, LegacyOperationRecord, LegacyOperationContext, LegacyOperationMetadata,
  InitializeCutoverFenceOptions, CutoverTransitionParams, WithLegacyOperationOptions,
  GuardMutationOptions, GuardMutationResult, MonotonicTimer, PendingClaim,
  ClaimUpstreamGrantOptions, ReconcileUpstreamGrantOptions,
} from '../cutover/canonical-core.mjs';
export { deriveStoreKey } from './codec.js';
export {
  activateFirestoreMigration, adoptFirestoreLegacyTokens, assertValidMigrationContext,
  getFirestoreMigrationStatus, inspectFirestoreLegacyMigration, verifyActiveFirestoreMigration,
} from './firestore-migration-engine.js';
export { createProtectedFirestoreMigrationContext } from './protected-migration-context.js';
