// Test-only runner. The emulator harness copies this file to /opt/cutover/runner.mjs inside a
// disposable container, because the protected factory refuses any entry path but that one.
// It imports the mounted bundle by its fixed file URL, passes the Firestore SDK as the single
// argument, and prints one JSON line. It reads no credentials and performs no mutating call.
import { FieldPath, Firestore } from '@google-cloud/firestore';

try {
  const bundle = await import('file:///opt/cutover/cutover-protocol.mjs');
  const context = await bundle.createProtectedFirestoreMigrationContext({ Firestore, FieldPath });
  process.stdout.write(`${JSON.stringify({ ok: true, fields: Object.keys(context).sort() })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
