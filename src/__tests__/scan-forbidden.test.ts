import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  let root: string;
  let repo: string;
  const gitIn = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
  const commitScan = (args: string[], cwd = repo) => spawnSync(process.execPath, [scanner, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, FORBIDDEN_CONTENT_PATTERNS: marker },
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

  it('scans the exact commit rather than dirty or later checkout content', () => {
    const clean = gitIn('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'clean.txt'), marker);
    expect(commitScan(['--commit', clean]).status).toBe(0);
    const dirtyCommit = commitAll();
    writeFileSync(join(repo, 'clean.txt'), 'clean again');
    const result = commitScan(['--commit', dirtyCommit]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('MATCH clean.txt');
    expect(result.stdout + result.stderr).not.toContain(marker);
    expect(commitScan(['--commit', clean]).status).toBe(0);
  });

  it('redacts matching paths, including paths under spec', () => {
    writeFileSync(join(repo, marker), 'clean');
    writeFileSync(join(repo, 'spec', marker), 'clean');
    const result = commitScan(['--commit', commitAll()]);
    expect(result.status).toBe(1);
    expect(result.stdout.match(/MATCH \[redacted\]/g)).toHaveLength(2);
    expect(result.stdout + result.stderr).not.toContain(marker);
  });

  it('reads symlink blob text without following an outside target', () => {
    writeFileSync(join(root, 'sentinel'), marker);
    symlinkSync('../sentinel', join(repo, 'link'));
    const outsideLink = commitAll();
    expect(commitScan(['--commit', outsideLink]).status).toBe(0);
    rmSync(join(repo, 'link'));
    symlinkSync(marker, join(repo, 'link'));
    const result = commitScan(['--commit', commitAll()]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('MATCH link');
    expect(result.stdout + result.stderr).not.toContain(marker);
  });

  it('rejects submodules even inside excluded spec', () => {
    const target = gitIn('rev-parse', 'HEAD');
    gitIn('update-index', '--add', '--cacheinfo', `160000,${target},spec/submodule`);
    gitIn('commit', '-m', 'submodule');
    expect(commitScan(['--commit', gitIn('rev-parse', 'HEAD')]).status).toBe(2);
  });

  it('rejects missing, abbreviated, non-commit, and injection-like arguments', () => {
    const id = gitIn('rev-parse', 'HEAD');
    const blob = gitIn('rev-parse', 'HEAD:clean.txt');
    for (const args of [
      ['--commit'], ['--commit', id.slice(0, 12)], ['--commit', 'HEAD'],
      ['--commit', `${id};touch injected`], ['--commit', id, 'extra'],
      ['--commit', blob], ['--commit', '0'.repeat(id.length)],
    ]) {
      expect(commitScan(args).status).toBe(2);
    }
  });

  it('bounds reports while continuing to scan the commit', () => {
    for (let index = 0; index < 105; index++) {
      writeFileSync(join(repo, `item-${index}.txt`), marker);
    }
    const result = commitScan(['--commit', commitAll()]);
    expect(result.status).toBe(1);
    expect(result.stdout.split('\n').filter(Boolean)).toHaveLength(101);
    expect(result.stdout).toContain('MATCH [additional results omitted]');
    expect(result.stdout + result.stderr).not.toContain(marker);
  });

  it('fails closed on git errors without disclosing stderr', () => {
    const id = gitIn('rev-parse', 'HEAD');
    const result = commitScan(['--commit', id], root);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Content scan failed');
    expect(result.stdout + result.stderr).not.toContain(root);
  });
});
