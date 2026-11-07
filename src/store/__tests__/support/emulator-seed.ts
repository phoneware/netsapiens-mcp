// Test-only seeding for the Firestore emulator used by the protected preparation runner. Every suite that
// runs the real runner seeds its legacy state through these helpers, so the emulator state is the one the
// runner reads. Runs only where containerGateOpen() holds, against the emulator profile below.
// Suites in this emulator share the supported namespace mcp, so they must run serially: vitest --no-file-parallelism.
// Running them in parallel lets one file's reset race another file's fence transition (observed as "already in state closing").
import type { Firestore } from '@google-cloud/firestore';
import * as canonicalCore from '../../../cutover/canonical-core.mjs';
import { getCutoverFenceRecord, initializeCutoverFence, transitionCutoverFenceState } from '../../firestore-v2-adoption.js';
import type { FirestoreLike } from '../../firestore.js';

export const EMULATOR = { projectId: 'demo-netsapiens-cutover', host: '127.0.0.1', port: 8080, ssl: false, ignoreUndefinedProperties: false };

// A fresh namespace initializes at 1; closing -> fenced advances the signed migration epoch to 2.
export const EPOCH = 2;

// Every collection the preparation can read or write for a namespace, for clearing and snapshots.
export function groupsFor(namespace: string): string[] {
  const names = (canonicalCore as Record<string, any>).getCutoverDistinctCollectionNames(namespace);
  const groups = [
    ...Object.values(names.source as Record<string, string>),
    ...Object.values(names.target as Record<string, string>),
    `${namespace}_meta`,
    `${namespace}_tokens`,
    `${namespace}_tokens_refresh`,
    `${namespace}_tokens_upstream`,
    `${namespace}_tokens_refresh_families`,
  ];
  return [...new Set(groups)];
}

// Clears the namespace and leaves its fence in the fenced state at the given epoch. The subcollections of
// the fence record are removed by recursiveDelete, so a previous run cannot leak state into this one.
export async function resetFencedNamespace(db: Firestore, namespace: string): Promise<void> {
  for (const group of groupsFor(namespace)) await db.recursiveDelete(db.collection(group));
  await initializeCutoverFence(db as unknown as FirestoreLike, namespace, { initialEpoch: 1 });
  await transitionCutoverFenceState(db as unknown as FirestoreLike, namespace, { fromState: 'legacy_open', toState: 'closing', expectedEpoch: 1 });
  const fenced = await transitionCutoverFenceState(db as unknown as FirestoreLike, namespace, { fromState: 'closing', toState: 'fenced', expectedEpoch: 1 });
  if (fenced.epoch !== EPOCH) throw new Error(`Unexpected fenced epoch ${fenced.epoch}`);
}

// Clears the namespace and leaves no fence record, for the fail-closed case.
export async function resetNamespaceWithoutFence(db: Firestore, namespace: string): Promise<void> {
  for (const group of groupsFor(namespace)) await db.recursiveDelete(db.collection(group));
}

// Writes each [path, data] pair. Paths are collection/doc, for example mcp_tokens/acc-1.
export async function seedDocs(db: Firestore, docs: ReadonlyArray<readonly [string, Record<string, unknown>]>): Promise<void> {
  for (const [path, data] of docs) await db.doc(path).set(data);
}

// Every document in every group the preparation touches, in stable order. Equal before and after a refusal
// proves the refusal wrote nothing.
export async function snapshotNamespace(db: Firestore, namespace: string): Promise<string[]> {
  const lines: string[] = [];
  for (const group of groupsFor(namespace)) {
    const docs = await db.collection(group).get();
    for (const doc of docs.docs) lines.push(`${group}/${doc.id}=${JSON.stringify(doc.data())}`);
  }
  const operations = await db.collection(`${namespace}_meta`).doc('cutover_fence').collection('operations').get();
  for (const doc of operations.docs) lines.push(`${namespace}_meta/cutover_fence/operations/${doc.id}=${JSON.stringify(doc.data())}`);
  return lines.sort();
}

export { getCutoverFenceRecord };
