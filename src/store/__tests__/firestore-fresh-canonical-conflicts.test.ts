import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';
import { assertNoCanonicalOwnershipInTransaction } from '../firestore-fresh-conflicts.js';
import type { FirestoreLike, TransactionLike } from '../firestore-like.js';

const host = process.env.FIRESTORE_EMULATOR_HOST;
describe.skipIf(!host)('fresh ownership canonical conflict predicate on the emulator', () => {
  it.each(['historical-metadata', 'orphan-operation', 'other-controlled-namespace', 'custom-namespace'])
    ('rejects %s without writing an ownership record', async (variant) => {
      const db = new Firestore({ projectId: `demo-fresh-conflict-${randomUUID().slice(0, 8)}` });
      try {
        const handle = db as unknown as FirestoreLike;
        const check = () => db.runTransaction((tx) => assertNoCanonicalOwnershipInTransaction(tx as unknown as TransactionLike, handle, 'custom'));
        await expect(check()).resolves.toBeUndefined();
        const path = variant === 'historical-metadata' ? 'mcp_meta/migration_prepared_99'
          : variant === 'orphan-operation' ? 'mcp_meta/cutover_fence/operations/orphan'
            : variant === 'other-controlled-namespace' ? 'pwmcp_meta/v2_adopted' : 'custom_meta/other';
        await db.doc(path).set({ synthetic: true });
        await expect(check()).rejects.toThrow('Canonical Firestore ownership metadata conflicts');
        expect((await db.doc('_netsapiens_mcp_installation/ownership').get()).exists).toBe(false);
      } finally {
        await db.terminate();
      }
    });
});
