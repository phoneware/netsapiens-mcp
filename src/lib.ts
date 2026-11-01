// Runtime
export { NetSapiensClient } from './netsapiens-client.js';
export { CURATED_CATALOG } from './tools/curated/catalog.js';
export { withStructuredContent } from './tools/index.js';
export { NetSapiensAuthProvider } from './auth/netsapiens-auth-provider.js';
export { FirestoreTokenStore, FirestoreClientsStore, FirestoreAuthCodeStore } from './auth/firestore-stores.js';
export { LoopbackTolerantClientsStore } from './auth/loopback-redirect.js';
export { negotiateProtocolVersion } from './http/protocol-version.js';
export { nsScopeToTier, ROLE_HIERARCHY } from './auth/roles.js';
export { NS_RESOURCE_FIELDS } from './governance/ns-fields.generated.js';
export { scrubSecrets } from './governance/scrub.js';
export { resolveQueueAgent, resolveSelfIdentity } from './tools/curated/queue-agent.js';
export { requireBearer } from './auth/kit/bearer.js';
export {
  StoreUnavailableError,
  UpstreamUnavailableError,
  UpstreamRevokedError,
  kitCodeOf,
  classifyUpstreamTokenResponse,
  toTokenEndpointError,
} from './auth/kit/errors.js';
export { MemoryTokenLedger } from './auth/kit/ledger.js';
export type { TokenLedger } from './auth/kit/ledger.js';
export { FirestoreTokenLedger } from './auth/kit/firestore-ledger.js';
export { adoptClientMiddleware } from './auth/kit/adopt-client.js';
export { DEFAULT_REDIRECT_ALLOWLIST, isAllowedRedirectUri } from './auth/kit/redirect-policy.js';
export type { BaseStoredToken } from './auth/kit/ledger.js';

// Types
export type { GenericApiClient } from './generated/types.js';
export type { CuratedTool, CuratedResult } from './tools/curated/types.js';
export type { UserRole } from './auth/roles.js';
export type { StoredToken, NetSapiensAuthProviderOptions, AuthHooks, LoginDecision, NsUserSnapshot } from './auth/types.js';
export type { ContentKind, FieldClass, FieldRule, OutputDeclaration, ToolTargets, NsResourceName } from './governance/types.js';
export type { SelfIdentity, QueueAgentResolution } from './tools/curated/queue-agent.js';
