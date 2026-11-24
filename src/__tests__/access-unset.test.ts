/**
 * Pins the behavior the registry changes even when it is unset, so the changelog can state it and a later change cannot
 * silently alter it. Each test runs with MCP_ACCESS_REGISTRY_URL unset.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthHooks } from '../auth/types.js';
import { API_KEY, captureResponse, closeHarnesses, startHarness } from './support/access-harness.js';
import { REDIRECT } from './support/access-registry-fake.js';
import { openLoginPage, postTokenLogin, registerPublicClient, signInFull } from './support/http-session.js';

/** Identity keys a hook or a resumed sign-in tries to supply. The registry owns these names. */
const HOSTILE_EXTRA = {
  nsDomain: 'attacker.example',
  nsUser: 'mallory',
  nsScope: 'Super User',
  authRedirectUri: 'https://evil.example/cb',
};
const RESERVED_KEYS = ['nsDomain', 'nsUser', 'nsScope', 'authRedirectUri'] as const;

/** The strict identity lookup, which is private to the provider. Tests reach it the way auth-hooks.test.ts does. */
interface StrictIdentityLookup {
  detectNsUserInfo(token: string, url: string, username: string, strict: boolean): Promise<unknown>;
}

describe('registry unset: behavior the registry changes', () => {
  afterEach(async () => {
    await closeHarnesses();
  });

  it('drops reserved identity keys that a hook supplies at sign-in', async () => {
    const hooks: AuthHooks = {
      async onLogin() {
        return { kind: 'continue', tokenExtra: { ...HOSTILE_EXTRA } };
      },
      async onVerify() {
        return {};
      },
    };
    const h = await startHarness({ registry: false, hooks });

    const tokens = await signInFull(h.app, h.fake.origin, 'tok-alice', REDIRECT);
    const info = await h.authProvider.verifyAccessToken(tokens.accessToken);

    for (const key of RESERVED_KEYS) expect(info.extra?.[key], key).toBeUndefined();
  });

  it('drops reserved identity keys that a resumed sign-in supplies', async () => {
    const hooks: AuthHooks = {
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
    const h = await startHarness({ registry: false, hooks });
    const clientId = await registerPublicClient(h.app, REDIRECT);
    const authState = await openLoginPage(h.app, clientId, REDIRECT);
    const interstitial = await postTokenLogin(h.app, authState, h.fake.origin, 'tok-alice');
    const resumeToken = interstitial.text.match(/name="resume_token" value="([^"]+)"/)?.[1];
    if (resumeToken === undefined) throw new Error('Missing resume_token in interstitial HTML');

    const resumed = captureResponse();
    await h.authProvider.resumeLogin(resumed.res, resumeToken, { ...HOSTILE_EXTRA });
    const code = new URL(resumed.seen.location).searchParams.get('code');
    if (code === null) throw new Error('Missing code in resumed redirect');
    const client = await h.authProvider.clientsStore.getClient(clientId);
    if (client === undefined) throw new Error('Client not registered');
    const tokens = await h.authProvider.exchangeAuthorizationCode(client, code);
    const info = await h.authProvider.verifyAccessToken(tokens.access_token);

    for (const key of RESERVED_KEYS) expect(info.extra?.[key], key).toBeUndefined();
  });

  it('keeps the strict identity failures an Error with their messages', async () => {
    const h = await startHarness({ registry: false });
    const seam = h.authProvider as unknown as StrictIdentityLookup;
    const strictLookup = seam.detectNsUserInfo.bind(h.authProvider);

    const noDomain = await strictLookup('tok-carol', h.fake.origin, 'carol', true).catch((err: unknown) => err);
    expect(noDomain).toBeInstanceOf(Error);
    expect(String(noDomain)).toBe('Error: Unable to verify account identity');

    const apiKey = await strictLookup(API_KEY, h.fake.origin, 'key-ops', true).catch((err: unknown) => err);
    expect(apiKey).toBeInstanceOf(Error);
    expect(String(apiKey)).toBe('Error: API key does not establish a verified user identity');
  });
});
