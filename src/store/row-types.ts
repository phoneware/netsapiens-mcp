// Primitive-only row shapes for the store. Import-free by design: the protected assembly's type check reads
// this file, so it must never pull in the store, the SDK, or the auth modules. Type-only.

export interface UpstreamSealedData {
  nsAccessToken: string;
  nsRefreshToken?: string;
  nsUsername: string;
  nsUserRole?: string;
  nsApiUrl?: string;
}

export interface AccessSealedData {
  familyId: string;
  clientId: string;
  serverBaseUrl?: string;
  extra?: Record<string, string>;
}

export interface FamilySealedData {
  clientId: string;
  serverBaseUrl?: string;
  extra?: Record<string, string>;
  retiredRefreshIds?: string[];
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
  subjectRefs?: string[];
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
export interface AuthCodeRow { id: string; expiresAt: number; sealed: string; used?: boolean; }
export interface ResumeRow { id: string; consumedAt: number; expiresAt: number; }
