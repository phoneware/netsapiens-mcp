// Runtime
export { NetSapiensClient } from './netsapiens-client.js';
export { CURATED_CATALOG } from './tools/curated/catalog.js';
export { withStructuredContent } from './tools/index.js';
export { NetSapiensAuthProvider } from './auth/netsapiens-auth-provider.js';
export { FirestoreTokenStore, FirestoreClientsStore, FirestoreAuthCodeStore } from './auth/firestore-stores.js';
export { LoopbackTolerantClientsStore } from './auth/loopback-redirect.js';
export { negotiateProtocolVersion } from './http/protocol-version.js';
export { nsScopeToTier, ROLE_HIERARCHY } from './auth/roles.js';

// Types
export type { GenericApiClient } from './generated/types.js';
export type { CuratedTool, CuratedResult } from './tools/curated/types.js';
export type { UserRole } from './auth/roles.js';
export type { StoredToken, NetSapiensAuthProviderOptions, AuthHooks, LoginDecision, NsUserSnapshot } from './auth/types.js';
export type { ContentKind, FieldClass, FieldRule, OutputDeclaration, ToolTargets, NsResourceName } from './governance/types.js';
