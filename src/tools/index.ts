import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { NetSapiensClient } from '../netsapiens-client.js';

import * as system from './system.js';
import * as resellers from './resellers.js';
import * as domains from './domains.js';
import * as sites from './sites.js';
import * as users from './users.js';
import * as phoneNumbers from './phone-numbers.js';
import * as callQueues from './call-queues.js';
import * as cdrs from './cdrs.js';
import * as calls from './calls.js';
import * as conferences from './conferences.js';
import * as autoAttendants from './auto-attendants.js';
import * as answerRules from './answer-rules.js';
import * as timeframes from './timeframes.js';
import * as greetings from './greetings.js';
import * as voicemails from './voicemails.js';
import * as musicOnHold from './music-on-hold.js';
import * as contacts from './contacts.js';
import * as phones from './phones.js';
import * as recordings from './recordings.js';
import * as messaging from './messaging.js';
import * as statistics from './statistics.js';
import * as dialPlans from './dial-plans.js';
import * as dialPolicy from './dial-policy.js';
import * as subscriptions from './subscriptions.js';
import * as routes from './routes.js';
import * as addresses from './addresses.js';
import * as numberFilters from './number-filters.js';
import * as holdMessages from './hold-messages.js';
import * as videoMeetings from './video-meetings.js';
import * as misc from './misc.js';

const toolModules = [
  system,
  resellers,
  domains,
  sites,
  users,
  phoneNumbers,
  callQueues,
  cdrs,
  calls,
  conferences,
  autoAttendants,
  answerRules,
  timeframes,
  greetings,
  voicemails,
  musicOnHold,
  contacts,
  phones,
  recordings,
  messaging,
  statistics,
  dialPlans,
  dialPolicy,
  subscriptions,
  routes,
  addresses,
  numberFilters,
  holdMessages,
  videoMeetings,
  misc,
];

/**
 * Read-only verbs — these tools do not modify NS state.
 * Anything else is treated as a writer.
 */
const READ_PREFIXES = ['get_', 'list_', 'count_', 'search_', 'test_', 'export_', 'download_', 'read_', 'find_', 'lookup_'];

/**
 * Tools whose semantics change with an `action` argument (manage_*).
 * These can read OR write, so we classify them as writers for safety.
 */
const MIXED_PREFIXES = ['manage_'];

/**
 * Verbs that imply potentially destructive operations.
 */
const DESTRUCTIVE_HINTS = ['delete_', 'revoke_', 'remove_', 'cancel_', 'destroy_', 'reset_', 'restart_', 'reboot_', 'restore_'];

function classifyTool(name: string): { readOnlyHint: boolean; destructiveHint: boolean } {
  if (READ_PREFIXES.some((p) => name.startsWith(p))) {
    return { readOnlyHint: true, destructiveHint: false };
  }
  if (MIXED_PREFIXES.some((p) => name.startsWith(p))) {
    return { readOnlyHint: false, destructiveHint: true };
  }
  const destructive = DESTRUCTIVE_HINTS.some((p) => name.startsWith(p));
  return { readOnlyHint: false, destructiveHint: destructive };
}

/**
 * Compile a comma-separated list of glob patterns into a single RegExp.
 * Supports `*` as a wildcard (matches any characters).
 *
 * Example: "delete_*,remove_*,manage_certificate" disables all delete and remove
 * prefixed tools plus the specific manage_certificate tool.
 */
function compileToolPatterns(patterns: string): RegExp | null {
  const list = patterns.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return null;
  const regexParts = list.map((pat) =>
    pat
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*'),
  );
  return new RegExp(`^(${regexParts.join('|')})$`);
}

let disabledPatternsCache: { source: string; regex: RegExp | null } | null = null;
function getDisabledPattern(): RegExp | null {
  const env = process.env.MCP_DISABLED_TOOLS || '';
  if (!disabledPatternsCache || disabledPatternsCache.source !== env) {
    disabledPatternsCache = { source: env, regex: compileToolPatterns(env) };
  }
  return disabledPatternsCache.regex;
}

export function isToolDisabled(name: string): boolean {
  const re = getDisabledPattern();
  return re ? re.test(name) : false;
}

/**
 * Comma-separated list of action argument values that should be blocked when
 * passed to multi-action tools like `manage_*` (e.g. "delete,revoke,destroy").
 * Matches the `args.action` field on tool calls.
 */
let disabledActionsCache: { source: string; set: Set<string> } | null = null;
function getDisabledActions(): Set<string> {
  const env = process.env.MCP_DISABLED_ACTIONS || '';
  if (!disabledActionsCache || disabledActionsCache.source !== env) {
    const set = new Set(env.split(',').map((s) => s.trim()).filter(Boolean));
    disabledActionsCache = { source: env, set };
  }
  return disabledActionsCache.set;
}

export function isActionDisabled(action: unknown): boolean {
  if (typeof action !== 'string') return false;
  const set = getDisabledActions();
  if (set.size === 0) return false;
  return set.has(action);
}

/**
 * Returns all tool definitions from all modules, decorated with
 * read/write annotations per the MCP spec (ToolAnnotations).
 *
 * Tools matched by MCP_DISABLED_TOOLS (comma-separated globs) are omitted.
 */
export function getAllToolDefinitions(): any[] {
  return toolModules
    .flatMap((m) => m.toolDefinitions as any[])
    .filter((tool) => !isToolDisabled(tool.name))
    .map((tool) => {
      const { readOnlyHint, destructiveHint } = classifyTool(tool.name);
      return {
        ...tool,
        annotations: {
          ...(tool.annotations ?? {}),
          readOnlyHint,
          destructiveHint,
        },
      };
    });
}

/**
 * Dispatches a tool call to the appropriate module handler.
 * Returns the result or null if no module handles the tool.
 */
export async function handleToolCall(
  client: NetSapiensClient,
  toolName: string,
  args: any
): Promise<any> {
  if (isToolDisabled(toolName)) {
    throw new McpError(ErrorCode.MethodNotFound, `Tool '${toolName}' is disabled on this server`);
  }
  if (args && isActionDisabled(args.action)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Action '${args.action}' is disabled on this server (blocked by MCP_DISABLED_ACTIONS)`,
    );
  }
  for (const mod of toolModules) {
    const result = await mod.handleToolCall(client, toolName, args);
    if (result !== null) {
      return result;
    }
  }
  return null;
}

/**
 * Registers ListTools and CallTool handlers on an MCP Server.
 */
export function registerAllTools(server: Server, client: NetSapiensClient): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: getAllToolDefinitions() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await handleToolCall(client, name, args);
      if (result !== null) {
        return result;
      }
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
      throw new McpError(
        ErrorCode.InternalError,
        `Error executing tool ${name}: ${error}`
      );
    }
  });
}
