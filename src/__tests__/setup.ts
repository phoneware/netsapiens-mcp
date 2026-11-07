/**
 * Vitest setup, applied to every test file.
 *
 * Node 18+ turns on HTTP keep-alive for the global agent (Node 26 ships
 * `keepAlive: true`, `keepAliveMsecs: 1000`). supertest binds a fresh
 * ephemeral server per `request(app)` and closes it right after, so a pooled
 * socket can outlive the port it points at. The next request reuses that dead
 * socket and fails with "socket hang up" — in whichever test happens to draw
 * it, which is why it read as an unrelated flake in a different file each run.
 *
 * Tests do not benefit from connection reuse, so turn it off.
 */

import http from 'node:http';
import https from 'node:https';

http.globalAgent = new http.Agent({ keepAlive: false });
https.globalAgent = new https.Agent({ keepAlive: false });

/**
 * Configure memory store and test session secret for all test suites.
 */
process.env.MCP_PERSISTENCE = 'memory';
process.env.MCP_SESSION_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
delete process.env.MCP_TOKEN_STORE_PATH;
