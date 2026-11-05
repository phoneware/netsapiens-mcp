import { createHash } from 'node:crypto';
import { canonicalJson } from '../cutover/dsse-verifier-core.mjs';
import { CutoverFenceError, CutoverRefusedError } from './errors.js';
import { subjectRefFor, type SubjectGuard } from './subject-guard.js';

// Public subject descriptor ABI. The descriptor is data from the signed index schema
// (binding.subjectDescriptors). This module names no namespace, customer, seat or
// collection. A deployment's signed approval supplies every value.
//
// Policy: every protected namespace must have an explicit entry. null is a deliberate
// "no subject" policy. An absent or malformed declaration refuses before any read.
// Caller overrides are not accepted anywhere.

export interface SubjectDescriptor {
  readonly extraKey: string;
  readonly required: boolean;
  readonly guard?: { readonly collection: string; readonly field: string; readonly allow: readonly string[] };
}

export type SubjectDescriptors = Readonly<Record<string, SubjectDescriptor | null>>;

// The migration's view of one namespace. refFor is the keyed reference function for it.
export interface SubjectSpec {
  readonly namespace: string;
  readonly extraKey: string;
  readonly required: boolean;
  readonly refFor: (value: string) => string;
}

const NAMESPACE = /^[a-z][a-z0-9_]{0,63}$/;
const EXTRA_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;

function refuse(message: string): never {
  throw new CutoverRefusedError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) refuse(`${label} has an unknown key`);
  }
  for (const key of required) {
    if (!(key in value)) refuse(`${label} is missing a required key`);
  }
}

// Strict validation of the signed declaration. The declaration itself must be present;
// a missing declaration refuses, and no namespace is assumed.
export function validateSubjectDescriptors(input: unknown): SubjectDescriptors {
  if (!isPlainObject(input)) refuse('subjectDescriptors must be declared by the signed index schema');
  const out: Record<string, SubjectDescriptor | null> = {};
  for (const [namespace, value] of Object.entries(input)) {
    if (!NAMESPACE.test(namespace)) refuse('subjectDescriptors names a malformed namespace');
    if (value === null) {
      out[namespace] = null;
      continue;
    }
    if (!isPlainObject(value)) refuse('subjectDescriptors entry must be null or an object');
    assertKeys(value, ['extraKey', 'required', 'guard'], ['extraKey', 'required'], 'subject descriptor');
    if (typeof value.extraKey !== 'string' || !EXTRA_KEY.test(value.extraKey)) {
      refuse('subject descriptor extraKey is malformed');
    }
    if (typeof value.required !== 'boolean') refuse('subject descriptor required must be boolean');
    let guard: SubjectDescriptor['guard'];
    if (value.guard !== undefined) {
      if (!isPlainObject(value.guard)) refuse('subject descriptor guard must be an object');
      const g = value.guard;
      assertKeys(g, ['collection', 'field', 'allow'], ['collection', 'field', 'allow'], 'subject descriptor guard');
      if (typeof g.collection !== 'string' || !g.collection || g.collection.includes('/')) {
        refuse('subject descriptor guard collection is malformed');
      }
      if (typeof g.field !== 'string' || !FIELD.test(g.field)) refuse('subject descriptor guard field is malformed');
      if (!Array.isArray(g.allow) || g.allow.length === 0 || g.allow.some((item) => typeof item !== 'string' || !item)) {
        refuse('subject descriptor guard allow-list is malformed');
      }
      guard = { collection: g.collection, field: g.field, allow: [...(g.allow as string[])] };
    }
    out[namespace] = { extraKey: value.extraKey, required: value.required, ...(guard ? { guard } : {}) };
  }
  return Object.freeze(out);
}

// Refuses unless the signed declaration names this namespace explicitly (null counts).
export function assertSubjectDeclared(descriptors: SubjectDescriptors, namespace: string): void {
  if (!Object.prototype.hasOwnProperty.call(descriptors, namespace)) {
    refuse(`Signed subject descriptor policy is not declared for namespace ${namespace}`);
  }
}

// Digest recorded in the protected binding. It is redundant with indexSchemaDigest and
// lets the protected context check the declaration before any read.
export function subjectDescriptorDigest(descriptors: SubjectDescriptors): string {
  return createHash('sha256').update(canonicalJson(descriptors), 'utf8').digest('hex');
}

export function subjectSpecFor(descriptors: SubjectDescriptors, namespace: string, storeKey: Uint8Array): SubjectSpec | null {
  assertSubjectDeclared(descriptors, namespace);
  const entry = descriptors[namespace];
  if (!entry) return null;
  return {
    namespace,
    extraKey: entry.extraKey,
    required: entry.required,
    refFor: (value: string) => subjectRefFor(storeKey, namespace, entry.extraKey, value),
  };
}

// The sealed family extra value for the signed key. Absent or null: hold when required,
// otherwise no reference. Present but not a non-empty string: ambiguous, so always hold.
// Errors never contain the value.
function requiredValue(extraKey: string, extra: Record<string, unknown> | undefined): unknown {
  return extra?.[extraKey];
}

export function subjectRefsForFamily(
  spec: SubjectSpec | null | undefined,
  extra: Record<string, unknown> | undefined,
): string[] | undefined {
  if (!spec) return undefined;
  const value = requiredValue(spec.extraKey, extra);
  if (value === undefined || value === null) {
    if (spec.required) {
      throw new CutoverFenceError(`Migrated family has no '${spec.extraKey}' subject value for namespace ${spec.namespace}; preparation holds`);
    }
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new CutoverFenceError(`Migrated family has an ambiguous '${spec.extraKey}' subject value for namespace ${spec.namespace}; preparation holds`);
  }
  return [spec.refFor(value)];
}

// Issuance-time subject for the provider's resolver: the signed extra key, the value from
// the authorized request, and the guard whose document id is the value. The same rules as
// migration apply: absent holds when required, an ambiguous value always refuses.
export function subjectIssuanceFromDescriptor(
  descriptors: SubjectDescriptors,
  namespace: string,
  extra: Record<string, unknown> | undefined,
): { extraKey: string; value: string; guard?: SubjectGuard } | undefined {
  assertSubjectDeclared(descriptors, namespace);
  const entry = descriptors[namespace];
  if (!entry) return undefined;
  const value = requiredValue(entry.extraKey, extra);
  if (value === undefined || value === null) {
    if (entry.required) refuse(`Subject value is required for namespace ${namespace}`);
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0) refuse(`Subject value is ambiguous for namespace ${namespace}`);
  const guard: SubjectGuard | undefined = entry.guard
    ? { collection: entry.guard.collection, documentId: value, field: entry.guard.field, allow: entry.guard.allow }
    : undefined;
  return { extraKey: entry.extraKey, value, ...(guard ? { guard } : {}) };
}
