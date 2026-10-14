/**
 * Protocol version negotiation shim.
 *
 * Some MCP clients (such as Claude Code) speak newer protocol versions than the
 * Model Context Protocol SDK supports. If an unrecognized protocol version header
 * is passed, the SDK rejects requests with 400.
 *
 * This shim rewrites the request header to the newest supported SDK protocol version
 * so subsequent calls succeed instead of being refused.
 */

import {
 LATEST_PROTOCOL_VERSION,
 SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';

export function negotiateProtocolVersion(req: {
 headers: NodeJS.Dict<string | string[]>;
 rawHeaders?: string[];
}): { requested: string; negotiated: string } | undefined {
 const HEADER = 'mcp-protocol-version';
 const raw = req.headers[HEADER];
 const requested = Array.isArray(raw) ? raw[0] : raw;
 if (!requested || (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
  return undefined;
 }

 req.headers[HEADER] = LATEST_PROTOCOL_VERSION;

 const rawHeaders = req.rawHeaders;
 if (rawHeaders) {
  for (let i = 0; i < rawHeaders.length - 1; i += 2) {
   if (rawHeaders[i]?.toLowerCase() === HEADER) {
    rawHeaders[i + 1] = LATEST_PROTOCOL_VERSION;
   }
  }
 }

 return { requested, negotiated: LATEST_PROTOCOL_VERSION };
}
