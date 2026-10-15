import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
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

function sanitize(val: unknown, key = ''): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val === 'boolean' || typeof val === 'number') return val;
  if (Array.isArray(val)) return val.map((item) => sanitize(item, key));
  if (typeof val === 'object') {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      res[k] = sanitize(v, k);
    }
    return res;
  }
  let s = String(val);
  // Secret keys
  if (/password|pin|secret|passcode|token|auth/i.test(key) && !/key-id|timeframe|status/i.test(key)) {
    return '[REDACTED]';
  }
  // Names
  if (/name-first-name|first_name/i.test(key)) return 'Jane';
  if (/name-last-name|last_name/i.test(key)) return 'Doe';
  if (/name-full-name|FromName|caller-id-name|from-name/i.test(key)) return 'Jane Doe';
  // Emails
  if (/email/i.test(key) || /\S+@\S+\.\S+/.test(s)) {
    return s.replace(/[\w.-]+@[\w.-]+\.[a-zA-Z]{2,}/g, 'user@example.com');
  }
  // Transcripts & message text
  if (/file-script-text|transcription|transcript|^message$|^text$/i.test(key)) {
    return 'This is a sanitized test message.';
  }
  // Phone numbers (10 digits, +1..., etc.)
  if (/phone|caller-id-number|number|dialed|destination/i.test(key) || /^\+?1?\d{10}$/.test(s)) {
    if (s.startsWith('+1')) return '+15551234567';
    if (s.length === 10 && /^\d+$/.test(s)) return '5551234567';
  }
  // IPs
  s = s.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '192.0.2.1');
  return s;
}

const WRITE_TOOLS = new Set([
  'place_call',
  'transfer_call',
  'end_call',
  'forward_voicemail',
  'send_message',
  'agent_login',
  'agent_logout',
  'update_my_answer_rule',
  'switch_queue',
  'find_and_call',
  'schedule_forwarding',
  'provision_user',
  'deprovision_user',
  'provision_call_queue',
  'deprovision_call_queue',
  'set_hold_message',
]);

const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  find_user: { query: '1011' },
  find_contact: { query: '1011' },
  recent_calls: {},
  call_volume: {},
  call_details: { call_id: '17920189603fbd66a39410012ded2d6cb48773ca46' },
  my_voicemails: {},
  read_voicemail: { voicemail_id: 'vm-20261014230240002772-1060dbaaf1b6b354dbede99e21161b2e.wav' },
  list_message_sessions: {},
  read_messages: { session_id: 'c1919a5ed63f289545f6304a14f2314e' },
  agent_status: {},
  my_devices: {},
  my_answer_rules: {},
  find_domain: {},
  find_phone_number: { number: '6022226368' },
  find_device: { query: '1011' },
  active_calls: {},
  call_trace: { call_id: '17920189603fbd66a39410012ded2d6cb48773ca46' },
  list_queues: {},
  queue_status: { queue: '1099' },
  call_statistics: {},
  agent_statistics: {},
  diagnose_call: { call_id: '17920189603fbd66a39410012ded2d6cb48773ca46' },
  user_profile: { user: '1011' },
  queue_health: {},
  agent_dashboard: {},
  recent_activity_for_number: { number: '6022226368' },
  voicemail_inbox_summary: {},
};

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
      await new Promise((r) => setTimeout(r, 1000));
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
      if (WRITE_TOOLS.has(t.schema.name)) return false;
      return ROLE_HIERARCHY[t.minRole] <= ROLE_HIERARCHY[role];
    });

    console.log(`Tools to capture: ${readTools.length}`);

    for (const tool of readTools) {
      const name = tool.schema.name;
      const args = SAMPLE_ARGS[name] || {};
      try {
        const result = await tool.handler(args, client, role);
        const text = result.content[0]?.text;
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { text };
        }
        const sanitized = sanitize(payload);
        const outPath = resolve(FIXTURES_DIR, `${name}.${id}.json`);
        writeFileSync(outPath, JSON.stringify(sanitized, null, 2) + '\n');
        console.log(`  [OK] ${name} -> ${outPath}`);
      } catch (err: unknown) {
        console.error(`  [ERR] ${name}:`, err);
      }
    }
  }
}

capture().catch(console.error);
