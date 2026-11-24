import { describe, expect, it } from 'vitest';
import { CURATED_CATALOG } from '../tools/curated/catalog.js';
import { WORKFLOW_TOOLS } from '../tools/curated/workflows.js';
import { toolRegistry } from '../generated/registry.js';
import { v1ToolRegistry } from '../generated/v1/registry.js';
import {
  CONTENT_OPERATION_TABLE,
  CONTENT_OPERATIONS,
  REVIEWED_CONTENT_FREE,
  UNREVIEWED_CONTENT_OPERATIONS,
  contentCoverage,
  contentKindsOf,
  isGatedOperation,
  v1OperationKeyOf,
} from '../governance/content-operations.js';

/** Every operation key the registries generate: v2 normalized keys and canonical v1 keys. */
function liveOperationKeys(): Set<string> {
  const keys = new Set<string>();
  for (const def of toolRegistry.values()) {
    if (def.operation?.key) keys.add(def.operation.key);
  }
  for (const def of v1ToolRegistry.values()) {
    const key = def.operation?.key === undefined ? undefined : v1OperationKeyOf(def.operation.key);
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

const OPERATION_SHAPE = /^((GET|POST|PUT|PATCH|DELETE) \/\S*|v1:[A-Za-z0-9]+:[A-Za-z_]+)$/;

describe('content operation review (spec 3.6)', () => {
  it('every gated v2 or v1 operation is reviewed exactly once, and no entry is stale', () => {
    expect(contentCoverage(liveOperationKeys())).toEqual({ unreviewed: [], conflicting: [], stale: [] });
  });

  it('the gate fails on an operation nobody has reviewed', () => {
    const current = new Set([...liveOperationKeys(), 'POST /domains/{}/voicemail-archives']);
    expect(contentCoverage(current).unreviewed).toEqual(['POST /domains/{}/voicemail-archives']);
  });

  it('the gate fails on an entry that names an operation which no longer exists', () => {
    const current = liveOperationKeys();
    current.delete('GET /recordings/play');
    expect(contentCoverage(current).stale).toEqual(['GET /recordings/play']);
  });

  it('the gate fails on an operation listed in two sets', () => {
    const table = {
      ...CONTENT_OPERATION_TABLE,
      free: { ...REVIEWED_CONTENT_FREE, 'GET /recordings/play': true as const },
    };
    expect(contentCoverage(liveOperationKeys(), table).conflicting).toEqual(['GET /recordings/play']);
  });

  it('every review entry is a well-formed operation key', () => {
    const listed = [
      ...Object.keys(UNREVIEWED_CONTENT_OPERATIONS),
      ...Object.keys(REVIEWED_CONTENT_FREE),
      ...Object.values(CONTENT_OPERATIONS).flatMap((set) => Object.keys(set)),
    ];
    for (const key of listed) expect(key, key).toMatch(OPERATION_SHAPE);
  });

  it('every v1 registry operation has a canonical key of the form v1:<object>:<action>', () => {
    for (const def of v1ToolRegistry.values()) {
      const key = def.operation?.key === undefined ? undefined : v1OperationKeyOf(def.operation.key);
      expect(key, def.schema.name).toMatch(/^v1:[A-Za-z0-9]+:[A-Za-z_]+$/);
    }
  });

  it('every operation a curated tool names exists in the registries', () => {
    const live = liveOperationKeys();
    for (const tool of [...CURATED_CATALOG, ...WORKFLOW_TOOLS]) {
      for (const operation of tool.operations) {
        expect(live.has(operation), `${tool.schema.name} names ${operation}`).toBe(true);
      }
    }
  });

  it('gates exactly the path or v1 object patterns the spec names', () => {
    expect(isGatedOperation('GET /domains/{}/users/{}/voicemails/{}/{}')).toBe(true);
    expect(isGatedOperation('v1:cdrexport:read')).toBe(true);
    expect(isGatedOperation('GET /domains/{}/cdrs/{}/cradle2grave')).toBe(true);
    expect(isGatedOperation('GET /domains/{}/cdrs')).toBe(false);
    expect(isGatedOperation('v1:cdr2:readbyid')).toBe(false);
  });
});

describe('content kinds of an operation', () => {
  it('reports the kinds an operation returns or transmits', () => {
    expect(contentKindsOf('GET /domains/{}/users/{}/faxes')).toEqual(['fax_page']);
    expect(contentKindsOf('GET /domains/{}/cdrs/{}/vcon')).toEqual(['call_recording', 'transcript', 'ai_summary']);
    expect(contentKindsOf('v1:audio:play')).toEqual(['call_recording']);
  });

  it('counts unreviewed operations as every kind', () => {
    expect(contentKindsOf('GET /insight/{}')).toBe('unreviewed');
  });

  it('is undefined for operations no set lists', () => {
    expect(contentKindsOf('GET /fax/vendors')).toBeUndefined();
    expect(contentKindsOf('GET /domains/{}/cdrs')).toBeUndefined();
  });
});
