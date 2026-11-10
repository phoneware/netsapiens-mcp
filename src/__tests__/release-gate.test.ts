import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { runReleaseGate } from '../../scripts/release-gate.mjs';

const GATE_PATH = fileURLToPath(new URL('../../scripts/release-gate.mjs', import.meta.url));
const PACKAGE = 'netsapiens-mcp';
const VERSION = '3.0.1';
const TAG_REF = 'refs/tags/v3.0.1';
const REPO = 'phoneware/netsapiens-mcp';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const GH_TOKEN = 'ghp_TESTONLY_marker_4417';
const NPM_FAKE_TOKEN = 'release-gate-fake-npm-token';
const SENTINEL = 'release-gate-sentinel';
const CONTROL = 'release-gate-control';
const IN_TOTO = 'https://in-toto.io/Statement/v1';
const SLSA = 'https://slsa.dev/provenance/v1';
const DSSE = 'application/vnd.in-toto+json';

function sha(algorithm: string, bytes: Buffer): string {
  return createHash(algorithm).update(bytes).digest('hex');
}

const SHA512 = sha('sha512', Buffer.from('netsapiens-mcp fixture tarball'));
const INTEGRITY = `sha512-${Buffer.from(SHA512, 'hex').toString('base64')}`;

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

interface Seen {
  method: string;
  url: URL;
  auth?: string;
  body: string;
}

interface Reply {
  status: number;
  body?: unknown;
  raw?: string;
}

interface Fake {
  url: string;
  seen: Seen[];
}

/** The in-toto statement shape the readback check reads. */
interface Statement {
  _type: string;
  predicateType: string;
  subject: Array<{ name: string; digest: { sha512: string } }>;
  predicate: {
    buildDefinition: {
      externalParameters: { workflow: { ref: string; repository: string; path: string } };
      resolvedDependencies: Array<{ uri: string; digest: { gitCommit: string } }>;
    };
    runDetails: { builder: { id: string } };
  };
}

const tempDirs: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await closeServer(server);
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gate-'));
  tempDirs.push(dir);
  return dir;
}

function listen(server: http.Server): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => resolve());
  return promise;
}

function closeServer(server: http.Server): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  return promise;
}

function portOf(server: http.Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no TCP port');
  return address.port;
}

/** Loopback fake that records every request and answers from the handler. */
async function fakeServer(handle: (seen: Seen) => Reply): Promise<Fake> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const entry: Seen = {
        method: req.method ?? '',
        url: new URL(req.url ?? '/', 'http://127.0.0.1'),
        auth: req.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(entry);
      const reply = handle(entry);
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
    });
  });
  servers.push(server);
  await listen(server);
  return { url: `http://127.0.0.1:${portOf(server)}`, seen };
}

/** A loopback address with nothing listening on it. */
async function closedPortUrl(): Promise<string> {
  const server = http.createServer();
  await listen(server);
  const port = portOf(server);
  await closeServer(server);
  return `http://127.0.0.1:${port}`;
}

function gate(argv: string[], env: Record<string, string> = {}): Promise<Run> {
  return runReleaseGate(argv, { env });
}

function expectFailure(run: Run, pattern?: RegExp): void {
  expect(run.status).toBe(1);
  expect(run.stdout).toBe('');
  expect(run.stderr).toMatch(/^release-gate: /);
  if (pattern) expect(run.stderr).toMatch(pattern);
}

function execAsync(file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  execFile(file, args, options, error => (error ? reject(error) : resolve()));
  return promise;
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
  execFile(
    process.execPath,
    [GATE_PATH, ...args],
    { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' },
    (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout, stderr });
    },
  );
  return promise;
}

/* ---------- package.json fixtures ---------- */

function writePackage(fields: Record<string, unknown> = {}): string {
  const file = path.join(tempDir(), 'package.json');
  fs.writeFileSync(file, JSON.stringify({ name: PACKAGE, version: VERSION, ...fields }));
  return file;
}

/* ---------- tar fixtures ---------- */

interface TarEntry {
  name: string;
  type?: string;
  data?: string | Buffer;
  linkname?: string;
  magic?: string;
  signedChecksum?: boolean;
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width, '0');
}

/** Hand-built ustar header. Used only where system tar would normalise the hostile name away. */
function tarHeader(name: string, prefix: string, type: string, size: number, linkname = '', magic = 'ustar\u000000', signedChecksum = false): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(`${octal(type === '5' ? 0o755 : 0o644, 7)}\0`, 100, 8, 'latin1');
  h.write(`${octal(0, 7)}\0`, 108, 8, 'latin1');
  h.write(`${octal(0, 7)}\0`, 116, 8, 'latin1');
  h.write(`${octal(size, 11)}\0`, 124, 12, 'latin1');
  h.write(`${octal(0, 11)}\0`, 136, 12, 'latin1');
  h.fill(0x20, 148, 156);
  h.write(type, 156, 1, 'latin1');
  h.write(linkname, 157, 100, 'utf8');
  h.write(magic, 257, 8, 'latin1');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of h) sum += signedChecksum && byte > 127 ? byte - 256 : byte;
  h.write(`${octal(sum, 6)}\0 `, 148, 8, 'latin1');
  return h;
}

function padBlock(data: Buffer): Buffer {
  const rest = data.length % 512;
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rest)]);
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let digits = 1;
  while (String(body.length + digits).length !== digits) {
    digits = String(body.length + digits).length;
  }
  return Buffer.from(`${body.length + digits}${body}`);
}

function splitForUstar(name: string): { prefix: string; name: string } | undefined {
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] !== '/') continue;
    const prefix = name.slice(0, i);
    const base = name.slice(i + 1);
    if (base.length > 0 && Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(base) <= 100) {
      return { prefix, name: base };
    }
  }
  return undefined;
}

