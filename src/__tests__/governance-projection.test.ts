import { describe, expect, it } from 'vitest';
import {
  findUndeclaredPaths,
  projectOutput,
  resourceDeclaration,
  scrubSecrets,
  withheldMarker,
} from '../governance/scrub.js';
import type { OutputDeclaration } from '../governance/types.js';

/** A CdrD record with call-intelligence fields, the prefilled transcription plumbing and two internal relay fields. */
function cdrFixture(): Record<string, unknown> {
  return {
    success: true,
    data: [
      {
        id: 'cdr-1',
        name: 'Alice',
        number: '1011',
        'call-orig-call-id': 'call-abc',
        'call-audio-codec': 'PCMU',
        'call-intelligence-summary': 'The caller asked about a refund.',
        'call-intelligence-topics-top': 'refund, billing',
        ending_sentiment: 'negative',
        'prefilled-transcription-api': 'https://transcribe.example.test/api/job-1',
        'call-orig-ip-address': '203.0.113.7',
        'call-term-ip-address': '203.0.113.8',
      },
    ],
  };
}

const SECRET_PAYLOAD = {
  user: '1011',
  pin: 1234,
  nested: { password: 'hunter2', ok: true },
  note: '{"password":"abc","keep":1}',
};

describe('projectOutput with every option off', () => {
  const cases: Array<{ name: string; payload: unknown; output: OutputDeclaration | undefined }> = [
    { name: 'secret-bearing object', payload: SECRET_PAYLOAD, output: undefined },
    { name: 'CdrD record', payload: cdrFixture(), output: resourceDeclaration('CdrD') },
    { name: 'array root', payload: [{ secret: 's', a: 1 }], output: undefined },
    { name: 'no secrets', payload: { user: '1011', limit: 10 }, output: undefined },
  ];

  it.each(cases)('equals scrubSecrets exactly: $name', ({ payload, output }) => {
    const scrubbed = scrubSecrets(payload, output);
    const projected = projectOutput(payload, output, {});
    expect(projected.projected).toEqual(scrubbed.scrubbed);
    expect(projected.secrets).toBe(scrubbed.count);
    expect(projected.stripped).toEqual({});
    expect(projected.internalDropped).toBe(0);
    expect(projected.undeclaredDropped).toBe(0);
  });

  it('returns the input unchanged when it holds no secret', () => {
    const payload = { user: '1011', limit: 10, nested: { domain: 'example.test' } };
    expect(projectOutput(payload, undefined).projected).toEqual(payload);
  });

  it('does not refuse a wildcard root when disabled', () => {
    const output: OutputDeclaration = { rules: [{ path: '*', field: { class: 'metadata' } }] };
    expect(() => projectOutput({ a: 1 }, output, {})).not.toThrow();
  });
});

describe('projectOutput removals', () => {
  it('strips content fields of the stripped kinds and drops internal fields, metadata intact', () => {
    const result = projectOutput(cdrFixture(), resourceDeclaration('CdrD'), {
      stripKinds: ['ai_summary', 'transcript'],
      dropInternal: true,
    });
    expect(result.projected).toEqual({
      success: true,
      data: [
        {
          id: 'cdr-1',
          name: 'Alice',
          number: '1011',
          'call-orig-call-id': 'call-abc',
          'call-audio-codec': 'PCMU',
        },
      ],
    });
    expect(result.stripped).toEqual({ ai_summary: 3 });
    expect(result.internalDropped).toBe(3);
    expect(result.undeclaredDropped).toBe(0);
    expect(result.secrets).toBe(0);
  });

  it('keeps internal fields when internal dropping is off', () => {
    const result = projectOutput(cdrFixture(), resourceDeclaration('CdrD'), { stripKinds: ['ai_summary'] });
    expect(result.projected).toMatchObject({
      data: [{ 'prefilled-transcription-api': 'https://transcribe.example.test/api/job-1' }],
    });
    expect(result.internalDropped).toBe(0);
  });

  it('strips a content field nested in a JSON string', () => {
    const payload = {
      success: true,
      data: [{ id: 'x', 'payload-json': JSON.stringify({ 'call-intelligence-summary': 'secret summary', kept: 'yes' }) }],
    };
    const result = projectOutput(payload, resourceDeclaration('CdrD'), { stripKinds: ['ai_summary'] });
    expect(result.projected).toEqual({ success: true, data: [{ id: 'x', 'payload-json': '{"kept":"yes"}' }] });
    expect(result.stripped).toEqual({ ai_summary: 1 });
  });

  it('leaves a JSON string untouched when nothing in it is removed', () => {
    const text = JSON.stringify({ kept: 'yes' });
    const payload = { 'payload-json': text };
    expect(projectOutput(payload, undefined, { stripKinds: ['ai_summary'] }).projected).toEqual({ 'payload-json': text });
  });

  it('strips by name in a resource that does not classify the field', () => {
    const payload = { 'call-intelligence-summary': 'summary text', keep: 1 };
    const result = projectOutput(payload, undefined, { stripKinds: ['ai_summary'] });
    expect(result.projected).toEqual({ keep: 1 });
    expect(result.stripped).toEqual({ ai_summary: 1 });
  });

  it('still scrubs secrets while it strips content, and counts them as scrubSecrets does', () => {
    const payload = { pin: 1234, 'call-intelligence-summary': 'summary', user: '1011' };
    const result = projectOutput(payload, undefined, { stripKinds: ['ai_summary'] });
    expect(result.projected).toEqual({ user: '1011' });
    expect(result.secrets).toBe(scrubSecrets(payload).count);
    expect(result.stripped).toEqual({ ai_summary: 1 });
  });
});

