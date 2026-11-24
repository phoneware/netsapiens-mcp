import { describe, expect, it } from 'vitest';
import { getToolCatalogView } from '../access/groups.js';
import type { ToolCatalogEntry } from '../access/types.js';
import { CURATED_CATALOG } from '../tools/curated/catalog.js';
import { getAllToolDefinitions } from '../tools/index.js';
import { toolRegistry } from '../generated/registry.js';
import { v1ToolRegistry } from '../generated/v1/registry.js';
import type { ToolDefinition } from '../generated/types.js';
import { CONTENT_KIND_ORDER } from '../governance/content-operations.js';

/** The generated tools in the order src/tools/index.ts builds them: v2, then the v1 names that do not collide. */
function combinedRegistry(): Map<string, ToolDefinition> {
  const combined = new Map<string, ToolDefinition>();
  for (const [name, def] of toolRegistry) combined.set(name, def);
  for (const [name, def] of v1ToolRegistry) if (!combined.has(name)) combined.set(name, def);
  return combined;
}

/** Runs a function with the environment set as given, then restores it. An undefined value unsets the variable. */
async function withEnv<T>(overrides: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const FULL_MODE = { MCP_TOOL_MODE: 'full', MCP_DISABLED_TOOLS: undefined, MCP_DISABLED_ACTIONS: undefined, MCP_DISABLE_DESTRUCTIVE: undefined, MCP_READ_ONLY: undefined, MCP_DISABLE_ROLE_FILTER: undefined } as const;
const CURATED_MODE = { MCP_TOOL_MODE: undefined } as const;

/** The generated tools a full-mode server lists: the parity reference for exposed names. */
function fullModeTools() {
  return withEnv(FULL_MODE, () => getAllToolDefinitions(undefined, undefined, undefined));
}

describe('tool catalog view: names', () => {
  it('resolves a curated name to itself, in @curated', async () => {
    const entry = await withEnv(CURATED_MODE, async () => getToolCatalogView().lookupTool('recent_calls'));
    expect(entry).toEqual({
      canonical: 'recent_calls',
      exposed: 'recent_calls',
      groups: expect.arrayContaining(['@curated', '@read']),
    });
    expect(entry?.groups).not.toContain('@generated');
  });

  it('resolves the meta tools in @meta', async () => {
    const view = getToolCatalogView();
    expect(view.lookupTool('search_api')?.groups).toEqual(expect.arrayContaining(['@meta', '@read']));
    expect(view.lookupTool('call_api')?.groups).toEqual(expect.arrayContaining(['@meta', '@read']));
  });

  it('resolves a generated tool by its exposed name and by its registry key to the same tool', async () => {
    const tools = await fullModeTools();
    await withEnv(FULL_MODE, async () => {
      const view = getToolCatalogView();
      for (const tool of tools) {
        const entry = view.lookupTool(tool.name);
        expect(entry?.exposed, tool.name).toBe(tool.name);
        expect(view.lookupTool(entry?.canonical ?? '')?.canonical, tool.name).toBe(entry?.canonical);
      }
    });
  });

  it('returns undefined for a name no tool has', () => {
    expect(getToolCatalogView().lookupTool('no_such_tool')).toBeUndefined();
    expect(getToolCatalogView().lookupTool('recent_calls ')).toBeUndefined();
  });

  it('resolves a name that a curated and a generated tool both hold by the mode, as dispatch does', async () => {
    const exposed = new Set((await fullModeTools()).map((tool) => tool.name));
    const shared = CURATED_CATALOG.map((tool) => tool.schema.name).filter((name) => exposed.has(name));
    expect(shared).toContain('read_voicemail');
    const view = getToolCatalogView();
    await withEnv(CURATED_MODE, async () => {
      for (const name of shared) expect(view.lookupTool(name)?.groups, name).toContain('@curated');
    });
    await withEnv(FULL_MODE, async () => {
      for (const name of shared) expect(view.lookupTool(name)?.groups, name).toContain('@generated');
    });
  });

  it('agrees with getAllToolDefinitions on every exposed name, for the same tool', async () => {
    const combined = combinedRegistry();
    const visible = [...combined].filter(([, def]) => def.operation?.multipartOnly !== true);
    const tools = await fullModeTools();
    // Full mode lists every generated tool except the multipart-only ones, which dispatch refuses.
    expect(tools).toHaveLength(visible.length);

    const keyBySchema = new Map<object, string>();
    for (const [key, def] of combined) keyBySchema.set(def.schema.inputSchema, key);
    expect(keyBySchema.size, 'every generated tool has its own input schema object').toBe(combined.size);

    await withEnv(FULL_MODE, async () => {
      const view = getToolCatalogView();
      for (const tool of tools) {
        const key = keyBySchema.get(tool.inputSchema);
        expect(key, tool.name).toBeDefined();
        expect(view.lookupTool(tool.name)?.canonical, tool.name).toBe(key);
      }
    });
  });
});

describe('tool catalog view: groups', () => {
  it('puts a curated tool that sends a message in @write and @content:sms_text', async () => {
    const entry = await withEnv(CURATED_MODE, async () => getToolCatalogView().lookupTool('send_message'));
    expect(entry?.groups).toEqual(expect.arrayContaining(['@curated', '@write', '@content:sms_text']));
    expect(entry?.groups).not.toContain('@read');
  });

  it('puts a curated voicemail tool in the voicemail and transcript content groups', async () => {
    const view = getToolCatalogView();
    await withEnv(CURATED_MODE, async () => {
      expect(view.lookupTool('read_voicemail')?.groups).toEqual(
        expect.arrayContaining(['@content:voicemail', '@content:transcript']),
      );
      expect(view.lookupTool('forward_voicemail')?.groups).toEqual(
        expect.arrayContaining(['@write', '@content:voicemail']),
      );
    });
  });

  it('leaves a call-history tool with classified fields out of every content group', async () => {
    const entry = await withEnv(CURATED_MODE, async () => getToolCatalogView().lookupTool('recent_calls'));
    expect((entry?.groups ?? []).filter((group) => group.startsWith('@content:'))).toEqual([]);
  });

  it('puts a generated voicemail play tool in its content groups, and marks it unclassified', () => {
    const entry = getToolCatalogView().lookupTool('play_voicemail');
    expect(entry?.groups).toEqual(
      expect.arrayContaining(['@generated', '@read', '@content:voicemail', '@content:fax_page', '@unclassified']),
    );
  });

  it('marks a generated v1 operation unclassified, because v1 has no output mapping', () => {
    const entry = getToolCatalogView().lookupTool('v1_audio_play');
    expect(entry?.groups).toEqual(expect.arrayContaining(['@generated', '@content:call_recording', '@unclassified']));
  });

  it('marks a generated fax download unclassified, with its fax_page content group', () => {
    const entry = getToolCatalogView().lookupTool('download_fax');
    expect(entry?.groups).toEqual(expect.arrayContaining(['@generated', '@content:fax_page', '@unclassified']));
  });

  it('marks destructive tools', async () => {
    const view = getToolCatalogView();
    await withEnv(CURATED_MODE, async () => {
      expect(view.lookupTool('end_call')?.groups).toContain('@destructive');
      expect(view.lookupTool('recent_calls')?.groups).not.toContain('@destructive');
    });
  });
});

describe('tool catalog view: operations', () => {
  it('classifies operation keys through the review sets', () => {
    const view = getToolCatalogView();
    expect(view.lookupOperation('v1:audio:play')).toEqual(['call_recording']);
    expect(view.lookupOperation('GET /insight/{}')).toBe('unreviewed');
    expect(view.lookupOperation('GET /fax/vendors')).toBeUndefined();
  });
});

describe('tool catalog view: @content group snapshot', () => {
  it('matches the reviewed snapshot of every @content group', async () => {
    const view = getToolCatalogView();
    const rows: Array<{ group: string; origin: string; canonical: string; exposed: string }> = [];
    const addRows = (entry: ToolCatalogEntry | undefined, origin: string) => {
      if (entry === undefined) throw new Error(`no catalog entry for ${origin} tool`);
      for (const group of entry.groups) {
        if (group.startsWith('@content:')) rows.push({ group, origin, canonical: entry.canonical, exposed: entry.exposed });
      }
    };

    for (const name of [...CURATED_CATALOG.map((tool) => tool.schema.name), 'search_api', 'call_api']) {
      const origin = name === 'search_api' || name === 'call_api' ? 'meta' : 'curated';
      await withEnv(CURATED_MODE, async () => addRows(view.lookupTool(name), origin));
    }
    // Every generated tool, multipart-only ones included: the snapshot is the review record, not the listing.
    await withEnv(FULL_MODE, async () => {
      for (const registryKey of combinedRegistry().keys()) {
        const entry = view.lookupTool(registryKey);
        expect(entry?.canonical, registryKey).toBe(registryKey);
        addRows(entry, 'generated');
      }
    });

    rows.sort((a, b) => compare(a.group, b.group) || compare(a.origin, b.origin) || compare(a.canonical, b.canonical));
    const header = CONTENT_KIND_ORDER.map((kind) => {
      const group = `@content:${kind}`;
      const members = rows.filter((row) => row.group === group);
      const curated = members.filter((row) => row.origin !== 'generated').length;
      return `# ${group} curated=${curated} generated=${members.length - curated}`;
    });
    const lines = [...header, ...rows.map((row) => `${row.group}\t${row.origin}\t${row.canonical}\t${row.exposed}`)];
    await expect(`${lines.join('\n')}\n`).toMatchFileSnapshot('./fixtures/content-groups.snapshot.txt');
  });
});

function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
