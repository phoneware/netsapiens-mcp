import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Firestore, Timestamp } from '@google-cloud/firestore';
import { createFirestoreBackend, createFirestoreStore, firestoreCollections, FirestoreBackend, FirestoreClientsStore } from '../firestore.js';
import { createCodec, deriveStoreKey, LeaseLostError } from '../codec.js';
import { runStoreConformance, type PersistedSnapshot, type PersistedValue } from '../conformance.js';
import type { StoreBackend } from '../types.js';

const host = process.env.FIRESTORE_EMULATOR_HOST;
const required = process.env.NSMCP_REQUIRE_FIRESTORE_EMULATOR === '1';
const key = deriveStoreKey('test secret with at least thirty two characters');
const handles = new Map<string, Firestore[]>();
const projectId = 'nsmcp-test';

async function checkEmulator() {
 if (!host) throw new Error('FIRESTORE_EMULATOR_HOST is required when NSMCP_REQUIRE_FIRESTORE_EMULATOR=1');
 const url = new URL(`http://${host}`);
 await new Promise<void>((resolve, reject) => {
  const socket = connect({ host: url.hostname, port: Number(url.port) });
  socket.setTimeout(2000);
  socket.once('connect', () => { socket.destroy(); resolve(); });
  socket.once('error', error => { socket.destroy(); reject(new Error(`Firestore emulator unreachable at ${host}: ${error.message}`)); });
  socket.once('timeout', () => { socket.destroy(); reject(new Error(`Firestore emulator unreachable at ${host}: timeout`)); });
 });
}

function normalize(value: unknown): PersistedValue {
 if (value instanceof Timestamp) return { $timestamp: value.toMillis() };
 if (value instanceof Date) return { $timestamp: value.getTime() };
 if (Array.isArray(value)) return value.map(normalize);
 if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v != null).map(([k, v]) => [k, normalize(v)]));
 return value as PersistedValue;
}
async function documents(handle: StoreBackend) {
 const { db, collections } = handle as FirestoreBackend;
 const pairs = await Promise.all(Object.entries(collections).map(async ([name, collection]) => {
  const snapshot = await db.collection(collection).get();
  return [name, snapshot.docs.map(doc => ({ key: doc.id, fields: doc.data() }))] as const;
 }));
 return Object.fromEntries(pairs);
}
async function cleanup(ns: string) {
 const clients = handles.get(ns) ?? [];
 if (clients.length) {
  for (const name of Object.values(firestoreCollections(ns))) {
   const snapshot = await clients[0].collection(name).get();
   await Promise.all(snapshot.docs.map(doc => doc.ref.delete()));
  }
 }
 await Promise.all(clients.map(client => client.terminate()));
 handles.delete(ns);
}

