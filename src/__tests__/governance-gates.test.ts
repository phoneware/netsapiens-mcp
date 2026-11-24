import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toolRegistry } from '../generated/registry.js';
import { v1ToolRegistry } from '../generated/v1/registry.js';
import { normalizeOperationKey } from '../netsapiens/operation-key.js';
import {
  isGatedOperation,
  listedKindsOf,
  NAME_REVIEWS,
  RECORD_LIST_OPERATIONS,
  REVIEWED_CONTENT_FREE,
  v1OperationKeyOf,
} from '../governance/content-operations.js';
import {
  isDestinationName,
  isVoicemailDestination,
  operationViolations,
  REVIEWED_SETTING_NAMES,
  RESPONSE_NAME_PATTERN,
} from '../governance/gates.js';
import { OPERATION_OUTPUTS } from '../governance/operation-outputs.generated.js';
import { NS_RESOURCE_FIELDS } from '../governance/ns-fields.generated.js';
import { v1FactsOf } from '../governance/v1-facts.js';
import { forEachOperation, mergeFacts, operationFactsOf, type Components, type OperationFacts, type SpecDocument } from '../governance/spec-walk.js';

interface FactInput {
  responseNames?: string[];
  responseMedia?: string[];
  writes?: boolean;
  bodyNames?: string[];
  queryNames?: string[];
  requestNames?: string[];
  requestEnumValues?: string[];
}

/** The facts of one synthetic operation. */
function facts(input: FactInput): OperationFacts {
  return {
    responseNames: new Set(input.responseNames ?? []),
    responseMedia: new Set(input.responseMedia ?? []),
    writes: input.writes ?? false,
    bodyNames: new Set(input.bodyNames ?? []),
    queryNames: new Set(input.queryNames ?? []),
    requestNames: new Set(input.requestNames ?? []),
    requestEnumValues: new Set(input.requestEnumValues ?? []),
  };
}

describe('gate (a): a write that names a destination must be listed', () => {
  it.each([
    'smtp-host',
    'export-hostname',
    'remote_path',
    'service-url',
    'ccc-ip',
    'archive-path',
    'inbound-email',
    'participants',
    'email',
    'dest-number',
    'bucket',
    'server-id',
  ])('flags a write that names %s', (name) => {
    expect(operationViolations('POST /synthetic', facts({ writes: true, bodyNames: [name] }), undefined, undefined, {})).toHaveLength(1);
  });

  it('accepts a destination write listed free with a reason that says what the destination receives', () => {
    expect(
      operationViolations('POST /synthetic', facts({ writes: true, bodyNames: ['smtp-host'] }), undefined, [], {}, 'receives nothing: a relay host name'),
    ).toEqual([]);
  });

  it('does not flag a read that names a destination, or a write that names none', () => {
    expect(operationViolations('GET /synthetic', facts({ bodyNames: ['smtp-host'] }), undefined, undefined, {})).toEqual([]);
    expect(operationViolations('POST /synthetic', facts({ writes: true, bodyNames: ['display-name'] }), undefined, undefined, {})).toEqual([]);
  });

  it('matches whole name tokens, so a substring such as ipaware or hosted is not a destination', () => {
    expect(isDestinationName('ipaware-status')).toBe(false);
    expect(isDestinationName('hosted-video')).toBe(false);
    expect(isDestinationName('ip-address')).toBe(true);
  });
});

describe('gate (a), round 3: destination words, query names, v1 facts and the reason a free listing must give', () => {
  it.each([
    'callback-number',
    'webhook-id',
    'endpoint-id',
    'target-user',
    'forward-always',
    'forwardto',
    'outbound-to',
    'to-user',
    'cc-list',
    'bcc-list',
    'cclist',
    'notify-on-voicemail',
    'account-code',
    'integration-key',
    'credentials-id',
    'address-line-1',
    'members',
    'push-network',
    'push-device-token',
    'device-aor',
    'phonenumber-fax',
    'responder-user',
    'callqueue-agent-id',
  ])('flags a write that names %s, a word that names where content goes', (name) => {
    expect(operationViolations('POST /synthetic', facts({ writes: true, bodyNames: [name] }), undefined, undefined, {})).toHaveLength(1);
  });

  it('matches whole words only: a word that contains a destination word is not one', () => {
    for (const name of ['toolbar', 'accountant', 'notification-count', 'addressing-mode']) expect(isDestinationName(name), name).toBe(false);
    expect(isDestinationName('address')).toBe(true);
  });

  it('reads the query names of a write: a destination in the query is a destination write', () => {
    expect(operationViolations('POST /synthetic', facts({ writes: true, queryNames: ['to'] }), undefined, undefined, {})).toHaveLength(1);
    expect(operationViolations('GET /synthetic', facts({ queryNames: ['to'] }), undefined, undefined, {})).toEqual([]);
  });

  it('derives v1 facts from the apidoc: a v1 write that names a destination is flagged, and a v1 read sets nothing', () => {
    expect(v1FactsOf('update', ['dest', 'number']).writes).toBe(true);
    expect(v1FactsOf('count', ['dest']).writes).toBe(false);
    expect(operationViolations('v1:smsnumber:update', v1FactsOf('update', ['dest']), undefined, undefined, {})).toHaveLength(1);
    expect(operationViolations('v1:smsnumber:count', v1FactsOf('count', ['dest']), undefined, undefined, {})).toEqual([]);
  });

  it('refuses a free listing of a destination write whose reason does not say what the destination receives', () => {
    const write = facts({ writes: true, bodyNames: ['smtp-host'] });
    expect(operationViolations('POST /synthetic', write, undefined, [], {})).toHaveLength(1);
    expect(operationViolations('POST /synthetic', write, undefined, [], {}, 'a relay setting')).toHaveLength(1);
  });

  it('asks no reason of a free listing that names no destination', () => {
    expect(operationViolations('POST /synthetic', facts({ writes: true, bodyNames: ['display-name'] }), undefined, [], {})).toEqual([]);
  });
});

