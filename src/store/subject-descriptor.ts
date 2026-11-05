import { canonicalJson, validateSubjectDescriptor } from '../cutover/dsse-verifier-core.mjs';
import { CutoverRefusedError } from './errors.js';
import { subjectRefFor, type SubjectGuard } from './subject-guard.js';

// Subject descriptor (contract: local://subject-descriptor-contract.md, sections 3, 6, 7).
// The single authority is the approval's verified predicate,
// predicate.serviceConfiguration.subjectDescriptor: explicit null, or one flat descriptor
// with exact keys {allow, collection, extraKey, field}. The shared verifier owns the rule.
// validateSubjectDescriptor(namespace, value) returns nothing and throws on any violation.
// This module keeps no second rule. It validates through the shared export, then returns a
// frozen copy of the value it validated.

export interface SubjectDescriptor {
  readonly allow: readonly string[];
  readonly collection: string;
  readonly extraKey: string;
  readonly field: string;
}

// The migration and store view of one bound descriptor: the sealed family extra key that
// carries the subject value, and the keyed reference function for it.
export interface SubjectSpec {
  readonly namespace: string;
  readonly extraKey: string;
  readonly refFor: (value: string) => string;
}

// An active migrated family's subject result. A missing, empty or non-string value sets
// problem. The engine counts that as subject_value_missing and never skips the family.
export interface FamilySubjectResult {
  readonly refs?: string[];
  readonly problem?: 'subject_value_missing';
}

function refuse(message: string): never {
  throw new CutoverRefusedError(message);
}

// Validates through the shared rule and returns a deep, frozen copy, so the bound
// descriptor cannot change after verification. Errors are fixed and never echo the value.
function validatedCopy(namespace: string, value: unknown): SubjectDescriptor | null {
  try {
    validateSubjectDescriptor(namespace, value);
  } catch {
    refuse('Subject descriptor is invalid for this namespace');
  }
  if (value === null) return null;
  return Object.freeze(JSON.parse(canonicalJson(value)) as SubjectDescriptor);
}

// Reads the one descriptor from a verified predicate's serviceConfiguration. The field must
// be declared explicitly (null counts). Absence refuses before any read.
export function subjectDescriptorFromPredicate(namespace: string, predicate: unknown): SubjectDescriptor | null {
  const configuration = (predicate as { serviceConfiguration?: unknown } | null | undefined)?.serviceConfiguration;
  if (configuration === null || typeof configuration !== 'object' || Array.isArray(configuration) ||
    !Object.prototype.hasOwnProperty.call(configuration, 'subjectDescriptor')) {
    refuse('Signed predicate does not declare subjectDescriptor explicitly');
  }
  return validatedCopy(namespace, (configuration as Record<string, unknown>).subjectDescriptor);
}

function nullAllowed(namespace: string): boolean {
  try {
    validateSubjectDescriptor(namespace, null);
    return true;
  } catch {
    return false;
  }
}

// Runtime delivery through env (section 7). Absent is allowed only where the shared rule
// makes null the only value. Presence must be canonical JSON bytes that the shared rule accepts.
export function subjectDescriptorFromEnv(namespace: string, raw: string | undefined): SubjectDescriptor | null {
  if (raw === undefined) return validatedCopy(namespace, null);
  if (nullAllowed(namespace)) refuse('MCP_SUBJECT_DESCRIPTOR is not allowed for this namespace');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    refuse('MCP_SUBJECT_DESCRIPTOR is not valid JSON');
  }
  if (canonicalJson(parsed) !== raw) refuse('MCP_SUBJECT_DESCRIPTOR is not canonical JSON');
  return validatedCopy(namespace, parsed);
}

export function subjectSpecFor(descriptor: SubjectDescriptor | null, namespace: string, storeKey: Uint8Array): SubjectSpec | null {
  if (!descriptor) return null;
  return {
    namespace,
    extraKey: descriptor.extraKey,
    refFor: (value: string) => subjectRefFor(storeKey, namespace, descriptor.extraKey, value),
  };
}

// Active families carry the reference. Revoked families carry no subject field at all.
export function subjectRefsForFamily(
  spec: SubjectSpec | null | undefined,
  extra: Record<string, unknown> | undefined,
  status: 'active' | 'revoked',
): FamilySubjectResult {
  if (!spec || status !== 'active') return {};
  const value = extra?.[spec.extraKey];
  if (typeof value !== 'string' || value.length === 0) return { problem: 'subject_value_missing' };
  return { refs: [spec.refFor(value)] };
}

// Issuance subject from the same bound descriptor. The guard document id is the subject
// value. An absent or ambiguous value refuses, and the message never includes it.
export function subjectIssuanceFromDescriptor(
  descriptor: SubjectDescriptor | null,
  extra: Record<string, unknown> | undefined,
): { extraKey: string; value: string; guard: SubjectGuard } | undefined {
  if (!descriptor) return undefined;
  const value = extra?.[descriptor.extraKey];
  if (typeof value !== 'string' || value.length === 0) refuse('Subject value is missing or ambiguous');
  return {
    extraKey: descriptor.extraKey,
    value,
    guard: {
      collection: descriptor.collection,
      documentId: value,
      field: descriptor.field,
      allow: descriptor.allow,
    },
  };
}
