import { spawnRunner } from './support/spawn-runner.mjs';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as canonicalCore from '../../cutover/canonical-core.mjs';
import { canonicalJson, formatPAE } from '../../cutover/dsse-verifier-core.mjs';
import { createSyntheticFixture } from './support/synthetic-dsse-fixture.mjs';
import { OPT, RUN, assertCanOwnMounts, containerGateOpen, releaseMounts } from './support/mounts.mjs';
import type { SubjectDescriptor } from '../subject-descriptor.js';

// Genuine protected-factory emulator fixtures. The factory refuses any mount but its fixed paths,
// so these run only where containerGateOpen() holds (a disposable container or CI). They never
// touch an existing /opt/cutover or /run/cutover. The bundle is regenerated first with
// `npm run bundle:cutover`, because the mounted bytes must be the built artifact.
import { closedBundleBytes } from './support/closed-bundle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const RUNNER_SOURCE = resolve(here, 'support', 'protected-runner.mjs');
const REPO_NODE_MODULES = resolve(here, '..', '..', '..', 'node_modules');
const gateOpen = containerGateOpen();

interface RunResult {
  readonly ok: boolean;
  readonly fields?: string[];
  readonly message?: string;
}

// The factory's environment allowlist. Any other variable is refused before a file is read.
function minimalEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/root',
    ...extra,
  };
}

// The reviewed union of collection groups for a namespace, from the reviewed canonical core's
// getCutoverRuntimeCollectionScope. Until the core sync lands it is absent, and this fails closed.
function reviewedUnion(namespace: string): string[] {
  const scopeFn = (canonicalCore as Record<string, unknown>).getCutoverRuntimeCollectionScope;
  if (typeof scopeFn !== 'function') {
    throw new Error('reviewed canonical core export getCutoverRuntimeCollectionScope is absent; the emulator harness cannot run until the core sync lands');
  }
  // Negatives only: the factory is the gate that must refuse an open scope, so the groups are read unchecked here.
  // Positive suites gate on reviewedScopeClosed() instead.
  const scope = (scopeFn as (ns: string) => { groups: readonly string[] })(namespace);
  return [...scope.groups];
}

// Writes the fixture's bytes to the fixed mounts. The bundle may be replaced to test a digest
// mismatch, and extra run-directory files may be added to test refusals.
function mount(
  fixture: { opt: Record<string, Buffer>; run: Record<string, Buffer> },
  options: { bundle?: Buffer; extraRun?: Record<string, Buffer> } = {},
): void {
  releaseMounts();
  mkdirSync(OPT, { recursive: true, mode: 0o755 });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of Object.entries(fixture.opt)) {
    writeFileSync(join(OPT, name), name === 'cutover-protocol.mjs' && options.bundle ? options.bundle : bytes);
  }
  writeFileSync(join(OPT, 'runner.mjs'), readFileSync(RUNNER_SOURCE));
  // The runner resolves @google-cloud/firestore from /opt/cutover, so the repo's modules are linked there.
  symlinkSync(REPO_NODE_MODULES, join(OPT, 'node_modules'), 'dir');
  for (const [name, bytes] of Object.entries(fixture.run)) writeFileSync(join(RUN, name), bytes, { mode: 0o600 });
  for (const [name, bytes] of Object.entries(options.extraRun ?? {})) writeFileSync(join(RUN, name), bytes, { mode: 0o600 });
}

// Runs the mounted runner in a child with the factory's required argv and environment. The factory
// refuses node execution arguments and a runner path other than /opt/cutover/runner.mjs.
async function runFactory(
  action: string,
  namespace: string,
  options: { env?: Record<string, string>; nodeArgs?: string[] } = {},
): Promise<RunResult> {
  const child = await spawnRunner(
    [...(options.nodeArgs ?? []), join(OPT, 'runner.mjs'), action, '--namespace', namespace],
    { env: minimalEnv(options.env), timeout: 60_000 },
  );
  const line = child.stdout.trim().split('\n').filter(Boolean).pop();
  if (!line) throw new Error(`runner produced no result; stderr: ${child.stderr}`);
  return JSON.parse(line) as RunResult;
}

describe.skipIf(!gateOpen)('protected migration factory on the emulator profile', () => {
  let bundleBytes: Buffer;

  beforeAll(() => {
    assertCanOwnMounts();
    bundleBytes = closedBundleBytes();
    // The mounted bundle must be the built artifact: it must export the protected factory.
    expect(bundleBytes.toString('utf8')).toContain('createProtectedFirestoreMigrationContext');
  });

  afterAll(() => {
    releaseMounts();
  });

  function fixtureFor(namespace: string, subjectDescriptor: SubjectDescriptor | null = null) {
    return createSyntheticFixture({
      canonicalJson,
      formatPAE,
      bundleBytes,
      collectionGroups: reviewedUnion(namespace),
      namespace,
      action: 'inspect',
      subjectDescriptor,
    }) as { opt: Record<string, Buffer>; run: Record<string, Buffer> };
  }

  it('mounts the real bundle and returns the ten-field protected context (mcp, no subject descriptor)', async () => { mount(fixtureFor('mcp'));
  const result = await runFactory('inspect', 'mcp')
  expect(result.ok).toBe(true);
  expect(result.fields).toEqual(expect.arrayContaining(['db', 'FieldPath', 'key']));
  expect(result.fields).toHaveLength(10); });

  it('binds a verified pwmcp subject descriptor before any read', async () => { const descriptor: SubjectDescriptor = { allow: ['active'], collection: 'seats', extraKey: 'seat', field: 'state' };
  mount(fixtureFor('pwmcp', descriptor));
  const result = await runFactory('inspect', 'pwmcp')
  expect(result.ok).toBe(true);
  expect(result.fields).toHaveLength(10); });

  it('refuses a mounted bundle whose bytes differ from the approved protocol digest', async () => { mount(fixtureFor('mcp'), { bundle: Buffer.concat([bundleBytes, Buffer.from('\n// tampered\n')]) });
  const result = await runFactory('inspect', 'mcp')
  expect(result.ok).toBe(false);
  expect(result.message).toBe('Bundle digest does not match the approved protocol digest'); });

  it('refuses mounted production credentials on the emulator profile', async () => { mount(fixtureFor('mcp'), { extraRun: { 'credentials.json': Buffer.from('{}') } });
  const result = await runFactory('inspect', 'mcp')
  expect(result.ok).toBe(false);
  expect(result.message).toBe('Emulator profile refuses mounted production credentials'); });

  it('refuses a variable outside the factory environment allowlist before reading any file', async () => { mount(fixtureFor('mcp'));
  const result = await runFactory('inspect', 'mcp', { env: { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' } })
  expect(result.ok).toBe(false);
  expect(result.message).toBe('Protected runner environment contains a disallowed variable'); });

  it('refuses node execution arguments', async () => { mount(fixtureFor('mcp'));
  const result = await runFactory('inspect', 'mcp', { nodeArgs: ['--no-warnings'] })
  expect(result.ok).toBe(false);
  expect(result.message).toBe('Protected runner refuses node execution arguments'); });
});
