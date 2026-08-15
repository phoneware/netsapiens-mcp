/**
 * Loopback redirect tolerance for native MCP clients.
 *
 * The SDK's /authorize handler compares the presented redirect_uri against the
 * client's registered list by exact string match. A native client (OMP, Claude
 * Code) serves its callback from a loopback listener on a port it picks per
 * attempt, and persists only its client_id. Its next sign-in therefore arrives
 * with the same client_id and a different port, and is refused with
 * "Unregistered redirect_uri" from then on. The client has no reason to
 * register again, so removing and re-adding the connector does not clear it.
 *
 * RFC 8252 §7.3 requires exactly this allowance: "the authorization server MUST
 * allow any port to be specified at the time of the request for loopback IP
 * redirect URIs". §8.3 is why the loopback spellings are interchangeable here:
 * clients are told to prefer the IP literals but do not agree on which, and OMP
 * binds 127.0.0.1 while advertising localhost.
 *
 * The allowance lasts one in-flight authorize request and yields a widened
 * *copy* of the client record. Nothing is mutated and nothing is written, so a
 * client whose port churns cannot accumulate junk redirect_uris on its stored
 * registration.
 *
 * This widens nothing an attacker can reach. The code is still delivered to the
 * signing-in person's own machine, and /register is open and unauthenticated as
 * MCP clients require, so any redirect_uri obtainable this way was already
 * obtainable by registering for one.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { logger } from '../utils/logger.js';

/** Hostnames that resolve to the machine running the client. */
const LOOPBACK_HOSTNAMES: Record<string, true> = {
 localhost: true,
 '127.0.0.1': true,
 '::1': true,
 '[::1]': true,
};

/**
 * The redirect_uri of the authorize request being served, readable by the
 * clients store, which the SDK calls with no request context.
 */
const requestedRedirectUri = new AsyncLocalStorage<string>();

export function isLoopbackRedirectUri(value: string): boolean {
 let url: URL;
 try {
  url = new URL(value);
 } catch {
  return false;
 }
 if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
 // Credentials or a fragment mean this is not a plain loopback callback, so it
 // gets none of the latitude one is given.
 if (url.username !== '' || url.password !== '' || url.hash !== '') return false;
 return LOOPBACK_HOSTNAMES[url.hostname] === true;
}

/**
 * True when `candidate` is the same loopback callback as one already registered,
 * differing only in port or in how loopback is spelled. A different path is a
 * different callback: widening that would let one registration stand in for
 * another.
 */
export function isLoopbackPortVariant(registered: readonly string[], candidate: string): boolean {
 if (!isLoopbackRedirectUri(candidate)) return false;
 const want = new URL(candidate);
 return registered.some((entry) => {
  if (!isLoopbackRedirectUri(entry)) return false;
  const have = new URL(entry);
  return have.pathname === want.pathname && have.search === want.search;
 });
}

/**
 * Publish the requested loopback redirect_uri for the duration of the request,
 * so `LoopbackTolerantClientsStore` can honor it. Mount on /authorize only:
 * every other endpoint should keep the exact-match rule.
 */
export function allowLoopbackRedirectUri(): RequestHandler {
 return (req, _res, next) => {
  const fromQuery = req.query?.redirect_uri;
  const fromBody = (req.body as Record<string, unknown> | undefined)?.redirect_uri;
  const value =
   typeof fromQuery === 'string'
    ? fromQuery
    : typeof fromBody === 'string'
     ? fromBody
     : undefined;
  if (value === undefined || !isLoopbackRedirectUri(value)) {
   next();
   return;
  }
  requestedRedirectUri.run(value, next);
 };
}

/**
 * Wraps a clients store so a registered client may be reached at a loopback
 * callback on any port. Only `getClient` behaves differently; registration and
 * every non-loopback redirect_uri are the delegate's business, unchanged.
 */
export class LoopbackTolerantClientsStore implements OAuthRegisteredClientsStore {
 registerClient?: OAuthRegisteredClientsStore['registerClient'];

 constructor(private readonly inner: OAuthRegisteredClientsStore) {
  // Mirror the delegate's capability instead of always claiming it: the SDK
  // decides whether to expose /register by testing for this method.
  if (inner.registerClient) {
   this.registerClient = (client) => inner.registerClient!(client);
  }
 }

 async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
  const client = await this.inner.getClient(clientId);
  if (!client) return client;

  const requested = requestedRedirectUri.getStore();
  if (requested === undefined) return client;
  if (client.redirect_uris.includes(requested)) return client;
  if (!isLoopbackPortVariant(client.redirect_uris, requested)) return client;

  logger.info('Accepting a loopback redirect_uri on a new port', {
   clientId,
   redirectUri: requested,
  });
  return { ...client, redirect_uris: [...client.redirect_uris, requested] };
 }
}
