import { CutoverFenceError, CutoverRefusedError } from './errors.js';

// Private provenance for a database handle created by the protected runner
// factory. Only code inside the canonical module closure can register a
// binding; the public library façade never exports these functions.
export interface ProtectedBinding {
  readonly namespace: string;
  readonly expectedEpoch: number;
  readonly migrationRunId: string;
  readonly codeSha: string;
  readonly codeArtifact: string;
  readonly packageIntegrity: string;
  readonly protocolDigest: string;
  readonly migrationManifestDigest: string;
  readonly planDigest: string;
  readonly key: Uint8Array;
  readonly FieldPath: unknown;
  readonly indexSchema: unknown;
  readonly allowedOperations: ReadonlySet<string>;
  // Filled only by the authenticated fresh Admin observation adapter. Absent
  // until that adapter runs, so preparation refuses rather than assuming coverage.
  freshCoverage?: ReadonlyMap<string, unknown>;
}

const bindings = new WeakMap<object, ProtectedBinding>();

export function bindProtectedContext(db: object, binding: ProtectedBinding): void {
  if (bindings.has(db)) {
    throw new CutoverFenceError('Protected migration database handle is already bound');
  }
  bindings.set(db, Object.freeze({ ...binding, key: Buffer.from(binding.key) }));
}

export function attachFreshIndexCoverage(db: object, coverage: ReadonlyMap<string, unknown>): void {
  const binding = bindings.get(db);
  if (!binding) throw new CutoverRefusedError('Protected migration database handle is not bound');
  if (binding.freshCoverage) throw new CutoverFenceError('Fresh index coverage is already attached');
  bindings.set(db, Object.freeze({ ...binding, freshCoverage: new Map(coverage) }));
}

interface ContextFields {
  readonly db: object;
  readonly FieldPath: unknown;
  readonly key: Uint8Array;
  readonly namespace: string;
  readonly expectedEpoch: number;
  readonly migrationRunId: string;
  readonly codeSha: string;
  readonly codeArtifact: string;
  readonly packageIntegrity: string;
  readonly protocolDigest: string;
}

// Refuses before any Firestore data access unless the caller's context is
// exactly the one the protected factory authenticated for this database.
export function assertProtectedContext(
  context: ContextFields,
  options: { operation: string; migrationManifestDigest?: string },
): ProtectedBinding {
  const binding = bindings.get(context.db);
  if (!binding) {
    throw new CutoverRefusedError('Protected migration context required: database handle is not bound');
  }
  if (!binding.allowedOperations.has(options.operation)) {
    throw new CutoverRefusedError('Protected migration operation is not authorized for this context');
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
  if (options.migrationManifestDigest !== undefined && options.migrationManifestDigest !== binding.migrationManifestDigest) {
    throw new CutoverRefusedError('Protected migration manifest digest does not match the authenticated binding');
  }
  return binding;
}

export function getProtectedBinding(db: object): ProtectedBinding | undefined {
  return bindings.get(db);
}
