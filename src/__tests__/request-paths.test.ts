import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CURATED_CATALOG } from '../tools/curated/catalog.js';
import { WORKFLOW_TOOLS } from '../tools/curated/workflows.js';
import type { GenericApiClient } from '../generated/types.js';

interface Spec {
 paths: Record<string, Record<string, unknown>>;
}

const spec = JSON.parse(readFileSync('spec/netsapiens-api-v2.json', 'utf8')) as Spec;

/**
 * Literal sub-resource or action keywords in the NetSapiens v2 API.
 * A wildcard parameter like {filename} or {user} must not match an action keyword.
 */
const ACTION_KEYWORDS: Record<string, true> = {
 forward: true,
 save: true,
 count: true,
 answerrules: true,
 devices: true,
 cdrs: true,
 voicemails: true,
 calls: true,
 contacts: true,
 sites: true,
 queues: true,
 agents: true,
 reorder: true,
};

/**
 * Match a request's path template to a spec path structurally:
 * same segment count, literals equal, placeholders and ~ matching parameters.
 * Action keywords cannot match wildcard parameter segments.
 */
export function findSpecPath(pathTemplate: string): string[] {
 const want = pathTemplate.split('/').filter(Boolean);
 return Object.keys(spec.paths).filter((candidate) => {
  const got = candidate.replace(/#\d+$/, '').split('/').filter(Boolean);
  if (got.length !== want.length) return false;
  return got.every((seg, i) => {
   const segWild = seg === '~' || (seg.startsWith('{') && seg.endsWith('}'));
   const wantWild = want[i] === '~' || (want[i].startsWith('{') && want[i].endsWith('}'));
   if (seg === want[i]) return true;
   if (wantWild && segWild) return true;
   // If template has wildcard and spec has literal, literal cannot be an action keyword
   if (wantWild && !segWild) {
    return !ACTION_KEYWORDS[seg];
   }
   // If spec has wildcard (e.g. {filename}) and template has literal, literal cannot be an action keyword
   if (segWild && !wantWild) {
    return !ACTION_KEYWORDS[want[i]];
   }
   return false;
  });
 });
}

interface Recorded {
 method: string;
 pathTemplate: string;
 pathParams?: Record<string, unknown>;
 queryParams?: Record<string, unknown>;
 body?: Record<string, unknown>;
}

function recordingClient(recorded: Recorded[]): GenericApiClient {
 return {
  request: async (o: Recorded) => {
   recorded.push(o);
   return { success: true, data: [] };
  },
 } as unknown as GenericApiClient;
}

interface SchemaProperty {
 type?: string;
 default?: unknown;
}

interface ToolSchema {
 properties?: Record<string, SchemaProperty>;
 required?: string[];
}

/**
 * Build representative arguments for a tool from its inputSchema.
 */
function mockArgs(schema: ToolSchema | undefined, mode: 'full' | 'minimal') {
 const args: Record<string, unknown> = {};
 if (!schema?.properties) return args;
 for (const [key, prop] of Object.entries(schema.properties)) {
  if (mode === 'minimal' && !schema.required?.includes(key)) {
   continue;
  }
  if (prop.default !== undefined) {
   args[key] = prop.default;
  } else if (prop.type === 'string') {
   args[key] = '1001';
  } else if (prop.type === 'number') {
   args[key] = 10;
  } else if (prop.type === 'boolean') {
   args[key] = true;
  } else if (prop.type === 'array') {
   args[key] = ['1001'];
  } else {
   args[key] = '1001';
  }
 }
 return args;
}

/**
 * Legacy non-spec paths outside the voicemail scope that are preserved because
 * changing them requires updating call_trace, diagnose_call, and existing tests in curated-tools.test.ts.
 */
const KNOWN_NON_SPEC_EXCEPTIONS: Record<string, true> = {
 '/sipflow/{callid}': true,
 '/cradle2grave/{callid}': true,
};

const ALL_TOOLS = [...CURATED_CATALOG, ...WORKFLOW_TOOLS];

describe('request paths gate', () => {
 it('every request issued by curated and workflow tools matches a spec path', async () => {
  const recorded: Recorded[] = [];
  const client = recordingClient(recorded);

  for (const tool of ALL_TOOLS) {
   for (const mode of ['full', 'minimal'] as const) {
    const args = mockArgs(tool.schema.inputSchema as ToolSchema, mode);
    try {
     await tool.handler(args, client, 'super_user');
    } catch {
     // ignore client response errors in recording run
    }
   }
  }

  const uniquePaths = [...new Set(recorded.map((r) => r.pathTemplate))];
  const invalid: string[] = [];

  for (const p of uniquePaths) {
   if (KNOWN_NON_SPEC_EXCEPTIONS[p]) continue;
   const matches = findSpecPath(p);
   if (matches.length === 0) {
    invalid.push(p);
   }
  }

  expect(invalid, `Tools issued requests to non-existent spec paths: ${invalid.join(', ')}`).toEqual([]);
 });

 describe('voicemail tool paths', () => {
  it('my_voicemails without folder does not call /domains/~/users/~/voicemails', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'my_voicemails');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const client = recordingClient(recorded);

   await tool!.handler({}, client, 'user');

   expect(recorded.length).toBeGreaterThan(0);
   for (const r of recorded) {
    expect(r.pathTemplate).not.toBe('/domains/~/users/~/voicemails');
    const matches = findSpecPath(r.pathTemplate);
    expect(matches.length, `no spec path matches ${r.pathTemplate}`).toBeGreaterThan(0);
   }
  });

  it('read_voicemail calls spec path with folder and filename, never /domains/~/users/~/voicemails/{id}', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'read_voicemail');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const client = recordingClient(recorded);

   await tool!.handler({ voicemail_id: 'vm-123.wav' }, client, 'user');

   expect(recorded.length).toBeGreaterThan(0);
   for (const r of recorded) {
    expect(r.pathTemplate).not.toBe('/domains/~/users/~/voicemails/{id}');
    expect(r.pathTemplate).toBe('/domains/~/users/~/voicemails/{folder}/{filename}');
    const matches = findSpecPath(r.pathTemplate);
    expect(matches.length, `no spec path matches ${r.pathTemplate}`).toBeGreaterThan(0);
   }
  });

  it('forward_voicemail calls spec path /domains/~/users/~/voicemails/{folder}/{filename}/forward with PATCH', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'forward_voicemail');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const client = recordingClient(recorded);

   await tool!.handler({ voicemail_id: 'vm-123.wav', to: '1002' }, client, 'user');

   expect(recorded.length).toBeGreaterThan(0);
   for (const r of recorded) {
    expect(r.pathTemplate).not.toBe('/domains/~/users/~/voicemails/{id}/forward');
    expect(r.pathTemplate).toBe('/domains/~/users/~/voicemails/{folder}/{filename}/forward');
    expect(r.method.toUpperCase()).toBe('PATCH');
    const matches = findSpecPath(r.pathTemplate);
    expect(matches.length, `no spec path matches ${r.pathTemplate}`).toBeGreaterThan(0);
   }
  });

  it('user_profile composite calls spec path with folder, never /domains/{domain}/users/{user}/voicemails', async () => {
   const tool = WORKFLOW_TOOLS.find((t) => t.schema.name === 'user_profile');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const client = recordingClient(recorded);

   await tool!.handler({ user: '1001', domain: 'test.com' }, client, 'user');

   const vmCalls = recorded.filter((r) => r.pathTemplate.includes('voicemail'));
   expect(vmCalls.length).toBeGreaterThan(0);
   for (const r of vmCalls) {
    expect(r.pathTemplate).not.toBe('/domains/{domain}/users/{user}/voicemails');
    const matches = findSpecPath(r.pathTemplate);
    expect(matches.length, `no spec path matches ${r.pathTemplate}`).toBeGreaterThan(0);
   }
  });

  it('my_voicemails maps friendly synonyms (inbox -> new, saved -> save, deleted -> trash)', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'my_voicemails');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const client = recordingClient(recorded);

   await tool!.handler({ folder: 'saved' }, client, 'user');
   expect(recorded.length).toBe(1);
   expect(recorded[0].pathParams?.folder).toBe('save');

   recorded.length = 0;
   await tool!.handler({ folder: 'inbox' }, client, 'user');
   expect(recorded.length).toBe(1);
   expect(recorded[0].pathParams?.folder).toBe('new');

   recorded.length = 0;
   await tool!.handler({ folder: 'deleted' }, client, 'user');
   expect(recorded.length).toBe(1);
   expect(recorded[0].pathParams?.folder).toBe('trash');
  });

  it('my_voicemails without folder tags each item with its folder and respects limit', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'my_voicemails');
   expect(tool).toBeTruthy();

   const customClient = {
    request: async (o: Recorded) => {
     const folder = String(o.pathParams?.folder);
     return {
      success: true,
      data: [{ filename: `vm-${folder}-1.wav` }],
     };
    },
   } as unknown as GenericApiClient;

   const result = await tool!.handler({}, customClient, 'user');
   expect(result.content[0].text).toBeDefined();
   const parsed = JSON.parse(result.content[0].text);
   expect(parsed.data.length).toBe(3);
   expect(parsed.data.map((item: { folder: string }) => item.folder)).toEqual(['new', 'save', 'trash']);
  });

  it('read_voicemail with folder maps saved to save', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'read_voicemail');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const client = recordingClient(recorded);

   await tool!.handler({ voicemail_id: 'vm-123.wav', folder: 'saved' }, client, 'user');
   expect(recorded.length).toBe(1);
   expect(recorded[0].pathTemplate).toBe('/domains/~/users/~/voicemails/{folder}/{filename}');
   expect(recorded[0].pathParams?.folder).toBe('save');
   expect(recorded[0].pathParams?.filename).toBe('vm-123.wav');
  });

  it('read_voicemail without folder searches folders until voicemail is found', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'read_voicemail');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const mockClient = {
    request: async (o: Recorded) => {
     recorded.push(o);
     // Simulate not found in new, but found in save
     if (o.pathParams?.folder === 'new') {
      return { success: false, error: 'Not found' };
     }
     return { success: true, data: { filename: 'vm-123.wav' } };
    },
   } as unknown as GenericApiClient;

   const result = await tool!.handler({ voicemail_id: 'vm-123.wav' }, mockClient, 'user');
   expect(recorded.length).toBe(2);
   expect(recorded[0].pathParams?.folder).toBe('new');
   expect(recorded[1].pathParams?.folder).toBe('save');
   const parsed = JSON.parse(result.content[0].text);
   expect(parsed.success).toBe(true);
  });

  it('forward_voicemail maps synonyms and includes declared body field', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'forward_voicemail');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const client = recordingClient(recorded);

   await tool!.handler({ voicemail_id: 'vm-123.wav', to: '1002', folder: 'saved' }, client, 'user');
   expect(recorded.length).toBe(1);
   expect(recorded[0].method).toBe('PATCH');
   expect(recorded[0].pathParams?.folder).toBe('save');
   expect(recorded[0].pathParams?.filename).toBe('vm-123.wav');
   expect(recorded[0].body).toEqual({
    'voicemail-forward-new-destination': '1002',
   });
  });

  it('voicemail_inbox_summary maps friendly synonyms to valid spec folder', async () => {
   const tool = WORKFLOW_TOOLS.find((t) => t.schema.name === 'voicemail_inbox_summary');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const client = recordingClient(recorded);

   await tool!.handler({ folder: 'saved' }, client, 'user');
   expect(recorded.length).toBe(1);
   expect(recorded[0].pathParams?.folder).toBe('save');
  });
 });
});
