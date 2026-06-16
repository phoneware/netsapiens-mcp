/**
 * Elicitation gate for destructive tool calls.
 *
 * When MCP_CONFIRM_DESTRUCTIVE=true, the CallTool handler routes destructive
 * invocations through `elicitConfirmation()` before dispatching. The MCP
 * client shows the user a confirmation form; we only proceed on `accept`.
 *
 * If the connected client doesn't support elicitation, MCP_CONFIRM_FALLBACK
 * controls the behavior:
 *   - "fail"   (default) — refuse the call with a clear error
 *   - "allow"           — proceed as if confirmed (operator opt-in)
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';

export function confirmDestructiveEnabled(): boolean {
  return process.env.MCP_CONFIRM_DESTRUCTIVE === 'true';
}

function fallbackPolicy(): 'fail' | 'allow' {
  const v = (process.env.MCP_CONFIRM_FALLBACK || '').toLowerCase();
  return v === 'allow' ? 'allow' : 'fail';
}

/**
 * Render the args into a compact summary line for the prompt. Avoid dumping
 * 500-byte JSON blobs into a confirmation dialog; the user should be able to
 * read the prompt at a glance.
 */
function summarizeArgs(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return '(no arguments)';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v == null) continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    const trimmed = s.length > 60 ? s.slice(0, 60) + '…' : s;
    parts.push(`${k}=${trimmed}`);
    if (parts.length >= 5) {
      parts.push('…');
      break;
    }
  }
  return parts.join(', ');
}

/**
 * Ask the user to confirm a destructive call. Returns true on accept.
 * Throws an `McpError` on decline/cancel, or on a missing capability when
 * the fallback policy is "fail".
 */
export async function elicitConfirmation(
  server: Server,
  toolName: string,
  args: Record<string, unknown> | undefined,
): Promise<boolean> {
  const summary = summarizeArgs(args);
  const message =
    `This tool can change or remove data and the operator has required confirmation.\n\n` +
    `Tool: ${toolName}\n` +
    `Arguments: ${summary}\n\n` +
    `Proceed?`;

  try {
    const result = await server.elicitInput({
      mode: 'form',
      message,
      requestedSchema: {
        type: 'object',
        properties: {
          confirm: {
            type: 'string',
            title: 'Confirm',
            description: 'Choose "yes" to execute this destructive operation.',
            enum: ['yes', 'no'],
            enumNames: ['Yes — execute', 'No — cancel'],
          },
        },
        required: ['confirm'],
      },
    });

    if (result.action === 'accept') {
      const confirm = (result.content as Record<string, unknown> | undefined)?.confirm;
      if (confirm === 'yes') return true;
      throw new McpError(
        ErrorCode.InvalidParams,
        `User declined to confirm destructive operation '${toolName}'`,
      );
    }
    // decline or cancel
    throw new McpError(
      ErrorCode.InvalidParams,
      `User ${result.action === 'decline' ? 'declined' : 'cancelled'} the destructive operation '${toolName}'`,
    );
  } catch (err: unknown) {
    // The SDK rejects with an MCP error when the client doesn't advertise the
    // `elicitation` capability. Treat that as a missing capability and apply
    // the fallback policy.
    if (err instanceof McpError && err.code !== ErrorCode.InvalidParams) {
      const policy = fallbackPolicy();
      logger.warn('Elicitation unsupported by client', { toolName, fallback: policy, error: err.message });
      if (policy === 'allow') return true;
      throw new McpError(
        ErrorCode.InvalidParams,
        `Tool '${toolName}' is destructive and the connected client does not support confirmation prompts. ` +
          `Set MCP_CONFIRM_FALLBACK=allow to bypass on such clients, or use a client that supports MCP elicitation.`,
      );
    }
    throw err;
  }
}
