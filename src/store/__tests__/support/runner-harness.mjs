// Test-only harness for the real protected-migration preparation path. The mounted runner refuses any
// mount but its fixed paths, so callers run this only where containerGateOpen() holds (a disposable
// container or CI). It mounts the synthetic fixture into /opt/cutover and /run/cutover, copies the
// preparation runner (prepare-runner.mjs) to /opt/cutover/runner.mjs, runs it with no argv (the action
// and options come from the mounted request.json), and returns its JSON result. A refusal is returned
// as data (ok: false) because refusal is an expected outcome the suites assert on, not an exception.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as canonicalCore from '../../../cutover/canonical-core.mjs';
import { canonicalJson, formatPAE } from '../../../cutover/dsse-verifier-core.mjs';
import { createSyntheticFixture } from './synthetic-dsse-fixture.mjs';
import { OPT, RUN, releaseMounts } from './mounts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const RUNNER_SOURCE = resolve(here, 'prepare-runner.mjs');
const REPO_NODE_MODULES = resolve(here, '..', '..', '..', '..', 'node_modules');

// The reviewed union of collection groups for a namespace, from the reviewed canonical core. It fails
// closed if the export or its completeness is missing.
export function reviewedUnion(namespace) {
  const scopeFn = canonicalCore.getCutoverRuntimeCollectionScope;
  if (typeof scopeFn !== 'function') throw new Error('reviewed canonical core export getCutoverRuntimeCollectionScope is absent');
  const scope = scopeFn(namespace);
  if (!scope || scope.complete !== true) throw new Error('reviewed runtime collection scope is incomplete');
  return scope.union.map((entry) => (typeof entry === 'string' ? entry : entry.name));
}

// Builds a fixture whose identity is derived by the production formula from the approval payload, the
// namespace and the epoch. Only the nonce varies the payload, so distinct approvals get distinct run ids.
export function fixtureFor({ bundleBytes, namespace, epoch, action, options = {}, nonce = '1', subjectDescriptor = null }) {
  return createSyntheticFixture({
    canonicalJson,
    formatPAE,
    bundleBytes,
    collectionGroups: reviewedUnion(namespace),
    namespace,
    epoch,
    action,
    options,
    nonce,
    subjectDescriptor,
  });
}

// Writes the fixture's bytes to the fixed mounts. Callers must have passed assertCanOwnMounts() first.
export function mountFixture(fixture, { bundle } = {}) {
  releaseMounts();
  mkdirSync(OPT, { recursive: true, mode: 0o755 });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of Object.entries(fixture.opt)) {
    writeFileSync(join(OPT, name), name === 'cutover-protocol.mjs' && bundle ? bundle : bytes);
  }
  writeFileSync(join(OPT, 'runner.mjs'), readFileSync(RUNNER_SOURCE));
  symlinkSync(REPO_NODE_MODULES, join(OPT, 'node_modules'), 'dir');
  for (const [name, bytes] of Object.entries(fixture.run)) writeFileSync(join(RUN, name), bytes, { mode: 0o600 });
}

// The factory's environment. PATH and HOME are required to start Node. The emulator host is passed only
// when the caller's gate set it; it is never read from a config file.
function runnerEnv() {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/root' };
  if (process.env.FIRESTORE_EMULATOR_HOST) env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST;
  return env;
}

// Runs the mounted preparation runner and returns its parsed JSON line plus the exit status.
export function runFactory() {
  const child = spawnSync(process.execPath, [join(OPT, 'runner.mjs')], { env: runnerEnv(), encoding: 'utf8', timeout: 120_000 });
  const line = child.stdout.trim().split('\n').filter(Boolean).pop();
  if (!line) throw new Error(`runner produced no result; stderr: ${child.stderr}`);
  return { ...JSON.parse(line), exitStatus: child.status };
}

// One protected step: mount the fixture for this action and run it. For adopt, pass the inspect digest in
// options.expectedSourceInventoryDigest, obtained from a prior inspect run against the same emulator state.
export function runStep({ bundleBytes, namespace, epoch, action, options = {}, nonce = '1', subjectDescriptor = null }) {
  mountFixture(fixtureFor({ bundleBytes, namespace, epoch, action, options, nonce, subjectDescriptor }));
  return runFactory();
}
