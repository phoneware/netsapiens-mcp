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
    expect(OPERATION_OUTPUTS['GET /domains/{}/users/{}/voicemails/{}/{}']).toBe('VoicemailMessage');
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
