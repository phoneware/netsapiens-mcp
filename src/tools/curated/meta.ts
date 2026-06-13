/**
 * Escape-hatch meta-tools that give the model access to the full generated
 * tool registry without flooding the default tool list.
 *
 *   search_api(query, limit?)   — keyword search across all 727 generated
 *                                  tools by name and description.
 *   call_api(tool_name, args)   — invoke any generated tool by name. All
 *                                  existing filters (disable patterns, role
 *                                  tier, disabled actions) still apply.
 */

import type { CuratedTool } from './types.js';
import { textResult } from './types.js';
import type { GenericApiClient, ToolDefinition } from '../../generated/types.js';

/**
 * Build the meta-tools, parameterized over the full registry and a dispatcher.
 * Kept as a factory so the registry layer can inject the merged v1+v2 map and
 * the same dispatch function used for everything else (preserving filters).
 */
export function buildMetaTools(
  registry: Map<string, ToolDefinition>,
  dispatch: (toolName: string, args: Record<string, unknown>, client: GenericApiClient) => Promise<unknown>,
  /**
   * Predicate that returns true if a tool name should be visible in
   * search_api results. The registry layer threads this through so disabled
   * tools, over-tier tools, and (when MCP_DISABLE_DESTRUCTIVE=true)
   * destructive tools don't leak into search results that call_api would
   * just reject anyway.
   */
  isVisible: (toolName: string) => boolean = () => true,
): CuratedTool[] {
  const search_api: CuratedTool = {
    minRole: 'user',
    schema: {
      name: 'search_api',
      description:
        'Search the full NetSapiens API for tools by keyword. Returns matching tool names plus short descriptions. ' +
        'Use this when the curated tool set does not cover what you need, then call the discovered tool with `call_api`.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term — matches tool name and description.' },
          limit: { type: 'number', default: 15, description: 'Max results to return.' },
        },
        required: ['query'],
      },
    },
    handler: async (args) => {
      const q = String(args.query ?? '').toLowerCase().trim();
      const limit = typeof args.limit === 'number' ? args.limit : 15;
      if (!q) return textResult({ matches: [], note: 'Empty query' });
      const terms = q.split(/\s+/).filter(Boolean);

      const scored: Array<{ name: string; description: string; score: number }> = [];
      for (const [name, def] of registry) {
        if (!isVisible(name)) continue;
        const haystack = (name + ' ' + def.schema.description).toLowerCase();
        let score = 0;
        for (const t of terms) {
          if (!haystack.includes(t)) { score = 0; break; }
          score += haystack.includes(t) ? 1 : 0;
          // Bonus when the term hits the tool name itself
          if (name.toLowerCase().includes(t)) score += 2;
        }
        if (score > 0) scored.push({ name, description: def.schema.description, score });
      }
      scored.sort((a, b) => b.score - a.score);
      const matches = scored.slice(0, limit).map(({ name, description }) => ({
        name,
        description: description.length > 200 ? description.slice(0, 200) + '…' : description,
      }));
      return textResult({ query: q, total: scored.length, matches });
    },
  };

  const call_api: CuratedTool = {
    minRole: 'user',
    schema: {
      name: 'call_api',
      description:
        'Invoke any tool from the full NetSapiens API by name. Use after `search_api` finds a tool the curated set does not include. ' +
        'The same role tier, disable patterns, and action filters that govern the curated set apply here too.',
      inputSchema: {
        type: 'object',
        properties: {
          tool_name: { type: 'string', description: 'Exact tool name as returned by search_api.' },
          args: { type: 'object', description: 'Arguments for the tool. Pass an empty object {} if none.', default: {} },
        },
        required: ['tool_name'],
      },
    },
    handler: async (args, client) => {
      const name = String(args.tool_name);
      const inner = (args.args ?? {}) as Record<string, unknown>;
      const result = await dispatch(name, inner, client);
      // dispatch may return null on unknown tool — surface a useful error
      if (result === null || result === undefined) {
        return textResult({ error: `Tool '${name}' is not registered. Use search_api to discover the correct name.` });
      }
      return result as ReturnType<typeof textResult>;
    },
  };

  return [search_api, call_api];
}
