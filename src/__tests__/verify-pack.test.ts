import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { verifyPack } from '../../scripts/verify-pack.mjs';

interface FixtureOptions {
  packageJsonOverrides?: Record<string, unknown>;
  omitFiles?: string[];
  extraFiles?: Record<string, string>;
}

describe('verify-pack', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function createFixture(options: FixtureOptions = {}): { dir: string; tarballPath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-pack-test-'));
    tempDirs.push(dir);

    const basePkgJson: Record<string, unknown> = {
      name: 'fixture-package',
      version: '3.0.0',
      main: 'build/index.js',
      types: 'build/index.d.ts',
      files: [
        'build/**/*',
        'CHANGELOG.md',
        'LICENSE',
        'README.md',
      ],
      exports: {
        '.': {
          types: './build/index.d.ts',
          default: './build/index.js',
        },
        './testing/store-conformance': {
          types: './build/store/conformance.d.ts',
          default: './build/store/conformance.js',
        },
      },
      dependencies: {
        axios: '^1.20.0',
      },
      peerDependencies: {
        '@google-cloud/firestore': '^7.11.0 || ^8.0.0 || ^9.0.0',
        vitest: '^4.1.11',
      },
      peerDependenciesMeta: {
        '@google-cloud/firestore': {
          optional: true,
        },
        vitest: {
          optional: true,
        },
      },
      repository: {
        type: 'git',
        url: 'git+https://github.com/phoneware/netsapiens-mcp.git',
      },
      ...options.packageJsonOverrides,
    };

    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(basePkgJson, null, 2), 'utf8');

    // Default required files
    const defaultFiles: Record<string, string> = {
      'build/index.js': 'export const main = () => {};',
      'build/lib.js': 'export const lib = () => {};',
      'build/store/conformance.js': 'export const conformance = () => {};',
      'build/store/conformance.d.ts': 'export declare const conformance: () => void;',
      'build/generated/availability.json': '{}',
      'CHANGELOG.md': '# Changelog\n\n## 3.0.0\n- Release 3.0.0\n',
      'LICENSE': 'MIT License',
      'README.md': '# Fixture Package',
      ...(options.extraFiles || {}),
    };

    for (const [relPath, content] of Object.entries(defaultFiles)) {
      if (options.omitFiles && options.omitFiles.includes(relPath)) {
        continue;
      }
      const fullPath = path.join(dir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf8');
    }

    const packOutput = execFileSync('npm', ['pack'], { cwd: dir, encoding: 'utf8' }).trim();
    const tarballFileName = packOutput.split(/\r?\n/).pop()!.trim();
    const tarballPath = path.join(dir, tarballFileName);

    return { dir, tarballPath };
  }

  it('proves valid package passes verifyPack and CLI', () => {
    const { tarballPath } = createFixture();
    const result = verifyPack(tarballPath, { expectedVersion: '3.0.0' });
    expect(result.ok).toBe(true);
    expect(result.results.some(r => r.status === 'FAIL')).toBe(false);

    // Also verify CLI exit 0
    const cliScript = path.resolve('scripts/verify-pack.mjs');
    const stdout = execFileSync('node', [cliScript, tarballPath, '3.0.0'], { encoding: 'utf8' });
    expect(stdout).toContain('PASS');
    expect(stdout).not.toContain('FAIL');
  });

  it('fails when package/build/__tests__/setup.js is present', () => {
    const { tarballPath } = createFixture({
      extraFiles: {
        'build/__tests__/setup.js': '// test setup helper',
      },
    });

    const result = verifyPack(tarballPath, { expectedVersion: '3.0.0' });
    expect(result.ok).toBe(false);
    const failure = result.results.find(r => r.status === 'FAIL' && r.message.includes('__tests__'));
    expect(failure).toBeDefined();
    expect(failure?.message).toContain('__tests__');
  });

  it('fails when *.node entry is present', () => {
    const { tarballPath } = createFixture({
      extraFiles: {
        'build/addon.node': 'binary content',
      },
    });

    const result = verifyPack(tarballPath, { expectedVersion: '3.0.0' });
    expect(result.ok).toBe(false);
    const failure = result.results.find(r => r.status === 'FAIL' && r.message.includes('*.node'));
    expect(failure).toBeDefined();
  });

  it('fails when spec/ entry is present', () => {
    const { tarballPath } = createFixture({
      packageJsonOverrides: {
        files: [
          'build/**/*',
          'spec/**/*',
          'CHANGELOG.md',
          'LICENSE',
          'README.md',
        ],
      },
      extraFiles: {
        'spec/v2/44.4.json': '{"openapi": "3.0.0"}',
      },
    });

    const result = verifyPack(tarballPath, { expectedVersion: '3.0.0' });
    expect(result.ok).toBe(false);
    const failure = result.results.find(r => r.status === 'FAIL' && r.message.includes('spec/**'));
    expect(failure).toBeDefined();
  });

  it('fails when CHANGELOG.md is missing', () => {
    const { tarballPath } = createFixture({
      omitFiles: ['CHANGELOG.md'],
      packageJsonOverrides: {
        files: [
          'build/**/*',
          'LICENSE',
          'README.md',
        ],
      },
    });

    const result = verifyPack(tarballPath, { expectedVersion: '3.0.0' });
    expect(result.ok).toBe(false);
    const failure = result.results.find(r => r.status === 'FAIL' && r.message.includes('CHANGELOG.md'));
    expect(failure).toBeDefined();
  });

  it('fails on version mismatch', () => {
    const { tarballPath } = createFixture();

    const result = verifyPack(tarballPath, { expectedVersion: '9.9.9' });
    expect(result.ok).toBe(false);
    const failure = result.results.find(r => r.status === 'FAIL' && r.message.includes('version mismatch'));
    expect(failure).toBeDefined();
  });

  it('fails when @google-cloud/firestore is in dependencies', () => {
    const { tarballPath } = createFixture({
      packageJsonOverrides: {
        dependencies: {
          '@google-cloud/firestore': '^8.7.1',
          axios: '^1.20.0',
        },
      },
    });

    const result = verifyPack(tarballPath, { expectedVersion: '3.0.0' });
    expect(result.ok).toBe(false);
    const failure = result.results.find(r => r.status === 'FAIL' && r.message.includes('@google-cloud/firestore'));
    expect(failure).toBeDefined();
  });

  it('fails when optional peerDependenciesMeta is missing', () => {
    const { tarballPath } = createFixture({
      packageJsonOverrides: {
        peerDependenciesMeta: {
          vitest: {
            optional: true,
          },
          // omitted @google-cloud/firestore
        },
      },
    });

    const result = verifyPack(tarballPath, { expectedVersion: '3.0.0' });
    expect(result.ok).toBe(false);
    const failure = result.results.find(r => r.status === 'FAIL' && r.message.includes('peerDependenciesMeta'));
    expect(failure).toBeDefined();
  });

  it('fails on different repository.url', () => {
    const { tarballPath } = createFixture({
      packageJsonOverrides: {
        repository: {
          type: 'git',
          url: 'git+https://github.com/other-org/other-repo.git',
        },
      },
    });

    const result = verifyPack(tarballPath, { expectedVersion: '3.0.0' });
    expect(result.ok).toBe(false);
    const failure = result.results.find(r => r.status === 'FAIL' && r.message.includes('repository.url'));
    expect(failure).toBeDefined();
  });

  it('CLI exits 1 when tarball verification fails', () => {
    const { tarballPath } = createFixture({
      extraFiles: {
        'build/__tests__/setup.js': '// test setup helper',
      },
    });

    const cliScript = path.resolve('scripts/verify-pack.mjs');
    try {
      execFileSync('node', [cliScript, tarballPath, '3.0.0'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect.fail('Should have exited with status 1');
    } catch (err: unknown) {
      const spawnError = err as { status?: number; stdout?: Buffer | string };
      expect(spawnError.status).toBe(1);
      expect(spawnError.stdout?.toString()).toContain('FAIL');
    }
  });
});
