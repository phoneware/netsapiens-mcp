import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { AccessPolicyV1 } from '../access/contract.js';
import type { AuthHooks } from '../auth/types.js';
import { NetSapiensAuthProvider } from '../auth/netsapiens-auth-provider.js';
import { logger } from '../utils/logger.js';
import { deriveStoreKey } from '../store/codec.js';
import { createMemoryStore } from '../store/memory.js';
import {
  API_KEY,
  NS_SECRET,
  captureResponse,
  closeHarnesses,
  startFakeNs,
  startHarness,
  startLoopbackRegistry,
  toolTraffic,
  type Harness,
} from './support/access-harness.js';
import { OTHER_REDIRECT, REDIRECT, SUBJECT, TENANT, policy, type Answer } from './support/access-registry-fake.js';
import {
  bodyString,
  openLoginPage,
  postTokenLogin,
  refreshGrant,
  registerPublicClient,
  signIn,
  signInFull,
} from './support/http-session.js';

const NOT_ENABLED = 'Your organization has not enabled this AI connector for your account.';
const APP_NOT_APPROVED = 'This AI app is not approved for your organization.';
const COULD_NOT_VERIFY = 'We could not verify your account. Sign in with your own user credentials.';
const UNAVAILABLE = 'Sign-in is temporarily unavailable. Try again in a few minutes.';

/** The identity the session must carry, whatever the hooks supplied. */
const VERIFIED_EXTRA = {
  nsDomain: TENANT,
  nsUser: 'alice',
  nsScope: 'Office Manager',
  authRedirectUri: REDIRECT,
};

function allow(patch: Partial<AccessPolicyV1> = {}, revision = 'rev-1'): Answer {
  return { decision: 'allow', revision, policy: policy(patch) };
}

/** Starts a login as a NetSapiens token holder on an AI app's redirect, and returns the login response. */
async function attemptLogin(h: Harness, nsToken: string, redirectUri = REDIRECT) {
  const clientId = await registerPublicClient(h.app, redirectUri);
  const authState = await openLoginPage(h.app, clientId, redirectUri);
  return postTokenLogin(h.app, authState, h.fake.origin, nsToken);
}

function resumeTokenFrom(html: string): string {
  const token = html.match(/name="resume_token" value="([^"]+)"/)?.[1];
  if (!token) throw new Error('Missing resume_token in interstitial HTML');
  return token;
}

/** A refusal leaves no authorization code and reaches no NetSapiens tool. */
function expectRefusal(h: Harness, login: { status: number; text: string }, status: number, copy: string): void {
  expect(login.status).toBe(status);
  expect(login.text).toContain(copy);
  expect(h.authCodePuts).not.toHaveBeenCalled();
  expect(toolTraffic(h.fake)).toEqual([]);
}

function interstitialHooks(): AuthHooks {
  return {
    async onLogin() {
      return {
        kind: 'interstitial',
        html: '<form action="/enroll"><input type="hidden" name="resume_token" value="{{RESUME_TOKEN}}"><button>Continue</button></form>',
      };
    },
    async onVerify() {
      return {};
    },
  };
}

afterEach(async () => {
  await closeHarnesses();
  vi.restoreAllMocks();
});

