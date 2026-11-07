import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolRegistry } from '../generated/registry.js';
import { v1ToolRegistry } from '../generated/v1/registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');

interface FixtureData {
  v2: Record<string, { key: string; lockKey: string; method: string }>;
  v1: Record<string, { key: string; method: string }>;
}

describe('generator-lock', () => {
  it('every fixture name is generated for the same identity', () => {
    const fixturePath = resolve(REPO_ROOT, 'src/__tests__/fixtures/pre-v3-tool-names.json');
    const fixture: FixtureData = JSON.parse(readFileSync(fixturePath, 'utf8'));

    const v2Names = Object.keys(fixture.v2);
    const v1Names = Object.keys(fixture.v1);

    expect(v2Names.length).toBe(454);
    expect(v1Names.length).toBe(273);

    for (const [name, expected] of Object.entries(fixture.v2)) {
      const tool = toolRegistry.get(name);
      expect(tool, `tool '${name}' must exist in v2 registry`).toBeDefined();
      expect(tool?.operation?.family).toBe('v2');
      expect(tool?.operation?.key, `tool '${name}' key mismatch`).toBe(expected.key);
      expect(tool?.operation?.method, `tool '${name}' method mismatch`).toBe(expected.method);
    }

    for (const [name, expected] of Object.entries(fixture.v1)) {
      const tool = v1ToolRegistry.get(name);
      expect(tool, `v1 tool '${name}' must exist in v1 registry`).toBeDefined();
      expect(tool?.operation?.family).toBe('v1');
      expect(tool?.operation?.key, `v1 tool '${name}' key mismatch`).toBe(expected.key);
      expect(tool?.operation?.method, `v1 tool '${name}' method mismatch`).toBe(expected.method);
    }
  });

  it('lock file matches generated tools for every locked identity', () => {
    const lockPath = resolve(REPO_ROOT, 'spec/v2/tool-names.lock.json');
    const lock: Record<string, string> = JSON.parse(readFileSync(lockPath, 'utf8'));

    expect(Object.keys(lock).length).toBe(454);

    for (const [lockKey, name] of Object.entries(lock)) {
      const tool = toolRegistry.get(name);
      expect(tool, `tool '${name}' for locked key '${lockKey}' must exist in registry`).toBeDefined();
      expect(tool?.schema.name).toBe(name);
      const baseOpKey = lockKey.replace(/#\d+$/, '');
      expect(tool?.operation?.key).toBe(baseOpKey);
    }
  });
});
