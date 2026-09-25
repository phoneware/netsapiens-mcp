/**
 * Role-wall regression tests.
 *
 * Prevents tools visible to lower roles (like domain_admin or user) from
 * calling endpoints restricted to resellers or system administrators.
 */

import { describe, expect, it } from 'vitest';
import { CURATED_CATALOG } from '../tools/curated/catalog.js';
import { WORKFLOW_TOOLS } from '../tools/curated/workflows.js';
import { ROLE_HIERARCHY, type UserRole } from '../auth/roles.js';
import type { GenericApiClient } from '../generated/types.js';

interface RecordedRequest {
 method: string;
 pathTemplate: string;
 pathParams?: Record<string, string>;
 queryParams?: Record<string, unknown>;
 body?: unknown;
}

function recordingClient(
 recorded: RecordedRequest[],
 responseData: unknown = [],
): GenericApiClient {
 return {
  request: async (opts: RecordedRequest) => {
   recorded.push(opts);
   return { success: true, data: responseData };
  },
 } as unknown as GenericApiClient;
}

/**
 * Endpoints that require Reseller or Super User / System Admin scope.
 * Derived from spec/netsapiens-api-v2.json.
 * Any request issued to these paths by a caller with a role below reseller
 * (domain_admin or user) is a role-wall defect.
 */
export const RESELLER_OR_ABOVE_ENDPOINTS: Record<string, true> = {
 // Spec paths["/domains"].get.description:
 // "This API is the same for both Super User and Reseller. If using Reseller scopped access
 // there territory/reseller will be used from the access rights for the filter."
 '/domains': true,
 '/domains/count': true,

 // Spec paths["/phonenumbers"].get.description:
 // "This path will give you all Phonenumbers (DIDs) that are accessable based on the access rights
 // of the Access Token or API Key used to make the requests. Super User or Reseller both supported,
 // but for per domain lookups you should use /domains/{domain}/phonenumbers."
 '/phonenumbers': true,
 '/phonenumbers/count': true,

 // Spec paths under /resellers: Reseller management endpoints.
 '/resellers': true,
 '/resellers/count': true,
 '/resellers/{reseller}': true,
 '/resellers/{reseller}/devices/count': true,
 '/resellers/{reseller}/schedule/count': true,
 '/resellers/{reseller}/quotas': true,
 '/resellers/{reseller}/quotas/count': true,

 // Spec paths /cdrs and /cdrs/count:
 // Cross-domain system and reseller call history (per-domain uses /domains/{domain}/cdrs).
 '/cdrs': true,
 '/cdrs/count': true,

 // Spec paths under /subscriptions: Cross-domain webhook event subscriptions.
 '/subscriptions': true,
 '/subscriptions/{id}': true,

 // Spec paths under /routes and /routecon: System routing tables.
 '/routes': true,
 '/routes/count': true,
 '/routes/{route-id}': true,
 '/routes/{route-id}/routecon': true,
 '/routecon/count': true,
 '/routes/{route-id}/routecon/{index}': true,

 // Spec paths under /connections: System trunk / carrier connections.
 '/connections': true,
 '/connections/count': true,

 // Spec paths under /dialplans and /dialpolicy: System dial plans and policies.
 '/dialplans': true,
 '/dialpolicy': true,
 '/dialpolicy/{policy}': true,
 '/dialpolicy/{policy}/permission': true,
 '/dialpolicy/{policy}/permission/{id}': true,

 // Spec paths under /configurations, /config-definitions, /nsconfigs: System configurations.
 '/configurations': true,
 '/configurations/count': true,
 '/configurations/{config-name}': true,
 '/config-definitions': true,
 '/config-definitions/{config-name}': true,
 '/nsconfigs': true,

 // Spec paths under /certificates: System SSL certificates.
 '/certificates': true,
 '/certificates/{name}': true,

 // Spec paths under /apikeys: System/reseller API keys.
 '/apikeys': true,
 '/apikeys#1': true,
 '/apikeys/~': true,
 '/apikeys/{key_id}': true,
};

/**
 * Representative arguments for tools that enforce required input fields.
 */
