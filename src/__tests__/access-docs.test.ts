import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const docPath = path.join(repoRoot, 'docs/access-registry.md');
const fixturesDir = path.join(repoRoot, 'src/__tests__/fixtures/access');
const doc = readFileSync(docPath, 'utf8');
const fixtures = readdirSync(fixturesDir)
  .filter((file) => file.endsWith('.json'))
  .sort();

describe('docs/access-registry.md', () => {
  it('contains no em-dashes or en-dashes', () => {
    expect(/[\u2013\u2014]/.test(doc)).toBe(false);
  });

  it('mentions the product name only inside a repository URL', () => {
    doc.split('\n').forEach((line, index) => {
      if (/phoneware/i.test(line)) {
        expect(line, `docs/access-registry.md:${index + 1}`).toMatch(/github\.com\/phoneware\/netsapiens-mcp/i);
      }
    });
  });

  it('quotes every valid fixture verbatim, so the examples are the tested bytes', () => {
    const valid = fixtures.filter((file) => !file.startsWith('invalid-'));
    expect(valid.length).toBeGreaterThan(0);
    for (const file of valid) {
      const text = readFileSync(path.join(fixturesDir, file), 'utf8').trimEnd();
      expect(doc, file).toContain(text);
    }
  });

  it('names every invalid fixture where it explains the rejection', () => {
    const invalid = fixtures.filter((file) => file.startsWith('invalid-'));
    expect(invalid.length).toBeGreaterThan(0);
    for (const file of invalid) {
      expect(doc, file).toContain(file);
    }
  });

  it('has the sections the implementation is held to', () => {
    for (const heading of [
      '## Request',
      '## Decision response',
      '## Status handling',
      '## Platforms and redirect URIs',
      '## Effective policy',
      '## Identity',
      '## Caching and fail-closed',
      '## Auth modes',
    ]) {
      expect(doc, heading).toContain(`\n${heading}\n`);
    }
  });
});
