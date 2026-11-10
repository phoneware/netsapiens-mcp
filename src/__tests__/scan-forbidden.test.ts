import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scanner = resolve('scripts/scan-forbidden.mjs');
const marker = 'sample-private-marker';
let dir: string;
let archive: string;
function git(...args: string[]) {
  return execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();
}
function scan(args: string[], patterns = marker) {
  return spawnSync(process.execPath, [scanner, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, FORBIDDEN_CONTENT_PATTERNS: patterns },
  });
}
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'content-scan-'));
  git('init', '-b', 'initial');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'fixture.txt'), marker.toUpperCase());
  mkdirSync(join(dir, 'spec'));
  writeFileSync(join(dir, 'spec', 'excluded.txt'), marker);
  git('add', '.');
  git('commit', '-m', 'initial');
  archive = join(dir, 'fixture.tgz');
  execFileSync('tar', ['-czf', archive, '-C', dir, 'fixture.txt']);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('forbidden content scanner', () => {
  it('detects tracked content and excludes the vendor specification directory', () => {
    const result = scan(['--tree']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('MATCH fixture.txt');
    expect(result.stdout).not.toContain(marker);
    expect(result.stdout).not.toContain('excluded.txt');
    writeFileSync(join(dir, 'fixture.txt'), 'clean');
    expect(scan(['--tree']).status).toBe(0);
  });
  it('detects content in a tarball without printing it', () => {
    const result = scan(['--pack', archive], '/sample-private-marker/i');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('MATCH fixture.txt');
    expect(result.stdout.toLowerCase()).not.toContain(marker);
    expect(scan(['--pack', archive], 'absent').status).toBe(0);
  });
  it('detects reachable objects and reports pull refs separately', () => {
    const result = scan(['--history', join(dir, '.git')]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('MATCH object ');
    expect(result.stdout.toLowerCase()).not.toContain(marker);
    const dirty = git('rev-parse', 'HEAD');
    git('checkout', '--orphan', 'clean');
    git('rm', '-rf', '.');
    writeFileSync(join(dir, 'clean.txt'), 'clean');
    git('add', 'clean.txt');
    git('commit', '-m', 'clean');
    git('update-ref', 'refs/pull/1/head', dirty);
    git('branch', '-D', 'initial');
    const pending = scan(['--history', join(dir, '.git')]);
    expect(pending.status).toBe(0);
    expect(pending.stdout).toContain('PENDING refs/pull/1/head');
    expect(pending.stdout.toLowerCase()).not.toContain(marker);
  });
  it('scans history by path even when an excluded blob also appears elsewhere', () => {
    const history = mkdtempSync(join(tmpdir(), 'content-paths-'));
    try {
      const run = (...args: string[]) => execFileSync('git', args, { cwd: history, stdio: 'pipe' });
      run('init', '-b', 'main');
      run('config', 'user.email', 'test@example.invalid');
      run('config', 'user.name', 'Test');
      mkdirSync(join(history, 'spec'));
      writeFileSync(join(history, 'spec', 'vendor.json'), marker);
      run('add', '.');
      run('commit', '-m', 'vendor');
      const clean = scan(['--history', join(history, '.git')]);
      expect(clean.status).toBe(0);
      expect(clean.stdout.toLowerCase()).not.toContain(marker);
      writeFileSync(join(history, 'aaa-outside.txt'), marker);
      run('add', '.');
      run('commit', '-m', 'outside');
      const dirty = scan(['--history', join(history, '.git')]);
      expect(dirty.status).toBe(1);
      expect(dirty.stdout).toContain('MATCH object ');
      expect(dirty.stdout.toLowerCase()).not.toContain(marker);
      run('rm', 'aaa-outside.txt');
      run('commit', '-m', 'remove');
      expect(scan(['--history', join(history, '.git')]).status).toBe(1);
    } finally {
      rmSync(history, { recursive: true, force: true });
    }
  });
  it('redacts matching path and reference names in scanner output', () => {
    const history = mkdtempSync(join(tmpdir(), 'content-redaction-'));
    try {
      const run = (...args: string[]) => execFileSync('git', args, { cwd: history, stdio: 'pipe' });
      run('init', '-b', 'main');
      run('config', 'user.email', 'test@example.invalid');
      run('config', 'user.name', 'Test');
      writeFileSync(join(history, `${marker}.txt`), marker);
      run('add', '.');
      run('commit', '-m', 'fixture');
      run('branch', marker);
      const env = { ...process.env, FORBIDDEN_CONTENT_PATTERNS: marker };
      const tree = spawnSync(process.execPath, [scanner, '--tree'], { cwd: history, env, encoding: 'utf8' });
      const historyResult = spawnSync(process.execPath, [scanner, '--history', join(history, '.git')], { cwd: history, env, encoding: 'utf8' });
      expect(tree.status).toBe(1);
      expect(historyResult.status).toBe(1);
      expect(tree.stdout.toLowerCase()).not.toContain(marker);
      expect(historyResult.stdout.toLowerCase()).not.toContain(marker);
      expect(tree.stdout).toContain('[redacted]');
      expect(historyResult.stdout).toContain('[redacted]');
    } finally {
      rmSync(history, { recursive: true, force: true });
    }
  });
  it('detects forbidden paths in tree and history even when file contents are clean', () => {
    const history = mkdtempSync(join(tmpdir(), 'content-filenames-'));
    try {
      const run = (...args: string[]) => execFileSync('git', args, { cwd: history, stdio: 'pipe' });
      run('init', '-b', 'main');
      run('config', 'user.email', 'test@example.invalid');
      run('config', 'user.name', 'Test');
      mkdirSync(join(history, 'spec'));
      writeFileSync(join(history, 'spec', `${marker}.txt`), 'clean');
      run('add', '.');
      run('commit', '-m', 'clean');
      const env = { ...process.env, FORBIDDEN_CONTENT_PATTERNS: marker };
      const tree = spawnSync(process.execPath, [scanner, '--tree'], { cwd: history, env, encoding: 'utf8' });
      const old = scan(['--history', join(history, '.git')]);
      for (const result of [tree, old]) {
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('MATCH [redacted]');
        expect(result.stdout.toLowerCase()).not.toContain(marker);
      }
    } finally {
      rmSync(history, { recursive: true, force: true });
    }
  });
  it('scans a root-level blob named spec', () => {
    const history = mkdtempSync(join(tmpdir(), 'content-spec-file-'));
    try {
      const run = (...args: string[]) => execFileSync('git', args, { cwd: history, stdio: 'pipe' });
      run('init', '-b', 'main');
      run('config', 'user.email', 'test@example.invalid');
      run('config', 'user.name', 'Test');
      writeFileSync(join(history, 'spec'), marker);
      run('add', '.');
      run('commit', '-m', 'clean');
      const result = scan(['--history', join(history, '.git')]);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('MATCH object ');
      expect(result.stdout.toLowerCase()).not.toContain(marker);
    } finally {
      rmSync(history, { recursive: true, force: true });
    }
  });
  it('detects commit and annotated tag messages without displaying them', () => {
    const history = mkdtempSync(join(tmpdir(), 'content-messages-'));
    try {
      const run = (...args: string[]) => execFileSync('git', args, { cwd: history, stdio: 'pipe' });
      run('init', '-b', 'initial');
      run('config', 'user.email', 'test@example.invalid');
      run('config', 'user.name', 'Test');
      writeFileSync(join(history, 'clean.txt'), 'clean');
      run('add', '.');
      run('commit', '-m', marker);
      const commitResult = scan(['--history', join(history, '.git')]);
      expect(commitResult.status).toBe(1);
      expect(commitResult.stdout).toContain('MATCH object ');
      expect(commitResult.stdout.toLowerCase()).not.toContain(marker);
      run('checkout', '--orphan', 'clean');
      run('commit', '-m', 'clean');
      run('branch', '-D', 'initial');
      run('tag', '-a', 'tag', '-m', marker);
      const tagResult = scan(['--history', join(history, '.git')]);
      expect(tagResult.status).toBe(1);
      expect(tagResult.stdout).toContain('MATCH object ');
      expect(tagResult.stdout.toLowerCase()).not.toContain(marker);
    } finally {
      rmSync(history, { recursive: true, force: true });
    }
  });
  it.each(['author', 'committer', 'encoding', 'mergetag', 'tag'])('detects forbidden %s headers', field => {
    const history = mkdtempSync(join(tmpdir(), 'content-header-'));
    try {
      const run = (...args: string[]) => execFileSync('git', args, { cwd: history, stdio: 'pipe' }).toString().trim();
      run('init', '-b', 'main');
      run('config', 'user.email', 'test@example.invalid');
      run('config', 'user.name', 'Test');
      writeFileSync(join(history, 'clean.txt'), 'clean');
      run('add', '.');
      run('commit', '-m', 'clean');
      const tree = run('rev-parse', 'HEAD^{tree}');
      const author = field === 'author' ? marker : 'Person';
      const committer = field === 'committer' ? marker : 'Person';
      const extra = field === 'encoding' ? `encoding ${marker}\n` : field === 'mergetag' ? `mergetag object 0000000000000000000000000000000000000000\n ${marker}\n` : '';
      const commit = `tree ${tree}\nauthor ${author} <test@example.invalid> 1 +0000\ncommitter ${committer} <test@example.invalid> 1 +0000\n${extra}\nclean\n`;
      const oid = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: history, input: commit, encoding: 'utf8' }).trim();
      run('update-ref', 'refs/heads/main', oid);
      if (field === 'tag') {
        const tag = `object ${oid}\ntype commit\ntag ${marker}\ntagger Person <test@example.invalid> 1 +0000\n\nclean\n`;
        const tagId = execFileSync('git', ['hash-object', '-t', 'tag', '-w', '--stdin'], { cwd: history, input: tag, encoding: 'utf8' }).trim();
        run('update-ref', 'refs/tags/safe', tagId);
      }
      const result = scan(['--history', join(history, '.git')]);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('MATCH object ');
      expect(result.stdout.toLowerCase()).not.toContain(marker);
    } finally {
      rmSync(history, { recursive: true, force: true });
    }
  });
  it('uses a fixed number of git processes regardless of pull refs', () => {
    const history = mkdtempSync(join(tmpdir(), 'content-processes-'));
    try {
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      const run = (...args: string[]) => execFileSync(realGit, args, { cwd: history, stdio: 'pipe' });
      run('init', '-b', 'main');
      run('config', 'user.email', 'test@example.invalid');
      run('config', 'user.name', 'Test');
      writeFileSync(join(history, 'clean.txt'), 'clean');
      run('add', '.');
      run('commit', '-m', 'clean');
      const commit = run('rev-parse', 'HEAD').toString().trim();
      for (let i = 1; i <= 25; i++) run('update-ref', `refs/pull/${i}/head`, commit);
      const bin = join(history, 'bin');
      mkdirSync(bin);
      const wrapper = join(bin, 'git');
      writeFileSync(wrapper, '#!/bin/sh\nprintf \"%s\\n\" \"$3\" >> \"$SCAN_GIT_LOG\"\nexec \"$REAL_GIT\" \"$@\"\n');
      chmodSync(wrapper, 0o755);
      const log = join(history, 'calls');
      const result = spawnSync(process.execPath, [scanner, '--history', join(history, '.git')], {
        cwd: history, encoding: 'utf8',
        env: { ...process.env, FORBIDDEN_CONTENT_PATTERNS: marker, PATH: `${bin}:${process.env.PATH}`, REAL_GIT: realGit, SCAN_GIT_LOG: log },
      });
      expect(result.status).toBe(0);
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['for-each-ref', 'rev-list', 'cat-file']);
    } finally {
      rmSync(history, { recursive: true, force: true });
    }
  });
  it('requires patterns', () => {
    expect(scan(['--tree'], '').status).toBe(2);
  });
});

