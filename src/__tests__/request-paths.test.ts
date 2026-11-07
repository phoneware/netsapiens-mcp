import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CURATED_CATALOG, nsDateWindow, parseNsBound, toNsDateTime } from '../tools/curated/catalog.js';
import { WORKFLOW_TOOLS } from '../tools/curated/workflows.js';
import type { GenericApiClient } from '../generated/types.js';
import { recordCuratedHandlers } from './curated-operation-recorder.js';

recordCuratedHandlers(CURATED_CATALOG);

interface Spec {
 paths: Record<string, Record<string, unknown>>;
}

const spec = JSON.parse(readFileSync('spec/v2/45.0.json', 'utf8')) as Spec;

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
 const want = pathTemplate.replace(/#\d+$/, '').split('/').filter(Boolean);
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

  it('call_trace calls GET /sipflow with callids, servers, and type=call_trace', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'call_trace');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const client = recordingClient(recorded);

   await tool!.handler({ call_id: 'c-100', servers: 'core1.netsapiens.com' }, client, 'domain_admin');

   expect(recorded.length).toBeGreaterThan(0);
   const traceCall = recorded.find((r) => r.pathTemplate === '/sipflow');
   expect(traceCall).toBeDefined();
   expect(traceCall?.method.toUpperCase()).toBe('GET');
   expect(traceCall?.queryParams?.type).toBe('call_trace');
   expect(traceCall?.queryParams?.servers).toBe('core1.netsapiens.com');
  });

  it('completed call as domain_admin falls from active 404 to /domains/{domain}/cdrs and calls /sipflow with servers from CDR', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'call_trace');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const mockClient = {
    request: async (o: Recorded) => {
     recorded.push(o);
     if (o.pathTemplate.includes('/calls/')) {
      // Active call 404 for completed call
      return { success: false, error: 'Resource not found' };
     }
     if (o.pathTemplate === '/domains/{domain}/cdrs') {
      return {
       success: true,
       data: [
        {
         id: 'c-100',
         'core-server': 'core.example.net',
         'call-start-datetime': '2026-09-23T22:50:00Z',
         'call-disconnect-datetime': '2026-09-23T22:55:00Z',
         'is-trace-expected': 'yes',
        },
       ],
      };
     }
     if (o.pathTemplate === '/sipflow') {
      return { success: true, data: { trace: 'ladder' } };
     }
     return { success: true, data: [] };
    },
   } as unknown as GenericApiClient;

   const result = await tool!.handler({ call_id: 'c-100', domain: 'example.test' }, mockClient, 'domain_admin');
   const paths = recorded.map((r) => r.pathTemplate);
   expect(paths).toContain('/domains/{domain}/users/{user}/calls/{callid}');
   expect(paths).toContain('/domains/{domain}/cdrs');
   expect(paths).toContain('/sipflow');

   const sipflowCall = recorded.find((r) => r.pathTemplate === '/sipflow');
   expect(sipflowCall?.queryParams?.servers).toBe('core.example.net');
   expect(sipflowCall?.queryParams?.callids).toBe('c-100');
   expect(result.content[0].text).toBeDefined();
  });

  it('completed call as reseller falls to /cdrs with orig_callid and calls /sipflow with servers from CDR', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'call_trace');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const mockClient = {
    request: async (o: Recorded) => {
     recorded.push(o);
     if (o.pathTemplate.includes('/calls/')) {
      return { success: false, error: 'Resource not found' };
     }
     if (o.pathTemplate === '/cdrs') {
      expect(o.queryParams?.orig_callid).toBe('c-200');
      return {
       success: true,
       data: [
        {
         orig_callid: 'c-200',
         hostname: 'core-las.netsapiens.com',
         time_start: '2026-09-23T18:30:00Z',
         time_release: '2026-09-23T18:37:00Z',
         expected_trace: 'yes',
        },
       ],
      };
     }
     if (o.pathTemplate === '/sipflow') {
      return { success: true, data: { trace: 'ladder' } };
     }
     return { success: true, data: [] };
    },
   } as unknown as GenericApiClient;

   const result = await tool!.handler({ call_id: 'c-200' }, mockClient, 'reseller');
   const paths = recorded.map((r) => r.pathTemplate);
   expect(paths).toContain('/cdrs');
   expect(paths).toContain('/sipflow');

   const sipflowCall = recorded.find((r) => r.pathTemplate === '/sipflow');
   expect(sipflowCall?.queryParams?.servers).toBe('core-las.netsapiens.com');
   expect(sipflowCall?.queryParams?.callids).toBe('c-200');
  });

  it('completed call with no active call or CDR match returns clear error without calling /sipflow', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'call_trace');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const mockClient = {
    request: async (o: Recorded) => {
     recorded.push(o);
     if (o.pathTemplate.includes('/calls/')) {
      return { success: false, error: 'Resource not found' };
     }
     if (o.pathTemplate === '/domains/{domain}/cdrs') {
      return { success: true, data: [] }; // no matches
     }
     return { success: true, data: [] };
    },
   } as unknown as GenericApiClient;

   const result = await tool!.handler({ call_id: 'c-missing', domain: 'example.test' }, mockClient, 'domain_admin');
   const paths = recorded.map((r) => r.pathTemplate);
   expect(paths).not.toContain('/sipflow');

   const parsed = JSON.parse(result.content[0].text);
   expect(parsed.error).toBeDefined();
   expect(parsed.searched_window).toBeDefined();
   expect(parsed.searched_window.start).toBeDefined();
   expect(parsed.searched_window.end).toBeDefined();
  });

  it('completed call where is-trace-expected is not yes returns plain error without calling /sipflow', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'call_trace');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const mockClient = {
    request: async (o: Recorded) => {
     recorded.push(o);
     if (o.pathTemplate.includes('/calls/')) {
      return { success: false, error: 'Resource not found' };
     }
     if (o.pathTemplate === '/domains/{domain}/cdrs') {
      return {
       success: true,
       data: [
        {
         id: 'c-old',
         'core-server': 'core-phx.netsapiens.com',
         'is-trace-expected': 'no',
        },
       ],
      };
     }
     return { success: true, data: [] };
    },
   } as unknown as GenericApiClient;

   const result = await tool!.handler({ call_id: 'c-old', domain: 'ACMELAW' }, mockClient, 'domain_admin');
   const paths = recorded.map((r) => r.pathTemplate);
   expect(paths).not.toContain('/sipflow');

   const parsed = JSON.parse(result.content[0].text);
   expect(parsed.error).toContain('trace');
  });

  it('completed call where is-trace-expected is boolean true calls /sipflow with servers from CDR', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'call_trace');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const mockClient = {
    request: async (o: Recorded) => {
     recorded.push(o);
     if (o.pathTemplate.includes('/calls/')) {
      return { success: false, error: 'Resource not found' };
     }
     if (o.pathTemplate === '/domains/{domain}/cdrs') {
      return {
       success: true,
       data: [
        {
         id: 'c-bool-true',
         'core-server': 'core.example.net',
         'is-trace-expected': true,
        },
       ],
      };
     }
     if (o.pathTemplate === '/sipflow') {
      return { success: true, data: { trace: 'ladder' } };
     }
     return { success: true, data: [] };
    },
   } as unknown as GenericApiClient;

   const result = await tool!.handler({ call_id: 'c-bool-true', domain: 'example.test' }, mockClient, 'domain_admin');
   const paths = recorded.map((r) => r.pathTemplate);
   expect(paths).toContain('/sipflow');

   const parsed = JSON.parse(result.content[0].text);
   expect(parsed.data).toEqual({ trace: 'ladder' });
  });

  it('completed call where /sipflow returns 401 explains portal role cannot read traces instead of retention elapsed', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'call_trace');
   expect(tool).toBeTruthy();

   const mockClient = {
    request: async (o: Recorded) => {
     if (o.pathTemplate.includes('/calls/')) {
      return { success: false, error: 'Resource not found' };
     }
     if (o.pathTemplate === '/domains/{domain}/cdrs') {
      return {
       success: true,
       data: [
        {
         id: 'c-bool-true',
         'core-server': 'core.example.net',
         'is-trace-expected': true,
        },
       ],
      };
     }
     if (o.pathTemplate === '/sipflow') {
      return { success: false, error: '401 Invalid Scope [APP001]' };
     }
     return { success: true, data: [] };
    },
   } as unknown as GenericApiClient;

   const result = await tool!.handler({ call_id: 'c-bool-true', domain: 'example.test' }, mockClient, 'domain_admin');
   const parsed = JSON.parse(result.content[0].text);
   expect(parsed.success).toBe(false);
   expect(parsed.error).toContain('401');
   expect(parsed.detail).toContain('portal role cannot read SIP traces');
   expect(parsed.detail).not.toContain('retention has elapsed');
  });

  it('call_trace preserves an invalid-token authentication failure', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'call_trace');
   expect(tool).toBeTruthy();

   const mockClient = {
    request: async (o: Recorded) => {
     if (o.pathTemplate.includes('/calls/')) return { success: false, error: 'Resource not found' };
     if (o.pathTemplate === '/domains/{domain}/cdrs') {
      return { success: true, data: [{ id: 'c-auth-failure', 'core-server': 'core.example.net', 'is-trace-expected': true }] };
     }
     if (o.pathTemplate === '/sipflow') return { success: false, error: '401 Invalid Token' };
     return { success: true, data: [] };
    },
   } as unknown as GenericApiClient;

   const result = await tool!.handler({ call_id: 'c-auth-failure', domain: 'example.test' }, mockClient, 'domain_admin');
   const parsed = JSON.parse(result.content[0].text);
   expect(parsed.error).toBe('401 Invalid Token');
   expect(parsed.detail).toBeUndefined();
  });

  it('diagnose_call preserves an invalid-token authentication failure', async () => {
   const tool = WORKFLOW_TOOLS.find((t) => t.schema.name === 'diagnose_call');
   expect(tool).toBeTruthy();

   const mockClient = {
    request: async (o: Recorded) => {
     if (o.pathTemplate.includes('/calls/')) return { success: false, error: 'Resource not found' };
     if (o.pathTemplate === '/domains/{domain}/cdrs') {
      return { success: true, data: [{ id: 'c-auth-failure', 'core-server': 'core.example.net', 'is-trace-expected': true }] };
     }
     if (o.pathTemplate === '/sipflow') return { success: false, error: '401 Invalid Token' };
     return { success: true, data: [] };
    },
   } as unknown as GenericApiClient;

   const result = await tool!.handler({ call_id: 'c-auth-failure', domain: 'example.test' }, mockClient, 'domain_admin');
   const parsed = JSON.parse(result.content[0].text);
   expect(parsed.cdr).toBeDefined();
   expect(parsed.detail).toBeUndefined();
   expect(parsed.sip_trace.error).toBe('401 Invalid Token');
   expect(parsed.sip_trace.detail).toBeUndefined();
  });

  it('diagnose_call on completed call where is-trace-expected is boolean true and /sipflow returns 401 returns cdr and explains role restriction', async () => {
   const tool = WORKFLOW_TOOLS.find((t) => t.schema.name === 'diagnose_call');
   expect(tool).toBeTruthy();

   const mockClient = {
    request: async (o: Recorded) => {
     if (o.pathTemplate.includes('/calls/')) {
      return { success: false, error: 'Resource not found' };
     }
     if (o.pathTemplate === '/domains/{domain}/cdrs') {
      return {
       success: true,
       data: [
        {
         id: 'c-bool-true',
         'core-server': 'core.example.net',
         'is-trace-expected': true,
         'call-start-datetime': '2026-10-15T12:00:00Z',
         'call-disconnect-datetime': '2026-10-15T12:05:00Z',
        },
       ],
      };
     }
     if (o.pathTemplate === '/sipflow') {
      return { success: false, error: '401 Invalid Scope [APP001]' };
     }
     return { success: true, data: [] };
    },
   } as unknown as GenericApiClient;

   const result = await tool!.handler({ call_id: 'c-bool-true', domain: 'example.test' }, mockClient, 'domain_admin');
   const parsed = JSON.parse(result.content[0].text);
   expect(parsed.call_id).toBe('c-bool-true');
   expect(parsed.cdr).toBeDefined();
   expect(parsed.cdr['core-server']).toBe('core.example.net');
   expect(parsed.server_used).toBe('core.example.net');
   expect(parsed.detail).toContain('portal role cannot read SIP traces');
   expect(parsed.sip_trace.ok).toBe(false);
   expect(parsed.sip_trace.detail).toContain('portal role cannot read SIP traces');
  });
 });

 describe('device tool paths', () => {
  it('find_device calls /domains/{domain}/phones and not /domains/{domain}/devices', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'find_device');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const client = recordingClient(recorded);

   await tool!.handler({ query: '1001' }, client, 'domain_admin');

   expect(recorded.length).toBeGreaterThan(0);
   for (const r of recorded) {
    expect(r.pathTemplate).not.toBe('/domains/{domain}/devices');
    const matches = findSpecPath(r.pathTemplate);
    expect(matches.length, `no spec path matches ${r.pathTemplate}`).toBeGreaterThan(0);
   }
   const pathTemplates = recorded.map((r) => r.pathTemplate);
   expect(pathTemplates).toContain('/domains/{domain}/phones');
  });

  it('find_device with a MAC address calls /domains/{domain}/phones and not /domains/{domain}/devices', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'find_device');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const client = recordingClient(recorded);

   await tool!.handler({ query: '0004f2112233' }, client, 'domain_admin');

   expect(recorded.length).toBeGreaterThan(0);
   for (const r of recorded) {
    expect(r.pathTemplate).not.toBe('/domains/{domain}/devices');
    const matches = findSpecPath(r.pathTemplate);
    expect(matches.length, `no spec path matches ${r.pathTemplate}`).toBeGreaterThan(0);
   }
   const pathTemplates = recorded.map((r) => r.pathTemplate);
   expect(pathTemplates).toContain('/domains/{domain}/phones');
  });
 });

 describe('defect fixes: request paths and scoping', () => {
  it('call_details searches user CDRs for basic user when active call 404s', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'call_details');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const mockClient = {
    request: async (o: Recorded) => {
     recorded.push(o);
     if (o.pathTemplate.includes('/calls/')) {
      return { success: false, error: '404 Resource not found' };
     }
     if (o.pathTemplate === '/domains/{domain}/users/{user}/cdrs') {
      return { success: true, data: [{ id: 'cdr-123', domain: 'test' }] };
     }
     return { success: true, data: [] };
    },
   } as unknown as GenericApiClient;

   const result = await tool!.handler({ call_id: 'cdr-123' }, mockClient, 'user');
   const templates = recorded.map((r) => r.pathTemplate);
   expect(templates).toContain('/domains/{domain}/users/{user}/calls/{callid}');
   expect(templates).toContain('/domains/{domain}/users/{user}/cdrs');
   const parsed = JSON.parse(result.content[0].text);
   expect(parsed.success).toBe(true);
   expect(parsed.data.id).toBe('cdr-123');
  });

  it('call_details searches domain CDRs for domain_admin when active call 404s', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'call_details');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const mockClient = {
    request: async (o: Recorded) => {
     recorded.push(o);
     if (o.pathTemplate.includes('/calls/')) {
      return { success: false, error: '404 Resource not found' };
     }
     if (o.pathTemplate === '/domains/{domain}/cdrs') {
      return { success: true, data: [{ id: 'cdr-456', domain: 'test' }] };
     }
     return { success: true, data: [] };
    },
   } as unknown as GenericApiClient;

   const result = await tool!.handler({ call_id: 'cdr-456' }, mockClient, 'domain_admin');
   const templates = recorded.map((r) => r.pathTemplate);
   expect(templates).toContain('/domains/{domain}/users/{user}/calls/{callid}');
   expect(templates).toContain('/domains/{domain}/cdrs');
   const parsed = JSON.parse(result.content[0].text);
   expect(parsed.success).toBe(true);
   expect(parsed.data.id).toBe('cdr-456');
  });

  it('find_user falls back to /domains/{domain}/users/~ when /domains/{domain}/users 401s for basic user', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'find_user');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const mockClient = {
    request: async (o: Recorded) => {
     recorded.push(o);
     if (o.pathTemplate === '/domains/{domain}/users') {
      return { success: false, error: '401 Invalid Scope [APP001]' };
     }
     if (o.pathTemplate === '/domains/{domain}/users/~') {
      return { success: true, data: { user: '1011', 'name-first-name': 'Alice' } };
     }
     return { success: true, data: [] };
    },
   } as unknown as GenericApiClient;

   const result = await tool!.handler({ query: '1011' }, mockClient, 'user');
   const templates = recorded.map((r) => r.pathTemplate);
   expect(templates).toContain('/domains/{domain}/users');
   expect(templates).toContain('/domains/{domain}/users/~');
   const parsed = JSON.parse(result.content[0].text);
   expect(parsed.success).toBe(true);
   expect(parsed.data.length).toBe(1);
  });

  it('my_devices returns not available note when NS answers 401 for basic user', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'my_devices');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const mockClient = {
    request: async (o: Recorded) => {
     recorded.push(o);
     return { success: false, error: '401 Invalid Scope [APP001]' };
    },
   } as unknown as GenericApiClient;

   const result = await tool!.handler({}, mockClient, 'user');
   const parsed = JSON.parse(result.content[0].text);
   expect(parsed.success).toBe(true);
   expect(parsed.note).toContain('not available');
  });

  it('agent_status calls /domains/{domain}/agents for domain_admin', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'agent_status');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const mockClient = {
    request: async (o: Recorded) => {
     recorded.push(o);
     if (o.pathTemplate === '/domains/{domain}/users/{user}') return { success: true, data: { user: '1011' } };
     return { success: true, data: [{ 'callqueue-agent-id': '1011@dom' }, { 'callqueue-agent-id': '1015@dom' }] };
    },
   } as unknown as GenericApiClient;

   const result = await tool!.handler({}, mockClient, 'domain_admin');
   const templates = recorded.map((r) => r.pathTemplate);
   expect(templates).toContain('/domains/{domain}/agents');
   const parsed = JSON.parse(result.content[0].text);
   expect(parsed.success).toBe(true);
   expect(parsed.data['callqueue-agent-id']).toBe('1011@dom');
  });

  it('call_volume defaults to sensible window in Y-m-d H:i:s format when since is omitted', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'call_volume');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const mockClient = {
    request: async (o: Recorded) => {
     recorded.push(o);
     return { success: true, data: { total: 5, minutes: 2, seconds: 120 } };
    },
   } as unknown as GenericApiClient;

   await tool!.handler({}, mockClient, 'domain_admin');
   const countCall = recorded.find((r) => r.pathTemplate.includes('/count'));
   expect(countCall).toBeDefined();
   const qp = countCall?.queryParams as Record<string, string>;
   expect(qp['datetime-start']).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
   expect(qp['datetime-end']).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('queue_status defaults start_date and end_date when omitted', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'queue_status');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const mockClient = {
    request: async (o: Recorded) => {
     recorded.push(o);
     return { success: true, data: [] };
    },
   } as unknown as GenericApiClient;

   await tool!.handler({ queue: '1099' }, mockClient, 'domain_admin');
   const statusCall = recorded.find((r) => r.pathTemplate.includes('/statistics/callqueues/'));
   expect(statusCall).toBeDefined();
   const qp = statusCall?.queryParams as Record<string, string>;
   expect(qp.start_date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
   expect(qp.end_date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('call_statistics defaults start_date and end_date when omitted', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'call_statistics');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const mockClient = {
    request: async (o: Recorded) => {
     recorded.push(o);
     return { success: true, data: [] };
    },
   } as unknown as GenericApiClient;

   await tool!.handler({}, mockClient, 'domain_admin');
   const statsCall = recorded.find((r) => r.pathTemplate.includes('/statistics/callqueues/'));
   expect(statsCall).toBeDefined();
   const qp = statsCall?.queryParams as Record<string, string>;
   expect(qp.start_date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
   expect(qp.end_date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
   expect(qp).not.toHaveProperty('datetime-start');
  });

  it('agent_statistics defaults start_date and end_date when omitted', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'agent_statistics');
   expect(tool).toBeTruthy();

   const recorded: Recorded[] = [];
   const mockClient = {
    request: async (o: Recorded) => {
     recorded.push(o);
     return { success: true, data: {} };
    },
   } as unknown as GenericApiClient;

   await tool!.handler({}, mockClient, 'domain_admin');
   const statsCall = recorded.find((r) => r.pathTemplate.includes('/statistics/agent'));
   expect(statsCall).toBeDefined();
   const qp = statsCall?.queryParams as Record<string, string>;
   expect(qp.start_date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
   expect(qp.end_date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
   expect(statsCall?.pathTemplate).toBe('/domains/{domain}/statistics/agent');
  });

  it('agent_statistics preserves flat stats for a single agent and normalizes multi-agent dictionaries', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'agent_statistics');
   expect(tool).toBeTruthy();

   // 1. Single agent: returns flat object
   const singleClient = {
    request: async (o: Recorded) => {
     if (o.pathTemplate.includes('/statistics/agent/{agent}')) {
      return {
       success: true,
       data: {
        'queue-calls-answered-count': 5,
        'queue-calls-talking-avg-duration-minutes': 2,
       },
      };
     }
     return { success: true, data: {} };
    },
   } as unknown as GenericApiClient;

   const singleRes = await tool!.handler({ agent: '1011' }, singleClient, 'domain_admin');
   const singleParsed = JSON.parse(singleRes.content[0].text);
   expect(singleParsed.success).toBe(true);
   expect(singleParsed.data['queue-calls-answered-count']).toBe(5);
   expect(singleParsed.data['queue-calls-talking-avg-duration-minutes']).toBe(2);

   // 2. Multi-agent dictionary: normalizes to array with agent key
   const multiClient = {
    request: async (o: Recorded) => {
     if (o.pathTemplate === '/domains/{domain}/statistics/agent') {
      return {
       success: true,
       data: {
        '1001': { 'queue-calls-answered-count': 3 },
        '1002': { 'queue-calls-answered-count': 7 },
       },
      };
     }
     return { success: true, data: {} };
    },
   } as unknown as GenericApiClient;

   const multiRes = await tool!.handler({}, multiClient, 'domain_admin');
   const multiParsed = JSON.parse(multiRes.content[0].text);
   expect(multiParsed.success).toBe(true);
   expect(Array.isArray(multiParsed.data)).toBe(true);
   expect(multiParsed.data).toHaveLength(2);
   expect(multiParsed.data[0].agent).toBe('1001');
   expect(multiParsed.data[0]['queue-calls-answered-count']).toBe(3);
   expect(multiParsed.data[1].agent).toBe('1002');
   expect(multiParsed.data[1]['queue-calls-answered-count']).toBe(7);
  });

  it('call_details rejects unrelated first CDR row and returns call not found', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'call_details');
   expect(tool).toBeTruthy();

   const mockClient = {
    request: async (o: Recorded) => {
     if (o.pathTemplate.includes('/calls/')) {
      return { success: false, error: '404 Resource not found' };
     }
     if (o.pathTemplate.includes('/cdrs')) {
      // Returns an unrelated CDR that does not match callid "target-123"
      return {
       success: true,
       data: [
        { id: 'unrelated-456', 'call-orig-call-id': 'unrelated-orig', domain: 'test' },
       ],
      };
     }
     return { success: true, data: [] };
    },
   } as unknown as GenericApiClient;

   const result = await tool!.handler({ call_id: 'target-123' }, mockClient, 'domain_admin');
   const parsed = JSON.parse(result.content[0].text);
   expect(parsed.success).toBe(false);
   expect(parsed.error).toContain('Call not found');
  });

  it('call_details keeps an upstream refusal instead of searching CDRs or reporting not found', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'call_details');
   const recorded: Recorded[] = [];
   const mockClient = {
    request: async (o: Recorded) => {
     recorded.push(o);
     return { success: false, error: '503 Service Unavailable' };
    },
   } as unknown as GenericApiClient;
   const parsed = JSON.parse((await tool!.handler({ call_id: 'c1' }, mockClient, 'domain_admin')).content[0].text);
   expect(parsed.error).toBe('503 Service Unavailable');
   expect(recorded).toHaveLength(1);
  });

  it('date windows: offsets become the UTC instant NetSapiens reads, bare dates cover the day, the 24-hour default', () => {
   // NS ignores offsets and reads every bound as UTC wall time (measured 2026-10-15).
   expect(toNsDateTime(parseNsBound('2026-10-14T16:00:00-07:00', 'start'))).toBe('2026-10-14 23:00:00');
   expect(toNsDateTime(parseNsBound('2026-10-15T08:30:00.000Z', 'start'))).toBe('2026-10-15 08:30:00');
   expect(toNsDateTime(parseNsBound('2026-10-15 08:30', 'start'))).toBe('2026-10-15 08:30:00');
   expect(toNsDateTime(parseNsBound('2026-10-14', 'start'))).toBe('2026-10-14 00:00:00');
   expect(toNsDateTime(parseNsBound('2026-10-14', 'end'))).toBe('2026-10-14 23:59:59');
   expect(() => parseNsBound('next tuesday-ish', 'start')).toThrow(/Could not read the date/);

   const now = new Date('2026-10-15T12:00:00Z');
   expect(nsDateWindow(undefined, undefined, now)).toEqual({ start: '2026-10-14 12:00:00', end: '2026-10-15 12:00:00' });
   // An end-only question about the past asks about the 24 hours before that end, not before now.
   expect(nsDateWindow(undefined, '2026-10-01', now)).toEqual({ start: '2026-09-30 23:59:59', end: '2026-10-01 23:59:59' });
   expect(nsDateWindow('2026-10-10', undefined, now)).toEqual({ start: '2026-10-10 00:00:00', end: '2026-10-15 12:00:00' });
  });

  it('explicit end bounds survive and the start is anchored to them on every date-bounded tool', async () => {
   const recorded: Recorded[] = [];
   const mockClient = {
    request: async (o: Recorded) => {
     recorded.push(o);
     return { success: true, data: [] };
    },
   } as unknown as GenericApiClient;
   const run = async (name: string, args: Record<string, unknown>) => {
    recorded.length = 0;
    await CURATED_CATALOG.find((t) => t.schema.name === name)!.handler(args, mockClient, 'domain_admin');
    return recorded[recorded.length - 1].queryParams as Record<string, string>;
   };

   expect(await run('call_volume', { until: '2026-10-01 18:00:00' })).toMatchObject({ 'datetime-start': '2026-09-30 18:00:00', 'datetime-end': '2026-10-01 18:00:00' });
   expect(await run('queue_status', { queue: '1099', until: '2026-10-01' })).toMatchObject({ start_date: '2026-09-30 23:59:59', end_date: '2026-10-01 23:59:59' });
   expect(await run('call_statistics', { end_date: '2026-10-01' })).toMatchObject({ start_date: '2026-09-30 23:59:59', end_date: '2026-10-01 23:59:59' });
   expect(await run('agent_statistics', { end_date: '2026-10-01' })).toMatchObject({ start_date: '2026-09-30 23:59:59', end_date: '2026-10-01 23:59:59' });
   expect(await run('queue_status', { queue: '1099', since: '2026-10-14T16:00:00-07:00', until: '2026-10-14T17:00:00-07:00' })).toMatchObject({ start_date: '2026-10-14 23:00:00', end_date: '2026-10-15 00:00:00' });
  });

  it('"~" is the signed-in agent on every agent tool, and a failed self lookup never widens to the roster', async () => {
   const statusTool = CURATED_CATALOG.find((t) => t.schema.name === 'agent_status');
   const statsTool = CURATED_CATALOG.find((t) => t.schema.name === 'agent_statistics');
   const dashTool = WORKFLOW_TOOLS.find((t) => t.schema.name === 'agent_dashboard');
   const roster = [
    { 'callqueue-agent-id': '1013@dom', 'login-username': '1013@dom' },
    { 'callqueue-agent-id': '1015@dom', 'login-username': '1015@dom' },
   ];
   const recorded: Recorded[] = [];
   const client = (selfOk: boolean) =>
    ({
    request: async (o: Recorded) => {
     recorded.push(o);
      if (o.pathTemplate === '/domains/{domain}/users/{user}' && o.pathParams?.user === '~') {
       return selfOk ? { success: true, data: { user: '1013' } } : { success: false, error: '401 Invalid Scope' };
      }
      if (o.pathTemplate === '/domains/{domain}/agents') return { success: true, data: roster };
     return { success: true, data: [] };
    },
    }) as unknown as GenericApiClient;

   const selfStatus = JSON.parse((await statusTool!.handler({ agent: '~' }, client(true), 'domain_admin')).content[0].text);
   expect(selfStatus.data['callqueue-agent-id']).toBe('1013@dom');

   await expect(statusTool!.handler({ agent: '~' }, client(false), 'domain_admin')).rejects.toThrow(/Could not resolve your own extension/);

   const notFound = JSON.parse((await statusTool!.handler({ agent: '9999' }, client(true), 'domain_admin')).content[0].text);
   expect(notFound.error).toContain('Agent not found');

   recorded.length = 0;
   await statsTool!.handler({ agent: '~' }, client(true), 'domain_admin');
   expect(recorded.map((r) => r.pathTemplate)).toContain('/domains/{domain}/statistics/agent/{agent}');
   expect(recorded.map((r) => r.pathTemplate)).not.toContain('/domains/{domain}/statistics/agent');

   recorded.length = 0;
   const dash = JSON.parse((await dashTool!.handler({}, client(true), 'user')).content[0].text);
   expect(dash.agent).toBe('1013');
   expect(recorded.map((r) => r.pathTemplate)).not.toContain('/domains/{domain}/statistics/agent');
   expect(recorded.find((r) => r.pathTemplate === '/domains/{domain}/statistics/agent/{agent}')?.pathParams?.agent).toBe('1013');

   const dashMissing = JSON.parse((await dashTool!.handler({ agent: '9999' }, client(true), 'domain_admin')).content[0].text);
   expect(dashMissing.status.ok).toBe(false);
   expect(dashMissing.status.error).toContain('Agent not found');
  });
 });
});
