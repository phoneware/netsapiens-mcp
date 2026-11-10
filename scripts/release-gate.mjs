#!/usr/bin/env node
/**
 * Release gate for netsapiens-mcp, called from .github/workflows/release.yml.
 *
 * Each command prints key=value lines for GITHUB_OUTPUT on success. Any
 * failure, including a network error, prints one fixed diagnostic to stderr
 * and exits 1. Diagnostics never echo tokens, response bodies, tarball entry
 * names or any other remote or attacker-controlled content.
 *
 * Node built-ins only: the publish job runs this file and nothing else from
 * the repository.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

export const PACKAGE_NAME = 'netsapiens-mcp';
export const DEFAULT_GITHUB_API = 'https://api.github.com';
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
export const WORKFLOW_PATH = '.github/workflows/release.yml';

const USER_AGENT = 'netsapiens-mcp-release-gate';
const IN_TOTO_STATEMENT = 'https://in-toto.io/Statement/v1';
const SLSA_PROVENANCE = 'https://slsa.dev/provenance/v1';
const DSSE_PAYLOAD_TYPE = 'application/vnd.in-toto+json';
const BLOCK = 512;
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 3_600;
const MAX_EXTENDED_HEADER_BYTES = 1024 * 1024 - 1;
const USTAR_MAGIC = 'ustar\u000000';
const ACCEPTED_TYPES = new Set(['0', '5', 'x', 'L']);
const C0_CONTROL = /[\u0000-\u001f]/;

// Official SemVer 2.0 grammar without build metadata. Build metadata is refused
// because npm version strings and dist-tags do not round-trip it reliably.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA512_HEX = /^[0-9a-f]{128}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const UTF8 = new TextDecoder('utf-8', { fatal: true });

const VERSION_FLAGS = ['event', 'ref', 'input', 'package'];
const SOURCE_FLAGS = ['repo', 'sha', 'api'];
const ARTIFACT_FLAGS = ['tarball', 'version', 'sha256', 'sha512'];
const REGISTRY_FLAGS = ['name', 'version', 'sha512', 'registry', 'expect'];
const READBACK_FLAGS = ['repo', 'name', 'version', 'sha512', 'sha', 'ref', 'registry', 'timeout-seconds'];

/** A failure with a fixed, safe message. */
export class GateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GateError';
  }
}

/** The registry or API has not answered usefully yet. Readback retries these; other commands fail. */
export class Unavailable extends GateError {}

const fail = message => new GateError(message);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function errorSuffix(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return ' (timeout)';
  const code = err?.cause?.code ?? err?.code;
  return typeof code === 'string' && ERROR_CODE.test(code) ? ` (${code})` : '';
}

function requireSemver(value, label) {
  if (typeof value !== 'string' || !SEMVER.test(value)) {
    throw fail(`${label} must be a semantic version without build metadata`);
  }
  return value;
}

function requireHex(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw fail(`${label} must be lowercase hex of the expected length`);
  }
  return value;
}

function requireRepo(value) {
  if (typeof value !== 'string' || !REPO.test(value) || value.split('/').some(part => part === '.' || part === '..')) {
    throw fail('repo must be owner/name');
  }
  return value;
}

function requirePackageName(value) {
  if (value !== PACKAGE_NAME) throw fail(`package name must be ${PACKAGE_NAME}`);
  return value;
}

function integrityOf(sha512Hex) {
  return `sha512-${Buffer.from(sha512Hex, 'hex').toString('base64')}`;
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha512Hex(bytes) {
  return createHash('sha512').update(bytes).digest('hex');
}

/** Accepts https, or plain http only for loopback fakes used by the test suite. */
export function endpoint(base, label) {
  let url;
  try {
    url = new URL(base);
  } catch {
    throw fail(`${label} is not a valid URL`);
  }
  const plainLoopback = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !plainLoopback) throw fail(`${label} must use https`);
  if (url.username || url.password || url.search || url.hash) {
    throw fail(`${label} must not carry credentials, a query or a fragment`);
  }
  return url.href.replace(/\/+$/, '');
}

