import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeOperationKey } from '../netsapiens/operation-key.js';
import type { AvailabilityData } from '../../scripts/generate-availability.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const;

describe('availability-data', () => {
  const availPath = resolve(REPO_ROOT, 'src/generated/availability.json');
  const data: AvailabilityData = JSON.parse(readFileSync(availPath, 'utf8'));

  const branchesPath = resolve(REPO_ROOT, 'spec/v2/BRANCHES.json');
  const expectedBranches: string[] = JSON.parse(readFileSync(branchesPath, 'utf8'));

  it('schemaVersion is 2', () => {
    expect(data.schemaVersion).toBe(2);
  });

  it('contains two maintainer observations for 44.4.10 and 44.5.2', () => {
    expect(data.observations).toHaveLength(2);
    expect(data.observations[0]).toEqual({
      apiVersion: '44.4.10',
      line: '44.4',
      probedAt: '2026-11-01',
      source: 'maintainer',
    });
    expect(data.observations[1]).toEqual({
      apiVersion: '44.5.2',
      line: '44.5',
      probedAt: '2026-11-01',
      source: 'maintainer',
    });
  });

  it('computes early-route counts and verifies 45.0-first statistics keys on line 44.4', () => {
    const statsKeys = [
      'GET /domains/{}/statistics/callqueues/aggregate',
      'GET /domains/{}/statistics/callqueues/{}',
      'GET /domains/{}/statistics/agent',
      'GET /domains/{}/statistics/agent/{}',
    ];
    for (const key of statsKeys) {
      expect(data.v2[key]?.observed?.['44.4.10']).toBe('present');
    }

    let e45 = 0;
    let n45 = 0;
    let e46 = 0;
    let n46 = 0;
    for (const [key, entry] of Object.entries(data.v2)) {
      if (!key.startsWith('GET ')) continue;
      const docs = entry.documented || [];
      const firstDoc = docs[0];
      const obs = entry.observed?.['44.4.10'];
      if (firstDoc === '45.0') {
        if (obs === 'present') e45++;
        else if (obs === 'absent') n45++;
      } else if (firstDoc === '46.0') {
        if (obs === 'present') e46++;
        else if (obs === 'absent') n46++;
      }
    }
    expect(e45).toBe(20);
    expect(n45).toBe(49);
    expect(e46).toBe(53);
    expect(n46).toBe(322);
  });

  it('branches equal BRANCHES.json', () => {
    expect(data.branches).toEqual(expectedBranches);
  });

  it('key and baseline counts equal values computed dynamically from the four spec files', () => {
    const unionKeys = new Set<string>();
    const branchKeys: Record<string, Set<string>> = {};

    for (const b of expectedBranches) {
      branchKeys[b] = new Set<string>();
      const specPath = resolve(REPO_ROOT, `spec/v2/${b}.json`);
      const spec = JSON.parse(readFileSync(specPath, 'utf8')) as {
        paths?: Record<string, Record<string, unknown>>;
      };

      for (const [rawPath, pathItem] of Object.entries(spec.paths ?? {})) {
        for (const method of HTTP_METHODS) {
          if (pathItem[method]) {
            const key = normalizeOperationKey(method, rawPath);
            unionKeys.add(key);
            branchKeys[b].add(key);
          }
        }
      }
    }

    const baselineKeys = Array.from(unionKeys).filter((k) =>
      expectedBranches.every((b) => branchKeys[b].has(k)),
    );

    // Assert v2 key count equals computed union count
    expect(Object.keys(data.v2).length).toBe(unionKeys.size);

    // Assert baseline count in availability data equals computed baseline count
    const dataBaselineCount = Object.values(data.v2).filter((entry) => {
      const docs = entry.documented ?? entry.branches ?? [];
      return expectedBranches.every((b) => docs.includes(b));
    }).length;

    expect(dataBaselineCount).toBe(baselineKeys.length);
  });

  it('GET /domains/{}/statistics/agent/{} is documented in ["45.0", "46.0"]', () => {
    const entry = data.v2['GET /domains/{}/statistics/agent/{}'];
    expect(entry, 'GET /domains/{}/statistics/agent/{} must exist in v2 availability').toBeDefined();
    const documented = entry.documented ?? entry.branches;
    expect(documented).toEqual(['45.0', '46.0']);
  });

  it('v2 and v1 keys are sorted alphabetically', () => {
    const v2Keys = Object.keys(data.v2);
    const sortedV2Keys = [...v2Keys].sort();
    expect(v2Keys).toEqual(sortedV2Keys);

    const v1Keys = Object.keys(data.v1);
    const sortedV1Keys = [...v1Keys].sort();
    expect(v1Keys).toEqual(sortedV1Keys);
  });
});