describe('commit content scanner', () => {
  const maxEntries = 50_000; // Mirrors MAX_ENTRIES in scripts/scan-forbidden.mjs.
  const maxObjectBytes = 64 * 1024 * 1024; // Mirrors MAX_OBJECT_BYTES in scripts/scan-forbidden.mjs.
  const verdict = 'MATCH [redacted]\n';
  let root: string;
  let repo: string;
  const gitIn = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
  const gitWith = (input: Buffer | string, ...args: string[]) => execFileSync('git', args, { cwd: repo, input, stdio: 'pipe' }).toString().trim();
  const blob = (content: Buffer | string) => gitWith(content, 'hash-object', '-w', '--stdin');
  const rawTree = (entries: [string, string, string][]) => gitWith(
    Buffer.concat(entries.map(([mode, name, oid]) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')]))),
    'hash-object', '-t', 'tree', '--literally', '-w', '--stdin',
  );
  // Root tree holding one leaf at `path`, with a nested tree for each directory above it.
  const nested = (path: string, oid: string, mode = '100644'): string => {
    const [head, ...rest] = path.split('/');
    return rest.length ? rawTree([['40000', head, nested(rest.join('/'), oid, mode)]]) : rawTree([[mode, head, oid]]);
  };
  const commitOf = (tree: string) => gitIn('commit-tree', tree, '-m', 'fixture');
  const commitScan = (args: string[], extra: NodeJS.ProcessEnv = {}, cwd = repo) => spawnSync(process.execPath, [scanner, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, FORBIDDEN_CONTENT_PATTERNS: marker, ...extra },
  });
  const commitAll = () => {
    gitIn('add', '-A');
    gitIn('commit', '-m', 'fixture');
    return gitIn('rev-parse', 'HEAD');
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'commit-scan-'));
    repo = join(root, 'repo');
    mkdirSync(repo);
    gitIn('init');
    gitIn('config', 'user.email', 'test@example.invalid');
    gitIn('config', 'user.name', 'Test');
    writeFileSync(join(repo, 'clean.txt'), 'clean');
    mkdirSync(join(repo, 'spec'));
    writeFileSync(join(repo, 'spec', 'excluded.txt'), marker);
    commitAll();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('scans the named commit, ignoring dirty and later checkout content', () => {
    const clean = gitIn('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'clean.txt'), marker);
    expect(commitScan(['--commit', clean]).status).toBe(0);
    const dirty = commitAll();
    writeFileSync(join(repo, 'clean.txt'), 'clean again');
    const result = commitScan(['--commit', dirty]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(verdict);
    expect(commitScan(['--commit', clean]).status).toBe(0);
  });

  it('excludes root spec/ content from matching', () => {
    expect(commitScan(['--commit', commitOf(nested('spec/excluded.txt', blob(marker)))]).status).toBe(0);
  });

  it.each(['spec', 'spec.txt', 'specs/x.txt', 'a/spec/x.txt', 'Spec/x.txt'])('content-scans the near-miss path %s', path => {
    const result = commitScan(['--commit', commitOf(nested(path, blob(marker)))]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(verdict);
  });

  it('emits only a fixed verdict, never a path or matched text', () => {
    const tree = rawTree([['100644', marker, blob(marker)], ['100644', 'clean.txt', blob('clean')]]);
    const result = commitScan(['--commit', commitOf(tree)]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(verdict);
    expect(result.stderr).toBe('');
  });

  it('emits one verdict for many matches and still exits 1', () => {
    const match = blob(marker);
    const tree = rawTree(Array.from({ length: 105 }, (_, i) => ['100644', `m${i}.txt`, match] as [string, string, string]));
    const result = commitScan(['--commit', commitOf(tree)]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(verdict);
  });

  it('keeps scanning after a match and fails on a later submodule entry', () => {
    const head = gitIn('rev-parse', 'HEAD');
    const tree = rawTree([['100644', 'a.txt', blob(marker)], ['160000', 'z', head]]);
    expect(commitScan(['--commit', commitOf(tree)]).status).toBe(2);
  });

  it('rejects submodules even inside excluded spec', () => {
    const head = gitIn('rev-parse', 'HEAD');
    expect(commitScan(['--commit', commitOf(nested('spec/submodule', head, '160000'))]).status).toBe(2);
  });

  it.each(['f.txt', 'spec/excluded.txt'])('rejects non-blob objects behind file modes at %s', path => {
    const head = gitIn('rev-parse', 'HEAD');
    gitIn('tag', '-a', 'fixture-tag', '-m', 'tag message', head);
    const tag = gitIn('rev-parse', 'refs/tags/fixture-tag');
    const others = [tag, head, gitIn('rev-parse', 'HEAD^{tree}'), '1'.repeat(head.length)];
    for (const oid of others) expect(commitScan(['--commit', commitOf(nested(path, oid))]).status).toBe(2);
  });

  it('rejects a directory mode that points at a blob', () => {
    expect(commitScan(['--commit', commitOf(rawTree([['40000', 'd', blob('clean')]]))]).status).toBe(2);
  });

  it('checks directory names, including empty directories', () => {
    const empty = rawTree([]);
    const clean = blob('clean');
    const matching = commitScan(['--commit', commitOf(rawTree([['40000', marker, empty], ['100644', 'clean.txt', clean]]))]);
    expect(matching.status).toBe(1);
    expect(matching.stdout).toBe(verdict);
    expect(commitScan(['--commit', commitOf(rawTree([['40000', 'empty', empty]]))]).status).toBe(0);
  });

  it('reads symlink blobs as target text and never follows them', () => {
    writeFileSync(join(root, 'sentinel'), marker);
    expect(commitScan(['--commit', commitOf(nested('link', blob('../sentinel'), '120000'))]).status).toBe(0);
    expect(commitScan(['--commit', commitOf(nested('link', blob(marker), '120000'))]).status).toBe(1);
  });

  it('content-scans executable files', () => {
    expect(commitScan(['--commit', commitOf(nested('run.sh', blob(marker), '100755'))]).status).toBe(1);
    expect(commitScan(['--commit', commitOf(nested('run.sh', blob('clean'), '100755'))]).status).toBe(0);
  });

  it('accepts uppercase full hex ids', () => {
    const clean = gitIn('rev-parse', 'HEAD');
    expect(commitScan(['--commit', clean.toUpperCase()]).status).toBe(0);
  });

  it('rejects missing, abbreviated, non-commit, and injection-like arguments', () => {
    const id = gitIn('rev-parse', 'HEAD');
    const blobId = gitIn('rev-parse', 'HEAD:clean.txt');
    for (const args of [
      ['--commit'], ['--commit', id.slice(0, 12)], ['--commit', 'HEAD'],
      ['--commit', `${id};touch injected`], ['--commit', id, 'extra'],
      ['--commit', blobId], ['--commit', '0'.repeat(id.length)],
    ]) {
      expect(commitScan(args).status).toBe(2);
    }
  });

  it('accepts exactly the entry limit and rejects one more', () => {
    const clean = blob('clean');
    const flat = (count: number) => commitOf(rawTree(Array.from({ length: count }, (_, i) => ['100644', `f${i}`, clean] as [string, string, string])));
    expect(commitScan(['--commit', flat(maxEntries)]).status).toBe(0);
    expect(commitScan(['--commit', flat(maxEntries + 1)]).status).toBe(2);
  });

  it('rejects a total object budget overrun', () => {
    expect(commitScan(['--commit', commitOf(nested('big.bin', blob(Buffer.alloc(maxObjectBytes + 1))))]).status).toBe(2);
  });

  it('counts a shared object once against the byte budget', () => {
    const shared = blob(Buffer.concat([Buffer.from(marker), Buffer.alloc(1024 * 1024, 0x61)]));
    const tree = rawTree(Array.from({ length: 100 }, (_, i) => ['100644', `ref-${i}.txt`, shared] as [string, string, string]));
    const result = commitScan(['--commit', commitOf(tree)]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(verdict);
  });

  describe('git children', () => {
    let fakeDir: string;
    let log: string;
    let fakeEnv: NodeJS.ProcessEnv;
    beforeEach(() => {
      const realGit = execFileSync('which', ['git'], { stdio: 'pipe' }).toString().trim();
      fakeDir = mkdtempSync(join(root, 'bin-'));
      log = join(root, 'git.log');
      writeFileSync(log, '');
      writeFileSync(join(fakeDir, 'git'), [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> '${log}'`,
        `if env | grep -q '^FORBIDDEN_CONTENT_PATTERNS='; then echo leak >> '${log}'; fi`,
        `exec '${realGit}' "$@"`,
      ].join('\n') + '\n');
      chmodSync(join(fakeDir, 'git'), 0o755);
      fakeEnv = { PATH: `${fakeDir}:${process.env.PATH}` };
    });

    it('keeps the pattern variable out of git children, unlike the tree mode', () => {
      commitScan(['--tree'], fakeEnv);
      expect(readFileSync(log, 'utf8')).toContain('leak');
      writeFileSync(log, '');
      expect(commitScan(['--commit', gitIn('rev-parse', 'HEAD')], fakeEnv).status).toBe(0);
      expect(readFileSync(log, 'utf8')).toContain('cat-file');
      expect(readFileSync(log, 'utf8')).not.toContain('leak');
    });

    it('uses a fixed number of git processes regardless of commit size', () => {
      const withFiles = (count: number) => commitOf(rawTree(Array.from({ length: count }, (_, i) => ['100644', `f${i}.txt`, blob(`clean ${i}`)] as [string, string, string])));
      const invocations = (commit: string) => {
        writeFileSync(log, '');
        expect(commitScan(['--commit', commit], fakeEnv).status).toBe(0);
        return readFileSync(log, 'utf8').trim().split('\n').length;
      };
      const small = invocations(withFiles(3));
      const large = invocations(withFiles(60));
      expect(small).toBeLessThanOrEqual(5);
      expect(large).toBe(small);
    });
  });

  it('fails closed on git errors without disclosing stderr', () => {
    const id = gitIn('rev-parse', 'HEAD');
    const result = commitScan(['--commit', id], {}, root);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Content scan failed');
    expect(result.stdout + result.stderr).not.toContain(root);
  });
});
