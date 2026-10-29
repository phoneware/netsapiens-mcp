import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
      writeFileSync(join(history, 'zzz-outside.txt'), marker);
      run('add', '.');
      run('commit', '-m', 'outside');
      const dirty = scan(['--history', join(history, '.git')]);
      expect(dirty.status).toBe(1);
      expect(dirty.stdout).toContain('MATCH object ');
      expect(dirty.stdout.toLowerCase()).not.toContain(marker);
      run('rm', 'zzz-outside.txt');
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
  it('requires patterns', () => {
    expect(scan(['--tree'], '').status).toBe(2);
  });
});
