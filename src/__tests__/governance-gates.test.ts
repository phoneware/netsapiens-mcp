import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toolRegistry } from '../generated/registry.js';
import { v1ToolRegistry } from '../generated/v1/registry.js';
import { normalizeOperationKey } from '../netsapiens/operation-key.js';
import { CONTENT_GATE, isGatedOperation, listedKindsOf, v1OperationKeyOf } from '../governance/content-operations.js';
import { OPERATION_OUTPUTS } from '../governance/operation-outputs.generated.js';
import { NS_RESOURCE_FIELDS } from '../governance/ns-fields.generated.js';
import {
  DESTINATION_PATTERN,
  operationViolations,
  requestRequirement,
  responseRequirement,
  isVoicemailDestination,
} from '../governance/gates.js';
import { forEachOperation, mergeFacts, operationFactsOf, type Components, type OperationFacts, type SpecDocument } from '../governance/spec-walk.js';
import type { FieldClass } from '../governance/types.js';

const TEST_DIR = resolve(fileURLToPath(import.meta.url), '..');

function facts(partial: Partial<OperationFacts>): OperationFacts {
  return {
    responseNames: new Set(partial.responseNames ?? []),
    responseMedia: new Set(partial.responseMedia ?? []),
    requestNames: new Set(partial.requestNames ?? []),
    requestEnumValues: new Set(partial.requestEnumValues ?? []),
  };
}

const TRANSCRIPT: FieldClass = { class: 'content', kind: 'transcript', media: 'text' };

describe('gate (a): the path and object pattern covers the new surfaces', () => {
  it.each([
    'POST /subscriptions',
    'PUT /domains/{}/subscriptions/{}',
    'POST /hooks/webhook',
    'GET /domains/{}/users/{}/playback/{}',
    'POST /domains/{}/uploads',
    'v1:event:create',
    'v1:conversation:read',
    'v1:email:create',
    'v1:upload:create',
  ])('gates %s', (key) => {
    expect(isGatedOperation(key), key).toBe(true);
  });

  it.each(['GET /domains/{}/cdrs', 'GET /domains/{}/users', 'v1:cdr2:readbyid', 'v1:user:list'])('does not gate %s', (key) => {
    expect(isGatedOperation(key), key).toBe(false);
  });

  it('exposes the gate pattern the reviewer named', () => {
    expect(CONTENT_GATE.test('subscri')).toBe(true);
    expect(CONTENT_GATE.test('webhook')).toBe(true);
  });
});

describe('gate (b): response requirement across every spec branch', () => {
  it('flags a response whose field is classified content, and requires that kind to be listed', () => {
    const requirement = responseRequirement(facts({ responseNames: ['transcription'] }), { transcription: TRANSCRIPT });
    expect(requirement.kinds).toEqual(['transcript']);
    expect(requirement.flagged).toBe(true);
  });

  it('flags a response carrying a transcript-named field the table does not classify', () => {
    const requirement = responseRequirement(facts({ responseNames: ['call-recording-status'] }), {});
    expect(requirement.flagged).toBe(true);
    expect(requirement.kinds).toEqual([]);
  });

  it('flags a non-JSON media response, whatever its fields', () => {
    expect(responseRequirement(facts({ responseMedia: ['audio/wav'] }), undefined).flagged).toBe(true);
    expect(responseRequirement(facts({ responseMedia: ['image/webp'] }), undefined).flagged).toBe(true);
  });

  it('leaves a plain JSON response with no classified or named fields unflagged', () => {
    expect(responseRequirement(facts({ responseNames: ['success', 'message'] }), { success: { class: 'metadata' } }).flagged).toBe(false);
  });

  it('reports every violation for an unlisted operation, so the failure names the kinds it needs', () => {
    const violations = operationViolations('GET /synthetic/{}', facts({ responseNames: ['transcription'] }), { transcription: TRANSCRIPT }, undefined);
    expect(violations).toEqual(['GET /synthetic/{}: unlisted, carries transcript']);
  });

  it('fails when the listed kinds miss a kind the response carries', () => {
    const violations = operationViolations('GET /synthetic/{}', facts({ responseNames: ['transcription'] }), { transcription: TRANSCRIPT }, []);
    expect(violations).toEqual(['GET /synthetic/{}: listed kinds [] miss transcript']);
  });

  it('passes when the listed kinds cover the response', () => {
    expect(operationViolations('GET /synthetic/{}', facts({ responseNames: ['transcription'] }), { transcription: TRANSCRIPT }, ['transcript'])).toEqual([]);
  });

  it('passes a listed operation whose response is media', () => {
    expect(operationViolations('GET /synthetic/{}', facts({ responseMedia: ['audio/wav'] }), undefined, [])).toEqual([]);
  });
});

