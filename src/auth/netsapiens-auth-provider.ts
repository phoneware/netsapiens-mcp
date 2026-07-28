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

import {
  randomUUID,
  randomBytes,
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from 'node:crypto';
import type { Request, Response } from 'express';
import axios from 'axios';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError, InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
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
// Signed state helpers.
//
// The OAuth flow sets no cookies. There is no session here to keep: /authorize
// receives everything the flow needs (client_id, redirect_uri, PKCE challenge,
// state) and the only job is to hand those same params back at POST /login.
// A cookie is browser-global and request-independent, which is precisely wrong
// for that — a second /authorize clobbers the first tab's copy, and any
// browser that withholds it takes the whole flow down. State rides in the form
// instead, one copy per rendered page, signed so it cannot be forged.
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

/** Hidden form fields carrying the flow's state. */
const AUTH_STATE_FIELD = 'auth_state';
const MFA_STATE_FIELD = 'mfa_state';

/**
 * How long a rendered login page stays usable. Generous on purpose: a tab that
 * sat open should still sign in. The blob holds public OAuth request params,
 * and the code it leads to still lands on the client's registered redirect URI
 * behind PKCE, so a long window grants nothing a short one wouldn't.
 */
const PENDING_AUTH_TTL_SEC = 2 * 60 * 60;
/** How long after a passcode prompt we still accept the code. */
const MFA_CHALLENGE_TTL_SEC = 10 * 60;

export function signValue<T>(payload: T, ttlSec: number): string {
  const data = { ...(payload as object), exp: Math.floor(Date.now() / 1000) + ttlSec };
  const json = Buffer.from(JSON.stringify(data));
  const b64 = json.toString('base64url');
  const sig = createHmac('sha256', getSessionSecret()).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

export function verifySigned<T>(token: string): T | null {
  const result = inspectSigned<T>(token);
  return result.status === 'valid' ? result.value : null;
}

/**
 * Signature/expiry verdict for a signed blob.
 *
 * `expired` still carries the payload: the signature proved we minted it, only
 * the window lapsed. Callers decide whether a lapsed window is recoverable.
 * The distinct statuses are what let us log *why* a login lost its state
 * instead of collapsing every cause into "session expired".
 */
export type SignedInspection<T> =
  | { status: 'valid'; value: T }
  | { status: 'expired'; value: T; expiredAgoSec: number }
  | { status: 'malformed' }
  | { status: 'bad_signature' };

export function inspectSigned<T>(token: string): SignedInspection<T> {
  try {
    const dot = token.indexOf('.');
    if (dot <= 0) return { status: 'malformed' };
    const b64 = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = createHmac('sha256', getSessionSecret()).update(b64).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { status: 'bad_signature' };
    const data = JSON.parse(Buffer.from(b64, 'base64url').toString());
    const exp = data.exp;
    delete data.exp;
    if (typeof exp === 'number' && exp < Math.floor(Date.now() / 1000)) {
      return { status: 'expired', value: data as T, expiredAgoSec: Math.floor(Date.now() / 1000) - exp };
    }
    return { status: 'valid', value: data as T };
  } catch {
    return { status: 'malformed' };
  }
}

// ---------------------------------------------------------------------------
// Sealed (encrypted) state — for blobs that must ride in the page HTML but
// hold secrets. The pending-authorization blob is public OAuth request
// params, so signing is enough; the MFA challenge carries the user's password
// and partial access token, so it gets AES-256-GCM on top of the signature.
// ---------------------------------------------------------------------------

function sealKey(): Buffer {
  return createHash('sha256').update(`seal:${getSessionSecret()}`).digest();
}

export function sealValue<T>(payload: T, ttlSec: number): string {
  const data = { ...(payload as object), exp: Math.floor(Date.now() / 1000) + ttlSec };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64url'), ct.toString('base64url'), tag.toString('base64url')].join('.');
}

export function openSealed<T>(token: string): T | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [iv, ct, tag] = parts.map((p) => Buffer.from(p, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', sealKey(), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    const data = JSON.parse(plain);
    if (typeof data.exp === 'number' && data.exp < Math.floor(Date.now() / 1000)) return null;
    delete data.exp;
    return data as T;
  } catch {
    return null;
  }
}

/**
 * Send a credential page. These carry sign-in state in the markup, so they
 * must not sit in a disk cache or an intermediary.
 */
function sendPage(res: Response, status: number, html: string): void {
  res.status(status)
    .set('Cache-Control', 'no-store, private')
    .set('Pragma', 'no-cache')
    .type('html')
    .send(html);
}

/**
 * True when the browser tells us this POST came from another site. With no
 * cookies in the flow there is no SameSite behavior to lean on, so the fetch
 * metadata is what keeps another origin from posting at our login form.
 * Absent header (curl, older browsers) is treated as same-site.
 */
export function isCrossSitePost(req: Request): boolean {
  const site = req.headers['sec-fetch-site'];
  return typeof site === 'string' && site === 'cross-site';
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

function loginPageHtml(authorizeUrl: string, error?: string, authState?: string): string {
  const errorHtml = error
    ? `<div class="error">${escapeHtml(error)}</div>`
    : '';

  // The pending authorization rides with the page that will submit it. One
  // copy per rendered form, so two tabs can't overwrite each other.
  const stateHtml = authState
    ? `<input type="hidden" name="${AUTH_STATE_FIELD}" value="${escapeHtml(authState)}">`
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
      ${stateHtml}
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

function mfaPageHtml(
  mfaUrl: string,
  mfaVendor: string | undefined,
  error?: string,
  mfaState?: string,
): string {
  const errorHtml = error
    ? `<div class="error">${escapeHtml(error)}</div>`
    : '';

  // Same as the login page, except sealed rather than merely signed: this blob
  // holds the password needed for the NS mfa grant, which must never be
  // readable in page source.
  const stateHtml = mfaState
    ? `<input type="hidden" name="${MFA_STATE_FIELD}" value="${escapeHtml(mfaState)}">`
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
      ${stateHtml}
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
    // Pack the pending authorization into a signed blob that travels with the
    // page. Nothing is stored server-side and nothing is stored in the
    // browser, so this survives restarts, scaling, and instance switches
    // without any of them being able to strand the user.
    const pending: PendingAuthorization = {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      state: params.state,
      scopes: params.scopes,
      resource: params.resource,
      createdAt: Date.now(),
    };
    const state = signValue(pending, PENDING_AUTH_TTL_SEC);
    sendPage(res, 200, loginPageHtml('/login', undefined, state));
  }

  /**
   * Recover the pending authorization from the submitted form. The `reason` is
   * what gets logged when there is nothing usable.
   */
  private resolvePending(req: Request): { pending: PendingAuthorization | null; reason: string } {
    const formState = (req.body as Record<string, unknown> | undefined)?.[AUTH_STATE_FIELD];
    if (typeof formState !== 'string' || !formState) {
      return { pending: null, reason: 'no_state_present' };
    }

    const result = inspectSigned<PendingAuthorization>(formState);
    switch (result.status) {
      case 'valid':
        return { pending: result.value, reason: 'valid' };
      case 'expired':
        return { pending: null, reason: 'expired' };
      case 'bad_signature':
        return { pending: null, reason: 'bad_signature' };
      default:
        return { pending: null, reason: 'malformed' };
    }
  }

  /**
   * Called by our custom POST /login route after the user submits credentials.
   * Runs the password grant against NetSapiens, generates an authorization code,
   * and redirects back to the MCP client.
   */
  async handleLogin(req: Request, res: Response, username: string, password: string): Promise<void> {
    if (isCrossSitePost(req)) {
      logger.warn('Rejected cross-site login POST');
      sendPage(res, 440, loginPageHtml('/login', 'Your sign-in session has expired. Close this tab and reconnect from your MCP client to start over.'));
      return;
    }

    const { pending, reason } = this.resolvePending(req);
    if (!pending) {
      // No state on the form, a page older than the TTL, or a state we didn't
      // sign — a rotated MCP_SESSION_SECRET, or a POST that never came from
      // one of our login pages.
      logger.warn('Login rejected: no usable pending-auth state', { reason });
      sendPage(res, 440, loginPageHtml('/login', 'Your sign-in session has expired. Close this tab and reconnect from your MCP client to start over.'));
      return;
    }

    // Re-mint the state so a retry on this page (wrong password, MFA bounce)
    // starts a fresh window instead of inheriting the original deadline.
    const refreshedState = signValue(pending, PENDING_AUTH_TTL_SEC);

    // Run NS password grant — may return final tokens OR an MFA challenge
    let grantResult: NsGrantResult;
    try {
      grantResult = await this.nsPasswordGrant(username, password);
    } catch (err: any) {
      const msg = err.message?.includes('401')
        ? 'Invalid username or password.'
        : `Authentication failed: ${err.message}`;
      sendPage(res, 200, loginPageHtml('/login', msg, refreshedState));
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
      const sealed = sealValue(challenge, MFA_CHALLENGE_TTL_SEC);
      sendPage(res, 200, mfaPageHtml('/mfa', grantResult.mfaVendor, undefined, sealed));
      return;
    }

    await this.completeLogin(pending, grantResult.tokens, username, res);
  }

  /**
   * Called by our custom POST /mfa route after the user submits the passcode.
   */
  async handleMfa(req: Request, res: Response, passcode: string): Promise<void> {
    if (isCrossSitePost(req)) {
      logger.warn('Rejected cross-site MFA POST');
      sendPage(res, 440, loginPageHtml('/login', 'MFA verification window has expired. Close this tab and reconnect from your MCP client to start over.'));
      return;
    }

    const formState = (req.body as Record<string, unknown> | undefined)?.[MFA_STATE_FIELD];
    const sealed = typeof formState === 'string' ? formState : undefined;
    const challenge = sealed ? openSealed<MfaChallenge>(sealed) : null;
    if (!challenge) {
      // Stale or missing MFA state — show a sign-in failure page; the OAuth
      // client will retry from the start.
      logger.warn('MFA rejected: no usable challenge state', {
        hadFormState: typeof formState === 'string',
      });
      sendPage(res, 440, loginPageHtml('/login', 'MFA verification window has expired. Close this tab and reconnect from your MCP client to start over.'));
      return;
    }

    let nsTokens: NsTokenResponse;
    try {
      nsTokens = await this.nsMfaGrant(challenge, passcode);
    } catch (err: any) {
      const msg = err.message?.includes('401') || err.message?.toLowerCase().includes('passcode') || err.message?.toLowerCase().includes('invalid')
        ? 'Invalid or expired passcode. Try again.'
        : `MFA failed: ${err.message}`;
      // Re-seal so "try again" has state to work with.
      const resealed = sealValue(challenge, MFA_CHALLENGE_TTL_SEC);
      sendPage(res, 200, mfaPageHtml('/mfa', challenge.mfaVendor, msg, resealed));
      return;
    }

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
      throw new InvalidGrantError('Invalid authorization code');
    }
    return entry.pending.codeChallenge;
  }

  async exchangeAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const entry = this.authCodes.get(authorizationCode);
    if (!entry) {
      throw new InvalidGrantError('Invalid authorization code');
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
      throw new InvalidGrantError('Invalid refresh token');
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
        throw new InvalidGrantError('Upstream token refresh failed. Please re-authenticate.');
      }
    } else {
      logger.warn('MCP refresh attempted but no upstream NS refresh token on file', {
        username: stored.nsUsername,
      });
      throw new InvalidGrantError('No upstream refresh token available. Please re-authenticate.');
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
      // Must be InvalidTokenError (not a plain Error): requireBearerAuth maps
      // it to a 401 with a WWW-Authenticate challenge, which is the signal an
      // MCP client needs to refresh or re-authenticate. Anything else becomes
      // a 500 the client can't act on.
      throw new InvalidTokenError('Invalid access token');
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
      throw new InvalidTokenError('Access token expired');
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
