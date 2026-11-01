/**
 * OAuth 2.1 Server Provider for the NetSapiens MCP Server.
 *
 * Wraps NetSapiens' password-grant OAuth in a standard authorization-code
 * flow so that MCP clients see a normal browser-redirect login experience.
 * User credentials are entered in a login page served by *this* server and
 * never pass through the MCP transport or LLM context.
 *
 * Env vars consumed (all set by the server operator):
 *   NETSAPIENS_API_URL: upstream NS API base URL
 *   NETSAPIENS_OAUTH_CLIENT_ID: NS OAuth client ID
 *   NETSAPIENS_OAUTH_CLIENT_SECRET: NS OAuth client secret
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
import { InvalidTokenError, InvalidGrantError, ServerError, TemporarilyUnavailableError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  type CutoverFenceConfig,
  type LegacyOperationContext,
  type SupportedCutoverNamespace,
  withLegacyOperation,
  checkMutationGuardInTransaction,
  type GuardMutationResult,
  requestOperationContext,
} from './kit/cutover-fence.js';
import {
 UpstreamRevokedError,
 UpstreamUnavailableError,
 CutoverRefusedError,
 classifyUpstreamTokenResponse,
 toTokenEndpointError,
 kitCodeOf,
} from './kit/errors.js';
import { stripUndefined } from './kit/strip-undefined.js';
import { DEFAULT_ACCESS_TOKEN_TTL_MS } from './kit/ledger.js';
import type { TokenLedger } from './kit/ledger.js';
import type {
 OAuthClientInformationFull,
 OAuthTokens,
 OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { Firestore } from '@google-cloud/firestore';
import { TokenStore } from './token-store.js';
import { LoopbackTolerantClientsStore } from './loopback-redirect.js';
import type { StoredToken, TokenStoreLike } from './token-store.js';
import {
 FirestoreTokenStore,
 FirestoreClientsStore,
 FirestoreAuthCodeStore,
 RetryableRefreshError,
 LeaseLostError,
} from './firestore-stores.js';
import { nsScopeToTier, type UserRole } from './roles.js';
import type {
 PendingAuthorization,
 NsTokenResponse,
 AuthHooks,
 RenderPagesOptions,
 NsUserSnapshot,
} from './types.js';
import { getAllowedPlatforms, getPlatform, isPlatformAllowed } from './platforms.js';
export type { PendingAuthorization, NsTokenResponse };
import { logger } from '../utils/logger.js';

export class UpstreamTimeoutError extends Error {
 constructor(message = 'Upstream refresh request timed out') {
  super(message);
  this.name = 'UpstreamTimeoutError';
 }
}

export class UpstreamGrantRejectedError extends Error {
 readonly status: number;
 constructor(message = 'Upstream refresh grant rejected', status = 400) {
  super(message);
  this.name = 'UpstreamGrantRejectedError';
  this.status = status;
 }
}

// ---------------------------------------------------------------------------
// Signed state helpers.
//
// The OAuth flow sets no cookies. There is no session here to keep: /authorize
// receives everything the flow needs (client_id, redirect_uri, PKCE challenge,
// state) and the only job is to hand those same params back at POST /login.
// A cookie is browser-global and request-independent, which is precisely wrong
// for that: a second /authorize clobbers the first tab's copy, and any
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
// Sealed (encrypted) state: for blobs that must ride in the page HTML but
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
  client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'> & { client_id?: string },
 ): OAuthClientInformationFull {
  const clientId = client.client_id ?? randomUUID();
  // Honor the client's requested authentication method. Public clients
  // (token_endpoint_auth_method=none) get no secret: they rely on PKCE
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

function loginPageHtml(
 authorizeUrl: string,
 error?: string,
 authState?: string,
 initialTab: 'password' | 'token' = 'password',
): string {
 const errorHtml = error
  ? `<div class="error">${escapeHtml(error)}</div>`
  : '';

 // The pending authorization rides with the page that will submit it. One
 // copy per rendered form, so two tabs can't overwrite each other.
 const stateHtml = authState
  ? `<input type="hidden" name="${AUTH_STATE_FIELD}" value="${escapeHtml(authState)}">`
  : '';

 const defaultHeading = process.env.MCP_READ_ONLY === 'true'
  ? 'NetSapiens MCP (Read-Only): Sign In'
  : 'NetSapiens MCP: Sign In';
 const heading = process.env.MCP_LOGIN_HEADER || defaultHeading;
 const safeHeading = escapeHtml(heading);
 const platforms = getAllowedPlatforms();

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
            padding: 2rem; width: 100%; max-width: 420px; }
    .logo { text-align: center; margin-bottom: 1rem; }
    .logo img { max-width: 96px; max-height: 96px; height: auto; }
    h1 { font-size: 1.25rem; margin-bottom: 1.25rem; text-align: center; }
    .tabs { display: flex; gap: 0.5rem; margin-bottom: 1.25rem; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.5rem; }
    .tab-btn { flex: 1; padding: 0.5rem; background: none; border: none; font-size: 0.85rem; font-weight: 500; color: #6b7280; cursor: pointer; border-radius: 4px; transition: background 0.15s, color 0.15s; }
    .tab-btn.active { color: #2563eb; background: #eff6ff; font-weight: 600; }
    .tab-btn:hover { background: #f3f4f6; }
    .auth-form { display: none; }
    .auth-form.active { display: block; }
    label { display: block; font-size: 0.875rem; font-weight: 500; margin-bottom: 0.25rem; }
    input, select { width: 100%; padding: 0.5rem 0.75rem; border: 1px solid #ccc; border-radius: 4px;
            font-size: 0.9rem; margin-bottom: 1rem; background: #fff; }
    input:focus, select:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,.2); }
    button[type="submit"] { width: 100%; padding: 0.6rem; background: #2563eb; color: #fff; border: none;
             border-radius: 4px; font-size: 0.95rem; cursor: pointer; }
    button[type="submit"]:hover { background: #1d4ed8; }
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
    <div class="tabs">
      <button type="button" class="tab-btn ${initialTab === 'password' ? 'active' : ''}" onclick="switchTab('password')">Password</button>
      <button type="button" class="tab-btn ${initialTab === 'token' ? 'active' : ''}" onclick="switchTab('token')">Sign in with a NetSapiens token</button>
    </div>
    <form method="POST" action="${escapeHtml(authorizeUrl)}" id="password-form" class="auth-form ${initialTab === 'password' ? 'active' : ''}">
      ${stateHtml}
      <label for="username">Username</label>
      <input type="text" id="username" name="username" required autocomplete="username" ${initialTab === 'password' ? 'autofocus' : ''}>
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autocomplete="current-password">
      <button type="submit">Sign In</button>
    </form>
    <form method="POST" action="${escapeHtml(authorizeUrl)}" id="token-form" class="auth-form ${initialTab === 'token' ? 'active' : ''}">
      ${stateHtml}
      <label for="platform">Platform</label>
      <select id="platform" name="platform" required>
        ${platforms.map((p) => `<option value="${escapeHtml(p.apiUrl)}">${escapeHtml(p.label)} (${escapeHtml(new URL(p.apiUrl).hostname)})</option>`).join('\n        ')}
      </select>
      <label for="token">NetSapiens Token or API Key</label>
      <input type="password" id="token" name="token" required placeholder="Paste your API key or token" autocomplete="off" ${initialTab === 'token' ? 'autofocus' : ''}>
      <button type="submit">Sign In with Token</button>
    </form>
    <script>
      function switchTab(tab) {
        var btns = document.querySelectorAll('.tab-btn');
        var forms = document.querySelectorAll('.auth-form');
        btns.forEach(function(b) { b.classList.remove('active'); });
        forms.forEach(function(f) { f.classList.remove('active'); });
        if (tab === 'token') {
          if (btns[1]) btns[1].classList.add('active');
          var tf = document.getElementById('token-form');
          if (tf) tf.classList.add('active');
        } else {
          if (btns[0]) btns[0].classList.add('active');
          var pf = document.getElementById('password-form');
          if (pf) pf.classList.add('active');
        }
      }
    </script>
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

 const heading = process.env.MCP_LOGIN_HEADER || 'NetSapiens MCP: Sign In';
 const safeHeading = escapeHtml(heading);
 const vendorHint = mfaVendor
  ? `<div class="hint">Enter the 6-digit code from your ${escapeHtml(mfaVendor)} authenticator.</div>`
  : `<div class="hint">Enter the 6-digit code from your authenticator app.</div>`;

 return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeHeading}: MFA</title>
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
 /** MCP Server base URL for cross-server token isolation */
 serverBaseUrl?: string;
 /** Optional auth hooks for enrollment and request verification */
 hooks?: AuthHooks;
 /** Optional custom HTML page renderers */
 renderPages?: RenderPagesOptions;
 /** Optional custom collection names for Firestore stores */
 collections?: {
  tokens?: string;
  clients?: string;
  authCodes?: string;
  resumeTokens?: string;
 };
 /** Optional Firestore instance override */
 firestore?: Firestore;
 /** Optional GCP project ID override */
 projectId?: string;
 /** Optional token store override */
 tokenStore?: TokenStoreLike;
 /** Optional clients store override */
 clientsStore?: OAuthRegisteredClientsStore;
 /** Optional auth code store override */
 authCodeStore?: FirestoreAuthCodeStore;
 /** Optional now provider for testing */
 now?: () => number;
 fence?: CutoverFenceConfig;
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
 private authCodes = new Map<string, { pending: PendingAuthorization; nsTokens: NsTokenResponse; extra?: Record<string, string>; serverBaseUrl?: string; clientId?: string }>();
 private authCodeStore?: FirestoreAuthCodeStore;
 private db?: Firestore;
 private resumeTokensCollection: string = 'mcp_resume_tokens';
 private consumedResumeTokens = new Set<string>();
 private tokenStore: TokenStoreLike;
 private hooks?: AuthHooks;
 private renderPages?: RenderPagesOptions;
 private nsApiUrl: string;
 private nsClientId: string;
 private nsClientSecret: string;
 private tokenLifetimeSec: number;
 private serverBaseUrl?: string;
 readonly nowProvider: () => number;
 // In-flight upstream NS refreshes keyed by MCP bearer. NS rotates refresh
 // tokens, so two concurrent refreshes for the same bearer means the second
 // one presents an already-consumed refresh token and fails: concurrent
 // verifies must share a single refresh instead.
 private nsRefreshInflight = new Map<string, Promise<void>>();
 readonly fenceConfig?: CutoverFenceConfig;
 private readonly authCodesCollection: string;

 get dbInstance(): Firestore | undefined {
  return this.db;
 }

 get fenceNamespace(): SupportedCutoverNamespace {
  const ns = this.fenceConfig?.namespace;
  if (ns === 'readonly_mcp' || ns === 'pwmcp') return ns;
  return 'mcp';
 }

 async withOperation<R>(
  kind: string,
  fn: (opCtx?: LegacyOperationContext) => Promise<R>,
 ): Promise<R> {
  const existing = requestOperationContext.getStore();
  if (existing && !existing.isCompleted()) {
   return await fn(existing);
  }
  if (this.db && this.fenceConfig?.enforce) {
   return await withLegacyOperation(
    { db: this.db, namespace: this.fenceNamespace, kind, now: this.nowProvider },
    async (opCtx) => fn(opCtx),
   );
  }
  return fn(undefined);
 }

 constructor(options: NetSapiensAuthProviderOptions) {
  this.nsApiUrl = options.nsApiUrl;
  this.nsClientId = options.nsClientId;
  this.nsClientSecret = options.nsClientSecret;
  this.tokenLifetimeSec = options.tokenLifetimeSec ?? Math.round(DEFAULT_ACCESS_TOKEN_TTL_MS / 1000);
  this.serverBaseUrl = options.serverBaseUrl || process.env.MCP_BASE_URL;
  this.hooks = options.hooks;
  this.renderPages = options.renderPages;
  this.nowProvider = options.now ?? Date.now;
  const useFirestore = !!options.firestore
   || process.env.MCP_PERSISTENCE === 'firestore'
   || (process.env.MCP_PERSISTENCE !== 'file' && !!process.env.GOOGLE_CLOUD_PROJECT);

  const projectId = options.projectId || process.env.GOOGLE_CLOUD_PROJECT;
  const db = options.firestore;
  const tokensCollection = options.collections?.tokens ?? (process.env.MCP_READ_ONLY === 'true' ? 'readonly_mcp_tokens' : 'mcp_tokens');
  const clientsCollection = options.collections?.clients ?? 'mcp_oauth_clients';
  const authCodesCollection = options.collections?.authCodes
   ?? process.env.FIRESTORE_AUTH_CODES_COLLECTION
   ?? (process.env.MCP_READ_ONLY === 'true' ? 'readonly_mcp_auth_codes' : 'mcp_auth_codes');
  this.authCodesCollection = authCodesCollection;
  this.resumeTokensCollection = options.collections?.resumeTokens
   ?? process.env.FIRESTORE_RESUME_TOKENS_COLLECTION
   ?? (process.env.MCP_READ_ONLY === 'true' ? 'readonly_mcp_resume_tokens' : 'mcp_resume_tokens');
  if (useFirestore) {
   this.db = db ?? new Firestore({ projectId, ignoreUndefinedProperties: true });
  }

  const detectedNs = tokensCollection.startsWith('readonly_mcp')
   ? 'readonly_mcp'
   : tokensCollection.startsWith('pwmcp')
   ? 'pwmcp'
   : 'mcp';
  this.fenceConfig = options.fence ?? (process.env.MCP_FENCE_ENFORCE === 'true' ? { namespace: detectedNs, enforce: true } : undefined);

  if (options.tokenStore) {
   this.tokenStore = options.tokenStore;
  } else if (useFirestore) {
   this.tokenStore = new FirestoreTokenStore({ collection: tokensCollection, projectId, db: this.db, fence: this.fenceConfig });
  } else {
   this.tokenStore = new TokenStore(options.tokenStorePath);
  }

  if (options.clientsStore) {
   this._clientsStore = options.clientsStore;
  } else if (useFirestore) {
   this._clientsStore = new LoopbackTolerantClientsStore(
    new FirestoreClientsStore({ collection: clientsCollection, projectId, db: this.db, fence: this.fenceConfig }),
   );
  } else {
   this._clientsStore = new LoopbackTolerantClientsStore(new InMemoryClientsStore());
  }

  if (options.authCodeStore) {
   this.authCodeStore = options.authCodeStore;
  } else if (useFirestore) {
   this.authCodeStore = new FirestoreAuthCodeStore({ collection: authCodesCollection, projectId, db: this.db, fence: this.fenceConfig, now: this.nowProvider });
  }
  if (useFirestore) {
   logger.info('Auth provider using Firestore persistence');
  } else {
   logger.info('Auth provider using file-backed token store + in-memory clients store');
  }
 }

 private renderLoginPage(
  authorizeUrl: string,
  error?: string,
  authState?: string,
  initialTab: 'password' | 'token' = 'password',
 ): string {
  if (this.renderPages?.login) {
   return this.renderPages.login({ authorizeUrl, error, authState, initialTab });
  }
  return loginPageHtml(authorizeUrl, error, authState, initialTab);
 }

 private renderMfaPage(
  mfaUrl: string,
  mfaVendor: string | undefined,
  error?: string,
  mfaState?: string,
 ): string {
  if (this.renderPages?.mfa) {
   return this.renderPages.mfa({ mfaUrl, mfaVendor, error, mfaState });
  }
  return mfaPageHtml(mfaUrl, mfaVendor, error, mfaState);
 }

 private renderErrorPage(message: string, status?: number): string {
  if (this.renderPages?.error) {
   return this.renderPages.error({ message, status });
  }
  return loginPageHtml('/login', message);
 }
 get activeTokenCount(): number {
  return this.tokenStore.size;
 }

 get clientsStore(): OAuthRegisteredClientsStore {
  return this._clientsStore;
 }

 // -----------------------------------------------------------------------
 // authorize: show login page (GET) or handle form submission (POST)
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
  sendPage(res, 200, this.renderLoginPage('/login', undefined, state));
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
   sendPage(res, 440, this.renderErrorPage('Your sign-in session has expired. Close this tab and reconnect from your MCP client to start over.', 440));
   return;
  }

  const { pending, reason } = this.resolvePending(req);
  if (!pending) {
   logger.warn('Login rejected: no usable pending-auth state', { reason });
   sendPage(res, 440, this.renderErrorPage('Your sign-in session has expired. Close this tab and reconnect from your MCP client to start over.', 440));
   return;
  }

  const refreshedState = signValue(pending, PENDING_AUTH_TTL_SEC);

  try {
   await this.withOperation('login', async (opCtx) => {
    let grantResult: NsGrantResult;
    try {
     grantResult = await this.nsPasswordGrant(username, password);
    } catch (err: unknown) {
     const e = err as { message?: string };
     const msg = e?.message?.includes('401')
      ? 'Invalid username or password.'
      : `Authentication failed: ${e?.message ?? String(err)}`;
     sendPage(res, 200, this.renderLoginPage('/login', msg, refreshedState));
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
     sendPage(res, 200, this.renderMfaPage('/mfa', grantResult.mfaVendor, undefined, sealed));
     return;
    }

    await this.completeLogin(pending, { ...grantResult.tokens, nsApiUrl: this.nsApiUrl }, username, res, undefined, false, { operation: opCtx, completeOperation: true });
   });
  } catch (err: unknown) {
   if (err instanceof CutoverRefusedError || kitCodeOf(err) === 'cutover_refused') {
    res.setHeader('Retry-After', '5');
    sendPage(res, 503, this.renderErrorPage('Cutover in progress; sign-in temporarily unavailable', 503));
    return;
   }
   throw err;
  }
 }

 /**
  * Called by our custom POST /login route after the user submits token credentials.
  * Validates the token against the allowlisted platform API, generates an authorization code,
  * and redirects back to the MCP client.
  */
 async handleTokenLogin(req: Request, res: Response, platform: string, token: string): Promise<void> {
  if (isCrossSitePost(req)) {
   logger.warn('Rejected cross-site token login POST');
   sendPage(res, 440, this.renderErrorPage('Your sign-in session has expired. Close this tab and reconnect from your MCP client to start over.', 440));
   return;
  }

  const { pending, reason } = this.resolvePending(req);
  if (!pending) {
   logger.warn('Token login rejected: no usable pending-auth state', { reason });
   sendPage(res, 440, this.renderErrorPage('Your sign-in session has expired. Close this tab and reconnect from your MCP client to start over.', 440));
   return;
  }

  const refreshedState = signValue(pending, PENDING_AUTH_TTL_SEC);

  const resolvedPlatform = getPlatform(platform);
  if (!resolvedPlatform) {
   logger.warn('Token login rejected: unknown or forbidden platform', { platform });
   sendPage(res, 200, this.renderLoginPage('/login', 'Selected platform is not recognized or not allowed.', refreshedState, 'token'));
   return;
  }

  try {
   await this.withOperation('token_login', async (opCtx) => {
    let validated: { username: string; userRole?: UserRole; scope?: string; expiresIn?: number; user?: string; domain?: string; displayName?: string; email?: string };
    try {
     validated = await this.validateNsToken(resolvedPlatform.apiUrl, token);
    } catch (err: unknown) {
     const errMsg = (err as Error).message || String(err);
     const msg = errMsg.includes('401')
      ? 'Invalid NetSapiens token or API key.'
      : `Authentication failed: ${errMsg}`;
     sendPage(res, 200, this.renderLoginPage('/login', msg, refreshedState, 'token'));
     return;
    }

    const nsTokens: NsTokenResponse = {
     access_token: token,
     expires_in: validated.expiresIn,
     username: validated.username,
     nsUserRole: validated.userRole,
     scope: validated.scope,
     nsApiUrl: resolvedPlatform.apiUrl,
    };

    await this.completeLogin(pending, nsTokens, validated.username, res, undefined, false, { operation: opCtx, completeOperation: true });
   });
  } catch (err: unknown) {
   if (err instanceof CutoverRefusedError || kitCodeOf(err) === 'cutover_refused') {
    res.setHeader('Retry-After', '5');
    sendPage(res, 503, this.renderErrorPage('Cutover in progress; sign-in temporarily unavailable', 503));
    return;
   }
   throw err;
  }
 }

 /**
  * Validates a NetSapiens token against an allowlisted platform API.
  * Performs a cheap authenticated read (GET /domains/~/users/~, falling back
  * to GET /apikeys/~ for machine API keys where domain cannot be expanded from token).
  * Throws if platform is forbidden or token is invalid.
  */
 async validateNsToken(
  apiUrl: string,
  token: string,
 ): Promise<{ username: string; userRole?: UserRole; scope?: string; expiresIn?: number; user?: string; domain?: string; displayName?: string; email?: string }> {
  if (!isPlatformAllowed(apiUrl)) {
   throw new Error(`Platform URL is not allowed: ${apiUrl}`);
  }

  let expiresIn: number | undefined;
  if (token.includes('.')) {
   try {
    const parts = token.split('.');
    if (parts.length === 3) {
     const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
     if (typeof payload.exp === 'number') {
      const remainingSec = payload.exp - Math.floor(Date.now() / 1000);
      if (remainingSec > 0) expiresIn = remainingSec;
     }
    }
   } catch {
    // Not a standard JWT, ignore
   }
  }

  // Try GET /domains/~/users/~
  try {
   const userRes = await axios.get(`${apiUrl}/ns-api/v2/domains/~/users/~`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeout: 15000,
   });
   const data = userRes.data;
   const scope = data?.['user-scope'] ?? data?.scope ?? data?.type;
   const userRole = nsScopeToTier(scope);
   const user = data?.user;
   const domain = data?.domain;
   const username = data?.login || (domain && user ? `${user}@${domain}` : undefined) || user || 'token-user';
   const firstName = data?.['name-first-name'] ?? data?.['first-name'];
   const lastName = data?.['name-last-name'] ?? data?.['last-name'];
   const displayName = [firstName, lastName].filter(Boolean).join(' ') || data?.name || data?.description || username;
   const email = (data?.email || data?.['email-address'] || '') as string;
   return { username, userRole, scope: typeof scope === 'string' ? scope : undefined, expiresIn, user, domain, displayName, email };
  } catch (err: unknown) {
   const status = (err as { response?: { status?: number; data?: unknown } })?.response?.status;
   if (status === 400) {
    // Fallback for machine API keys where domain cannot be expanded from token
    try {
     const keyRes = await axios.get(`${apiUrl}/ns-api/v2/apikeys/~`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      timeout: 15000,
     });
     const keyData = keyRes.data;
     const scope = keyData?.['user-scope'] ?? keyData?.scope;
     const userRole = nsScopeToTier(scope);
     const username = keyData?.description || keyData?.['key-id'] || 'api-user';
     return { username, userRole, scope: typeof scope === 'string' ? scope : undefined, expiresIn };
    } catch (keyErr: unknown) {
     const keyStatus = (keyErr as { response?: { status?: number; data?: { message?: string } } })?.response?.status;
     const keyMsg = (keyErr as { response?: { data?: { message?: string } } })?.response?.data?.message || (keyErr as Error).message;
     if (keyStatus === 401) {
      throw new Error('401 Unauthorized: Invalid NetSapiens API key.');
     }
     throw new Error(`API key validation failed: ${keyMsg}`);
    }
   }
   if (status === 401) {
    throw new Error('401 Unauthorized: Invalid NetSapiens token.');
   }
   const data = (err as { response?: { data?: { message?: string } } })?.response?.data;
   throw new Error(`Token validation failed: ${data?.message || (err as Error).message}`);
  }
 }

 /**
  * Called by our custom POST /mfa route after the user submits the passcode.
  */
 async handleMfa(req: Request, res: Response, passcode: string): Promise<void> {
  if (isCrossSitePost(req)) {
   logger.warn('Rejected cross-site MFA POST');
   sendPage(res, 440, this.renderErrorPage('MFA verification window has expired. Close this tab and reconnect from your MCP client to start over.', 440));
   return;
  }

  const formState = (req.body as Record<string, unknown> | undefined)?.[MFA_STATE_FIELD];
  const sealed = typeof formState === 'string' ? formState : undefined;
  const challenge = sealed ? openSealed<MfaChallenge>(sealed) : null;
  if (!challenge) {
   logger.warn('MFA rejected: no usable challenge state', {
    hadFormState: typeof formState === 'string',
   });
   sendPage(res, 440, this.renderErrorPage('MFA verification window has expired. Close this tab and reconnect from your MCP client to start over.', 440));
   return;
  }

  try {
   await this.withOperation('mfa', async (opCtx) => {
    let nsTokens: NsTokenResponse;
    try {
     nsTokens = await this.nsMfaGrant(challenge, passcode);
    } catch (err: any) {
     const msg = err.message?.includes('401') || err.message?.toLowerCase().includes('passcode') || err.message?.toLowerCase().includes('invalid')
      ? 'Invalid or expired passcode. Try again.'
      : `MFA failed: ${err.message}`;
     const resealed = sealValue(challenge, MFA_CHALLENGE_TTL_SEC);
     sendPage(res, 200, this.renderMfaPage('/mfa', challenge.mfaVendor, msg, resealed));
     return;
    }

    await this.completeLogin(challenge.pending, { ...nsTokens, nsApiUrl: this.nsApiUrl }, challenge.username, res, undefined, false, { operation: opCtx, completeOperation: true });
   });
  } catch (err: unknown) {
   if (err instanceof CutoverRefusedError || kitCodeOf(err) === 'cutover_refused') {
    res.setHeader('Retry-After', '5');
    sendPage(res, 503, this.renderErrorPage('Cutover in progress; sign-in temporarily unavailable', 503));
    return;
   }
   throw err;
  }
 }

 /**
  * Shared finalization: detect role, issue auth code, redirect back to MCP client.
  */
 private async completeLogin(
  pending: PendingAuthorization,
  nsTokens: NsTokenResponse,
  username: string,
  res: Response,
  tokenExtra?: Record<string, string>,
  skipHooks = false,
  options?: { operation?: LegacyOperationContext; completeOperation?: boolean },
 ): Promise<void> {
  let nsUserRole = nsTokens.nsUserRole;
  let whoUser = username;
  let whoDomain = '';
  let whoScope = nsTokens.scope ?? '';
  let displayName = username;
  let email = '';

  if (!nsUserRole || !whoScope) {
   try {
    const detected = await this.detectNsUserInfo(nsTokens.access_token, nsTokens.nsApiUrl, username);
    if (!nsUserRole) nsUserRole = detected.role;
    if (!whoUser || whoUser === username) whoUser = detected.user;
    if (!whoDomain) whoDomain = detected.domain;
    if (!whoScope) whoScope = detected.scope;
    if (!displayName || displayName === username) displayName = detected.displayName;
    if (!email) email = detected.email;
   } catch (err) {
    logger.warn('Failed to detect user role, defaulting to user', { error: String(err) });
   }
  } else {
   if (username.includes('@')) {
    const parts = username.split('@');
    whoUser = parts[0];
    whoDomain = parts[1];
   }
  }

  const tier: UserRole = nsScopeToTier(whoScope || nsUserRole);
  const who: NsUserSnapshot = {
   user: whoUser,
   domain: whoDomain,
   scope: whoScope,
   displayName,
   email,
  };

  if (!skipHooks && this.hooks?.onLogin) {
   const nonce = randomBytes(16).toString('hex');
   const resumeToken = sealValue(
    {
     nonce,
     pending,
     nsTokens: { ...nsTokens, username, nsUserRole },
     username,
     who,
     tier,
    },
    PENDING_AUTH_TTL_SEC,
   );

   const decision = await this.hooks.onLogin({
    who,
    tier,
    clientId: pending.clientId,
    nsAccessToken: nsTokens.access_token,
    nsApiUrl: nsTokens.nsApiUrl || this.nsApiUrl,
    resumeToken,
   });

   if (decision.kind === 'deny') {
    sendPage(res, decision.status, decision.html);
    return;
   }
   if (decision.kind === 'interstitial') {
    const html = decision.html.replaceAll('{{RESUME_TOKEN}}', resumeToken);
    sendPage(res, 200, html);
    return;
   }
   if (decision.kind === 'continue') {
    tokenExtra = { ...tokenExtra, ...decision.tokenExtra };
   }
  }

  const code = randomBytes(32).toString('hex');
  const authCodeData = {
   pending,
   nsTokens: { ...nsTokens, username, nsUserRole },
   extra: tokenExtra,
   serverBaseUrl: this.serverBaseUrl,
   clientId: pending.clientId,
  };

  if (this.authCodeStore) {
   if (options?.operation) {
    await this.authCodeStore.set(code, authCodeData, options);
   } else {
    await this.withOperation('auth_code', async (opCtx) => {
     await this.authCodeStore!.set(code, authCodeData, { operation: opCtx, completeOperation: true });
    });
   }
  } else {
   this.authCodes.set(code, authCodeData);
   setTimeout(() => this.authCodes.delete(code), 5 * 60 * 1000);
  }

  const redirectUrl = new URL(pending.redirectUri);
  redirectUrl.searchParams.set('code', code);
  if (pending.state) {
   redirectUrl.searchParams.set('state', pending.state);
  }
  res.redirect(redirectUrl.toString());
 }

 /**
  * Resumes login after an interstitial page posts back to a host route.
  */
 async resumeLogin(
  res: Response,
  resumeToken: string,
  extra?: Record<string, string>,
 ): Promise<void> {
  const payload = openSealed<{
   nonce?: string;
   pending: PendingAuthorization;
   nsTokens: NsTokenResponse;
   username: string;
   who: NsUserSnapshot;
   tier: UserRole;
  }>(resumeToken);

  if (!payload) {
   sendPage(res, 440, this.renderErrorPage('Your sign-in session has expired. Close this tab and reconnect from your MCP client to start over.', 440));
   return;
  }

  try {
   await this.withOperation('resume', async (opCtx) => {
    const parts = resumeToken.split('.');
    const canonicalDecodedBytes = Buffer.concat(parts.map((p) => Buffer.from(p, 'base64url')));
    const resumeId = payload.nonce
     ? createHash('sha256').update(`nonce:${payload.nonce}`).digest('hex')
     : createHash('sha256').update(canonicalDecodedBytes).digest('hex');

    if (this.db) {
     const resumeRef = this.db.collection(this.resumeTokensCollection).doc(resumeId);
     const code = randomBytes(32).toString('hex');
     const now = this.nowProvider();
     const expiresAt = now + 5 * 60 * 1000;
     const authCodeData = {
      pending: payload.pending,
      nsTokens: { ...payload.nsTokens, username: payload.username },
      extra,
      expiresAt,
      ttlAt: new Date(expiresAt),
      used: false,
      serverBaseUrl: this.serverBaseUrl,
      clientId: payload.pending.clientId,
     };
     const codeRef = this.db.collection(this.authCodesCollection).doc(code);
     const success = await this.db.runTransaction(async (transaction) => {
      let guard: GuardMutationResult | undefined;
      if (this.fenceConfig?.enforce) {
       guard = await checkMutationGuardInTransaction(transaction, {
        db: this.db!,
        namespace: this.fenceNamespace,
        operation: opCtx,
        completeOperation: true,
        now: this.nowProvider,
       });
      }
      const resumeSnap = await transaction.get(resumeRef);
      if (resumeSnap.exists) {
       return false;
      }
      guard?.bufferCompletion(now);
      transaction.set(resumeRef, {
       consumedAt: now,
       expiresAt: now + 2 * 60 * 60 * 1000,
       ttlAt: new Date(now + 2 * 60 * 60 * 1000),
      });
      transaction.set(codeRef, stripUndefined(authCodeData as unknown as Record<string, unknown>));
      return true;
     });

     if (!success) {
      sendPage(res, 400, this.renderErrorPage('This sign-in session has already been completed. Close this tab and reconnect from your MCP client.', 400));
      return;
     }

     const redirectUrl = new URL(payload.pending.redirectUri);
     redirectUrl.searchParams.set('code', code);
     if (payload.pending.state) {
      redirectUrl.searchParams.set('state', payload.pending.state);
     }
     res.redirect(redirectUrl.toString());
     return;
    }

    const consumed = await this.consumeResumeToken(resumeId, { operation: opCtx, completeOperation: false });
    if (!consumed) {
     sendPage(res, 400, this.renderErrorPage('This sign-in session has already been completed. Close this tab and reconnect from your MCP client.', 400));
     return;
    }

    await this.completeLogin(
     payload.pending,
     payload.nsTokens,
     payload.username,
     res,
     extra,
     true,
     { operation: opCtx, completeOperation: true },
    );
   });
  } catch (err: unknown) {
   if (err instanceof CutoverRefusedError || kitCodeOf(err) === 'cutover_refused') {
    res.setHeader('Retry-After', '5');
    sendPage(res, 503, this.renderErrorPage('Cutover in progress; sign-in temporarily unavailable', 503));
    return;
   }
   throw err;
  }
 }

 private async consumeResumeToken(
  resumeId: string,
  options?: { operation?: LegacyOperationContext; completeOperation?: boolean },
 ): Promise<boolean> {
  if (this.db) {
   const docRef = this.db.collection(this.resumeTokensCollection).doc(resumeId);
   return await this.db.runTransaction(async (transaction) => {
    let guard: GuardMutationResult | undefined;
    if (this.fenceConfig?.enforce) {
     guard = await checkMutationGuardInTransaction(transaction, {
      db: this.db!,
      namespace: this.fenceNamespace,
      operation: options?.operation,
      completeOperation: options?.completeOperation !== false,
      now: this.nowProvider,
     });
    }
    const snap = await transaction.get(docRef);
     if (snap.exists) {
      guard?.bufferCompletion(this.nowProvider());
      return false;
     }
     const now = this.nowProvider();
     const expiresAt = now + 2 * 60 * 60 * 1000;
     guard?.bufferCompletion(now);
     transaction.set(docRef, {
      consumedAt: now,
      expiresAt,
      ttlAt: new Date(expiresAt),
     });
     return true;
    });
  }
  if (this.consumedResumeTokens.has(resumeId)) {
   return false;
  }
  this.consumedResumeTokens.add(resumeId);
  setTimeout(() => this.consumedResumeTokens.delete(resumeId), 2 * 60 * 60 * 1000);
  return true;
 }

 // -----------------------------------------------------------------------
 // Token exchange
 // -----------------------------------------------------------------------

 async challengeForAuthorizationCode(
  client: OAuthClientInformationFull,
  authorizationCode: string,
 ): Promise<string> {
  if (this.authCodeStore) {
   const challenge = await this.authCodeStore.getChallenge(authorizationCode, {
    serverBaseUrl: this.serverBaseUrl,
    clientId: client.client_id,
   });
   if (!challenge) {
    throw new InvalidGrantError('Invalid authorization code');
   }
   return challenge;
  }

  const entry = this.authCodes.get(authorizationCode);
  if (!entry) {
   throw new InvalidGrantError('Invalid authorization code');
  }
  if (entry.serverBaseUrl || this.serverBaseUrl) {
   if (!entry.serverBaseUrl || !this.serverBaseUrl || entry.serverBaseUrl.toLowerCase() !== this.serverBaseUrl.toLowerCase()) {
    throw new InvalidGrantError('Invalid authorization code');
   }
  }
  if (client?.client_id && entry.clientId && entry.clientId !== client.client_id) {
   throw new InvalidGrantError('Invalid authorization code');
  }
  return entry.pending.codeChallenge;
 }

 async exchangeAuthorizationCode(
  client: OAuthClientInformationFull,
  authorizationCode: string,
 ): Promise<OAuthTokens> {
  return await this.withOperation('auth_code', async (opCtx) => {
   if (this.authCodeStore && 'redeemAndIssue' in this.authCodeStore && this.tokenStore instanceof FirestoreTokenStore) {
    const result = await this.authCodeStore.redeemAndIssue(
     authorizationCode,
     this.tokenStore,
     {
      serverBaseUrl: this.serverBaseUrl,
      clientId: client.client_id,
      tokenLifetimeSec: this.tokenLifetimeSec,
     },
     { operation: opCtx },
    );
    if (!result) {
     throw new InvalidGrantError('Invalid authorization code');
    }
    return result.tokens;
   }

   if (this.authCodeStore) {
    const entry = await this.authCodeStore.redeem(authorizationCode, {
     serverBaseUrl: this.serverBaseUrl,
     clientId: client.client_id,
    }, { operation: opCtx });
    if (!entry) {
     throw new InvalidGrantError('Invalid authorization code');
    }
    return this.issueTokens(entry.pending.clientId, entry.nsTokens, entry.extra, { operation: opCtx });
   }

   const inMemEntry = this.authCodes.get(authorizationCode);
   if (!inMemEntry) {
    throw new InvalidGrantError('Invalid authorization code');
   }
   if (inMemEntry.serverBaseUrl || this.serverBaseUrl) {
    if (!inMemEntry.serverBaseUrl || !this.serverBaseUrl || inMemEntry.serverBaseUrl.toLowerCase() !== this.serverBaseUrl.toLowerCase()) {
     throw new InvalidGrantError('Invalid authorization code');
    }
   }
   if (client?.client_id && inMemEntry.clientId && inMemEntry.clientId !== client.client_id) {
    throw new InvalidGrantError('Invalid authorization code');
   }
   this.authCodes.delete(authorizationCode);

   return this.issueTokens(inMemEntry.pending.clientId, inMemEntry.nsTokens, inMemEntry.extra, { operation: opCtx });
  });
 }

 async exchangeRefreshToken(
  client: OAuthClientInformationFull,
  refreshToken: string,
 ): Promise<OAuthTokens> {
  return await this.withOperation('refresh', async (opCtx) => {
   try {
    const expectedClientId = client?.client_id;
    let stored: StoredToken | undefined;

    if ('lookupRefresh' in this.tokenStore && typeof (this.tokenStore as unknown as { lookupRefresh: unknown }).lookupRefresh === 'function') {
     const ledger = this.tokenStore as unknown as TokenLedger<StoredToken>;
     const lookup = await ledger.lookupRefresh(
      refreshToken,
      expectedClientId,
      this.nowProvider(),
      { operation: opCtx },
     );
     if (lookup.status === 'missing' || lookup.status === 'replay') {
      logger.warn('Refresh token rejected', { status: lookup.status });
      throw new InvalidGrantError('Invalid refresh token');
     }
     if (lookup.status === 'retry') {
      const remainingSec = Math.max(1, Math.round((lookup.token.expiresAt - this.nowProvider()) / 1000));
      return {
       access_token: lookup.token.accessToken,
       token_type: 'Bearer',
       expires_in: remainingSec,
       refresh_token: lookup.token.refreshToken,
      };
     }
     stored = lookup.token;
    } else {
     stored = await this.tokenStore.getByRefreshToken(refreshToken);
     if (!stored) {
      logger.warn('Refresh token presented but unknown: user will be asked to reconnect');
      throw new InvalidGrantError('Invalid refresh token');
     }
     if (expectedClientId && stored.clientId !== expectedClientId) {
      logger.warn('Refresh token client mismatch', {
       expected: expectedClientId,
       actual: stored.clientId,
      });
      throw new InvalidGrantError('Invalid refresh token');
     }
    }

    if (this.hooks?.onVerify) {
     try {
      await this.hooks.onVerify(stored);
     } catch (err: unknown) {
      if (err instanceof InvalidTokenError) {
       if ('revokeFamily' in this.tokenStore && stored.refreshFamilyId) {
        await (this.tokenStore as unknown as TokenLedger<StoredToken>).revokeFamily(stored.refreshFamilyId, { operation: opCtx });
       } else {
        await (this.tokenStore as TokenStoreLike).delete(stored.accessToken);
       }
       throw new InvalidGrantError(err.message);
      }
      logger.warn('Refresh authorization check failed with operational error', { error: String(err) });
      throw new TemporarilyUnavailableError('Refresh authorization check temporarily unavailable');
     }
    }

    // Try to refresh the upstream NS token if we have a refresh token
    let nsTokens: NsTokenResponse;
    if (stored.nsRefreshToken) {
     try {
      if (this.tokenStore instanceof FirestoreTokenStore && stored.refreshFamilyId) {
       const storeWithRefresh = this.tokenStore as FirestoreTokenStore;
       const upstreamStore = (storeWithRefresh as any).upstreamStore;
       const upstreamGrant = await upstreamStore.ensureFresh(
        stored.refreshFamilyId,
        async (currentGrant: any) => {
         const grantObj = currentGrant?.grant ?? currentGrant ?? {};
         const res = await this.nsRefreshGrant(
          grantObj.nsRefreshToken ?? stored.nsRefreshToken!,
          grantObj.nsApiUrl ?? stored.nsApiUrl,
         );
         return {
          grant: {
           nsAccessToken: res.access_token,
           nsRefreshToken: res.refresh_token ?? stored.nsRefreshToken,
           nsExpiresAt: res.expires_in ? this.nowProvider() + res.expires_in * 1000 : undefined,
           nsUsername: stored.nsUsername,
           nsUserRole: stored.nsUserRole,
           nsApiUrl: stored.nsApiUrl,
          },
          expiresAt: res.expires_in ? this.nowProvider() + res.expires_in * 1000 : undefined,
         };
        },
        { operation: opCtx, now: this.nowProvider(), force: true, completeOperation: false },
       );
       const effectiveGrant = (upstreamGrant as any)?.grant ?? upstreamGrant;
       nsTokens = {
        access_token: effectiveGrant.nsAccessToken,
        refresh_token: effectiveGrant.nsRefreshToken,
        expires_in: effectiveGrant.nsExpiresAt ? Math.max(1, Math.round((effectiveGrant.nsExpiresAt - this.nowProvider()) / 1000)) : 3600,
        username: effectiveGrant.nsUsername ?? stored.nsUsername,
        nsUserRole: effectiveGrant.nsUserRole ?? stored.nsUserRole,
        nsApiUrl: effectiveGrant.nsApiUrl ?? stored.nsApiUrl,
       };
      } else {
       nsTokens = await this.nsRefreshGrant(stored.nsRefreshToken, stored.nsApiUrl);
       nsTokens.username = stored.nsUsername;
       nsTokens.nsUserRole = stored.nsUserRole;
       nsTokens.nsApiUrl = stored.nsApiUrl;
      }
     } catch (err: unknown) {
      if (err instanceof UpstreamGrantRejectedError || err instanceof UpstreamRevokedError || kitCodeOf(err) === 'upstream_revoked') {
       if ('revokeFamily' in this.tokenStore && stored.refreshFamilyId) {
        await (this.tokenStore as unknown as TokenLedger<StoredToken>).revokeFamily(stored.refreshFamilyId, { operation: opCtx });
       } else {
        await (this.tokenStore as TokenStoreLike).delete(stored.accessToken);
       }
       throw new InvalidGrantError('Upstream token refresh failed. Please re-authenticate.');
      }
      const isTimeout =
        err instanceof UpstreamTimeoutError ||
        (err && typeof err === 'object' && 'code' in err && ((err as { code: unknown }).code === 'ETIMEDOUT' || (err as { code: unknown }).code === 'ECONNABORTED')) ||
        (err && typeof err === 'object' && 'name' in err && (err as { name: unknown }).name === 'UpstreamTimeoutError') ||
        (err instanceof Error && err.message.toLowerCase().includes('timeout'));
      opCtx?.markAmbiguousRemoteOutcome(isTimeout ? 'upstream_timeout' : 'upstream_transport_error');
      throw toTokenEndpointError(err);
     }
    } else {
     logger.warn('MCP refresh attempted but no upstream NS refresh token on file', {
      username: stored.nsUsername,
     });
     throw new InvalidGrantError('No upstream refresh token available. Please re-authenticate.');
    }

    const newAccess = randomBytes(32).toString('hex');
    const newRefresh = randomBytes(32).toString('hex');
    const expiresAt = this.nowProvider() + this.tokenLifetimeSec * 1000;
    const nsExpiresAt = nsTokens.expires_in
     ? this.nowProvider() + nsTokens.expires_in * 1000
     : undefined;

    const replacement: StoredToken = {
     accessToken: newAccess,
     refreshToken: newRefresh,
     clientId: stored.clientId,
     expiresAt,
     ttlAt: new Date(expiresAt + 30 * 24 * 60 * 60 * 1000),
     extra: stored.extra,
     nsAccessToken: nsTokens.access_token,
     nsRefreshToken: nsTokens.refresh_token,
     nsExpiresAt,
     nsUsername: nsTokens.username ?? 'unknown',
     nsUserRole: nsTokens.nsUserRole,
     nsApiUrl: nsTokens.nsApiUrl,
     serverBaseUrl: this.serverBaseUrl,
    };

    try {
     if ('rotate' in this.tokenStore && typeof (this.tokenStore as unknown as { rotate: unknown }).rotate === 'function') {
      const rot = await (this.tokenStore as unknown as TokenLedger<StoredToken>).rotate(
       refreshToken,
       replacement,
       stored.clientId,
       this.nowProvider(),
       { operation: opCtx },
      );
      if (rot.status === 'retry') {
       const remainingSec = Math.max(1, Math.round((rot.token.expiresAt - this.nowProvider()) / 1000));
       return {
        access_token: rot.token.accessToken,
        token_type: 'Bearer',
        expires_in: remainingSec,
        refresh_token: rot.token.refreshToken,
       };
      }
      if (rot.status === 'replay' || rot.status === 'missing') {
       throw new InvalidGrantError('Invalid refresh token');
      }
     } else {
      await this.tokenStore.delete(stored.accessToken);
      await this.tokenStore.set(replacement);
     }
    } catch (rotErr) {
     opCtx?.markAmbiguousRemoteOutcome('local_commit_failure');
     throw rotErr;
    }

    logger.info('MCP bearer refreshed via refresh_token', {
     username: stored.nsUsername,
     clientId: stored.clientId,
    });

    return {
     access_token: newAccess,
     token_type: 'Bearer',
     expires_in: this.tokenLifetimeSec,
     refresh_token: newRefresh,
    };
   } catch (err: unknown) {
    throw toTokenEndpointError(err);
   }
  });
 }

 // -----------------------------------------------------------------------
 // Token verification
 // -----------------------------------------------------------------------

 async verifyAccessToken(token: string): Promise<AuthInfo> {
  const op = requestOperationContext.getStore();
  let stored: StoredToken | undefined;
  if (this.tokenStore instanceof FirestoreTokenStore) {
   stored = await this.tokenStore.getByAccessToken(token, { operation: op });
  } else {
   stored = await this.tokenStore.get(token);
  }
  if (!stored) {
   throw new InvalidTokenError('Invalid access token');
  }

  if (stored.serverBaseUrl && this.serverBaseUrl) {
   if (stored.serverBaseUrl.toLowerCase() !== this.serverBaseUrl.toLowerCase()) {
    logger.warn('Token rejected: serverBaseUrl mismatch (cross-server token)', {
     tokenServer: stored.serverBaseUrl,
     expectedServer: this.serverBaseUrl,
    });
    throw new InvalidTokenError('Access token was issued for a different server');
   }
  }

  if (this.nowProvider() > stored.expiresAt) {
   const ageMs = this.nowProvider() - stored.expiresAt;
   logger.info('MCP bearer expired: client should refresh', {
    username: stored.nsUsername,
    clientId: stored.clientId,
    ageSec: Math.round(ageMs / 1000),
    hadRefreshToken: !!stored.refreshToken,
   });
   // Do NOT delete the token document here per C1
   throw new InvalidTokenError('Access token expired');
  }

  // Transparently refresh the upstream NS token if it has expired or is within 60s of expiry.
  // The MCP client never sees this: it just keeps using the same MCP bearer token.
  const NS_REFRESH_SKEW_MS = 60_000;
  const nsExpired = stored.nsExpiresAt && this.nowProvider() > stored.nsExpiresAt - NS_REFRESH_SKEW_MS;
  if (nsExpired) {
   if (stored.nsRefreshToken) {
    if (this.hooks?.onVerify) {
     try {
      await this.hooks.onVerify(stored);
     } catch (err: unknown) {
      if (err instanceof InvalidTokenError) {
       await this.withOperation('revocation', async (opCtx) => {
        await (this.tokenStore as any).delete(token, { operation: opCtx });
       });
       throw err;
      }
      logger.warn('Pre-refresh verification hook failed with operational error', {
       error: err instanceof Error ? err.message : String(err),
      });
      throw new TemporarilyUnavailableError('Verification service temporarily unavailable, please retry');
     }
    }
    if ('refreshNsToken' in this.tokenStore && typeof (this.tokenStore as unknown as { refreshNsToken: unknown }).refreshNsToken === 'function') {
     try {
      const storeWithRefresh = this.tokenStore as FirestoreTokenStore;
      stored = await this.withOperation('upstream_refresh', async (opCtx) => {
       return await storeWithRefresh.refreshNsToken(token, (current: StoredToken) =>
        this.nsRefreshGrant(current.nsRefreshToken!, current.nsApiUrl),
        { operation: opCtx },
       );
      });
     } catch (err: unknown) {
      if (err instanceof UpstreamGrantRejectedError || err instanceof UpstreamRevokedError || kitCodeOf(err) === 'upstream_revoked') {
       logger.warn('Upstream NS refresh grant rejected by NetSapiens', { error: String(err) });
       await this.tokenStore.delete(token);
       throw new InvalidTokenError('Upstream access token expired and could not be refreshed');
      }
      logger.warn('Cross-instance NS token refresh failed with non-fatal error', { error: String(err) });
      if ('clearCache' in this.tokenStore && typeof this.tokenStore.clearCache === 'function') {
       this.tokenStore.clearCache();
      }
      const latest = await this.tokenStore.get(token);
      if (latest && (!latest.nsExpiresAt || this.nowProvider() <= latest.nsExpiresAt - NS_REFRESH_SKEW_MS)) {
       stored = latest;
      } else {
       throw new UpstreamUnavailableError('Upstream token refresh temporarily unavailable, please retry');
      }
     }
    } else {
     let inflight = this.nsRefreshInflight.get(token);
     if (!inflight) {
      inflight = this.refreshUpstreamNsToken(token, stored)
       .finally(() => this.nsRefreshInflight.delete(token));
      this.nsRefreshInflight.set(token, inflight);
     }
     try {
      await inflight;
      stored = (await this.tokenStore.get(token)) ?? stored;
     } catch (err: unknown) {
      if (err instanceof UpstreamGrantRejectedError || err instanceof UpstreamRevokedError || kitCodeOf(err) === 'upstream_revoked') {
       logger.warn('Upstream NS refresh grant rejected by NetSapiens', { error: String(err) });
       await this.tokenStore.delete(token);
       throw new InvalidTokenError('Upstream access token expired and could not be refreshed');
      }
      logger.warn('In-memory NS token refresh failed with non-fatal error', { error: String(err) });
      if ('clearCache' in this.tokenStore && typeof this.tokenStore.clearCache === 'function') {
       this.tokenStore.clearCache();
      }
      const latest = await this.tokenStore.get(token);
      if (latest && (!latest.nsExpiresAt || this.nowProvider() <= latest.nsExpiresAt - NS_REFRESH_SKEW_MS)) {
       stored = latest;
      } else {
       throw new UpstreamUnavailableError('Upstream token refresh temporarily unavailable, please retry');
      }
     }
    }
    if (stored.nsExpiresAt && this.nowProvider() > stored.nsExpiresAt) {
     await this.tokenStore.delete(token);
     throw new InvalidTokenError('Upstream access token expired and could not be refreshed');
    }
   } else {
    await this.tokenStore.delete(token);
    throw new InvalidTokenError('Upstream access token expired');
   }
  }

  const authInfo: AuthInfo = {
   token,
   clientId: stored.clientId,
   scopes: [],
   expiresAt: Math.floor(stored.expiresAt / 1000),
   extra: {
    nsAccessToken: stored.nsAccessToken,
    nsUsername: stored.nsUsername,
    nsUserRole: stored.nsUserRole,
    nsApiUrl: stored.nsApiUrl,
   },
  };

  if (this.hooks?.onVerify) {
   try {
    const governance = await this.hooks.onVerify(stored);
    if (authInfo.extra) {
     authInfo.extra.governance = governance;
    }
   } catch (err: unknown) {
    if (err instanceof InvalidTokenError) {
     throw err;
    }
    throw new InvalidTokenError(err instanceof Error ? err.message : String(err));
   }
  }

  return authInfo;
 }

 private async refreshUpstreamNsToken(token: string, stored: StoredToken): Promise<void> {
  const refreshed = await this.nsRefreshGrant(stored.nsRefreshToken!, stored.nsApiUrl);
  await this.tokenStore.update(token, {
   nsAccessToken: refreshed.access_token,
   nsRefreshToken: refreshed.refresh_token ?? stored.nsRefreshToken,
   nsExpiresAt: refreshed.expires_in ? this.nowProvider() + refreshed.expires_in * 1000 : undefined,
  });
  logger.info('Refreshed upstream NS token', { username: stored.nsUsername });
 }

 // -----------------------------------------------------------------------
 // Revocation
 // -----------------------------------------------------------------------

 async revokeToken(
  _client: OAuthClientInformationFull,
  request: OAuthTokenRevocationRequest,
 ): Promise<void> {
  const { token } = request;
  await this.withOperation('revocation', async (opCtx) => {
   const stored = this.tokenStore instanceof FirestoreTokenStore
    ? await this.tokenStore.getByAccessToken(token, { operation: opCtx })
    : await this.tokenStore.get(token);
   if (stored) {
    if ('revokeFamily' in this.tokenStore && stored.refreshFamilyId) {
     await (this.tokenStore as unknown as TokenLedger<StoredToken>).revokeFamily(stored.refreshFamilyId, { operation: opCtx });
    } else {
     await (this.tokenStore as any).delete(token, { operation: opCtx });
    }
    return;
   }

   const byRefresh = await this.tokenStore.getByRefreshToken(token);
   if (byRefresh) {
    if ('revokeFamily' in this.tokenStore && byRefresh.refreshFamilyId) {
     await (this.tokenStore as unknown as TokenLedger<StoredToken>).revokeFamily(byRefresh.refreshFamilyId, { operation: opCtx });
    } else {
     await (this.tokenStore as any).deleteByRefreshToken(token, { operation: opCtx });
    }
   }
  });
 }
 // -----------------------------------------------------------------------
 // Lookup: get the upstream NS access token for a verified MCP token
 // -----------------------------------------------------------------------

 async getNsAccessToken(mcpToken: string): Promise<string | undefined> {
  return await this.withOperation('read', async (opCtx) => {
   const stored = this.tokenStore instanceof FirestoreTokenStore
    ? await this.tokenStore.getByAccessToken(mcpToken, { operation: opCtx })
    : await this.tokenStore.get(mcpToken);
   return stored?.nsAccessToken;
  });
 }

 async forceRefreshUpstream(mcpToken: string): Promise<string | undefined> {
  const op = requestOperationContext.getStore();
  const stored = this.tokenStore instanceof FirestoreTokenStore
   ? await this.tokenStore.getByAccessToken(mcpToken, { operation: op })
   : await this.tokenStore.get(mcpToken);
  if (!stored || !stored.nsRefreshToken) return undefined;
  if (this.hooks?.onVerify) {
   try {
    await this.hooks.onVerify(stored);
   } catch (err: unknown) {
    if (err instanceof InvalidTokenError) {
     await this.withOperation('revocation', async (opCtx) => {
      await (this.tokenStore as any).delete(mcpToken, { operation: opCtx });
     });
     return undefined;
    }
    throw new TemporarilyUnavailableError('Verification service temporarily unavailable, please retry');
   }
  }
  return await this.withOperation('upstream_refresh', async (opCtx) => {
   if ('refreshNsToken' in this.tokenStore && typeof (this.tokenStore as unknown as { refreshNsToken: unknown }).refreshNsToken === 'function') {
    try {
     const storeWithRefresh = this.tokenStore as FirestoreTokenStore;
     const refreshed = await storeWithRefresh.refreshNsToken(
      mcpToken,
      (current: StoredToken) => this.nsRefreshGrant(current.nsRefreshToken!, current.nsApiUrl),
      { operation: opCtx },
     );
     return refreshed.nsAccessToken;
    } catch (err: unknown) {
     if (err instanceof UpstreamRevokedError || kitCodeOf(err) === 'upstream_revoked') {
      await (this.tokenStore as any).delete(mcpToken, { operation: opCtx });
     }
     throw err;
    }
   } else {
    try {
     await this.refreshUpstreamNsToken(mcpToken, stored);
     const latest = await this.tokenStore.get(mcpToken);
     return latest?.nsAccessToken;
    } catch (err: unknown) {
     if (err instanceof UpstreamRevokedError || kitCodeOf(err) === 'upstream_revoked') {
      await (this.tokenStore as any).delete(mcpToken, { operation: opCtx });
     }
     throw err;
    }
   }
  });
 }
 // -----------------------------------------------------------------------
 // Private helpers
 // -----------------------------------------------------------------------

 private async issueTokens(
  clientId: string,
  nsTokens: NsTokenResponse,
  extra?: Record<string, string>,
  options?: { operation?: LegacyOperationContext },
 ): Promise<OAuthTokens> {
  const accessToken = randomBytes(32).toString('hex');
  const refreshToken = randomBytes(32).toString('hex');
  const expiresAt = this.nowProvider() + this.tokenLifetimeSec * 1000;
  const nsExpiresAt = nsTokens.expires_in
   ? this.nowProvider() + nsTokens.expires_in * 1000
   : undefined;

  const stored: StoredToken = {
   accessToken,
   refreshToken,
   clientId,
   expiresAt,
   ttlAt: new Date(expiresAt + 30 * 24 * 60 * 60 * 1000),
   extra,
   nsAccessToken: nsTokens.access_token,
   nsRefreshToken: nsTokens.refresh_token,
   nsExpiresAt,
   nsUsername: nsTokens.username ?? 'unknown',
   nsUserRole: nsTokens.nsUserRole,
   nsApiUrl: nsTokens.nsApiUrl,
   serverBaseUrl: this.serverBaseUrl,
  };

  if ('issue' in this.tokenStore) {
   await (this.tokenStore as FirestoreTokenStore).issue(stored, options);
  } else {
   await this.tokenStore.set(stored);
  }

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
   const detail = nsMessage ? `${status}: ${nsMessage}` : err.message;
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
   const detail = nsMessage ? `${status}: ${nsMessage}` : err.message;
   throw new Error(detail);
  }
 }

 private async detectNsUserInfo(
  nsAccessToken: string,
  targetApiUrl?: string,
  username?: string,
 ): Promise<{
  user: string;
  domain: string;
  scope: string;
  role: string;
  displayName: string;
  email: string;
 }> {
  const url = targetApiUrl || this.nsApiUrl;
  const defaultUser = username && username.includes('@') ? username.split('@')[0] : (username ?? 'user');
  const defaultDomain = username && username.includes('@') ? username.split('@')[1] : '';

  try {
   const response = await axios.get(`${url}/ns-api/v2/domains/~/users/~`, {
    headers: { Authorization: `Bearer ${nsAccessToken}` },
   });
   const data = response.data;
   const scope = (data?.['user-scope'] ?? data?.scope ?? data?.type ?? '') as string;
   const role = nsScopeToTier(scope);
   const user = (data?.user as string | undefined) ?? defaultUser;
   const domain = (data?.domain as string | undefined) ?? defaultDomain;
   const firstName = data?.['name-first-name'] ?? data?.['first-name'];
   const lastName = data?.['name-last-name'] ?? data?.['last-name'];
   const displayName = [firstName, lastName].filter(Boolean).join(' ') || data?.name || data?.description || user;
   const email = (data?.email || data?.['email-address'] || '') as string;

   logger.info('Detected NS user role', { scope, role, username: user });
   return { user, domain, scope, role, displayName, email };
  } catch (err: unknown) {
   const status = (err as { response?: { status?: number } })?.response?.status;
   if (status === 400) {
    try {
     const keyRes = await axios.get(`${url}/ns-api/v2/apikeys/~`, {
      headers: { Authorization: `Bearer ${nsAccessToken}` },
     });
     const keyData = keyRes.data;
     const scope = (keyData?.['user-scope'] ?? keyData?.scope ?? '') as string;
     const role = nsScopeToTier(scope);
     return {
      user: (keyData?.['key-id'] as string | undefined) ?? defaultUser,
      domain: defaultDomain,
      scope,
      role,
      displayName: (keyData?.description as string | undefined) ?? defaultUser,
      email: '',
     };
    } catch {
     // Ignore
    }
   }
   logger.warn('NS role detection API call failed', { error: String(err) });
   return {
    user: defaultUser,
    domain: defaultDomain,
    scope: '',
    role: 'user',
    displayName: defaultUser,
    email: '',
   };
  }
 }

 private async detectNsUserRole(
  nsAccessToken: string,
  targetApiUrl?: string,
  username?: string,
 ): Promise<string> {
  const info = await this.detectNsUserInfo(nsAccessToken, targetApiUrl, username);
  return info.role;
 }

 private async nsRefreshGrant(nsRefreshToken: string, targetApiUrl?: string): Promise<NsTokenResponse> {
  const url = targetApiUrl || this.nsApiUrl;
  try {
   const response = await axios.post(
    `${url}/ns-api/v2/tokens`,
    {
     grant_type: 'refresh_token',
     client_id: this.nsClientId,
     client_secret: this.nsClientSecret,
     refresh_token: nsRefreshToken,
    },
    {
     headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
     timeout: 10_000,
    },
   );

   return {
    access_token: response.data.access_token,
    refresh_token: response.data.refresh_token,
    expires_in: response.data.expires_in,
    username: '', // caller fills this in
    nsApiUrl: targetApiUrl,
   };
  } catch (err: unknown) {
   if (axios.isAxiosError(err)) {
    const status = err.response?.status ?? 500;
    const data = err.response?.data;
    const desc = (typeof data === 'object' && data && ((data as Record<string, unknown>).error_description || (data as Record<string, unknown>).error || (data as Record<string, unknown>).message)) || err.message;
    const classification = classifyUpstreamTokenResponse(status, data ?? desc);
    if (classification === 'definitive') {
     throw new UpstreamRevokedError(`Upstream refresh grant definitive failure (${status}): ${String(desc)}`);
    }
    throw new UpstreamUnavailableError(`Upstream refresh grant transient failure (${status}): ${String(desc)}`);
   }
   throw err;
  }
 }

 async invalidateToken(mcpToken: string, options?: { operation?: LegacyOperationContext }): Promise<void> {
  if (options?.operation) {
   await (this.tokenStore as any).delete(mcpToken, options);
   return;
  }
  await this.withOperation('revocation', async (opCtx) => {
   await (this.tokenStore as any).delete(mcpToken, { operation: opCtx });
  });
 }
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