function tarBytes(entries: TarEntry[], { terminator = true } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const type = entry.type ?? '0';
    const data = Buffer.from(entry.data ?? '');
    let name = entry.name;
    let prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const split = splitForUstar(name);
      if (split) {
        name = split.name;
        prefix = split.prefix;
      } else {
        const record = paxRecord('path', name);
        parts.push(tarHeader('PaxHeaders/entry', '', 'x', record.length), padBlock(record));
        name = name.slice(0, 100);
      }
    }
    parts.push(tarHeader(name, prefix, type, data.length, entry.linkname ?? '', entry.magic, entry.signedChecksum), padBlock(data));
  }
  if (terminator) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function tarFile(raw: Buffer): string {
  const file = path.join(tempDir(), 'fixture.tgz');
  fs.writeFileSync(file, zlib.gzipSync(raw));
  return file;
}

function packageEntries(pkg: Record<string, unknown> = { name: PACKAGE, version: VERSION }): TarEntry[] {
  return [
    { name: 'package/', type: '5' },
    { name: 'package/package.json', data: JSON.stringify(pkg) },
    { name: 'package/build/index.js', data: 'export {};\n' },
    { name: 'package/README.md', data: '# fixture\n' },
  ];
}

/** Real system tar, for the well-formed fixtures. */
async function systemTarball(pkg: Record<string, unknown>): Promise<string> {
  const stage = tempDir();
  fs.mkdirSync(path.join(stage, 'package', 'build'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'package', 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(stage, 'package', 'build', 'index.js'), 'export {};\n');
  fs.writeFileSync(path.join(stage, 'package', 'README.md'), '# fixture\n');
  const out = path.join(tempDir(), `${String(pkg.name)}-${String(pkg.version)}.tgz`);
  await execAsync('tar', ['--format', 'ustar', '-czf', out, '-C', stage, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  return out;
}

function digests(file: string): { sha256: string; sha512: string } {
  const bytes = fs.readFileSync(file);
  return { sha256: sha('sha256', bytes), sha512: sha('sha512', bytes) };
}

function artifactArgs(file: string, overrides: Partial<{ version: string; sha256: string; sha512: string }> = {}) {
  const d = digests(file);
  return [
    'artifact',
    '--tarball', file,
    '--version', overrides.version ?? VERSION,
    '--sha256', overrides.sha256 ?? d.sha256,
    '--sha512', overrides.sha512 ?? d.sha512,
  ];
}

/* ---------- GitHub fake ---------- */

function checkRun(overrides: Record<string, unknown> = {}) {
  return { name: 'ci', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, ...overrides };
}

interface GitHubOptions {
  compare?: Reply;
  runs?: Reply;
}

function githubFake(options: GitHubOptions = {}): Promise<Fake> {
  return fakeServer(seen => {
    if (seen.auth !== `Bearer ${GH_TOKEN}`) return { status: 401, body: { message: 'Bad credentials' } };
    if (seen.url.pathname === `/repos/${REPO}/compare/main...${SHA}`) {
      return options.compare ?? { status: 200, body: { status: 'identical' } };
    }
    if (seen.url.pathname === `/repos/${REPO}/commits/${SHA}/check-runs`) {
      return (
        options.runs ?? {
          status: 200,
          body: { total_count: 2, check_runs: [checkRun(), checkRun({ name: 'lint', conclusion: 'failure' })] },
        }
      );
    }
    return { status: 404, body: { message: 'Not Found' } };
  });
}

const sourceArgs = (api: string, sha = SHA) => ['source', '--repo', REPO, '--sha', sha, '--api', api];
const GH_ENV = { GH_TOKEN };

/* ---------- registry fakes ---------- */

const doc = (overrides: Record<string, unknown> = {}) => ({
  name: PACKAGE,
  version: VERSION,
  dist: { integrity: INTEGRITY },
  ...overrides,
});

const registryArgs = (base: string, extra: string[] = []) => [
  'registry',
  '--name', PACKAGE,
  '--version', VERSION,
  '--sha512', SHA512,
  '--registry', base,
  ...extra,
];

function registryFake(reply: Reply): Promise<Fake> {
  return fakeServer(seen => (seen.url.pathname === `/${PACKAGE}/${VERSION}` ? reply : { status: 404, body: {} }));
}

function statementFor(version: string, sha512: string, mutate?: (statement: Statement) => void): Statement {
  const statement: Statement = {
    _type: IN_TOTO,
    predicateType: SLSA,
    subject: [{ name: `pkg:npm/${PACKAGE}@${version}`, digest: { sha512 } }],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            ref: `refs/tags/v${version}`,
            repository: `https://github.com/${REPO}`,
            path: '.github/workflows/release.yml',
          },
        },
        resolvedDependencies: [
          { uri: `git+https://github.com/${REPO}@refs/tags/v${version}`, digest: { gitCommit: SHA } },
        ],
      },
      runDetails: { builder: { id: 'https://github.com/actions/runner/github-hosted' } },
    },
  };
  mutate?.(statement);
  return statement;
}

function attestationBody(statement: Statement, payloadType = DSSE) {
  return {
    attestations: [
      {
        predicateType: SLSA,
        bundle: {
          dsseEnvelope: {
            payloadType,
            payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
            signatures: [],
          },
        },
      },
    ],
  };
}

interface ReadbackState {
  versions: Reply[];
  attestation: Reply;
  tags: Reply;
}

/** Registry for readback: version document, attestations and dist-tags. Version replies are consumed in order. */
function readbackFake(version: string, state: Partial<ReadbackState> = {}, statement?: Statement): Promise<Fake> {
  const full: ReadbackState = {
    versions: [{ status: 200, body: { name: PACKAGE, version, dist: { integrity: INTEGRITY } } }],
    attestation: { status: 200, body: attestationBody(statement ?? statementFor(version, SHA512)) },
    tags: { status: 200, body: { latest: version } },
    ...state,
  };
  let versionCalls = 0;
  return fakeServer(seen => {
    const pathname = seen.url.pathname;
    if (pathname === `/${PACKAGE}/${version}`) {
      const reply = full.versions[Math.min(versionCalls, full.versions.length - 1)];
      versionCalls += 1;
      return reply;
    }
    if (pathname === `/-/npm/v1/attestations/${PACKAGE}@${version}`) return full.attestation;
    if (pathname === `/-/package/${PACKAGE}/dist-tags`) return full.tags;
    return { status: 404, body: {} };
  });
}

