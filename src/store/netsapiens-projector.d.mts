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

export interface ProjectorCandidate {
  id: string;
  kind: string;
  targets: Array<{ collection: string; id: string }>;
  logicalDigest: string;
}

export function projectSourceLogical(
  candidate: ProjectorCandidate,
  sources: Map<string, Record<string, unknown>>,
  codec: Codec,
  subject: SubjectSpec | null,
): Record<string, unknown>;

export function projectTargetLogical(
  candidate: ProjectorCandidate,
  targets: Map<string, Record<string, unknown>>,
  codec: Codec,
): Record<string, unknown>;
