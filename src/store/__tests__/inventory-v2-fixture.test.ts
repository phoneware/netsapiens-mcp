import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, formatPAE, verifyDSSEEnvelope } from '../../cutover/dsse-verifier-core.mjs';
import { EMULATOR_INVENTORY_BINDING, PRODUCTION_INVENTORY_BINDING, compareCensus } from '../../cutover/writer-census-contract.mjs';
import { joinFromFiles } from '../../cutover/writer-inventory-format.mjs';
import { createSyntheticFixture } from './support/synthetic-dsse-fixture.mjs';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('v2 synthetic inventory attestation', () => {
  it('authenticates exact evidence and rejects a modified inventory digest', () => {
    const fixture = createSyntheticFixture({ canonicalJson, formatPAE, bundleBytes: Buffer.from('synthetic bundle'), collectionGroups: ['mcp_users'] });
    const writer = JSON.parse(fixture.run['writer-inventory.json'].toString());
    const collection = JSON.parse(fixture.run['collection-inventory.json'].toString());
    const census = JSON.parse(fixture.run['writer-census.json'].toString());
    const joined = joinFromFiles(writer, collection, EMULATOR_INVENTORY_BINDING);
    expect(compareCensus({ census, ...joined, scopeGroups: ['mcp_users'], binding: EMULATOR_INVENTORY_BINDING }).decision).toBe('match');
    expect(compareCensus({ census, ...joined, scopeGroups: ['mcp_users'], binding: PRODUCTION_INVENTORY_BINDING }).decision).toBe('fail');
    const p = fixture.statement.predicate;
    const keys = ['codeSha', 'publicPackageSourceSha', 'privateRunnerSha', 'workflowSourceSha', 'assemblyDigest', 'sessionSecretVersion', 'image', 'packageIntegrity', 'indexSchemaDigest', 'indexPolicyDigest', 'project', 'database', 'namespace', 'protocolDigest', 'writerCensusDigest', 'writerInventoryDigest', 'collectionInventoryDigest'] as const;
    const expectedPredicate = Object.fromEntries(keys.map((key) => [key, p[key]])) as Record<typeof keys[number], string>;
    expect(expectedPredicate.writerCensusDigest).toBe(digest(fixture.run['writer-census.json']));
    expect(expectedPredicate.writerInventoryDigest).toBe(digest(fixture.run['writer-inventory.json']));
    expect(expectedPredicate.collectionInventoryDigest).toBe(digest(fixture.run['collection-inventory.json']));
    const envelope = JSON.parse(fixture.run['approval.dsse.json'].toString());
    const options = { expectedKeyVersion: p.keyVersion, expectedPredicateType: fixture.statement.predicateType, runnerRepository: 'test-docker.pkg.dev/test-proj/test-repo/test-image', expectedPredicate };
    expect(verifyDSSEEnvelope(envelope, fixture.publicKey, options).valid).toBe(true);
    expect(() => verifyDSSEEnvelope(envelope, fixture.publicKey, { ...options, expectedPredicate: { ...expectedPredicate, writerInventoryDigest: digest(Buffer.from('tampered')) } })).toThrow();
  });
});