const readbackArgs = (base: string, version = VERSION, extra: string[] = []) => [
  'readback',
  '--repo', REPO,
  '--name', PACKAGE,
  '--version', version,
  '--sha512', SHA512,
  '--sha', SHA,
  '--ref', `refs/tags/v${version}`,
  '--registry', base,
  ...extra,
];

/* ---------- npm sentinel ---------- */

const STRIPPED_ENV = /^(npm_|NPM_|GITHUB_|ACTIONS_|NODE_AUTH_TOKEN|NODE_OPTIONS)|_PROXY$/i;

function sentinelManifest(name: string): Record<string, unknown> {
  const marker = (event: string) =>
    `node -e "require('fs').writeFileSync(require('path').join(process.env.RELEASE_GATE_MARKER_DIR, '${event}'), '')"`;
  return {
    name,
    version: '0.0.1',
    description: 'release gate fixture',
    main: 'index.js',
    scripts: {
      prepublishOnly: marker('prepublishOnly'),
      prepack: marker('prepack'),
      publish: marker('publish'),
      postpublish: marker('postpublish'),
    },
  };
}

function npmEnv(registryUrl: string, home: string, markers: string): NodeJS.ProcessEnv {
  const port = new URL(registryUrl).port;
  const userconfig = path.join(home, 'npmrc');
  const globalconfig = path.join(home, 'globalrc');
  fs.writeFileSync(userconfig, `registry=${registryUrl}/\n//127.0.0.1:${port}/:_authToken=${NPM_FAKE_TOKEN}\n`);
  fs.writeFileSync(globalconfig, '');
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !STRIPPED_ENV.test(key)) env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    npm_config_userconfig: userconfig,
    npm_config_globalconfig: globalconfig,
    npm_config_cache: path.join(home, 'cache'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    RELEASE_GATE_MARKER_DIR: markers,
  };
}

function npmRegistry(): Promise<Fake> {
  return fakeServer(seen => {
    if (seen.method === 'PUT') return { status: 200, body: { ok: true } };
    if (seen.method === 'GET' && seen.url.pathname === '/-/whoami') {
      return { status: 200, body: { username: 'release-gate-fake' } };
    }
    return { status: 404, body: { error: 'not_found' } };
  });
}

/* ================================================================== */

describe('version', () => {
  it('resolves the tag version when package.json agrees', async () => {
    const run = await gate(['version', '--event', 'push', '--ref', TAG_REF, '--input', '', '--package', writePackage()]);
    expect(run).toEqual({ status: 0, stdout: 'version=3.0.1\n', stderr: '' });
  });

  it('resolves a dispatch input that matches package.json', async () => {
    const run = await gate([
      'version', '--event', 'workflow_dispatch', '--ref', 'refs/heads/main', '--input', VERSION, '--package', writePackage(),
    ]);
    expect(run).toEqual({ status: 0, stdout: 'version=3.0.1\n', stderr: '' });
  });

  it('fails when package.json disagrees with the tag', async () => {
    const run = await gate([
      'version', '--event', 'push', '--ref', TAG_REF, '--input', '', '--package', writePackage({ version: '3.0.0' }),
    ]);
    expectFailure(run, /does not match the release version/);
  });

  it.each(['refs/tags/v3.0', 'refs/tags/v3.0.1.4', 'refs/tags/v03.0.1', 'refs/tags/v3.0.1+build.7', 'refs/tags/3.0.1', 'refs/tags/vv3.0.1', 'refs/heads/main'])(
    'rejects a non-semver or non-tag ref %s',
    async ref => {
      const run = await gate(['version', '--event', 'push', '--ref', ref, '--input', '', '--package', writePackage()]);
      expectFailure(run);
    },
  );

  it('fails a dispatch with no input', async () => {
    const run = await gate([
      'version', '--event', 'workflow_dispatch', '--ref', 'refs/heads/main', '--input', '', '--package', writePackage(),
    ]);
    expectFailure(run, /dispatch version/);
  });

  it.each(['v3.0.1', '3.0', '3.0.1+build'])('rejects dispatch input %s', async input => {
    const run = await gate([
      'version', '--event', 'workflow_dispatch', '--ref', 'refs/heads/main', '--input', input, '--package', writePackage(),
    ]);
    expectFailure(run, /dispatch version/);
  });

  it('accepts a prerelease dispatch that matches package.json', async () => {
    const run = await gate([
      'version', '--event', 'workflow_dispatch', '--ref', 'refs/heads/main', '--input', '3.1.0-rc.1',
      '--package', writePackage({ version: '3.1.0-rc.1' }),
    ]);
    expect(run.stdout).toBe('version=3.1.0-rc.1\n');
  });

  it('fails when the package name is not netsapiens-mcp', async () => {
    const run = await gate(['version', '--event', 'push', '--ref', TAG_REF, '--input', '', '--package', writePackage({ name: 'other' })]);
    expectFailure(run, /netsapiens-mcp/);
  });

  it('fails on an unknown event', async () => {
    const run = await gate(['version', '--event', 'pull_request', '--ref', TAG_REF, '--input', '', '--package', writePackage()]);
    expectFailure(run, /event/);
  });

  it('fails on an unknown command and an unknown option', async () => {
    expectFailure(await gate(['publish']), /usage/);
    expectFailure(
      await gate(['version', '--event', 'push', '--ref', TAG_REF, '--input', '', '--package', writePackage(), '--publish', 'yes']),
      /unknown option/,
    );
    expectFailure(await gate(['version', '--event', 'push', '--event', 'push']), /more than once/);
  });
});

