// Test-only runner: insert an emulator target after observation, before preparation.
import { readFileSync } from 'node:fs';
import { FieldPath, Firestore } from '@google-cloud/firestore';

let inserted = false;
try {
  const bundle = await import('file:///opt/cutover/cutover-protocol.mjs');
  const context = await bundle.createProtectedFirestoreMigrationContext({ Firestore, FieldPath });
  const request = JSON.parse(readFileSync('/run/cutover/request.json', 'utf8'));
  if (request.action !== 'adopt' || request.options.dryRun !== false) throw new Error('Race runner requires commit');
  const original = context.db.runTransaction.bind(context.db);
  context.db.runTransaction = async (...args) => {
    const result = await original(...args);
    if (!inserted && result?.sourceInventoryDigest && Array.isArray(result?.requiredFields)) {
      throw new Error('Unexpected observation fields shape');
    }
    if (!inserted && result?.sourceInventoryDigest && result?.requiredFields && typeof result.requiredFields === 'object') {
      await context.db.collection(`${context.namespace}_refresh_families`).doc('inserted-target').set({ id: 'inserted-target' });
      inserted = true;
    }
    return result;
  };
  await bundle.adoptFirestoreLegacyTokens({ ...context, dryRun: false, expectedSourceInventoryDigest: request.options.expectedSourceInventoryDigest });
  process.stdout.write(`${JSON.stringify({ ok: true, inserted })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, inserted, message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