describe('gate (c): request requirement for sinks and model enums', () => {
  it('flags a request with a sink and an enum naming a model, and requires that model kind', () => {
    const requirement = requestRequirement(facts({ requestNames: ['post-url', 'model'], requestEnumValues: ['message'] }));
    expect(requirement.flagged).toBe(true);
    expect(requirement.kinds).toEqual(['sms_text']);
  });

  it('requires transcript and ai_summary for a cdr model, conservatively', () => {
    const requirement = requestRequirement(facts({ requestNames: ['post-url'], requestEnumValues: ['cdr'] }));
    expect(requirement.kinds).toEqual(expect.arrayContaining(['transcript', 'ai_summary']));
  });

  it('does not flag an enum with no sink, or a sink with no model enum', () => {
    expect(requestRequirement(facts({ requestNames: ['model'], requestEnumValues: ['message'] })).flagged).toBe(false);
    expect(requestRequirement(facts({ requestNames: ['post-url'], requestEnumValues: ['daily'] })).flagged).toBe(false);
  });

  it('fails an unlisted subscription-style request', () => {
    const violations = operationViolations('POST /synthetic', facts({ requestNames: ['post-url'], requestEnumValues: ['voicemail'] }), undefined, undefined);
    expect(violations).toEqual(['POST /synthetic: unlisted, transmits voicemail']);
  });
});

describe('gate (d): every voicemail destination is listed as voicemail', () => {
  it.each(['email-send-alert-new-voicemail-cc-list-csv', 'voicemail-reminder-email-address-array', 'voicemail-forward-new-destination', 'vmail_fwd_to'])(
    'treats %s as a destination',
    (name) => {
      expect(isVoicemailDestination(name)).toBe(true);
      expect(DESTINATION_PATTERN.test(name)).toBe(true);
    },
  );

  it.each(['voicemail-enabled', 'voicemail-login-pin', 'voicemail-transcription-enabled'])('does not treat %s as a destination', (name) => {
    expect(isVoicemailDestination(name)).toBe(false);
  });
});

describe('gate over the real specs', () => {
  const specRoot = resolve(TEST_DIR, '../../spec/v2');
  const branches: readonly string[] = JSON.parse(readFileSync(resolve(specRoot, 'BRANCHES.json'), 'utf8')) as string[];

  const factsByKey = new Map<string, OperationFacts>();
  for (const branch of branches) {
    const doc = JSON.parse(readFileSync(resolve(specRoot, `${branch}.json`), 'utf8')) as SpecDocument;
    const components: Components = doc.components?.schemas ?? {};
    forEachOperation(doc, (method, path, op) => {
      const key = normalizeOperationKey(method, path);
      factsByKey.set(key, mergeFacts(factsByKey.get(key), operationFactsOf(op, components)));
    });
  }

  function liveKeys(): Set<string> {
    const keys = new Set<string>();
    for (const def of toolRegistry.values()) if (def.operation?.key) keys.add(def.operation.key);
    for (const def of v1ToolRegistry.values()) {
      const key = def.operation?.key === undefined ? undefined : v1OperationKeyOf(def.operation.key);
      if (key !== undefined) keys.add(key);
    }
    return keys;
  }

  it('every live operation that the response or request gate flags is listed with the kinds it carries', () => {
    const violations: string[] = [];
    for (const key of [...liveKeys()].sort()) {
      const resource = Object.hasOwn(OPERATION_OUTPUTS, key) ? OPERATION_OUTPUTS[key] : undefined;
      const table = resource === undefined ? undefined : NS_RESOURCE_FIELDS[resource];
      violations.push(...operationViolations(key, factsByKey.get(key) ?? facts({}), table, listedKindsOf(key)));
    }
    expect(violations).toEqual([]);
  });
});