const REPRESENTATIVE_ARGS: Record<string, Record<string, unknown>> = {
 find_user: { query: 'alice' },
 find_contact: { query: 'bob' },
 call_details: { call_id: 'c1' },
 place_call: { to: '1002' },
 read_voicemail: { voicemail_id: 'vm1' },
 forward_voicemail: { voicemail_id: 'vm1', to: '1002' },
 read_messages: { session_id: 'sess1' },
 send_message: { to: '1002', text: 'hello' },
 agent_login: { queue: 'support', agent: '1001' },
 agent_logout: { queue: 'support', agent: '1001' },
 agent_status: { agent: '1001' },
 update_my_answer_rule: { timeframe: 'Default', update: { enable: true } },
 find_phone_number: { number: '1001' },
 find_device: { query: 'poly' },
 call_trace: { call_id: 'c1' },
 transfer_call: { call_id: 'c1', to: '1002' },
 end_call: { call_id: 'c1' },
 queue_status: { queue: 'support' },
 diagnose_call: { call_id: 'c1' },
 switch_queue: { from: 'q1', to: 'q2', agent: '1001' },
 find_and_call: { query: 'alice' },
 recent_activity_for_number: { number: '1001' },
 schedule_forwarding: { destination: '1002' },
 provision_user: { user: '1001', first_name: 'A', last_name: 'B', email: 'a@b.com' },
 deprovision_user: { user: '1001' },
 provision_call_queue: { callqueue: 'support' },
 deprovision_call_queue: { callqueue: 'support' },
 set_hold_message: { audio_base64: 'dGVzdA==' },
};

const ALL_TOOLS = [...new Set([...CURATED_CATALOG, ...WORKFLOW_TOOLS])];
const ROLES: UserRole[] = ['user', 'domain_admin', 'reseller', 'system_admin'];

describe('role-wall boundaries', () => {
 describe('class gate: no tool called below reseller issues requests to reseller-or-above endpoints', () => {
  for (const tool of ALL_TOOLS) {
   for (const role of ROLES) {
    if (ROLE_HIERARCHY[role] < ROLE_HIERARCHY[tool.minRole]) continue;

    it(`${tool.schema.name} as ${role}`, async () => {
     const recorded: RecordedRequest[] = [];
     const client = recordingClient(recorded);
     const args = REPRESENTATIVE_ARGS[tool.schema.name] ?? {};

     await tool.handler(args, client, role);

     if (ROLE_HIERARCHY[role] < ROLE_HIERARCHY.reseller) {
      for (const req of recorded) {
       const violates = Boolean(RESELLER_OR_ABOVE_ENDPOINTS[req.pathTemplate]);
       expect(
        violates,
        `${tool.schema.name} executed as ${role} requested ${req.method} ${req.pathTemplate}, ` +
        'which is a reseller-or-above endpoint.',
       ).toBe(false);
      }
     }
    });
   }
  }
 });

 describe('focused: find_domain role awareness', () => {
  it('as domain_admin hits /domains/{domain} with domain="~", never /domains', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'find_domain');
   expect(tool).toBeDefined();

   const recorded: RecordedRequest[] = [];
   const fakeDomainData = {
    domain: 'ggrmlaw.com',
    description: 'GGRM Law Firm',
   };
   const client = recordingClient(recorded, fakeDomainData);

   const result = await tool!.handler({}, client, 'domain_admin');

   expect(recorded.length).toBe(1);
   const req = recorded[0];
   expect(req.pathTemplate).toBe('/domains/{domain}');
   expect(req.pathParams?.domain).toBe('~');

   // Check response shape matches list path: a one-element data array
   const parsed = JSON.parse(result.content[0].text);
   expect(parsed.data).toEqual([fakeDomainData]);
  });

  it('as domain_admin applies query filter to caller domain', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'find_domain');
   expect(tool).toBeDefined();

   const recorded: RecordedRequest[] = [];
   const fakeDomainData = {
    domain: 'ggrmlaw.com',
    description: 'GGRM Law Firm',
   };
   const client = recordingClient(recorded, fakeDomainData);

   // Non-matching query
   const nonMatching = await tool!.handler({ query: 'spooner' }, client, 'domain_admin');
   const parsedNonMatch = JSON.parse(nonMatching.content[0].text);
   expect(parsedNonMatch.data).toEqual([]);

   // Matching query
   const matching = await tool!.handler({ query: 'ggrm' }, client, 'domain_admin');
   const parsedMatch = JSON.parse(matching.content[0].text);
   expect(parsedMatch.data).toEqual([fakeDomainData]);
  });

  it('as reseller hits /domains list endpoint', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'find_domain');
   expect(tool).toBeDefined();

   const recorded: RecordedRequest[] = [];
   const client = recordingClient(recorded, [{ domain: 'd1' }, { domain: 'd2' }]);

   await tool!.handler({}, client, 'reseller');

   expect(recorded.length).toBe(1);
   expect(recorded[0].pathTemplate).toBe('/domains');
  });

  it('as system_admin hits /domains list endpoint', async () => {
   const tool = CURATED_CATALOG.find((t) => t.schema.name === 'find_domain');
   expect(tool).toBeDefined();

   const recorded: RecordedRequest[] = [];
   const client = recordingClient(recorded, [{ domain: 'd1' }, { domain: 'd2' }]);

   await tool!.handler({}, client, 'system_admin');

   expect(recorded.length).toBe(1);
   expect(recorded[0].pathTemplate).toBe('/domains');
  });
 });
});
