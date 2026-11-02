import type { Codec } from './codec.js';

export const PROJECTOR_ID = 'netsapiens-mcp/v2-v3-projector';
export const PROJECTOR_VERSION = 1;

export class CutoverFenceError extends Error {
  readonly kitCode = 'cutover_fence_error';
  constructor(message: string);
}

export function codeUnitCompare(a: string, b: string): number;

export function createCodec(root: string | Uint8Array): {
  id(purpose: string, value: string): string;
  open<T = unknown>(sealed: unknown, aad: string): T | null;
};

export const familyAad: (params: { id: string; generation: number }) => string;
export const upstreamAad: (params: { id: string; grantVersion: number }) => string;
export const accessAad: (params: { id: string; familyId: string }) => string;

export interface ProjectorCandidate {
  id: string;
  kind: string;
  sources: Array<{ collection: string; id: string; recordDigest: string }>;
  targets: Array<{ collection: string; id: string }>;
  logicalDigest: string;
}

export function projectSourceLogical(
  candidate: ProjectorCandidate,
  sources: Map<string, Record<string, unknown>>,
  codec: { id(purpose: string, value: string): string; open<T = unknown>(sealed: unknown, aad: string): T | null },
): Record<string, unknown>;

export function projectTargetLogical(
  candidate: ProjectorCandidate,
  targets: Map<string, Record<string, unknown>>,
  codec: { id(purpose: string, value: string): string; open<T = unknown>(sealed: unknown, aad: string): T | null },
): Record<string, unknown>;
