import { describe, expect, it } from 'vitest';
import { OPERATION_OUTPUTS } from '../governance/operation-outputs.generated.js';
import { NS_RESOURCE_FIELDS } from '../governance/ns-fields.generated.js';
import { resourceDeclaration } from '../governance/scrub.js';

describe('operation outputs (spec 3.3, output projection)', () => {
  it('names only resources that have a field table', () => {
    for (const [key, resource] of Object.entries(OPERATION_OUTPUTS)) {
      expect(Object.hasOwn(NS_RESOURCE_FIELDS, resource), `${key} -> ${resource}`).toBe(true);
    }
  });

  it('names the response resource of operations that return one', () => {
    expect(OPERATION_OUTPUTS['GET /domains/{}/users/{}/faxes']).toBe('Fax');
    expect(OPERATION_OUTPUTS['POST /domains/{}/users/{}/faxes']).toBe('Fax');
    expect(OPERATION_OUTPUTS['GET /domains/{}/transcriptions']).toBe('Transcription');
    // 46.0 returns VoicemailMessage for this operation; 44.3 to 45.0 return Audiofile records. The map is the union (spec 3.6).
    const voicemailRead = OPERATION_OUTPUTS['GET /domains/{}/users/{}/voicemails/{}/{}'];
    expect(voicemailRead).toContain('VoicemailMessage');
    expect(voicemailRead).toContain('Audiofile');
  });

  it('leaves unmapped an operation whose response is not a named JSON resource', () => {
    expect(Object.hasOwn(OPERATION_OUTPUTS, 'GET /domains/{}/users/{}/faxes/{}/play')).toBe(false);
  });

  it('declares a resource under the response wrapper and at the root', () => {
    expect(resourceDeclaration('Fax').rules).toEqual(
      expect.arrayContaining([
        { path: 'data[]', resource: 'Fax' },
        { path: 'data', resource: 'Fax' },
        { path: '', resource: 'Fax' },
      ]),
    );
  });
});

describe('composite output resources', () => {
  it('declares every field of every member, and names members in sorted order', () => {
    const composites = [...new Set(Object.values(OPERATION_OUTPUTS))].filter((name) => name.startsWith('Union('));
    expect(composites.length).toBeGreaterThan(0);
    for (const composite of composites) {
      const members = composite.slice('Union('.length, -1).split(',');
      expect(members.length, composite).toBeGreaterThan(1);
      expect(members, composite).toEqual([...members].sort());
      for (const member of members) {
        for (const field of Object.keys(NS_RESOURCE_FIELDS[member] ?? {})) {
          expect(Object.hasOwn(NS_RESOURCE_FIELDS[composite] ?? {}, field), `${composite} lacks ${member}.${field}`).toBe(true);
        }
      }
    }
  });
});
