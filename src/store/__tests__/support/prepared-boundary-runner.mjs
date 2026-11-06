// Test-only protected runner: observe the committed preparation before the real engine finalizes.
import { readFileSync } from 'node:fs';
import { FieldPath, Firestore } from '@google-cloud/firestore';

let boundary;
try {
  const bundle = await import('file:///opt/cutover/cutover-protocol.mjs');
  const context = await bundle.createProtectedFirestoreMigrationContext({ Firestore, FieldPath });
  const request = JSON.parse(readFileSync('/run/cutover/request.json', 'utf8'));
  if (request.action !== 'adopt' || request.options.dryRun !== false) throw new Error('Boundary runner requires commit');
  const original = context.db.runTransaction.bind(context.db);
  context.db.runTransaction = async (...args) => {
    const result = await original(...args);
    if (!boundary && result?.dryRun === false && result?.isResume === false) {
      const meta = context.db.collection(`${context.namespace}_meta`);
      const [control, prepared, final, marker] = await Promise.all([
        meta.doc('cutover_fence').get(),
        meta.doc(`migration_prepared_${context.expectedEpoch}`).get(),
        meta.doc(`migration_manifest_${context.expectedEpoch}`).get(),
        meta.doc('v2_adopted').get(),
      ]);
      boundary = { control: control.data(), prepared: prepared.data(), finalExists: final.exists, markerExists: marker.exists };
    }
    return result;
  };
  const report = await bundle.adoptFirestoreLegacyTokens({ ...context, dryRun: false, expectedSourceInventoryDigest: request.options.expectedSourceInventoryDigest });
  process.stdout.write(`${JSON.stringify({ ok: true, boundary, report: { errors: report.errors, migrated: report.migrated } })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, boundary, message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
