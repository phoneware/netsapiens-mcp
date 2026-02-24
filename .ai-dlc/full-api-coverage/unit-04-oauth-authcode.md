---
status: pending
depends_on: []
branch: ai-dlc/full-api-coverage/04-oauth-authcode
discipline: backend
ticket: ""
---

# unit-04: OAuth Authorization Code Flow

## Description
Add OAuth2 Authorization Code flow to the MCP server so users can authenticate via browser redirect instead of storing username/password in environment variables. When the server starts without stored tokens and auth code flow is configured, it opens the user's browser to the NetSapiens authorize endpoint, receives the auth code via a local callback server, and exchanges it for access + refresh tokens.

## Discipline
backend - This unit will be executed by backend-focused agents.

## Domain Entities
- **OAuthManager** (existing `src/oauth-manager.ts`): Extended to support authorization code flow
- **AccessToken** (from OpenAPI schema): `access_token`, `refresh_token`, `expires_in`, `token_type`, `scope`, `client_id`
- **AuthRequest** (from OpenAPI schema): `grant_type`, `client_id`, `client_secret`, `username`, `password`
- **Auth Code Exchange**: `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `client_secret`

## Data Sources
- **Existing**: `src/oauth-manager.ts` (201 lines) — current OAuth password grant implementation
- **Existing**: `src/types/config.ts` — `NetSapiensOAuthConfig` type
- **NetSapiens OAuth endpoints**:
  - Authorize: `GET {apiUrl}/ns-api/oauth2/authorize?client_id=X&redirect_uri=Y&response_type=code&scope=Z`
  - Token: `POST {apiUrl}/ns-api/oauth2/token/` with `grant_type=authorization_code&code=X&redirect_uri=Y&client_id=X&client_secret=Y`
  - Refresh: `POST {apiUrl}/ns-api/oauth2/token/` with `grant_type=refresh_token&refresh_token=X&client_id=X&client_secret=Y`

## Technical Specification

### Auth Method Detection
When the server starts, determine which auth method to use based on available configuration:

1. **If stored tokens exist** (in `~/.netsapiens-mcp/oauth-tokens.json`) and are still valid or refreshable → use them
2. **If `NETSAPIENS_OAUTH_CLIENT_ID` + `NETSAPIENS_OAUTH_CLIENT_SECRET` are set but NO `NETSAPIENS_OAUTH_USERNAME`/`PASSWORD`** → use Authorization Code flow
3. **If all 4 OAuth env vars are set** (client_id, client_secret, username, password) → use Password Grant (existing behavior)
4. **If `NETSAPIENS_API_TOKEN` is set** → use static token
5. **If none** → throw configuration error

### Authorization Code Flow Implementation

#### Step 1: Start Local Callback Server
```typescript
// Start HTTP server on a random available port
const server = http.createServer();
server.listen(0); // OS assigns available port
const port = (server.address() as AddressInfo).port;
const redirectUri = `http://localhost:${port}/callback`;
```

#### Step 2: Open Browser
```typescript
// Construct authorize URL
const authorizeUrl = new URL(`${apiUrl}/ns-api/oauth2/authorize`);
authorizeUrl.searchParams.set('client_id', clientId);
authorizeUrl.searchParams.set('redirect_uri', redirectUri);
authorizeUrl.searchParams.set('response_type', 'code');
// Optional: authorizeUrl.searchParams.set('scope', scope);

