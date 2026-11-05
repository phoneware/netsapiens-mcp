import { describe, expect, it } from 'vitest';
import { deriveStoreKey } from '../codec.js';
import { CutoverFenceError, CutoverRefusedError } from '../errors.js';
import { subjectRefFor } from '../subject-guard.js';
import {
  assertSubjectDeclared,
  subjectDescriptorDigest,
  subjectIssuanceFromDescriptor,
  subjectRefsForFamily,
  subjectSpecFor,
  validateSubjectDescriptors,
} from '../subject-descriptor.js';

// Public subject descriptor ABI. Neutral values only: a deployment's signed approval
// supplies the real namespace, key, collection and field names.

const storeKey = deriveStoreKey('subject-descriptor-test-secret-0123456789abcdef');
const signed = {
  alpha: { extraKey: 'subjectKey', required: true, guard: { collection: 'example_subjects', field: 'status', allow: ['active'] } },
  beta: null,
};

describe('subject descriptor declaration', () => {
  it('refuses an absent or non-object declaration', () => {
    expect(() => validateSubjectDescriptors(undefined)).toThrow(CutoverRefusedError);
    expect(() => validateSubjectDescriptors(null)).toThrow(CutoverRefusedError);
    expect(() => validateSubjectDescriptors('policy')).toThrow(CutoverRefusedError);
  });

  it('accepts an explicit empty declaration and explicit null per namespace', () => {
    expect(validateSubjectDescriptors({})).toEqual({});
    expect(validateSubjectDescriptors({ beta: null })).toEqual({ beta: null });
  });

  it('accepts the signed shape and freezes it', () => {
    const valid = validateSubjectDescriptors(signed);
    expect(valid).toEqual(signed);
    expect(Object.isFrozen(valid)).toBe(true);
  });

  it('refuses malformed namespaces, unknown keys and malformed fields', () => {
    expect(() => validateSubjectDescriptors({ 'Bad Name': null })).toThrow(CutoverRefusedError);
    expect(() => validateSubjectDescriptors({ alpha: { extraKey: 'k', required: true, extra: 1 } })).toThrow(CutoverRefusedError);
    expect(() => validateSubjectDescriptors({ alpha: { extraKey: 'bad-key', required: true } })).toThrow(CutoverRefusedError);
    expect(() => validateSubjectDescriptors({ alpha: { extraKey: 'k', required: 'yes' } })).toThrow(CutoverRefusedError);
    expect(() => validateSubjectDescriptors({ alpha: { extraKey: 'k', required: true, guard: { collection: 'a/b', field: 'status', allow: ['x'] } } }))
      .toThrow(CutoverRefusedError);
    expect(() => validateSubjectDescriptors({ alpha: { extraKey: 'k', required: true, guard: { collection: 'c', field: 'status', allow: [] } } }))
      .toThrow(CutoverRefusedError);
  });

  it('refuses a namespace that is not explicitly declared', () => {
    expect(() => assertSubjectDeclared(validateSubjectDescriptors(signed), 'gamma')).toThrow(CutoverRefusedError);
    expect(() => assertSubjectDeclared(validateSubjectDescriptors(signed), 'beta')).not.toThrow();
  });
});

