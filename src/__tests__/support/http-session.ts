/**
 * Drives the OAuth sign-in over HTTP against an Express app: register a public client, open the login page, post a
 * NetSapiens token, and exchange the code. `signIn` asserts every step succeeds; the raw helpers return the responses
 * so a test can assert a refusal.
 */
import { createHash } from 'node:crypto';
import request from 'supertest';

/** What supertest accepts: an Express app or a listening server. */
export type HttpApp = Parameters<typeof request>[0];

export const DEFAULT_REDIRECT = 'http://localhost/cb';
export const DEFAULT_VERIFIER = 'my-token-verifier-123456789012345678901234';

export interface SignedInTokens {
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Reads a string member of a JSON response body that the server is known to send. */
export function bodyString(body: unknown, name: string): string {
  const value: unknown = body !== null && typeof body === 'object' ? Reflect.get(body, name) : undefined;
  if (typeof value !== 'string') throw new Error(`Missing ${name} in response body`);
  return value;
}

/** Registers a public client for the redirect URI and returns its client_id. */
export async function registerPublicClient(app: HttpApp, redirectUri = DEFAULT_REDIRECT): Promise<string> {
  const reg = await request(app)
    .post('/register')
    .send({
      redirect_uris: [redirectUri],
      client_name: 'test-client',
      token_endpoint_auth_method: 'none',
    })
    .expect(201);
  return bodyString(reg.body, 'client_id');
}

/** Opens the login page for a client and returns the signed auth_state that its form carries. */
export async function openLoginPage(app: HttpApp, clientId: string, redirectUri = DEFAULT_REDIRECT, verifier = DEFAULT_VERIFIER): Promise<string> {
  const auth = await request(app)
    .get('/authorize')
    .query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
    })
    .expect(200);
  const authState = auth.text.match(/name="auth_state" value="([^"]+)"/)?.[1];
  if (!authState) throw new Error('Missing auth_state in login page HTML');
  return authState;
}

/** Posts a NetSapiens token to the login form. The response is returned unchecked. */
export function postTokenLogin(app: HttpApp, authState: string, platformUrl: string, nsToken: string) {
  return request(app).post('/login').type('form').send({
    platform: platformUrl,
    token: nsToken,
    auth_state: authState,
  });
}

/** Exchanges an authorization code for tokens. The response is returned unchecked. */
export function exchangeCode(app: HttpApp, code: string, clientId: string, redirectUri = DEFAULT_REDIRECT, verifier = DEFAULT_VERIFIER) {
  return request(app).post('/token').type('form').send({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: redirectUri,
  });
}

/** Refreshes a session. The response is returned unchecked. */
export function refreshGrant(app: HttpApp, clientId: string, refreshToken: string) {
  return request(app).post('/token').type('form').send({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
}

/** Signs in with a NetSapiens token and returns the client and both tokens. Every step must succeed. */
export async function signInFull(app: HttpApp, platformUrl: string, nsToken: string, redirectUri = DEFAULT_REDIRECT): Promise<SignedInTokens> {
  const clientId = await registerPublicClient(app, redirectUri);
  const authState = await openLoginPage(app, clientId, redirectUri);

  const login = await postTokenLogin(app, authState, platformUrl, nsToken).expect(302);
  const code = new URL(login.headers.location as string).searchParams.get('code');
  if (!code) throw new Error('Missing code in login redirect');

  const tokenResp = await exchangeCode(app, code, clientId, redirectUri).expect(200);
  return {
    clientId,
    accessToken: bodyString(tokenResp.body, 'access_token'),
    refreshToken: bodyString(tokenResp.body, 'refresh_token'),
  };
}

/** Signs in with a NetSapiens token and returns the MCP access token. Every step must succeed. */
export async function signIn(app: HttpApp, platformUrl: string, nsToken: string, redirectUri = DEFAULT_REDIRECT): Promise<string> {
  return (await signInFull(app, platformUrl, nsToken, redirectUri)).accessToken;
}
