import { describe, expect, it } from 'vitest';
import { keySetHash, OBSERVATION_RULE, validateObservation, type Observation, type BranchKeys } from '../../scripts/validate-observations.js';

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
});
