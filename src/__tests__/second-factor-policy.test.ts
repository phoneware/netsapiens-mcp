import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import type { Request, Response } from 'express';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError, ServerError, TemporarilyUnavailableError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { NetSapiensAuthProvider } from '../auth/netsapiens-auth-provider.js';
import { hasServerAssurance, parseSecondFactorPolicy, satisfiesSecondFactorPolicy, withAssurance, type SecondFactorPolicy, type AuthMethod } from '../auth/second-factor-policy.js';
import { createMemoryStore } from '../store/memory.js';
import { deriveStoreKey } from '../store/codec.js';
import { createApp } from '../http-server.js';

import type { AuthHooks } from '../auth/types.js';

// Tests replace private upstream calls to exercise the real sign-in orchestration.
type TestInternals = {
 nsPasswordGrant: (...args: never[]) => Promise<unknown>;
 nsMfaGrant: (...args: never[]) => Promise<unknown>;
 detectNsUserInfo: (...args: never[]) => Promise<unknown>;
 hooks?: AuthHooks;
};
const primary = 'https://primary.example.com';
const other = 'https://other.example.com';
const policy: SecondFactorPolicy = { tiers: ['system_admin', 'reseller', 'domain_admin'], acceptProviderSignIn: true, acceptPastedToken: false, applyToExistingSessions: true };
const client = { client_id: 'client', redirect_uris: ['http://localhost/callback'], token_endpoint_auth_method: 'none' } as OAuthClientInformationFull;

function response() {
 let html = '';
 let location = '';
 let status = 200;
 const res = {
  status: vi.fn((s: number) => { status = s; return res; }),
  set: vi.fn(() => res), type: vi.fn(() => res),
  send: vi.fn((s: string) => { html = s; return res; }),
  redirect: vi.fn((s: string) => { location = s; return res; }),
  get html() { return html; }, get location() { return location; }, get statusCode() { return status; },
 };
 return res;
}

function provider(config: SecondFactorPolicy | undefined = policy) {
 const store = createMemoryStore({ namespace: 'policy', key: deriveStoreKey('0123456789abcdef0123456789abcdef') });
 const instance = new NetSapiensAuthProvider({ nsApiUrl: primary, platforms: [
  { id: 'default', label: 'Primary', apiUrl: primary }, { id: 'other', label: 'Other', apiUrl: other },
 ], nsClientId: 'id', nsClientSecret: 'secret', store, secondFactorPolicy: config });
 return { instance, store };
}

async function state(instance: NetSapiensAuthProvider) {
 const res = response();
 await instance.authorize(client, { codeChallenge: 'challenge', redirectUri: 'http://localhost/callback' }, res as unknown as Response);
 return res.html.match(/name="auth_state" value="([^"]+)"/)![1];
}

function req(body: Record<string, string>): Request { return { body, headers: {} } as unknown as Request; }
function identity(scope: string) { return { user: 'alice', domain: 'example.com', scope, role: 'domain_admin', displayName: 'Alice', email: '', verifiedIdentity: true }; }

