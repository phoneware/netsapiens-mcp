import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateReadmeFacts } from '../../scripts/readme-facts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

describe('README and documentation facts', () => {
  const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  const changelog = readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
  const security = readFileSync(path.join(repoRoot, 'SECURITY.md'), 'utf8');
  const contributing = readFileSync(path.join(repoRoot, 'CONTRIBUTING.md'), 'utf8');
  const allDocs = [readme, changelog, security, contributing];

  it('contains no em-dashes or en-dashes', () => {
    const dashRegex = /[\u2013\u2014]/;
    for (const doc of allDocs) {
      expect(dashRegex.test(doc)).toBe(false);
    }
  });

  it('mentions phoneware only in github.com/phoneware repository URLs', () => {
    for (const [filename, content] of [
      ['README.md', readme],
      ['CHANGELOG.md', changelog],
      ['SECURITY.md', security],
      ['CONTRIBUTING.md', contributing],
    ]) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/phoneware/i.test(line)) {
          expect(
            line,
            `Unexpected phoneware reference in ${filename}:${i + 1}: ${line}`,
          ).toMatch(/github\.com\/phoneware\/netsapiens-mcp/i);
        }
      }
    }
  });

  it('matches generated readme facts for version matrix and tables', () => {
    const facts = generateReadmeFacts();

    // Version matrix block
    const vmBlock = readme.match(/<!-- facts:version-matrix -->([\s\S]*?)<!-- \/facts:version-matrix -->/);
    expect(vmBlock).toBeTruthy();
    expect(vmBlock![1].trim()).toBe(facts.versionMatrix.trim());

    // Backends table block
    const beBlock = readme.match(/<!-- facts:backends -->([\s\S]*?)<!-- \/facts:backends -->/);
    expect(beBlock).toBeTruthy();
    expect(beBlock![1].trim()).toBe(facts.backendsTable.trim());

    // Firestore collections block
    const fcBlock = readme.match(/<!-- facts:firestore-collections -->([\s\S]*?)<!-- \/facts:firestore-collections -->/);
    expect(fcBlock).toBeTruthy();
    expect(fcBlock![1].trim()).toBe(facts.firestoreCollectionsTable.trim());

    // Store env table block
    const seBlock = readme.match(/<!-- facts:store-env -->([\s\S]*?)<!-- \/facts:store-env -->/);
    expect(seBlock).toBeTruthy();
    expect(seBlock![1].trim()).toBe(facts.storeEnvTable.trim());
  });

  it('fails if a fact block is tampered with', () => {
    const facts = generateReadmeFacts();
    const tamperedMatrix = facts.versionMatrix.replace(/\d+/, '99999');
    expect(tamperedMatrix).not.toBe(facts.versionMatrix);
  });
});
