// Test-only protected runner. It alters only the emulator's prepared record
// after preparation commits and before the first item transaction begins.
import { readFileSync } from 'node:fs';
import { FieldPath, Firestore } from '@google-cloud/firestore';

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
      const ref = context.db.collection(`${context.namespace}_meta`).doc(`migration_prepared_${context.expectedEpoch}`);
      const prepared = (await ref.get()).data();
      if (!prepared?.candidateCommitments?.length) throw new Error('Expected a prepared candidate');
      const candidateCommitments = prepared.candidateCommitments.map((candidate, index) => index === 0
        ? { ...candidate, logicalDigest: candidate.logicalDigest === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64) }
        : candidate);
      await ref.set({ candidateCommitments }, { merge: true });
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
