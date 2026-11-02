import {
  computeKeyedDocId,
  computeSourceRecordDigest,
  computeSourceInventoryDigest as protoComputeSourceInventoryDigest,
} from '../cutover/canonical-core.mjs';
import {
  type MigrationContext,
  type SupportedNamespace,
  inspectFirestoreLegacyMigration,
  adoptFirestoreLegacyTokens,
  activateFirestoreMigration,
  getFirestoreMigrationStatus,
} from './firestore-migration-engine.js';
import {
  CutoverFenceError,
  CutoverRefusedError,
  isCutoverFenceError,
  isCutoverRefusedError,
} from './errors.js';
import {
  isSupportedCutoverNamespace,
  getCutoverFenceRecord,
} from './cutover-protocol.mjs';
import type { FirestoreLike } from './firestore.js';

export {
  type MigrationContext,
  type SupportedNamespace,
  inspectFirestoreLegacyMigration,
  adoptFirestoreLegacyTokens,
  activateFirestoreMigration,
  getFirestoreMigrationStatus,
  CutoverFenceError,
  CutoverRefusedError,
  isCutoverFenceError,
  isCutoverRefusedError,
};

export async function computeSourceInventoryDigest(
  db: any,
  namespace: string,
  key: Uint8Array | Buffer,
  epoch: number,
): Promise<string> {
  const cols = [
    'families',
    'tokens',
    'refresh',
    'upstream',
    'authCodes',
    'resumeTokens',
    'oauthClients',
    'clients',
  ];
  const colNames: Record<string, string> = {
    families: `${namespace}_tokens_refresh_families`,
    tokens: `${namespace}_tokens`,
    refresh: `${namespace}_tokens_refresh`,
    upstream: `${namespace}_tokens_upstream`,
    authCodes: `${namespace}_auth_codes`,
    resumeTokens: `${namespace}_resume_tokens`,
    oauthClients: `${namespace}_oauth_clients`,
    clients: `${namespace}_clients`,
  };

  const descriptors: Array<{ collection: string; id: string; recordDigest: string }> = [];
  for (const colKey of cols) {
    const snap = await db.collection(colNames[colKey]).get();
    for (const doc of snap.docs) {
      const sourceId = H(key, 'source-id', namespace, epoch, [colKey, doc.id]);
      const recDigest = H(key, 'source-record', namespace, epoch, [colKey, sourceId, doc.data() || {}]);
      descriptors.push({ collection: colKey, id: sourceId, recordDigest: recDigest });
    }
  }
  descriptors.sort((a, b) => {
    if (a.collection !== b.collection) return a.collection < b.collection ? -1 : 1;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  });
  return H(key, 'source-inventory', namespace, epoch, descriptors);
}

export async function ensureFirestoreAdopted(options: {
  db: FirestoreLike;
  namespace: string;
  key: Uint8Array;
  now?: () => number;
}): Promise<void> {
  const { db, namespace } = options;
  const isControlled = isSupportedCutoverNamespace(namespace);

  if (isControlled) {
    const control = await getCutoverFenceRecord(db, namespace);
    if (!control || control.state !== 'v3_active') {
      const state = control?.state ?? 'uninitialized';
      throw new CutoverRefusedError(
        `Cutover state is ${state}; v3 operations require v3_active for namespace ${namespace}`,
        { cutoverState: state, epoch: control?.epoch },
      );
    }
    return;
  }

  // Non-controlled test namespaces only:
  const markerDoc = db.collection(`${namespace}_meta`).doc('v2_adopted');
  const snap = await markerDoc.get();
  if (snap.exists) return;

  const [legFam, legTok, legRef, legUp, legAuth, legRes] = await Promise.all([
    db.collection(`${namespace}_tokens_refresh_families`).get(),
    db.collection(`${namespace}_tokens`).get(),
    db.collection(`${namespace}_tokens_refresh`).get(),
    db.collection(`${namespace}_tokens_upstream`).get(),
    db.collection(`${namespace}_auth_codes`).get(),
    db.collection(`${namespace}_resume_tokens`).get(),
  ]);

  const hasAnyLegacy =
    legFam.docs.length > 0 ||
    legTok.docs.length > 0 ||
    legRef.docs.length > 0 ||
    legUp.docs.length > 0 ||
    legAuth.docs.length > 0 ||
    legRes.docs.length > 0;

  if (hasAnyLegacy) {
    throw new CutoverFenceError(`Non-empty legacy collection detected in uncontrolled test namespace ${namespace}`);
  } else {
    await markerDoc.set({
      adoptedAt: (options.now ?? Date.now)(),
      scanned: 0,
      migrated: 0,
      skipped: 0,
      errors: 0,
    });
  }
}
