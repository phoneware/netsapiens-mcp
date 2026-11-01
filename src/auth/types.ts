import type { UserRole } from './roles.js';
import type { StoredToken } from './token-store.js';

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

export interface AuthCodeData {
  pending: PendingAuthorization;
  nsTokens: NsTokenResponse;
  extra?: Record<string, string>;
  expiresAt: number;
  ttlAt: Date;
  used?: boolean;
  serverBaseUrl?: string;
  clientId?: string;
}

export type { StoredToken } from './token-store.js';
export type { NetSapiensAuthProviderOptions } from './netsapiens-auth-provider.js';
export type {
  CutoverFenceConfig,
  CutoverFenceControlRecord,
  CutoverFenceState,
  LegacyOperationContext,
} from './kit/cutover-fence.js';
