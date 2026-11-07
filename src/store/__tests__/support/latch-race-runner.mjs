// Test-only runner: alter only the emulator control after a nonempty item commits.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { FieldPath, Firestore } from '@google-cloud/firestore';

let altered = false;
let committedTargets;
let committedReceipts;
const digest = (docs) => createHash('sha256').update(JSON.stringify(docs.map((doc) => [doc.id, doc.data()]).sort((a, b) => a[0].localeCompare(b[0])))).digest('hex');
try {
  const bundle = await import('file:///opt/cutover/cutover-protocol.mjs');
  const context = await bundle.createProtectedFirestoreMigrationContext({ Firestore, FieldPath });
  const request = JSON.parse(readFileSync('/run/cutover/request.json', 'utf8'));
  if (request.action !== 'adopt' || request.options.dryRun !== false) throw new Error('Latch race runner requires commit');
  const original = context.db.runTransaction.bind(context.db);
  context.db.runTransaction = async (...args) => {
    const result = await original(...args);
    if (!altered) {
      const ref = context.db.collection(`${context.namespace}_meta`).doc('cutover_fence');
      const control = (await ref.get()).data();
      if (control?.state === 'migrating' && control.irreversible === true) {
        const targets = await context.db.collection(`${context.namespace}_sessions`).get();
        const metadata = await context.db.collection(`${context.namespace}_meta`).get();
        const receipts = metadata.docs.filter((doc) => doc.id.startsWith(`migration_receipt_${context.expectedEpoch}_`));
        if (targets.empty || receipts.length !== targets.size) throw new Error('Expected committed target and matching receipt before latch fault');
        committedTargets = { count: targets.size, digest: digest(targets.docs) };
        committedReceipts = { count: receipts.length, digest: digest(receipts) };
        await ref.set({ irreversible: false }, { merge: true });
        altered = true;
      }
    }
    return result;
  };
  await bundle.adoptFirestoreLegacyTokens({ ...context, dryRun: false, expectedSourceInventoryDigest: request.options.expectedSourceInventoryDigest });
  process.stdout.write(`${JSON.stringify({ ok: true, altered })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, altered, committedTargets, committedReceipts, message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
