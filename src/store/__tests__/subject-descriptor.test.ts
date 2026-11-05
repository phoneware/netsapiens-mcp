import { describe, expect, it } from 'vitest';
import { createCodec, deriveStoreKey } from '../codec.js';
import { CutoverFenceError, CutoverRefusedError } from '../errors.js';
import { subjectRefFor } from '../subject-guard.js';
import {
  subjectDescriptorDigest,
  subjectIssuanceFromDescriptor,
  subjectRefsForFamily,
  subjectSpecFor,
  validateSubjectDescriptors,
} from '../subject-descriptor.js';

// Public subject descriptor ABI. The tests use neutral values only: a deployment's
// signed approval supplies the real key, collection and field names.

const codec = createCodec(deriveStoreKey('subject-descriptor-test-secret-0123456789abcdef'));
const signed = {
  pwmcp: { extraKey: 'seatId', required: true, guard: { collection: 'example_subjects', field: 'status', allow: ['active'] } },
  mcp: null,
};

describe('subject descriptor validation', () => {
  it('returns null when no descriptor is signed', () => {
    expect(validateSubjectDescriptors(undefined)).toBeNull();
    expect(validateSubjectDescriptors(null)).toBeNull();
  });

  it('accepts the signed shape and freezes it', () => {
    const valid = validateSubjectDescriptors(signed);
    expect(valid).toEqual(signed);
    expect(Object.isFrozen(valid)).toBe(true);
  });

  it('refuses unknown namespaces, unknown keys and malformed fields', () => {
    expect(() => validateSubjectDescriptors({ other: null })).toThrow(CutoverRefusedError);
    expect(() => validateSubjectDescriptors({ mcp: { extraKey: 'seatId', required: true, extra: 1 } })).toThrow(CutoverRefusedError);
    expect(() => validateSubjectDescriptors({ mcp: { extraKey: 'seat-id', required: true } })).toThrow(CutoverRefusedError);
    expect(() => validateSubjectDescriptors({ mcp: { extraKey: 'seatId', required: 'yes' } })).toThrow(CutoverRefusedError);
    expect(() => validateSubjectDescriptors({ mcp: { extraKey: 'seatId', required: true, guard: { collection: 'a/b', field: 'status', allow: ['x'] } } }))
      .toThrow(CutoverRefusedError);
    expect(() => validateSubjectDescriptors({ mcp: { extraKey: 'seatId', required: true, guard: { collection: 'c', field: 'status', allow: [] } } }))
      .toThrow(CutoverRefusedError);
  });
});

describe('migrated family subject references', () => {
  it('derives one reference per migrated family from its extra value', () => {
    const spec = subjectSpecFor(validateSubjectDescriptors(signed), 'pwmcp');
    expect(spec).toEqual({ namespace: 'pwmcp', extraKey: 'seatId', required: true });
    const refs = subjectRefsForFamily(spec, { seatId: 'value-1' }, codec);
    expect(refs).toEqual([subjectRefFor(codec, 'pwmcp', 'seatId', 'value-1')]);
    expect(refs?.[0]).not.toContain('value-1');
  });

  it('keys the reference by namespace, so two namespaces never share a reference', () => {
    const pwmcp = subjectRefsForFamily({ namespace: 'pwmcp', extraKey: 'seatId', required: true }, { seatId: 'v' }, codec);
    const mcp = subjectRefsForFamily({ namespace: 'mcp', extraKey: 'seatId', required: true }, { seatId: 'v' }, codec);
    expect(pwmcp).not.toEqual(mcp);
  });

  it('fails closed for a required namespace when the value is missing or empty', () => {
    const spec = { namespace: 'pwmcp', extraKey: 'seatId', required: true };
    expect(() => subjectRefsForFamily(spec, {}, codec)).toThrow(CutoverFenceError);
    expect(() => subjectRefsForFamily(spec, { seatId: '' }, codec)).toThrow(CutoverFenceError);
    expect(() => subjectRefsForFamily(spec, { seatId: 7 as unknown as string }, codec)).toThrow(CutoverFenceError);
  });

  it('omits the reference for a non-required namespace when the value is missing', () => {
    const spec = { namespace: 'mcp', extraKey: 'seatId', required: false };
    expect(subjectRefsForFamily(spec, {}, codec)).toBeUndefined();
  });

  it('writes no reference when the namespace has no signed descriptor', () => {
    expect(subjectRefsForFamily(null, { seatId: 'v' }, codec)).toBeUndefined();
    expect(subjectSpecFor(validateSubjectDescriptors(signed), 'readonly_mcp')).toBeNull();
  });
});

describe('issuance subject from the signed descriptor', () => {
  it('builds the guard with the subject value as its document id', () => {
    const subject = subjectIssuanceFromDescriptor(validateSubjectDescriptors(signed), 'pwmcp', { seatId: 'value-2' });
    expect(subject).toEqual({
      extraKey: 'seatId',
      value: 'value-2',
      guard: { collection: 'example_subjects', documentId: 'value-2', field: 'status', allow: ['active'] },
    });
  });

  it('refuses when a required value is absent, and returns undefined when not required', () => {
    const descriptors = validateSubjectDescriptors(signed);
    expect(() => subjectIssuanceFromDescriptor(descriptors, 'pwmcp', {})).toThrow(CutoverRefusedError);
    expect(subjectIssuanceFromDescriptor(descriptors, 'mcp', {})).toBeUndefined();
  });
});

describe('subject descriptor digest', () => {
  it('is stable for the same descriptor and changes when it changes', () => {
    const a = subjectDescriptorDigest(validateSubjectDescriptors(signed));
    expect(a).toBe(subjectDescriptorDigest(validateSubjectDescriptors(JSON.parse(JSON.stringify(signed)))));
    expect(a).not.toBe(subjectDescriptorDigest(validateSubjectDescriptors({ pwmcp: { extraKey: 'other', required: true } })));
    expect(subjectDescriptorDigest(null)).toMatch(/^[0-9a-f]{64}$/);
  });
});
