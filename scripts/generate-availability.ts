#!/usr/bin/env tsx

/**
 * NetSapiens Availability Data Generator
 *
 * Generates `src/generated/availability.json` with schemaVersion: 2.
 * Combines route definitions across all vendored v2 OpenAPI specification branches
 * and the v1 apidoc specification.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeOperationKey } from '../src/netsapiens/operation-key.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_REPO_ROOT = resolve(__dirname, '..');

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const;
const EXCLUDED_OBJECTS = new Set(['sfu']);

export interface V2AvailabilityEntry {
  branches: string[];
  documented: string[];
  observed: Record<string, 'present' | 'absent'>;
}

export interface V1AvailabilityEntry {
  branches: string[];
  documented: string[];
}

export interface AvailabilityData {
  schemaVersion: 2;
  branches: string[];
  observations: Array<{
    apiVersion: string;
    line: string;
    probedAt: string;
    source: string;
  }>;
  v2: Record<string, V2AvailabilityEntry>;
  v1: Record<string, V1AvailabilityEntry>;
}

function parseObjectAction(url: string): { object: string; action: string } | null {
  const objMatch = url.match(/object=([^&]+)/);
  const actMatch = url.match(/action=([^&]+)/);
  if (!objMatch || !actMatch) return null;
  return { object: objMatch[1], action: actMatch[1] };
}

export function buildAvailability(options?: { repoRoot?: string }): AvailabilityData {
  const repoRoot = options?.repoRoot ?? DEFAULT_REPO_ROOT;

  // 1. Read branches from BRANCHES.json
  const branchesPath = resolve(repoRoot, 'spec/v2/BRANCHES.json');
  const branches: string[] = JSON.parse(readFileSync(branchesPath, 'utf8'));

  // 2. Aggregate v2 operations across all branches
  const v2Map = new Map<string, Set<string>>();

  for (const branch of branches) {
    const specPath = resolve(repoRoot, `spec/v2/${branch}.json`);
    const spec = JSON.parse(readFileSync(specPath, 'utf8')) as {
      paths?: Record<string, Record<string, unknown>>;
    };

    for (const [rawPath, pathItem] of Object.entries(spec.paths ?? {})) {
      for (const method of HTTP_METHODS) {
        if (pathItem[method]) {
          const key = normalizeOperationKey(method, rawPath);
          if (!v2Map.has(key)) {
            v2Map.set(key, new Set());
          }
          v2Map.get(key)!.add(branch);
        }
      }
    }
  }

  // Sort v2 keys alphabetically
  const sortedV2Keys = Array.from(v2Map.keys()).sort();
  const v2: Record<string, V2AvailabilityEntry> = {};
  for (const key of sortedV2Keys) {
    const branchSet = v2Map.get(key)!;
    const branchList = Array.from(branchSet).sort();
    v2[key] = {
      branches: branchList,
      documented: branchList,
      observed: {},
    };
  }

  // 3. Aggregate v1 operations
  const v1Path = resolve(repoRoot, 'spec/v1/apidoc-44.4.10.json');
  const v1Raw = readFileSync(v1Path, 'utf8');
  const v1Endpoints = JSON.parse(v1Raw) as Array<{ type: string; url: string }>;

  const v1Map = new Map<string, string[]>();
  for (const ep of v1Endpoints) {
    const parsed = parseObjectAction(ep.url);
    if (!parsed) continue;
    if (EXCLUDED_OBJECTS.has(parsed.object.toLowerCase())) continue;

    const method = ep.type.toUpperCase();
    const key = `${method} ${ep.url}`;
    v1Map.set(key, ['44.4.10']);
  }

  // Sort v1 keys alphabetically
  const sortedV1Keys = Array.from(v1Map.keys()).sort();
  const v1: Record<string, V1AvailabilityEntry> = {};
  for (const key of sortedV1Keys) {
    v1[key] = {
      branches: ['44.4.10'],
      documented: ['44.4.10'],
    };
  }

  return {
    schemaVersion: 2,
    branches,
    observations: [],
    v2,
    v1,
  };
}

function main(): void {
  const data = buildAvailability();
  const outPath = resolve(DEFAULT_REPO_ROOT, 'src/generated/availability.json');
  writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`Generated ${outPath} (v2: ${Object.keys(data.v2).length}, v1: ${Object.keys(data.v1).length})`);
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main();
}
