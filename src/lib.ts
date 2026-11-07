// Runtime
export { NetSapiensClient } from './netsapiens-client.js';
export { CURATED_CATALOG } from './tools/curated/catalog.js';
export { withStructuredContent } from './tools/index.js';
export {
  NetSapiensAuthProvider,
  signValue,
  inspectSigned,
  sealValue,
  openSealed,
  UpstreamGrantRejectedError,
  UpstreamTimeoutError,
  UpstreamUnavailableError,
} from './auth/netsapiens-auth-provider.js';
export { parsePlatforms } from './auth/platforms.js';
export type { NetSapiensPlatform } from './auth/platforms.js';
export { LoopbackTolerantClientsStore } from './auth/loopback-redirect.js';
export { negotiateProtocolVersion } from './http/protocol-version.js';
export { nsScopeToTier, ROLE_HIERARCHY } from './auth/roles.js';
export { NS_RESOURCE_FIELDS } from './governance/ns-fields.generated.js';
export { scrubSecrets } from './governance/scrub.js';
export { resolveQueueAgent, resolveSelfIdentity } from './tools/curated/queue-agent.js';

// Storage
export { createStore } from './store/store.js';
export { createSqliteStore } from './store/sqlite.js';
export { createFirestoreStore, createFirestoreBackend, firestoreCollections, FirestoreClientsStore } from './store/firestore.js';
export { createMemoryStore } from './store/memory.js';
export {
  adoptFirestoreLegacyTokens,
  verifyActiveFirestoreMigration,
  computeSourceInventoryDigest,
  ensureFirestoreAdopted,
  type CutoverFenceControlRecord,
  type CutoverFenceState,
  getCutoverFenceRecord,
  initializeCutoverFence,
  transitionCutoverFenceState,
  markIrreversibleInTransaction,
  getCutoverOperationDocRef,
  claimUpstreamGrantInTransaction,
  reconcileUpstreamGrantInTransaction,
  withLegacyOperation,
  releaseLegacyOperation,
  markOperationAmbiguous,
  checkMutationGuardInTransaction,
  isLegacyMutationPermittedInTransaction,
  CutoverFenceError,
  CutoverRefusedError,
} from './store/firestore-v2-adoption.js';
export { deriveStoreKey, StoreConfigError, StoreLockedError, RetryableRefreshError, LeaseLostError, StoreUnavailableError } from './store/codec.js';
export { startMonotonicTimer, getCutoverFenceDocRef, getCutoverOperationsColRef } from './cutover/canonical-core.mjs';
export type { FirestoreLike, TransactionLike, DocumentReferenceLike, QueryLike } from './store/firestore-like.js';

// Types
export type {
  LegacyOperationContext,
  WithLegacyOperationOptions,
  ClaimUpstreamGrantOptions,
  ReconcileUpstreamGrantOptions,
} from './cutover/canonical-core.mjs';
export type { GenericApiClient } from './generated/types.js';
export type { CuratedTool, CuratedResult } from './tools/curated/types.js';
export type { UserRole } from './auth/roles.js';
export type { NetSapiensAuthProviderOptions, AuthHooks, LoginDecision, NsUserSnapshot } from './auth/types.js';
export type {
  StoredToken,
  StoredSession,
  OAuthTokenPair,
  RefreshLookupResult,
  RefreshRotationResult,
  RevokeCondition,
  UpstreamTokens,
  AuthCodeData,
  UsageRecord,
  StoreCapabilities,
  SessionStore,
  AuthCodeStore,
  ResumeTokenStore,
  UsageStore,
  McpStore,
  StoreBackend,
  SessionRow,
  AuthCodeRow,
  ResumeRow,
} from './store/types.js';
export type { ContentKind, FieldClass, FieldRule, OutputDeclaration, ToolTargets, NsResourceName } from './governance/types.js';
export type { SelfIdentity, QueueAgentResolution } from './tools/curated/queue-agent.js';
