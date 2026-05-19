/**
 * Tool registry — wraps the auto-generated tool registry in src/generated/
 * and layers on our own concerns: read/write annotations, disable patterns,
 * and the dispatch hookup for the MCP Server.
 *
 * The generated layer is produced by `npm run generate` from
 * spec/netsapiens-api-v2.json. Do not edit src/generated/ by hand.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { NetSapiensClient } from '../netsapiens-client.js';
import { toolRegistry } from '../generated/registry.js';
import { v1ToolRegistry } from '../generated/v1/registry.js';
import type { GenericApiClient, ToolDefinition } from '../generated/types.js';
import { ROLE_HIERARCHY, type UserRole } from '../auth/roles.js';

// Merge v1 RPC-style tools into the same registry. v1 names are all
// prefixed `v1_`, so they sort and disable cleanly: `MCP_DISABLED_TOOLS=v1_*`.
for (const [name, def] of v1ToolRegistry) {
  if (!toolRegistry.has(name)) toolRegistry.set(name, def);
}

// ---------------------------------------------------------------------------
// Read/write classification (annotations only — naming is left to the spec)
// ---------------------------------------------------------------------------

const READ_PREFIXES = ['get_', 'list_', 'count_', 'search_', 'test_', 'export_', 'download_', 'read_', 'find_', 'lookup_'];
const MIXED_PREFIXES = ['manage_'];
const DESTRUCTIVE_HINTS = ['delete_', 'revoke_', 'remove_', 'cancel_', 'destroy_', 'reset_', 'restart_', 'reboot_', 'restore_'];

function classifyTool(name: string): { readOnlyHint: boolean; destructiveHint: boolean } {
  if (READ_PREFIXES.some((p) => name.startsWith(p))) {
    return { readOnlyHint: true, destructiveHint: false };
  }
  if (MIXED_PREFIXES.some((p) => name.startsWith(p))) {
    return { readOnlyHint: false, destructiveHint: true };
  }
  // HTTP verbs in the spec map cleanly: GET → read, DELETE → destructive, PUT/PATCH/POST → write.
  if (name.startsWith('get_')) return { readOnlyHint: true, destructiveHint: false };
  if (name.startsWith('delete_')) return { readOnlyHint: false, destructiveHint: true };
  if (name.startsWith('put_') || name.startsWith('patch_') || name.startsWith('post_')) {
    return { readOnlyHint: false, destructiveHint: false };
  }
  const destructive = DESTRUCTIVE_HINTS.some((p) => name.startsWith(p));
  return { readOnlyHint: false, destructiveHint: destructive };
}

// ---------------------------------------------------------------------------
// Disabled-tool patterns (MCP_DISABLED_TOOLS, MCP_DISABLED_ACTIONS)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Coarse role-tier filtering
//
// NetSapiens has no per-endpoint capability introspection — authorization is
// scope-tier + ownership, enforced server-side (403). We hide the clearly-
// privileged resource families from lower tiers as a UX nicety; NS remains the
// real gatekeeper for everything else. The map is intentionally small and
// conservative: only families we are confident require a given tier are listed,
// so we never hide a tool a user could legitimately call. Anything unmatched
// defaults to 'user' (visible to all).
//
// Patterns match the tool name (which encodes the resource). Disable the whole
// behavior with MCP_DISABLE_ROLE_FILTER=true.
// ---------------------------------------------------------------------------

const TIER_RULES: Array<{ role: UserRole; patterns: RegExp[] }> = [
  {
    role: 'system_admin',
    patterns: [
      /certificate/i,
      /(^|_)template(s)?(_|$)/i,
      /(^|_)image(s)?(_|$)/i,
      /(^|_)route(s)?(_|$)/i,
      /connection/i,
      /firebase/i,
      /backup/i,
      /restore/i,
      /accesslog|access_log/i,
      /auditlog|audit_log/i,
      /(^|_)sfu(_|$)/i,
      /(^|_)insight(_|$)/i,
      /configuration|config_definition|configdef/i,
      // system-wide dial policy (domain-scoped variants contain "domain")
      /^(get|post|put|delete|read|create|update)_dialpolicy/i,
      /v1_(configuration|template|image|route|connection|firebase|backup|restore|accesslog|auditlog|sfu|insight|uiconfigdef)/i,
    ],
  },
  {
    role: 'reseller',
    patterns: [
      /reseller/i,
      /^create_domain$|^delete_domain$|^domain_billing$|^count_domains$/i,
      /v1_reseller/i,
    ],
  },
];

/** Minimum role required to see a tool. Defaults to 'user' if unmatched. */
export function toolMinRole(name: string): UserRole {
  for (const rule of TIER_RULES) {
    if (rule.patterns.some((p) => p.test(name))) return rule.role;
  }
  return 'user';
}

function roleFilterEnabled(): boolean {
  return process.env.MCP_DISABLE_ROLE_FILTER !== 'true';
}

/** True if a user of `userRole` is allowed to see/use a tool requiring `minRole`. */
function roleAllows(userRole: UserRole | undefined, name: string): boolean {
  if (!userRole || !roleFilterEnabled()) return true;
  const required = toolMinRole(name);
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[required];
}

// ---------------------------------------------------------------------------
// Name shortening
//
// MCP clients (Claude, ChatGPT) cap tool names at 64 characters. Several
// OpenAPI-generated names from deep paths blow past that, so we apply a set
// of deterministic abbreviations that collapse REST verbiage like
// `domains_by_domain_users_by_user` → `domain_user`. The mapping is built
// once at module load and cached for dispatch.
// ---------------------------------------------------------------------------

