import { describe, expect, it } from 'vitest';
import { FirestoreClientsStore, createFirestoreBackend } from '../firestore.js';
import { deriveStoreKey } from '../codec.js';
import { CutoverFenceError, CutoverRefusedError } from '../firestore-v2-adoption.js';
import type { FirestoreLike, CollectionLike, DocumentReferenceLike, TransactionLike, QuerySnapshotLike, DocumentDataLike, QueryLike } from '../firestore-like.js';

class MockFirestore implements FirestoreLike {
  public collections = new Map<string, Map<string, Record<string, unknown>>>();

  private getCol(name: string): Map<string, Record<string, unknown>> {
    if (!this.collections.has(name)) {
      this.collections.set(name, new Map());
    }
    return this.collections.get(name)!;
  }

  collection(path: string): CollectionLike {
    const col = this.getCol(path);
    const snapshot = (entries: [string, Record<string, unknown>][]): QuerySnapshotLike => ({
      empty: entries.length === 0,
      size: entries.length,
      docs: entries.map(([id, data]) => ({
        id,
        exists: true,
        data: () => data,
      })),
    });
    const makeDoc = (id: string): DocumentReferenceLike => ({
      id,
      get: async () => ({
        id,
        exists: col.has(id),
        data: () => col.get(id),
      }),
      set: async (data: DocumentDataLike, opts?: { merge?: boolean }) => {
        if (opts?.merge && col.has(id)) {
          col.set(id, { ...col.get(id), ...data });
        } else {
          col.set(id, data);
        }
      },
      delete: async () => {
        col.delete(id);
      },
      collection: (subPath: string) => this.collection(`${path}/${id}/${subPath}`),
    });
    return {
      doc: makeDoc,
      get: async () => snapshot(Array.from(col.entries())),
      limit: () => this.collection(path),
      orderBy: () => this.collection(path),
      where: () => this.collection(path),
      startAt: () => this.collection(path),
      endBefore: () => this.collection(path),
    };
  }

  async runTransaction<T>(cb: (tx: TransactionLike) => Promise<T>): Promise<T> {
    const tx: TransactionLike = {
      get: async (target: DocumentReferenceLike | QueryLike) => target.get(),
      set: (docRef: DocumentReferenceLike, data: DocumentDataLike, opts?: { merge?: boolean }) => docRef.set(data, opts),
      delete: (docRef: DocumentReferenceLike) => docRef.delete(),
    };
    return cb(tx);
  }
}