function parseOptions(args, allowed, required) {
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (typeof flag !== 'string' || !flag.startsWith('--')) throw fail('unexpected argument');
    const key = flag.slice(2);
    if (!allowed.includes(key)) throw fail('unknown option');
    if (values.has(key)) throw fail('option given more than once');
    if (i + 1 >= args.length) throw fail('option is missing its value');
    values.set(key, args[i + 1]);
  }
  for (const key of required) {
    if (!values.has(key)) throw fail(`option --${key} is required`);
  }
  return Object.fromEntries(values);
}

function timeoutFrom(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_SECONDS;
  if (!/^\d{1,4}$/.test(value)) throw fail('timeout must be a whole number of seconds');
  return Number(value);
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw fail(`${label} is not valid JSON`);
  }
}

function readPackageJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw fail('package.json cannot be read');
  }
  const parsed = parseJson(text, 'package.json');
  if (!isObject(parsed)) throw fail('package.json is not a JSON object');
  return parsed;
}

/** Derives the release version from the event and checks package.json agrees. */
export function resolveVersion({ event, ref, input, packagePath }) {
  let version;
  if (event === 'push') {
    const prefix = 'refs/tags/v';
    if (typeof ref !== 'string' || !ref.startsWith(prefix)) {
      throw fail('a tag push must come from refs/tags/v<semver>');
    }
    version = requireSemver(ref.slice(prefix.length), 'tag version');
  } else if (event === 'workflow_dispatch') {
    version = requireSemver(input, 'dispatch version');
  } else {
    throw fail('event must be a tag push or workflow_dispatch');
  }
  const pkg = readPackageJson(packagePath);
  if (pkg.name !== PACKAGE_NAME) throw fail(`package.json name must be ${PACKAGE_NAME}`);
  requireNoPublishConfig(pkg);
  if (pkg.version !== version) throw fail('package.json version does not match the release version');
  return version;
}

/* ---------- HTTP helpers ---------- */

async function request(url, options = {}) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new Unavailable(`network request failed${errorSuffix(err)}`);
  }
}

async function discard(res) {
  try {
    await res.arrayBuffer();
  } catch {
    // The body is already gone; nothing to release.
  }
}

async function readJson(res, label) {
  let bytes;
  try {
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw new Unavailable(`${label} response could not be read${errorSuffix(err)}`);
  }
  if (bytes.length > MAX_JSON_BYTES) throw fail(`${label} response is too large`);
  return parseJson(bytes.toString('utf8'), `${label} response`);
}

function httpFailure(status, label) {
  return status === 429 || status >= 500
    ? new Unavailable(`${label} is unavailable (HTTP ${status})`)
    : fail(`${label} request failed (HTTP ${status})`);
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': USER_AGENT,
  };
}

function requireToken(token) {
  if (typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token)) {
    throw fail('GH_TOKEN is missing or malformed');
  }
  return token;
}

async function githubJson(base, route, token, label) {
  const res = await request(`${base}${route}`, { headers: githubHeaders(token), redirect: 'error' });
  if (!res.ok) {
    await discard(res);
    throw httpFailure(res.status, label);
  }
  return readJson(res, label);
}

/* ---------- source: the tagged commit is on main and its ci check passed ---------- */

export async function checkSource({ repo, sha, api = DEFAULT_GITHUB_API, token }) {
  requireRepo(repo);
  requireHex(sha, COMMIT_SHA, 'sha');
  const base = endpoint(api, 'GitHub API URL');
  requireToken(token);

  const compare = await githubJson(base, `/repos/${repo}/compare/main...${sha}`, token, 'GitHub compare');
  if (compare?.status !== 'identical' && compare?.status !== 'behind') {
    throw fail('commit is not on main');
  }

  const route = `/repos/${repo}/commits/${sha}/check-runs?check_name=ci&filter=latest&per_page=100`;
  const runs = await githubJson(base, route, token, 'GitHub check runs');
  if (!Array.isArray(runs?.check_runs)) throw fail('GitHub check runs response is malformed');
  const ciRuns = runs.check_runs.filter(run => isObject(run) && run.name === 'ci');
  if (ciRuns.length === 0) throw fail('no ci check run on the commit');
  for (const run of ciRuns) {
    if (run.app?.slug !== 'github-actions') throw fail('ci check run is not from github-actions');
    if (run.status !== 'completed' || run.conclusion !== 'success') {
      throw fail('ci check run is not completed with success');
    }
  }
  return { status: compare.status };
}