// Open in default browser
// Use 'open' package or child_process: open(authorizeUrl.toString())
```

Print a message to stderr (not stdout, since MCP uses stdout):
```
Authorization required. Opening browser...
If the browser doesn't open, visit: {authorizeUrl}
```

#### Step 3: Wait for Callback
```typescript
// Handle GET /callback?code=XXX
server.on('request', (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (code) {
      // Show success page in browser
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>Authorization successful!</h1><p>You can close this window.</p></body></html>');
      // Resolve the promise with the code
    } else {
      // Show error page
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<html><body><h1>Authorization failed</h1><p>${error}</p></body></html>`);
      // Reject the promise
    }
    server.close();
  }
});
```

Add a timeout (e.g., 120 seconds) — if the user doesn't complete auth, fail gracefully.

#### Step 4: Exchange Code for Tokens
```typescript
// POST to token endpoint
const tokenResponse = await axios.post(`${apiUrl}/ns-api/oauth2/token/`, {
  grant_type: 'authorization_code',
  code: authCode,
  redirect_uri: redirectUri,
  client_id: clientId,
  client_secret: clientSecret,
});
```

#### Step 5: Store Tokens
Use the existing token storage mechanism (`~/.netsapiens-mcp/oauth-tokens.json`, mode 0600).

### Updated OAuthManager Interface
```typescript
class OAuthManager {
  // Existing
  async getAccessToken(): Promise<string>;

  // New: determines auth method and authenticates
  async authenticate(): Promise<void>;

  // New: authorization code flow
  private async authenticateWithAuthCode(): Promise<void>;

  // Existing: password grant
  private async authenticateWithPassword(): Promise<void>;

  // Existing: token refresh
  private async refreshAccessToken(): Promise<void>;
}
```

### Configuration Changes
Update `src/types/config.ts`:
```typescript
interface NetSapiensOAuthConfig {
  clientId: string;
  clientSecret: string;
  // These become optional (not needed for auth code flow)
  username?: string;
  password?: string;
}
```

Update `getConfig()` in the server entry point:
- Don't require username/password if only client_id and client_secret are provided
- The OAuthManager detects the flow based on what's available

### Browser Opening
Use Node.js built-in or a minimal approach:
- macOS: `child_process.exec('open "URL"')`
- Linux: `child_process.exec('xdg-open "URL"')`
- Windows: `child_process.exec('start "URL"')`

Detect platform via `process.platform`.

## Success Criteria
- [ ] When client_id + client_secret are set without username/password, the auth code flow is triggered
- [ ] A local HTTP server starts on a random port for the OAuth callback
- [ ] The user's browser opens to the NetSapiens authorize URL
- [ ] After browser authentication, the auth code is captured at the callback
- [ ] The auth code is exchanged for access + refresh tokens
- [ ] Tokens are stored in `~/.netsapiens-mcp/oauth-tokens.json` (mode 0600)
- [ ] On subsequent starts, stored tokens are reused (no re-authentication needed)
- [ ] Token refresh works automatically when the access token expires
- [ ] Password grant flow still works when username/password are provided (backward compatibility)
- [ ] API token fallback still works when only `NETSAPIENS_API_TOKEN` is set

## Risks
- **Authorize endpoint URL**: The exact NetSapiens OAuth authorize URL may vary by instance or version. Mitigation: use the pattern `{apiUrl}/ns-api/oauth2/authorize` which is the standard NetSapiens convention. If it differs, the user can set `NETSAPIENS_OAUTH_AUTHORIZE_URL` as an override.
- **Port conflicts**: The random port approach should avoid conflicts, but firewalls may block localhost HTTP. Mitigation: try a few ports if the first fails.
- **Headless environments**: Docker/CI environments have no browser. Mitigation: print the URL to stderr and instruct the user to open it manually. Also, headless environments should use password grant or API token instead.
- **MFA**: If the NetSapiens instance requires MFA, the browser flow handles it natively (the user completes MFA in the browser). No special handling needed.

## Boundaries
This unit does NOT handle:
- Tool definitions or the MCP server architecture (Units 01, 02)
- The generic HTTP client (Unit 03) — this unit only provides tokens; the client consumes them
- JWT or API Key authentication methods from the spec — those are separate auth mechanisms not in scope

## Notes
- All console output during the OAuth flow MUST go to stderr (`console.error`), not stdout. MCP protocol uses stdout for JSON-RPC communication — any non-JSON output on stdout will break the protocol.
- The callback server should bind to `127.0.0.1` only (not `0.0.0.0`) for security.
- Consider adding a `--no-browser` flag or env var for environments where auto-opening the browser is undesirable.
