import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { validateCloudBuildSecrets } from '../utils/cloudbuild-validator.js';

describe('cloudbuild.yaml secrets regression guard', () => {
  const repoRoot = resolve(__dirname, '../../');
  const cloudBuildPath = resolve(repoRoot, 'cloudbuild.yaml');

  it('validates that the repository cloudbuild.yaml has zero plaintext secret violations', () => {
    expect(existsSync(cloudBuildPath)).toBe(true);
    const content = readFileSync(cloudBuildPath, 'utf8');
    const violations = validateCloudBuildSecrets(content);

    expect(violations).toEqual([]);
  });

  it('detects and fails on the plaintext secrets present in commit c3788b9', () => {
    let oldContent: string | null = null;
    try {
      oldContent = execSync('git show c3788b9:cloudbuild.yaml', {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      // In shallow clone environments where c3788b9 is not available, oldContent remains null
    }

    if (oldContent) {
      const violations = validateCloudBuildSecrets(oldContent);
      expect(violations.length).toBeGreaterThanOrEqual(2);

      const keys = violations.map((v) => v.key);
      expect(keys).toContain('NETSAPIENS_OAUTH_CLIENT_SECRET');
      expect(keys).toContain('MCP_SESSION_SECRET');

      // Verify the reported reasons
      for (const v of violations) {
        expect(v.reason).toMatch(/must use Secret Manager/i);
      }
    }
  });

  it('rejects literal secrets passed via --update-env-vars', () => {
    const yaml = `
steps:
  - id: deploy
    name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    args:
      - 'run'
      - 'deploy'
      - 'svc'
      - '--update-env-vars=^;;^AUTH_TOKEN=literal-auth-token-1234;;NODE_ENV=production'
`;
    const violations = validateCloudBuildSecrets(yaml);
    expect(violations.length).toBe(1);
    expect(violations[0].key).toBe('AUTH_TOKEN');
  });

  it('rejects literal secrets passed via --set-env-vars', () => {
    const yaml = `
steps:
  - id: deploy
    name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    args:
      - 'run'
      - 'deploy'
      - 'svc'
      - '--set-env-vars=API_KEY=raw-key-value,NODE_ENV=production'
`;
    const violations = validateCloudBuildSecrets(yaml);
    expect(violations.length).toBe(1);
    expect(violations[0].key).toBe('API_KEY');
  });

  it('rejects unversioned or literal values in --update-secrets', () => {
    const yaml = `
steps:
  - id: deploy
    name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    args:
      - 'run'
      - 'deploy'
      - 'svc'
      - '--update-secrets=DB_PASSWORD=literalunversionedsecret'
`;
    const violations = validateCloudBuildSecrets(yaml);
    expect(violations.length).toBe(1);
    expect(violations[0].key).toBe('DB_PASSWORD');
    expect(violations[0].reason).toMatch(/Secret Manager reference/i);
  });

  it('accepts valid Secret Manager references with version tags in --update-secrets', () => {
    const yaml = `
steps:
  - id: deploy
    name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    args:
      - 'run'
      - 'deploy'
      - 'svc'
      - '--update-secrets=DB_PASSWORD=my-db-secret:latest,API_KEY=projects/123/secrets/my-api-key/versions/1'
`;
    const violations = validateCloudBuildSecrets(yaml);
    expect(violations).toEqual([]);
  });

  it('rejects secret variables defined in step env list', () => {
    const yaml = `
steps:
  - id: build
    name: 'node:18'
    env:
      - 'DEPLOY_TOKEN=inline-token-abc'
    args:
      - 'build'
`;
    const violations = validateCloudBuildSecrets(yaml);
    expect(violations.length).toBe(1);
    expect(violations[0].key).toBe('DEPLOY_TOKEN');
  });

  it('rejects secret variables defined in substitutions block', () => {
    const yaml = `
steps:
  - id: build
    name: 'node:18'
    args: ['echo', 'hi']
substitutions:
  _MASTER_KEY: 'some-key-value'
`;
    const violations = validateCloudBuildSecrets(yaml);
    expect(violations.length).toBe(1);
    expect(violations[0].key).toBe('_MASTER_KEY');
  });

  it('allows non-secret identifiers like CLIENT_ID, URL, and remove-env-vars', () => {
    const yaml = `
steps:
  - id: deploy
    name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    args:
      - 'run'
      - 'deploy'
      - 'svc'
      - '--remove-env-vars=NETSAPIENS_OAUTH_CLIENT_SECRET,MCP_SESSION_SECRET'
      - '--update-env-vars=^;;^NETSAPIENS_OAUTH_CLIENT_ID=\${_CLIENT_ID};;BASE_URL=https://example.com'
substitutions:
  _CLIENT_ID: my-client-id
`;
    const violations = validateCloudBuildSecrets(yaml);
    expect(violations).toEqual([]);
  });
});
