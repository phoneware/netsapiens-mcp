import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// The published build must resolve every relative .mjs and .d.mts specifier that build/ reaches. tsc emits
// neither, so scripts/copy-protocol-sources.mjs copies them. These tests run the real copy script in child
// processes, and the last block imports the built package itself. That block is skipped until a build exists.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const copyScript = join(repoRoot, 'scripts', 'copy-protocol-sources.mjs');
const temps: string[] = [];

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function filesUnder(root: string): string[] {
  const found: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else found.push(relative(root, path));
    }
  })(root);
  return found.sort();
}

function runCopy(src: string, dest: string) {
  return spawnSync(process.execPath, [copyScript, src, dest], { encoding: 'utf8' });
}

describe('protocol source copy into the build output', () => {
  it('copies every .mjs and .d.mts at its relative path, and nothing else', () => {
    const src = tempDir('protocol-src-');
    mkdirSync(join(src, 'cutover'), { recursive: true });
    mkdirSync(join(src, 'store', 'nested'), { recursive: true });
    writeFileSync(join(src, 'cutover', 'core.mjs'), 'export const core = 1;\n');
    writeFileSync(join(src, 'cutover', 'core.d.mts'), 'export declare const core: 1;\n');
    writeFileSync(join(src, 'store', 'nested', 'projector.mjs'), 'export const p = 2;\n');
    writeFileSync(join(src, 'store', 'types.ts'), 'export type T = 1;\n');
    writeFileSync(join(src, 'store', 'cutover-protocol.d.ts'), 'export {};\n');

    const dest = tempDir('protocol-dest-');
    const result = runCopy(src, dest);
    expect(result.status).toBe(0);

    expect(readFileSync(join(dest, 'cutover', 'core.mjs'), 'utf8')).toBe('export const core = 1;\n');
    expect(readFileSync(join(dest, 'cutover', 'core.d.mts'), 'utf8')).toBe('export declare const core: 1;\n');
    expect(readFileSync(join(dest, 'store', 'nested', 'projector.mjs'), 'utf8')).toBe('export const p = 2;\n');
    expect(existsSync(join(dest, 'store', 'types.ts'))).toBe(false);
    expect(existsSync(join(dest, 'store', 'types.js'))).toBe(false);
    expect(existsSync(join(dest, 'store', 'cutover-protocol.d.ts'))).toBe(true);
  });

  it('copies every protocol source of the real tree, so no relative .mjs import from build/ is missing', () => {
    const dest = tempDir('protocol-real-');
    const realSrc = join(repoRoot, 'src');
    const result = runCopy(realSrc, dest);
    expect(result.status).toBe(0);

    const expected = filesUnder(realSrc).filter((rel) => rel.endsWith('.mjs') || rel.endsWith('.d.mts'));
    for (const rel of expected) {
      expect(existsSync(join(dest, rel)), `${rel} must be copied`).toBe(true);
    }
    expect(existsSync(join(dest, 'cutover', 'canonical-core.mjs'))).toBe(true);
    expect(existsSync(join(dest, 'cutover', 'canonical-core.d.mts'))).toBe(true);
    expect(existsSync(join(dest, 'store', 'netsapiens-projector.mjs'))).toBe(true);
    expect(existsSync(join(dest, 'store', 'netsapiens-projector.d.mts'))).toBe(true);
  });
});

const builtLib = join(repoRoot, 'build', 'lib.js');

describe.skipIf(!existsSync(builtLib))('built package resolution', () => {
  it('imports the built lib and store entry points, resolving their .mjs dependencies', () => {
    const script = `await import(${JSON.stringify(builtLib)}); await import(${JSON.stringify(join(repoRoot, 'build', 'store', 'firestore.js'))});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: repoRoot });
    expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(result.status).toBe(0);
  });
});
