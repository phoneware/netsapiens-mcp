import { CutoverFenceError } from './errors.js';

export const ACCESS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_RETENTION_MS = ACCESS_RETENTION_MS;
export const REFRESH_RETRY_WINDOW_MS = 30_000;
export const MAX_RETIRED_REFRESH_FINGERPRINTS = 64;
export const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
export const RESUME_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
export const REFRESH_WAIT_MS = 15_000;
export const REFRESH_POLL_MS = 150;
export const REFRESH_LEASE_MS = 15_000;
export const REFRESH_SKEW_MS = 60_000;

export function accessAad(row: { id: string; familyId: string }): string {
  return `access:${row.id}:${row.familyId}`;
}

export function refreshAad(row: { id: string; familyId: string; generation: number }): string {
  return `refresh:${row.id}:${row.familyId}:${row.generation}`;
}

export function familyAad(row: { id: string; generation: number }): string {
  return `family:${row.id}:${row.generation}`;
}

export function upstreamAad(row: { id: string; grantVersion: number }): string {
  return `upstream:${row.id}:${row.grantVersion}`;
}

export function sessionAad(row: { id: string; refreshId: string }): string {
  return `session:${row.id}:${row.refreshId}`;
}

export function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareDescriptors(
  a: { collection: string; id: string },
  b: { collection: string; id: string },
): number {
  if (a.collection !== b.collection) return a.collection < b.collection ? -1 : 1;
  return codeUnitCompare(a.id, b.id);
}

export function safeDocEntry(
  physicalId: string,
  data: Record<string, unknown> | null | undefined,
  credentialId?: string,
): Record<string, unknown> {
  const d = data || {};
  return {
    ...d,
    physicalId,
    id: credentialId ?? (typeof d.id === 'string' && d.id ? d.id : physicalId),
  };
}

export { startMonotonicTimer } from '../cutover/canonical-core.mjs';
