/**
 * Server identity, instructions, and transport-mode helpers shared by the
 * stdio and HTTP entrypoints.
 *
 * Everything here maps to a field the current MCP spec (2025-11-25) defines
 * on `initialize`:
 *   - `Implementation.title` / `.websiteUrl` / `.icons` — how clients label
 *     this server in a picker or connections list.
 *   - `instructions` — a system-prompt-level hint about how to drive the
 *     tools. Clients pass it to the model, so it is the cheapest place to
 *     teach NetSapiens conventions once instead of repeating them in 700
 *     tool descriptions.
 */

import type { MCPServerConfig } from './types/config.js';

/**
 * How to use this server, in the model's context, once per session.
 *
 * The conventions here are the ones that actually cause failed calls when the
 * model has to guess them: `~` self-references, the NS datetime format, and
 * the fact that list endpoints are unfiltered (so `limit`/`fields` matter).
 */
export const SERVER_INSTRUCTIONS = [
  'This server exposes the NetSapiens (NS) VoIP platform API.',
  '',
  'Conventions that apply to every tool:',
  '- `~` means "the authenticated user" or "their domain". Prefer `~` over hardcoding a domain or user when acting on the caller\'s own resources.',
  '- Users are addressed as `user@domain`; extensions are the `user` part inside a domain.',
  '- Datetimes use `YYYY-MM-DD HH:MM:SS`. A bare `YYYY-MM-DD` start is widened to 00:00:00 and an end to 23:59:59.',
  '- Collection endpoints return everything by default and most have no server-side name filter. Pass `limit` (and `start` to page) rather than fetching unbounded lists.',
  '- Where a tool accepts `fields`, pass a comma-separated subset to cut the response down to what you actually need.',
  '',
  'Finding the right tool:',
  '- Start with the curated task-shaped tools (find_user, recent_calls, and friends). They cover the common workflows and shape the response for you.',
  '- If nothing fits, call `search_api` to search the full generated API surface, then invoke the result with `call_api`.',
  '',
  'Authorization is enforced by NetSapiens, not by this server: a 403 means the signed-in account\'s scope is too low for that resource, not that the tool is broken.',
].join('\n');

/**
 * Optional icons for the server entry in a client's UI. Sourced from
 * MCP_ICON_URL, which the HTTP transport already proxies at /favicon.png.
 */
function serverIcons(): Array<{ src: string; mimeType?: string; sizes?: string[] }> | undefined {
  const src = process.env.MCP_ICON_URL;
  if (!src) return undefined;
  return [{ src, mimeType: src.endsWith('.svg') ? 'image/svg+xml' : 'image/png' }];
}

/**
 * The `Implementation` block sent on initialize. `name` stays machine-stable;
 * `title` is the human-readable label clients should display.
 */
export function serverImplementation(config: MCPServerConfig): {
  name: string;
  version: string;
  title: string;
  websiteUrl?: string;
  icons?: Array<{ src: string; mimeType?: string; sizes?: string[] }>;
} {
  return {
    name: config.name,
    version: config.version,
    title: process.env.MCP_SERVER_TITLE || 'NetSapiens',
    websiteUrl: process.env.MCP_WEBSITE_URL,
    icons: serverIcons(),
  };
}

/**
 * Declared server capabilities.
 *
 * `tools.listChanged` is only honest in session mode — a stateless server has
 * no stream to push a `notifications/tools/list_changed` down, so we do not
 * advertise it there.
 */
export function serverCapabilities(): { tools: { listChanged?: boolean } } {
  return { tools: isStatelessMode() ? {} : { listChanged: true } };
}

/**
 * True when the HTTP transport should run without server-side sessions.
 *
 * Default is stateless. The server runs on Cloud Run behind an autoscaler
 * (min 1 / max 10 instances), where an in-memory session map means any
 * request routed to a different instance 404s and forces a re-initialize.
 * Stateless removes that failure class entirely.
 *
 * The one thing sessions still buy us is server-initiated traffic:
 * elicitation prompts and `tools/list_changed`. So when the operator has
 * explicitly turned the destructive-confirmation gate on and has not stated a
 * preference, we keep sessions rather than silently degrading that gate.
 */
export function isStatelessMode(): boolean {
  const raw = (process.env.MCP_STATELESS || '').toLowerCase().trim();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return process.env.MCP_CONFIRM_DESTRUCTIVE !== 'true';
}
