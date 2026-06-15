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
import { toolRegistry as v2ToolRegistry } from '../generated/registry.js';
import { v1ToolRegistry } from '../generated/v1/registry.js';
import type { GenericApiClient, ToolDefinition } from '../generated/types.js';
import { ROLE_HIERARCHY, type UserRole } from '../auth/roles.js';
import { CURATED_CATALOG } from './curated/catalog.js';
import { buildMetaTools } from './curated/meta.js';
import { confirmDestructiveEnabled, elicitConfirmation } from './elicitation.js';
import { getPromotedToolNames, recordCallApiInvocation } from './promotion/index.js';

/**
 * Combined registry: v2 first (canonical), then v1 entries that don't collide.
 * Built locally without mutating the imported v2 map, so tests and tooling
 * that introspect the generated registries see them in their original shape.
 * v1 names are all `v1_*` so they sort and disable cleanly with
 * `MCP_DISABLED_TOOLS=v1_*`.
 */
const toolRegistry = new Map<string, ToolDefinition>();
for (const [name, def] of v2ToolRegistry) toolRegistry.set(name, def);
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
// Semantic destructive filter (MCP_DISABLE_DESTRUCTIVE)
//
// MCP_DISABLED_TOOLS matches *names* — useful for power users, but it won't
// catch composites like `end_call` that are destructive in effect even though
// they don't start with `delete_`. This semantic toggle hides everything
// classified as destructive (composite metadata first, then the prefix
// inference fallback) from the tool list, dispatch, AND search_api results.
// ---------------------------------------------------------------------------

function disableDestructiveEnabled(): boolean {
  return process.env.MCP_DISABLE_DESTRUCTIVE === 'true';
}

/**
 * True when the tool is destructive in effect. Looks at explicit composite
 * metadata first (`CuratedTool.destructive`), then falls back to the
 * prefix-based heuristic the generated registry uses.
 */
export function isToolDestructive(name: string): boolean {
  const curated = CURATED_CATALOG.find((t) => t.schema.name === name);
  if (curated && curated.destructive !== undefined) return curated.destructive;
  return classifyTool(name).destructiveHint;
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

// ---------------------------------------------------------------------------
// Tool mode (curated vs full)
//
// `MCP_TOOL_MODE=curated` (the default) exposes the small task-shaped
// catalog in src/tools/curated/ plus search_api/call_api. This is what AI
// clients actually want: a focused surface they can choose from quickly,
// with an escape hatch to the long tail when needed.
// `MCP_TOOL_MODE=full` exposes all 700+ generated tools (legacy behavior).
// ---------------------------------------------------------------------------

type ToolMode = 'curated' | 'full';

function getToolMode(): ToolMode {
  const v = (process.env.MCP_TOOL_MODE || '').toLowerCase();
  return v === 'full' ? 'full' : 'curated';
}

/**
 * Visibility predicate for the generated registry. Returns true when a tool
 * should appear in search results / promoted into a user's catalog.
 */
function isGeneratedToolVisible(toolName: string, userRole?: UserRole): boolean {
  if (isToolDisabled(toolName)) return false;
  if (!roleAllows(userRole, toolName)) return false;
  if (disableDestructiveEnabled() && classifyTool(toolName).destructiveHint) return false;
  return true;
}

/**
 * The curated tools, plus search_api / call_api, plus any tools promoted into
 * the user's catalog through repeated call_api invocations. All entries are
 * filtered by scope, disable patterns, and the destructive toggle.
 *
 * `userIdentity` is the NetSapiens username from the bearer token; promotion
 * is keyed on it so each NS user's catalog reflects their own muscle memory.
 */
async function curatedExposedTools(userRole?: UserRole, userIdentity?: string): Promise<Array<{
  name: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
}>> {
  const meta = buildMetaTools(
    toolRegistry,
    async (name, args, client) => {
      // Reuse handleToolCall so every filter (disable, action, role, name
      // mapping, destructive) applies to call_api invocations too.
      return handleToolCall(client as unknown as NetSapiensClient, name, args, userRole);
    },
    // search_api visibility: hide anything the operator has disabled, anything
    // above the user's role tier, and (when MCP_DISABLE_DESTRUCTIVE=true)
    // anything destructive. Stops the model from finding a tool that call_api
    // would then reject.
    (toolName) => isGeneratedToolVisible(toolName, userRole),
  );
  const all = [...CURATED_CATALOG, ...meta];
  const tools: Array<{
    name: string;
    description: string;
    inputSchema: object;
    annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  }> = [];
  const seen = new Set<string>();
  for (const t of all) {
    if (userRole && ROLE_HIERARCHY[userRole] < ROLE_HIERARCHY[t.minRole] && roleFilterEnabled()) continue;
    if (isToolDisabled(t.schema.name)) continue;
    // Respect explicit composite metadata in addition to the prefix-based
    // inference, then honor the semantic MCP_DISABLE_DESTRUCTIVE toggle.
    const inferred = classifyTool(t.schema.name);
    const destructive = t.destructive ?? inferred.destructiveHint;
    const readOnly = t.readOnly ?? inferred.readOnlyHint;
    if (disableDestructiveEnabled() && destructive) continue;
    seen.add(t.schema.name);
    tools.push({
      name: t.schema.name,
      description: t.schema.description,
      inputSchema: t.schema.inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: destructive },
    });
  }

  // Per-user promotion: append generated tools the user has called frequently
  // through call_api, subject to the same filters. Promoted tools appear under
  // their shortened exposed names.
  if (userIdentity) {
    const promoted = await getPromotedToolNames(userIdentity);
    const mapping = buildNameMapping();
    for (const registryKey of promoted) {
      if (!isGeneratedToolVisible(registryKey, userRole)) continue;
      const exposed = mapping.registryToExposed.get(registryKey) ?? registryKey;
      if (seen.has(exposed)) continue;
      const def = toolRegistry.get(registryKey);
      if (!def) continue;
      const annotations = classifyTool(registryKey);
      seen.add(exposed);
      tools.push({
        name: exposed,
        description: `[promoted] ${def.schema.description}`,
        inputSchema: def.schema.inputSchema,
        annotations,
      });
    }
  }
  return tools;
}

