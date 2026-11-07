import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyFreshOwnership } from '../firestore-fresh-ownership.js';
import { assertFreshResourceAllowed } from '../firestore-fresh-resource-policy.js';
import { PRODUCTION_INVENTORY_BINDING } from '../../cutover/writer-census-contract.mjs';

const resource = {
  projectId: 'example-project', projectNumber: '123456789', databaseId: '(default)',
  databaseUid: 'database-uid', namespace: 'mcp',
};
const key = Buffer.alloc(32, 1);

function signedRecord() {
  const fields = {
    schemaVersion: 1, kind: 'standalone-fresh', ...resource,
    installationId: '073a322c-a872-4d15-ae90-861d3df4d6db',
    provisioningEvidenceDigest: 'a'.repeat(64), createdAt: '2026-11-05T00:00:00.000Z',
  };
  const message = JSON.stringify([fields.schemaVersion, fields.kind, fields.projectId, fields.projectNumber,
  fields.databaseId, fields.databaseUid, fields.namespace, fields.installationId,
  fields.provisioningEvidenceDigest, fields.createdAt]);
  const mac = createHmac('sha256', key).update('netsapiens-mcp/firestore-standalone-ownership/v1\0').update(message).digest('hex');
  return { ...fields, mac };
}

describe('fresh ownership integrity, not provisioning authority', () => {
  it('verifies an exact record against its resource and key', () => {
    const verified = verifyFreshOwnership(signedRecord(), resource, key);
    expect(verified.installationId).toBe(signedRecord().installationId);
    expect(Object.isFrozen(verified)).toBe(true);
  });

  it('rejects resource, key and immutable field substitutions', () => {
    for (const changed of [
      { databaseUid: 'other-uid' }, { namespace: 'other' }, { databaseId: 'other' },
      { projectId: 'other-project' }, { projectNumber: '987654321' },
    ]) expect(() => verifyFreshOwnership(signedRecord(), { ...resource, ...changed }, key)).toThrow();
    expect(() => verifyFreshOwnership(signedRecord(), resource, Buffer.alloc(32, 2))).toThrow();
    expect(() => verifyFreshOwnership(signedRecord(), resource, Buffer.alloc(0))).toThrow();
    expect(() => verifyFreshOwnership({ ...signedRecord(), provisioningEvidenceDigest: 'b'.repeat(64) }, resource, key)).toThrow();
  });

  it('rejects unknown, missing, malformed and noncanonical fields', () => {
    const { mac: _mac, ...missing } = signedRecord();
    for (const record of [missing, { ...signedRecord(), extra: true },
      { ...signedRecord(), createdAt: '2026-02-30T00:00:00.000Z' },
      { ...signedRecord(), mac: 'a'.repeat(63) }, null, []]) {
      expect(() => verifyFreshOwnership(record, resource, key)).toThrow();
    }
  });

  it('rejects the protected project by either ID or number for every database', () => {
    expect(() => assertFreshResourceAllowed({ ...resource, projectId: PRODUCTION_INVENTORY_BINDING.project, databaseId: 'other' })).toThrow();
    expect(() => assertFreshResourceAllowed({ ...resource, projectNumber: PRODUCTION_INVENTORY_BINDING.projectNumber!, databaseId: 'other' })).toThrow();
    expect(() => assertFreshResourceAllowed({ ...resource, projectNumber: '' })).toThrow();
  });
});
