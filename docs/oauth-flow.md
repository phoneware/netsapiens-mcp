# OAuth flow

Step by step, what happens between an AI client and NetSapiens when a user connects. Back to the [README](../README.md).

1. AI client hits `GET /.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server` for discovery.
2. AI client POSTs `/register` (RFC 7591 DCR). Public clients pass `token_endpoint_auth_method=none` and get back a `client_id` only; confidential clients get `client_id` + `client_secret`. Registrations persist in Firestore.
3. AI redirects the user's browser to `/authorize?...` with PKCE parameters. The server stores the pending request in a signed cookie (`mcp_pending_auth`, 15 min TTL) and renders the login page.
4. User submits credentials → server hits `POST {NS}/ns-api/v2/tokens` (password grant). If NS responds with `mfa_type`/`mfa_vendor`, the server stores the partial state in `mcp_mfa_challenge` and prompts for a passcode.
5. On success, the server issues an authorization code and redirects back to the AI client. Cookies are cleared.
6. AI exchanges the code at `/token` for our MCP-issued bearer + refresh token. The upstream NS token is stored alongside.
7. On every `/mcp` request, the server verifies the bearer, transparently refreshes the upstream NS token if it's within 60s of expiry, and forwards the request through the right NS handler.
