import type { Codec } from './codec.js';
import type { SubjectSpec } from './subject-descriptor.js';

export const PROJECTOR_ID = 'netsapiens-mcp/v2-v3-projector';
export const PROJECTOR_VERSION = 1;

export { CutoverFenceError } from './errors.js';

export function codeUnitCompare(a: string, b: string): number;

export { createCodec, type Codec } from './codec.js';
export { subjectSpecFor } from './subject-descriptor.js';
export function sanitizeId(id: unknown): string;
export function getTimestampMs(val: unknown): number | null;

export const familyAad: (params: { id: string; generation: number }) => string;
export const upstreamAad: (params: { id: string; grantVersion: number }) => string;
export const accessAad: (params: { id: string; familyId: string }) => string;

// A candidate is identified by its kind literal, so each source projection's return type follows from it.
export interface ProjectorCandidate<K extends string = string> {
  id: string;
  kind: K;
  targets: Array<{ collection: string; id: string }>;
  logicalDigest: string;
}

export interface ProjectionSnapshotEntry {
  readonly collection: string;
  readonly physicalId: string;
  readonly data: Readonly<Record<string, unknown>>;
}
export function buildSourceProjectionMap(candidate: ProjectorCandidate, entries: readonly ProjectionSnapshotEntry[], codec: Codec): Map<string, Record<string, unknown>>;
export function buildTargetProjectionMap(candidate: ProjectorCandidate, entries: readonly ProjectionSnapshotEntry[]): Map<string, Record<string, unknown>>;

// The return shapes of the source projections, as the projector builds them (netsapiens-projector.mjs).
export interface PreviousRefreshProjection {
  id: string;
  consumedAt: number;
  generation: number;
  successor: { accessToken: string; refreshToken: string };
}
export interface UpstreamProjection {
  grantVersion: number;
  nsAccessToken: string;
  nsRefreshToken: string | null;
  nsUsername: string;
  nsUserRole: string | null;
  nsApiUrl: string | null;
  nsExpiresAt: number | null;
}
export interface FamilyProjection {
  familyId: string;
  generation: number;
  status: 'active' | 'revoked';
  clientId: string;
  serverBaseUrl: string | null;
  extra: Record<string, string>;
  activeRefreshId: string;
  currentAccessTokenId: string;
  previousRefresh: PreviousRefreshProjection | null;
  retiredRefreshFingerprints: string[];
  subjectRefs?: string[];
  upstream: UpstreamProjection;
  expiresAt: number;
  v: 2;
}
export interface AuthCodeProjection {
  codeId: string;
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
  state: string | null;
  scopes: string[];
  nsAccessToken: string;
  nsRefreshToken: string | null;
  nsUsername: string | null;
  nsUserRole: string | null;
  nsApiUrl: string | null;
  serverBaseUrl: string | null;
  extra: Record<string, string>;
  used: boolean;
  v: 2;
}
export interface ResumeTokenProjection {
  resumeId: string;
  consumedAt: number;
  expiresAt: number;
  v: 2;
}
export interface ClientProjection {
  clientId: string;
  clientName: string | null;
  clientSecret: string | null;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  grantTypes: string[];
  responseTypes: string[];
  clientUri: string | null;
  logoUri: string | null;
  scope: string | null;
  clientIdIssuedAt: number | null;
  v: 2;
}

export function projectSourceLogical(
  candidate: ProjectorCandidate<'pr56Families' | 'baseFormatTokens'>,
  sources: Map<string, Record<string, unknown>>,
  codec: Codec,
  subject: SubjectSpec | null,
): FamilyProjection;
export function projectSourceLogical(
  candidate: ProjectorCandidate<'authCodes'>,
  sources: Map<string, Record<string, unknown>>,
  codec: Codec,
  subject: SubjectSpec | null,
): AuthCodeProjection;
export function projectSourceLogical(
  candidate: ProjectorCandidate<'resumeTokens'>,
  sources: Map<string, Record<string, unknown>>,
  codec: Codec,
  subject: SubjectSpec | null,
): ResumeTokenProjection;
export function projectSourceLogical(
  candidate: ProjectorCandidate<'clients'>,
  sources: Map<string, Record<string, unknown>>,
  codec: Codec,
  subject: SubjectSpec | null,
): ClientProjection;

export function projectTargetLogical(
  candidate: ProjectorCandidate,
  targets: Map<string, Record<string, unknown>>,
  codec: Codec,
): Record<string, unknown>;