describe('migrated family subject references', () => {
  it('derives the reference as the store key HMAC over the fixed tuple', () => {
    const spec = subjectSpecFor(validateSubjectDescriptors(signed), 'alpha', storeKey);
    expect(spec?.extraKey).toBe('subjectKey');
    expect(spec?.refFor('value-1')).toBe(subjectRefFor(storeKey, 'alpha', 'subjectKey', 'value-1'));
    expect(subjectRefsForFamily(spec, { subjectKey: 'value-1' })).toEqual([subjectRefFor(storeKey, 'alpha', 'subjectKey', 'value-1')]);
    expect(subjectRefsForFamily(spec, { subjectKey: 'value-1' })?.[0]).not.toContain('value-1');
  });

  it('keys the reference by namespace, so two namespaces never share a reference', () => {
    const a = subjectSpecFor(validateSubjectDescriptors({ alpha: { extraKey: 'k', required: true }, beta: { extraKey: 'k', required: true } }), 'alpha', storeKey);
    const b = subjectSpecFor(validateSubjectDescriptors({ alpha: { extraKey: 'k', required: true }, beta: { extraKey: 'k', required: true } }), 'beta', storeKey);
    expect(a?.refFor('v')).not.toBe(b?.refFor('v'));
  });

  it('holds for a required namespace when the value is missing', () => {
    const spec = subjectSpecFor(validateSubjectDescriptors(signed), 'alpha', storeKey);
    expect(() => subjectRefsForFamily(spec, {})).toThrow(CutoverFenceError);
    expect(() => subjectRefsForFamily(spec, undefined)).toThrow(CutoverFenceError);
  });

  it('holds on an ambiguous value: empty, numeric or other non-string', () => {
    const spec = subjectSpecFor(validateSubjectDescriptors(signed), 'alpha', storeKey);
    expect(() => subjectRefsForFamily(spec, { subjectKey: '' })).toThrow(CutoverFenceError);
    expect(() => subjectRefsForFamily(spec, { subjectKey: 7 })).toThrow(CutoverFenceError);
    expect(() => subjectRefsForFamily(spec, { subjectKey: ['a'] })).toThrow(CutoverFenceError);
  });

  it('omits the reference for a non-required namespace when the value is missing', () => {
    const spec = subjectSpecFor(validateSubjectDescriptors({ alpha: { extraKey: 'k', required: false } }), 'alpha', storeKey);
    expect(subjectRefsForFamily(spec, {})).toBeUndefined();
  });

  it('writes no reference for a namespace declared as no subject', () => {
    expect(subjectSpecFor(validateSubjectDescriptors(signed), 'beta', storeKey)).toBeNull();
    expect(subjectRefsForFamily(null, { subjectKey: 'v' })).toBeUndefined();
  });

  it('never reads a fallback key: only the signed extraKey maps', () => {
    const spec = subjectSpecFor(validateSubjectDescriptors(signed), 'alpha', storeKey);
    expect(() => subjectRefsForFamily(spec, { seatId: 'v' })).toThrow(CutoverFenceError);
  });
});

describe('issuance subject from the signed descriptor', () => {
  it('builds the guard with the subject value as its document id', () => {
    const subject = subjectIssuanceFromDescriptor(validateSubjectDescriptors(signed), 'alpha', { subjectKey: 'value-2' });
    expect(subject).toEqual({
      extraKey: 'subjectKey',
      value: 'value-2',
      guard: { collection: 'example_subjects', documentId: 'value-2', field: 'status', allow: ['active'] },
    });
  });

  it('refuses when a required value is absent or ambiguous, and returns undefined when not required', () => {
    const descriptors = validateSubjectDescriptors(signed);
    expect(() => subjectIssuanceFromDescriptor(descriptors, 'alpha', {})).toThrow(CutoverRefusedError);
    expect(() => subjectIssuanceFromDescriptor(descriptors, 'alpha', { subjectKey: '' })).toThrow(CutoverRefusedError);
    expect(subjectIssuanceFromDescriptor(descriptors, 'beta', {})).toBeUndefined();
  });
});

describe('subject descriptor digest', () => {
  it('is stable for the same declaration and changes when it changes', () => {
    const a = subjectDescriptorDigest(validateSubjectDescriptors(signed));
    expect(a).toBe(subjectDescriptorDigest(validateSubjectDescriptors(JSON.parse(JSON.stringify(signed)))));
    expect(a).not.toBe(subjectDescriptorDigest(validateSubjectDescriptors({ alpha: { extraKey: 'other', required: true } })));
    expect(subjectDescriptorDigest(validateSubjectDescriptors({}))).toMatch(/^[0-9a-f]{64}$/);
  });
});