describe('registry sign-in (E1)', () => {
  it('lets an enrolled user on an approved redirect get a code', async () => {
    const h = await startHarness();
    h.registry.set(SUBJECT, allow());

    const login = await attemptLogin(h, 'tok-alice');

    expect(login.status).toBe(302);
    expect(login.headers.location.startsWith(`${REDIRECT}?code=`)).toBe(true);
    expect(h.authCodePuts).toHaveBeenCalledTimes(1);
  });

  it('refuses a tenant that is not enrolled, before any code is stored or any tool is reached', async () => {
    const h = await startHarness();

    expectRefusal(h, await attemptLogin(h, 'tok-alice'), 403, NOT_ENABLED);
    expect(h.registry.seen).toHaveLength(1);
  });

  it('refuses a user who is not on the enrolled list, and still admits a listed user', async () => {
    const h = await startHarness();
    h.registry.set('bob@domain.com', { decision: 'deny', reason: 'subject_not_enabled' });
    h.registry.set(SUBJECT, allow());

    expectRefusal(h, await attemptLogin(h, 'tok-bob'), 403, NOT_ENABLED);

    const listed = await attemptLogin(h, 'tok-alice');
    expect(listed.status).toBe(302);
    expect(listed.headers.location.startsWith(`${REDIRECT}?code=`)).toBe(true);
    expect(h.authCodePuts).toHaveBeenCalledTimes(1);
  });

  it('refuses an AI app whose redirect the policy does not approve', async () => {
    const h = await startHarness();
    h.registry.set(SUBJECT, allow({ platforms: [OTHER_REDIRECT] }));

    expectRefusal(h, await attemptLogin(h, 'tok-alice'), 403, APP_NOT_APPROVED);
  });

  it('answers 503 when the registry is down and nothing is cached', async () => {
    const h = await startHarness();
    h.registry.down = true;

    expectRefusal(h, await attemptLogin(h, 'tok-alice'), 503, UNAVAILABLE);
  });

  it('treats a policy the compiler rejects as unavailable, which is closed', async () => {
    const h = await startHarness();
    h.registry.set(SUBJECT, allow({ tools: { allow: ['@curated'], deny: ['@no-such-group'] } }));

    expectRefusal(h, await attemptLogin(h, 'tok-alice'), 503, UNAVAILABLE);
  });

  it('refuses an API key with no user record before the registry is asked', async () => {
    const h = await startHarness();
    h.registry.set(SUBJECT, allow());

    expectRefusal(h, await attemptLogin(h, API_KEY), 403, COULD_NOT_VERIFY);
    expect(h.registry.seen).toEqual([]);
  });

  it('refuses a user record that names no domain as an unverified identity', async () => {
    const h = await startHarness();
    h.registry.set('carol@domain.com', allow());

    expectRefusal(h, await attemptLogin(h, 'tok-carol'), 403, COULD_NOT_VERIFY);
    expect(h.registry.seen).toEqual([]);
  });

  it('decides again when a resume token is redeemed, so a denial after the interstitial stops the sign-in', async () => {
    const h = await startHarness({ hooks: interstitialHooks() });
    h.registry.set(SUBJECT, allow());

    const first = await attemptLogin(h, 'tok-alice');
    expect(first.status).toBe(200);
    const granted = captureResponse();
    await h.authProvider.resumeLogin(granted.res, resumeTokenFrom(first.text));
    expect(granted.seen.location.startsWith(`${REDIRECT}?code=`)).toBe(true);
    expect(h.authCodePuts).toHaveBeenCalledTimes(1);

    const second = await attemptLogin(h, 'tok-alice');
    expect(second.status).toBe(200);
    h.registry.set(SUBJECT, { decision: 'deny', reason: 'subject_not_enabled' });
    const refused = captureResponse();
    await h.authProvider.resumeLogin(refused.res, resumeTokenFrom(second.text));
    expect(refused.seen.status).toBe(403);
    expect(refused.seen.html).toContain(NOT_ENABLED);
    expect(refused.seen.location).toBe('');
    expect(h.authCodePuts).toHaveBeenCalledTimes(1);
  });

  it('ignores reserved session keys a hook supplies and stores the NetSapiens-verified identity', async () => {
    const h = await startHarness({
      hooks: {
        async onLogin() {
          return {
            kind: 'continue',
            tokenExtra: {
              nsDomain: 'attacker.example',
              nsUser: 'mallory',
              nsScope: 'Super User',
              authRedirectUri: 'https://evil.example/cb',
            },
          };
        },
        async onVerify() {
          return {};
        },
      },
    });
    h.registry.set(SUBJECT, allow());

    const token = await signIn(h.app, h.fake.origin, 'tok-alice', REDIRECT);

    expect((await h.authProvider.verifyAccessToken(token)).extra).toMatchObject(VERIFIED_EXTRA);
  });

  it('keeps the reserved keys through the store, a refresh, and the next verification', async () => {
    const h = await startHarness();
    h.registry.set(SUBJECT, allow());
    const tokens = await signInFull(h.app, h.fake.origin, 'tok-alice', REDIRECT);
    expect((await h.authProvider.verifyAccessToken(tokens.accessToken)).extra).toMatchObject(VERIFIED_EXTRA);

    const refreshed = await refreshGrant(h.app, tokens.clientId, tokens.refreshToken).expect(200);
    const info = await h.authProvider.verifyAccessToken(bodyString(refreshed.body, 'access_token'));

    expect(info.extra).toMatchObject(VERIFIED_EXTRA);
  });

  it('logs the sign-in decision and never the NetSapiens token', async () => {
    const info = vi.spyOn(logger, 'info');
    const h = await startHarness();
    h.registry.set(SUBJECT, allow());

    expect((await attemptLogin(h, 'tok-alice')).status).toBe(302);

    const decisions = info.mock.calls.filter(([message]) => message === 'Access sign-in').map(([, context]) => context);
    expect(decisions).toEqual([
      expect.objectContaining({ outcome: 'allow', tenant: TENANT, subject: SUBJECT, redirectUri: REDIRECT, revision: 'rev-1' }),
    ]);
    expect(JSON.stringify(info.mock.calls)).not.toContain('tok-alice');
  });
});

