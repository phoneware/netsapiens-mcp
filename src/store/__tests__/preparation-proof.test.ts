import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Firestore } from '@google-cloud/firestore';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as canonicalCore from '../../cutover/canonical-core.mjs';
import { canonicalJson, formatPAE } from '../../cutover/dsse-verifier-core.mjs';
import type { FirestoreLike } from '../firestore.js';
import { getCutoverFenceRecord, initializeCutoverFence, transitionCutoverFenceState } from '../firestore-v2-adoption.js';
import { startFakeAdmin } from './support/fake-admin.mjs';
import { createSyntheticFixture } from './support/synthetic-dsse-fixture.mjs';
import { OPT, RUN, assertCanOwnMounts, containerGateOpen, releaseMounts } from './support/mounts.mjs';
import type { SubjectDescriptor } from '../subject-descriptor.js';

// Preparation proof on the genuine bundle and protected context, against the Firestore emulator. The
// Admin index reads go to the fake on 127.0.0.1:8081, which serves the fixture's signed policy in the
// Admin REST shapes. Every step runs in a child process with the factory's exact argv and environment.
// Writes are compared before and after each step, so a refusal is proven to leave the store unchanged.
//
// Runs only where containerGateOpen() holds. Never touches an existing /opt/cutover or /run/cutover.
// Regenerate the bundle first: `npm run bundle:cutover`.

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE_SOURCE = resolve(here, '..', 'cutover-protocol.mjs');
const PREPARE_RUNNER = resolve(here, 'support', 'prepare-runner.mjs');
const REPO_NODE_MODULES = resolve(here, '..', '..', '..', 'node_modules');
const EPOCH = 2;
const EMULATOR = { projectId: 'demo-netsapiens-cutover', host: '127.0.0.1', port: 8080, ssl: false, ignoreUndefinedProperties: false };
const DESCRIPTOR: SubjectDescriptor = { allow: ['active'], collection: 'seats', extraKey: 'seatId', field: 'state' };
const LEGACY_EXPIRY = () => Date.now() + 3_600_000;
const gateOpen = containerGateOpen();

type StepRequest =
  | { readonly action: 'inspect' }
  | { readonly action: 'adopt'; readonly dryRun: boolean; readonly expectedSourceInventoryDigest: string };

interface StepResult {
  readonly ok: boolean;
  readonly sourceInventoryDigest?: string;
  readonly report?: Record<string, unknown>;
  readonly message?: string;
}

function minimalEnv(): Record<string, string> {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/root' };
}

// The reviewed collection-group union for a namespace. Fails closed until the core export exists.
function reviewedUnion(namespace: string): string[] {
  const scopeFn = (canonicalCore as Record<string, unknown>).getCutoverRuntimeCollectionScope;
  if (typeof scopeFn !== 'function') {
    throw new Error('reviewed canonical core export getCutoverRuntimeCollectionScope is absent; the preparation proof cannot run until the core sync lands');
  }
  const scope = (scopeFn as (ns: string) => { complete: boolean; union: string[] })(namespace);
  if (scope.complete !== true) throw new Error('reviewed runtime collection scope is incomplete');
  return [...scope.union];
}

// Every collection the preparation can read or write, for the snapshot and the reset.
function groupsFor(namespace: string): string[] {
  const names = (canonicalCore as Record<string, any>).getCutoverDistinctCollectionNames(namespace);
  const groups = [
    ...Object.values(names.source as Record<string, string>),
    ...Object.values(names.target as Record<string, string>),
    `${namespace}_meta`,
    `${namespace}_tokens`,
    `${namespace}_tokens_refresh`,
    `${namespace}_tokens_upstream`,
    `${namespace}_tokens_refresh_families`,
  ];
  return [...new Set(groups)];
}

