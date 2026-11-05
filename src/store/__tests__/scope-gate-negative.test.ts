// Negative proof for the runtime collection scope gate in the protected factory. Each case mutates the bundle's
// reviewed scope and runs the real preparation runner against a signed fixture whose protocolDigest binds the
// mutated bytes. A refusal from the factory's scope gate, and not a digest or signature error, is the proof.
//
// The fixture binds the mutated bundle, so the only thing that can refuse is the scope check under test. Each
// mutation is asserted to match exactly once in the bundle, so a changed bundle fails loudly instead of passing.
// The union comes unchecked from the core: the factory, not the harness, must be the gate that refuses.
// Runs only where containerGateOpen() holds. Never touches an existing /opt/cutover or /run/cutover.
// UNVERIFIED: written without a run (source-only pending core integration).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeAdmin } from './support/fake-admin.mjs';
import { assertCanOwnMounts, containerGateOpen, releaseMounts } from './support/mounts.mjs';
import { EPOCH } from './support/emulator-seed.js';
import { fixtureFor, runStep, scopeUnionUnchecked } from './support/runner-harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE_SOURCE = resolve(here, '..', 'cutover-protocol.mjs');
const NS = 'mcp';
const gateOpen = containerGateOpen();

// The reviewed scope fields as the bundle prints them. The census is incomplete today (complete: false) and
// lists three unscanned sources. Each mutation changes only the fields under test.
const SCOPE_TEXT = 'complete: false,\n    unscanned: Object.freeze(["sibling services", "terraform", "workflows"]),';

interface Mutation {
  readonly name: string;
  readonly replacement: string;
  readonly refusal: RegExp;
}

// Each case isolates one check. Earlier checks in the factory pass, so the refusal names the check under test.
const MUTATIONS: readonly Mutation[] = [
  {
    // complete is forced true, unscanned is still nonempty: only the unscanned check can refuse.
    name: 'complete true with nonempty unscanned sources',
    replacement: 'complete: true,\n    unscanned: Object.freeze(["sibling services"]),',
    refusal: /unscanned sources/,
  },
  {
    // unscanned is empty and complete is true; an unresolved dynamic collection is the only defect.
    name: 'empty unscanned with an unresolved dynamic collection',
    replacement: 'complete: true,\n    unscanned: Object.freeze([]),\n    unresolvedDynamic: Object.freeze(["tenant_*"]),',
    refusal: /unresolved dynamic collection/,
  },
  {
    // unscanned missing entirely: the factory must treat an absent list as not a proof.
    name: 'missing unscanned list',
    replacement: 'complete: true,',
    refusal: /unscanned sources/,
  },
];

describe.skipIf(!gateOpen)('runtime scope gate negative proof (signed factory fixture)', () => {
  let bundleText: string;
  let bundleBytes: Buffer;

  beforeAll(() => {
    assertCanOwnMounts();
    bundleBytes = readFileSync(BUNDLE_SOURCE);
    bundleText = bundleBytes.toString('utf8');
    expect(bundleText).toContain('createProtectedFirestoreMigrationContext');
    expect(bundleText.split(SCOPE_TEXT).length - 1, 'scope text must appear exactly once').toBe(1);
  });

  afterAll(() => {
    releaseMounts();
  });

  for (const mutation of MUTATIONS) {
    it(`refuses at the scope gate: ${mutation.name}`, async () => {
      const mutated = Buffer.from(bundleText.replace(SCOPE_TEXT, mutation.replacement), 'utf8');
      expect(mutated.equals(bundleBytes)).toBe(false);

      const collectionGroups = scopeUnionUnchecked(NS);
      // The fixture binds the mutated bytes through protocolDigest, so no digest error can be the refusal.
      const fixture = fixtureFor({ bundleBytes: mutated, namespace: NS, epoch: EPOCH, collectionGroups });
      const admin = await startFakeAdmin({
        databaseResource: fixture.index.provenance.databaseResource,
        policy: fixture.index.policy,
        token: 'owner',
      });
      try {
        const result = runStep({ bundleBytes: mutated, namespace: NS, epoch: EPOCH, action: 'inspect', collectionGroups });
        expect(result.ok).toBe(false);
        expect(result.exitStatus).not.toBe(0);
        expect(String(result.message)).toMatch(mutation.refusal);
        expect(String(result.message)).not.toMatch(/digest|signature|identity/i);
      } finally {
        await admin.close();
      }
    });
  }
});
