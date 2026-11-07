import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { extractChangelogSection } from '../../scripts/changelog-section.mjs';

const SAMPLE_CHANGELOG = `# Changelog

All notable changes to this project will be documented in this file.

## 3.0.0 - 2026-10-31

### Added
- Multi-backend persistence (sqlite, firestore, memory)
- Full store conformance test suite

### Changed
- Dropped @google-cloud/firestore as hard dependency

## 2.3.1

### Fixed
- Token refresh concurrency fix

## [2.3.0] - 2026-09-15

### Added
- Initial release candidate
`;

describe('changelog-section', () => {
  let tempDir: string;
  let changelogPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-test-'));
    changelogPath = path.join(tempDir, 'CHANGELOG.md');
    fs.writeFileSync(changelogPath, SAMPLE_CHANGELOG, 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('extractChangelogSection function', () => {
    it('extracts section under ## <version> up to the next ## heading', () => {
      const section = extractChangelogSection(SAMPLE_CHANGELOG, '3.0.0');
      expect(section).toBe(
        `### Added
- Multi-backend persistence (sqlite, firestore, memory)
- Full store conformance test suite

### Changed
- Dropped @google-cloud/firestore as hard dependency`
      );
      expect(section).not.toContain('2.3.1');
    });

    it('extracts an intermediate section correctly', () => {
      const section = extractChangelogSection(SAMPLE_CHANGELOG, '2.3.1');
      expect(section).toBe(
        `### Fixed
- Token refresh concurrency fix`
      );
      expect(section).not.toContain('3.0.0');
      expect(section).not.toContain('2.3.0');
    });

    it('extracts the last section up to EOF', () => {
      const section = extractChangelogSection(SAMPLE_CHANGELOG, '2.3.0');
      expect(section).toBe(
        `### Added
- Initial release candidate`
      );
    });

    it('handles version string with leading v', () => {
      const section = extractChangelogSection(SAMPLE_CHANGELOG, 'v3.0.0');
      expect(section).toContain('Multi-backend persistence');
    });

    it('returns null when version is not present', () => {
      const section = extractChangelogSection(SAMPLE_CHANGELOG, '4.0.0');
      expect(section).toBeNull();
    });

    it('throws error when version parameter is empty', () => {
      expect(() => extractChangelogSection(SAMPLE_CHANGELOG, '')).toThrow(/required/);
    });

    it('handles bracketed versions in heading', () => {
      const changelog = `# Notes\n\n## [1.2.3] - 2026-01-01\n\n- Fixes\n\n## [1.2.2]\n\n- Old`;
      const section = extractChangelogSection(changelog, '1.2.3');
      expect(section).toBe('- Fixes');
    });
  });

  describe('CLI execution', () => {
    const cliScript = path.resolve('scripts/changelog-section.mjs');

    it('prints extracted section to stdout and exits 0', () => {
      const stdout = execFileSync('node', [cliScript, '3.0.0', changelogPath], {
        encoding: 'utf8',
      });
      expect(stdout.trim()).toBe(
        `### Added
- Multi-backend persistence (sqlite, firestore, memory)
- Full store conformance test suite

### Changed
- Dropped @google-cloud/firestore as hard dependency`
      );
    });

    it('strips leading v when passed in CLI', () => {
      const stdout = execFileSync('node', [cliScript, 'v2.3.1', changelogPath], {
        encoding: 'utf8',
      });
      expect(stdout.trim()).toBe(
        `### Fixed
- Token refresh concurrency fix`
      );
    });

    it('exits 1 with error message when version is not found', () => {
      expect(() => {
        execFileSync('node', [cliScript, '9.9.9', changelogPath], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }).toThrow();

      try {
        execFileSync('node', [cliScript, '9.9.9', changelogPath], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err: unknown) {
        const spawnError = err as { status?: number; stderr?: Buffer | string };
        expect(spawnError.status).toBe(1);
        expect(spawnError.stderr?.toString()).toContain('Version 9.9.9 not found');
      }
    });

    it('exits 1 when version argument is missing', () => {
      try {
        execFileSync('node', [cliScript], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err: unknown) {
        const spawnError = err as { status?: number; stderr?: Buffer | string };
        expect(spawnError.status).toBe(1);
        expect(spawnError.stderr?.toString()).toContain('Usage:');
      }
    });

    it('exits 1 when CHANGELOG.md file is missing', () => {
      const nonExistent = path.join(tempDir, 'NO_SUCH_CHANGELOG.md');
      try {
        execFileSync('node', [cliScript, '3.0.0', nonExistent], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err: unknown) {
        const spawnError = err as { status?: number; stderr?: Buffer | string };
        expect(spawnError.status).toBe(1);
        expect(spawnError.stderr?.toString()).toContain('not found');
      }
    });

    it('reads CHANGELOG_PATH from environment variable', () => {
      const stdout = execFileSync('node', [cliScript, '2.3.1'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          CHANGELOG_PATH: changelogPath,
        },
      });
      expect(stdout.trim()).toContain('Token refresh concurrency fix');
    });
  });
});
