import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as canonicalCore from '../../cutover/canonical-core.mjs';
import { canonicalJson, formatPAE } from '../../cutover/dsse-verifier-core.mjs';
import { createSyntheticFixture } from './support/synthetic-dsse-fixture.mjs';
import type { SubjectDescriptor } from '../subject-descriptor.js';

// Genuine protected-factory emulator fixtures. The factory refuses any mount but its fixed paths,
// so these tests run only in a disposable container with root, /opt/cutover and /run/cutover
// writable, and the Firestore emulator on 127.0.0.1:8080. Set NETSAPIENS_CUTOVER_CONTAINER=1 to
// run them. Without that variable the suite is skipped, and nothing touches the host's mounts.
//
// Before running: regenerate the bundle with `npm run bundle:cutover`. The bundle mounted here is
// src/store/cutover-protocol.mjs, the same bytes `npm run build` copies into build/store.

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE_SOURCE = resolve(here, '..', 'cutover-protocol.mjs');
const RUNNER_SOURCE = resolve(here, 'support', 'protected-runner.mjs');
const REPO_NODE_MODULES = resolve(here, '..', '..', '..', 'node_modules');
const OPT = '/opt/cutover';
const RUN = '/run/cutover';
const inContainer = process.env.NETSAPIENS_CUTOVER_CONTAINER === '1';

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

// The reviewed union of collection groups for a namespace. The export is the reviewed canonical
// core's getCutoverRuntimeCollectionScope. Until the core sync lands it is absent, and this
// fails closed rather than inventing the set.
function reviewedUnion(namespace: string): string[] {
  const scopeFn = (canonicalCore as Record<string, unknown>).getCutoverRuntimeCollectionScope;
  if (typeof scopeFn !== 'function') {
    throw new Error('reviewed canonical core export getCutoverRuntimeCollectionScope is absent; the emulator harness cannot run until the core sync lands');
  }
  const scope = (scopeFn as (ns: string) => { complete: boolean; union: string[] })(namespace);
  if (scope.complete !== true) throw new Error('reviewed runtime collection scope is incomplete');
  return [...scope.union];
}

function clearMounts(): void {
  rmSync(OPT, { recursive: true, force: true });
  rmSync(RUN, { recursive: true, force: true });
}

// Writes the fixture's bytes to the fixed mounts. The bundle may be replaced to test a digest
// mismatch, and extra run-directory files may be added to test refusals.
function mount(
  fixture: { opt: Record<string, Buffer>; run: Record<string, Buffer> },
  options: { bundle?: Buffer; extraRun?: Record<string, Buffer> } = {},
): void {
  clearMounts();
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
function runFactory(
  action: string,
  namespace: string,
  options: { env?: Record<string, string>; nodeArgs?: string[] } = {},
): RunResult {
  const child = spawnSync(
    process.execPath,
    [...(options.nodeArgs ?? []), join(OPT, 'runner.mjs'), action, '--namespace', namespace],
    { env: minimalEnv(options.env), encoding: 'utf8', timeout: 60_000 },
  );
  const line = child.stdout.trim().split('\n').filter(Boolean).pop();
  if (!line) throw new Error(`runner produced no result; stderr: ${child.stderr}`);
  return JSON.parse(line) as RunResult;
}

describe.skipIf(!inContainer)('protected migration factory on the emulator profile', () => {
  let bundleBytes: Buffer;

  beforeAll(() => {
    bundleBytes = readFileSync(BUNDLE_SOURCE);
    // The mounted bundle must be the built artifact: it must export the protected factory.
    expect(bundleBytes.toString('utf8')).toContain('createProtectedFirestoreMigrationContext');
  });

  afterAll(() => {
    clearMounts();
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

  it('mounts the real bundle and returns the ten-field protected context (mcp, no subject descriptor)', () => {
    mount(fixtureFor('mcp'));
    const result = runFactory('inspect', 'mcp');
    expect(result.ok).toBe(true);
    expect(result.fields).toEqual(expect.arrayContaining(['db', 'FieldPath', 'key']));
    expect(result.fields).toHaveLength(10);
  });

  it('binds a verified pwmcp subject descriptor before any read', () => {
    const descriptor: SubjectDescriptor = { allow: ['active'], collection: 'seats', extraKey: 'seat', field: 'state' };
    mount(fixtureFor('pwmcp', descriptor));
    const result = runFactory('inspect', 'pwmcp');
    expect(result.ok).toBe(true);
    expect(result.fields).toHaveLength(10);
  });

  it('refuses a mounted bundle whose bytes differ from the approved protocol digest', () => {
    mount(fixtureFor('mcp'), { bundle: Buffer.concat([bundleBytes, Buffer.from('\n// tampered\n')]) });
    const result = runFactory('inspect', 'mcp');
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Bundle digest does not match the approved protocol digest');
  });

  it('refuses mounted production credentials on the emulator profile', () => {
    mount(fixtureFor('mcp'), { extraRun: { 'credentials.json': Buffer.from('{}') } });
    const result = runFactory('inspect', 'mcp');
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Emulator profile refuses mounted production credentials');
  });

  it('refuses a variable outside the factory environment allowlist before reading any file', () => {
    mount(fixtureFor('mcp'));
    const result = runFactory('inspect', 'mcp', { env: { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' } });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Protected runner environment contains a disallowed variable');
  });

  it('refuses node execution arguments', () => {
    mount(fixtureFor('mcp'));
    const result = runFactory('inspect', 'mcp', { nodeArgs: ['--no-warnings'] });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Protected runner refuses node execution arguments');
  });
});
