import type { UserRole } from './roles.js';
import type { StoredToken } from '../store/types.js';

export interface NsUserSnapshot {
  user: string;
  domain: string;
  scope: string;
  displayName: string;
  email: string;
}

export type LoginDecision =
  | { kind: 'continue'; tokenExtra: Record<string, string> }
  | { kind: 'deny'; status: 403; html: string }
  | { kind: 'interstitial'; html: string };

export interface AuthHooks {
  onLogin(input: {
    who: NsUserSnapshot;
    tier: UserRole;
    clientId: string;
    nsAccessToken: string;
    nsApiUrl: string;
    resumeToken?: string;
  }): Promise<LoginDecision>;
  /**
   * Invoked on every access token verification (HTTP /mcp) and on refresh token exchange
   * before any upstream refresh grant.
   *
   * On access token verification: any thrown error maps to 401 InvalidTokenError.
   * On refresh token exchange: InvalidTokenError deletes the session and maps to 400 InvalidGrantError.
   * Other errors leave the session intact and map to 500 ServerError.
   */
  onVerify(stored: StoredToken): Promise<Record<string, unknown>>;
}

export interface RenderPagesOptions {
  login?(props: {
    authorizeUrl: string;
    error?: string;
    authState?: string;
    initialTab?: 'password' | 'token';
  }): string;
  mfa?(props: {
    mfaUrl: string;
    mfaVendor?: string;
    error?: string;
    mfaState?: string;
  }): string;
  error?(props: {
    message: string;
    status?: number;
  }): string;
}

export interface PendingAuthorization {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  state?: string;
  scopes?: string[];
  resource?: URL;
  createdAt: number;
}

export interface NsTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  username?: string;
  nsUserRole?: string;
  scope?: string;
  nsApiUrl?: string;
}

export type { StoredToken, AuthCodeData } from '../store/types.js';
export type { NetSapiensAuthProviderOptions } from './netsapiens-auth-provider.js';
