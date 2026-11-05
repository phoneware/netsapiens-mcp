// Test-only harness for the real protected-migration runner path. The mounted runner refuses any mount
// but its fixed paths, so callers run this only where containerGateOpen() holds (a disposable container
// or CI). It mounts the synthetic fixture, spawns the runner with the factory's argv and allowlisted
// environment, and returns the runner's JSON result. It never reads credentials or writes outside the
// fixed mounts it owns, and it never runs with a host mount it did not create.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as canonicalCore from '../../../cutover/canonical-core.mjs';
import { canonicalJson, formatPAE } from '../../../cutover/dsse-verifier-core.mjs';
import { createSyntheticFixture } from './synthetic-dsse-fixture.mjs';
import { OPT, RUN, releaseMounts } from './mounts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const BUNDLE_SOURCE = resolve(here, '..', '..', 'cutover-protocol.mjs');
export const RUNNER_SOURCE = resolve(here, 'protected-runner.mjs');
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
export function mountFixture(fixture, { bundle, extraRun } = {}) {
  releaseMounts();
  mkdirSync(OPT, { recursive: true, mode: 0o755 });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of Object.entries(fixture.opt)) {
    writeFileSync(join(OPT, name), name === 'cutover-protocol.mjs' && bundle ? bundle : bytes);
  }
  writeFileSync(join(OPT, 'runner.mjs'), readFileSync(RUNNER_SOURCE));
  symlinkSync(REPO_NODE_MODULES, join(OPT, 'node_modules'), 'dir');
  for (const [name, bytes] of Object.entries(fixture.run)) writeFileSync(join(RUN, name), bytes, { mode: 0o600 });
  for (const [name, bytes] of Object.entries(extraRun ?? {})) writeFileSync(join(RUN, name), bytes, { mode: 0o600 });
}

// The factory's environment allowlist. Any other variable is refused before a file is read. The emulator
// host comes from the mounted fixed profile, never from the environment.
function minimalEnv() {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/root' };
}

// Runs the mounted runner with the factory's argv and returns its JSON result line.
export function runFactory(action, namespace, { nodeArgs = [] } = {}) {
  const child = spawnSync(
    process.execPath,
    [...nodeArgs, join(OPT, 'runner.mjs'), action, '--namespace', namespace],
    { env: minimalEnv(), encoding: 'utf8', timeout: 120_000 },
  );
  const line = child.stdout.trim().split('\n').filter(Boolean).pop();
  if (!line) throw new Error(`runner produced no result; stderr: ${child.stderr}`);
  return JSON.parse(line);
}

// One protected step: mount the fixture for this action and run it. The runner result carries the
// report (adopt) or the inspection (inspect); a refusal comes back as ok: false with the runner's message.
export function runStep({ bundleBytes, namespace, epoch, action, options = {}, nonce = '1', subjectDescriptor = null }) {
  mountFixture(fixtureFor({ bundleBytes, namespace, epoch, action, options, nonce, subjectDescriptor }));
  return runFactory(action, namespace);
}
