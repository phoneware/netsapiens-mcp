// Test-only gate on the reviewed runtime collection scope. Positive runner suites run only when the reviewed
// scope is closed; while the census is open (complete:false in production) they are skipped with this reason,
// so the required run never asserts a positive the production scope cannot yet support.
//
// Negative suites never use this gate. They build their fixtures from the reviewed groups unchecked, and the
// factory is the gate that must refuse. The closed-scope positive proof runs on a synthetic bundle only.
import * as canonicalCore from '../../../cutover/canonical-core.mjs';

export function reviewedScopeClosed(namespace = 'mcp') {
  const scopeFn = canonicalCore.getCutoverRuntimeCollectionScope;
  if (typeof scopeFn !== 'function') return false;
  const scope = scopeFn(namespace);
  return scope?.complete === true &&
    Array.isArray(scope.unscanned) && scope.unscanned.length === 0 &&
    Array.isArray(scope.unresolved) && scope.unresolved.length === 0;
}

export const SCOPE_OPEN_REASON = 'reviewed runtime collection scope is open (complete:false); positive runner proof is skipped until the census closes';
