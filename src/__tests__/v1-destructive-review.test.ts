/**
 * The v1 destructive review (P2, round 2). Every v1 operation in the registry is classified by one of three rules: a
 * reviewed destructive entry (V1_DESTRUCTIVE_ACTIONS, naming the v2 DELETE it pairs with), a reviewed not-destructive entry
 * (V1_NOT_DESTRUCTIVE, with a reason), or a read (V1_READ_ACTION, whose name carries no destructive word). An operation with
 * no reviewed entry fails the gate when its name carries a destructive verb or word, and fails when it is neither a read
 * nor reviewed. So a new v1 operation fails until it is reviewed.
 */
import { describe, expect, it } from 'vitest';
import { toolRegistry } from '../generated/registry.js';
import { v1ToolRegistry } from '../generated/v1/registry.js';
import { v1OperationKeyOf } from '../governance/content-operations.js';
import {
  isDestructiveV1Action,
  isDestructiveV1Verb,
  V1_DESTRUCTIVE_ACTIONS,
  V1_DESTRUCTIVE_LOOKING_WORDS,
  V1_NOT_DESTRUCTIVE,
  V1_READ_ACTION,
  v1ActionWords,
} from '../netsapiens/operation-key.js';

type Verdict = 'destructive' | 'not-destructive' | 'read' | 'unreviewed-destructive' | 'unclassified';

interface Pair {
  readonly key: string;
  readonly object: string;
  readonly action: string;
  readonly name: string;
}

/** Classifies one v1 operation. Pure: it reads only the lists and the names passed in, so synthetic pairs can be checked. */
function verdictOf(pair: { readonly key: string; readonly action: string; readonly names: readonly string[] }): Verdict {
  if (Object.hasOwn(V1_DESTRUCTIVE_ACTIONS, pair.key)) return 'destructive';
  if (Object.hasOwn(V1_NOT_DESTRUCTIVE, pair.key)) return 'not-destructive';
  const words = [pair.action, ...pair.names].flatMap(v1ActionWords);
  if (isDestructiveV1Verb(pair.action) || words.some(word => V1_DESTRUCTIVE_LOOKING_WORDS.has(word))) return 'unreviewed-destructive';
  if (V1_READ_ACTION.test(pair.action)) return 'read';
  return 'unclassified';
}

/** Every v1 tool of the registry, with the operation it sends. Keys repeat where several tools send one operation. */
function registryPairs(): Pair[] {
  return [...v1ToolRegistry].map(([name, def]) => {
    const key = v1OperationKeyOf(def.operation?.key ?? '') ?? '';
    const [, object = '', action = ''] = key.split(':');
    return { key, object, action, name };
  });
}

const PAIRS = registryPairs();
const KEYS = new Set(PAIRS.map(pair => pair.key));
const V2_DELETES = new Set(
  [...toolRegistry.values()]
    .filter(def => String(def.operation?.method ?? '').toUpperCase() === 'DELETE')
    .map(def => String(def.operation?.key ?? '')),
);

describe('v1 destructive review: the registry is fully classified', () => {
  it('every v1 operation is destructive, not destructive, or a read; none is unreviewed', () => {
    const unresolved = PAIRS.filter(pair => {
      const verdict = verdictOf({ key: pair.key, action: pair.action, names: [pair.name] });
      return verdict === 'unreviewed-destructive' || verdict === 'unclassified';
    }).map(pair => `${pair.name} (${pair.key})`);
    expect(unresolved).toEqual([]);
  });

  it('no reviewed entry names an operation the registry lacks (no stale entries)', () => {
    const stale = [...Object.keys(V1_DESTRUCTIVE_ACTIONS), ...Object.keys(V1_NOT_DESTRUCTIVE)].filter(key => !KEYS.has(key));
    expect(stale).toEqual([]);
  });

  it('no operation is reviewed as both destructive and not destructive', () => {
    const both = Object.keys(V1_DESTRUCTIVE_ACTIONS).filter(key => Object.hasOwn(V1_NOT_DESTRUCTIVE, key));
    expect(both).toEqual([]);
  });

  it('no reviewed not-destructive operation carries a destructive verb or word in its name', () => {
    const contradictions = PAIRS.filter(pair => Object.hasOwn(V1_NOT_DESTRUCTIVE, pair.key)).filter(pair => {
      const words = [pair.action, pair.name].flatMap(v1ActionWords);
      return isDestructiveV1Verb(pair.action) || words.some(word => V1_DESTRUCTIVE_LOOKING_WORDS.has(word));
    }).map(pair => `${pair.name} (${pair.key})`);
    expect(contradictions).toEqual([]);
  });

  it('every reviewed destructive operation is destructive at runtime', () => {
    const notDestructive = PAIRS.filter(pair => Object.hasOwn(V1_DESTRUCTIVE_ACTIONS, pair.key) && !isDestructiveV1Action(pair.object, pair.action));
    expect(notDestructive.map(pair => pair.key)).toEqual([]);
  });

  it('every reviewed not-destructive operation is not destructive at runtime', () => {
    const destructive = PAIRS.filter(pair => Object.hasOwn(V1_NOT_DESTRUCTIVE, pair.key) && isDestructiveV1Action(pair.object, pair.action));
    expect(destructive.map(pair => pair.key)).toEqual([]);
  });

  it('every reviewed entry has a reason', () => {
    const blank = [...Object.entries(V1_DESTRUCTIVE_ACTIONS), ...Object.entries(V1_NOT_DESTRUCTIVE)]
      .filter(([, review]) => review.reason.trim() === '')
      .map(([key]) => key);
    expect(blank).toEqual([]);
  });

  it('every v2 form a destructive entry names is a DELETE operation of the registry', () => {
    const missing = Object.entries(V1_DESTRUCTIVE_ACTIONS).flatMap(([key, review]) =>
      (review.v2 ?? []).filter(form => !V2_DELETES.has(form)).map(form => `${key} -> ${form}`),
    );
    expect(missing).toEqual([]);
  });

  it('every read operation carries no destructive word in its name or action', () => {
    const readWithWord = PAIRS.filter(pair => V1_READ_ACTION.test(pair.action)).filter(pair => {
      const words = [pair.action, pair.name].flatMap(v1ActionWords);
      return isDestructiveV1Verb(pair.action) || words.some(word => V1_DESTRUCTIVE_LOOKING_WORDS.has(word));
    });
    expect(readWithWord.map(pair => pair.name)).toEqual([]);
  });
});

