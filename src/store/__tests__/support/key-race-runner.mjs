// Test-only entrypoint mounted at the factory's fixed runner path. The real Firestore SDK executes
// every transaction. The barrier pauses the first transaction after engine authorization, then changes
// the caller's key before allowing the real transaction to run. No production code or shared store is altered.
import { readFileSync } from 'node:fs';
import { FieldPath, Firestore } from '@google-cloud/firestore';

try {
  const bundle = await import('file:///opt/cutover/cutover-protocol.mjs');
  const context = await bundle.createProtectedFirestoreMigrationContext({ Firestore, FieldPath });
  const request = JSON.parse(readFileSync('/run/cutover/request.json', 'utf8'));
  if (request.action !== 'adopt' || request.options.dryRun !== false) throw new Error('Race runner requires commit');
  const original = context.db.runTransaction.bind(context.db);
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let paused = false;
  context.db.runTransaction = async (...args) => {
    if (!paused) { paused = true; enter(); await barrier; }
    return original(...args);
  };
  const pending = bundle.adoptFirestoreLegacyTokens({ ...context, dryRun: false, expectedSourceInventoryDigest: request.options.expectedSourceInventoryDigest });
  await entered;
  context.key.fill(0);
  release();
  const report = await pending;
  process.stdout.write(`${JSON.stringify({ ok: true, paused, report: { errors: report.errors, migrated: report.migrated } })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
