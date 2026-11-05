import { FieldPath } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';
import { assertValidMigrationContext } from '../firestore-migration-engine.js';

function context(fieldPath: unknown) {
  return {
    db: { collection() {}, runTransaction() {} }, FieldPath: fieldPath,
    key: new Uint8Array(32), namespace: 'mcp', expectedEpoch: 1,
    migrationRunId: 'run', codeSha: 'a'.repeat(40), codeArtifact: 'artifact',
    packageIntegrity: 'integrity', protocolDigest: 'b'.repeat(64),
  };
}

describe('migration context FieldPath', () => {
  it('accepts the real Firestore SDK class without changing its identity', () => {
    const input = context(FieldPath);
    expect(() => assertValidMigrationContext(input)).not.toThrow();
    expect(input.FieldPath).toBe(FieldPath);
  });
  it('accepts an object adapter with a callable documentId', () => {
    const adapter = { documentId: () => FieldPath.documentId() };
    const input = context(adapter);
    expect(() => assertValidMigrationContext(input)).not.toThrow();
    expect(input.FieldPath).toBe(adapter);
  });
  it.each([{}, { documentId: 'not callable' }, () => {}, 42, 'invalid'])('rejects malformed adapters', value => {
    expect(() => assertValidMigrationContext(context(value))).toThrow(/FieldPath/);
  });
  it.each([null, undefined])('rejects absent FieldPath', value => {
    expect(() => assertValidMigrationContext(context(value))).toThrow(/FieldPath/);
  });
});