// Writes the step's request and the fixture's bytes to the fixed mounts, then runs the preparation runner.
function runStep(fixture: any, namespace: string, bundleBytes: Buffer, request: StepRequest): StepResult {
  const options = request.action === 'adopt'
    ? { dryRun: request.dryRun, expectedSourceInventoryDigest: request.expectedSourceInventoryDigest }
    : {};
  const body = canonicalJson({ ...fixture.request, action: request.action, options });
  releaseMounts();
  mkdirSync(OPT, { recursive: true, mode: 0o755 });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of Object.entries(fixture.opt as Record<string, Buffer>)) {
    writeFileSync(join(OPT, name), name === 'cutover-protocol.mjs' ? bundleBytes : bytes);
  }
  writeFileSync(join(OPT, 'runner.mjs'), readFileSync(PREPARE_RUNNER));
  symlinkSync(REPO_NODE_MODULES, join(OPT, 'node_modules'), 'dir');
  for (const [name, bytes] of Object.entries(fixture.run as Record<string, Buffer>)) {
    writeFileSync(join(RUN, name), name === 'request.json' ? Buffer.from(body) : bytes, { mode: 0o600 });
  }
  const argv = request.action === 'adopt'
    ? ['adopt', '--namespace', namespace, '--mode', request.dryRun ? 'dry-run' : 'commit']
    : [request.action, '--namespace', namespace];
  const child = spawnSync(process.execPath, [join(OPT, 'runner.mjs'), ...argv], { env: minimalEnv(), encoding: 'utf8', timeout: 180_000 });
  const line = child.stdout.trim().split('\n').filter(Boolean).pop();
  if (!line) throw new Error(`preparation runner produced no result; stderr: ${child.stderr}`);
  return JSON.parse(line) as StepResult;
}

