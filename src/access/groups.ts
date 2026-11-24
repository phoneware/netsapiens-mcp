/**
 * The tool catalog the access policy compiles against (spec 3.3): each tool's canonical and exposed names, the
 * groups it belongs to, and the content classification of each operation. Built once, lazily, from the
 * registries, which are static.
 *
 * Dispatch resolves a name the same way: a curated or meta name first, then an exposed name, then a registry key.
 * This module follows that order so the policy judges the tool that dispatch would run.
 */
import { CURATED_CATALOG } from '../tools/curated/catalog.js';
import { buildMetaTools } from '../tools/curated/meta.js';
import { classifyTool, isToolDestructive, isToolReadOnly } from '../tools/index.js';
import { isDestructiveV1Action, V1_READ_ACTION } from '../netsapiens/operation-key.js';
import { toolRegistry as v2Registry } from '../generated/registry.js';
import { v1ToolRegistry } from '../generated/v1/registry.js';
import type { ToolDefinition } from '../generated/types.js';
import { OPERATION_OUTPUTS } from '../governance/operation-outputs.generated.js';
import { CONTENT_KIND_ORDER, contentKindsOf, v1OperationKeyOf } from '../governance/content-operations.js';
import type { ContentKind } from '../governance/types.js';
import type { ToolCatalogEntry, ToolCatalogView } from './types.js';

/**
 * A copy of the shortening rules in src/tools/index.ts (SHORTEN_RULES), which that module keeps private. The parity
 * test in src/__tests__/access-groups.test.ts compares every exposed name with what getAllToolDefinitions returns.
 */