describe('Firestore emulator availability', () => {
 it('requires a reachable emulator when requested', async () => { if (required || host) await checkEmulator(); });
});
describe.skipIf(!host)('Firestore emulator', () => {
 beforeAll(checkEmulator);
 afterAll(async () => { for (const ns of handles.keys()) await cleanup(ns); });
 runStoreConformance({
  name: 'firestore', capabilities: { persistent: true, multiInstance: true, exclusive: false, expiry: 'ttl-policy' },
  async openBackend(ns) {
   const db = new Firestore({ projectId, ignoreUndefinedProperties: false });
   handles.set(ns, [...(handles.get(ns) ?? []), db]);
   return createFirestoreBackend({ db, namespace: ns });
  },
  async inspect(handle) {
   const rows = await documents(handle);
   const convert = (name: string) => rows[name].map(({ key, fields }: { key: string; fields: Record<string, unknown> }) => {
    const { id: _id, ...rest } = fields;
    return { key, fields: normalize(rest) as Record<string, PersistedValue> };
   });
   return { sessions: convert('sessions'), authCodes: convert('authCodes'), resumeTokens: convert('resumeTokens'), usage: convert('usage').map((row: { key: string; fields: Record<string, PersistedValue> }) => ({ ...row, key: `${row.fields.userHash}__${row.fields.toolName}` })), clients: convert('oauthClients') } as PersistedSnapshot;
  },
  async dumpRaw(handle) {
   const rows = await documents(handle);
   return JSON.stringify(Object.fromEntries(Object.entries(rows).map(([name, docs]) => [name, Object.fromEntries((docs as Array<{ key: string; fields: unknown }>).map(doc => [doc.key, doc.fields]))])));
  },
  cleanup,
 });
 it('round trips an explicit client collection', async () => {
  const db = new Firestore({ projectId, ignoreUndefinedProperties: false });
  const clients = new FirestoreClientsStore({ db, collection: 'lens_oauth_clients' });
  const registered = await clients.registerClient({ redirect_uris: ['https://example.com/'], token_endpoint_auth_method: 'none' });
  const confidential = await clients.registerClient({ redirect_uris: ['https://example.com/'] });
  try {
   expect(registered.client_secret).toBeUndefined();
   expect(confidential.client_secret).toBeTruthy();
   expect(await clients.getClient(registered.client_id)).toEqual(registered);
   expect(await clients.getClient(confidential.client_id)).toEqual(confidential);
  } finally {
   await Promise.all([registered, confidential].map(client => db.collection('lens_oauth_clients').doc(client.client_id).delete()));
   await db.terminate();
  }
 });
 it('a competing owner cannot be overwritten by lease completion', async () => {
  const ns = `t_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const db = new Firestore({ projectId, ignoreUndefinedProperties: false });
  const other = new Firestore({ projectId, ignoreUndefinedProperties: false });
  handles.set(ns, [db, other]);
  const peer = createFirestoreBackend({ db: other, namespace: ns });
  const id = createCodec(key).id('session', 'race-access');
  let armed = false;
  let injected = false;
  const changeOwner = async () => {
   if (!armed || injected) return;
   injected = true;
   await peer.updateSession(id, row => ({ ...row, leaseOwner: 'competitor', leaseUntil: Date.now() + 60000 }));
  };
  // A plain get sees a stale snapshot after the competing write. A transaction
  // receives the competing write before its read, avoiding emulator lock deadlock.
  const refs = new WeakMap<object, object>();
  const instrumented = new Proxy(db, {
   get(target, prop) {
    if (prop === 'collection') return (name: string) => {
     const collection = target.collection(name);
     return new Proxy(collection, {
      get(c, p) {
       if (p !== 'doc') { const value = Reflect.get(c, p, c); return typeof value === 'function' ? value.bind(c) : value; }
       return (docId: string) => {
        const ref = c.doc(docId);
        const wrapped = new Proxy(ref, {
         get(r, key) {
          if (key === 'get') return async () => { const snapshot = await r.get(); await changeOwner(); return snapshot; };
          const value = Reflect.get(r, key, r); return typeof value === 'function' ? value.bind(r) : value;
         },
        });
        refs.set(wrapped, ref);
        return wrapped;
       };
      },
     });
    };
    if (prop === 'runTransaction') return (fn: (tx: unknown) => Promise<unknown>) => target.runTransaction(tx => fn(new Proxy(tx, {
     get(t, p) {
      if (p === 'get') return async (ref: object) => { await changeOwner(); return t.get((refs.get(ref) ?? ref) as never); };
      if (p === 'set' || p === 'delete') return (ref: object, ...args: unknown[]) => (t[p] as Function).call(t, refs.get(ref) ?? ref, ...args);
      const value = Reflect.get(t, p, t); return typeof value === 'function' ? value.bind(t) : value;
     },
    })));
    const value = Reflect.get(target, prop, target); return typeof value === 'function' ? value.bind(target) : value;
   },
  });
  try {
   const store = createFirestoreStore({ db: instrumented, namespace: ns, key });
   await store.sessions.create({ accessToken: 'race-access', refreshToken: 'race-refresh' }, { clientId: 'client', expiresAt: Date.now() + 60000, nsAccessToken: 'original', nsUsername: 'user', nsExpiresAt: Date.now() - 1 });
   await expect(store.sessions.refreshUpstream('race-access', async () => {
    armed = true;
    return { access_token: 'stale-result', expires_in: 3600 };
   })).rejects.toBeInstanceOf(LeaseLostError);
   expect(injected).toBe(true);
   expect((await peer.getSession(id))?.leaseOwner).toBe('competitor');
   expect((await store.sessions.get('race-access'))?.nsAccessToken).toBe('original');
  } finally { await cleanup(ns); }
 });
 it('store factory uses the supplied client without closing it', async () => {
  const ns = `t_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const db = new Firestore({ projectId, ignoreUndefinedProperties: false });
  handles.set(ns, [db]);
  const store = createFirestoreStore({ db, namespace: ns, key });
  await store.close(); await store.close();
  expect((await db.collection(firestoreCollections(ns).sessions).get()).empty).toBe(true);
  await cleanup(ns);
 });
});