/* ---------- artifact: the frozen tarball matches its digests and is one safe package ---------- */

export function checkTarball({ tarball, version, sha256, sha512 }) {
  requireSemver(version, 'version');
  requireHex(sha256, SHA256_HEX, 'sha256');
  requireHex(sha512, SHA512_HEX, 'sha512');
  const bytes = readRegularFile(tarball);
  if (sha256Hex(bytes) !== sha256) throw fail('sha256 digest does not match the tarball');
  if (sha512Hex(bytes) !== sha512) throw fail('sha512 digest does not match the tarball');
  const pkg = packageJsonFromTarball(bytes);
  if (pkg.name !== PACKAGE_NAME) throw fail('tarball package name is not netsapiens-mcp');
  if (pkg.version !== version) throw fail('tarball package version does not match the release version');
  return { sha256, sha512 };
}

function readRegularFile(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw fail('tarball cannot be read');
  }
  if (!stat.isFile() || stat.size > MAX_TARBALL_BYTES) {
    throw fail('tarball is not a regular file of acceptable size');
  }
  try {
    return fs.readFileSync(file);
  } catch {
    throw fail('tarball cannot be read');
  }
}

/** Returns the parsed package/package.json of a gzipped npm tarball after structural checks. */
export function packageJsonFromTarball(gzipped) {
  const entries = readTarEntries(gzipped);
  checkEntries(entries);
  const matches = entries.filter(entry => entry.name === 'package/package.json');
  if (matches.length !== 1 || matches[0].isDir) {
    throw fail('tarball must contain exactly one package/package.json file');
  }
  let text;
  try {
    text = UTF8.decode(matches[0].data);
  } catch {
    throw fail('package/package.json is not valid UTF-8');
  }
  const pkg = parseJson(text, 'package/package.json');
  if (!isObject(pkg)) throw fail('package/package.json is not a JSON object');
  requireNoPublishConfig(pkg);
  return pkg;
}

function readTarEntries(gzipped) {
  let tar;
  try {
    tar = zlib.gunzipSync(gzipped, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch {
    throw fail('tarball is not a readable gzip stream or exceeds the size limit');
  }
  const entries = [];
  let offset = 0;
  let pax = {};
  let longName;
  let extendedSeen = false;
  let ended = false;
  while (offset < tar.length) {
    if (tar.length - offset < BLOCK) throw fail('tarball is truncated');
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every(byte => byte === 0)) {
      if (tar.subarray(offset).some(byte => byte !== 0)) {
        throw fail('tarball has data after its end-of-archive marker');
      }
      ended = true;
      break;
    }
    verifyChecksum(header);
    requireUstarMagic(header);
    const typeflag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    if (!ACCEPTED_TYPES.has(typeflag)) throw fail('tarball contains an unsupported entry type');
    if (!isZeroField(header, 157, 100)) throw fail('tarball entry has a link path');
    const size = numericField(header, 124, 12);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw fail('tarball is truncated');
    const data = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === 'x' || typeflag === 'L') {
      if (extendedSeen) throw fail('tarball has more than one extended header before an entry');
      if (size > MAX_EXTENDED_HEADER_BYTES) throw fail('tarball extended header is too large');
      extendedSeen = true;
      if (typeflag === 'x') pax = parsePax(data);
      else longName = decodeName(cBytes(data));
      continue;
    }
    if (pax.size !== undefined && pax.size !== size) throw fail('tarball size headers disagree');
    const isDir = typeflag === '5';
    if (isDir && size !== 0) throw fail('tarball directory entry has content');
    const rawName = pax.path ?? longName ?? ustarName(header);
    entries.push({ name: entryName(rawName, isDir), isDir, data });
    pax = {};
    longName = undefined;
    extendedSeen = false;
  }
  if (!ended) throw fail('tarball has no end-of-archive marker');
  if (extendedSeen) throw fail('tarball ends with a dangling extended header');
  return entries;
}