describe('source', () => {
  it('passes when the commit is identical to main and its ci check succeeded', async () => {
    const fake = await githubFake();
    const run = await gate(sourceArgs(fake.url), GH_ENV);
    expect(run).toEqual({ status: 0, stdout: `status=identical\nsha=${SHA}\n`, stderr: '' });
  });

  it('passes when the commit is behind main', async () => {
    const fake = await githubFake({ compare: { status: 200, body: { status: 'behind' } } });
    const run = await gate(sourceArgs(fake.url), GH_ENV);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('status=behind\n');
  });

  it.each(['ahead', 'diverged'])('fails when the compare status is %s', async status => {
    const fake = await githubFake({ compare: { status: 200, body: { status } } });
    expectFailure(await gate(sourceArgs(fake.url), GH_ENV), /not on main/);
  });

  it.each([
    { label: 'failure', status: 'completed', conclusion: 'failure' },
    { label: 'cancelled', status: 'completed', conclusion: 'cancelled' },
    { label: 'skipped', status: 'completed', conclusion: 'skipped' },
    { label: 'still running', status: 'in_progress', conclusion: null },
    { label: 'queued', status: 'queued', conclusion: null },
  ])('fails when the ci run is $label', async ({ status, conclusion }) => {
    const fake = await githubFake({
      runs: { status: 200, body: { check_runs: [checkRun({ status, conclusion })] } },
    });
    expectFailure(await gate(sourceArgs(fake.url), GH_ENV), /completed with success/);
  });

  it('fails when there is no ci check run', async () => {
    const fake = await githubFake({ runs: { status: 200, body: { check_runs: [checkRun({ name: 'lint' })] } } });
    expectFailure(await gate(sourceArgs(fake.url), GH_ENV), /no ci check run/);
  });

  it('fails when the ci check comes from another app', async () => {
    const fake = await githubFake({
      runs: { status: 200, body: { check_runs: [checkRun({ app: { slug: 'some-other-app' } })] } },
    });
    expectFailure(await gate(sourceArgs(fake.url), GH_ENV), /not from github-actions/);
  });

  it('fails when a ci check from another app sits beside a passing github-actions ci check', async () => {
    const fake = await githubFake({
      runs: {
        status: 200,
        body: { check_runs: [checkRun(), checkRun({ app: { slug: 'some-other-app' } })] },
      },
    });
    expectFailure(await gate(sourceArgs(fake.url), GH_ENV), /not from github-actions/);
  });

  it('fails on HTTP 403 from the compare endpoint', async () => {
    const fake = await githubFake({ compare: { status: 403, body: { message: 'forbidden' } } });
    expectFailure(await gate(sourceArgs(fake.url), GH_ENV), /HTTP 403/);
  });

  it('fails on HTTP 500 from the compare endpoint', async () => {
    const fake = await githubFake({ compare: { status: 500, body: {} } });
    expectFailure(await gate(sourceArgs(fake.url), GH_ENV), /unavailable \(HTTP 500\)/);
  });

  it('fails on HTTP 500 from the check-runs endpoint', async () => {
    const fake = await githubFake({ runs: { status: 500, body: {} } });
    expectFailure(await gate(sourceArgs(fake.url), GH_ENV), /unavailable \(HTTP 500\)/);
  });

  it('queries the latest ci check run by name', async () => {
    const fake = await githubFake();
    await gate(sourceArgs(fake.url), GH_ENV);
    const runs = fake.seen.find(entry => entry.url.pathname.endsWith('/check-runs'));
    expect(runs?.url.searchParams.get('check_name')).toBe('ci');
    expect(runs?.url.searchParams.get('filter')).toBe('latest');
  });

  it('fails without a token and makes no request', async () => {
    const fake = await githubFake();
    expectFailure(await gate(sourceArgs(fake.url), {}), /GH_TOKEN/);
    expect(fake.seen).toHaveLength(0);
  });

  it('fails on a malformed sha before any request', async () => {
    const fake = await githubFake();
    expectFailure(await gate(sourceArgs(fake.url, 'abc123'), GH_ENV), /sha/);
    expect(fake.seen).toHaveLength(0);
  });

  it('refuses a plain-http API that is not loopback', async () => {
    expectFailure(await gate(sourceArgs('http://api.example.com'), GH_ENV), /https/);
  });

  it('never prints the token, even on a failure', async () => {
    const fake = await githubFake({ compare: { status: 500, body: { leaked: GH_TOKEN } } });
    const run = await gate(sourceArgs(fake.url), GH_ENV);
    expectFailure(run);
    expect(run.stderr).not.toContain(GH_TOKEN);
    expect(run.stdout).not.toContain(GH_TOKEN);
  });

  it('fails closed on an unexpected error and discloses nothing of it', async () => {
    const hostileEnv: Record<string, string> = new Proxy<Record<string, string>>({}, {
      get() {
        throw new Error('LEAK-MARKER-42 secret material');
      },
    });
    const run = await runReleaseGate(sourceArgs('http://127.0.0.1:1'), { env: hostileEnv });
    expect(run).toEqual({ status: 1, stdout: '', stderr: 'release-gate: unexpected failure\n' });
  });
});

