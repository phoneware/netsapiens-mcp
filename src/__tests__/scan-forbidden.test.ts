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
  it('requires patterns', () => {
    expect(scan(['--tree'], '').status).toBe(2);
  });
});
