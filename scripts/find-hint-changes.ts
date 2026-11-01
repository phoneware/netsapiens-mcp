import { toolRegistry } from '../src/generated/registry.js';

// Old 2.3.1 logic
const READ_PREFIXES = ['get_', 'list_', 'count_', 'search_', 'test_', 'export_', 'download_', 'read_', 'find_', 'lookup_'];
const MIXED_PREFIXES = ['manage_'];
const DESTRUCTIVE_HINTS = ['delete_', 'revoke_', 'remove_', 'cancel_', 'destroy_', 'reset_', 'restart_', 'reboot_', 'restore_'];

function oldClassify(name) {
  if (READ_PREFIXES.some((p) => name.startsWith(p))) {
    return { readOnlyHint: true, destructiveHint: false };
  }
  if (MIXED_PREFIXES.some((p) => name.startsWith(p))) {
    return { readOnlyHint: false, destructiveHint: true };
  }
  if (name.startsWith('get_')) return { readOnlyHint: true, destructiveHint: false };
  if (name.startsWith('delete_')) return { readOnlyHint: false, destructiveHint: true };
  if (name.startsWith('put_') || name.startsWith('patch_') || name.startsWith('post_')) {
    return { readOnlyHint: false, destructiveHint: false };
  }
  const destructive = DESTRUCTIVE_HINTS.some((p) => name.startsWith(p));
  return { readOnlyHint: false, destructiveHint: destructive };
}

function newClassify(name, def) {
  if (def?.operation?.family === 'v2') {
    const method = String(def.operation.method).toUpperCase();
    if (method === 'GET') return { readOnlyHint: true, destructiveHint: false };
    if (method === 'DELETE') return { readOnlyHint: false, destructiveHint: true };
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') return { readOnlyHint: false, destructiveHint: false };
  }
  return oldClassify(name);
}

const changes = [];

for (const [name, def] of toolRegistry) {
  const oldH = oldClassify(name);
  const newH = newClassify(name, def);
  if (oldH.readOnlyHint !== newH.readOnlyHint || oldH.destructiveHint !== newH.destructiveHint) {
    changes.push({
      name,
      operation: def.operation?.key,
      method: def.operation?.method,
      oldHints: oldH,
      newHints: newH,
    });
  }
}

console.log(JSON.stringify(changes, null, 2));