describe('artifact', () => {
  it('passes for a system-tar package and prints the verified digests', async () => {
    const file = await systemTarball({ name: PACKAGE, version: VERSION });
    const d = digests(file);
    const run = await gate(artifactArgs(file));
    expect(run).toEqual({ status: 0, stdout: `sha256=${d.sha256}\nsha512=${d.sha512}\n`, stderr: '' });
  });

  it('fails on a wrong sha256 digest', async () => {
    const file = await systemTarball({ name: PACKAGE, version: VERSION });
    expectFailure(await gate(artifactArgs(file, { sha256: '0'.repeat(64) })), /sha256 digest/);
  });

  it('fails on a wrong sha512 digest', async () => {
    const file = await systemTarball({ name: PACKAGE, version: VERSION });
    expectFailure(await gate(artifactArgs(file, { sha512: 'f'.repeat(128) })), /sha512 digest/);
  });

  it('fails on the wrong package name even when the digests match', async () => {
    const file = await systemTarball({ name: 'other-package', version: VERSION });
    expectFailure(await gate(artifactArgs(file)), /package name/);
  });

  it('fails on the wrong package version even when the digests match', async () => {
    const file = await systemTarball({ name: PACKAGE, version: '3.0.0' });
    expectFailure(await gate(artifactArgs(file)), /package version/);
  });

  it('fails on a duplicate package/package.json, even when both copies are valid', async () => {
    const file = tarFile(
      tarBytes([...packageEntries(), { name: 'package/package.json', data: JSON.stringify({ name: PACKAGE, version: VERSION }) }]),
    );
    expectFailure(await gate(artifactArgs(file)), /duplicate/);
  });

  it.each([
    ['package/../escape.txt', /unsafe path/],
    ['../escape.txt', /unsafe path/],
    ['/package/absolute.js', /unsafe path/],
    ['package/a\\b.js', /unsafe path/],
    ['package//double.js', /unsafe path/],
    ['other/outside.js', /outside package/],
  ])('fails on the hostile entry %s', async (name, pattern) => {
    const file = tarFile(tarBytes([...packageEntries(), { name, data: 'x' }]));
    expectFailure(await gate(artifactArgs(file)), pattern);
  });

  it('fails on a symlink entry', async () => {
    const file = tarFile(tarBytes([...packageEntries(), { name: 'package/link.js', type: '2', linkname: '/etc/passwd' }]));
    expectFailure(await gate(artifactArgs(file)), /unsupported entry type/);
  });

  it('fails on a hardlink entry', async () => {
    const file = tarFile(tarBytes([...packageEntries(), { name: 'package/hard.js', type: '1', linkname: 'package/build/index.js' }]));
    expectFailure(await gate(artifactArgs(file)), /unsupported entry type/);
  });

  it('fails when package/package.json is missing', async () => {
    const file = tarFile(tarBytes([{ name: 'package/build/index.js', data: 'export {};\n' }]));
    expectFailure(await gate(artifactArgs(file)), /exactly one package\/package.json/);
  });

  it('fails on a truncated archive', async () => {
    const big = tarBytes([
      { name: 'package/package.json', data: JSON.stringify({ name: PACKAGE, version: VERSION }) },
      { name: 'package/big.txt', data: 'x'.repeat(4000) },
    ]);
    expectFailure(await gate(artifactArgs(tarFile(big.subarray(0, 2000)))), /truncated/);
  });

  it('fails when the end-of-archive marker is missing', async () => {
    const file = tarFile(tarBytes(packageEntries(), { terminator: false }));
    expectFailure(await gate(artifactArgs(file)), /end-of-archive/);
  });

  it('fails on data after the end-of-archive marker', async () => {
    const file = tarFile(Buffer.concat([tarBytes(packageEntries()), Buffer.alloc(512, 0x41)]));
    expectFailure(await gate(artifactArgs(file)), /after its end-of-archive/);
  });

  it('fails when the file is not gzip', async () => {
    const file = path.join(tempDir(), 'not-a-tarball.tgz');
    fs.writeFileSync(file, 'this is not a tarball');
    expectFailure(await gate(artifactArgs(file)), /gzip/);
  });

  it('accepts long entry names carried by a ustar prefix and by a pax path', async () => {
    const prefixed = `package/${'d'.repeat(90)}/${'e'.repeat(60)}.js`;
    const paxed = `package/${'f'.repeat(120)}.js`;
    const file = tarFile(tarBytes([...packageEntries(), { name: prefixed, data: 'x' }, { name: paxed, data: 'y' }]));
    const run = await gate(artifactArgs(file));
    expect(run.status).toBe(0);
  });

  it('never prints a hostile entry name', async () => {
    const file = tarFile(tarBytes([...packageEntries(), { name: 'package/../HOSTILE-MARKER-9137.txt', data: 'x' }]));
    const run = await gate(artifactArgs(file));
    expectFailure(run);
    expect(run.stderr).not.toContain('HOSTILE-MARKER');
  });
});

function runEntry(entry: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
  execFile(
    process.execPath,
    [entry, ...args],
    { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' },
    (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout, stderr });
    },
  );
  return promise;
}

