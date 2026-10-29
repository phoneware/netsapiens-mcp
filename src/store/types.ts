import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { PendingAuthorization, NsTokenResponse } from '../auth/types.js';

export interface StoredToken { clientId: string; expiresAt: number; nsAccessToken: string; nsRefreshToken?: string; nsExpiresAt?: number; nsUsername: string; nsUserRole?: string; nsApiUrl?: string; serverBaseUrl?: string; extra?: Record<string, string>; }
export interface UpstreamTokens { access_token: string; refresh_token?: string; expires_in?: number; }
export interface AuthCodeData { pending: PendingAuthorization; nsTokens: NsTokenResponse; extra?: Record<string, string>; serverBaseUrl?: string; clientId?: string; }
export interface UsageRecord { count: number; lastUsed: number; }
export interface StoreCapabilities { persistent: boolean; multiInstance: boolean; exclusive: boolean; expiry: 'sweep' | 'ttl-policy'; }
export interface SessionStore {
  create(tokens: { accessToken: string; refreshToken: string }, session: StoredToken): Promise<void>;
  get(accessToken: string): Promise<StoredToken | undefined>;
  getByRefreshToken(refreshToken: string): Promise<StoredToken | undefined>;
  delete(accessToken: string): Promise<void>;
  deleteByRefreshToken(refreshToken: string): Promise<void>;
  refreshUpstream(accessToken: string, doRefresh: (s: StoredToken) => Promise<UpstreamTokens>, opts?: { maxWaitMs?: number; pollIntervalMs?: number; leaseDurationMs?: number }): Promise<StoredToken>;
}
export interface AuthCodeStore {
  put(code: string, data: AuthCodeData): Promise<void>;
  getChallenge(code: string, expected: { serverBaseUrl?: string; clientId?: string }): Promise<string | undefined>;
  redeem(code: string, expected: { serverBaseUrl?: string; clientId?: string }): Promise<AuthCodeData | undefined>;
}
export interface ResumeTokenStore { consume(resumeId: string): Promise<boolean>; }
export interface UsageStore { recordCall(userKey: string, toolName: string): Promise<void>; getUserUsage(userKey: string): Promise<Map<string, UsageRecord>>; }
export interface McpStore {
  readonly backend: string; readonly namespace: string; readonly capabilities: StoreCapabilities;
  readonly sessions: SessionStore; readonly clients: OAuthRegisteredClientsStore;
  readonly authCodes: AuthCodeStore; readonly resumeTokens: ResumeTokenStore; readonly usage: UsageStore;
  close(): Promise<void>;
}
export interface SessionRow { id: string; refreshId: string; expiresAt: number; retainUntil: number; nsExpiresAt?: number; leaseOwner?: string; leaseUntil?: number; sealed: string; }
export interface AuthCodeRow { id: string; expiresAt: number; sealed: string; }
export interface ResumeRow { id: string; consumedAt: number; expiresAt: number; }
export interface StoreBackend {
  readonly name: string; readonly capabilities: StoreCapabilities;
  getSession(id: string): Promise<SessionRow | undefined>;
  findSessionByRefreshId(refreshId: string): Promise<SessionRow | undefined>;
  putSession(row: SessionRow): Promise<void>;
  updateSession(id: string, mutate: (cur: SessionRow) => SessionRow | null | undefined): Promise<SessionRow | undefined>;
  deleteSession(id: string): Promise<void>;
  putAuthCode(row: AuthCodeRow): Promise<void>;
  getAuthCode(id: string): Promise<AuthCodeRow | undefined>;
  takeAuthCode(id: string): Promise<AuthCodeRow | undefined>;
  insertResumeIfAbsent(row: ResumeRow, now: number): Promise<boolean>;
  incrementUsage(userHash: string, toolName: string, now: number): Promise<void>;
  listUsage(userHash: string): Promise<Array<{ toolName: string; count: number; lastUsed: number }>>;
  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined>;
  putClient(client: OAuthClientInformationFull): Promise<void>;
  sweep(now: number): Promise<number>;
  close(): Promise<void>;
}
