import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('leaves all specification bytes unchanged when a later fetch fails the equality guard', () => {
  const root = mkdtempSync(join(tmpdir(), 'nsmcp-fetch-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'spec', 'v1'), { recursive: true });
    mkdirSync(join(root, 'spec', 'v2'));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    copyFileSync(resolve('scripts/fetch-specs.ts'), join(root, 'scripts/fetch-specs.ts'));
    writeFileSync(join(root, 'spec/v2/BRANCHES.json'), JSON.stringify(['44.3', '44.4', '45.0']));
    writeFileSync(join(root, 'spec/v1/apidoc-44.4.10.json'), 'v1');
    for (const branch of ['44.3', '44.4', '45.0']) writeFileSync(join(root, `spec/v2/${branch}.json`), `original-${branch}`);
    writeFileSync(join(root, 'spec/SOURCES.json'), 'original-sources');
    const preload = join(root, 'fetch.cjs');
    writeFileSync(preload, "global.fetch = async (url) => new Response('new-' + url, { status: 200 });\n");
    const tsx = resolve('node_modules/tsx/dist/cli.mjs');
    const result = spawnSync(process.execPath, [tsx, join(root, 'scripts/fetch-specs.ts')], {
      cwd: root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--require=${preload}` },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('45.0 documentation differs');
    for (const branch of ['44.3', '44.4', '45.0']) expect(readFileSync(join(root, `spec/v2/${branch}.json`), 'utf8')).toBe(`original-${branch}`);
    expect(readFileSync(join(root, 'spec/SOURCES.json'), 'utf8')).toBe('original-sources');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
