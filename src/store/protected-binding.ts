import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { canonicalJson } from '../cutover/dsse-verifier-core.mjs';
import { CutoverFenceError, CutoverRefusedError } from './errors.js';

// Private provenance for a database handle created by the protected factory.
// Module-private state only: the public façade and the bundle entry never
// export these functions. Each handle runs exactly one protected operation.

export type ProtectedOperation = 'inspect' | 'adopt' | 'activate' | 'status' | 'verifyActive';

export interface ProtectedIdentityFields {
  readonly namespace: string;
  readonly expectedEpoch: number;
  readonly migrationRunId: string;
  readonly codeSha: string;
  readonly codeArtifact: string;
  readonly packageIntegrity: string;
  readonly protocolDigest: string;
}

export interface ProtectedBinding extends ProtectedIdentityFields {
  readonly profile: 'production' | 'emulator';
  readonly assemblyDigest: string;
  readonly indexSchemaDigest: string;
  readonly indexPolicyDigest: string;
  readonly indexSchema: unknown;
  readonly key: Uint8Array;
  readonly FieldPath: unknown;
  readonly authorized: { readonly operation: ProtectedOperation; readonly options: Record<string, unknown> };
  readonly adminAccess: { readonly getAccessToken: () => Promise<string>; readonly fetchFn: typeof fetch } | null;
  readonly invocation: { readonly runId: string; readonly runAttempt: string } | null;
  // SHA-256 of the exact oidc.jwt bytes that STS accepted for this handle.
  // Production only; null for the emulator, which has no credential file.
  readonly credentialDigest: string | null;
}

const CREDENTIAL_PATH = '/run/cutover/oidc.jwt';
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const bindings = new WeakMap<object, ProtectedBinding>();
const consumed = new WeakSet<object>();

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function bindProtectedContext(db: object, binding: ProtectedBinding): void {
  if (bindings.has(db)) {
    throw new CutoverFenceError('Protected migration database handle is already bound');
  }
  bindings.set(db, deepFreeze({ ...binding, key: Buffer.from(binding.key) }));
}

// Re-reads the mounted credential and requires the exact bytes STS accepted.
// Called at every protected operation entry and at each mutating transaction
// start. A rotated or swapped file refuses; decoded claims are never authority.
export function assertCredentialUnchanged(db: object): void {
  const binding = bindings.get(db);
  if (!binding) throw new CutoverRefusedError('Protected migration context required: database handle is not bound');
  if (binding.credentialDigest === null) return;
  const stat = lstatSync(CREDENTIAL_PATH);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CREDENTIAL_BYTES) {
    throw new CutoverRefusedError('Credential token file is not a bounded regular file');
  }
  const digest = createHash('sha256').update(readFileSync(CREDENTIAL_PATH)).digest('hex');
  if (digest !== binding.credentialDigest) {
    throw new CutoverRefusedError('Credential token bytes changed since the authenticated exchange');
  }
}

interface ContextFields extends ProtectedIdentityFields {
  readonly db: object;
  readonly FieldPath: unknown;
  readonly key: Uint8Array;
}

// Refuses before any Firestore data access unless the caller's context is the
// one this handle was authenticated for, the operation matches, the options
// equal the authorized options exactly, and the credential bytes are unchanged.
// Marks the handle consumed.
export function assertProtectedContext(
  context: ContextFields,
  request: { readonly operation: ProtectedOperation; readonly options: Record<string, unknown> },
): ProtectedBinding {
  const binding = bindings.get(context.db);
  if (!binding) {
    throw new CutoverRefusedError('Protected migration context required: database handle is not bound');
  }
  if (consumed.has(context.db)) {
    throw new CutoverRefusedError('Protected migration database handle was already used for an operation');
  }
  if (binding.authorized.operation !== request.operation) {
    throw new CutoverRefusedError('Protected migration operation is not the authorized operation');
  }
  if (canonicalJson(request.options) !== canonicalJson(binding.authorized.options)) {
    throw new CutoverRefusedError('Protected migration options do not match the authorized options');
  }
  const mismatch = (
    binding.namespace !== context.namespace ||
    binding.expectedEpoch !== context.expectedEpoch ||
    binding.migrationRunId !== context.migrationRunId ||
    binding.codeSha !== context.codeSha ||
    binding.codeArtifact !== context.codeArtifact ||
    binding.packageIntegrity !== context.packageIntegrity ||
    binding.protocolDigest !== context.protocolDigest ||
    binding.FieldPath !== context.FieldPath ||
    !Buffer.from(context.key).equals(Buffer.from(binding.key))
  );
  if (mismatch) {
    throw new CutoverRefusedError('Protected migration context does not match the authenticated binding');
  }
  assertCredentialUnchanged(context.db);
  consumed.add(context.db);
  return binding;
}

export function getProtectedBinding(db: object): ProtectedBinding | undefined {
  return bindings.get(db);
}
