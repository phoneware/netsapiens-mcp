import { describe, expect, it } from 'vitest';
import { deriveStoreKey } from '../codec.js';
import { CutoverRefusedError } from '../errors.js';
import { subjectRefFor } from '../subject-guard.js';
import {
  subjectDescriptorFromEnv,
  subjectDescriptorFromPredicate,
  subjectIssuanceFromDescriptor,
  subjectRefsForFamily,
  subjectSpecFor,
  type SubjectDescriptor,
} from '../subject-descriptor.js';

// Flat subject descriptor {allow, collection, extraKey, field}, delivered by the verified
// predicate. Validation goes through the shared verifier's validateSubjectDescriptor, the
// same export the verifier ships, so these tests assert its real accept and refuse outcomes.

const storeKey = deriveStoreKey('subject-descriptor-test-secret-0123456789abcdef');
const descriptor: SubjectDescriptor = {
  allow: ['active'],
  collection: 'example_subjects',
  extraKey: 'subjectKey',
  field: 'status',
};

describe('subject descriptor validation through the shared verifier', () => {
  it('refuses a predicate that does not declare subjectDescriptor explicitly', () => {
    expect(() => subjectDescriptorFromPredicate('pwmcp', { serviceConfiguration: {} })).toThrow(CutoverRefusedError);
    expect(() => subjectDescriptorFromPredicate('pwmcp', {})).toThrow(CutoverRefusedError);
  });

  it('refuses a null descriptor for pwmcp, where a flat descriptor is mandatory', () => {
    expect(() => subjectDescriptorFromPredicate('pwmcp', { serviceConfiguration: { subjectDescriptor: null } }))
      .toThrow(CutoverRefusedError);
  });

  it('accepts a valid flat descriptor for pwmcp and returns a frozen copy', () => {
    const bound = subjectDescriptorFromPredicate('pwmcp', { serviceConfiguration: { subjectDescriptor: descriptor } });
    expect(bound).toEqual(descriptor);
    expect(Object.isFrozen(bound)).toBe(true);
  });

  it('refuses a descriptor with an extra key or an unsorted allow list', () => {
    expect(() => subjectDescriptorFromPredicate('pwmcp', { serviceConfiguration: { subjectDescriptor: { ...descriptor, extra: 1 } } }))
      .toThrow(CutoverRefusedError);
    expect(() => subjectDescriptorFromPredicate('pwmcp', { serviceConfiguration: { subjectDescriptor: { ...descriptor, allow: ['b', 'a'] } } }))
      .toThrow(CutoverRefusedError);
  });

  it('accepts null for mcp and refuses any value for mcp', () => {
    expect(subjectDescriptorFromEnv('mcp', undefined)).toBeNull();
    expect(() => subjectDescriptorFromEnv('mcp', '{}')).toThrow(CutoverRefusedError);
  });

  it('refuses a missing env descriptor for pwmcp, where it is mandatory', () => {
    expect(() => subjectDescriptorFromEnv('pwmcp', undefined)).toThrow(CutoverRefusedError);
  });
});

describe('migrated family subject references', () => {
  it('writes the store-key HMAC reference for an active family', () => {
    const spec = subjectSpecFor(descriptor, 'pwmcp', storeKey);
    expect(spec?.extraKey).toBe('subjectKey');
    const result = subjectRefsForFamily(spec, { subjectKey: 'value-1' }, 'active');
    expect(result).toEqual({ refs: [subjectRefFor(storeKey, 'pwmcp', 'subjectKey', 'value-1')] });
    expect(result.refs?.[0]).not.toContain('value-1');
  });

  it('writes no subject field for a revoked family', () => {
    const spec = subjectSpecFor(descriptor, 'pwmcp', storeKey);
    expect(subjectRefsForFamily(spec, { subjectKey: 'value-1' }, 'revoked')).toEqual({});
  });

  it('counts a missing, empty or non-string value on an active family, never silently', () => {
    const spec = subjectSpecFor(descriptor, 'pwmcp', storeKey);
    expect(subjectRefsForFamily(spec, {}, 'active')).toEqual({ problem: 'subject_value_missing' });
    expect(subjectRefsForFamily(spec, undefined, 'active')).toEqual({ problem: 'subject_value_missing' });
    expect(subjectRefsForFamily(spec, { subjectKey: '' }, 'active')).toEqual({ problem: 'subject_value_missing' });
    expect(subjectRefsForFamily(spec, { subjectKey: 7 }, 'active')).toEqual({ problem: 'subject_value_missing' });
  });

  it('writes nothing for a namespace whose descriptor is null', () => {
    expect(subjectSpecFor(null, 'mcp', storeKey)).toBeNull();
    expect(subjectRefsForFamily(null, { subjectKey: 'v' }, 'active')).toEqual({});
  });

  it('keys the reference by namespace', () => {
    const a = subjectSpecFor(descriptor, 'pwmcp', storeKey);
    const b = subjectSpecFor(descriptor, 'other_ns', storeKey);
    expect(a?.refFor('v')).not.toBe(b?.refFor('v'));
  });

  it('maps only the signed extraKey, never a fallback key', () => {
    const spec = subjectSpecFor(descriptor, 'pwmcp', storeKey);
    expect(subjectRefsForFamily(spec, { seatId: 'v' }, 'active')).toEqual({ problem: 'subject_value_missing' });
  });
});

describe('issuance subject from the same bound descriptor', () => {
  it('builds the flat guard with the subject value as its document id', () => {
    expect(subjectIssuanceFromDescriptor(descriptor, { subjectKey: 'value-2' })).toEqual({
      extraKey: 'subjectKey',
      value: 'value-2',
      guard: { collection: 'example_subjects', documentId: 'value-2', field: 'status', allow: ['active'] },
    });
  });

  it('refuses an absent or ambiguous value under a configured descriptor, without echoing it', () => {
    expect(() => subjectIssuanceFromDescriptor(descriptor, {})).toThrow(CutoverRefusedError);
    expect(() => subjectIssuanceFromDescriptor(descriptor, { subjectKey: '' })).toThrow(CutoverRefusedError);
  });

  it('issues without a subject when the descriptor is null', () => {
    expect(subjectIssuanceFromDescriptor(null, { subjectKey: 'v' })).toBeUndefined();
  });
});