describe.skipIf(!gateOpen)('preparation proof on the genuine bundle, emulator and fake Admin', () => {
  let bundleBytes: Buffer;
  let db: Firestore;
  let admin: { close: () => Promise<void> } | null = null;

  beforeAll(() => {
    assertCanOwnMounts();
    bundleBytes = readFileSync(BUNDLE_SOURCE);
    expect(bundleBytes.toString('utf8')).toContain('createProtectedFirestoreMigrationContext');
    db = new Firestore(EMULATOR);
  });

  afterEach(async () => {
    if (admin) await admin.close();
    admin = null;
  });

  afterAll(async () => {
    releaseMounts();
    await db.terminate();
  });

  // A fresh namespace state: every collection cleared, the fence fenced at the request's epoch, and
  // legacy rows seeded. Clearing uses recursiveDelete so the fence operations subcollection goes too.
  async function reset(namespace: string, options: { malformedSeat?: boolean } = {}): Promise<void> {
    for (const group of groupsFor(namespace)) await db.recursiveDelete(db.collection(group));
    await initializeCutoverFence(db as unknown as FirestoreLike, namespace, { initialEpoch: EPOCH, initialState: 'legacy_open' });
    await transitionCutoverFenceState(db as unknown as FirestoreLike, namespace, { fromState: 'legacy_open', toState: 'closing', expectedEpoch: EPOCH });
    await transitionCutoverFenceState(db as unknown as FirestoreLike, namespace, { fromState: 'closing', toState: 'fenced', expectedEpoch: EPOCH });
    await db.collection(`${namespace}_tokens`).doc('legacy-acc-2').set({
      accessToken: 'legacy-acc-2',
      refreshToken: 'legacy-ref-2',
      expiresAt: LEGACY_EXPIRY(),
      nsAccessToken: 'legacy-ns-acc',
      nsRefreshToken: 'legacy-ns-ref',
      nsUsername: 'legacy@domain.com',
      clientId: 'legacy-client',
      seatId: 'seat-42',
      ttlAt: new Date(Date.now() + 30 * 86_400_000),
    });
    if (options.malformedSeat) {
      await db.collection(`${namespace}_tokens`).doc('legacy-acc-bad').set({
        accessToken: 'legacy-acc-bad',
        refreshToken: 'legacy-ref-bad',
        expiresAt: LEGACY_EXPIRY(),
        nsAccessToken: 'bad-ns-acc',
        nsRefreshToken: 'bad-ns-ref',
        nsUsername: 'bad@domain.com',
        clientId: 'legacy-client',
        seatId: '',
        ttlAt: new Date(Date.now() + 30 * 86_400_000),
      });
    }
  }

  // Every document in every group the preparation touches, in a stable order. Equal before and after
  // a refusal proves that the refusal wrote nothing.
  async function snapshot(namespace: string): Promise<string[]> {
    const lines: string[] = [];
    for (const group of groupsFor(namespace)) {
      const docs = await db.collection(group).get();
      for (const doc of docs.docs) lines.push(`${group}/${doc.id}=${JSON.stringify(doc.data())}`);
    }
    return lines.sort();
  }

  // The fixture's signed index, served by the fake Admin. `mutate` changes only what the fake serves.
  async function startAdmin(fixture: any, mutate?: (served: any) => any): Promise<void> {
    admin = await startFakeAdmin({
      databaseResource: fixture.index.provenance.databaseResource,
      policy: fixture.index.policy,
      token: 'owner',
      mutate,
    });
  }

  function fixtureFor(namespace: string, subjectDescriptor: SubjectDescriptor | null) {
    return createSyntheticFixture({
      canonicalJson,
      formatPAE,
      bundleBytes,
      collectionGroups: reviewedUnion(namespace),
      namespace,
      action: 'inspect',
      epoch: EPOCH,
      subjectDescriptor,
    });
  }

  it('prepares and commits on the real bundle, with no write on the dry run (mcp, no descriptor)', async () => {
    await reset('mcp');
    const fixture = fixtureFor('mcp', null);
    await startAdmin(fixture);

    const inspected = runStep(fixture, 'mcp', bundleBytes, { action: 'inspect' });
    expect(inspected.ok).toBe(true);
    const digest = inspected.sourceInventoryDigest as string;

    const beforeDry = await snapshot('mcp');
    const dry = runStep(fixture, 'mcp', bundleBytes, { action: 'adopt', dryRun: true, expectedSourceInventoryDigest: digest });
    expect(dry.ok).toBe(true);
    expect(dry.report?.dryRun).toBe(true);
    expect(dry.report?.errors).toBe(0);
    expect(await snapshot('mcp')).toEqual(beforeDry);

    const commit = runStep(fixture, 'mcp', bundleBytes, { action: 'adopt', dryRun: false, expectedSourceInventoryDigest: digest });
    expect(commit.ok).toBe(true);
    expect(commit.report?.errors).toBe(0);
    expect(commit.report?.migrated).toBeGreaterThan(0);
    expect((await getCutoverFenceRecord(db as unknown as FirestoreLike, 'mcp'))?.state).toBe('v3_ready');
  });

  it('prepares a subject-bound namespace when the signed index covers subjectRefs (pwmcp)', async () => {
    await reset('pwmcp');
    const fixture = fixtureFor('pwmcp', DESCRIPTOR);
    await startAdmin(fixture);

    const inspected = runStep(fixture, 'pwmcp', bundleBytes, { action: 'inspect' });
    expect(inspected.ok).toBe(true);
    const digest = inspected.sourceInventoryDigest as string;

    const commit = runStep(fixture, 'pwmcp', bundleBytes, { action: 'adopt', dryRun: false, expectedSourceInventoryDigest: digest });
    expect(commit.ok).toBe(true);
    expect(commit.report?.errors).toBe(0);
    expect((await getCutoverFenceRecord(db as unknown as FirestoreLike, 'pwmcp'))?.state).toBe('v3_ready');
  });

  // The signed policy still declares the subjectRefs override. The fake serves none, so the observed
  // policy's digest differs from the signed digest, and the producer refuses before any write.
  it('refuses preparation when the observed index omits the signed subjectRefs coverage, with no write', async () => {
    await reset('pwmcp');
    const fixture = fixtureFor('pwmcp', DESCRIPTOR);
    await startAdmin(fixture, (served) => {
      for (const entry of served.collections) entry.overrides = [];
      return served;
    });

    const beforeDry = await snapshot('pwmcp');
    const inspected = runStep(fixture, 'pwmcp', bundleBytes, { action: 'inspect' });
    expect(inspected.ok).toBe(true);
    const dry = runStep(fixture, 'pwmcp', bundleBytes, { action: 'adopt', dryRun: true, expectedSourceInventoryDigest: inspected.sourceInventoryDigest as string });
    expect(dry.ok).toBe(false);
    expect(dry.message).toBe('Fresh index policy differs from the signed index policy');
    expect(await snapshot('pwmcp')).toEqual(beforeDry);
  });

  // The served subjectRefs mode is ASCENDING instead of the signed array-contains. The observed policy
  // digest no longer matches the signed one, so the producer refuses before any write.
  it('refuses preparation when the observed subjectRefs mode differs from the signed mode, with no write', async () => {
    await reset('pwmcp');
    const fixture = fixtureFor('pwmcp', DESCRIPTOR);
    await startAdmin(fixture, (served) => {
      for (const entry of served.collections) {
        for (const override of entry.overrides) override.indexes = [{ queryScope: 'COLLECTION', order: 'ASCENDING' }];
      }
      return served;
    });

    const beforeDry = await snapshot('pwmcp');
    const inspected = runStep(fixture, 'pwmcp', bundleBytes, { action: 'inspect' });
    expect(inspected.ok).toBe(true);
    const dry = runStep(fixture, 'pwmcp', bundleBytes, { action: 'adopt', dryRun: true, expectedSourceInventoryDigest: inspected.sourceInventoryDigest as string });
    expect(dry.ok).toBe(false);
    expect(dry.message).toBe('Fresh index policy differs from the signed index policy');
    expect(await snapshot('pwmcp')).toEqual(beforeDry);
  });

  // A legacy token with an empty seatId is counted as subject_value_missing. The dry run reports the
  // count; the commit refuses before any preparation write.
  it('refuses a malformed family subject without writing (pwmcp)', async () => {
    await reset('pwmcp', { malformedSeat: true });
    const fixture = fixtureFor('pwmcp', DESCRIPTOR);
    await startAdmin(fixture);

    const inspected = runStep(fixture, 'pwmcp', bundleBytes, { action: 'inspect' });
    expect(inspected.ok).toBe(true);
    const digest = inspected.sourceInventoryDigest as string;

    const beforeDry = await snapshot('pwmcp');
    const dry = runStep(fixture, 'pwmcp', bundleBytes, { action: 'adopt', dryRun: true, expectedSourceInventoryDigest: digest });
    expect(dry.ok).toBe(true);
    expect(Number(dry.report?.errors)).toBeGreaterThan(0);
    expect(await snapshot('pwmcp')).toEqual(beforeDry);

    const commit = runStep(fixture, 'pwmcp', bundleBytes, { action: 'adopt', dryRun: false, expectedSourceInventoryDigest: digest });
    expect(commit.ok).toBe(false);
    expect(commit.message?.startsWith('Cannot prepare migration for namespace pwmcp')).toBe(true);
    expect(await snapshot('pwmcp')).toEqual(beforeDry);
  });

  // The source changes after the inspection. The commit names the old digest, so the snapshot check
  // refuses. Only the test's own write changed the store; the refusal itself must write nothing.
  it('refuses a commit whose source changed after the snapshot, with no write (pwmcp)', async () => {
    await reset('pwmcp');
    const fixture = fixtureFor('pwmcp', DESCRIPTOR);
    await startAdmin(fixture);

    const inspected = runStep(fixture, 'pwmcp', bundleBytes, { action: 'inspect' });
    expect(inspected.ok).toBe(true);
    const digest = inspected.sourceInventoryDigest as string;

    await db.collection('pwmcp_tokens').doc('legacy-acc-3').set({
      accessToken: 'legacy-acc-3',
      refreshToken: 'legacy-ref-3',
      expiresAt: LEGACY_EXPIRY(),
      nsAccessToken: 'legacy-ns-acc-3',
      nsRefreshToken: 'legacy-ns-ref-3',
      nsUsername: 'later@domain.com',
      clientId: 'legacy-client',
      seatId: 'seat-43',
      ttlAt: new Date(Date.now() + 30 * 86_400_000),
    });

    const beforeCommit = await snapshot('pwmcp');
    const commit = runStep(fixture, 'pwmcp', bundleBytes, { action: 'adopt', dryRun: false, expectedSourceInventoryDigest: digest });
    expect(commit.ok).toBe(false);
    expect(commit.message?.includes('Source inventory digest mismatch')).toBe(true);
    expect(await snapshot('pwmcp')).toEqual(beforeCommit);
  });
});
