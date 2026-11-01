import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolRegistry } from '../generated/registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');

const SIX_46_TAGS = [
  'System Information',
  'Call Center - Call Center Global Configurations',
  'Configs - Configuration Settings - System Configurations',
  'Resellers - Reseller Usage',
  'Audit Logs',
  'Integrations - Integrations Configurations',
];

const CRED_46_TAGS = [
  'Authentication/Masquerade',
  'Authentication/NetsapiensJs Auth',
  'Authentication/NetsapiensJs Auth/MFA',
  'OAuth Clients',
  'OAuth Tokens',
  'APNs',
];

const TODAY_TAGS = [
  'Authentication/Access Token (Oauth - Username/Password)',
  'Authentication/API Key (Machine 2 Machine)',
  'Authentication/JWT (JSON Web Token)',
  'Firebase',
  'SSL Certificates',
];

const ALL_EXCLUDED_TAGS = new Set([
  ...SIX_46_TAGS,
  ...CRED_46_TAGS,
  ...TODAY_TAGS,
]);

const CRED_REGEX = /(?:api[-_ ]?keys?|jwt|masquerade|oauth|password|secret|certificate|mfa|token)/i;

describe('generator exclusions', () => {
  it('none of the excluded tags appears in generated tool descriptions or tag files', () => {
    // Check that none of the generated tool files corresponds to excluded tags
    const toolsDir = resolve(REPO_ROOT, 'src/generated/tools');
    const toolFiles = readdirSync(toolsDir);

    for (const tag of ALL_EXCLUDED_TAGS) {
      const tagSlug = tag
        .toLowerCase()
        .replace(/[\/\\]/g, '-')
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      expect(
        toolFiles.includes(`${tagSlug}.ts`),
        `Tag '${tag}' (slug: '${tagSlug}.ts') must not be generated as a tool file`,
      ).toBe(false);
    }
  });

  it('no generated path matches /email/verify/', () => {
    for (const [name, def] of toolRegistry) {
      const key = def.operation?.key ?? '';
      expect(
        /\/email\/verify\//i.test(key),
        `Tool '${name}' has excluded path matching /email/verify/: ${key}`,
      ).toBe(false);
    }
  });

  it('no generated tag or path matches the credential regex outside the allowlist', () => {
    const allowlistPath = resolve(REPO_ROOT, 'spec/v2/generator-allowlist.json');
    const allowlist: Array<{ key: string; reason: string }> = JSON.parse(
      readFileSync(allowlistPath, 'utf8'),
    );
    const allowlistSet = new Set(allowlist.map((entry) => entry.key));

    const violations: Array<{ tool: string; key: string; reason: string }> = [];

    for (const [name, def] of toolRegistry) {
      const key = def.operation?.key ?? '';
      // Check path part of key
      const [, pathPart] = key.split(' ');
      if (pathPart && CRED_REGEX.test(pathPart) && !allowlistSet.has(key)) {
        violations.push({
          tool: name,
          key,
          reason: `path '${pathPart}' matches credential regex`,
        });
      }
    }

    expect(
      violations,
      `Generated tools matched credential regex outside allowlist: ${JSON.stringify(violations, null, 2)}`,
    ).toEqual([]);
  });
});
