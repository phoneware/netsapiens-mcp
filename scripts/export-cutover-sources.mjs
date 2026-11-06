import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  if (i < 0 || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing ${name}`);
  return args[i + 1];
};
const safePath = (path) => {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error('Invalid relative path');
  return path;
};
const consumer = resolve(value('--consumer'));
const lockPath = resolve(consumer, safePath(value('--lock')));
const digest = (content) => createHash('sha256').update(content).digest('hex');
const gitBlob = (content) => createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
const git = (...argv) => execFileSync('git', argv, { cwd: packageRoot });
const commonPaths = [
  'src/cutover/canonical-core.mjs', 'src/cutover/canonical-core.d.mts',
  'src/cutover/protocol.entry.mjs',
  'src/cutover/dsse-verifier-core.mjs', 'src/cutover/dsse-verifier-core.d.mts',
  'src/store/netsapiens-projector.mjs', 'src/store/netsapiens-projector.d.mts',
  'src/store/errors.ts', 'src/store/codec.ts', 'src/store/row-format.ts',
  'src/store/firestore-like.ts',
  'src/store/subject-descriptor.ts', 'src/store/subject-guard.ts',
];
const readOptional = async (path) => {
  try { return await readFile(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
};
const previousBytes = await readOptional(lockPath);
const previous = previousBytes ? JSON.parse(previousBytes.toString('utf8')) : undefined;
const profile = args.includes('--check') ? previous?.profile : value('--profile');
if (profile !== 'bridge' && profile !== 'migration') throw new Error('Profile must be bridge or migration');
const paths = profile === 'bridge'
  ? [...commonPaths, 'src/ledger.ts', 'src/firestore-ledger.ts', 'src/upstream-grant.ts',
    'src/bound-fenced-runtime.ts', 'src/strip-undefined.ts', 'src/index.ts']
  : commonPaths;
const generatedNames = profile === 'bridge'
  ? ['cutover-protocol.mjs', 'cutover-protocol.d.ts', 'cutover-protocol.d.mts']
  : ['cutover-protocol.mjs', 'cutover-protocol.d.ts'];
if (args.includes('--check')) {
  if (!previous || previous.generator !== 1 || previous.repository !== 'phoneware/monorepo' ||
    !/^[0-9a-f]{40}$/.test(previous.commit) || !Array.isArray(previous.files) || previous.files.length !== paths.length ||
    previous.entrypoint !== 'src/cutover/protocol.entry.mjs' ||
    !Array.isArray(previous.generated) || previous.generated.length !== generatedNames.length) {
    throw new Error('Invalid source lock');
  }
  const names = new Set();
  const generatedSeen = new Set();
  const sources = new Set();
  for (const entry of previous.files) {
    const destination = safePath(entry.destination);
    if (names.has(destination) || !/^[0-9a-f]{40}$/.test(entry.blob) || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error('Invalid source lock entry');
    names.add(destination);
    if (!paths.some((path) => entry.source === `packages/mcp-oauth-kit/${path}`) || sources.has(entry.source)) throw new Error('Invalid source inventory');
    sources.add(entry.source);
    const actual = await readFile(resolve(consumer, destination));
    if (digest(actual) !== entry.sha256 || gitBlob(actual) !== entry.blob) throw new Error(`Source drift: ${destination}`);
  }
  for (const entry of previous.generated ?? []) {
    const destination = safePath(entry.destination);
    const basename = destination.split('/').at(-1);
    if (!generatedNames.includes(basename) || generatedSeen.has(basename) || names.has(destination) ||
      !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error('Invalid generated output inventory');
    generatedSeen.add(basename);
    if (digest(await readFile(resolve(consumer, destination))) !== entry.sha256) throw new Error(`Generated output drift: ${destination}`);
  }
} else {
  const revision = value('--revision');
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('Revision must be a full commit SHA');
  const prefix = safePath(value('--destination'));
  const commit = git('rev-parse', `${revision}^{commit}`).toString('utf8').trim();
  if (commit !== revision) throw new Error('Revision mismatch');
  const packagePath = git('rev-parse', '--show-prefix').toString('utf8').trim();
  const staged = [];
  for (const path of paths) {
    const source = `${packagePath}${path}`;
    const content = git('show', `${commit}:${source}`);
    const blob = git('rev-parse', `${commit}:${source}`).toString('utf8').trim();
    const relative = path === 'src/cutover/protocol.entry.mjs' ? 'cutover/canonical-protocol.entry.mjs' : path.slice(4);
    const destination = safePath(`${prefix}/${relative}`);
    const target = resolve(consumer, destination);
    const existing = await readOptional(target);
    const prior = previous?.files?.find((entry) => entry.destination === destination);
    if (existing && (!prior || digest(existing) !== prior.sha256)) throw new Error(`Refusing to overwrite unrecognized content: ${destination}`);
    staged.push({ content, target, entry: { source, blob, destination, sha256: digest(content) } });
  }
  const generated = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--generated') {
      const destination = safePath(args[++i]);
      generated.push({ destination, sha256: digest(await readFile(resolve(consumer, destination))) });
    }
  }
  for (const item of staged) {
    await mkdir(dirname(item.target), { recursive: true });
    await writeFile(item.target, item.content);
  }
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, JSON.stringify({ generator: 1, repository: 'phoneware/monorepo', commit, profile, entrypoint: 'src/cutover/protocol.entry.mjs', files: staged.map((item) => item.entry), generated }, null, 2) + '\n');
}
