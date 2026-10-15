import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { NetSapiensClient } from '../src/netsapiens-client.js';
import { CURATED_CATALOG } from '../src/tools/curated/catalog.js';
import { ROLE_HIERARCHY, type UserRole } from '../src/auth/roles.js';

const PROOF_PATH = `${process.env.HOME}/.config/phoneware/phonewarelab-mcp-proof.json`;
const NS_CLIENT_PATH = `${process.env.HOME}/.config/phoneware/ns-oauth-client.json`;
const NS_URL = 'https://edge.phoneware.cloud';

const proof = JSON.parse(readFileSync(PROOF_PATH, 'utf8'));
const nsClient = JSON.parse(readFileSync(NS_CLIENT_PATH, 'utf8'));

const FIXTURES_DIR = resolve('src/__tests__/fixtures/live');
mkdirSync(FIXTURES_DIR, { recursive: true });

/**
 * Fixtures land in a public repo. Live responses are converted to value-free shapes
 * directly in memory before writing to disk. Raw responses never touch disk.
 */
function toShape(val: unknown): unknown {
 if (val === null || val === undefined || typeof val === 'boolean') return val;
 if (typeof val === 'number') return 0;
 if (typeof val === 'string') return 's';
 if (Array.isArray(val)) {
  return val.slice(0, 2).map((item) => toShape(item));
 }
 if (typeof val === 'object') {
  const res: Record<string, unknown> = {};
  let keyIdx = 0;
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
   const isDataKey =
    /^\d/.test(k) ||
    k.includes('@') ||
    (!/^[a-z][a-z0-9_-]*$/.test(k) &&
     !/^[345]-digit-dial-by-extension$/.test(k) &&
     k !== 'vmailType' &&
     k !== 'maxCallMinute');
   const finalKey = isDataKey ? `k${keyIdx++}` : k;
   res[finalKey] = toShape(v);
  }
  return res;
 }
 return val;
}

const WRITE_TOOLS: Record<string, true> = {
 place_call: true,
 transfer_call: true,
 end_call: true,
 forward_voicemail: true,
 send_message: true,
 agent_login: true,
 agent_logout: true,
 update_my_answer_rule: true,
 switch_queue: true,
 find_and_call: true,
 schedule_forwarding: true,
 provision_user: true,
 deprovision_user: true,
 provision_call_queue: true,
 deprovision_call_queue: true,
 set_hold_message: true,
};

// Record identifiers are discovered at capture time from the persona's own lists, so no
// live id ever sits in this public file.
const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
 find_user: { query: '1011' },
 find_contact: { query: '1011' },
 recent_calls: {},
 call_volume: {},
 my_voicemails: {},
 list_message_sessions: {},
 agent_status: {},
 my_devices: {},
 my_answer_rules: {},
 find_domain: {},
 find_phone_number: { number: '6025550100' },
 find_device: { query: '1011' },
 active_calls: {},
 list_queues: {},
 queue_status: { queue: '1099' },
 call_statistics: {},
 agent_statistics: {},
 user_profile: { user: '1011' },
 queue_health: {},
 agent_dashboard: {},
 recent_activity_for_number: { number: '6025550100' },
 voicemail_inbox_summary: {},
};

async function firstRecord(name: string, client: NetSapiensClient, role: UserRole): Promise<Record<string, unknown> | undefined> {
 const tool = CURATED_CATALOG.find((t) => t.schema.name === name);
 if (!tool) return undefined;
 try {
  const result = await tool.handler({}, client, role);
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { data?: unknown };
  return Array.isArray(parsed.data) ? (parsed.data[0] as Record<string, unknown> | undefined) : undefined;
 } catch {
  return undefined;
 }
}

async function discoverArgs(client: NetSapiensClient, role: UserRole): Promise<Record<string, Record<string, unknown>>> {
 const call = await firstRecord('recent_calls', client, role);
 const voicemail = await firstRecord('my_voicemails', client, role);
 const session = await firstRecord('list_message_sessions', client, role);
 const discovered: Record<string, Record<string, unknown>> = {};
 if (call?.id) {
  for (const name of ['call_details', 'call_trace', 'diagnose_call']) discovered[name] = { call_id: String(call.id) };
 }
 if (voicemail?.filename) discovered.read_voicemail = { voicemail_id: String(voicemail.filename) };
 if (session?.['messagesession-id']) discovered.read_messages = { session_id: String(session['messagesession-id']) };
 return { ...SAMPLE_ARGS, ...discovered };
}

async function mintToken(user: string): Promise<string> {
 const p = proof.personas[user];
 let res: Response | undefined;
 for (let attempt = 0; attempt < 3; attempt++) {
  try {
   res = await fetch(`${NS_URL}/ns-api/v2/jwt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
     grant_type: 'password',
     client_id: nsClient.client_id,
     client_secret: nsClient.client_secret,
     username: p.login,
     password: p.password,
    }),
   });
   if (res.ok) break;
  } catch {
   await sleep(1000);
  }
 }
 if (!res || !res.ok) throw new Error(`Failed to mint token for ${user}`);
 const data = (await res.json()) as { token?: string; access_token?: string };
 return (data.token || data.access_token)!;
}

async function capture() {
 const personas: Array<{ id: string; role: UserRole }> = [
  { id: '1011', role: 'user' },
  { id: '1013', role: 'domain_admin' },
  { id: '1015', role: 'domain_admin' },
 ];

 for (const { id, role } of personas) {
  console.log(`\n=== Capturing persona ${id} (${role}) ===`);
  const token = await mintToken(id);
  const client = new NetSapiensClient({
   apiUrl: NS_URL,
   apiToken: token,
  });

  const readTools = CURATED_CATALOG.filter((t) => {
   if (t.destructive) return false;
   if (WRITE_TOOLS[t.schema.name]) return false;
   return ROLE_HIERARCHY[t.minRole] <= ROLE_HIERARCHY[role];
  });

  console.log(`Tools to capture: ${readTools.length}`);
  const sampleArgs = await discoverArgs(client, role);

  for (const tool of readTools) {
   const name = tool.schema.name;
   const args = sampleArgs[name] || {};
   try {
    const result = await tool.handler(args, client, role);
    const text = result.content[0]?.text;
    let payload: unknown;
    try {
     payload = JSON.parse(text);
    } catch {
     payload = { text };
    }
    const shaped = toShape(payload);
    const outPath = resolve(FIXTURES_DIR, `${name}.${id}.json`);
    writeFileSync(outPath, JSON.stringify(shaped, null, 2) + '\n');
    console.log(`  [OK] ${name} -> ${outPath}`);
   } catch (err: unknown) {
    console.error(`  [ERR] ${name}:`, err);
   }
  }
 }
}

capture().catch(console.error);
