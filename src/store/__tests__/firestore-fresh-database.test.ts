import { describe, expect, it } from 'vitest';
import { validateFreshDatabaseResponses } from '../firestore-fresh-database.js';

const resource = { projectId: 'example-project', projectNumber: '123456789', databaseId: 'fresh', databaseUid: '073a322c-a872-4d15-ae90-861d3df4d6db', namespace: 'mcp' };
const name = 'projects/example-project/databases/fresh';
const operationName = `${name}/operations/create-1`;
const database = { name, uid: resource.databaseUid, type: 'FIRESTORE_NATIVE', createTime: '2026-11-05T00:00:00Z' };
const operation = { name: operationName, done: true, response: database };

describe('fresh database response consistency', () => {
  it('accepts matching completed create and readback, with optional matching operation provenance', () => {
    expect(() => validateFreshDatabaseResponses(resource, operationName, operation, database)).not.toThrow();
    expect(() => validateFreshDatabaseResponses(resource, operationName, operation, { ...database, sourceInfo: { operation: operationName } })).not.toThrow();
    const fractional = { ...database, createTime: '2026-11-05T00:00:00.123456789Z' };
    expect(() => validateFreshDatabaseResponses(resource, operationName, { ...operation, response: fractional }, fractional)).not.toThrow();
  });

  it('rejects ambiguous, unrelated, incomplete, restored or replaced resources', () => {
    for (const altered of [
      { ...operation, done: false }, { ...operation, error: {} }, { ...operation, name: `${name}/operations/other` },
      { ...operation, response: { ...database, uid: 'other' } }, { ...operation, response: { ...database, type: 'DATASTORE_MODE' } },
    ]) expect(() => validateFreshDatabaseResponses(resource, operationName, altered, database)).toThrow();
    for (const altered of [
      { ...database, uid: 'different' }, { ...database, name: `${name}-other` }, { ...database, deleteTime: '2026-11-05T01:00:00Z' },
      { ...database, previousId: 'old' }, { ...database, sourceInfo: { backup: 'backup' } },
      { ...database, sourceInfo: { operation: `${name}/operations/other` } }, { ...database, createTime: '2026-11-06T00:00:00Z' },
      { ...database, createTime: '2026-02-30T00:00:00Z' }, { ...database, createTime: 'yesterday' },
    ]) expect(() => validateFreshDatabaseResponses(resource, operationName, operation, altered)).toThrow();
    expect(() => validateFreshDatabaseResponses(resource, `${name}/operations/`, operation, database)).toThrow();
    expect(() => validateFreshDatabaseResponses({ ...resource, databaseUid: 'not-a-uuid' }, operationName, operation, database)).toThrow();
  });
});
