/**
 * Shared types for the curated (task-shaped) tool catalog.
 *
 * Each curated tool is a composite that wraps one or two underlying NetSapiens
 * operations and shapes the response into something the model can act on
 * without parsing 30 lines of JSON. Curated tools carry a `minRole` so the
 * default tool list naturally scales with the user's NS scope.
 */

import type { GenericApiClient, ToolDefinition } from '../../generated/types.js';
import type { UserRole } from '../../auth/roles.js';

export interface CuratedTool extends Omit<ToolDefinition, 'handler'> {
 /**
  * Curated handlers also receive the caller's NS scope tier. A tool can use
  * it to pick the right default breadth: an office manager asking about
  * "calls" means the office, a plain user means their own line.
  */
 handler: Handler;
 /** Minimum NetSapiens scope required to see this tool in the catalog. */
 minRole: UserRole;
 /**
  * Human-readable display name (MCP `Tool.title`). Clients show this in tool
  * lists and permission prompts. Defaults to a title-cased form of the tool
  * name when omitted.
  */
 title?: string;
 /**
  * Explicit destructive flag. Composites have names like `end_call` that
  * don't match the generator's prefix-based destructive heuristic, but they
  * DO mutate state irreversibly. Set this true so MCP_DISABLE_DESTRUCTIVE
  * catches them. Defaults to the prefix-based inference if omitted.
  */
 destructive?: boolean;
 /** Explicit read-only flag (overrides prefix-based inference if set). */
 readOnly?: boolean;
}

/** Every curated tool emits this shape. */
export interface CuratedResult {
 content: Array<{ type: 'text'; text: string }>;
}

/** Helper for handler responses. */
export function textResult(payload: unknown): CuratedResult {
 const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
 return { content: [{ type: 'text' as const, text }] };
}

/** Shorthand for typed handler signatures. */
export type Handler = (
 args: Record<string, unknown>,
 client: GenericApiClient,
 userRole?: UserRole,
) => Promise<CuratedResult>;
