/**
 * The governance facts of the v1 API (spec 3.6). The v1 apidoc gives each operation's parameter names and no response
 * fields, and every v1 call is a POST whatever it does, so the action name decides whether a call writes. The
 * parameter names stand for the request, and the facts feed the same destination gate as the v2 spec's facts.
 */
import type { OperationFacts } from './spec-walk.js';

/** The actions that only read: they return records or counts and set nothing. Any other action is a write. */
export const V1_READ_ACTIONS: ReadonlySet<string> = new Set([
  'count',
  'download',
  'export',
  'list',
  'play',
  'read',
  'read_media',
  'readAddressEndpoint',
  'readEvents',
  'report',
  'validate',
]);

/** The facts of one v1 operation: its action and the parameter names its apidoc declares. */
export function v1FactsOf(action: string, parameterNames: readonly string[]): OperationFacts {
  const names = new Set(parameterNames);
  return {
    responseNames: new Set(),
    responseMedia: new Set(),
    writes: !V1_READ_ACTIONS.has(action),
    bodyNames: new Set(names),
    requestNames: new Set(names),
    queryNames: new Set(),
    requestEnumValues: new Set(),
  };
}
