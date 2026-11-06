// Test-only runner: mutate one real emulator source after preparation, before the first item transaction.
import { readFileSync } from 'node:fs';
import { FieldPath, Firestore } from '@google-cloud/firestore';

const target = 'SOURCE_RACE_TARGET';
let mutated = false;
try {
  const bundle = await import('file:///opt/cutover/cutover-protocol.mjs');
  const context = await bundle.createProtectedFirestoreMigrationContext({ Firestore, FieldPath });
  const request = JSON.parse(readFileSync('/run/cutover/request.json', 'utf8'));
  if (request.action !== 'adopt' || request.options.dryRun !== false) throw new Error('Race runner requires commit');
  const original = context.db.runTransaction.bind(context.db);
  context.db.runTransaction = async (...args) => {
    const result = await original(...args);
    if (!mutated && result?.dryRun === false && result?.isResume === false) {
      const targets = {
        family: [`${context.namespace}_tokens_refresh_families`, 'race-family'],
        refresh: [`${context.namespace}_tokens_refresh`, 'race-refresh'],
        upstream: [`${context.namespace}_tokens_upstream`, 'race-family'],
      };
      if (!targets[target]) throw new Error('Unknown race target');
      const [collection, id] = targets[target];
      await context.db.collection(collection).doc(id).update({ raceMarker: 'changed-after-preparation' });
      mutated = true;
    }
    return result;
  };
  await bundle.adoptFirestoreLegacyTokens({ ...context, dryRun: false, expectedSourceInventoryDigest: request.options.expectedSourceInventoryDigest });
  process.stdout.write(`${JSON.stringify({ ok: true, mutated })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, mutated, message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
