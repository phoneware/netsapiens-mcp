// Test-only IPC barriers around actual emulator transactions. Each process invokes the protected factory once.
import { readFileSync } from 'node:fs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FieldPath, Firestore } from '@google-cloud/firestore';

const worker = typeof process.send === 'function';
const bundle = await import('file:///opt/cutover/cutover-protocol.mjs');
let context;
let child;
let finishedProof = false;
try {
  context = await bundle.createProtectedFirestoreMigrationContext({ Firestore, FieldPath });
  const request = JSON.parse(readFileSync('/run/cutover/request.json', 'utf8'));
  if (request.action !== 'adopt' || request.options.dryRun !== false) throw new Error('Receipt race requires an adopt commit');
  const options = { dryRun: false, expectedSourceInventoryDigest: request.options.expectedSourceInventoryDigest };
  const snapshot = async () => {
    const names = bundle.getCutoverDistinctCollectionNames(context.namespace);
    const groups = [...new Set([...Object.values(names.source), ...Object.values(names.target), `${context.namespace}_meta`])].sort();
    const rows = [];
    for (const group of groups) {
      const docs = await context.db.collection(group).get();
      for (const doc of docs.docs) rows.push([`${group}/${doc.id}`, doc.data()]);
    }
    const operations = await context.db.collection(`${context.namespace}_meta`).doc('cutover_fence').collection('operations').get();
    for (const doc of operations.docs) rows.push([`operations/${doc.id}`, doc.data()]);
    return JSON.stringify(rows.sort((a, b) => a[0].localeCompare(b[0])));
  };
  const original = context.db.runTransaction.bind(context.db);
  if (worker) {
    let committed = false;
    context.db.runTransaction = async (...args) => {
      const result = await original(...args);
      if (!committed && result?.status === 'written') {
        committed = true;
        process.send?.({ phase: 'item-committed' });
        await new Promise((resolve) => process.once('message', resolve));
        throw new Error('injected worker stop after committed item');
      }
      return result;
    };
    try {
      await bundle.adoptFirestoreLegacyTokens({ ...context, ...options });
      process.send?.({ phase: 'unexpected-completion' });
    } catch (error) {
      process.send?.({ phase: 'worker-stopped', expected: error instanceof Error && error.message === 'injected worker stop after committed item' });
    }
  } else {
    let prepared = false;
    let workerCommitted = false;
    let receiptObserved = false;
    let resumeFirst;
    let signalPrepared;
    const firstMayContinue = new Promise((resolve) => { resumeFirst = resolve; });
    const preparedBarrier = new Promise((resolve) => { signalPrepared = resolve; });
    context.db.runTransaction = async (...args) => {
      const result = await original(...args);
      if (!prepared && result?.dryRun === false && result?.isResume === false) {
        prepared = true;
        signalPrepared();
        await firstMayContinue;
      } else if (workerCommitted && result?.status === 'written') {
        receiptObserved = true;
      }
      return result;
    };
    const firstRun = bundle.adoptFirestoreLegacyTokens({ ...context, ...options });
    await Promise.race([preparedBarrier, firstRun.then(() => { throw new Error('First runner completed before preparation barrier'); })]);
    child = fork(fileURLToPath(import.meta.url), process.argv.slice(2), { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/root' } });
    let workerStopped;
    let workerFailed;
    let workerFinished = false;
    const stopped = new Promise((resolve, reject) => { workerStopped = resolve; workerFailed = reject; });
    child.on('message', (message) => {
      if (message?.phase === 'item-committed') { workerCommitted = true; resumeFirst(); }
      else if (message?.phase === 'worker-stopped') { workerFinished = true; workerStopped(message.expected === true); }
      else if (message?.phase === 'error' || message?.phase === 'unexpected-completion') workerFailed(new Error('Worker failed before completing the receipt barrier'));
    });
    child.once('error', workerFailed);
    child.once('exit', (code) => { if (!workerFinished) workerFailed(new Error(`Worker exited before stop acknowledgment (${code})`)); });
    const result = await Promise.race([firstRun, stopped.then(() => { throw new Error('Worker stopped before first runner completed'); })]);
    const beforeStop = await snapshot();
    child.send?.('stop');
    const secondStopped = await stopped;
    const unchangedAfterStop = beforeStop === await snapshot();
    process.stdout.write(`${JSON.stringify({ ok: true, firstPrepared: prepared, secondCommitted: workerCommitted, firstObservedReceipt: receiptObserved, secondStopped, unchangedAfterStop, result })}\n`);
    finishedProof = true;
  }
} catch (error) {
  if (worker) process.send?.({ phase: 'error' });
  else process.stdout.write(`${JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
} finally {
  if (context?.db) await context.db.terminate();
  if (worker) process.disconnect?.();
  else if (child?.connected) {
    if (!finishedProof) child.kill();
    else child.disconnect();
  }
}
