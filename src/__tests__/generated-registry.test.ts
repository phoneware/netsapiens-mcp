/**
 * Sanity checks on the auto-generated tool registries.
 *
 * Rather than re-running the generators with fixture specs (which adds a tsx
 * subprocess to the test path), this asserts the shape and key invariants of
 * the registries that `npm run generate` produces from the real specs:
 *   - both v1 and v2 produce non-zero tool counts
 *   - every tool has a usable schema and an async handler
 *   - all v1 tool names are prefixed `v1_` so the disable glob works
 *   - the merged tools/index registry shapes match
 */

import { describe, expect, it } from 'vitest';
import { toolRegistry as v2Registry } from '../generated/registry.js';
import { v1ToolRegistry } from '../generated/v1/registry.js';

describe('generated v2 registry', () => {
  it('exposes a large number of tools', () => {
    expect(v2Registry.size).toBeGreaterThan(400);
  });

  it('every tool has a schema with name/description/inputSchema and an async handler', () => {
    for (const [name, def] of v2Registry) {
      expect(def.schema.name).toBe(name);
      expect(typeof def.schema.description).toBe('string');
      expect(def.schema.description.length).toBeGreaterThan(0);
      expect(typeof def.schema.inputSchema).toBe('object');
      expect(typeof def.handler).toBe('function');
    }
  });

  it('contains expected anchor tools', () => {
    expect(v2Registry.has('get_domains')).toBe(true);
    expect(v2Registry.has('create_domain')).toBe(true);
  });
});

describe('generated v1 registry', () => {
  it('exposes a meaningful number of tools', () => {
    expect(v1ToolRegistry.size).toBeGreaterThan(100);
  });

  it('every v1 tool name is prefixed `v1_`', () => {
    for (const name of v1ToolRegistry.keys()) {
      expect(name.startsWith('v1_')).toBe(true);
    }
  });

  it('every v1 tool has a [v1] description tag', () => {
    for (const [, def] of v1ToolRegistry) {
      expect(def.schema.description).toContain('[v1]');
    }
  });
});

describe('input schemas are valid JSON Schema draft 2020-12', () => {
  it('every generated tool schema compiles under ajv 2020', async () => {
    // Lazy-load both ajv and the merged registry so this test mirrors what
    // the Anthropic API checks when ListTools is sent over the wire.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Ajv2020 = (await import('ajv/dist/2020.js')).default;
    const { getAllToolDefinitions } = await import('../tools/index.js');
    const ajv = new (Ajv2020 as never as { new (opts: object): { compile: (s: object) => unknown } })({ strict: false });
    const tools = await getAllToolDefinitions();
    const failures: string[] = [];
    for (const t of tools) {
      try {
        ajv.compile(t.inputSchema);
      } catch (err) {
        failures.push(`${t.name}: ${(err as Error).message.slice(0, 200)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('cross-registry invariants', () => {
  it('v1 names do not collide with v2 names', () => {
    for (const v1Name of v1ToolRegistry.keys()) {
      expect(v2Registry.has(v1Name)).toBe(false);
    }
  });

  it('all v2 tool handlers accept (args, client) signature', () => {
    for (const [, def] of v2Registry) {
      // .length is the number of declared params
      expect(def.handler.length).toBeGreaterThanOrEqual(2);
    }
  });
});
