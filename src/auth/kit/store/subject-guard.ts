import { createHmac } from 'node:crypto';
import { CutoverRefusedError } from './errors.js';

// Subject guard for V1 and keyed subject references for V2 (seat revocation).
// The guard reads one document inside the same transaction as the credential
// write and requires a field value from an allow-list. The reference is a
// keyed HMAC, so family rows never carry a plaintext subject identifier.

export interface SubjectGuard {
  readonly collection: string;
  readonly documentId: string;
  readonly field: string;
  readonly allow: readonly string[];
}

export function assertSubjectGuardShape(guard: SubjectGuard): void {
  if (typeof guard.collection !== 'string' || !guard.collection ||
    typeof guard.documentId !== 'string' || !guard.documentId ||
    typeof guard.field !== 'string' || !guard.field ||
    !Array.isArray(guard.allow) || guard.allow.length === 0 ||
    guard.allow.some((value) => typeof value !== 'string' || !value)) {
    throw new CutoverRefusedError('Subject guard is malformed');
  }
}

// True only when the guard document exists and its field is in the allow-list.
export function subjectGuardAllows(data: Record<string, unknown> | undefined, guard: SubjectGuard): boolean {
  if (!data) return false;
  const value = data[guard.field];
  return typeof value === 'string' && guard.allow.includes(value);
}

// Keyed subject reference: HMAC under the store key over the fixed tuple
// ["netsapiens-mcp/subject", 1, namespace, extraKey, value]. The same subject always maps
// to the same reference within one namespace. Issue time and migration both call this
// function, so migrated and newly issued families match.
export function subjectRefFor(storeKey: Uint8Array, namespace: string, extraKey: string, value: string): string {
  return createHmac('sha256', storeKey)
    .update(JSON.stringify(['netsapiens-mcp/subject', 1, namespace, extraKey, value]))
    .digest('hex');
}
