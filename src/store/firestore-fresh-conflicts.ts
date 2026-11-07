import { SUPPORTED_CUTOVER_NAMESPACES } from '../cutover/canonical-core.mjs';
import type { FirestoreLike, TransactionLike } from './firestore-like.js';

// This is only a conflict check. An empty scan cannot establish creation, isolation, or ownership authority.
// The caller must use authenticated, provider-observed results while the database remains sealed.
export interface FreshDatabaseInventory {
  listCollectionIds(parent: string, pageToken?: string): Promise<unknown>;
  listDocuments(parent: string, collectionId: string, options: { readonly showMissing: true; readonly pageToken?: string }): Promise<unknown>;
}

function page(value: unknown, itemsKey: 'collectionIds' | 'documents'): { items: unknown[]; next?: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed Firestore inventory page');
  const data = value as Record<string, unknown>;
  const items = data[itemsKey];
  if (items !== undefined && !Array.isArray(items)) throw new Error('Malformed Firestore inventory items');
  const next = data.nextPageToken;
  if (next !== undefined && (typeof next !== 'string' || next.length === 0)) throw new Error('Malformed Firestore inventory continuation');
  return { items: (items ?? []) as unknown[], next: next as string | undefined };
}

async function eachPage(fetch: (token?: string) => Promise<unknown>, key: 'collectionIds' | 'documents', visit: (item: unknown) => Promise<void>): Promise<void> {
  const seen = new Set<string>();
  let token: string | undefined;
  do {
    const current = page(await fetch(token), key);
    for (const item of current.items) await visit(item);
    token = current.next;
    if (token !== undefined) {
      if (seen.has(token)) throw new Error('Repeated Firestore inventory continuation');
      seen.add(token);
    }
  } while (token !== undefined);
}

/** Requires listDocuments to use the Google API's showMissing=true. No document or missing parent is permitted. */
export async function assertNoFreshDatabaseConflicts(inventory: FreshDatabaseInventory, databaseRoot: string): Promise<void> {
  if (!/^projects\/[^/]+\/databases\/[^/]+\/documents$/.test(databaseRoot)) throw new Error('Invalid Firestore inventory root');
  const seenCollections = new Set<string>();
  await eachPage((token) => inventory.listCollectionIds(databaseRoot, token), 'collectionIds', async (value) => {
    if (typeof value !== 'string' || !value || value.includes('/') || seenCollections.has(value)) throw new Error('Invalid Firestore collection inventory');
    seenCollections.add(value);
    await eachPage((token) => inventory.listDocuments(databaseRoot, value, { showMissing: true, pageToken: token }), 'documents', async () => {
      // A showMissing entry without fields is also a conflict: descendants may exist beneath a missing parent.
      throw new Error('Fresh Firestore database is not empty');
    });
  });
}

/** Read-only conflict predicate, not a binding or authorization to use a Firestore handle. */
export async function assertNoCanonicalOwnershipInTransaction(
  tx: TransactionLike, db: FirestoreLike, namespace: string,
): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(namespace)) throw new Error('Invalid Firestore namespace');
  const namespaces = new Set([...SUPPORTED_CUTOVER_NAMESPACES, namespace]);
  let conflict = false;
  for (const name of namespaces) {
    const meta = db.collection(`${name}_meta`);
    const documents = await tx.get(meta.limit(1));
    const operations = await tx.get(meta.doc('cutover_fence').collection('operations').limit(1));
    if (!documents.empty || !operations.empty) conflict = true;
  }
  if (conflict) throw new Error('Canonical Firestore ownership metadata conflicts with fresh ownership');
}
