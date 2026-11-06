// Validates provider response consistency only. Raw objects and operation names are not provisioning authority.
import { assertFreshResourceAllowed, type FreshResourceIdentity } from './firestore-fresh-resource-policy.js';

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

/** Compare a completed create operation with the subsequent authenticated database readback. */
export function validateFreshDatabaseResponses(
  resource: FreshResourceIdentity, operationName: string, operationValue: unknown, readbackValue: unknown,
): void {
  assertFreshResourceAllowed(resource);
  const databaseName = `projects/${resource.projectId}/databases/${resource.databaseId}`;
  if (!operationName.startsWith(`${databaseName}/operations/`) || operationName.slice(`${databaseName}/operations/`.length).includes('/') ||
    operationName === `${databaseName}/operations/`) throw new Error('Invalid create operation name');
  const operation = object(operationValue, 'create operation');
  if (operation.name !== operationName || operation.done !== true || operation.error !== undefined) throw new Error('Create operation did not complete successfully');
  const result = object(operation.response, 'create response');
  const readback = object(readbackValue, 'database readback');
  const validateDatabase = (database: Record<string, unknown>) => {
    if (database.name !== databaseName || database.uid !== resource.databaseUid ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(resource.databaseUid) ||
      database.type !== 'FIRESTORE_NATIVE' || typeof database.createTime !== 'string' || !Number.isFinite(Date.parse(database.createTime)) ||
      database.deleteTime !== undefined || database.previousId !== undefined) throw new Error('Invalid created database identity or state');
    if (database.sourceInfo !== undefined) {
      const source = object(database.sourceInfo, 'database provenance');
      if (Object.keys(source).some((key) => key !== 'operation') || (source.operation !== undefined && source.operation !== operationName)) {
        throw new Error('Database provenance is not a matching plain create');
      }
    }
  };
  validateDatabase(result);
  validateDatabase(readback);
  if (result.createTime !== readback.createTime) throw new Error('Database creation timestamps differ');
}
