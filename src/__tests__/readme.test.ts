import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { generateReadmeFacts } from '../../scripts/readme-facts.js';
import { startFakeNetSapiens } from '../../scripts/fake-netsapiens/index.mjs';

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

    // Roles hierarchy block
    const roleBlock = readme.match(/<!-- facts:roles -->([\s\S]*?)<!-- \/facts:roles -->/);
    expect(roleBlock).toBeTruthy();
    expect(roleBlock![1].trim()).toBe(facts.rolesTable.trim());

    // Full env table block
    const seBlock = readme.match(/<!-- facts:env-table -->([\s\S]*?)<!-- \/facts:env-table -->/);
    expect(seBlock).toBeTruthy();
    expect(seBlock![1].trim()).toBe(facts.envTable.trim());
  });

  it('exercises quickstart stdio invocation against fake NetSapiens', async () => {
    const fake = await startFakeNetSapiens({
      apiVersion: '44.4.10',
      tokens: {
        'test-token': {
          login: 'user@domain.com',
          user: 'user',
          domain: 'domain.com',
          'user-scope': 'Super User',
        },
      },
    });

    const testHome = mkdtempSync(join(tmpdir(), 'nsmcp-readme-stdio-'));
    try {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: repoRoot,
        env: {
          PATH: process.env.PATH,
          HOME: testHome,
          USERPROFILE: testHome,
          SystemRoot: process.env.SystemRoot,
          MCP_TRANSPORT: 'stdio',
          NETSAPIENS_API_URL: fake.origin,
          NETSAPIENS_API_TOKEN: 'test-token',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });

      const initReq = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      }) + '\n';
      child.stdin.write(initReq);

      for (let i = 0; i < 40; i++) {
        if (stdout.includes('"result"')) break;
        await delay(50);
      }

      expect(stdout).toContain('"protocolVersion"');
      child.kill();
    } finally {
      await fake.close();
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it('fails if a fact block is tampered with', () => {
    const facts = generateReadmeFacts();
    const tamperedMatrix = facts.versionMatrix.replace(/\d+/, '99999');
    expect(tamperedMatrix).not.toBe(facts.versionMatrix);
  });
});