const SHORTEN_RULES: Array<[RegExp, string]> = [
  [/domains_by_domain/g, 'domain'],
  [/users_by_user/g, 'user'],
  [/conferences_by_conference/g, 'conference'],
  [/participants_by_participant/g, 'participant'],
  [/callqueues_by_callqueue/g, 'callqueue'],
  [/calls_by_call_id/g, 'call'],
  [/meetings_by_id/g, 'meeting'],
  [/instance_by_instance/g, 'instance'],
  [/devices_by_device/g, 'device'],
  [/dialplans_by_dialplan/g, 'dialplan'],
  [/dialpolicy_by_policy/g, 'dialpolicy'],
  [/sites_by_site/g, 'site'],
  [/resellers_by_reseller/g, 'reseller'],
  [/schedule_by_schedule_name/g, 'schedule'],
  [/timeframes_by_timeframe/g, 'timeframe'],
  [/contacts_by_contact_id/g, 'contact'],
  [/agents_by_agent/g, 'agent'],
];

function shortenName(name: string): string {
  let out = name;
  for (const [pattern, replacement] of SHORTEN_RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

const MCP_MAX_NAME_LEN = 64;

interface NameMapping {
  // exposed name (what MCP clients see) → registry key (original generated name)
  exposedToRegistry: Map<string, string>;
  // registry key → exposed name (for ListTools rendering)
  registryToExposed: Map<string, string>;
}

let nameMappingCache: NameMapping | null = null;
function buildNameMapping(): NameMapping {
  if (nameMappingCache) return nameMappingCache;
  const exposedToRegistry = new Map<string, string>();
  const registryToExposed = new Map<string, string>();
  const collisions: string[] = [];
  for (const [registryKey] of toolRegistry) {
    let exposed = registryKey;
    if (registryKey.length > MCP_MAX_NAME_LEN) {
      exposed = shortenName(registryKey);
    }
    if (exposed.length > MCP_MAX_NAME_LEN) {
      // Still too long — truncate with a deterministic hash suffix.
      const hash = Buffer.from(registryKey).toString('base64url').slice(0, 6);
      exposed = `${exposed.slice(0, MCP_MAX_NAME_LEN - 7)}_${hash}`;
    }
    if (exposedToRegistry.has(exposed)) {
      collisions.push(`${registryKey} → ${exposed}`);
      // Disambiguate with a short hash suffix.
      const hash = Buffer.from(registryKey).toString('base64url').slice(0, 4);
      exposed = `${exposed.slice(0, MCP_MAX_NAME_LEN - 5)}_${hash}`;
    }
    exposedToRegistry.set(exposed, registryKey);
    registryToExposed.set(registryKey, exposed);
  }
  if (collisions.length) {
    // eslint-disable-next-line no-console
    console.warn('[tools] shortened-name collisions resolved with hashes:', collisions);
  }
  nameMappingCache = { exposedToRegistry, registryToExposed };
  return nameMappingCache;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Returns the full list of tool definitions exposed to MCP clients.
 * Wraps each generated tool with our read/write annotations, skips tools
 * matched by MCP_DISABLED_TOOLS, and (when a userRole is given) hides tools
 * that require a higher tier than the user has.
 */
export function getAllToolDefinitions(userRole?: UserRole): Array<{
  name: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
}> {
  const mapping = buildNameMapping();
  const tools: Array<{
    name: string;
    description: string;
    inputSchema: object;
    annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  }> = [];
  for (const [registryKey, def] of toolRegistry) {
    const exposed = mapping.registryToExposed.get(registryKey) ?? registryKey;
    if (isToolDisabled(exposed) || isToolDisabled(registryKey)) continue;
    if (!roleAllows(userRole, registryKey)) continue;
    tools.push({
      name: exposed,
      description: def.schema.description,
      inputSchema: def.schema.inputSchema,
      annotations: classifyTool(registryKey),
    });
  }
  return tools;
}

/**
 * Dispatches a tool call to the generated registry's handler.
 * Returns the tool result or null if the tool isn't registered.
 *
 * When userRole is provided, a call to a tool above the user's tier is
 * rejected here too (defense-in-depth alongside the ListTools filter).
 */
export async function handleToolCall(
  client: NetSapiensClient,
  toolName: string,
  args: Record<string, unknown>,
  userRole?: UserRole,
): Promise<unknown> {
  if (isToolDisabled(toolName)) {
    throw new McpError(ErrorCode.MethodNotFound, `Tool '${toolName}' is disabled on this server`);
  }
  if (args && isActionDisabled((args as { action?: unknown }).action)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Action '${(args as { action?: unknown }).action}' is disabled on this server (blocked by MCP_DISABLED_ACTIONS)`,
    );
  }
  // Translate the exposed (possibly-shortened) name back to the registry key.
  const mapping = buildNameMapping();
  const registryKey = mapping.exposedToRegistry.get(toolName) ?? toolName;
  if (!roleAllows(userRole, registryKey)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Tool '${toolName}' requires a higher access tier than your account has`,
    );
  }
  const def: ToolDefinition | undefined = toolRegistry.get(registryKey);
  if (!def) return null;
  return def.handler(args ?? {}, client as unknown as GenericApiClient);
}

/**
 * Wires ListTools and CallTool handlers onto an MCP Server.
 * Pass the authenticated user's role to enable coarse tier filtering.
 */
export function registerAllTools(server: Server, client: NetSapiensClient, userRole?: UserRole): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: getAllToolDefinitions(userRole) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await handleToolCall(client, name, (args ?? {}) as Record<string, unknown>, userRole);
      if (result === null || result === undefined) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
      return result as { content: Array<{ type: 'text'; text: string }> };
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
      throw new McpError(
        ErrorCode.InternalError,
        `Error executing tool ${name}: ${error}`,
      );
    }
  });
}