describe('second factor policy', () => {
 beforeEach(() => vi.stubEnv('MCP_SESSION_SECRET', '0123456789abcdef0123456789abcdef'));
 afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
 it('rejects malformed environment configuration before opening a store', async () => {
  vi.stubEnv('NETSAPIENS_API_URL', primary);
  vi.stubEnv('MCP_SECOND_FACTOR_POLICY', '{}');
  await expect(createApp()).rejects.toThrow('ConfigError: MCP_SECOND_FACTOR_POLICY');
 });

 it.each(['', '{', 'null', '[]', '{}', '{"tiers":[],"acceptProviderSignIn":true,"acceptPastedToken":false,"applyToExistingSessions":true}', '{"tiers":["admin"],"acceptProviderSignIn":true,"acceptPastedToken":false,"applyToExistingSessions":true}', '{"tiers":["reseller"],"acceptProviderSignIn":"true","acceptPastedToken":false,"applyToExistingSessions":true}', '{"tiers":["reseller"],"acceptProviderSignIn":true,"acceptPastedToken":false,"applyToExistingSessions":true,"typo":true}'])('rejects malformed policy %s', (raw) => {
  expect(() => parseSecondFactorPolicy(raw)).toThrow('ConfigError: MCP_SECOND_FACTOR_POLICY');
 });
 it('is disabled only when unset and validates programmatic options at construction', () => {
  expect(parseSecondFactorPolicy(undefined)).toBeUndefined();
  expect(parseSecondFactorPolicy(JSON.stringify(policy))).toEqual(policy);
  expect(() => provider({ ...policy, acceptPastedToken: 'false' } as unknown as SecondFactorPolicy)).toThrow('ConfigError: MCP_SECOND_FACTOR_POLICY');
 });
 it('distinguishes trusted provider sign-in from evidence of authenticator verification', () => {
  expect(satisfiesSecondFactorPolicy(policy, { authMethod: 'sso_google', authNsTotp: 'false' })).toBe(true);
  expect(satisfiesSecondFactorPolicy(policy, { authMethod: 'sso_office', authNsTotp: 'false' })).toBe(true);
  expect(satisfiesSecondFactorPolicy({ ...policy, acceptProviderSignIn: false }, { authMethod: 'sso_google', authNsTotp: 'true' })).toBe(false);
  expect(satisfiesSecondFactorPolicy(policy, { authNsTotp: 'true' })).toBe(false);
  expect(satisfiesSecondFactorPolicy(policy, { authMethod: 'unknown', authNsTotp: 'true' })).toBe(false);
 });
 it('binds assurance to identity, platform and every reserved field', () => {
  const secret = '0123456789abcdef0123456789abcdef';
  const record = withAssurance(undefined, { authMethod: 'password', authNsTotp: 'true', authAt: '2026-01-01', nsGrantKind: 'oauth' }, 'alice@example.com', primary, secret);
  expect(hasServerAssurance(record, 'alice@example.com', primary, secret)).toBe(true);
  expect(hasServerAssurance(record, 'bob@example.com', primary, secret)).toBe(false);
  expect(hasServerAssurance(record, 'alice@example.com', other, secret)).toBe(false);
  expect(hasServerAssurance({ ...record, authNsTotp: 'false' }, 'alice@example.com', primary, secret)).toBe(false);
  expect(hasServerAssurance({ ...record, authAssuranceSig: 'bad' }, 'alice@example.com', primary, secret)).toBe(false);
  const sso = withAssurance(undefined, { authMethod: 'sso_google', authNsTotp: 'true', authAt: '2026-01-01', nsGrantKind: 'jwt' }, 'alice@example.com', primary, secret);
  expect(sso.authNsTotp).toBe('false');
  expect(hasServerAssurance(sso, 'alice@example.com', primary, secret)).toBe(true);
 });
 it('refuses privileged password-only login before issuing a code', async () => {
  const { instance } = provider();
  vi.spyOn(instance as unknown as TestInternals, 'nsPasswordGrant').mockResolvedValue({ kind: 'tokens', tokens: { access_token: 'upstream' } });
  vi.spyOn(instance as unknown as TestInternals, 'detectNsUserInfo').mockResolvedValue(identity('Office Manager'));
  const res = response();
  await instance.handleLogin(req({ auth_state: await state(instance) }), res as unknown as Response, 'alice@example.com', 'password');
  expect(res.statusCode).toBe(403);
  expect(res.location).toBe('');
 });
 it('issues a code only after an explicitly identified authenticator challenge succeeds', async () => {
  const { instance, store } = provider();
  vi.spyOn(instance as unknown as TestInternals, 'nsPasswordGrant').mockResolvedValue({ kind: 'mfa_required', partialAccessToken: 'partial', mfaType: 'authenticator', mfaVendor: 'google', nsIdType: 'subscriber', verifiedAuthenticator: true });
  vi.spyOn(instance as unknown as TestInternals, 'nsMfaGrant').mockResolvedValue({ access_token: 'upstream' });
  vi.spyOn(instance as unknown as TestInternals, 'detectNsUserInfo').mockResolvedValue(identity('Office Manager'));
  const login = response();
  await instance.handleLogin(req({ auth_state: await state(instance) }), login as unknown as Response, 'alice@example.com', 'password');
  expect(login.location).toBe('');
  const mfaState = login.html.match(/name="mfa_state" value="([^"]+)"/)![1];
  const mfa = response();
  await instance.handleMfa(req({ mfa_state: mfaState }), mfa as unknown as Response, '123456');
  const tokens = await instance.exchangeAuthorizationCode(client, new URL(mfa.location).searchParams.get('code')!);
  expect((await store.sessions.get(tokens.access_token))?.extra).toMatchObject({ authMethod: 'password', authNsTotp: 'true', nsGrantKind: 'oauth' });
 });
 it('does not treat an unclassified MFA challenge as authenticator proof', async () => {
  const { instance } = provider();
  vi.spyOn(instance as unknown as TestInternals, 'nsPasswordGrant').mockResolvedValue({ kind: 'mfa_required', partialAccessToken: 'partial', mfaType: 'authenticator', mfaVendor: 'google', nsIdType: 'subscriber' });
  vi.spyOn(instance as unknown as TestInternals, 'nsMfaGrant').mockResolvedValue({ access_token: 'upstream' });
  vi.spyOn(instance as unknown as TestInternals, 'detectNsUserInfo').mockResolvedValue(identity('Reseller'));
  const login = response();
  await instance.handleLogin(req({ auth_state: await state(instance) }), login as unknown as Response, 'alice@example.com', 'password');
  const mfa = response();
  await instance.handleMfa(req({ mfa_state: login.html.match(/name="mfa_state" value="([^"]+)"/)![1] }), mfa as unknown as Response, '123456');
  expect(mfa.statusCode).toBe(403);
  expect(mfa.location).toBe('');
 });
 it.each(['Office Manager', 'Reseller', 'Super User'])('rejects pasted token for %s', async (scope) => {
  const { instance } = provider();
  vi.spyOn(instance, 'validateNsToken').mockResolvedValue({ username: 'alice@example.com', userRole: 'domain_admin', scope });
  vi.spyOn(instance as unknown as TestInternals, 'detectNsUserInfo').mockResolvedValue(identity(scope));
  const res = response();
  await instance.handleTokenLogin(req({ auth_state: await state(instance) }), res as unknown as Response, 'default', 'pasted');
  expect(res.statusCode).toBe(403);
  expect(res.location).toBe('');
 });
 it('accepts pasted tokens only when configured to do so', async () => {
  const { instance } = provider({ ...policy, acceptPastedToken: true });
  vi.spyOn(instance, 'validateNsToken').mockResolvedValue({ username: 'alice@example.com', userRole: 'reseller', scope: 'Reseller' });
  vi.spyOn(instance as unknown as TestInternals, 'detectNsUserInfo').mockResolvedValue(identity('Reseller'));
  const res = response();
  await instance.handleTokenLogin(req({ auth_state: await state(instance) }), res as unknown as Response, 'default', 'pasted');
  expect(res.location).toContain('code=');
 });
 it.each(['Basic User', 'Site Manager', 'Domain Admin', 'Call Center Supervisor'])('does not apply Office Manager policy to %s', async (scope) => {
  const { instance } = provider();
  vi.spyOn(instance, 'validateNsToken').mockResolvedValue({ username: 'alice@example.com', userRole: 'domain_admin', scope });
  vi.spyOn(instance as unknown as TestInternals, 'detectNsUserInfo').mockResolvedValue(identity(scope));
  const res = response();
  await instance.handleTokenLogin(req({ auth_state: await state(instance) }), res as unknown as Response, 'default', 'pasted');
  expect(res.location).toContain('code=');
 });
 it('leaves a nonprimary platform unchanged', async () => {
  const { instance } = provider();
  vi.spyOn(instance, 'validateNsToken').mockResolvedValue({ username: 'alice@example.com', userRole: 'system_admin', scope: 'Super User' });
  vi.spyOn(instance as unknown as TestInternals, 'detectNsUserInfo').mockResolvedValue(identity('Super User'));
  const res = response();
  await instance.handleTokenLogin(req({ auth_state: await state(instance) }), res as unknown as Response, 'other', 'pasted');
  expect(res.location).toContain('code=');
 });
 it('refuses unknown identity scope rather than defaulting to a basic user', async () => {
  const { instance } = provider();
  vi.spyOn(instance, 'validateNsToken').mockResolvedValue({ username: 'alice@example.com', userRole: 'user', scope: 'unrecognized' });
  vi.spyOn(instance as unknown as TestInternals, 'detectNsUserInfo').mockResolvedValue(identity('unrecognized'));
  const res = response();
  await instance.handleTokenLogin(req({ auth_state: await state(instance) }), res as unknown as Response, 'default', 'pasted');
  expect(res.statusCode).toBe(503);
  expect(res.location).toBe('');
 });
 it('fails closed when upstream cannot establish the identity', async () => {
  const { instance } = provider();
  vi.spyOn(instance, 'validateNsToken').mockResolvedValue({ username: 'alice@example.com', userRole: 'user', scope: 'Basic User' });
  vi.spyOn(instance as unknown as TestInternals, 'detectNsUserInfo').mockResolvedValue({ ...identity('Basic User'), verifiedIdentity: false });
  const res = response();
  await instance.handleTokenLogin(req({ auth_state: await state(instance) }), res as unknown as Response, 'default', 'pasted');
  expect(res.statusCode).toBe(503);
  expect(res.location).toBe('');
 });
 it('ignores hook attempts to forge reserved assurance keys', async () => {
  const { instance, store } = provider();
  (instance as unknown as TestInternals).hooks = { onLogin: async () => ({ kind: 'continue', tokenExtra: { authMethod: 'sso_google', authNsTotp: 'true', authProviderTenant: 'fake', seat: 'allowed' } }), onVerify: async () => ({}) };
  vi.spyOn(instance, 'validateNsToken').mockResolvedValue({ username: 'alice@example.com', userRole: 'user', scope: 'Basic User' });
  vi.spyOn(instance as unknown as TestInternals, 'detectNsUserInfo').mockResolvedValue(identity('Basic User'));
  const res = response();
  await instance.handleTokenLogin(req({ auth_state: await state(instance) }), res as unknown as Response, 'default', 'pasted');
  const tokens = await instance.exchangeAuthorizationCode(client, new URL(res.location).searchParams.get('code')!);
  const extra = (await store.sessions.get(tokens.access_token))!.extra!;
  expect(extra).toMatchObject({ authMethod: 'ns_token', authNsTotp: 'false', seat: 'allowed' });
  expect(extra.authProviderTenant).toBeUndefined();
 });

 async function existing(scope: string, extra?: Record<string, string>, config = policy, signed = true) {
  const { instance, store } = provider(config);
  const lookup = vi.spyOn(axios, 'get').mockResolvedValue({ data: { user: 'alice', domain: 'example.com', 'user-scope': scope } });
  const storedExtra = extra && signed ? withAssurance(undefined, {
   authMethod: extra.authMethod as AuthMethod, authNsTotp: extra.authNsTotp as 'true' | 'false',
   authAt: '2026-01-01T00:00:00.000Z', nsGrantKind: 'oauth',
  }, 'alice@example.com', primary, '0123456789abcdef0123456789abcdef') : extra;
  await store.sessions.create({ accessToken: 'access', refreshToken: 'refresh' }, { clientId: client.client_id, expiresAt: Date.now() + 60000, nsAccessToken: 'upstream', nsRefreshToken: 'upstream-refresh', nsUsername: 'alice@example.com', nsUserRole: 'user', nsApiUrl: primary, extra: storedExtra });
  return { instance, store, lookup };
 }
 it('revokes a legacy privileged family on access verification', async () => {
  const { instance, store } = await existing('Office Manager');
  await expect(instance.verifyAccessToken('access')).rejects.toBeInstanceOf(InvalidTokenError);
  expect(await store.sessions.getByRefreshToken('refresh')).toBeUndefined();
 });
 it('revokes a legacy privileged family on refresh with invalid_grant', async () => {
  const { instance, store } = await existing('Reseller');
  await expect(instance.exchangeRefreshToken(client, 'refresh')).rejects.toBeInstanceOf(InvalidGrantError);
  expect(await store.sessions.getByRefreshToken('refresh')).toBeUndefined();
 });
 it.each([
  { authMethod: 'password', authNsTotp: 'true' },
  { authMethod: 'sso_google', authNsTotp: 'false', authAssuranceSig: 'invalid' },
 ])('does not trust forged legacy assurance fields', async (extra) => {
  const { instance, store } = await existing('Super User', extra, policy, false);
  await expect(instance.verifyAccessToken('access')).rejects.toBeInstanceOf(InvalidTokenError);
  expect(await store.sessions.getByRefreshToken('refresh')).toBeUndefined();
 });
 it('rechecks changed authoritative scope instead of the persisted tier', async () => {
  const { instance, store } = await existing('Super User', { authMethod: 'ns_token', authNsTotp: 'false' });
  await expect(instance.verifyAccessToken('access')).rejects.toBeInstanceOf(InvalidTokenError);
  expect(await store.sessions.getByRefreshToken('refresh')).toBeUndefined();
 });
 it('allows a verified authenticator session and an unprotected scope', async () => {
  const { instance, lookup } = await existing('Office Manager', { authMethod: 'password', authNsTotp: 'true' });
  await expect(instance.verifyAccessToken('access')).resolves.toMatchObject({ token: 'access' });
  lookup.mockResolvedValue({ data: { user: 'alice', domain: 'example.com', 'user-scope': 'Site Manager' } });
  await expect(instance.verifyAccessToken('access')).resolves.toMatchObject({ token: 'access' });
 });
 it('accepts trusted provider sign-in without marking it as verified NS MFA', async () => {
  const { instance } = await existing('Super User', { authMethod: 'sso_google', authNsTotp: 'false' });
  const info = await instance.verifyAccessToken('access');
  expect(info.extra).toMatchObject({ authMethod: 'sso_google', authNsTotp: 'false' });
 });
 it('permits refresh with verified authenticator assurance', async () => {
  const { instance, store } = await existing('Office Manager', { authMethod: 'password', authNsTotp: 'true' });
  const session = (await store.sessions.get('access'))!;
  vi.spyOn(store.sessions, 'refreshUpstream').mockResolvedValue(session);
  const tokens = await instance.exchangeRefreshToken(client, 'refresh');
  expect(tokens.access_token).toBeTruthy();
  expect(tokens.refresh_token).toBeTruthy();
 });
 it('does not revoke on role lookup failure or unknown role for access and refresh', async () => {
  const { instance, store, lookup } = await existing('Office Manager');
  lookup.mockRejectedValue(new Error('upstream unavailable'));
  await expect(instance.verifyAccessToken('access')).rejects.toBeInstanceOf(ServerError);
  await expect(instance.exchangeRefreshToken(client, 'refresh')).rejects.toBeInstanceOf(TemporarilyUnavailableError);
  expect(await store.sessions.getByRefreshToken('refresh')).toBeDefined();
  lookup.mockResolvedValue({ data: { user: 'alice', domain: 'example.com', 'user-scope': 'unexpected' } });
  await expect(instance.verifyAccessToken('access')).rejects.toBeInstanceOf(ServerError);
  await expect(instance.exchangeRefreshToken(client, 'refresh')).rejects.toBeInstanceOf(TemporarilyUnavailableError);
  expect(await store.sessions.getByRefreshToken('refresh')).toBeDefined();
  lookup.mockResolvedValue({ data: { user: 'other', domain: 'example.com', 'user-scope': 'Office Manager' } });
  await expect(instance.verifyAccessToken('access')).rejects.toBeInstanceOf(ServerError);
  await expect(instance.exchangeRefreshToken(client, 'refresh')).rejects.toBeInstanceOf(TemporarilyUnavailableError);
  expect(await store.sessions.getByRefreshToken('refresh')).toBeDefined();
 });
 it('does not enforce existing sessions when disabled', async () => {
  const { instance, lookup } = await existing('Super User', undefined, { ...policy, applyToExistingSessions: false });
  await expect(instance.verifyAccessToken('access')).resolves.toMatchObject({ token: 'access' });
  expect(lookup).not.toHaveBeenCalled();
 });
});
