import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createHash } from 'node:crypto';
import { createRegisteredClient, createStore } from './store.js';
import type { AuthCodeRow, McpStore, ResumeRow, SessionRow, StoreBackend } from './types.js';

interface DocumentSnapshotLike {
 readonly id: string;
 readonly exists: boolean;
 data(): Record<string, unknown> | undefined;
}
interface QuerySnapshotLike {
 readonly empty: boolean;
 readonly docs: DocumentSnapshotLike[];
}
interface DocumentReferenceLike {
 get(): Promise<DocumentSnapshotLike>;
 set(data: Record<string, unknown>): Promise<unknown>;
 delete(): Promise<unknown>;
}
interface QueryLike {
 get(): Promise<QuerySnapshotLike>;
 limit(count: number): QueryLike;
}
interface CollectionLike extends QueryLike {
 doc(id: string): DocumentReferenceLike;
 where(field: string, op: '==', value: string): QueryLike;
}
interface TransactionLike {
 // The opaque reference is passed back to the same client that created it.
 get(ref: DocumentReferenceLike): Promise<DocumentSnapshotLike>;
 set(ref: DocumentReferenceLike, data: Record<string, unknown>): unknown;
 delete(ref: DocumentReferenceLike): unknown;
}
export interface FirestoreLike {
 collection(path: string): CollectionLike;
 runTransaction<T>(callback: (tx: TransactionLike) => Promise<T>): Promise<T>;
}

export interface FirestoreCollections {
 sessions: string; oauthClients: string; authCodes: string; resumeTokens: string; usage: string;
}
export function firestoreCollections(namespace: string): FirestoreCollections {
 return {
  sessions: `${namespace}_sessions`, oauthClients: `${namespace}_oauth_clients`,
  authCodes: `${namespace}_auth_codes`, resumeTokens: `${namespace}_resume_tokens`,
  usage: `${namespace}_usage`,
 };
}

// Firestore rejects undefined recursively unless configured otherwise.
function defined<T>(value: T): T {
 if (Array.isArray(value)) return value.filter(v => v !== undefined).map(defined) as T;
 if (value && typeof value === 'object' && !(value instanceof Date)) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, defined(v)])) as T;
 }
 return value;
}

export class FirestoreClientsStore implements OAuthRegisteredClientsStore {
 constructor(private readonly options: { db: FirestoreLike; collection: string }) { }
 async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
  const doc = await this.options.db.collection(this.options.collection).doc(clientId).get();
  return doc.exists ? doc.data() as OAuthClientInformationFull : undefined;
 }
 async registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): Promise<OAuthClientInformationFull> {
  const full = createRegisteredClient(client);
  await this.options.db.collection(this.options.collection).doc(full.client_id).set(defined(full));
  return full;
 }
}

export interface FirestoreBackend extends StoreBackend { }
export class FirestoreBackend {
 readonly db: FirestoreLike;
 readonly collections: FirestoreCollections;
 constructor(options: { db: FirestoreLike; namespace: string }) {
  const { db, namespace } = options;
  this.db = db;
  const names = this.collections = firestoreCollections(namespace);
  const sessions = db.collection(names.sessions);
  const codes = db.collection(names.authCodes);
  const resumes = db.collection(names.resumeTokens);
  const usage = db.collection(names.usage);
  const clients = db.collection(names.oauthClients);
  const sessionData = ({ id: _id, ...row }: SessionRow) => defined({ ...row, v: 1, ttlAt: new Date(row.retainUntil) });
  const codeData = ({ id: _id, ...row }: AuthCodeRow) => defined({ ...row, v: 1, ttlAt: new Date(row.expiresAt) });
  const backend: StoreBackend = {
   name: 'firestore',
   capabilities: { persistent: true, multiInstance: true, exclusive: false, expiry: 'ttl-policy' },
   async getSession(id) {
    const snap = await sessions.doc(id).get();
    return snap.exists ? { ...snap.data(), id } as SessionRow : undefined;
   },
   async findSessionByRefreshId(refreshId) {
    const snap = await sessions.where('refreshId', '==', refreshId).limit(1).get();
    return snap.empty ? undefined : { ...snap.docs[0].data(), id: snap.docs[0].id } as SessionRow;
   },
   async putSession(row) { await sessions.doc(row.id).set(sessionData(row)); },
   async updateSession(id, mutate) {
    const ref = sessions.doc(id);
    return db.runTransaction(async tx => {
     const snap = await tx.get(ref);
     if (!snap.exists) return undefined;
     const current = { ...snap.data(), id } as SessionRow;
     const next = mutate(current);
     if (next === null) { tx.delete(ref); return undefined; }
     if (next === undefined) return current;
     tx.set(ref, sessionData(next));
     return next;
    });
   },
   async deleteSession(id) { await sessions.doc(id).delete(); },
   async putAuthCode(row) { await codes.doc(row.id).set(codeData(row)); },
   async getAuthCode(id) {
    const snap = await codes.doc(id).get();
    return snap.exists ? { ...snap.data(), id } as AuthCodeRow : undefined;
   },
   async takeAuthCode(id) {
    const ref = codes.doc(id);
    return db.runTransaction(async tx => {
     const snap = await tx.get(ref);
     if (!snap.exists) return undefined;
     tx.delete(ref);
     return { ...snap.data(), id } as AuthCodeRow;
    });
   },
   async insertResumeIfAbsent(row: ResumeRow, now) {
    const ref = resumes.doc(row.id);
    return db.runTransaction(async tx => {
     const snap = await tx.get(ref);
     if (snap.exists && typeof snap.data()?.expiresAt === 'number' && (snap.data()!.expiresAt as number) > now) return false;
     tx.set(ref, { consumedAt: row.consumedAt, expiresAt: row.expiresAt, ttlAt: new Date(row.expiresAt) });
     return true;
    });
   },
   async incrementUsage(userHash, toolName, now) {
    const id = createHash('sha256').update(JSON.stringify([userHash, toolName])).digest('hex');
    const ref = usage.doc(id);
    await db.runTransaction(async tx => {
     const snap = await tx.get(ref);
     const count = snap.exists ? (snap.data()?.count as number) : 0;
     tx.set(ref, { userHash, toolName, count: count + 1, lastUsed: now });
    });
   },
   async listUsage(userHash) {
    const snap = await usage.where('userHash', '==', userHash).get();
    return snap.docs.map(doc => doc.data() as { toolName: string; count: number; lastUsed: number });
   },
   async getClient(id) {
    const snap = await clients.doc(id).get();
    return snap.exists ? snap.data() as OAuthClientInformationFull : undefined;
   },
   async putClient(client) { await clients.doc(client.client_id).set(defined(client)); },
   async sweep() { return 0; },
   async close() { },
  };
  Object.assign(this, backend);
 }
}

export function createFirestoreBackend(options: { db: FirestoreLike; namespace: string }): FirestoreBackend {
 return new FirestoreBackend(options);
}

export function createFirestoreStore(options: { db: FirestoreLike; namespace: string; key: Uint8Array }): McpStore {
 return createStore(createFirestoreBackend(options), { namespace: options.namespace, key: options.key });
}
