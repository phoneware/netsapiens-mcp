// Test-only barrier around real emulator transactions. No receipt or target is fabricated.
import { readFileSync } from 'node:fs';
import { FieldPath, Firestore } from '@google-cloud/firestore';

let releaseFirst;
let signalPrepared;
const prepared = new Promise((resolve) => { signalPrepared = resolve; });
let releaseSecond;
const firstMayContinue = new Promise((resolve) => { releaseFirst = resolve; });
const secondMayContinue = new Promise((resolve) => { releaseSecond = resolve; });
let firstPrepared = false;
let secondCommitted = false;
let firstObservedReceipt = false;
try {
  const bundle = await import('file:///opt/cutover/cutover-protocol.mjs');
  const first = await bundle.createProtectedFirestoreMigrationContext({ Firestore, FieldPath });
  const second = await bundle.createProtectedFirestoreMigrationContext({ Firestore, FieldPath });
  const request = JSON.parse(readFileSync('/run/cutover/request.json', 'utf8'));
  if (request.action !== 'adopt' || request.options.dryRun !== false) throw new Error('Receipt race requires an adopt commit');
  const firstTransaction = first.db.runTransaction.bind(first.db);
  first.db.runTransaction = async (...args) => {
    const result = await firstTransaction(...args);
    if (!firstPrepared && result?.dryRun === false && result?.isResume === false) {
      signalPrepared();
      firstPrepared = true;
      await firstMayContinue;
    } else if (secondCommitted && result?.status === 'written') {
      firstObservedReceipt = true;
    }
    return result;
  };
  const secondTransaction = second.db.runTransaction.bind(second.db);
  second.db.runTransaction = async (...args) => {
    const result = await secondTransaction(...args);
    if (!secondCommitted && result?.status === 'written') {
      secondCommitted = true;
      releaseFirst();
      await secondMayContinue;
      throw new Error('injected second-runner stop after committed item');
    }
    return result;
  };
  const options = { dryRun: false, expectedSourceInventoryDigest: request.options.expectedSourceInventoryDigest };
  const firstRun = bundle.adoptFirestoreLegacyTokens({ ...first, ...options });
  // Start the second only after the first preparation has committed.
  await Promise.race([prepared, firstRun.then(() => { throw new Error('First runner completed before preparation barrier'); })]);
  const secondRun = bundle.adoptFirestoreLegacyTokens({ ...second, ...options }).catch((error) => error);
  let result;
  try {
    result = await Promise.race([firstRun, secondRun.then((value) => { throw value instanceof Error ? value : new Error('Second runner completed before the item barrier'); })]);
  } finally { releaseSecond(); }
  const secondResult = await secondRun;
  process.stdout.write(`${JSON.stringify({ ok: true, firstPrepared, secondCommitted, firstObservedReceipt, result, secondStopped: secondResult instanceof Error && secondResult.message === 'injected second-runner stop after committed item' })}\n`);
} catch (error) {
  releaseFirst?.();
  releaseSecond?.();
  process.stdout.write(`${JSON.stringify({ ok: false, firstPrepared, secondCommitted, firstObservedReceipt, message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
