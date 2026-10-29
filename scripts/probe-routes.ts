import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { keySetHash, loadBranchKeys, OBSERVATION_RULE, validateObservation, type BranchKeys, type Observation } from './validate-observations.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
type ResponseData = { status: number; body: string };
export class ProbeError extends Error {
  constructor(message: string, readonly exitCode: number) { super(message); }
}

export async function probeRoutes(options: {
  apiUrl: string; source: 'maintainer' | 'community'; out: string;
  branches?: BranchKeys; request?: (path: string) => Promise<ResponseData>;
  wait?: (ms: number) => Promise<unknown>; version?: string;
}): Promise<{ observation: Observation; file: string }> {
  let origin: string;
  try {
    const url = new URL(options.apiUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    origin = url.origin;
  } catch { throw new ProbeError('Invalid API URL', 1); }
  const request = options.request ?? (async (path: string) => {
    const response = await fetch(origin + path, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.text() };
  });
  const wait = options.wait ?? delay;
  let versionResponse: ResponseData;
  try { versionResponse = await request('/ns-api/v2/version'); }
  catch { throw new ProbeError('Version request failed', 1); }
  let apiVersion: unknown;
  try { apiVersion = JSON.parse(versionResponse.body).apiversion; } catch { throw new ProbeError('Invalid version response', 1); }
  if (versionResponse.status !== 200 || typeof apiVersion !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(apiVersion)) throw new ProbeError('Invalid version response', 1);
  let control: ResponseData;
  await wait(500);
  try { control = await request(`/ns-api/v2/zz-route-probe-control-${randomUUID()}`); }
  catch { throw new ProbeError('Control request failed', 2); }
  if (control.status !== 404 || !control.body.includes('No Route Found')) throw new ProbeError('Control route did not return the expected 404', 2);
  const branches = options.branches ?? loadBranchKeys();
  const keys = [...new Set([...branches.values()].flatMap(value => [...value]))].sort();
  const results: Observation['results'] = {};
  let failures = 0;
  for (const key of keys) {
    for (; ;) {
      await wait(500);
      let response: ResponseData;
      try {
        response = await request('/ns-api/v2' + key.slice(4).replaceAll('{}', 'probe'));
      } catch {
        failures++;
        if (failures >= 3) throw new ProbeError('Three consecutive route requests failed', 3);
        continue;
      }
      if (response.status === 403 || response.status === 429 || (response.status >= 300 && response.status < 400) || response.status >= 500) {
        failures++;
        if (failures >= 3) throw new ProbeError('Three consecutive route requests failed', 3);
        continue;
    }
      failures = 0;
    results[key] = { status: response.status, result: response.status === 404 && response.body.includes('No Route Found') ? 'absent' : 'present' };
      break;
    }
  }
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { version: string };
  const observation: Observation = {
    schemaVersion: 2, apiVersion, probedAt: new Date().toISOString().slice(0, 10), source: options.source,
    probe: { version: options.version ?? pkg.version, keyCount: keys.length, keySetSha256: keySetHash(keys) },
    rule: OBSERVATION_RULE, control: { status: 404, noRouteFound: true }, results,
  };
  const file = join(options.out, `${apiVersion}.json`);
  try { validateObservation(observation, file, branches); }
  catch { throw new ProbeError('Observation failed validation', 1); }
  await mkdir(options.out, { recursive: true });
  await writeFile(file, JSON.stringify(observation, null, 2) + '\n', { flag: 'wx' });
  return { observation, file };
}

export async function runProbeCli(args: string[], overrides: Partial<Parameters<typeof probeRoutes>[0]> = {}): Promise<void> {
  const readArg = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const apiUrl = readArg('--api-url');
  const source = readArg('--source') ?? 'community';
  const out = readArg('--out') ?? 'spec/v2/observations';
  if (!apiUrl || !['community', 'maintainer'].includes(source) || !out || out.startsWith('--')) throw new ProbeError('Usage: --api-url <url> [--source maintainer|community] [--out <dir>]', 1);
  const { observation, file } = await probeRoutes({ ...overrides, apiUrl, source: source as 'community' | 'maintainer', out });
  const values = Object.values(observation.results);
  const absent = values.filter(value => value.result === 'absent').length;
  console.log(`observed ${observation.apiVersion}: ${values.length - absent} present, ${absent} absent of ${values.length} GET keys; wrote ${basename(file)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runProbeCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof ProbeError ? error.message : 'Probe failed');
    process.exitCode = error instanceof ProbeError ? error.exitCode : 1;
  }
}
