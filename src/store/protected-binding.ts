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
}

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

interface ContextFields extends ProtectedIdentityFields {
  readonly db: object;
  readonly FieldPath: unknown;
  readonly key: Uint8Array;
}

// Refuses before any Firestore data access unless the caller's context is the
// one this handle was authenticated for, the operation matches, and the
// options equal the authorized options exactly. Marks the handle consumed.
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
  consumed.add(context.db);
  return binding;
}

export function getProtectedBinding(db: object): ProtectedBinding | undefined {
  return bindings.get(db);
}
