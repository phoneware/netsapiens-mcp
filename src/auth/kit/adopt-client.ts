// Copied from @phoneware/mcp-oauth-kit 1.0.0 (phoneware/monorepo packages/mcp-oauth-kit/src/adopt-client.ts at 8447d361111612739343ee0fb83a15c328db372d). Edit the canonical file, then re-copy.
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  DEFAULT_REDIRECT_ALLOWLIST,
  isAllowedRedirectUri,
  isPlausibleClientId,
} from './redirect-policy.js';

export interface AdoptClientOptions {
  clientsStore: OAuthRegisteredClientsStore;
  redirectAllowlist?: readonly string[];
  serverName?: string;
  log?: (message: string) => void;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Express middleware for /authorize that adopts unknown clients on first touch
 * if the client_id is plausible and the redirect_uri complies with redirect policy.
 *
 * If the client is already known, execution proceeds normally.
 * If the client is unknown but adoptable, it is registered automatically.
 * If the client is unknown and the redirect_uri is outside policy, an escaped HTTP 400
 * response is returned with no redirection.
 */
export function adoptClientMiddleware(opts: AdoptClientOptions): RequestHandler {
  const allowlist = opts.redirectAllowlist ?? DEFAULT_REDIRECT_ALLOWLIST;
  const name = opts.serverName ?? 'MCP';

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const query = req.query;
    const body = req.body;

    const readParam = (key: string): string | undefined => {
      const qVal = query[key];
      if (typeof qVal === 'string') return qVal;
      if (body && typeof body === 'object' && key in body) {
        const bVal = (body as Record<string, unknown>)[key];
        if (typeof bVal === 'string') return bVal;
      }
      return undefined;
    };

    const clientId = readParam('client_id');
    const redirectUri = readParam('redirect_uri');

    // Missing client_id is handled by the SDK.
    if (!clientId) {
      next();
      return;
    }

    try {
      const existing = await opts.clientsStore.getClient(clientId);
      if (existing) {
        if (
          redirectUri !== undefined &&
          existing.redirect_uris &&
          !existing.redirect_uris.includes(redirectUri)
        ) {
          // Mismatched redirect_uri for existing client
          const safeRedirect = escapeHtml(redirectUri);
          const safeServer = escapeHtml(name);
          res.status(400).type('html').send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${safeServer} sign-in refused</title></head>
<body><h1>This sign-in was refused</h1><p>Mismatched redirect URI: <code>${safeRedirect}</code></p></body>
</html>`);
          return;
        }
        next();
        return;
      }
    } catch (err) {
      opts.log?.(`client lookup failed: ${(err as Error).message}`);
      next();
      return;
    }

    const adoptable =
      redirectUri !== undefined &&
      isPlausibleClientId(clientId) &&
      isAllowedRedirectUri(redirectUri, allowlist) &&
      typeof opts.clientsStore.registerClient === 'function';

    if (adoptable) {
      try {
        await opts.clientsStore.registerClient!({
          client_id: clientId,
          client_name: 'Adopted on first authorize',
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        } as never);
        opts.log?.(`adopted client_id ${clientId} for ${redirectUri}`);
        next();
        return;
      } catch (err) {
        opts.log?.(`could not adopt ${clientId}: ${(err as Error).message}`);
        next();
        return;
      }
    }

    opts.log?.(
      `refused /authorize for client_id ${clientId} with redirect_uri ${redirectUri ?? '(none)'}: outside redirect policy`,
    );

    const safeRedirect = escapeHtml(redirectUri ?? 'an unspecified address');
    const safeServer = escapeHtml(name);

    res.status(400).type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeServer} sign-in refused</title>
<style>
  body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         max-width: 34rem; margin: 12vh auto; padding: 0 1.5rem; color: #1c1c1c; }
  h1 { font-size: 1.35rem; margin-bottom: .5rem; }
  code { background: #f0f0f0; padding: .1rem .35rem; border-radius: 3px; font-size: .85em; }
  .muted { color: #666; font-size: .85rem; margin-top: 2rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #161616; color: #e8e8e8; }
    code { background: #2a2a2a; }
    .muted { color: #999; }
  }
</style>
</head>
<body>
<h1>This sign-in was refused</h1>
<p>The application that sent you here requested redirection to <code>${safeRedirect}</code>, which is not permitted by this server redirect policy.</p>
<p>If you started this from an MCP client, verify that your client configuration and redirect URI match an approved address.</p>
<p class="muted">No credentials were created or modified.</p>
</body>
</html>`);
  };
}
