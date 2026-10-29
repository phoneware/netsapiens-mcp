import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