describe('gate (b): response names match without regard to case, and each must be reviewed', () => {
  it.each(['Transcript-Text', 'Body', 'media-type', 'attachment-count', 'Fax-Enabled', 'message-waiting', 'text-to-speech-voice'])(
    'flags the unreviewed response name %s',
    (name) => {
      expect(RESPONSE_NAME_PATTERN.test(name)).toBe(true);
      expect(operationViolations('GET /synthetic', facts({ responseNames: [name] }), undefined, undefined, {})).toHaveLength(1);
    },
  );

  it('does not let a free listing silence a name the operation has not reviewed', () => {
    expect(operationViolations('GET /synthetic', facts({ responseNames: ['Fax-Enabled'] }), undefined, [], {})).toHaveLength(1);
  });

  it('silences a name the operation reviews with a reason', () => {
    expect(
      operationViolations('GET /synthetic', facts({ responseNames: ['Fax-Enabled'] }), undefined, [], { 'Fax-Enabled': 'a fax switch' }),
    ).toEqual([]);
  });

  it('does not silence a name reviewed with an empty reason', () => {
    expect(operationViolations('GET /synthetic', facts({ responseNames: ['Fax-Enabled'] }), undefined, [], { 'Fax-Enabled': '' })).toHaveLength(1);
  });

  it('silences a name on the setting whitelist, and every whitelisted setting carries a reason', () => {
    expect(operationViolations('GET /synthetic', facts({ responseNames: ['recording-configuration'] }), undefined, [], {})).toEqual([]);
    for (const reason of Object.values(REVIEWED_SETTING_NAMES)) expect(reason.trim().length).toBeGreaterThan(0);
  });
});

describe('gate (c): v1 objects that carry destinations and records are gated', () => {
  it.each(['v1:domain:update', 'v1:cdrschedule:create', 'v1:cdr2:readbyid'])('gates %s', (key) => {
    expect(isGatedOperation(key)).toBe(true);
  });

  it('does not gate an unrelated v1 object', () => {
    expect(isGatedOperation('v1:user:list')).toBe(false);
  });

  it('keeps the voicemail destination names that the voicemail kind depends on', () => {
    expect(isVoicemailDestination('email-send-alert-new-voicemail-cc-list-csv')).toBe(true);
    expect(isVoicemailDestination('voicemail-enabled')).toBe(false);
  });
});

describe('reasons', () => {
  it('every free, record-list and name-review entry carries a non-empty reason', () => {
    const reasons = [
      ...Object.values(REVIEWED_CONTENT_FREE),
      ...Object.values(RECORD_LIST_OPERATIONS).map((entry) => entry.reason),
      ...Object.values(NAME_REVIEWS).flatMap((names) => Object.values(names)),
    ];
    for (const reason of reasons) expect(reason.trim().length).toBeGreaterThan(0);
  });
});

describe('the gate over the real specs', () => {
  const TEST_DIR = resolve(fileURLToPath(import.meta.url), '..');
  const specRoot = resolve(TEST_DIR, '../../spec/v2');
  const branches = JSON.parse(readFileSync(resolve(specRoot, 'BRANCHES.json'), 'utf8')) as string[];

  const factsByKey = new Map<string, OperationFacts>();
  for (const branch of branches) {
    const doc = JSON.parse(readFileSync(resolve(specRoot, `${branch}.json`), 'utf8')) as SpecDocument;
    const components: Components = doc.components?.schemas ?? {};
    forEachOperation(doc, (method, path, op) => {
      const key = normalizeOperationKey(method, path);
      factsByKey.set(key, mergeFacts(factsByKey.get(key), operationFactsOf(method, op, components)));
    });
  }
  for (const def of v1ToolRegistry.values()) {
    const raw = def.operation?.key;
    const key = raw === undefined ? undefined : v1OperationKeyOf(raw);
    if (key === undefined) continue;
    const schema = def.schema.inputSchema as unknown as { properties?: Record<string, unknown> };
    factsByKey.set(key, mergeFacts(factsByKey.get(key), v1FactsOf(key.split(':')[2] ?? '', Object.keys(schema.properties ?? {}))));
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

  it('every live operation the gates flag is listed, and every name it carries is reviewed', () => {
    const violations: string[] = [];
    for (const key of [...liveKeys()].sort()) {
      const resource = Object.hasOwn(OPERATION_OUTPUTS, key) ? OPERATION_OUTPUTS[key] : undefined;
      const table = resource === undefined ? undefined : NS_RESOURCE_FIELDS[resource];
      const names = Object.hasOwn(NAME_REVIEWS, key) ? NAME_REVIEWS[key] : {};
      const reason = Object.hasOwn(REVIEWED_CONTENT_FREE, key) ? REVIEWED_CONTENT_FREE[key] : undefined;
      violations.push(...operationViolations(key, factsByKey.get(key) ?? facts({}), table, listedKindsOf(key), names, reason));
    }
    expect(violations).toEqual([]);
  });

  it('every name review names a listed operation and a name that operation really returns', () => {
    for (const [key, names] of Object.entries(NAME_REVIEWS)) {
      expect(listedKindsOf(key), `${key} is listed`).not.toBeUndefined();
      for (const name of Object.keys(names)) {
        expect(factsByKey.get(key)?.responseNames.has(name), `${key} returns ${name}`).toBe(true);
      }
    }
  });
});
