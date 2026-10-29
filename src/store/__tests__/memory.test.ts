import { runStoreConformance } from '../conformance.js';
import type { PersistedRecord, PersistedSnapshot } from '../conformance.js';
import { createMemoryBackend, MemoryBackend } from '../memory.js';

runStoreConformance({
  name: 'memory',
  capabilities: { persistent: false, multiInstance: false, exclusive: false, expiry: 'sweep' },
  async openBackend() { return createMemoryBackend(); },
  async inspect(handle) {
    const state = (handle as MemoryBackend).state;
    const rows = (map: Map<string, unknown>, remove: string[] = []): PersistedRecord[] => [...map].map(([key, value]) => {
      const fields = JSON.parse(JSON.stringify(value)) as PersistedRecord['fields'];
      for (const field of remove) delete fields[field];
      return { key, fields };
    });
    return {
      sessions: rows(state.sessions, ['id']), authCodes: rows(state.authCodes, ['id']),
      resumeTokens: rows(state.resumeTokens, ['id']), usage: rows(state.usage), clients: rows(state.clients),
    } satisfies PersistedSnapshot;
  },
  async dumpRaw(handle) { return JSON.stringify((handle as MemoryBackend).state, (_key, value) => value instanceof Map ? Object.fromEntries(value) : value); },
  async cleanup() { },
});