describe('tar hardening and manifest policy', () => {
  it('accepts an unsigned header checksum on a non-ASCII name', async () => {
    const file = tarFile(tarBytes([...packageEntries(), { name: 'package/é.js', data: 'x' }]));
    expect((await gate(artifactArgs(file))).status).toBe(0);
  });

  it('fails on a header checksum computed from signed bytes', async () => {
    const file = tarFile(tarBytes([...packageEntries(), { name: 'package/é.js', data: 'x', signedChecksum: true }]));
    expectFailure(await gate(artifactArgs(file)), /checksum is invalid/);
  });

  it.each([
    ['GNU spacing ustar  NUL', 'ustar  \u0000'],
    ['bare v7 header with no magic', '\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000'],
    ['version bytes that are not 00', 'ustar\u0000  '],
  ])('fails on a non-exact ustar magic (%s)', async (_label, magic) => {
    const file = tarFile(tarBytes([...packageEntries(), { name: 'package/x.js', data: 'x', magic }]));
    expectFailure(await gate(artifactArgs(file)), /not exact ustar/);
  });

  it.each([
    { label: 'regular file', type: '0', name: 'package/copy.js', data: 'x' },
    { label: 'directory', type: '5', name: 'package/copy/', data: '' },
  ])('fails when a $label header carries a link path', async ({ type, name, data }) => {
    const file = tarFile(tarBytes([...packageEntries(), { name, type, data, linkname: 'package/build/index.js' }]));
    expectFailure(await gate(artifactArgs(file)), /link path/);
  });

  it('fails when an extended header carries a header link path', async () => {
    const file = tarFile(tarBytes([
      ...packageEntries(),
      { name: 'PaxHeaders/l', type: 'x', data: paxRecord('size', '1'), linkname: 'package/build/index.js' },
      { name: 'package/tail.js', data: 'x' },
    ]));
    expectFailure(await gate(artifactArgs(file)), /link path/);
  });

  it('fails on a pax linkpath record', async () => {
    const file = tarFile(tarBytes([
      ...packageEntries(),
      { name: 'PaxHeaders/p', type: 'x', data: paxRecord('linkpath', 'package/build/index.js') },
      { name: 'package/tail.js', data: 'x' },
    ]));
    expectFailure(await gate(artifactArgs(file)), /link path/);
  });

  it('fails on a pax value with an embedded newline', async () => {
    const file = tarFile(tarBytes([
      ...packageEntries(),
      { name: 'PaxHeaders/n', type: 'x', data: paxRecord('path', 'package/a\nb.js') },
      { name: 'package/tail.js', data: 'x' },
    ]));
    expectFailure(await gate(artifactArgs(file)), /newline/);
  });

  it('accepts one GNU long-name header before an entry', async () => {
    const long = `package/${'l'.repeat(120)}.js`;
    const file = tarFile(tarBytes([
      ...packageEntries(),
      { name: '././@LongLink', type: 'L', data: `${long}\u0000` },
      { name: 'package/short.js', data: 'x' },
    ]));
    expect((await gate(artifactArgs(file))).status).toBe(0);
  });

  it('fails when two extended headers precede one entry', async () => {
    const file = tarFile(tarBytes([
      ...packageEntries(),
      { name: 'PaxHeaders/a', type: 'x', data: paxRecord('comment', 'one') },
      { name: 'PaxHeaders/b', type: 'x', data: paxRecord('comment', 'two') },
      { name: 'package/stacked.js', data: 'x' },
    ]));
    expectFailure(await gate(artifactArgs(file)), /more than one extended header/);
  });

  it('fails when a GNU long-name header is followed by a pax header before an entry', async () => {
    const file = tarFile(tarBytes([
      ...packageEntries(),
      { name: '././@LongLink', type: 'L', data: 'package/mixed.js\u0000' },
      { name: 'PaxHeaders/b', type: 'x', data: paxRecord('comment', 'two') },
      { name: 'package/mixed.js', data: 'x' },
    ]));
    expectFailure(await gate(artifactArgs(file)), /more than one extended header/);
  });

  it('fails on an extended header of exactly 1 MiB', async () => {
    const file = tarFile(tarBytes([
      ...packageEntries(),
      { name: 'PaxHeaders/huge', type: 'x', data: Buffer.alloc(1024 * 1024) },
      { name: 'package/tail.js', data: 'x' },
    ]));
    expectFailure(await gate(artifactArgs(file)), /too large/);
  });

  it('accepts an extended header of 1 MiB minus one byte', async () => {
    const record = paxRecord('comment', 'a'.repeat(1048558));
    expect(record.length).toBe(1048575);
    const file = tarFile(tarBytes([
      ...packageEntries(),
      { name: 'PaxHeaders/cap', type: 'x', data: record },
      { name: 'package/tail.js', data: 'x' },
    ]));
    expect((await gate(artifactArgs(file))).status).toBe(0);
  });

  it.each([
    ['package/a\u0001b.js'],
    ['package/tab\tfile.js'],
    ['package/esc\u001b.js'],
  ])('fails on a C0 control character in the entry name (%s)', async name => {
    const file = tarFile(tarBytes([...packageEntries(), { name, data: 'x' }]));
    expectFailure(await gate(artifactArgs(file)), /control character/);
  });

  it('fails on a C0 control character carried in a pax path', async () => {
    const file = tarFile(tarBytes([
      ...packageEntries(),
      { name: 'PaxHeaders/bell', type: 'x', data: paxRecord('path', 'package/bell\u0007.js') },
      { name: 'package/ignored.js', data: 'x' },
    ]));
    expectFailure(await gate(artifactArgs(file)), /control character/);
  });

  it('fails when the tarball manifest carries publishConfig', async () => {
    const file = await systemTarball({ name: PACKAGE, version: VERSION, publishConfig: { registry: 'https://registry.example.test' } });
    expectFailure(await gate(artifactArgs(file)), /publishConfig/);
  });

  it('fails when the source package.json carries publishConfig', async () => {
    const run = await gate(['version', '--event', 'push', '--ref', TAG_REF, '--input', '', '--package', writePackage({ publishConfig: { tag: 'latest' } })]);
    expectFailure(run, /publishConfig/);
  });

  it('accepts the tarball npm pack produces, including a long nested path', async () => {
    const dir = tempDir();
    const home = tempDir();
    const dest = tempDir();
    const longDir = path.join('build', 'n'.repeat(80));
    fs.mkdirSync(path.join(dir, longDir), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: PACKAGE, version: VERSION, files: ['build'] }));
    fs.writeFileSync(path.join(dir, 'build', 'index.js'), 'export {};\n');
    fs.writeFileSync(path.join(dir, longDir, `${'m'.repeat(60)}.js`), 'export {};\n');
    await execAsync('npm', ['pack', '--ignore-scripts', '--pack-destination', dest], {
      cwd: dir,
      env: npmEnv('http://127.0.0.1:9', home, tempDir()),
      timeout: 120_000,
    });
    const run = await gate(artifactArgs(path.join(dest, `${PACKAGE}-${VERSION}.tgz`)));
    expect(run.status).toBe(0);
  }, 150_000);

  it('runs the gate when invoked through a symlink to the script', async () => {
    const link = path.join(tempDir(), 'release-gate-link.mjs');
    fs.symlinkSync(GATE_PATH, link);
    const result = await runEntry(link, ['version', '--event', 'push', '--ref', TAG_REF, '--input', '', '--package', writePackage()]);
    expect(result).toEqual({ code: 0, stdout: 'version=3.0.1\n', stderr: '' });
  });

  it('fails closed through a symlink when the gate rejects its input', async () => {
    const link = path.join(tempDir(), 'release-gate-link.mjs');
    fs.symlinkSync(GATE_PATH, link);
    const result = await runEntry(link, ['version', '--event', 'push', '--ref', 'refs/tags/v3.0', '--input', '', '--package', writePackage()]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^release-gate: /);
  });
});

