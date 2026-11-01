import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { PendingAuthorization, NsTokenResponse } from '../auth/types.js';

export interface StoredToken {
  clientId: string;
  expiresAt: number;
  nsAccessToken: string;
  nsRefreshToken?: string;
  nsExpiresAt?: number;
  nsUsername: string;
  nsUserRole?: string;
  nsApiUrl?: string;
  serverBaseUrl?: string;
  extra?: Record<string, string>;
}
export interface StoredSession extends StoredToken {
  refreshFamilyId: string;
}
export interface OAuthTokenPair {
  accessToken: string;
  refreshToken: string;
}
export type RefreshLookupResult =
  | { status: 'active'; familyId: string; generation: number; grantVersion?: number; session: StoredSession }
  | { status: 'retry'; familyId: string; generation: number; session: StoredSession; tokens: OAuthTokenPair }
  | { status: 'replay'; familyId: string }
  | { status: 'missing' };
export type RefreshRotationResult =
  | { status: 'claimed'; familyId: string; session: StoredSession; tokens: OAuthTokenPair }
  | { status: 'retry'; familyId: string; session: StoredSession; tokens: OAuthTokenPair }
  | { status: 'replay' }
  | { status: 'missing' };
export interface RevokeCondition {
  expectedFamilyGeneration?: number;
  expectedUpstreamGrantVersion?: number;
  expectedLeaseOwner?: string;
}
export interface BackendRotateParams {
  oldRefreshId: string;
  expectedClientId?: string;
  now: number;
  newAccessRow: AccessRow;
  newRefreshRow: RefreshPointerRow;
  newSuccessorSealed: string;
  newFamilySealed: string;
  newUpstreamSealed?: string;
  newNsExpiresAt?: number;
  retiredFingerprint?: string;
  legacyFingerprint?: string;
}
export type BackendRotateResult =
  | { status: 'claimed'; familyId: string; generation: number }
  | { status: 'retry'; familyId: string; generation: number; successorSealed: string }
  | { status: 'replay'; familyId?: string }
  | { status: 'missing' };
export interface AtomicIssueParams {
  accessRow: AccessRow;
  refreshRow: RefreshPointerRow;
  familyRow: FamilyRow;
  upstreamRow: UpstreamGrantRow;
}
export interface UpstreamTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}
export interface AuthCodeData {
  pending: PendingAuthorization;
  nsTokens: NsTokenResponse;
  extra?: Record<string, string>;
  serverBaseUrl?: string;
  clientId?: string;
}
export interface UsageRecord { count: number; lastUsed: number; }
export interface StoreCapabilities {
  persistent: boolean;
  multiInstance: boolean;
  exclusive: boolean;
  expiry: 'sweep' | 'ttl-policy';
}
export interface SessionStore {
  create(tokens: OAuthTokenPair, session: StoredToken): Promise<StoredSession>;
  get(accessToken: string): Promise<StoredSession | undefined>;
  getByRefreshToken(refreshToken: string): Promise<StoredSession | undefined>;
  lookupRefresh(
    refreshToken: string,
    expectedClientId: string,
    now: number,
  ): Promise<RefreshLookupResult>;
  rotate(
    oldRefreshToken: string,
    replacement: { tokens: OAuthTokenPair; session: StoredToken },
    expectedClientId: string,
    now: number,
  ): Promise<RefreshRotationResult>;
  revokeByToken(token: string): Promise<void>;
  revokeFamily(
    familyId: string,
    condition?: RevokeCondition,
  ): Promise<'revoked' | 'stale' | 'missing'>;
  refreshUpstream(
    familyIdOrToken: string,
    doRefresh: (s: StoredSession) => Promise<UpstreamTokens>,
    options?: {
      force?: boolean;
      maxWaitMs?: number;
      pollIntervalMs?: number;
      leaseDurationMs?: number;
    },
  ): Promise<StoredSession>;
  delete(accessToken: string): Promise<void>;
  deleteByRefreshToken(refreshToken: string): Promise<void>;
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
  sweep?(now: number): Promise<number>;
  close(): Promise<void>;
}
export interface AccessRow {
  id: string;
  familyId: string;
  expiresAt: number;
  retainUntil: number;
  sealed: string;
}
export interface RefreshPointerRow {
  id: string;
  familyId: string;
  status: 'active' | 'consumed';
  generation: number;
  consumedAt?: number;
  successorSealed?: string;
}
export interface FamilyRow {
  id: string;
  generation: number;
  status: 'active' | 'revoked';
  activeRefreshId: string;
  currentAccessTokenId: string;
  revokedAt?: number;
  updatedAt: number;
  sealed: string;
}
export interface UpstreamGrantRow {
  id: string;
  grantVersion: number;
  nsExpiresAt?: number;
  leaseOwner?: string;
  leaseUntil?: number;
  updatedAt: number;
  sealed: string;
}
export interface SessionRow {
  id: string;
  refreshId: string;
  expiresAt: number;
  retainUntil: number;
  nsExpiresAt?: number;
  leaseOwner?: string;
  leaseUntil?: number;
  sealed: string;
}
export interface AuthCodeRow { id: string; expiresAt: number; sealed: string; }
export interface ResumeRow { id: string; consumedAt: number; expiresAt: number; }
export interface StoreBackend {
  readonly name: string;
  readonly capabilities: StoreCapabilities;

  getAccess(id: string, rawToken?: string): Promise<AccessRow | undefined>;
  putAccess(row: AccessRow): Promise<void>;
  deleteAccess(id: string): Promise<void>;

  getRefresh(id: string, rawRefreshToken?: string): Promise<RefreshPointerRow | undefined>;
  putRefresh(row: RefreshPointerRow): Promise<void>;
  deleteRefresh(id: string): Promise<void>;

  getFamily(id: string): Promise<FamilyRow | undefined>;
  putFamily(row: FamilyRow): Promise<void>;

  getUpstream(id: string): Promise<UpstreamGrantRow | undefined>;
  putUpstream(row: UpstreamGrantRow): Promise<void>;
  updateUpstream(
    id: string,
    mutate: (cur: UpstreamGrantRow) => UpstreamGrantRow | null | undefined,
  ): Promise<UpstreamGrantRow | undefined>;
  atomicIssue(params: AtomicIssueParams): Promise<void>;

  atomicRotate(params: BackendRotateParams): Promise<BackendRotateResult>;
  atomicRevokeFamily(
    familyId: string,
    condition?: RevokeCondition,
  ): Promise<'revoked' | 'stale' | 'missing'>;
  findFamilyByRetiredId?(retiredId: string): Promise<FamilyRow | undefined>;

  // Compatibility methods for v1 session operations
  getSession?(id: string): Promise<SessionRow | undefined>;
  findSessionByRefreshId?(refreshId: string): Promise<SessionRow | undefined>;
  putSession?(row: SessionRow): Promise<void>;
  updateSession?(id: string, mutate: (cur: SessionRow) => SessionRow | null | undefined): Promise<SessionRow | undefined>;
  deleteSession?(id: string): Promise<void>;

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
