/**
 * The one record guard the package uses. It proves a value is a plain object, not its fields: a field read through
 * the narrowed type is still unknown and is checked where it is used.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
