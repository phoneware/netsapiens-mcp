// Protocol entrypoint per FenceContractReset Section 1 & Section 2
// Public bundle exposes only necessary C9/C10 + high-level migration operations;
// low-level migration/projector/write-plan APIs remain internal.

// Canonical C9/C10 runtime exports & state rules
export {
  SUPPORTED_CUTOVER_NAMESPACES,
  isSupportedCutoverNamespace,
  assertSupportedCutoverNamespace,
  startMonotonicTimer,
  parseCutoverFenceRecord,
  readCutoverFenceInTransaction,
  getCutoverFenceRecord,
  initializeCutoverFence,
  transitionCutoverFenceState,
  getCutoverFenceDocRef,
  getCutoverOperationsColRef,
  getCutoverOperationDocRef,
  markIrreversibleInTransaction,
  withLegacyOperation,
  releaseLegacyOperation,
  markOperationAmbiguous,
  checkMutationGuardInTransaction,
  isLegacyMutationPermittedInTransaction,
  claimUpstreamGrantInTransaction,
  reconcileUpstreamGrantInTransaction,
} from './canonical-core.mjs';

// Errors
export {
  CutoverFenceError,
  CutoverRefusedError,
  isCutoverFenceError,
  isCutoverRefusedError,
} from '../store/errors.js';

// Use the same root derivation as the store; do not duplicate its HKDF.
export { deriveStoreKey } from '../store/codec.js';

// High-level Migration Operations
export {
  assertValidMigrationContext,
  inspectFirestoreLegacyMigration,
  adoptFirestoreLegacyTokens,
  activateFirestoreMigration,
  verifyActiveFirestoreMigration,
  getFirestoreMigrationStatus,
} from '../store/firestore-migration-engine.js';

// Runner-only zero-selector factory. lib.ts must never re-export it.
export { createProtectedFirestoreMigrationContext } from '../store/protected-migration-context.js';