describe('registry configuration at startup', () => {
  it('reports the registry on /health only when it is configured', async () => {
    const unset = await startHarness({ registry: false });
    expect((await request(unset.app).get('/health')).body).not.toHaveProperty('accessRegistry');
    await unset.close();

    const set = await startHarness();
    expect((await request(set.app).get('/health')).body).toMatchObject({ accessRegistry: 'enforced' });
  });

  it('stops startup on a malformed registry configuration', async () => {
    await expect(
      startHarness({ registry: false, env: { MCP_ACCESS_REGISTRY_URL: 'https://registry.example.com' } }),
    ).rejects.toThrow('ConfigError: MCP_ACCESS_REGISTRY_AUTH is required');
    await expect(
      startHarness({
        registry: false,
        env: { MCP_ACCESS_REGISTRY_URL: 'http://registry.example.com', MCP_ACCESS_REGISTRY_AUTH: 'bearer', MCP_ACCESS_REGISTRY_TOKEN: 'x' },
      }),
    ).rejects.toThrow('ConfigError: MCP_ACCESS_REGISTRY_URL must use https');
    await expect(
      startHarness({
        registry: false,
        env: { MCP_ACCESS_REGISTRY_URL: 'https://registry.example.com', MCP_ACCESS_REGISTRY_AUTH: 'bearer' },
      }),
    ).rejects.toThrow('ConfigError: MCP_ACCESS_REGISTRY_TOKEN is required');
  });

  it('refuses to combine a caller-built provider with a registry, which it could not enforce', async () => {
    const fake = await startFakeNs();
    const store = createMemoryStore({ namespace: 'test', key: deriveStoreKey(NS_SECRET) });
    try {
      const provider = new NetSapiensAuthProvider({
        nsApiUrl: fake.origin,
        platforms: [{ id: 'default', label: 'fake', apiUrl: fake.origin }],
        authMode: 'token',
        store,
      });
      await expect(startHarness({ fake, store, authProvider: provider })).rejects.toThrow('ConfigError');
    } finally {
      await store.close();
      await fake.close();
    }
  });

  it('builds the enforcer from the environment and asks the registry it names', async () => {
    const loopback = await startLoopbackRegistry((query) =>
      query.get('subject') === SUBJECT ? allow() : { decision: 'deny', reason: 'subject_not_enabled' },
    );
    try {
      const h = await startHarness({
        registry: false,
        env: { MCP_ACCESS_REGISTRY_URL: loopback.url, MCP_ACCESS_REGISTRY_AUTH: 'none' },
      });

      expectRefusal(h, await attemptLogin(h, 'tok-bob'), 403, NOT_ENABLED);
      const granted = await attemptLogin(h, 'tok-alice');

      expect(granted.status).toBe(302);
      expect(granted.headers.location.startsWith(`${REDIRECT}?code=`)).toBe(true);
      expect(loopback.queries.map((query) => query.get('subject'))).toEqual(['bob@domain.com', SUBJECT]);
      expect(loopback.queries[0].get('tenant')).toBe(TENANT);
      expect(loopback.queries[0].get('platform')).toBe(h.fake.origin);
      expect((await request(h.app).get('/health')).body).toMatchObject({ accessRegistry: 'enforced' });
    } finally {
      await loopback.close();
    }
  });
});
