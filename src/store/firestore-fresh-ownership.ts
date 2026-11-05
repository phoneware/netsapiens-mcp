import { createHmac, timingSafeEqual } from 'node:crypto';
import { assertFreshResourceAllowed, type FreshResourceIdentity } from './firestore-fresh-resource-policy.js';

export const FRESH_OWNERSHIP_PATH = '_netsapiens_mcp_installation/ownership';

export interface FreshOwnershipRecord extends FreshResourceIdentity {
 readonly schemaVersion: 1;
 readonly kind: 'standalone-fresh';
 readonly installationId: string;
 readonly provisioningEvidenceDigest: string;
 readonly createdAt: string;
 readonly mac: string;
}

const FIELDS = [
 'schemaVersion', 'kind', 'projectId', 'projectNumber', 'databaseId', 'databaseUid', 'namespace',
 'installationId', 'provisioningEvidenceDigest', 'createdAt', 'mac',
].sort();
const DOMAIN = 'netsapiens-mcp/firestore-standalone-ownership/v1\0';

/**
 * Verifies the immutable record's integrity and resource binding only. A valid MAC
 * is not a provider-created resource, containment proof, or a handle capability.
 */
export function verifyFreshOwnership(record: unknown, resource: FreshResourceIdentity, key: Uint8Array): FreshOwnershipRecord {
 assertFreshResourceAllowed(resource);
 if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new Error('Invalid store key');
 if (record === null || typeof record !== 'object' || Array.isArray(record) ||
  Object.keys(record).sort().join('\0') !== FIELDS.join('\0')) {
  throw new Error('Invalid fresh ownership schema');
 }
 const r = record as Record<string, unknown>;
 if (r.schemaVersion !== 1 || r.kind !== 'standalone-fresh' ||
  r.projectId !== resource.projectId || r.projectNumber !== resource.projectNumber ||
  r.databaseId !== resource.databaseId || r.databaseUid !== resource.databaseUid || r.namespace !== resource.namespace ||
  typeof r.installationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.installationId) ||
  typeof r.provisioningEvidenceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(r.provisioningEvidenceDigest) ||
  typeof r.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(r.createdAt) ||
  !Number.isFinite(Date.parse(r.createdAt)) || new Date(r.createdAt).toISOString() !== r.createdAt ||
  typeof r.mac !== 'string' || !/^[0-9a-f]{64}$/.test(r.mac)) {
  throw new Error('Invalid fresh ownership fields or resource binding');
 }
 // Array order and a domain prefix make encoding unambiguous and independent of object property order.
 const input = JSON.stringify([r.schemaVersion, r.kind, r.projectId, r.projectNumber, r.databaseId,
 r.databaseUid, r.namespace, r.installationId, r.provisioningEvidenceDigest, r.createdAt]);
 const expected = createHmac('sha256', key).update(DOMAIN).update(input).digest();
 if (!timingSafeEqual(expected, Buffer.from(r.mac as string, 'hex'))) throw new Error('Invalid fresh ownership MAC');
 return Object.freeze({ ...r }) as unknown as FreshOwnershipRecord;
}
