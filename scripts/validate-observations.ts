import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { normalizeOperationKey } from '../src/netsapiens/operation-key.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const OBSERVATION_RULE = "unauthenticated GET; 404 with 'No Route Found' = absent; any other status = present";
export interface Observation {
  schemaVersion: 2;
  apiVersion: string;
  probedAt: string;
  source: 'community' | 'maintainer';
  probe: { version: string; keyCount: number; keySetSha256: string };
  rule: string;
  control: { status: 404; noRouteFound: true };
  results: Record<string, { status: number; result: 'present' | 'absent' }>;
}
export type BranchKeys = Map<string, Set<string>>;

export function loadBranchKeys(): BranchKeys {
  const branches: string[] = JSON.parse(readFileSync(resolve(root, 'spec/v2/BRANCHES.json'), 'utf8'));
  return new Map(branches.map(branch => {
    const spec = JSON.parse(readFileSync(resolve(root, `spec/v2/${branch}.json`), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
    const keys = new Set(Object.entries(spec.paths).filter(([, operations]) => 'get' in operations).map(([path]) => normalizeOperationKey('GET', path)));
    return [branch, keys];
  }));
}

export function keySetHash(keys: string[]): string {
  return createHash('sha256').update([...keys].sort().join('\n')).digest('hex');
}

const schema = JSON.parse(readFileSync(resolve(root, 'spec/v2/observations/schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true });
const schemaCheck = ajv.compile(schema);

export function validateObservation(value: unknown, fileName: string, branches: BranchKeys = loadBranchKeys()): asserts value is Observation {
  if (!schemaCheck(value)) throw new Error(`Observation schema: ${ajv.errorsText(schemaCheck.errors)}`);
  const observation = value as Observation;
  if (basename(fileName) !== `${observation.apiVersion}.json`) throw new Error('Observation filename does not match apiVersion');
  if (Number.isNaN(Date.parse(`${observation.probedAt}T00:00:00Z`)) || new Date(`${observation.probedAt}T00:00:00Z`).toISOString().slice(0, 10) !== observation.probedAt) throw new Error('Invalid probe date');
  const line = observation.apiVersion.split('.').slice(0, 2).map(Number);
  const beforeOrEqual = (branch: string) => {
    const parts = branch.split('.').map(Number);
    return parts[0] < line[0] || (parts[0] === line[0] && parts[1] <= line[1]);
  };
  const sorted = [...branches.keys()].filter(beforeOrEqual).sort((a, b) => {
    const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
    return aa[0] - bb[0] || aa[1] - bb[1];
  });
  if (!sorted.length) throw new Error('No documented branch at or below observation version');
  const union = new Set([...branches.values()].flatMap(keys => [...keys]));
  const keys = Object.keys(observation.results);
  for (const key of keys) {
    if (!union.has(key)) throw new Error(`Unknown GET key: ${key}`);
    if (observation.results[key].result === 'absent' && observation.results[key].status !== 404) throw new Error(`Absent key must have 404: ${key}`);
    const result = observation.results[key];
    if (result.result === 'present' && (result.status === 403 || result.status === 429 || (result.status >= 300 && result.status < 400) || result.status >= 500)) throw new Error(`Present key has non-evidence status: ${key}`);
  }
  for (const branch of sorted) for (const key of branches.get(branch)!) {
    if (!(key in observation.results)) throw new Error(`Missing documented key: ${key}`);
  }
  if (observation.probe.keyCount !== keys.length || observation.probe.keySetSha256 !== keySetHash(keys)) throw new Error('Observation key count or digest mismatch');
  const ownKeys = branches.get(sorted[sorted.length - 1])!;
  const absent = [...ownKeys].filter(key => observation.results[key]?.result === 'absent').length;
  if (ownKeys.size === 0 || absent * 2 >= ownKeys.size) throw new Error('Probe blocked: half or more documented routes absent');
}

export function validateObservationDirectory(dir = resolve(root, 'spec/v2/observations'), branches = loadBranchKeys()): void {
  for (const file of readdirSync(dir).filter(name => name.endsWith('.json') && name !== 'schema.json')) {
    const raw = readFileSync(resolve(dir, file), 'utf8');
    const value: unknown = JSON.parse(raw);
    if (raw !== JSON.stringify(value, null, 2) + '\n') throw new Error('Observation must be unmodified canonical JSON');
    validateObservation(value, file, branches);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    validateObservationDirectory(process.argv[2]);
    console.log('Observations valid');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
