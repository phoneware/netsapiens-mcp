import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProbeError, probeRoutes, runProbeCli } from '../../scripts/probe-routes.js';

const branches = new Map([['44.4', new Set(['GET /a', 'GET /domains/{}/users', 'GET /missing', 'GET /version'])]]);
const wait = async (_ms: number) => {};
let server: Server | undefined;
let dir: string | undefined;
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  if (dir) await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('route probe', () => {
  it('writes a hostname-free observation from a local fake server', async () => {
    const paths: string[] = [];
    server = createServer((req, res) => {
      paths.push(req.url!);
      if (req.url === '/ns-api/v2/version') { res.writeHead(200); res.end(JSON.stringify({ apiversion: '44.4.10' })); }
      else if (req.url!.includes('zz-route-probe-control-') || req.url === '/ns-api/v2/missing') { res.writeHead(404); res.end('No Route Found'); }
      else { res.writeHead(400); res.end('missing token'); }
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    dir = await mkdtemp(join(tmpdir(), 'nsmcp-observation-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runProbeCli(['--api-url', `http://127.0.0.1:${address.port}`, '--out', dir], { branches, wait });
    const file = await readFile(join(dir, '44.4.10.json'), 'utf8');
    expect(file).not.toContain('127.0.0.1');
    expect(log.mock.calls.flat().join(' ')).not.toContain('127.0.0.1');
    expect(log.mock.calls.flat().join(' ')).not.toContain(dir);
    expect(log.mock.calls.flat().join(' ')).toContain('wrote 44.4.10.json');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('3 present, 1 absent of 4 GET keys'));
    expect(paths).toContain('/ns-api/v2/domains/probe/users');
    const result = JSON.parse(file);
    expect(result.source).toBe('community');
    expect(result.results['GET /missing']).toEqual({ status: 404, result: 'absent' });
  });
  it('refuses a control route that does not prove the signature', async () => {
    const request = async (path: string) => path.endsWith('/version') ? { status: 200, body: '{"apiversion":"44.4.10"}' } : { status: 404, body: 'blocked' };
    await expect(probeRoutes({ apiUrl: 'https://example.invalid', source: 'community', out: '.', branches, wait, request })).rejects.toMatchObject({ exitCode: 2 });
  });
  it.each([301, 403, 429, 500])('retries status %i on the same key and spaces every request', async status => {
    dir = await mkdtemp(join(tmpdir(), 'nsmcp-retry-'));
    const events: string[] = [];
    let versionRead = false;
    let retries = 0;
    const request = async (path: string) => {
      events.push(`request:${path}`);
      if (!versionRead) { versionRead = true; return { status: 200, body: '{"apiversion":"44.4.10"}' }; }
      if (path.includes('zz-route-probe-control-')) return { status: 404, body: 'No Route Found' };
      if (path === '/ns-api/v2/a' && retries++ === 0) return { status, body: '' };
      return { status: 400, body: 'missing token' };
    };
    const recordWait = async (ms: number) => { events.push(`wait:${ms}`); };
    const { observation } = await probeRoutes({ apiUrl: 'https://example.invalid', source: 'community', out: dir, branches, wait: recordWait, request });
    expect(observation.results['GET /a']).toEqual({ status: 400, result: 'present' });
    expect(events.filter(event => event === 'request:/ns-api/v2/a')).toHaveLength(2);
    expect(events[0]).toBe('request:/ns-api/v2/version');
    for (let index = 1; index < events.length; index += 2) {
      expect(events[index]).toBe('wait:500');
      expect(events[index + 1]).toMatch(/^request:/);
    }
    expect(events.length).toBe(1 + 2 * (1 + branches.get('44.4')!.size + 1));
  });
  it.each([403, 429, 500])('stops after three consecutive %s responses', async status => {
    const request = async (path: string) => path.endsWith('/version') ? { status: 200, body: '{"apiversion":"44.4.10"}' } : path.includes('zz-route-probe-control-') ? { status: 404, body: 'No Route Found' } : { status, body: '' };
    await expect(probeRoutes({ apiUrl: 'https://example.invalid', source: 'community', out: '.', branches, wait, request })).rejects.toMatchObject({ exitCode: 3 });
  });
  it('stops after three consecutive connection failures', async () => {
    let failures = 0;
    const request = async (path: string) => {
      if (path.endsWith('/version')) return { status: 200, body: '{"apiversion":"44.4.10"}' };
      if (path.includes('zz-route-probe-control-')) return { status: 404, body: 'No Route Found' };
      failures++; throw new Error('connection reset');
    };
    await expect(probeRoutes({ apiUrl: 'https://example.invalid', source: 'community', out: '.', branches, wait, request })).rejects.toBeInstanceOf(ProbeError);
    expect(failures).toBe(3);
  });
});
