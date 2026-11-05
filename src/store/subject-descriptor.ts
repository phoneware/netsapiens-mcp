import { createHash } from 'node:crypto';
import { canonicalJson } from '../cutover/dsse-verifier-core.mjs';
import type { Codec } from './codec.js';
import { CutoverFenceError, CutoverRefusedError } from './errors.js';
import { subjectRefFor, type SubjectGuard } from './subject-guard.js';

// Public subject descriptor ABI. The descriptor is data from the signed index schema
// (binding.subjectDescriptors). This library never names a customer, seat or
// collection; a deployment's signed approval supplies every value. Caller overrides
// are not accepted anywhere.

export const SUBJECT_NAMESPACES = ['mcp', 'pwmcp', 'readonly_mcp'] as const;
export type SubjectNamespace = (typeof SUBJECT_NAMESPACES)[number];

export interface SubjectDescriptor {
  readonly extraKey: string;
  readonly required: boolean;
  readonly guard?: { readonly collection: string; readonly field: string; readonly allow: readonly string[] };
}

export type SubjectDescriptors = Readonly<Partial<Record<SubjectNamespace, SubjectDescriptor | null>>>;

// The migration's view of one namespace: which sealed family extra key carries the
// subject value, and whether a migrated family without it refuses.
export interface SubjectSpec {
  readonly namespace: string;
  readonly extraKey: string;
  readonly required: boolean;
}

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

// Strict validation of the signed descriptor. Unknown keys, unsupported namespaces and
// malformed values refuse; nothing is defaulted.
export function validateSubjectDescriptors(input: unknown): SubjectDescriptors | null {
  if (input === undefined || input === null) return null;
  if (!isPlainObject(input)) refuse('subjectDescriptors must be an object');
  const out: Record<string, SubjectDescriptor | null> = {};
  for (const [namespace, value] of Object.entries(input)) {
    if (!(SUBJECT_NAMESPACES as readonly string[]).includes(namespace)) {
      refuse('subjectDescriptors names an unsupported namespace');
    }
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
  return Object.freeze(out) as SubjectDescriptors;
}

// Digest recorded in the protected binding. It is redundant with indexSchemaDigest and
// lets the protected context check the descriptor before any read.
export function subjectDescriptorDigest(descriptors: SubjectDescriptors | null): string {
  return createHash('sha256').update(canonicalJson(descriptors ?? null), 'utf8').digest('hex');
}

export function subjectSpecFor(descriptors: SubjectDescriptors | null, namespace: string): SubjectSpec | null {
  const entry = descriptors?.[namespace as SubjectNamespace];
  if (!entry) return null;
  return { namespace, extraKey: entry.extraKey, required: entry.required };
}

// Migrated family reference. Missing or empty values fail closed for a required spec and
// omit the reference otherwise. The value is never placed in an error message.
export function subjectRefsForFamily(
  spec: SubjectSpec | null | undefined,
  extra: Record<string, unknown> | undefined,
  codec: Codec,
): string[] | undefined {
  if (!spec) return undefined;
  const value = extra?.[spec.extraKey];
  if (typeof value !== 'string' || value.length === 0) {
    if (spec.required) {
      throw new CutoverFenceError(`Migrated family has no '${spec.extraKey}' subject value under the signed descriptor for namespace ${spec.namespace}`);
    }
    return undefined;
  }
  return [subjectRefFor(codec, spec.namespace, spec.extraKey, value)];
}

// Issuance-time subject for the provider's resolver: the signed descriptor's extra key,
// the value from the authorized request, and the guard whose document id is the value.
export function subjectIssuanceFromDescriptor(
  descriptors: SubjectDescriptors | null,
  namespace: string,
  extra: Record<string, unknown> | undefined,
): { extraKey: string; value: string; guard?: SubjectGuard } | undefined {
  const entry = descriptors?.[namespace as SubjectNamespace];
  if (!entry) return undefined;
  const value = extra?.[entry.extraKey];
  if (typeof value !== 'string' || value.length === 0) {
    if (entry.required) refuse(`Subject value is required for namespace ${namespace}`);
    return undefined;
  }
  const guard: SubjectGuard | undefined = entry.guard
    ? { collection: entry.guard.collection, documentId: value, field: entry.guard.field, allow: entry.guard.allow }
    : undefined;
  return { extraKey: entry.extraKey, value, ...(guard ? { guard } : {}) };
}
