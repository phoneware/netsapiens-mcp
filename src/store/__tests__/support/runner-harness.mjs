// Test-only harness for the real protected-migration preparation path. The mounted runner refuses any
// mount but its fixed paths, so callers run this only where containerGateOpen() holds (a disposable
// container or CI). It mounts the synthetic fixture into /opt/cutover and /run/cutover, copies the
// preparation runner (prepare-runner.mjs) to /opt/cutover/runner.mjs, runs it with the factory's exact
// argv, and returns its JSON result. A refusal is returned as data (ok: false, exitStatus).
//
// One fixture holds one signing keypair. The fake Admin serves its index and every step mounts its trust
// policy, so all steps of one bundle share one fixture (cached below) and only request.json changes per step.
// The fixture binds the bundle's bytes through protocolDigest, so the cache is keyed by the bundle hash too:
// a mutated bundle never reuses a fixture bound to the original bytes.
// Callers must start the fake Admin (support/fake-admin.mjs) before a step that reads the index.
import { spawnRunner } from './spawn-runner.mjs';
import { createHash } from 'node:crypto';
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

// Collection-group names from a scope's groups list, the only mapping the signed-policy check uses.
function groupNamesOf(scope) {
  if (!Array.isArray(scope.groups)) throw new Error('reviewed runtime collection scope has no groups list');
  return [...scope.groups];
}

// The reviewed groups for a namespace, fail-closed: the harness refuses to build a positive fixture on an
// incomplete scope. The factory is the authority on completeness; this check keeps positive runs honest.
export function reviewedUnion(namespace) {
  const scopeFn = canonicalCore.getCutoverRuntimeCollectionScope;
  if (typeof scopeFn !== 'function') throw new Error('reviewed canonical core export getCutoverRuntimeCollectionScope is absent');
  const scope = scopeFn(namespace);
  if (!scope || scope.complete !== true) throw new Error('reviewed runtime collection scope is incomplete');
  return groupNamesOf(scope);
}

// The groups without the completeness check. Only for negative proofs, where the factory must be the gate
// that refuses an incomplete or unscanned scope.
export function scopeUnionUnchecked(namespace) {
  const scopeFn = canonicalCore.getCutoverRuntimeCollectionScope;
  if (typeof scopeFn !== 'function') throw new Error('reviewed canonical core export getCutoverRuntimeCollectionScope is absent');
  return groupNamesOf(scopeFn(namespace));
}

// One fixture per (bundle, namespace, epoch, nonce, descriptor) for this process. The action and options are
// not part of the cache key: each step rewrites them in request.json.
const fixtures = new Map();
export function fixtureFor({ bundleBytes, namespace, epoch, nonce = '1', subjectDescriptor = null, collectionGroups }) {
  const bundleSha = createHash('sha256').update(bundleBytes).digest('hex');
  const groups = [...(collectionGroups ?? scopeUnionUnchecked(namespace))].sort();
  const cacheKey = JSON.stringify([bundleSha, namespace, epoch, nonce, subjectDescriptor, groups]);
  if (!fixtures.has(cacheKey)) {
    fixtures.set(cacheKey, createSyntheticFixture({
      canonicalJson,
      formatPAE,
      bundleBytes,
      collectionGroups: groups,
      namespace,
      epoch,
      action: 'inspect',
      options: {},
      nonce,
      subjectDescriptor,
    }));
  }
  return fixtures.get(cacheKey);
}

// The exact session secret the factory mounts. The factory derives the store key from these bytes with no
// trimming and no fallback, so a test that reads sealed rows must derive its key from this same string.
export function sessionSecretOf(fixture) {
  return fixture.run['session-secret'].toString('utf8');
}

// The factory's exact argv: inspect takes no mode; adopt names its mode.
export function argvFor(action, namespace, options = {}) {
  if (action === 'adopt') return ['adopt', '--namespace', namespace, '--mode', options.dryRun ? 'dry-run' : 'commit'];
  return [action, '--namespace', namespace];
}

// Writes the fixture's bytes and this step's request to the fixed mounts. Callers must have passed
// assertCanOwnMounts() first. Only the request carries the step's action and options.
export function mountFixture(fixture, action, options) {
  releaseMounts();
  mkdirSync(OPT, { recursive: true, mode: 0o755 });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of Object.entries(fixture.opt)) writeFileSync(join(OPT, name), bytes);
  writeFileSync(join(OPT, 'runner.mjs'), readFileSync(RUNNER_SOURCE));
  symlinkSync(REPO_NODE_MODULES, join(OPT, 'node_modules'), 'dir');
  const body = canonicalJson({ ...fixture.request, action, options });
  for (const [name, bytes] of Object.entries(fixture.run)) {
    writeFileSync(join(RUN, name), name === 'request.json' ? Buffer.from(body) : bytes, { mode: 0o600 });
  }
}

// The factory's environment allowlist, read from src/store/protected-migration-context.ts (ENV_ALLOW):
// HOME, HOSTNAME, NODE_VERSION, PATH, YARN_VERSION. The factory refuses any other variable, so this passes
// only PATH and HOME. The emulator host is fixed in the factory's emulator profile (127.0.0.1:8080), so no
// emulator variable is needed.
function runnerEnv() {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/root' };
}

// Runs the mounted preparation runner with the factory's argv and returns its parsed JSON line plus the
// exit status.
export async function runFactory(argv) {
  const child = await spawnRunner([join(OPT, 'runner.mjs'), ...argv], { env: runnerEnv(), timeout: 180_000 });
  const line = child.stdout.trim().split('\n').filter(Boolean).pop();
  if (!line) throw new Error(`runner produced no result; stderr: ${child.stderr}`);
  return { ...JSON.parse(line), exitStatus: child.status };
}

// One protected step: mount this fixture with the step's action and options, then run it with the factory's
// argv. For adopt, pass the inspect digest in options.expectedSourceInventoryDigest, from a prior inspect
// against the same emulator state.
export function runStep({ bundleBytes, namespace, epoch, action, options = {}, nonce = '1', subjectDescriptor = null, collectionGroups }) {
  const fixture = fixtureFor({ bundleBytes, namespace, epoch, nonce, subjectDescriptor, collectionGroups });
  mountFixture(fixture, action, options);
  return runFactory(argvFor(action, namespace, options));
}