function verifyChecksum(header) {
  const stored = numericField(header, 148, 8);
  let unsigned = 0;
  for (let i = 0; i < BLOCK; i++) {
    unsigned += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  if (stored !== unsigned) throw fail('tarball header checksum is invalid');
}

function numericField(buf, offset, length) {
  const field = buf.subarray(offset, offset + length);
  if (field[0] & 0x80) throw fail('tarball uses an unsupported numeric encoding');
  const text = field.toString('latin1').split('\0')[0].trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw fail('tarball header has an invalid numeric field');
  return parseInt(text, 8);
}

function cBytes(buf) {
  const end = buf.indexOf(0);
  return end === -1 ? buf : buf.subarray(0, end);
}

function decodeName(bytes) {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw fail('tarball entry name is not valid UTF-8');
  }
}

function ustarName(header) {
  const name = decodeName(cBytes(header.subarray(0, 100)));
  const prefix = decodeName(cBytes(header.subarray(345, 500)));
  return prefix === '' ? name : `${prefix}/${name}`;
}

function requireUstarMagic(header) {
  if (header.toString('latin1', 257, 265) !== USTAR_MAGIC) throw fail('tarball header is not exact ustar');
}

function isZeroField(buf, offset, length) {
  return buf.subarray(offset, offset + length).every(byte => byte === 0);
}

function requireNoPublishConfig(pkg) {
  if (Object.hasOwn(pkg, 'publishConfig')) throw fail('package manifest must not carry publishConfig');
}

function parsePax(data) {
  const out = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) throw fail('tarball extended header is malformed');
    const lengthText = data.toString('latin1', pos, space);
    if (!/^\d+$/.test(lengthText)) throw fail('tarball extended header is malformed');
    const length = Number(lengthText);
    if (length <= space - pos + 1 || pos + length > data.length || data[pos + length - 1] !== 0x0a) {
      throw fail('tarball extended header is malformed');
    }
    const record = decodeName(data.subarray(space + 1, pos + length - 1));
    if (record.includes('\n')) throw fail('tarball extended header value has a newline');
    const eq = record.indexOf('=');
    if (eq === -1) throw fail('tarball extended header is malformed');
    const key = record.slice(0, eq);
    const value = record.slice(eq + 1);
    if (key === 'linkpath') throw fail('tarball extended header has a link path');
    if (key === 'path') out.path = value;
    if (key === 'size') {
      if (!/^\d+$/.test(value)) throw fail('tarball extended header is malformed');
      out.size = Number(value);
    }
    pos += length;
  }
  return out;
}

function entryName(raw, isDir) {
  if (C0_CONTROL.test(raw)) throw fail('tarball entry name has a control character');
  if (typeof raw !== 'string' || raw === '' || raw.startsWith('/') || raw.includes('\\') || /^[A-Za-z]:/.test(raw)) {
    throw fail('tarball entry has an unsafe path');
  }
  let name = raw;
  if (name.endsWith('/')) {
    if (!isDir) throw fail('tarball file entry has a trailing slash');
    name = name.slice(0, -1);
  }
  const segments = name.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw fail('tarball entry has an unsafe path');
  }
  if (segments[0] !== 'package') throw fail('tarball entry is outside package/');
  if (!isDir && segments.length < 2) throw fail('tarball file must be inside package/');
  return name;
}

function checkEntries(entries) {
  const names = new Set();
  const files = new Set();
  for (const entry of entries) {
    if (names.has(entry.name)) throw fail('tarball has duplicate entries');
    names.add(entry.name);
    if (!entry.isDir) files.add(entry.name);
  }
  for (const name of names) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (files.has(parts.slice(0, i).join('/'))) throw fail('tarball has an entry beneath a file path');
    }
  }
}

/* ---------- publish-time state: is this exact version already on the registry? ---------- */

