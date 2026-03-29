/**
 * OAuth 2.1 Server Provider for the NetSapiens MCP Server.
 *
 * Wraps NetSapiens' password-grant OAuth in a standard authorization-code
 * flow so that MCP clients see a normal browser-redirect login experience.
 * User credentials are entered in a login page served by *this* server and
 * never pass through the MCP transport or LLM context.
 *
 * Env vars consumed (all set by the server operator):
 *   NETSAPIENS_API_URL          – upstream NS API base URL
 *   NETSAPIENS_OAUTH_CLIENT_ID  – NS OAuth client ID
 *   NETSAPIENS_OAUTH_CLIENT_SECRET – NS OAuth client secret
 */

import { randomUUID, randomBytes, createHash } from 'node:crypto';
import type { Response } from 'express';
import axios from 'axios';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { TokenStore } from './token-store.js';
import type { StoredToken } from './token-store.js';
import { mapNsScope } from './roles.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PendingAuthorization {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  state?: string;
  scopes?: string[];
  resource?: URL;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// In-memory clients store (supports dynamic registration)
// ---------------------------------------------------------------------------

class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): OAuthClientInformationFull {
    const clientId = randomUUID();
    const clientSecret = randomBytes(32).toString('hex');
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.clients.set(clientId, full);
    return full;
  }
}

// ---------------------------------------------------------------------------
// Login page HTML
// ---------------------------------------------------------------------------