/** Lookup a curated or meta tool by exposed name (per-call construction to bind userRole). */
function findCuratedTool(name: string, userRole?: UserRole) {
  const meta = buildMetaTools(
    toolRegistry,
    async (innerName, innerArgs, client) =>
      handleToolCall(client as unknown as NetSapiensClient, innerName, innerArgs, userRole),
    (toolName) => {
      if (isToolDisabled(toolName)) return false;
      if (!roleAllows(userRole, toolName)) return false;
      if (disableDestructiveEnabled() && classifyTool(toolName).destructiveHint) return false;
      return true;
    },
  );
  return [...CURATED_CATALOG, ...meta].find((t) => t.schema.name === name);
}

/**
 * Returns the full list of tool definitions exposed to MCP clients.
 *
 * In curated mode (default), the curated catalog + meta-tools + any
 * user-specific promoted tools are returned. In full mode, every generated
 * tool (subject to disable/role filters and name shortening) is returned.
 *
 * `userIdentity` is the NetSapiens username from the bearer token; it scopes
 * the promotion lookup.
 */
export async function getAllToolDefinitions(
  userRole?: UserRole,
  userIdentity?: string,
): Promise<Array<{
  name: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
}>> {
  if (getToolMode() === 'curated') {
    return curatedExposedTools(userRole, userIdentity);
  }

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
    const annotations = classifyTool(registryKey);
    if (disableDestructiveEnabled() && annotations.destructiveHint) continue;
    tools.push({
      name: exposed,
      description: def.schema.description,
      inputSchema: def.schema.inputSchema,
      annotations,
    });
  }
  return tools;
}

/**
 * Dispatches a tool call. In curated mode tries the curated/meta tools first
 * (so `call_api` is intercepted here too); falls through to the generated
 * registry for `full` mode or when call_api re-enters with a generated name.
 *
 * When userRole is provided, calls to tools above the user's tier are
 * rejected (defense-in-depth alongside the ListTools filter).
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
  if (disableDestructiveEnabled() && isToolDestructive(toolName)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Tool '${toolName}' is destructive and MCP_DISABLE_DESTRUCTIVE is set`,
    );
  }

  // Curated/meta tools take precedence so call_api can re-enter for the
  // generated registry without infinite recursion through the curated layer.
  if (getToolMode() === 'curated' || toolName === 'search_api' || toolName === 'call_api') {
    const curated = findCuratedTool(toolName, userRole);
    if (curated) {
      if (userRole && ROLE_HIERARCHY[userRole] < ROLE_HIERARCHY[curated.minRole] && roleFilterEnabled()) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Tool '${toolName}' requires a higher access tier than your account has`,
        );
      }
      return curated.handler(args ?? {}, client as unknown as GenericApiClient);
    }
    // Fall through to the generated registry only if explicitly invoked via
    // call_api (which routes through handleToolCall recursively).
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
 *
 * @param server          MCP server instance.
 * @param client          NetSapiensClient bound to the authenticated user's bearer.
 * @param userRole        Scope tier from the NS user record; enables role filtering.
 * @param userIdentity    NS username (used to scope per-user tool promotion).
 */
export function registerAllTools(
  server: Server,
  client: NetSapiensClient,
  userRole?: UserRole,
  userIdentity?: string,
): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: await getAllToolDefinitions(userRole, userIdentity) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const callArgs = (args ?? {}) as Record<string, unknown>;

    try {
      // Optional confirmation gate. Skip elicitation entirely if
      // MCP_DISABLE_DESTRUCTIVE will block the call anyway — that policy
      // wins; we don't want to prompt the user for a call we'll reject.
      if (
        confirmDestructiveEnabled() &&
        !disableDestructiveEnabled() &&
        isToolDestructive(name)
      ) {
        await elicitConfirmation(server, name, callArgs);
        // elicitConfirmation throws on decline/cancel; if we got here the
        // user accepted, so dispatch normally.
      }

      const result = await handleToolCall(client, name, callArgs, userRole);

      // Per-user tool promotion. We only track call_api invocations — that's
      // the signal that the user is reaching for a tool not in the default
      // catalog. After recording, if this call just crossed the promotion
      // threshold, notify the client to re-list so the new tool appears.
      if (name === 'call_api' && result) {
        const innerToolName = String(callArgs?.tool_name ?? '');
        if (innerToolName) {
          try {
            const { promoted } = await recordCallApiInvocation(userIdentity, innerToolName);
            if (promoted) {
              await server.sendToolListChanged();
            }
          } catch {
            // Promotion tracking is best-effort. Already logged inside the store.
          }
        }
      }
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