describe('registry', () => {
  it('prints action=publish when the version is absent', async () => {
    const fake = await registryFake({ status: 404, body: { error: 'Not found' } });
    const run = await gate(registryArgs(fake.url));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`action=publish\nintegrity=${INTEGRITY}\n`);
    expect(fake.seen[0]?.url.pathname).toBe(`/${PACKAGE}/${VERSION}`);
  });

  it('prints action=skip when the version exists with equal integrity', async () => {
    const fake = await registryFake({ status: 200, body: doc() });
    const run = await gate(registryArgs(fake.url));
    expect(run).toEqual({ status: 0, stdout: `action=skip\nintegrity=${INTEGRITY}\n`, stderr: '' });
  });

  it('fails when the version exists with different integrity', async () => {
    const fake = await registryFake({ status: 200, body: doc({ dist: { integrity: 'sha512-AAAA' } }) });
    expectFailure(await gate(registryArgs(fake.url)), /different content/);
  });

  it('fails on HTTP 500', async () => {
    const fake = await registryFake({ status: 500, body: {} });
    expectFailure(await gate(registryArgs(fake.url)), /unavailable \(HTTP 500\)/);
  });

  it('fails when the document describes a different version', async () => {
    const fake = await registryFake({ status: 200, body: doc({ version: '3.0.0' }) });
    expectFailure(await gate(registryArgs(fake.url)), /different version/);
  });

  it('fails with --expect publish when the version already exists', async () => {
    const fake = await registryFake({ status: 200, body: doc() });
    expectFailure(await gate(registryArgs(fake.url, ['--expect', 'publish'])), /publish was expected/);
  });

  it('passes with --expect publish when the version is absent', async () => {
    const fake = await registryFake({ status: 404, body: {} });
    const run = await gate(registryArgs(fake.url, ['--expect', 'publish']));
    expect(run.stdout).toContain('action=publish\n');
  });

  it('rejects any --expect value other than publish', async () => {
    const fake = await registryFake({ status: 404, body: {} });
    expectFailure(await gate(registryArgs(fake.url, ['--expect', 'skip'])), /only publish/);
  });

  it('fails on a network error', async () => {
    const base = await closedPortUrl();
    expectFailure(await gate(registryArgs(base)), /network request failed/);
  });

  it('refuses a plain-http registry that is not loopback', async () => {
    expectFailure(await gate(registryArgs('http://registry.example.com')), /https/);
  });

  it('fails on invalid JSON and never prints the body', async () => {
    const fake = await registryFake({ status: 200, raw: '{"HOSTILE-JSON-MARKER":' });
    const run = await gate(registryArgs(fake.url));
    expectFailure(run, /not valid JSON/);
    expect(run.stderr).not.toContain('HOSTILE-JSON-MARKER');
  });
});

