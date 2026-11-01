# Changelog

All notable changes to this project will be documented in this file.

## 3.0.0

### Breaking Changes

- Node floor: Node 22.13 or later is now required.
- Explicit NetSapiens configuration: `NETSAPIENS_API_URL` is required. The server never falls back to hardcoded default URLs.
- Storage architecture:
  - `store` parameter is now required when instantiating `NetSapiensAuthProvider`.
  - Default store is SQLite with encrypted credentials at rest.
  - `@google-cloud/firestore` is moved to optional peer dependencies. If using `MCP_PERSISTENCE=firestore`, install `@google-cloud/firestore` in the consumer environment.
  - Legacy file token storage (`http-tokens.json` and `MCP_PERSISTENCE=file`) has been removed.
  - `GOOGLE_CLOUD_PROJECT` no longer auto-selects Firestore; set `MCP_PERSISTENCE=firestore` explicitly.
  - `MCP_TOKEN_STORE_PATH`, `FIRESTORE_AUTH_CODES_COLLECTION`, and `FIRESTORE_RESUME_TOKENS_COLLECTION` are removed. Use `MCP_STORE_PATH` and `MCP_STORE_NAMESPACE`.
  - Upgrading to 3.0.0 requires users to sign in again because the encrypted session store format is updated.
- Removed library exports: legacy store implementations (`FirestoreTokenStore`, `FirestoreAuthCodeStore`, and file-based token stores) have been removed. Use `createStore`, `createSqliteStore`, `createFirestoreStore`, or `createMemoryStore`.
- Tool availability:
  - Version-aware tool filtering: tools are now gated based on the target NetSapiens host version.
  - NetSapiens 45.0 and 46.0 tools follow published API documentation.
- Corrected transfer_call semantics:
  - `type: "peer"` is removed because it invoked an undocumented route.
  - Attended transfer now accepts `consult_call_id`, looks up `core-server` and `call-session-id`, and bridges call legs.
  - Blind transfer sends `to` using the documented `call-term-user` parameter.
- AuthHooks: onVerify now also runs during refresh-token exchange before any upstream refresh grant. If onVerify throws InvalidTokenError, the session is deleted and the client receives 400 invalid_grant. Other errors preserve the session and return 500 server_error.

### Features

- Encrypted default storage using SQLite on local disk with 0600 file mode.
- Distributed persistence support via Firestore with Cloud Firestore TTL policies.
- Role-aware tool visibility and execution gating across all supported NetSapiens versions.
- Guarded client layer preventing invocation of unsupported routes.
- Streamable HTTP and stdio transports with OAuth 2.1 authorization code flow and PKCE.
