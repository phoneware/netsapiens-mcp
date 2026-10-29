import { expect, it } from 'vitest';
import { runStoreConformance } from '../conformance.js';
import { createCodec, deriveStoreKey } from '../codec.js';
import { MemoryBackend } from '../memory.js';
import { createStore, SESSION_RETENTION_MS } from '../store.js';
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

it('memory rejects a different key and swapped sealed sessions', async () => {
  const backend = new MemoryBackend();
  const store = createStore(backend, { namespace: 'test', key });
  const other = createStore(backend, { namespace: 'test', key: deriveStoreKey('another conformance secret key 12345') });
  const record = { clientId: 'client', expiresAt: Date.now() + 10_000, nsAccessToken: 'upstream', nsUsername: 'user' };
  await store.sessions.create({ accessToken: 'first', refreshToken: 'first-refresh' }, record);
  await store.sessions.create({ accessToken: 'second', refreshToken: 'second-refresh' }, record);
  expect(await other.sessions.get('first')).toBeUndefined();
  const codec = createCodec(key);
  const first = (await backend.getSession(codec.id('session', 'first')))!;
  const second = (await backend.getSession(codec.id('session', 'second')))!;
  await backend.putSession({ ...first, sealed: second.sealed });
  await backend.putSession({ ...second, sealed: first.sealed });
  expect(await store.sessions.get('first')).toBeUndefined();
  expect(await store.sessions.get('second')).toBeUndefined();
});

it('memory sweep removes physically expired rows', async () => {
  const backend = new MemoryBackend();
  const store = createStore(backend, { namespace: 'test', key });
  const now = Date.now();
  await store.sessions.create({ accessToken: 'expired', refreshToken: 'refresh' }, { clientId: 'client', expiresAt: now - SESSION_RETENTION_MS - 1, nsAccessToken: 'upstream', nsUsername: 'user' });
  await store.authCodes.put('code', { pending: { clientId: 'client', codeChallenge: 'challenge', redirectUri: 'https://example.com', createdAt: now }, nsTokens: { access_token: 'upstream' } });
  await store.resumeTokens.consume('a'.repeat(64));
  expect(await backend.sweep(now + 2 * 60 * 60 * 1000 + 1)).toBe(3);
  expect(await backend.getSession(createCodec(key).id('session', 'expired'))).toBeUndefined();
  expect(await backend.getAuthCode(createCodec(key).id('code', 'code'))).toBeUndefined();
});