describe('projectOutput allowlist', () => {
  it('drops every undeclared path, counted once per dropped key', () => {
    const payload = { success: true, data: [{ id: 'x', 'mystery-field': 'y', nested: { 'deep-mystery': 1 } }] };
    const result = projectOutput(payload, resourceDeclaration('CdrD'), { allowlist: true });
    expect(result.projected).toEqual({ success: true, data: [{ id: 'x' }] });
    expect(result.undeclaredDropped).toBe(2);
  });

  it('agrees with findUndeclaredPaths on which paths it drops', () => {
    const payload = { success: true, data: [{ id: 'x', 'mystery-field': 'y' }] };
    expect(findUndeclaredPaths(payload, resourceDeclaration('CdrD'))).toEqual(['data[].mystery-field']);
    expect(projectOutput(payload, resourceDeclaration('CdrD'), { allowlist: true }).undeclaredDropped).toBe(1);
  });

  it('drops everything when there is no declaration', () => {
    const result = projectOutput({ a: 1, b: { c: 2 } }, undefined, { allowlist: true });
    expect(result.projected).toEqual({});
    expect(result.undeclaredDropped).toBe(2);
  });

  it('keeps a field the resource table declares, and walks into it to strip content', () => {
    const payload = { success: true, data: [{ id: 'x', 'call-intelligence-summary': 'summary' }] };
    const result = projectOutput(payload, resourceDeclaration('CdrD'), {
      allowlist: true,
      stripKinds: ['ai_summary'],
    });
    expect(result.projected).toEqual({ success: true, data: [{ id: 'x' }] });
    expect(result.stripped).toEqual({ ai_summary: 1 });
    expect(result.undeclaredDropped).toBe(0);
  });
});

describe('projectOutput refuses declarations it cannot enforce', () => {
  it('throws on a wildcard root when a removal is requested', () => {
    const output: OutputDeclaration = { rules: [{ path: '*', field: { class: 'metadata' } }] };
    expect(() => projectOutput({ a: 1 }, output, { stripKinds: ['ai_summary'] })).toThrow(/wildcard root/i);
    expect(() => projectOutput({ a: 1 }, output, { allowlist: true })).toThrow(/wildcard root/i);
  });
});

describe('findUndeclaredPaths', () => {
  it('does not report paths beneath a field the resource table names', () => {
    const payload = { data: [{ 'call-intelligence-summary': { anything: 1 } }] };
    expect(findUndeclaredPaths(payload, resourceDeclaration('CdrD'))).toEqual([]);
  });

  it('accepts an empty root resource rule', () => {
    expect(findUndeclaredPaths({ id: 'x' }, { rules: [{ path: '', resource: 'CdrD' }] })).toEqual([]);
  });
});

describe('withheldMarker', () => {
  it('reports per stripped kind and undeclared paths', () => {
    expect(withheldMarker({ stripped: { ai_summary: 3, transcript: 1 }, undeclaredDropped: 2 })).toEqual({
      ai_summary: 3,
      transcript: 1,
      undeclared: 2,
    });
  });

  it('is undefined when nothing was removed', () => {
    expect(withheldMarker({ stripped: {}, undeclaredDropped: 0 })).toBeUndefined();
  });
});