describe('Firestore Cutover Fence: Uninitialized Production Negative Cases & Emulator Seed Proof', () => {
  const namespace = 'mcp';
  const key = deriveStoreKey('test secret with at least thirty two characters');

  it('negative: uninitialized database rejects client registration with CutoverFenceError', async () => {
    const db = new MockFirestore();
    const clients = new FirestoreClientsStore({ db, collection: `${namespace}_oauth_clients`, namespace });

    await expect(
      clients.registerClient({
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'none',
      })
    ).rejects.toThrow(CutoverFenceError);

    // Verify error specifically identifies missing cutover fence record
    await expect(
      clients.registerClient({
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'none',
      })
    ).rejects.toThrow(/Cutover fence record not initialized for namespace mcp/);
  });

  it('negative: uninitialized database rejects getClient with CutoverRefusedError', async () => {
    const db = new MockFirestore();
    const clients = new FirestoreClientsStore({ db, collection: `${namespace}_oauth_clients`, namespace });

    await expect(clients.getClient('client-123')).rejects.toThrow(CutoverRefusedError);
    await expect(clients.getClient('client-123')).rejects.toThrow(/Cutover state is uninitialized/);
  });

  it('negative: uninitialized database rejects credential backend operations with CutoverFenceError', async () => {
    const db = new MockFirestore();
    const backend = createFirestoreBackend({ db, namespace, key });

    await expect(
      backend.putAccess({
        id: 'acc-1',
        familyId: 'fam-1',
        expiresAt: Date.now() + 3600000,
        retainUntil: Date.now() + 7200000,
        sealed: 'sealed-data',
      })
    ).rejects.toThrow(CutoverFenceError);
  });

  it('negative: control in v3_active without v2_adopted ownership marker rejects with CutoverFenceError', async () => {
    const db = new MockFirestore();
    const now = Date.now();
    const runId = 'migration-test-run-01';
    const manifestDigest = 'a'.repeat(64);

    // Seed only control record, leaving v2_adopted missing
    await db.collection(`${namespace}_meta`).doc('cutover_fence').set({
      schemaVersion: 1,
      namespace,
      epoch: 2,
      state: 'v3_active',
      activeOperations: 0,
      irreversible: false,
      emptyNamespace: true,
      migrationRunId: runId,
      migrationManifestDigest: manifestDigest,
      createdAt: now,
      updatedAt: now,
      codeSha: '0'.repeat(40),
      codeArtifact: 'netsapiens-mcp@3.0.0',
    });

    const clients = new FirestoreClientsStore({ db, collection: `${namespace}_oauth_clients`, namespace });
    await expect(
      clients.registerClient({
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'none',
      })
    ).rejects.toThrow(CutoverFenceError);

    await expect(
      clients.registerClient({
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'none',
      })
    ).rejects.toThrow(/V3 ownership marker is missing/);
  });

  it('negative: control in v3_active with mismatched ownership marker digest rejects with CutoverFenceError', async () => {
    const db = new MockFirestore();
    const now = Date.now();
    const runId = 'migration-test-run-01';
    const manifestDigest = 'a'.repeat(64);

    await db.collection(`${namespace}_meta`).doc('cutover_fence').set({
      schemaVersion: 1,
      namespace,
      epoch: 2,
      state: 'v3_active',
      activeOperations: 0,
      irreversible: false,
      emptyNamespace: true,
      migrationRunId: runId,
      migrationManifestDigest: manifestDigest,
      createdAt: now,
      updatedAt: now,
      codeSha: '0'.repeat(40),
      codeArtifact: 'netsapiens-mcp@3.0.0',
    });

    // Mismatched manifest digest on marker
    await db.collection(`${namespace}_meta`).doc('v2_adopted').set({
      schemaVersion: 2,
      namespace,
      epoch: 2,
      migrationRunId: runId,
      codeSha: '0'.repeat(40),
      codeArtifact: 'netsapiens-mcp@3.0.0',
      packageIntegrity: 'sha512-' + 'b'.repeat(86) + '==',
      protocolDigest: '1'.repeat(64),
      assemblyDigest: '2'.repeat(64),
      indexSchemaDigest: '3'.repeat(64),
      encoderVersion: 1,
      planDigest: '4'.repeat(64),
      kind: 'ownership',
      preparedDigest: '5'.repeat(64),
      migrationManifestDigest: 'b'.repeat(64), // Mismatched!
      emptyNamespace: true,
      adoptedAt: now,
    });

    const clients = new FirestoreClientsStore({ db, collection: `${namespace}_oauth_clients`, namespace });
    await expect(
      clients.registerClient({
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'none',
      })
    ).rejects.toThrow(CutoverFenceError);

    await expect(
      clients.registerClient({
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'none',
      })
    ).rejects.toThrow(/V3 ownership marker does not match control/);
  });

  it('positive: seeded emulator with v3_active control and matching v2_adopted marker succeeds and latches', async () => {
    const db = new MockFirestore();
    const now = Date.now();
    const runId = 'migration-test-run-01';
    const manifestDigest = 'c'.repeat(64);
    const codeSha = '17e13f2b8a7258d037f09efb3a3684393ea61bdd';

    await db.collection(`${namespace}_meta`).doc('cutover_fence').set({
      schemaVersion: 1,
      namespace,
      epoch: 2,
      state: 'v3_active',
      activeOperations: 0,
      irreversible: false,
      emptyNamespace: true,
      migrationRunId: runId,
      migrationManifestDigest: manifestDigest,
      createdAt: now,
      updatedAt: now,
      codeSha,
      codeArtifact: 'netsapiens-mcp@3.0.0',
    });

    await db.collection(`${namespace}_meta`).doc('v2_adopted').set({
      schemaVersion: 2,
      namespace,
      epoch: 2,
      migrationRunId: runId,
      codeSha,
      codeArtifact: 'netsapiens-mcp@3.0.0',
      packageIntegrity: 'sha512-' + 'c'.repeat(86) + '==',
      protocolDigest: '1'.repeat(64),
      assemblyDigest: '2'.repeat(64),
      indexSchemaDigest: '3'.repeat(64),
      encoderVersion: 1,
      planDigest: '4'.repeat(64),
      kind: 'ownership',
      preparedDigest: '5'.repeat(64),
      migrationManifestDigest: manifestDigest,
      emptyNamespace: true,
      adoptedAt: now,
    });

    const clients = new FirestoreClientsStore({ db, collection: `${namespace}_oauth_clients`, namespace });
    const reg = await clients.registerClient({
      redirect_uris: ['https://example.com/callback'],
      token_endpoint_auth_method: 'none',
      client_name: 'test-seeded-client',
    });

    expect(reg.client_id).toBeTruthy();
    expect(await clients.getClient(reg.client_id)).toEqual(reg);

    // Verify backend putAccess also works and latches irreversible: true
    const backend = createFirestoreBackend({ db, namespace, key });
    await backend.putAccess({
      id: 'acc-1',
      familyId: 'fam-1',
      expiresAt: Date.now() + 3600000,
      retainUntil: Date.now() + 7200000,
      sealed: 'sealed-data',
    });

    const controlAfter = (await db.collection(`${namespace}_meta`).doc('cutover_fence').get()).data();
    expect(controlAfter).toMatchObject({
      state: 'v3_active',
      irreversible: true,
      emptyNamespace: false,
    });
  });
});
