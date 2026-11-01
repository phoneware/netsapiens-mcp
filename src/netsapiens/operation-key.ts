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
