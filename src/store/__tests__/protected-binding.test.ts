import { describe, expect, it } from 'vitest';
import { assertProtectedContext, bindProtectedContext, type ProtectedBinding } from '../protected-binding.js';

function fixture() {
  const db = {};
  const key = Buffer.alloc(32, 7);
  const FieldPath = {};
  const identity = { namespace: 'mcp', expectedEpoch: 1, migrationRunId: 'run', codeSha: 'sha', codeArtifact: 'artifact', packageIntegrity: 'integrity', protocolDigest: 'digest' };
  const binding: ProtectedBinding = { ...identity, profile: 'emulator', project: 'demo', database: '(default)', assemblyDigest: 'assembly', indexSchemaDigest: 'schema', indexPolicyDigest: 'policy', indexSchema: {}, key, FieldPath, authorized: { operation: 'inspect', options: {} }, adminAccess: null, invocation: null, credentialDigest: null, adminTokenDigest: null, subjectDescriptor: null };
  return { db, key, binding, context: { ...identity, db, key, FieldPath } };
}

describe('protected binding', () => {
  it('accepts a byte-view key, copies it, and consumes the handle only once', () => {
    const { db, binding, context } = fixture();
    expect(() => bindProtectedContext(db, binding)).not.toThrow();
    expect(assertProtectedContext(context, { operation: 'inspect', options: {} }).key).toEqual(context.key);
    expect(() => assertProtectedContext(context, { operation: 'inspect', options: {} })).toThrow(/already used/);
  });

  it('refuses a key changed after binding', () => {
    const { db, key, binding, context } = fixture();
    bindProtectedContext(db, binding);
    key[0] ^= 1;
    expect(() => assertProtectedContext(context, { operation: 'inspect', options: {} })).toThrow(/does not match/);
  });
});
