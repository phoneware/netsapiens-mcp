// Negative proof for the runtime collection scope gate in the protected factory. Each case mutates the bundle's
// reviewed scope and runs the real preparation runner against a signed fixture whose protocolDigest binds the
// mutated bytes. A refusal from the factory's scope gate, and not a digest or signature error, is the proof.
//
// The fixture binds the mutated bundle, so the only thing that can refuse is the scope check under test. Each
// mutation is asserted to match exactly once in the bundle, so a changed bundle fails loudly instead of passing.
// The groups come unchecked from the core: the factory, not the harness, must be the gate that refuses.
//
// Anchors are the reviewed core's scope text (src/cutover/canonical-core.mjs, getCutoverRuntimeCollectionScope,
// blob a67967359cc5). The bundle is the built copy; the anchor must match it exactly once.
// Runs only where containerGateOpen() holds. Never touches an existing /opt/cutover or /run/cutover.
// UNVERIFIED: written without a run. Not run until the bundle is regenerated from the reviewed core.
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

// The open scope as the reviewed core writes it: complete false, and three unscanned sources. Every mutation
// changes only the fields under test.
const OPEN_SCOPE_TEXT = 'complete: false,\n    unscanned: Object.freeze(["sibling services", "terraform", "workflows"]),';

// The same scope, closed: complete true and no unscanned sources. Used by the closed-scope cases only.
const CLOSED_SCOPE_TEXT = 'complete: true,\n    unscanned: Object.freeze([]),';

interface Mutation {
  readonly name: string;
  readonly replacement: string;
  readonly refusal: RegExp;
}

// Open-scope cases. Each isolates one check, and the refusal must name that check.
const OPEN_MUTATIONS: readonly Mutation[] = [
  {
    // complete is forced true, unscanned is still nonempty: only the unscanned check can refuse.
    name: 'complete true with nonempty unscanned sources',
    replacement: 'complete: true,\n    unscanned: Object.freeze(["sibling services"]),',
    refusal: /unscanned sources/,
  },
  {
    // unscanned is empty and complete is true; a real unresolved entry is the only defect.
    name: 'empty unscanned with a real unresolved collection',
    replacement: 'complete: true,\n    unscanned: Object.freeze([]),\n    unresolved: Object.freeze(["tenant_*"]),',
    refusal: /unresolved collections/,
  },
  {
    // unscanned missing entirely: the factory must treat an absent list as not a proof.
    name: 'missing unscanned list',
    replacement: 'complete: true,',
    refusal: /unscanned sources/,
  },
];

// Closed-scope cases. The scope passes every closure check, so the factory's own groups comparison is the gate.
// The signed groups are supplied per case: one reviewed group dropped, or one unreviewed group added.
const CLOSED_MISMATCH_CASES = [
  {
    name: 'closed scope, signed groups missing one reviewed group',
    signedGroups: (groups) => groups.slice(1),
  },
  {
    name: 'closed scope, signed groups carrying one unreviewed group',
    signedGroups: (groups) => [...groups, 'unreviewed_collection'],
  },
];

// The core's index binding check runs before the factory's comparison, so a missing group can be reported as
// "omits runtime collection group". Both messages name the signed-versus-scope mismatch this case proves.
const MISMATCH_REFUSAL = /differ from the reviewed runtime collection scope|omits runtime collection group/;

describe.skipIf(!gateOpen)('runtime scope gate negative proof (signed factory fixture)', () => {
  let bundleText: string;
  let bundleBytes: Buffer;

  beforeAll(() => {
    assertCanOwnMounts();
    bundleBytes = readFileSync(BUNDLE_SOURCE);
    bundleText = bundleBytes.toString('utf8');
    expect(bundleText).toContain('createProtectedFirestoreMigrationContext');
    expect(bundleText.split(OPEN_SCOPE_TEXT).length - 1, 'open scope text must appear exactly once').toBe(1);
  });

  afterAll(() => {
    releaseMounts();
  });

  // Runs one refusal case: the mutated bundle, a signed fixture bound to its bytes, and the real runner.
  async function expectRefusal(mutatedText: string, collectionGroups: readonly string[], refusal: RegExp): Promise<void> {
    const mutated = Buffer.from(mutatedText, 'utf8');
    expect(mutated.equals(bundleBytes)).toBe(false);

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
      expect(String(result.message)).toMatch(refusal);
      expect(String(result.message)).not.toMatch(/digest|signature|identity/i);
    } finally {
      await admin.close();
    }
  }

  for (const mutation of OPEN_MUTATIONS) {
    it(`refuses at the scope gate: ${mutation.name}`, async () => {
      const mutatedText = bundleText.replace(OPEN_SCOPE_TEXT, mutation.replacement);
      await expectRefusal(mutatedText, scopeUnionUnchecked(NS), mutation.refusal);
    });
  }

  for (const mismatch of CLOSED_MISMATCH_CASES) {
    it(`refuses at the groups comparison: ${mismatch.name}`, async () => {
      expect(bundleText.split(CLOSED_SCOPE_TEXT).length - 1, 'closed scope text must not already be present').toBe(0);
      const closedText = bundleText.replace(OPEN_SCOPE_TEXT, CLOSED_SCOPE_TEXT);
      const reviewedGroups = scopeUnionUnchecked(NS);
      await expectRefusal(closedText, mismatch.signedGroups(reviewedGroups), MISMATCH_REFUSAL);
    });
  }
});
