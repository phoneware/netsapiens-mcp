import { describe, expect, it } from 'vitest';
import { assertMutatingClaims } from '../protected-migration-context.js';

const HTTPS_AUDIENCE = 'https://iam.googleapis.com/projects/859122914438/locations/global/workloadIdentityPools/github/providers/github';
const BARE_AUDIENCE = 'projects/859122914438/locations/global/workloadIdentityPools/github/providers/github';
const CREDENTIAL_AUDIENCE = '//iam.googleapis.com/projects/859122914438/locations/global/workloadIdentityPools/github/providers/github';

type Claims = Record<string, unknown>;

function validClaims(): Claims {
  return {
    iss: 'https://token.actions.githubusercontent.com',
    aud: HTTPS_AUDIENCE,
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
  };
}

function tokenFrom(claims: Claims): Buffer {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return Buffer.from(`${header}.${payload}.signature`, 'utf8');
}

describe('mutating production OIDC claims', () => {
  it('accepts the https canonical provider audience with the exact dispatch claims', () => {
    expect(assertMutatingClaims(tokenFrom(validClaims()))).toEqual({ runId: '123456', runAttempt: '1' });
  });

  it.each([
    ['bare project provider audience', { aud: BARE_AUDIENCE }],
    ['// credential audience', { aud: CREDENTIAL_AUDIENCE }],
    ['wrong issuer', { iss: 'https://example.invalid' }],
    ['wrong repository_id', { repository_id: '1' }],
    ['wrong repository_owner_id', { repository_owner_id: '1' }],
    ['wrong repository', { repository: 'phoneware/other' }],
    ['wrong ref', { ref: 'refs/heads/feature' }],
    ['wrong event_name', { event_name: 'push' }],
    ['wrong workflow_ref', { workflow_ref: 'phoneware/monorepo/.github/workflows/other.yml@refs/heads/main' }],
    ['wrong environment', { environment: 'staging' }],
    ['expired exp', { exp: Math.floor(Date.now() / 1000) - 60 }],
    ['non-decimal run_id', { run_id: '12a' }],
    ['non-decimal run_attempt', { run_attempt: '0' }],
  ])('refuses a token with %s', (_label, mutation) => {
    expect(() => assertMutatingClaims(tokenFrom({ ...validClaims(), ...mutation }))).toThrow(/OIDC claims/);
  });
});
