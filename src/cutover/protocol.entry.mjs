// Protocol entrypoint per FenceContractReset Section 1

// Canonical Core schemas, hashing, constants, and C9/C10 operations from canonical-core
export {
  SUPPORTED_CUTOVER_NAMESPACES,
  isSupportedCutoverNamespace,
  assertSupportedCutoverNamespace,
  PHYSICAL_COUNT_KEYS,
  TARGET_COUNT_KEYS,
  CLASSIFICATION_KEYS,
  REASON_KEYS,
  ALLOWED_STATE_TRANSITIONS,
  REQUIRED_IDENTITY_KEYS,
  REQUIRED_OWNERSHIP_MARKER_KEYS,
  REQUIRED_PREPARED_MANIFEST_KEYS,
  REQUIRED_FINAL_MANIFEST_KEYS,
  REQUIRED_CANDIDATE_KEYS,
  REQUIRED_RECEIPT_KEYS,
  APPROVED_GRAPH_PROJECTOR_ID,
  APPROVED_GRAPH_PROJECTOR_VERSION,
  NONEMPTY_PROJECTOR_KEYS,
  getCutoverDistinctCollectionNames,
  getSourceCollectionAllowlist,
  getTargetCollectionAllowlist,
  isTargetFormatRow,
  computeKeyedDocId,
  computeSourceRecordDigest,
  computeTargetRecordDigest,
  computeSourceInventoryDigest,
  computeTargetInventoryDigest,
  computeLogicalInventoryDigest,
  computeManifestDigest,
  computeProtocolDigest,
  computeEstimatedFirestoreDocSize,
  validateMigrationPreflightLimits,
  validateProspectiveDocBudget,
  validateTransactionBudgetPlan,
  validateCompleteMigrationPlan,
  validateCandidateCommitments,
  validateReceipt,
  computeReceiptDigest,
  computeReceiptSetDigest,
  computePlanDigest,
  parseCutoverFenceRecord,
  readCutoverFenceInTransaction,
  getCutoverFenceRecord,
  initializeCutoverFence,
  validateMigrationIdentityFields,
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
  prepareMigrationInTransaction,
  finalizeMigrationInTransaction,
  activateMigrationInTransaction,
  stripUndefined,
  normalizeValue,
  rfc8785CanonicalJson,
  C,
  canonicalJsonStringify,
  deriveKey,
  frame,
  D,
  H,
} from './canonical-core.mjs';

// Errors
export {
  CutoverFenceError,
  CutoverRefusedError,
  isCutoverFenceError,
  isCutoverRefusedError,
  StoreConfigError,
  StoreLockedError,
  RetryableRefreshError,
  LeaseLostError,
  StoreUnavailableError,
} from '../store/errors.js';

// Format & Timers
export {
  ACCESS_RETENTION_MS,
  SESSION_RETENTION_MS,
  REFRESH_RETRY_WINDOW_MS,
  MAX_RETIRED_REFRESH_FINGERPRINTS,
  AUTH_CODE_TTL_MS,
  RESUME_TOKEN_TTL_MS,
  REFRESH_WAIT_MS,
  REFRESH_POLL_MS,
  REFRESH_LEASE_MS,
  REFRESH_SKEW_MS,
  accessAad,
  refreshAad,
  familyAad,
  upstreamAad,
  sessionAad,
  codeUnitCompare,
  compareDescriptors,
  safeDocEntry,
  startMonotonicTimer,
} from '../store/row-format.js';

// Codec
export {
  createCodec,
  deriveStoreKey,
} from '../store/codec.js';

// Row Encoders / Decoders
export {
  encodeSessionsRow,
  decodeSessionsRow,
  encodeRefreshFamiliesRow,
  decodeRefreshFamiliesRow,
  encodeUpstreamRow,
  decodeUpstreamRow,
  encodeRefreshRow,
  encodeAuthCodesRow,
  encodeResumeTokensRow,
  encodeOAuthClientsRow,
} from '../store/row-codec.js';

// Projector
export {
  PROJECTOR_ID,
  PROJECTOR_VERSION,
  getTimestampMs,
  projectSourceLogical,
  projectTargetLogical,
  sanitizeId,
} from '../store/netsapiens-projector.mjs';

// High-level Migration Engine
export {
  assertValidMigrationContext,
  inspectFirestoreLegacyMigration,
  adoptFirestoreLegacyTokens,
  activateFirestoreMigration,
  getFirestoreMigrationStatus,
  extractCandidatesAndPlan,
} from '../store/firestore-migration-engine.js';