function loginPageHtml(authorizeUrl: string, error?: string): string {
  const errorHtml = error
    ? `<div class="error">${escapeHtml(error)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NetSapiens MCP — Sign In</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           background: #f5f5f5; display: flex; justify-content: center; align-items: center;
           min-height: 100vh; }
    .card { background: #fff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,.1);
            padding: 2rem; width: 100%; max-width: 400px; }
    h1 { font-size: 1.25rem; margin-bottom: 1.5rem; text-align: center; }
    label { display: block; font-size: 0.875rem; font-weight: 500; margin-bottom: 0.25rem; }
    input { width: 100%; padding: 0.5rem 0.75rem; border: 1px solid #ccc; border-radius: 4px;
            font-size: 0.9rem; margin-bottom: 1rem; }
    input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,.2); }
    button { width: 100%; padding: 0.6rem; background: #2563eb; color: #fff; border: none;
             border-radius: 4px; font-size: 0.95rem; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    .error { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca;
             border-radius: 4px; padding: 0.5rem 0.75rem; margin-bottom: 1rem; font-size: 0.85rem; }
    .footer { text-align: center; margin-top: 1rem; font-size: 0.75rem; color: #888; }
  </style>
</head>
<body>
  <div class="card">
    <h1>NetSapiens MCP — Sign In</h1>
    ${errorHtml}
    <form method="POST" action="${escapeHtml(authorizeUrl)}">
      <label for="username">Username</label>
      <input type="text" id="username" name="username" required autocomplete="username" autofocus>
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autocomplete="current-password">
      <button type="submit">Sign In</button>
    </form>
    <div class="footer">Credentials are sent directly to the server, never to the AI.</div>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export interface NetSapiensAuthProviderOptions {
  /** Upstream NetSapiens API URL (e.g. https://edge.phoneware.cloud) */
  nsApiUrl: string;
  /** NS OAuth client_id (operator-provisioned) */
  nsClientId: string;
  /** NS OAuth client_secret (operator-provisioned) */
  nsClientSecret: string;
  /** Token lifetime in seconds (default 3600) */
  tokenLifetimeSec?: number;
  /** Path to the token store file (default ~/.netsapiens-mcp/http-tokens.json) */
  tokenStorePath?: string;
}

export class NetSapiensAuthProvider implements OAuthServerProvider {
  private _clientsStore = new InMemoryClientsStore();
  private pendingAuths = new Map<string, PendingAuthorization>();
  private authCodes = new Map<string, { pending: PendingAuthorization; nsTokens: NsTokenResponse }>();
  private tokenStore: TokenStore;

  private nsApiUrl: string;
  private nsClientId: string;
  private nsClientSecret: string;
  private tokenLifetimeSec: number;

  constructor(options: NetSapiensAuthProviderOptions) {
    this.nsApiUrl = options.nsApiUrl;
    this.nsClientId = options.nsClientId;
    this.nsClientSecret = options.nsClientSecret;
    this.tokenLifetimeSec = options.tokenLifetimeSec ?? 3600;
    this.tokenStore = new TokenStore(options.tokenStorePath);
  }

  /** Number of active tokens in the store. */
  get activeTokenCount(): number {
    return this.tokenStore.size;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  // -----------------------------------------------------------------------
  // authorize — show login page (GET) or handle form submission (POST)
  // -----------------------------------------------------------------------

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // Store the pending authorization so we can pick it up on form POST
    const authId = randomUUID();

    this.pendingAuths.set(authId, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      state: params.state,
      scopes: params.scopes,
      resource: params.resource,
      createdAt: Date.now(),
    });

    // The form POSTs to /login with the authId, which our Express route handles
    const loginUrl = `/login?auth_id=${authId}`;
    const html = loginPageHtml(loginUrl);
    res.status(200).type('html').send(html);
  }

  /**
   * Called by our custom POST /login route after the user submits credentials.
   * Runs the password grant against NetSapiens, generates an authorization code,
   * and redirects back to the MCP client.
   */
  async handleLogin(authId: string, username: string, password: string, res: Response): Promise<void> {
    const pending = this.pendingAuths.get(authId);
    if (!pending) {
      res.status(400).type('html').send(loginPageHtml(`/login?auth_id=${authId}`, 'Session expired. Please try again.'));
      return;
    }

    // Run NS password grant
    let nsTokens: NsTokenResponse;
    try {
      nsTokens = await this.nsPasswordGrant(username, password);
    } catch (err: any) {
      const msg = err.message?.includes('401')
        ? 'Invalid username or password.'
        : `Authentication failed: ${err.message}`;
      res.status(200).type('html').send(loginPageHtml(`/login?auth_id=${authId}`, msg));
      return;
    }

    // Detect user role from the NS API
    let nsUserRole: string | undefined;
    try {
      nsUserRole = await this.detectNsUserRole(nsTokens.access_token);
    } catch (err) {
      logger.warn('Failed to detect user role, defaulting to user', { error: String(err) });
    }

    // Generate authorization code
    const code = randomBytes(32).toString('hex');
    this.authCodes.set(code, { pending, nsTokens: { ...nsTokens, username, nsUserRole } });
    this.pendingAuths.delete(authId);

    // Expire the code after 5 minutes
    setTimeout(() => this.authCodes.delete(code), 5 * 60 * 1000);

    // Redirect back to the MCP client
    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (pending.state) {
      redirectUrl.searchParams.set('state', pending.state);
    }
    res.redirect(redirectUrl.toString());
  }

  // -----------------------------------------------------------------------
  // Token exchange
  // -----------------------------------------------------------------------

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const entry = this.authCodes.get(authorizationCode);
    if (!entry) {
      throw new Error('Invalid authorization code');
    }
    return entry.pending.codeChallenge;
  }

  async exchangeAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const entry = this.authCodes.get(authorizationCode);
    if (!entry) {
      throw new Error('Invalid authorization code');
    }
    this.authCodes.delete(authorizationCode);

    return this.issueTokens(entry.pending.clientId, entry.nsTokens);
  }

  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshToken: string,
  ): Promise<OAuthTokens> {
    const stored = this.tokenStore.getByRefreshToken(refreshToken);
    if (!stored) {
      throw new Error('Invalid refresh token');
    }

    // Try to refresh the upstream NS token if we have a refresh token
    let nsTokens: NsTokenResponse;
    if (stored.nsRefreshToken) {
      try {
        nsTokens = await this.nsRefreshGrant(stored.nsRefreshToken);
        nsTokens.username = stored.nsUsername;
        nsTokens.nsUserRole = stored.nsUserRole;
      } catch {
        throw new Error('Upstream token refresh failed. Please re-authenticate.');
      }
    } else {
      throw new Error('No upstream refresh token available. Please re-authenticate.');
    }

    // Remove old tokens
    this.tokenStore.delete(stored.accessToken);

    return this.issueTokens(stored.clientId, nsTokens);
  }

  // -----------------------------------------------------------------------
  // Token verification
  // -----------------------------------------------------------------------

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = this.tokenStore.get(token);
    if (!stored) {
      throw new Error('Invalid access token');
    }

    if (Date.now() > stored.expiresAt) {
      this.tokenStore.delete(token);
      throw new Error('Access token expired');
    }

    return {
      token,
      clientId: stored.clientId,
      scopes: [],
      expiresAt: Math.floor(stored.expiresAt / 1000),
      extra: {
        nsAccessToken: stored.nsAccessToken,
        nsUsername: stored.nsUsername,
        nsUserRole: stored.nsUserRole,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Revocation
  // -----------------------------------------------------------------------

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const { token } = request;

    // Check if it's an access token
    const stored = this.tokenStore.get(token);
    if (stored) {
      this.tokenStore.delete(token);
      return;
    }

    // Check if it's a refresh token
    const byRefresh = this.tokenStore.getByRefreshToken(token);
    if (byRefresh) {
      this.tokenStore.deleteByRefreshToken(token);
    }
  }

  // -----------------------------------------------------------------------
  // Lookup: get the upstream NS access token for a verified MCP token
  // -----------------------------------------------------------------------

  getNsAccessToken(mcpToken: string): string | undefined {
    return this.tokenStore.get(mcpToken)?.nsAccessToken;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private issueTokens(clientId: string, nsTokens: NsTokenResponse): OAuthTokens {
    const accessToken = randomBytes(32).toString('hex');
    const refreshToken = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + this.tokenLifetimeSec * 1000;

    const stored: StoredToken = {
      accessToken,
      refreshToken,
      clientId,
      expiresAt,
      nsAccessToken: nsTokens.access_token,
      nsRefreshToken: nsTokens.refresh_token,
      nsUsername: nsTokens.username,
      nsUserRole: nsTokens.nsUserRole,
    };

    this.tokenStore.set(stored);

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.tokenLifetimeSec,
      refresh_token: refreshToken,
    };
  }

  private async nsPasswordGrant(username: string, password: string): Promise<NsTokenResponse> {
    const response = await axios.post(
      `${this.nsApiUrl}/ns-api/oauth2/token/`,
      new URLSearchParams({
        client_id: this.nsClientId,
        client_secret: this.nsClientSecret,
        username,
        password,
        grant_type: 'password',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    return {
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token,
      expires_in: response.data.expires_in,
      username,
    };
  }

  private async detectNsUserRole(nsAccessToken: string): Promise<string | undefined> {
    try {
      const response = await axios.get(`${this.nsApiUrl}/ns-api/v2/domains/~/users/~`, {
        headers: { Authorization: `Bearer ${nsAccessToken}` },
      });
      const data = response.data;
      // NetSapiens returns role info in user-scope, scope, or type fields
      const scope = data?.['user-scope'] ?? data?.scope ?? data?.type;
      const role = mapNsScope(scope);
      logger.info('Detected NS user role', { scope, role });
      return role;
    } catch (err) {
      logger.warn('NS role detection API call failed', { error: String(err) });
      return undefined;
    }
  }

  private async nsRefreshGrant(nsRefreshToken: string): Promise<NsTokenResponse> {
    const response = await axios.post(
      `${this.nsApiUrl}/ns-api/oauth2/token/`,
      new URLSearchParams({
        client_id: this.nsClientId,
        client_secret: this.nsClientSecret,
        refresh_token: nsRefreshToken,
        grant_type: 'refresh_token',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    return {
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token,
      expires_in: response.data.expires_in,
      username: '', // caller fills this in
    };
  }
}

interface NsTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  username: string;
  nsUserRole?: string;
}
