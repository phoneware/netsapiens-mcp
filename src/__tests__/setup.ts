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
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

http.globalAgent = new http.Agent({ keepAlive: false });
https.globalAgent = new https.Agent({ keepAlive: false });

/**
 * Point the file-backed token store at a private temp file, per worker.
 *
 * Two reasons. First, any test that builds a real auth provider otherwise
 * loads and rewrites the developer's own ~/.netsapiens-mcp/http-tokens.json,
 * which by now had grown to 142KB of real tokens. Second, vitest runs test
 * files in parallel workers, so a shared path means several workers reading
 * and rewriting the same file inside request handlers.
 */
process.env.MCP_TOKEN_STORE_PATH = join(tmpdir(), `ns-mcp-test-tokens-${process.pid}-${randomUUID()}.json`);
