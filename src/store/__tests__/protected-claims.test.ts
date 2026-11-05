import { describe, expect, it } from 'vitest';
import { assertMutatingClaims } from '../protected-migration-context.js';

const HTTPS_AUDIENCE = 'https://iam.googleapis.com/projects/859122914438/locations/global/workloadIdentityPools/github/providers/github';
const BARE_AUDIENCE = 'projects/859122914438/locations/global/workloadIdentityPools/github/providers/github';
const CREDENTIAL_AUDIENCE = '//iam.googleapis.com/projects/859122914438/locations/global/workloadIdentityPools/github/providers/github';

function tokenWithAudience(aud: string): Buffer {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://token.actions.githubusercontent.com',
    aud,
    repository_id: '1278135054',
    repository_owner_id: '13560178',
    repository: 'phoneware/monorepo',
    ref: 'refs/heads/main',
    event_name: 'workflow_dispatch',
    workflow_ref: 'phoneware/monorepo/.github/workflows/deploy.yml@refs/heads/main',
    environment: 'production',
    exp: Math.floor(Date.now() / 1000) + 600,
    run_id: '123456',
    run_attempt: '1',
  })).toString('base64url');
  return Buffer.from(`${header}.${payload}.signature`, 'utf8');
}

describe('mutating production OIDC audience', () => {
  it('accepts the https canonical provider audience', () => {
    expect(assertMutatingClaims(tokenWithAudience(HTTPS_AUDIENCE))).toEqual({ runId: '123456', runAttempt: '1' });
  });

  it('refuses the bare project provider audience', () => {
    expect(() => assertMutatingClaims(tokenWithAudience(BARE_AUDIENCE))).toThrow(/OIDC claims/);
  });

  it('refuses the // credential audience', () => {
    expect(() => assertMutatingClaims(tokenWithAudience(CREDENTIAL_AUDIENCE))).toThrow(/OIDC claims/);
  });
});
