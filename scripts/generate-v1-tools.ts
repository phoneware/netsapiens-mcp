#!/usr/bin/env tsx

/**
 * NetSapiens v1 (apidoc) → MCP Tool Generator
 *
 * Reads the apidoc-format JSON dump from /ns-api/apidoc/api_data.json
 * and emits one tool per documented endpoint. v1 endpoints are RPC-style
 * `POST /ns-api/?object=X&action=Y` with form-urlencoded body parameters.
 *
 * All generated tool names are prefixed `v1_` so they can be hidden in bulk
 * with `MCP_DISABLED_TOOLS=v1_*` for deployments that only want v2.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

interface V1Endpoint {
  type: string;
  url: string;
  title?: string;
  name?: string;
  group?: string;
  description?: string;
  parameter?: {
    fields?: {
      Parameter?: Array<{
        field: string;
        type?: string;
        optional?: boolean;
        description?: string;
      }>;
    };
  };
  permission?: Array<{ name?: string }>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const SPEC = join(ROOT, 'spec', 'netsapiens-api-v1.json');
const OUT_DIR = join(ROOT, 'src', 'generated', 'v1');

/** v1 objects that are infra/credential endpoints — dropped at generation. */
const EXCLUDED_OBJECTS = new Set(['sfu']);

function stripHtml(s?: string): string {
  if (!s) return '';
  return s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseObjectAction(url: string): { object: string; action: string } | null {
  // url looks like "?object=foo&action=bar" or sometimes with extra params
  const objMatch = url.match(/object=([^&]+)/);
  const actMatch = url.match(/action=([^&]+)/);
  if (!objMatch || !actMatch) return null;
  return { object: objMatch[1], action: actMatch[1] };
}

function safeIdent(name: string): string {
  // produces a JS-safe identifier suffix
  return slug(name).replace(/^[0-9]/, '_$&');
}

function escapeStringLit(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

function main(): void {
  const raw = readFileSync(SPEC, 'utf-8');
  const endpoints: V1Endpoint[] = JSON.parse(raw);

  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(join(OUT_DIR, 'tools'), { recursive: true });

  const byGroup = new Map<string, Array<{ exportName: string; endpoint: V1Endpoint }>>();
  const usedNames = new Set<string>();

  for (const ep of endpoints) {
    const parsed = parseObjectAction(ep.url);
    if (!parsed) continue;

    // Hard exclusions: infra/credential objects that are a security risk if
    // exposed as AI tools. (oauth2/token endpoints already lack object= and
    // are skipped above.) `sfu` mints media-server access tokens.
    if (EXCLUDED_OBJECTS.has(parsed.object.toLowerCase())) continue;

    const group = ep.group ?? parsed.object;
    const action = ep.name ? safeIdent(ep.name) : safeIdent(parsed.action);
    let toolName = `v1_${slug(parsed.object)}_${action}`;
    // Collision handling — keep the first, suffix with a counter on dup
    let suffix = 2;
    while (usedNames.has(toolName)) {
      toolName = `v1_${slug(parsed.object)}_${action}_${suffix++}`;
    }
    usedNames.add(toolName);

    const exportName = toolName;
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group)!.push({ exportName, endpoint: { ...ep, name: exportName } });
  }

  const importsForRegistry: string[] = [];
  const setsForRegistry: string[] = [];

  for (const [group, entries] of byGroup) {
    const file = `${slug(group)}.ts`;
    const filePath = join(OUT_DIR, 'tools', file);

    const exportLines: string[] = [];
    for (const { exportName, endpoint } of entries) {
      const parsed = parseObjectAction(endpoint.url)!;
      const params = endpoint.parameter?.fields?.Parameter ?? [];

      const props: Record<string, { type: string; description: string }> = {};
      const required: string[] = [];
      for (const p of params) {
        // Skip placeholder-only fields with empty names
        if (!p.field) continue;
        const tsType = (p.type || 'string').toLowerCase();
        let jsonType: string = 'string';
        if (tsType.includes('int') || tsType.includes('num')) jsonType = 'number';
        else if (tsType.includes('bool')) jsonType = 'boolean';
        else if (tsType.includes('array')) jsonType = 'array';
        else if (tsType.includes('obj')) jsonType = 'object';
        props[p.field] = { type: jsonType, description: stripHtml(p.description) };
        if (p.optional === false) required.push(p.field);
      }

      const description = stripHtml(endpoint.title || endpoint.description || `${parsed.object}.${parsed.action}`);
      const permission = (endpoint.permission || []).map((p) => p.name).filter(Boolean).join(', ');
      const fullDescription = permission
        ? `[v1] ${description} — required role: ${permission}`
        : `[v1] ${description}`;

      const inputSchema = {
        type: 'object',
        properties: props,
        ...(required.length ? { required: [...new Set(required)] } : {}),
      };

      exportLines.push(
        `export const ${exportName}: ToolDefinition = {
  schema: {
    name: ${JSON.stringify(exportName)},
    description: ${JSON.stringify(fullDescription)},
    inputSchema: ${JSON.stringify(inputSchema, null, 6)},
  },
  handler: async (args, client) => {
    const response = await (client as any).v1Call(${JSON.stringify(parsed.object)}, ${JSON.stringify(parsed.action)}, args);
    return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] };
  },
};
`,
      );
    }

    const fileSrc = `// Auto-generated by scripts/generate-v1-tools.ts — DO NOT EDIT
import type { ToolDefinition } from '../../types.js';

${exportLines.join('\n')}`;
    writeFileSync(filePath, fileSrc);

    const exportNames = entries.map((e) => e.exportName);
    importsForRegistry.push(`import { ${exportNames.join(', ')} } from './tools/${slug(group)}.js';`);
    for (const n of exportNames) {
      setsForRegistry.push(`v1ToolRegistry.set(${JSON.stringify(n)}, ${n});`);
    }
    console.log(`  ${slug(group)}.ts (${entries.length} tools)`);
  }

  const registrySrc = `// Auto-generated by scripts/generate-v1-tools.ts — DO NOT EDIT
import type { ToolDefinition } from '../types.js';

${importsForRegistry.join('\n')}

export const v1ToolRegistry = new Map<string, ToolDefinition>();

${setsForRegistry.join('\n')}
`;
  writeFileSync(join(OUT_DIR, 'registry.ts'), registrySrc);

  console.log(`\nDone! Generated ${usedNames.size} v1 tools across ${byGroup.size} files.`);
}

main();
