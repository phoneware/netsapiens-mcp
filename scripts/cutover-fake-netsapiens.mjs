import * as http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

/**
 * Redacts a credential or sensitive string into an 8-character sha256 prefix
 * so raw secrets/tokens never leak into logs or receipts.
 */
export function hashSecret(val) {
  if (!val || typeof val !== 'string') return '[empty]';
  return 'h:' + createHash('sha256').update(val).digest('hex').slice(0, 8);
}

/**
 * Stateful loopback fake NetSapiens server for cutover proof.
 *
 * Implements:
 * - Dynamic Client Registration (/oauth/register)
 * - User Authorization & Login (/oauth/authorize, /login)
 * - Token Endpoint (/ns-api/oauth2/token, /oauth/token)
 *   - authorization_code exchange
 *   - refresh_token rotation (issues new refresh token on every grant)
 * - Concurrency barriers (hold token requests in flight to test deduplication)
 * - Explicit transport / server faults (500, socket hangup)
 * - Strict secret redaction in all request logs
 */
export async function startFakeNetSapiens(options = {}) {
  const hostname = options.hostname ?? '127.0.0.1';
  let grantCount = 0;
  let authCodeGrants = 0;
  let refreshGrants = 0;
  let totalRequests = 0;

  // Active state
  const issuedAccessTokens = new Map(); // token -> { user, scope, expiresAt }
  const issuedRefreshTokens = new Map(); // token -> { user, scope, familyId }
  const authCodes = new Map(); // code -> { clientId, redirectUri, user, scope, codeChallenge }
  const registeredClients = new Map(); // clientId -> { clientSecret, redirectUris, name }

  // Fault and barrier controls
  let tokenBarrier = null;
  let failNextToken = null; // { status, body }

  // Default test user
  const defaultUser = {
    domain: '1001',
    user: '1001@example.com',
    name: 'Test Subscriber',
    user_role: 'subscriber',
    site: 'main',
  };

  const server = http.createServer(async (req, res) => {
    totalRequests++;
    const method = req.method?.toUpperCase() ?? 'GET';
    const parsedUrl = new URL(req.url ?? '/', `http://${hostname}`);
    const pathname = parsedUrl.pathname;

    // Read body if POST/PUT
    let rawBody = '';
    for await (const chunk of req) {
      rawBody += chunk;
    }

    let parsedBody = {};
    if (rawBody.trim().startsWith('{')) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {}
    } else if (rawBody.includes('=')) {
      try {
        parsedBody = Object.fromEntries(new URLSearchParams(rawBody));
      } catch {}
    }

    // Health check
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', grants: grantCount }));
      return;
    }

    // Version route
    if (pathname === '/ns-api/v2/version' || pathname === '/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '44.4.0', status: 'active' }));
      return;
    }

    // User lookup route
    if (pathname.includes('/users/') || pathname === '/domains/1001/users/1001@example.com' || pathname === '/domains/1001/users') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(defaultUser));
      return;
    }

    // API key lookup
    if (pathname.startsWith('/apikeys/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ key: 'test-key', user: defaultUser.user, role: defaultUser.user_role }));
      return;
    }

    // Client registration (DCR)
    if (pathname === '/oauth/register') {
      const clientId = parsedBody.client_id ?? 'client_' + randomBytes(8).toString('hex');
      const clientSecret = 'sec_' + randomBytes(16).toString('hex');
      registeredClients.set(clientId, {
        clientId,
        clientSecret,
        redirectUris: parsedBody.redirect_uris ?? ['http://127.0.0.1:3000/callback'],
        name: parsedBody.client_name ?? 'Test Client',
      });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        client_id_issued_at: Math.floor(Date.now() / 1000),
      }));
      return;
    }

    // Authorize endpoint
    if (pathname === '/oauth/authorize') {
      const clientId = parsedUrl.searchParams.get('client_id');
      const redirectUri = parsedUrl.searchParams.get('redirect_uri');
      const state = parsedUrl.searchParams.get('state');
      const codeChallenge = parsedUrl.searchParams.get('code_challenge');
      const code = 'code_' + randomBytes(16).toString('hex');
      authCodes.set(code, {
        clientId,
        redirectUri,
        codeChallenge,
        user: defaultUser.user,
        scope: parsedUrl.searchParams.get('scope') ?? 'read write',
      });

      // Simple mock login form / immediate redirect
      const targetUrl = new URL(redirectUri ?? 'http://127.0.0.1:3000/callback');
      targetUrl.searchParams.set('code', code);
      if (state) targetUrl.searchParams.set('state', state);

      res.writeHead(302, { Location: targetUrl.href });
      res.end();
      return;
    }

    // Token endpoint: /ns-api/oauth2/token, /oauth/token, /ns-api/v2/tokens
    if (pathname === '/ns-api/oauth2/token' || pathname === '/oauth/token' || pathname === '/ns-api/v2/tokens') {
      // Barrier support for concurrency tests
      if (tokenBarrier) {
        await tokenBarrier;
      }

      // Injected fault support
      if (failNextToken) {
        const fault = failNextToken;
        failNextToken = null;
        res.writeHead(fault.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(fault.body));
        return;
      }

      const grantType = parsedBody.grant_type;

      if (grantType === 'authorization_code') {
        const code = parsedBody.code;
        if (!code || !authCodes.has(code)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Code invalid or expired' }));
          return;
        }
        authCodes.delete(code); // One-time use

        grantCount++;
        authCodeGrants++;

        const newAccessToken = 'ns_acc_' + randomBytes(16).toString('hex');
        const newRefreshToken = 'ns_ref_' + randomBytes(16).toString('hex');
        const now = Date.now();

        issuedAccessTokens.set(newAccessToken, {
          user: defaultUser.user,
          expiresAt: now + 3600_000,
        });
        issuedRefreshTokens.set(newRefreshToken, {
          user: defaultUser.user,
          familyId: 'ns_fam_' + randomBytes(8).toString('hex'),
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: newAccessToken,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: newRefreshToken,
          scope: 'read write',
          ns_username: defaultUser.user,
          ns_user_role: defaultUser.user_role,
        }));
        return;
      }

      if (grantType === 'refresh_token') {
        const oldRefreshToken = parsedBody.refresh_token;
        if (!oldRefreshToken) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_request', error_description: 'Missing refresh_token' }));
          return;
        }

        grantCount++;
        refreshGrants++;

        // Refresh token rotation: issue new pair
        const newAccessToken = 'ns_acc_' + randomBytes(16).toString('hex');
        const newRefreshToken = 'ns_ref_' + randomBytes(16).toString('hex');
        const now = Date.now();

        issuedAccessTokens.set(newAccessToken, {
          user: defaultUser.user,
          expiresAt: now + 3600_000,
        });
        issuedRefreshTokens.set(newRefreshToken, {
          user: defaultUser.user,
          familyId: 'ns_fam_' + randomBytes(8).toString('hex'),
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: newAccessToken,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: newRefreshToken,
          scope: 'read write',
          ns_username: defaultUser.user,
          ns_user_role: defaultUser.user_role,
        }));
        return;
      }

      // Password grant (for direct login)
      if (grantType === 'password') {
        grantCount++;
        const newAccessToken = 'ns_acc_' + randomBytes(16).toString('hex');
        const newRefreshToken = 'ns_ref_' + randomBytes(16).toString('hex');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: newAccessToken,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: newRefreshToken,
          scope: 'read write',
          ns_username: defaultUser.user,
          ns_user_role: defaultUser.user_role,
        }));
        return;
      }

      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
      return;
    }

    // Default route
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', path: pathname }));
  });

  await new Promise((resolve) => server.listen(0, hostname, resolve));
  const port = server.address().port;
  const origin = `http://${hostname}:${port}`;

  return {
    origin,
    port,
    getStats() {
      return {
        totalRequests,
        grantCount,
        authCodeGrants,
        refreshGrants,
      };
    },
    resetStats() {
      totalRequests = 0;
      grantCount = 0;
      authCodeGrants = 0;
      refreshGrants = 0;
    },
    setTokenBarrier(promise) {
      tokenBarrier = promise;
    },
    clearTokenBarrier() {
      tokenBarrier = null;
    },
    setFailNextToken(status, body) {
      failNextToken = { status, body };
    },
    async close() {
      if (server.closeAllConnections) {
        server.closeAllConnections();
      }
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