function versionUrl(base, name, version) {
  return `${base}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
}

export async function checkRegistry({ name, version, sha512, registry = DEFAULT_REGISTRY, expect }) {
  requirePackageName(name);
  requireSemver(version, 'version');
  requireHex(sha512, SHA512_HEX, 'sha512');
  if (expect !== undefined && expect !== 'publish') throw fail('--expect accepts only publish');
  const base = endpoint(registry, 'registry URL');
  const integrity = integrityOf(sha512);
  const res = await request(versionUrl(base, name, version), { headers: { Accept: 'application/json' } });

  let action;
  if (res.status === 404) {
    await discard(res);
    action = 'publish';
  } else if (res.ok) {
    const doc = await readJson(res, 'registry');
    if (!isObject(doc) || doc.name !== name || doc.version !== version) {
      throw fail('registry document is for a different version');
    }
    if (doc.dist?.integrity !== integrity) throw fail('registry already has this version with different content');
    action = 'skip';
  } else {
    await discard(res);
    throw httpFailure(res.status, 'registry');
  }
  if (expect === 'publish' && action !== 'publish') {
    throw fail('registry already has this version; a publish was expected');
  }
  return { action, integrity };
}

/* ---------- readback: the published version matches, with SLSA provenance from this release ---------- */

export async function checkReadback({
  repo,
  name,
  version,
  sha512,
  sha,
  ref,
  registry = DEFAULT_REGISTRY,
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
}) {
  requireRepo(repo);
  requirePackageName(name);
  requireSemver(version, 'version');
  requireHex(sha512, SHA512_HEX, 'sha512');
  requireHex(sha, COMMIT_SHA, 'sha');
  if (ref !== `refs/tags/v${version}`) throw fail('ref must be the release tag refs/tags/v<version>');
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw fail(`timeout must be 0 to ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  const context = {
    base: endpoint(registry, 'registry URL'),
    repo,
    name,
    version,
    sha512,
    sha,
    ref,
    integrity: integrityOf(sha512),
  };
  const deadline = Date.now() + timeoutSeconds * 1000;
  let waitingFor = 'no attempt completed';
  for (;;) {
    try {
      return await readbackOnce(context);
    } catch (err) {
      if (!(err instanceof Unavailable)) throw err;
      waitingFor = err.message;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw fail(`readback did not succeed before the timeout (${waitingFor})`);
    await delay(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

async function fetchRegistryJson(url, label) {
  const res = await request(url, { headers: { Accept: 'application/json' } });
  if (res.status === 404 || res.status === 429 || res.status >= 500) {
    await discard(res);
    throw new Unavailable(`${label} not visible yet (HTTP ${res.status})`);
  }
  if (!res.ok) {
    await discard(res);
    throw fail(`${label} request failed (HTTP ${res.status})`);
  }
  return readJson(res, label);
}

async function readbackOnce(c) {
  const doc = await fetchRegistryJson(versionUrl(c.base, c.name, c.version), 'registry version');
  if (!isObject(doc) || doc.name !== c.name || doc.version !== c.version) {
    throw fail('registry version document is for a different package version');
  }
  if (doc.dist?.integrity !== c.integrity) throw fail('registry integrity does not match the tarball');

  const attestationUrl = `${c.base}/-/npm/v1/attestations/${encodeURIComponent(c.name)}@${encodeURIComponent(c.version)}`;
  const attestations = await fetchRegistryJson(attestationUrl, 'provenance');
  const entry = Array.isArray(attestations?.attestations)
    ? attestations.attestations.find(item => isObject(item) && item.predicateType === SLSA_PROVENANCE)
    : undefined;
  if (!entry) throw new Unavailable('provenance not visible yet');
  verifyStatement(decodeStatement(entry), c);

  if (!c.version.includes('-')) {
    const tags = await fetchRegistryJson(`${c.base}/-/package/${encodeURIComponent(c.name)}/dist-tags`, 'dist-tags');
    if (tags?.latest !== c.version) throw new Unavailable('latest does not point at this version yet');
  }
  return { integrity: c.integrity };
}

function decodeStatement(entry) {
  const envelope = entry.bundle?.dsseEnvelope;
  if (!isObject(envelope) || envelope.payloadType !== DSSE_PAYLOAD_TYPE || typeof envelope.payload !== 'string') {
    throw fail('provenance envelope has an unexpected shape');
  }
  return parseJson(Buffer.from(envelope.payload, 'base64').toString('utf8'), 'provenance statement');
}

function sameFields(value, expected) {
  if (!isObject(value)) return false;
  const keys = Object.keys(expected);
  return Object.keys(value).length === keys.length && keys.every(key => value[key] === expected[key]);
}

function verifyStatement(statement, { repo, ref, sha, sha512 }) {
  if (!isObject(statement) || statement._type !== IN_TOTO_STATEMENT) {
    throw fail('provenance statement has an unexpected type');
  }
  if (statement.predicateType !== SLSA_PROVENANCE) throw fail('provenance predicate is not SLSA v1');
  const subjects = statement.subject;
  if (!Array.isArray(subjects) || subjects.length !== 1 || subjects[0]?.digest?.sha512 !== sha512) {
    throw fail('provenance subject does not match the tarball');
  }
  const build = statement.predicate?.buildDefinition;
  const expectedWorkflow = { path: WORKFLOW_PATH, ref, repository: `https://github.com/${repo}` };
  if (!sameFields(build?.externalParameters?.workflow, expectedWorkflow)) {
    throw fail('provenance workflow identity does not match this release');
  }
  const gitUri = `git+https://github.com/${repo}@${ref}`;
  const dependencies = Array.isArray(build?.resolvedDependencies) ? build.resolvedDependencies : [];
  if (!dependencies.some(dep => isObject(dep) && dep.uri === gitUri && dep.digest?.gitCommit === sha)) {
    throw fail('provenance resolved commit does not match the tagged commit');
  }
  const builderId = statement.predicate?.runDetails?.builder?.id;
  if (typeof builderId !== 'string' || !builderId.endsWith('/github-hosted')) {
    throw fail('provenance was not produced on a GitHub-hosted runner');
  }
}

/* ---------- CLI ---------- */

async function dispatch(argv, env) {
  const [command, ...args] = argv;
  switch (command) {
    case 'version': {
      const o = parseOptions(args, VERSION_FLAGS, VERSION_FLAGS);
      const version = resolveVersion({ event: o.event, ref: o.ref, input: o.input, packagePath: o.package });
      return [['version', version]];
    }
    case 'source': {
      const o = parseOptions(args, SOURCE_FLAGS, ['repo', 'sha']);
      const result = await checkSource({
        repo: o.repo,
        sha: o.sha,
        api: o.api ?? DEFAULT_GITHUB_API,
        token: env.GH_TOKEN,
      });
      return [['status', result.status], ['sha', o.sha]];
    }
    case 'artifact': {
      const o = parseOptions(args, ARTIFACT_FLAGS, ARTIFACT_FLAGS);
      const result = checkTarball({ tarball: o.tarball, version: o.version, sha256: o.sha256, sha512: o.sha512 });
      return [['sha256', result.sha256], ['sha512', result.sha512]];
    }
    case 'registry': {
      const o = parseOptions(args, REGISTRY_FLAGS, ['name', 'version', 'sha512']);
      const result = await checkRegistry({
        name: o.name,
        version: o.version,
        sha512: o.sha512,
        registry: o.registry ?? DEFAULT_REGISTRY,
        expect: o.expect,
      });
      return [['action', result.action], ['integrity', result.integrity]];
    }
    case 'readback': {
      const o = parseOptions(args, READBACK_FLAGS, ['repo', 'name', 'version', 'sha512', 'sha', 'ref']);
      const result = await checkReadback({
        repo: o.repo,
        name: o.name,
        version: o.version,
        sha512: o.sha512,
        sha: o.sha,
        ref: o.ref,
        registry: o.registry ?? DEFAULT_REGISTRY,
        timeoutSeconds: timeoutFrom(o['timeout-seconds']),
      });
      return [['integrity', result.integrity]];
    }
    default:
      throw fail('usage: release-gate.mjs <version|source|artifact|registry|readback> [options]');
  }
}

/**
 * Runs one gate command. Resolves to the exit status and the exact stdout and stderr
 * text, so callers and tests never depend on process state.
 */
export async function runReleaseGate(argv, { env = {} } = {}) {
  try {
    const lines = await dispatch(argv, env);
    return {
      status: 0,
      stdout: lines.map(([key, value]) => `${key}=${value}\n`).join(''),
      stderr: '',
    };
  } catch (err) {
    return { status: 1, stdout: '', stderr: `release-gate: ${describeFailure(err)}\n` };
  }
}

function describeFailure(err) {
  return err instanceof GateError ? err.message : `unexpected failure${errorSuffix(err)}`;
}

const isEntrypoint = () => {
  if (typeof process.argv[1] !== 'string') return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return true;
  }
};

if (isEntrypoint()) {
  runReleaseGate(process.argv.slice(2), { env: process.env }).then(result => {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.status;
  });
}