describe('v1 destructive review: a new operation with no reviewed entry fails the gate', () => {
  it.each([
    ['purgeAll', 'unreviewed-destructive'],
    ['hangup', 'unreviewed-destructive'],
    ['park2', 'unclassified'],
    ['list', 'read'],
  ])('a new operation %s is classed %s until it is reviewed', (action, expected) => {
    expect(verdictOf({ key: `v1:thing:${action}`, action, names: [`v1_thing_${action}`] })).toBe(expected);
  });

  it('a new operation whose tool name says end is flagged, though its action name does not', () => {
    expect(verdictOf({ key: 'v1:thing:dispatch', action: 'dispatch', names: ['v1_thing_end'] })).toBe('unreviewed-destructive');
  });

  it('a new operation with a reviewed entry is classed by that entry, whatever its name', () => {
    expect(verdictOf({ key: 'v1:call:disconnect', action: 'disconnect', names: ['v1_call_disconnect'] })).toBe('destructive');
    expect(verdictOf({ key: 'v1:call:park', action: 'park', names: ['v1_call_park'] })).toBe('not-destructive');
  });
});

describe('v1 destructive verb heuristic', () => {
  it.each([
    'delete', 'deleteEvents', 'bulkDelete', 'linkDelete', 'link_delete', 'delWakeUp', 'delwakeup', 'deleteaddressendpoint',
    'bulkdelete', 'removeAgent', 'purgecdrs', 'purge', 'clear', 'reset', 'restart', 'reboot', 'restore', 'terminate', 'destroy',
    'cancel', 'revoke',
  ])('treats %s as destructive', action => {
    expect(isDestructiveV1Verb(action)).toBe(true);
  });

  it.each([
    'deliver', 'delay', 'deliveryStatus', 'delivered', 'delayed', 'delegate', 'read', 'create', 'update', 'park', 'hold_orig',
    'readAddressEndpoint', 'endpoint', 'preset',
  ])('does not treat %s as destructive', action => {
    expect(isDestructiveV1Verb(action)).toBe(false);
  });

  it('carries no verb for disconnect or reject, so their reviewed entries decide them', () => {
    expect(isDestructiveV1Verb('disconnect')).toBe(false);
    expect(isDestructiveV1Verb('reject')).toBe(false);
  });
});

describe('isDestructiveV1Action: the reviewed entry and the verb, keyed by object and action', () => {
  it('a reviewed entry decides an action the verb does not carry', () => {
    expect(isDestructiveV1Action('call', 'disconnect')).toBe(true);
    expect(isDestructiveV1Action('call', 'reject')).toBe(true);
  });

  it('a reviewed entry is keyed by its object: the same action on another object is not destructive', () => {
    expect(isDestructiveV1Action('conference', 'disconnect')).toBe(false);
  });

  it('a reviewed not-destructive operation is not destructive', () => {
    expect(isDestructiveV1Action('call', 'park')).toBe(false);
    expect(isDestructiveV1Action('call', 'hold_orig')).toBe(false);
  });

  it('a destructive verb makes the operation destructive, reviewed or not', () => {
    expect(isDestructiveV1Action('callrequest', 'delWakeUp')).toBe(true);
    expect(isDestructiveV1Action('thing', 'deleteAll')).toBe(true);
  });
});
