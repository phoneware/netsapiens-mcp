import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Firestore, Timestamp } from '@google-cloud/firestore';
import { createFirestoreBackend, createFirestoreStore, firestoreCollections, FirestoreBackend, FirestoreClientsStore } from '../firestore.js';
import { deriveStoreKey } from '../codec.js';
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
  try { expect(await clients.getClient(registered.client_id)).toEqual(registered); }
  finally { await db.collection('lens_oauth_clients').doc(registered.client_id).delete(); await db.terminate(); }
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
