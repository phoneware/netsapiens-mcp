import { runStoreConformance } from '../conformance.js';
import { deriveStoreKey } from '../codec.js';
import { MemoryBackend } from '../memory.js';
import { createStore } from '../store.js';
import type { SessionRow } from '../types.js';

const backends = new Map<string, MemoryBackend>();
const key = deriveStoreKey('memory conformance secret key 12345');
runStoreConformance({
  name: 'memory',
  capabilities: { persistent: false, multiInstance: false, exclusive: false, expiry: 'sweep' },
  async open(namespace) { const backend = new MemoryBackend(); backends.set(namespace, backend); return createStore(backend, { namespace, key }); },
  async dumpRaw(namespace) {
    return JSON.stringify(backends.get(namespace), (_key, value) => value instanceof Map ? Object.fromEntries(value) : value);
  },
  async swapSealed(namespace, idA, idB) {
    const backend = backends.get(namespace)!;
    const a = await backend.getSession(idA); const b = await backend.getSession(idB);
    if (!a || !b) throw new Error('Missing session');
    await backend.putSession({ ...a, sealed: b.sealed } as SessionRow);
    await backend.putSession({ ...b, sealed: a.sealed } as SessionRow);
  },
  async cleanup(namespace) { backends.delete(namespace); },
});
