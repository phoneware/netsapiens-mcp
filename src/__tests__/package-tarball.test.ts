import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

describe('package tarball contents', () => {
  it('contains build/lib.js and build/index.js when packed', () => {
    const stdout = execSync('npm pack --dry-run --ignore-scripts --json', { encoding: 'utf8' });
    const parsed = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
    const files = parsed[0]?.files.map((f) => f.path) ?? [];
    expect(files).toContain('build/lib.js');
    expect(files).toContain('build/index.js');
  });
});
