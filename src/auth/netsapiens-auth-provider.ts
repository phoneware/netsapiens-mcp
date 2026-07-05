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

import { randomUUID, randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
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
import type { StoredToken, TokenStoreLike } from './token-store.js';
import { FirestoreTokenStore } from './firestore-token-store.js';
import { FirestoreClientsStore } from './firestore-clients-store.js';
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
// Signed cookie helpers — used to keep OAuth-flow state stateless across
// container restarts and Cloud Run instance switches.
// ---------------------------------------------------------------------------

let sessionSecret: string | null = null;
function getSessionSecret(): string {
  if (sessionSecret) return sessionSecret;
  const fromEnv = process.env.MCP_SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) {
    sessionSecret = fromEnv;
  } else {
    sessionSecret = randomBytes(32).toString('hex');
    logger.warn('MCP_SESSION_SECRET not set; generated ephemeral signing key. Set this env var (>=16 chars) to keep login sessions valid across restarts and instances.');
  }
  return sessionSecret;
}

const PENDING_AUTH_COOKIE = 'mcp_pending_auth';
const MFA_CHALLENGE_COOKIE = 'mcp_mfa_challenge';

export function signValue<T>(payload: T, ttlSec: number): string {
  const data = { ...(payload as object), exp: Math.floor(Date.now() / 1000) + ttlSec };
  const json = Buffer.from(JSON.stringify(data));
  const b64 = json.toString('base64url');
  const sig = createHmac('sha256', getSessionSecret()).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

export function verifySigned<T>(token: string): T | null {
  try {
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const b64 = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = createHmac('sha256', getSessionSecret()).update(b64).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(b64, 'base64url').toString());
    if (typeof data.exp === 'number' && data.exp < Math.floor(Date.now() / 1000)) return null;
    delete data.exp;
    return data as T;
  } catch {
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function setSignedCookie(res: Response, name: string, value: string, maxAgeSec: number): void {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${maxAgeSec}`,
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
  ];
  res.append('Set-Cookie', attrs.join('; '));
}

function clearCookie(res: Response, name: string): void {
  res.append('Set-Cookie', `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`);
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
    // Honor the client's requested authentication method. Public clients
    // (token_endpoint_auth_method=none) get no secret — they rely on PKCE
    // alone, which is correct for browser/native apps like ChatGPT.
    const authMethod = (client as { token_endpoint_auth_method?: string }).token_endpoint_auth_method;
    const isPublic = authMethod === 'none';
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    if (!isPublic) {
      full.client_secret = randomBytes(32).toString('hex');
    }
    this.clients.set(clientId, full);
    return full;
  }
}

// ---------------------------------------------------------------------------
// Login page HTML
// ---------------------------------------------------------------------------

function logoHtml(): string {
  const url = process.env.MCP_LOGIN_LOGO_URL || process.env.MCP_ICON_URL;
  if (!url) return '';
  return `<div class="logo"><img src="${escapeHtml(url)}" alt=""></div>`;
}

function loginPageHtml(authorizeUrl: string, error?: string): string {
  const errorHtml = error
    ? `<div class="error">${escapeHtml(error)}</div>`
    : '';

  const heading = process.env.MCP_LOGIN_HEADER || 'NetSapiens MCP — Sign In';
  const safeHeading = escapeHtml(heading);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeHeading}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           background: #f5f5f5; display: flex; justify-content: center; align-items: center;
           min-height: 100vh; }
    .card { background: #fff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,.1);
            padding: 2rem; width: 100%; max-width: 400px; }
    .logo { text-align: center; margin-bottom: 1rem; }
    .logo img { max-width: 96px; max-height: 96px; height: auto; }
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
    ${logoHtml()}
    <h1>${safeHeading}</h1>
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

function mfaPageHtml(mfaUrl: string, mfaVendor: string | undefined, error?: string): string {
  const errorHtml = error
    ? `<div class="error">${escapeHtml(error)}</div>`
    : '';

  const heading = process.env.MCP_LOGIN_HEADER || 'NetSapiens MCP — Sign In';
  const safeHeading = escapeHtml(heading);
  const vendorHint = mfaVendor
    ? `<div class="hint">Enter the 6-digit code from your ${escapeHtml(mfaVendor)} authenticator.</div>`
    : `<div class="hint">Enter the 6-digit code from your authenticator app.</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeHeading} — MFA</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           background: #f5f5f5; display: flex; justify-content: center; align-items: center;
           min-height: 100vh; }
    .card { background: #fff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,.1);
            padding: 2rem; width: 100%; max-width: 400px; }
    .logo { text-align: center; margin-bottom: 1rem; }
    .logo img { max-width: 96px; max-height: 96px; height: auto; }
    h1 { font-size: 1.25rem; margin-bottom: 1rem; text-align: center; }
    .hint { font-size: 0.85rem; color: #555; text-align: center; margin-bottom: 1.25rem; }
    label { display: block; font-size: 0.875rem; font-weight: 500; margin-bottom: 0.25rem; }
    input { width: 100%; padding: 0.5rem 0.75rem; border: 1px solid #ccc; border-radius: 4px;
            font-size: 1.1rem; margin-bottom: 1rem; text-align: center; letter-spacing: 0.2em; }
    input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,.2); }
    button { width: 100%; padding: 0.6rem; background: #2563eb; color: #fff; border: none;
             border-radius: 4px; font-size: 0.95rem; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    .error { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca;
             border-radius: 4px; padding: 0.5rem 0.75rem; margin-bottom: 1rem; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="card">
    ${logoHtml()}
    <h1>${safeHeading}</h1>
    ${vendorHint}
    ${errorHtml}
    <form method="POST" action="${escapeHtml(mfaUrl)}">
      <label for="passcode">Authentication Code</label>
      <input type="text" id="passcode" name="passcode" inputmode="numeric" pattern="[0-9]*"
             maxlength="6" required autocomplete="one-time-code" autofocus>
      <button type="submit">Verify</button>
    </form>
  </div>
</body>
</html>`;
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

interface MfaChallenge {
  pending: PendingAuthorization;
  username: string;
  password: string;
  partialAccessToken: string;
  mfaType: string;
  mfaVendor: string;
  nsIdType: string;
}

export class NetSapiensAuthProvider implements OAuthServerProvider {
  private _clientsStore: OAuthRegisteredClientsStore;
  private authCodes = new Map<string, { pending: PendingAuthorization; nsTokens: NsTokenResponse }>();
  private tokenStore: TokenStoreLike;

  private nsApiUrl: string;
  private nsClientId: string;
  private nsClientSecret: string;
  private tokenLifetimeSec: number;

  // In-flight upstream NS refreshes keyed by MCP bearer. NS rotates refresh
  // tokens, so two concurrent refreshes for the same bearer means the second
  // one presents an already-consumed refresh token and fails — concurrent
  // verifies must share a single refresh instead.
  private nsRefreshInflight = new Map<string, Promise<void>>();

  constructor(options: NetSapiensAuthProviderOptions) {
    this.nsApiUrl = options.nsApiUrl;
    this.nsClientId = options.nsClientId;
    this.nsClientSecret = options.nsClientSecret;
    this.tokenLifetimeSec = options.tokenLifetimeSec ?? 3600;

    // Pick persistence backend: Firestore when MCP_PERSISTENCE=firestore
    // (or when GOOGLE_CLOUD_PROJECT is set, the most common Cloud Run signal),
    // otherwise the in-process file-backed store.
    const useFirestore = process.env.MCP_PERSISTENCE === 'firestore'
      || (process.env.MCP_PERSISTENCE !== 'file' && !!process.env.GOOGLE_CLOUD_PROJECT);

    if (useFirestore) {
      this.tokenStore = new FirestoreTokenStore({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
      this._clientsStore = new FirestoreClientsStore({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
      logger.info('Auth provider using Firestore persistence');
    } else {
      this.tokenStore = new TokenStore(options.tokenStorePath);
      this._clientsStore = new InMemoryClientsStore();
      logger.info('Auth provider using file-backed token store + in-memory clients store');
    }
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
    // Pack the pending authorization into a signed cookie so it survives
    // container restarts, scaling events, and Cloud Run instance switches.
    const pending: PendingAuthorization = {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      state: params.state,
      scopes: params.scopes,
      resource: params.resource,
      createdAt: Date.now(),
    };
    const cookie = signValue(pending, 15 * 60); // 15 min TTL
    setSignedCookie(res, PENDING_AUTH_COOKIE, cookie, 15 * 60);

    const html = loginPageHtml('/login');
    res.status(200).type('html').send(html);
  }

  /**
   * Called by our custom POST /login route after the user submits credentials.
   * Runs the password grant against NetSapiens, generates an authorization code,
   * and redirects back to the MCP client.
   */
  async handleLogin(req: Request, res: Response, username: string, password: string): Promise<void> {
    const cookies = parseCookies(req.headers.cookie);
    const pending = cookies[PENDING_AUTH_COOKIE]
      ? verifySigned<PendingAuthorization>(cookies[PENDING_AUTH_COOKIE])
      : null;
    if (!pending) {
      // No valid pending-auth cookie. The cookie expired (>15 min) or the user
      // landed on /login without going through /authorize. Show a generic
      // sign-in failure page — the OAuth client will retry from the start.
      res.status(440).type('html').send(loginPageHtml('/login', 'Your sign-in session has expired. Close this tab and reconnect from your MCP client to start over.'));
      return;
    }

    // Run NS password grant — may return final tokens OR an MFA challenge
    let grantResult: NsGrantResult;
    try {
      grantResult = await this.nsPasswordGrant(username, password);
    } catch (err: any) {
      const msg = err.message?.includes('401')
        ? 'Invalid username or password.'
        : `Authentication failed: ${err.message}`;
      res.status(200).type('html').send(loginPageHtml('/login', msg));
      return;
    }

    if (grantResult.kind === 'mfa_required') {
      const challenge: MfaChallenge = {
        pending,
        username,
        password,
        partialAccessToken: grantResult.partialAccessToken,
        mfaType: grantResult.mfaType,
        mfaVendor: grantResult.mfaVendor,
        nsIdType: grantResult.nsIdType,
      };
      const cookie = signValue(challenge, 5 * 60); // 5 min TTL
      setSignedCookie(res, MFA_CHALLENGE_COOKIE, cookie, 5 * 60);
      clearCookie(res, PENDING_AUTH_COOKIE);

      res.status(200).type('html').send(mfaPageHtml('/mfa', grantResult.mfaVendor));
      return;
    }

    clearCookie(res, PENDING_AUTH_COOKIE);
    await this.completeLogin(pending, grantResult.tokens, username, res);
  }

  /**
   * Called by our custom POST /mfa route after the user submits the passcode.
   */
  async handleMfa(req: Request, res: Response, passcode: string): Promise<void> {
    const cookies = parseCookies(req.headers.cookie);
    const challenge = cookies[MFA_CHALLENGE_COOKIE]
      ? verifySigned<MfaChallenge>(cookies[MFA_CHALLENGE_COOKIE])
      : null;
    if (!challenge) {
      // Stale or missing MFA cookie — show a sign-in failure page; the OAuth
      // client will retry from the start.
      res.status(440).type('html').send(loginPageHtml('/login', 'MFA verification window has expired. Close this tab and reconnect from your MCP client to start over.'));
      return;
    }

    let nsTokens: NsTokenResponse;
    try {
      nsTokens = await this.nsMfaGrant(challenge, passcode);
    } catch (err: any) {
      const msg = err.message?.includes('401') || err.message?.toLowerCase().includes('passcode') || err.message?.toLowerCase().includes('invalid')
        ? 'Invalid or expired passcode. Try again.'
        : `MFA failed: ${err.message}`;
      res.status(200).type('html').send(mfaPageHtml('/mfa', challenge.mfaVendor, msg));
      return;
    }

    clearCookie(res, MFA_CHALLENGE_COOKIE);
    await this.completeLogin(challenge.pending, nsTokens, challenge.username, res);
  }

  /**
   * Shared finalization: detect role, issue auth code, redirect back to MCP client.
   */
  private async completeLogin(
    pending: PendingAuthorization,
    nsTokens: NsTokenResponse,
    username: string,
    res: Response,
  ): Promise<void> {
    let nsUserRole: string | undefined;
    try {
      nsUserRole = await this.detectNsUserRole(nsTokens.access_token);
    } catch (err) {
      logger.warn('Failed to detect user role, defaulting to user', { error: String(err) });
    }

    const code = randomBytes(32).toString('hex');
    this.authCodes.set(code, { pending, nsTokens: { ...nsTokens, username, nsUserRole } });
    setTimeout(() => this.authCodes.delete(code), 5 * 60 * 1000);

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
    const stored = await this.tokenStore.getByRefreshToken(refreshToken);
    if (!stored) {
      logger.warn('Refresh token presented but unknown — user will be asked to reconnect', {
        // Log a fingerprint, never the token itself
        refreshFingerprint: refreshToken.slice(0, 8),
      });
      throw new Error('Invalid refresh token');
    }

    // Try to refresh the upstream NS token if we have a refresh token
    let nsTokens: NsTokenResponse;
    if (stored.nsRefreshToken) {
      try {
        nsTokens = await this.nsRefreshGrant(stored.nsRefreshToken);
        nsTokens.username = stored.nsUsername;
        nsTokens.nsUserRole = stored.nsUserRole;
      } catch (err) {
        logger.warn('Upstream NS refresh-grant failed during MCP refresh', {
          username: stored.nsUsername,
          error: err instanceof Error ? err.message : String(err),
        });
        throw new Error('Upstream token refresh failed. Please re-authenticate.');
      }
    } else {
      logger.warn('MCP refresh attempted but no upstream NS refresh token on file', {
        username: stored.nsUsername,
      });
      throw new Error('No upstream refresh token available. Please re-authenticate.');
    }

    await this.tokenStore.delete(stored.accessToken);

    logger.info('MCP bearer refreshed via refresh_token', {
      username: stored.nsUsername,
      clientId: stored.clientId,
    });

    return this.issueTokens(stored.clientId, nsTokens);
  }

  // -----------------------------------------------------------------------
  // Token verification
  // -----------------------------------------------------------------------

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let stored = await this.tokenStore.get(token);
    if (!stored) {
      throw new Error('Invalid access token');
    }

    if (Date.now() > stored.expiresAt) {
      const ageMs = Date.now() - stored.expiresAt;
      logger.info('MCP bearer expired — client should refresh', {
        username: stored.nsUsername,
        clientId: stored.clientId,
        ageSec: Math.round(ageMs / 1000),
        hadRefreshToken: !!stored.refreshToken,
      });
      await this.tokenStore.delete(token);
      throw new Error('Access token expired');
    }

    // Transparently refresh the upstream NS token if it has expired or is within 60s of expiry.
    // The MCP client never sees this — it just keeps using the same MCP bearer token.
    const NS_REFRESH_SKEW_MS = 60_000;
    const nsExpired = stored.nsExpiresAt && Date.now() > stored.nsExpiresAt - NS_REFRESH_SKEW_MS;
    if (nsExpired && stored.nsRefreshToken) {
      let inflight = this.nsRefreshInflight.get(token);
      if (!inflight) {
        inflight = this.refreshUpstreamNsToken(token, stored)
          .finally(() => this.nsRefreshInflight.delete(token));
        this.nsRefreshInflight.set(token, inflight);
      }
      await inflight;
      // Re-read so every waiter (not just the one that refreshed) returns the new token.
      stored = (await this.tokenStore.get(token)) ?? stored;
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

  private async refreshUpstreamNsToken(token: string, stored: StoredToken): Promise<void> {
    try {
      const refreshed = await this.nsRefreshGrant(stored.nsRefreshToken!);
      await this.tokenStore.update(token, {
        nsAccessToken: refreshed.access_token,
        nsRefreshToken: refreshed.refresh_token ?? stored.nsRefreshToken,
        nsExpiresAt: refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : undefined,
      });
      logger.info('Refreshed upstream NS token', { username: stored.nsUsername });
    } catch (err) {
      logger.warn('Upstream NS token refresh failed during verify; client will need to re-auth', {
        error: String(err),
        username: stored.nsUsername,
      });
      // Fall through and let the API call fail with a 401, which will trigger
      // the MCP client to use its refresh token (which in turn re-tries the NS refresh).
    }
  }

  // -----------------------------------------------------------------------
  // Revocation
  // -----------------------------------------------------------------------

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const { token } = request;

    const stored = await this.tokenStore.get(token);
    if (stored) {
      await this.tokenStore.delete(token);
      return;
    }

    const byRefresh = await this.tokenStore.getByRefreshToken(token);
    if (byRefresh) {
      await this.tokenStore.deleteByRefreshToken(token);
    }
  }

  // -----------------------------------------------------------------------
  // Lookup: get the upstream NS access token for a verified MCP token
  // -----------------------------------------------------------------------

  async getNsAccessToken(mcpToken: string): Promise<string | undefined> {
    const stored = await this.tokenStore.get(mcpToken);
    return stored?.nsAccessToken;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async issueTokens(clientId: string, nsTokens: NsTokenResponse): Promise<OAuthTokens> {
    const accessToken = randomBytes(32).toString('hex');
    const refreshToken = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + this.tokenLifetimeSec * 1000;
    const nsExpiresAt = nsTokens.expires_in
      ? Date.now() + nsTokens.expires_in * 1000
      : undefined;

    const stored: StoredToken = {
      accessToken,
      refreshToken,
      clientId,
      expiresAt,
      nsAccessToken: nsTokens.access_token,
      nsRefreshToken: nsTokens.refresh_token,
      nsExpiresAt,
      nsUsername: nsTokens.username,
      nsUserRole: nsTokens.nsUserRole,
    };

    await this.tokenStore.set(stored);

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.tokenLifetimeSec,
      refresh_token: refreshToken,
    };
  }

  private async nsPasswordGrant(username: string, password: string): Promise<NsGrantResult> {
    const tokenUrl = `${this.nsApiUrl}/ns-api/v2/tokens`;
    try {
      const response = await axios.post(
        tokenUrl,
        {
          grant_type: 'password',
          client_id: this.nsClientId,
          client_secret: this.nsClientSecret,
          username,
          password,
        },
        { headers: { 'Content-Type': 'application/json', Accept: 'application/json' } },
      );

      const data = response.data || {};

      // MFA challenge: NS returns mfa_type/mfa_vendor when a second factor is required.
      // The access_token in this response is only valid for the subsequent mfa grant call.
      if (data.mfa_type || data.mfa_vendor) {
        return {
          kind: 'mfa_required',
          partialAccessToken: data.access_token,
          mfaType: String(data.mfa_type || 'authenticator'),
          mfaVendor: String(data.mfa_vendor || 'google'),
          nsIdType: String(data.ns_id_type || 'subscriber'),
        };
      }

      return {
        kind: 'tokens',
        tokens: {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_in: data.expires_in,
          username,
        },
      };
    } catch (err: any) {
      const status = err.response?.status;
      const data = err.response?.data;
      logger.warn('NS password grant failed', {
        tokenUrl,
        username,
        status,
        nsResponse: data,
      });
      const nsMessage = (typeof data === 'object' && data)
        ? (data.error_description || data.error || data.message)
        : (typeof data === 'string' ? data : undefined);
      const detail = nsMessage ? `${status} — ${nsMessage}` : err.message;
      throw new Error(detail);
    }
  }

  private async nsMfaGrant(challenge: MfaChallenge, passcode: string): Promise<NsTokenResponse> {
    const tokenUrl = `${this.nsApiUrl}/ns-api/v2/tokens`;
    try {
      const response = await axios.post(
        tokenUrl,
        {
          grant_type: 'mfa',
          client_id: this.nsClientId,
          client_secret: this.nsClientSecret,
          username: challenge.username,
          password: challenge.password,
          mfa_type: challenge.mfaType,
          mfa_vendor: challenge.mfaVendor,
          ns_id_type: challenge.nsIdType,
          passcode,
          access_token: challenge.partialAccessToken,
        },
        { headers: { 'Content-Type': 'application/json', Accept: 'application/json' } },
      );

      return {
        access_token: response.data.access_token,
        refresh_token: response.data.refresh_token,
        expires_in: response.data.expires_in,
        username: challenge.username,
      };
    } catch (err: any) {
      const status = err.response?.status;
      const data = err.response?.data;
      logger.warn('NS MFA grant failed', {
        tokenUrl,
        username: challenge.username,
        status,
        nsResponse: data,
      });
      const nsMessage = (typeof data === 'object' && data)
        ? (data.error_description || data.error || data.message)
        : (typeof data === 'string' ? data : undefined);
      const detail = nsMessage ? `${status} — ${nsMessage}` : err.message;
      throw new Error(detail);
    }
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
      `${this.nsApiUrl}/ns-api/v2/tokens`,
      {
        grant_type: 'refresh_token',
        client_id: this.nsClientId,
        client_secret: this.nsClientSecret,
        refresh_token: nsRefreshToken,
      },
      { headers: { 'Content-Type': 'application/json', Accept: 'application/json' } },
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

type NsGrantResult =
  | { kind: 'tokens'; tokens: NsTokenResponse }
  | {
      kind: 'mfa_required';
      partialAccessToken: string;
      mfaType: string;
      mfaVendor: string;
      nsIdType: string;
    };
