// Test-only runner: stop after the real preparation transaction commits, before any item write.
import { readFileSync } from 'node:fs';
import { FieldPath, Firestore } from '@google-cloud/firestore';
let prepared = false;
try {
  const bundle = await import('file:///opt/cutover/cutover-protocol.mjs');
  const context = await bundle.createProtectedFirestoreMigrationContext({ Firestore, FieldPath });
  const request = JSON.parse(readFileSync('/run/cutover/request.json', 'utf8'));
  if (request.action !== 'adopt' || request.options.dryRun !== false) throw new Error('Prepared stop requires adopt commit');
  const original = context.db.runTransaction.bind(context.db);
  context.db.runTransaction = async (...args) => {
    const result = await original(...args);
    if (result?.dryRun === false && result?.isResume === false) {
      prepared = true;
      throw new Error('injected stop after committed preparation');
    }
    return result;
  };
  await bundle.adoptFirestoreLegacyTokens({ ...context, dryRun: false, expectedSourceInventoryDigest: request.options.expectedSourceInventoryDigest });
  process.stdout.write(`${JSON.stringify({ ok: true, prepared })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, prepared, message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
