// Test-only runner for the preparation proof. The emulator harness copies this file to
// /opt/cutover/runner.mjs. It creates the real protected context from the mounted bundle, then runs
// the one operation the protected request names. It reads the options back from the request file the
// factory already validated, and prints one JSON line. Nothing here reads credentials or writes outside
// the emulator, because the factory refuses the emulator profile when any production file is mounted.
import { readFileSync } from 'node:fs';
import { FieldPath, Firestore } from '@google-cloud/firestore';

const REPORT_KEYS = ['dryRun', 'scanned', 'migrated', 'skipped', 'errors'];

function reply(value, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exitCode = exitCode;
}

try {
  const bundle = await import('file:///opt/cutover/cutover-protocol.mjs');
  const context = await bundle.createProtectedFirestoreMigrationContext({ Firestore, FieldPath });
  const request = JSON.parse(readFileSync('/run/cutover/request.json', 'utf8'));
  if (request.action === 'inspect') {
    const inspected = await bundle.inspectFirestoreLegacyMigration(context);
    reply({ ok: true, sourceInventoryDigest: inspected.sourceInventoryDigest, scanned: inspected.scanned });
  } else if (request.action === 'adopt') {
    const report = await bundle.adoptFirestoreLegacyTokens({
      ...context,
      dryRun: request.options.dryRun,
      expectedSourceInventoryDigest: request.options.expectedSourceInventoryDigest,
    });
    reply({ ok: true, report: Object.fromEntries(REPORT_KEYS.filter((key) => key in report).map((key) => [key, report[key]])) });
  } else if (request.action === 'activate') {
    const result = await bundle.activateFirestoreMigration({
      ...context,
      migrationManifestDigest: request.options.migrationManifestDigest,
    });
    reply({
      ok: true, result: {
        status: result.status,
        epoch: result.epoch,
        migrationRunId: result.migrationRunId,
        migrationManifestDigest: result.migrationManifestDigest,
        planDigest: result.planDigest,
      }
    });
  } else {
    reply({ ok: false, message: 'unsupported protected action' }, 1);
  }
} catch (error) {
  reply({ ok: false, message: error instanceof Error ? error.message : String(error) }, 1);
}