const SHORTEN_RULES: ReadonlyArray<readonly [RegExp, string]> = [
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

const MCP_MAX_NAME_LEN = 64;

function shortenName(name: string): string {
 let out = name;
 for (const [pattern, replacement] of SHORTEN_RULES) out = out.replace(pattern, replacement);
 return out;
}

/** Exposed names for the generated keys, with the collision rule of src/tools/index.ts. */
function exposedNames(registryKeys: Iterable<string>): {
 readonly byRegistryKey: ReadonlyMap<string, string>;
 readonly byExposed: ReadonlyMap<string, string>;
} {
 const byRegistryKey = new Map<string, string>();
 const byExposed = new Map<string, string>();
 for (const registryKey of registryKeys) {
  let exposed = registryKey;
  if (registryKey.length > MCP_MAX_NAME_LEN) exposed = shortenName(registryKey);
  if (exposed.length > MCP_MAX_NAME_LEN) {
   const hash = Buffer.from(registryKey).toString('base64url').slice(0, 6);
   exposed = `${exposed.slice(0, MCP_MAX_NAME_LEN - 7)}_${hash}`;
  }
  if (byExposed.has(exposed)) {
   const hash = Buffer.from(registryKey).toString('base64url').slice(0, 4);
   exposed = `${exposed.slice(0, MCP_MAX_NAME_LEN - 5)}_${hash}`;
  }
  byExposed.set(exposed, registryKey);
  byRegistryKey.set(registryKey, exposed);
 }
 return { byRegistryKey, byExposed };
}

/** The generated tools by registry key: v2 first, then the v1 keys that do not collide. Same order as src/tools/index.ts. */
function generatedRegistry(): Map<string, ToolDefinition> {
 const combined = new Map<string, ToolDefinition>();
 for (const [name, def] of v2Registry) combined.set(name, def);
 for (const [name, def] of v1ToolRegistry) if (!combined.has(name)) combined.set(name, def);
 return combined;
}

/** The content keys an operation contributes: its v2 key, or the canonical v1 key. */
function operationKeyOf(def: ToolDefinition): string | undefined {
 const key = def.operation?.key;
 if (key === undefined) return undefined;
 return def.operation?.family === 'v1' ? v1OperationKeyOf(key) : key;
}

/**
 * The access of a generated entry, from the operation it dispatches. A name lookup would find a curated tool of the same
 * name and judge the generated write by it. A v1 action is read or destructive by its action; a v2 entry takes the hints of
 * its definition, its HTTP method, as the policy's operation check does.
 */
function generatedAccess(registryKey: string, def: ToolDefinition): { readonly read: boolean; readonly destructive: boolean } {
  const key = operationKeyOf(def);
  if (key?.startsWith('v1:')) {
    const [, object = '', action = ''] = key.split(':');
    return { read: V1_READ_ACTION.test(action), destructive: isDestructiveV1Action(object, action) };
  }
  const hints = classifyTool(registryKey, def);
  return { read: hints.readOnlyHint, destructive: hints.destructiveHint };
}

function entryFor(input: {
  readonly canonical: string;
  readonly exposed: string;
  readonly origin: '@curated' | '@meta' | '@generated';
  readonly operations: readonly string[];
  readonly classified: boolean;
  /** A generated entry's access, from its own definition. Curated and meta entries read their own metadata by name. */
  readonly access?: { readonly read: boolean; readonly destructive: boolean };
}): ToolCatalogEntry {
  const groups = new Set<string>([input.origin]);
  const access = input.access ?? { read: isToolReadOnly(input.canonical), destructive: isToolDestructive(input.canonical) };
  groups.add(access.read ? '@read' : '@write');
  if (access.destructive) groups.add('@destructive');
 const kinds = new Set<ContentKind>();
 for (const operation of input.operations) {
  const classification = contentKindsOf(operation);
  if (classification === 'unreviewed') {
   for (const kind of CONTENT_KIND_ORDER) kinds.add(kind);
  } else if (classification !== undefined) {
   for (const kind of classification) kinds.add(kind);
  }
 }
 for (const kind of CONTENT_KIND_ORDER) if (kinds.has(kind)) groups.add(`@content:${kind}`);
 if (input.origin === '@generated' && !input.classified) groups.add('@unclassified');
 return { canonical: input.canonical, exposed: input.exposed, groups: [...groups] };
}

/** Whether the server runs curated mode. Mirrors getToolMode() in src/tools/index.ts: every value except "full". */
function curatedMode(): boolean {
 return (process.env.MCP_TOOL_MODE || '').toLowerCase() !== 'full';
}

function buildCatalog(): ToolCatalogView {
 const curated = new Map<string, ToolCatalogEntry>();
 for (const tool of CURATED_CATALOG) {
  const name = tool.schema.name;
  curated.set(name, entryFor({ canonical: name, exposed: name, origin: '@curated', operations: tool.operations, classified: true }));
 }
 for (const tool of buildMetaTools(new Map(), async () => undefined)) {
  const name = tool.schema.name;
  curated.set(name, entryFor({ canonical: name, exposed: name, origin: '@meta', operations: tool.operations, classified: true }));
 }

 const generated = generatedRegistry();
 const names = exposedNames(generated.keys());
 const generatedEntries = new Map<string, ToolCatalogEntry>();
 for (const [registryKey, def] of generated) {
  const operation = operationKeyOf(def);
  generatedEntries.set(
   registryKey,
   entryFor({
    canonical: registryKey,
    exposed: names.byRegistryKey.get(registryKey) ?? registryKey,
    origin: '@generated',
    operations: operation === undefined ? [] : [operation],
    classified: operation !== undefined && Object.hasOwn(OPERATION_OUTPUTS, operation),
    access: generatedAccess(registryKey, def),
   }),
  );
 }

 return {
  lookupTool(name: string): ToolCatalogEntry | undefined {
   const curatedEntry = curated.get(name);
   const generatedEntry = generatedEntries.get(names.byExposed.get(name) ?? name);
   // Dispatch runs the curated tool first in curated mode, and the generated tool first in full mode.
   const [preferred, fallback] = curatedMode() ? [curatedEntry, generatedEntry] : [generatedEntry, curatedEntry];
   return preferred ?? fallback;
  },
  lookupOperation(key: string) {
   return contentKindsOf(key);
  },
 };
}

let cached: ToolCatalogView | undefined;

/** The catalog view the policy compiles against. Built on first use; the registries it reads never change at runtime. */
export function getToolCatalogView(): ToolCatalogView {
 cached ??= buildCatalog();
 return cached;
}
