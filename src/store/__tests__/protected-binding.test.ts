import { describe, expect, it } from 'vitest';
import { assertProtectedContext, bindProtectedContext, getProtectedBinding, type ProtectedBinding } from '../protected-binding.js';

function fixture(input: Uint8Array = Buffer.alloc(32, 7)) {
  const db = {};
  const FieldPath = {};
  const identity = { namespace: 'mcp', expectedEpoch: 1, migrationRunId: 'run', codeSha: 'sha', codeArtifact: 'artifact', packageIntegrity: 'integrity', protocolDigest: 'digest' };
  const binding: ProtectedBinding = { ...identity, profile: 'emulator', project: 'demo', database: '(default)', assemblyDigest: 'assembly', indexSchemaDigest: 'schema', indexPolicyDigest: 'policy', indexSchema: { policy: { groups: ['mcp'] } }, key: input, FieldPath, authorized: { operation: 'inspect', options: { nested: ['x'] } }, adminAccess: null, invocation: null, credentialDigest: null, adminTokenDigest: null, subjectDescriptor: { allow: ['active'], collection: 'seats', extraKey: 'seatId', field: 'state' } };
  return { db, key: input, binding, context: { ...identity, db, key: input, FieldPath } };
}
const request = { operation: 'inspect' as const, options: { nested: ['x'] } };

describe('protected binding key isolation', () => {
  it.each([Buffer.alloc(32, 7), new Uint8Array(32).fill(7)])('binds nonempty byte views', key => {
    const f = fixture(key);
    expect(() => bindProtectedContext(f.db, f.binding)).not.toThrow();
    expect(assertProtectedContext(f.context, request).key).toEqual(Buffer.alloc(32, 7));
  });
  it('keeps the original authority after the input is mutated', () => {
    const f = fixture();
    bindProtectedContext(f.db, f.binding);
    f.key[0] ^= 1;
    expect(getProtectedBinding(f.db)!.key).toEqual(Buffer.alloc(32, 7));
    expect(() => assertProtectedContext(f.context, request)).toThrow(/does not match/);
    expect(assertProtectedContext({ ...f.context, key: Buffer.alloc(32, 7) }, request).key).toEqual(Buffer.alloc(32, 7));
  });
  it('never exposes retained key bytes through returned views', () => {
    const f = fixture();
    bindProtectedContext(f.db, f.binding);
    const first = getProtectedBinding(f.db)!.key;
    first.fill(1);
    const second = getProtectedBinding(f.db)!.key;
    second.subarray(0, 4).set([1, 2, 3, 4]);
    const third = getProtectedBinding(f.db)!.key;
    new Uint8Array(third.buffer, third.byteOffset, third.byteLength).fill(9);
    expect(getProtectedBinding(f.db)!.key).toEqual(Buffer.alloc(32, 7));
    const accepted = assertProtectedContext(f.context, request);
    accepted.key.fill(0);
    expect(getProtectedBinding(f.db)!.key).toEqual(Buffer.alloc(32, 7));
    expect(() => assertProtectedContext(f.context, request)).toThrow(/already used/);
  });
  it('freezes nested policy, descriptor and authorized options', () => {
    const f = fixture();
    bindProtectedContext(f.db, f.binding);
    const b = getProtectedBinding(f.db)!;
    expect(Object.isFrozen(b.indexSchema)).toBe(true);
    expect(Object.isFrozen((b.indexSchema as any).policy.groups)).toBe(true);
    expect(Object.isFrozen(b.subjectDescriptor!.allow)).toBe(true);
    expect(Object.isFrozen(b.authorized.options.nested)).toBe(true);
  });
  it('refuses another key before database reads without consuming the handle', () => {
    const f = fixture();
    bindProtectedContext(f.db, f.binding);
    expect(() => assertProtectedContext({ ...f.context, key: Buffer.alloc(32, 8) }, request)).toThrow(/does not match/);
    expect(() => assertProtectedContext(f.context, request)).not.toThrow();
  });
});
