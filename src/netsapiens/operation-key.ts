export type OperationMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export function normalizeOperationKey(method: string, path: string): string {
  const upper = method.toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(upper)) {
    throw new Error(`Unsupported operation method: ${method}`);
  }
  let normalized = path.replace(/#\d+$/, '');
  if (normalized !== '/') normalized = normalized.replace(/\/$/, '');
  normalized = normalized.split('/').map(segment => segment === '~' || /^\{[^}]*\}$/.test(segment) ? '{}' : segment).join('/');
  return `${upper} ${normalized}`;
}

/**
 * The verbs that remove something or end it. A v1 action carries its verb at the start (deleteEvents), at the end
 * (link_delete), or as the camelCase abbreviation del followed by a capital (delWakeUp). The group derivation and the
 * operation guard both read this: a destructive v1 action is judged as the DELETE it performs.
 */
const V1_DESTRUCTIVE_VERB = /^(delete|remove|destroy|cancel|revoke|reset|restart|reboot|restore|purge|clear|terminate)|_(delete|remove|destroy|cancel|revoke|reset|restart|reboot|restore|purge|clear|terminate)$/i;
const V1_DELETE_ABBREVIATION = /^del[A-Z]/;

/** Whether a v1 action is destructive, whatever its object. */
export function isDestructiveV1Action(action: string): boolean {
  return V1_DESTRUCTIVE_VERB.test(action) || V1_DELETE_ABBREVIATION.test(action);
}

/** The v1 actions the access policy reads as read-only. Mirrors READ_ACTION in src/access/policy.ts. */
export const V1_READ_ACTION = /^(read|count|list|search|get)/;
