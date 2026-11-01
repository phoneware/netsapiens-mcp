// Copied from @phoneware/mcp-oauth-kit 1.0.0 (phoneware/monorepo packages/mcp-oauth-kit/src/strip-undefined.ts at 998685a9dd5843a89e6eb1f3659223e7f9e31fc5). Edit the canonical file, then re-copy.
/**
 * Recursively strip undefined properties from an object or array.
 * Firestore writes and transactions reject undefined values unless
 * ignoreUndefinedProperties is explicitly set.
 */
export function stripUndefined<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item)) as unknown as T;
  }
  if (typeof value === 'object' && !(value instanceof Date)) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(record)) {
      if (val !== undefined) {
        out[key] = stripUndefined(val);
      }
    }
    return out as T;
  }
  return value;
}
