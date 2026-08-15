/**
 * Unit tests for the loopback redirect allowance. The end-to-end proof that an
 * /authorize request on a new port is accepted lives in
 * netsapiens-auth-provider.test.ts, which drives the real Express app.
 */

import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
 allowLoopbackRedirectUri,
 isLoopbackPortVariant,
 isLoopbackRedirectUri,
 LoopbackTolerantClientsStore,
} from '../auth/loopback-redirect.js';

function client(redirect_uris: string[]): OAuthClientInformationFull {
 return { client_id: 'c1', redirect_uris } as OAuthClientInformationFull;
}

describe('isLoopbackRedirectUri', () => {
 it('accepts every loopback spelling clients actually use', () => {
  expect(isLoopbackRedirectUri('http://localhost:1410/callback')).toBe(true);
  expect(isLoopbackRedirectUri('http://127.0.0.1:1410/callback')).toBe(true);
  expect(isLoopbackRedirectUri('http://[::1]:1410/callback')).toBe(true);
  expect(isLoopbackRedirectUri('https://127.0.0.1:1410/callback')).toBe(true);
 });

 it('refuses anything that is not plainly a loopback callback', () => {
  expect(isLoopbackRedirectUri('https://evil.example.com/callback')).toBe(false);
  // Resolves off-machine despite reading like loopback.
  expect(isLoopbackRedirectUri('http://localhost.evil.example.com/cb')).toBe(false);
  expect(isLoopbackRedirectUri('http://127.0.0.1.evil.example.com/cb')).toBe(false);
  expect(isLoopbackRedirectUri('javascript:alert(1)')).toBe(false);
  expect(isLoopbackRedirectUri('not a url')).toBe(false);
  // Credentials or a fragment mean this is not a plain callback.
  expect(isLoopbackRedirectUri('http://user:pw@127.0.0.1:1410/cb')).toBe(false);
  expect(isLoopbackRedirectUri('http://127.0.0.1:1410/cb#frag')).toBe(false);
 });
});

describe('isLoopbackPortVariant', () => {
 const registered = ['http://localhost:1410/callback'];

 it('accepts the same callback on a different port', () => {
  expect(isLoopbackPortVariant(registered, 'http://localhost:54321/callback')).toBe(true);
 });

 it('accepts an equivalent loopback spelling', () => {
  expect(isLoopbackPortVariant(registered, 'http://127.0.0.1:1410/callback')).toBe(true);
  expect(isLoopbackPortVariant(registered, 'http://[::1]:9999/callback')).toBe(true);
 });

 it('refuses a different path, which is a different callback', () => {
  expect(isLoopbackPortVariant(registered, 'http://localhost:1410/steal')).toBe(false);
  expect(isLoopbackPortVariant(registered, 'http://localhost:1410/callback/sub')).toBe(false);
  expect(isLoopbackPortVariant(registered, 'http://localhost:1410/callback?x=1')).toBe(false);
 });

 it('refuses an off-machine candidate, and gives no latitude to an off-machine registration', () => {
  expect(isLoopbackPortVariant(registered, 'https://evil.example.com/callback')).toBe(false);
  expect(
   isLoopbackPortVariant(['https://claude.ai/api/mcp/auth_callback'], 'http://localhost:1/api/mcp/auth_callback'),
  ).toBe(false);
 });
});

describe('LoopbackTolerantClientsStore', () => {
 function storeOver(record: OAuthClientInformationFull | undefined) {
  return new LoopbackTolerantClientsStore({ getClient: () => record });
 }

 /** Run fn as if serving an /authorize request carrying redirectUri. */
 async function duringAuthorize<T>(redirectUri: string, fn: () => Promise<T>): Promise<T> {
  const app = express();
  let result: T;
  app.get('/authorize', allowLoopbackRedirectUri(), (_req, res) => {
   void fn().then((r) => {
    result = r;
    res.json({ ok: true });
   });
  });
  await request(app).get(`/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`).expect(200);
  return result!;
 }

 it('widens a registered loopback callback to the port in flight', async () => {
  const record = client(['http://localhost:1410/callback']);
  const store = storeOver(record);
  const got = await duringAuthorize('http://localhost:54321/callback', () =>
   store.getClient('c1'),
  );
  expect(got!.redirect_uris).toEqual([
   'http://localhost:1410/callback',
   'http://localhost:54321/callback',
  ]);
  // The stored registration is untouched, so a churning port cannot accumulate.
  expect(record.redirect_uris).toEqual(['http://localhost:1410/callback']);
 });

 it('leaves the record alone outside an authorize request', async () => {
  const store = storeOver(client(['http://localhost:1410/callback']));
  const got = await store.getClient('c1');
  expect(got!.redirect_uris).toEqual(['http://localhost:1410/callback']);
 });

 it('does not widen for an off-machine redirect_uri', async () => {
  const store = storeOver(client(['http://localhost:1410/callback']));
  const got = await duringAuthorize('https://evil.example.com/callback', () =>
   store.getClient('c1'),
  );
  expect(got!.redirect_uris).toEqual(['http://localhost:1410/callback']);
 });

 it('does not widen for a loopback URI on a different path', async () => {
  const store = storeOver(client(['http://localhost:1410/callback']));
  const got = await duringAuthorize('http://localhost:1410/steal', () => store.getClient('c1'));
  expect(got!.redirect_uris).toEqual(['http://localhost:1410/callback']);
 });

 it('passes an unknown client straight through', async () => {
  const store = storeOver(undefined);
  expect(await duringAuthorize('http://localhost:1/callback', () => store.getClient('nope'))).toBeUndefined();
 });

 it('mirrors the delegate on whether registration is available', () => {
  const withReg = new LoopbackTolerantClientsStore({
   getClient: () => undefined,
   registerClient: (c) => ({ ...c, client_id: 'new' }) as OAuthClientInformationFull,
  });
  expect(typeof withReg.registerClient).toBe('function');
  // The SDK decides whether to expose /register by testing for this method,
  // so claiming it over a store that lacks it would advertise a broken route.
  expect(new LoopbackTolerantClientsStore({ getClient: () => undefined }).registerClient).toBeUndefined();
 });
});
