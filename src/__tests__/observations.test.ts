import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keySetHash, OBSERVATION_RULE, validateObservation, validateObservationDirectory, type Observation, type BranchKeys } from '../../scripts/validate-observations.js';

const branches: BranchKeys = new Map([
  ['44.3', new Set(['GET /a', 'GET /b'])],
  ['44.4', new Set(['GET /a', 'GET /b', 'GET /c', 'GET /d'])],
  ['45.0', new Set(['GET /new'])],
]);
function fixture(): Observation {
  const keys = ['GET /a', 'GET /b', 'GET /c', 'GET /d', 'GET /new'];
  return {
    schemaVersion: 2, apiVersion: '44.4.10', probedAt: '2026-10-29', source: 'community',
    probe: { version: '2.3.1', keyCount: keys.length, keySetSha256: keySetHash(keys) },
    rule: OBSERVATION_RULE, control: { status: 404, noRouteFound: true },
    results: Object.fromEntries(keys.map(key => [key, { status: 400, result: 'present' }])),
  };
}
function rehash(observation: Observation): void {
  const keys = Object.keys(observation.results);
  observation.probe.keyCount = keys.length;
  observation.probe.keySetSha256 = keySetHash(keys);
}

describe('observation validation', () => {
  it('accepts a complete valid observation', () => {
    expect(() => validateObservation(fixture(), '44.4.10.json', branches)).not.toThrow();
  });
  it.each([
    ['control status', (o: Observation) => { Object.assign(o.control, { status: 200 }); }, '44.4.10.json'],
    ['extra host field', (o: Observation) => { Object.assign(o, { host: 'example.invalid' }); }, '44.4.10.json'],
    ['filename mismatch', (_o: Observation) => { }, '44.4.11.json'],
    ['unknown key', (o: Observation) => { o.results['GET /unknown'] = { status: 400, result: 'present' }; rehash(o); }, '44.4.10.json'],
    ['missing documented key', (o: Observation) => { delete o.results['GET /a']; rehash(o); }, '44.4.10.json'],
    ['bad count', (o: Observation) => { o.probe.keyCount++; }, '44.4.10.json'],
    ['bad digest', (o: Observation) => { o.probe.keySetSha256 = '0'.repeat(64); }, '44.4.10.json'],
    ['absent status', (o: Observation) => { o.results['GET /a'] = { status: 400, result: 'absent' }; }, '44.4.10.json'],
    ['half the branch absent', (o: Observation) => { o.results['GET /a'] = { status: 404, result: 'absent' }; o.results['GET /b'] = { status: 404, result: 'absent' }; }, '44.4.10.json'],
  ])('rejects %s', (_name, mutate, filename) => {
    const value = fixture(); mutate(value);
    expect(() => validateObservation(value, filename, branches)).toThrow();
  });
  it.each([301, 403, 429, 500, 503])('rejects present status %i', status => {
    const value = fixture();
    value.results['GET /a'] = { status, result: 'present' };
    expect(() => validateObservation(value, '44.4.10.json', branches)).toThrow('non-evidence');
  });
  it.each(['3.0.0-host.example.invalid', '3.0.0-192.0.2.1'])('rejects identifying version suffix %s', version => {
    const value = fixture(); value.probe.version = version;
    expect(() => validateObservation(value, '44.4.10.json', branches)).toThrow();
  });
  it.each(['3.0.0-alpha.1', '3.0.0-beta.2', '3.0.0-rc.3', '3.0.0-next.4'])('accepts release suffix %s', version => {
    const value = fixture(); value.probe.version = version;
    expect(() => validateObservation(value, '44.4.10.json', branches)).not.toThrow();
  });
  it('rejects duplicate keys and noncanonical observation bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'observation-validation-'));
    try {
      const path = join(dir, '44.4.10.json');
      const canonical = JSON.stringify(fixture(), null, 2) + '\n';
      writeFileSync(path, canonical);
      expect(() => validateObservationDirectory(dir, branches)).not.toThrow();
      writeFileSync(path, canonical.replace('{', '{\n  \"apiVersion\": \"host.example.invalid\",'));
      expect(() => validateObservationDirectory(dir, branches)).toThrow('canonical');
      writeFileSync(path, canonical + ' ');
      expect(() => validateObservationDirectory(dir, branches)).toThrow('canonical');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