describe('readback', () => {
  it('passes for a published version whose provenance matches this release', async () => {
    const fake = await readbackFake(VERSION);
    const run = await gate(readbackArgs(fake.url, VERSION, ['--timeout-seconds', '0']));
    expect(run).toEqual({ status: 0, stdout: `integrity=${INTEGRITY}\n`, stderr: '' });
  });

  it('passes when a 404 turns into a 200 within the timeout', async () => {
    const fake = await readbackFake(VERSION, {
      versions: [
        { status: 404, body: {} },
        { status: 200, body: { name: PACKAGE, version: VERSION, dist: { integrity: INTEGRITY } } },
      ],
    });
    const run = await gate(readbackArgs(fake.url, VERSION, ['--timeout-seconds', '10']));
    expect(run.status).toBe(0);
    expect(fake.seen.filter(entry => entry.url.pathname === `/${PACKAGE}/${VERSION}`)).toHaveLength(2);
  });

  it('fails when the version never appears before the timeout', async () => {
    const fake = await readbackFake(VERSION, { versions: [{ status: 404, body: {} }] });
    expectFailure(
      await gate(readbackArgs(fake.url, VERSION, ['--timeout-seconds', '0'])),
      /before the timeout \(registry version not visible yet/,
    );
  });

  it('does not retry a hard integrity mismatch', async () => {
    const fake = await readbackFake(VERSION, {
      versions: [{ status: 200, body: doc({ dist: { integrity: 'sha512-AAAA' } }) }],
    });
    const run = await gate(readbackArgs(fake.url, VERSION, ['--timeout-seconds', '10']));
    expectFailure(run, /integrity does not match/);
    expect(fake.seen.filter(entry => entry.url.pathname === `/${PACKAGE}/${VERSION}`)).toHaveLength(1);
  });

  it('rejects a --ref that is not the release tag for the version', async () => {
    const fake = await readbackFake(VERSION);
    const args = readbackArgs(fake.url, VERSION, ['--timeout-seconds', '0']).map(arg =>
      arg === TAG_REF ? 'refs/tags/v3.0.0' : arg,
    );
    expectFailure(await gate(args), /ref must be/);
  });

  it.each([
    {
      label: 'provenance ref differs from the tag',
      mutate: (s: Statement) => { s.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/tags/v3.0.0'; },
      pattern: /workflow identity/,
    },
    {
      label: 'resolved commit differs',
      mutate: (s: Statement) => { s.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'f'.repeat(40); },
      pattern: /resolved commit/,
    },
    {
      label: 'workflow path differs',
      mutate: (s: Statement) => { s.predicate.buildDefinition.externalParameters.workflow.path = '.github/workflows/ci.yml'; },
      pattern: /workflow identity/,
    },
    {
      label: 'repository differs',
      mutate: (s: Statement) => { s.predicate.buildDefinition.externalParameters.workflow.repository = 'https://github.com/other/repo'; },
      pattern: /workflow identity/,
    },
    {
      label: 'builder is self-hosted',
      mutate: (s: Statement) => { s.predicate.runDetails.builder.id = 'https://github.com/actions/runner/self-hosted'; },
      pattern: /GitHub-hosted/,
    },
    {
      label: 'subject sha512 differs',
      mutate: (s: Statement) => { s.subject[0].digest.sha512 = 'e'.repeat(128); },
      pattern: /subject/,
    },
    {
      label: 'two subjects',
      mutate: (s: Statement) => { s.subject.push({ name: 'extra', digest: { sha512: SHA512 } }); },
      pattern: /subject/,
    },
    {
      label: 'predicate is not SLSA v1',
      mutate: (s: Statement) => { s.predicateType = 'https://example.test/other'; },
      pattern: /SLSA v1/,
    },
  ])('fails when the $label', async ({ mutate, pattern }) => {
    const fake = await readbackFake(VERSION, {}, statementFor(VERSION, SHA512, mutate));
    expectFailure(await gate(readbackArgs(fake.url, VERSION, ['--timeout-seconds', '0'])), pattern);
  });

  it('fails on a DSSE envelope with the wrong payload type', async () => {
    const fake = await readbackFake(VERSION, {
      attestation: { status: 200, body: attestationBody(statementFor(VERSION, SHA512), 'text/plain') },
    });
    expectFailure(await gate(readbackArgs(fake.url, VERSION, ['--timeout-seconds', '0'])), /envelope/);
  });

  it('fails when provenance is missing, both as a 404 and as an empty list', async () => {
    const missing404 = await readbackFake(VERSION, { attestation: { status: 404, body: {} } });
    expectFailure(
      await gate(readbackArgs(missing404.url, VERSION, ['--timeout-seconds', '0'])),
      /provenance not visible yet/,
    );
    const emptyList = await readbackFake(VERSION, { attestation: { status: 200, body: { attestations: [] } } });
    expectFailure(
      await gate(readbackArgs(emptyList.url, VERSION, ['--timeout-seconds', '0'])),
      /provenance not visible yet/,
    );
  });

  it('fails when latest does not point at a stable version', async () => {
    const fake = await readbackFake(VERSION, { tags: { status: 200, body: { latest: '3.0.0' } } });
    expectFailure(await gate(readbackArgs(fake.url, VERSION, ['--timeout-seconds', '0'])), /latest does not point/);
  });

  it('does not check latest for a prerelease', async () => {
    const version = '3.1.0-rc.1';
    const fake = await readbackFake(version, { tags: { status: 200, body: { latest: '3.0.1' } } });
    const run = await gate(readbackArgs(fake.url, version, ['--timeout-seconds', '0']));
    expect(run.status).toBe(0);
  });

  it('never prints a hostile response body', async () => {
    const fake = await readbackFake(VERSION, { attestation: { status: 200, raw: '{"HOSTILE-READBACK-MARKER":' } });
    const run = await gate(readbackArgs(fake.url, VERSION, ['--timeout-seconds', '0']));
    expectFailure(run);
    expect(run.stderr).not.toContain('HOSTILE-READBACK-MARKER');
  });
});

describe('CLI process', () => {
  it('prints key=value lines and exits 0 on success', async () => {
    const result = await runCli(['version', '--event', 'push', '--ref', TAG_REF, '--input', '', '--package', writePackage()]);
    expect(result).toEqual({ code: 0, stdout: 'version=3.0.1\n', stderr: '' });
  });

  it('exits 1 with a single diagnostic line and no stdout on failure', async () => {
    const result = await runCli(['version', '--event', 'push', '--ref', 'refs/tags/v3.0', '--input', '', '--package', writePackage()]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^release-gate: [^\n]+\n$/);
  });
});

describe('npm publish with --ignore-scripts', () => {
  it('uploads the sentinel tarball bytes unchanged and runs no lifecycle script', async () => {
    const registry = await npmRegistry();
    const home = tempDir();
    const markers = tempDir();
    const stage = tempDir();
    fs.mkdirSync(path.join(stage, 'package'));
    fs.writeFileSync(path.join(stage, 'package', 'package.json'), JSON.stringify(sentinelManifest(SENTINEL)));
    fs.writeFileSync(path.join(stage, 'package', 'index.js'), 'module.exports = {};\n');
    const tgz = path.join(tempDir(), `${SENTINEL}-0.0.1.tgz`);
    await execAsync('tar', ['--format', 'ustar', '-czf', tgz, '-C', stage, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });

    await execAsync('npm', ['publish', tgz, '--ignore-scripts', '--access', 'public'], {
      cwd: home,
      env: npmEnv(registry.url, home, markers),
      timeout: 120_000,
    });

    const puts = registry.seen.filter(entry => entry.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0]?.url.pathname).toBe(`/${SENTINEL}`);
    expect(puts[0]?.auth).toBe(`Bearer ${NPM_FAKE_TOKEN}`);
    const body: { _attachments?: Record<string, { data: string }> } = JSON.parse(puts[0]?.body ?? '{}');
    const attachments = Object.values(body._attachments ?? {});
    expect(attachments).toHaveLength(1);
    expect(Buffer.from(attachments[0]?.data ?? '', 'base64').equals(fs.readFileSync(tgz))).toBe(true);
    expect(fs.readdirSync(markers)).toEqual([]);
  }, 150_000);

  it('control: publishing the same manifest from a directory without --ignore-scripts writes the markers', async () => {
    const registry = await npmRegistry();
    const home = tempDir();
    const markers = tempDir();
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(sentinelManifest(CONTROL)));
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};\n');

    await execAsync('npm', ['publish', dir, '--access', 'public'], {
      cwd: home,
      env: npmEnv(registry.url, home, markers),
      timeout: 120_000,
    });

    expect(registry.seen.some(entry => entry.method === 'PUT' && entry.url.pathname === `/${CONTROL}`)).toBe(true);
    expect(fs.readdirSync(markers)).toEqual(expect.arrayContaining(['prepublishOnly', 'prepack']));
  }, 150_000);
});
