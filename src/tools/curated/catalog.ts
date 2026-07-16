/**
 * The curated tool catalog — ~28 task-shaped composites covering everyday
 * user, agent, and domain-admin workflows on NetSapiens. Each is one or two
 * `client.request()` calls underneath; we shape the args and the response
 * so the model has a small, intentional surface to work from instead of the
 * full 700+ generated registry.
 *
 * `~` in NS paths means "the authenticated user / their domain", so
 * `my_*` and self-service tools just substitute `~`.
 */

import type { CuratedTool } from './types.js';
import { textResult } from './types.js';
import { WORKFLOW_TOOLS } from './workflows.js';
import { fieldsMatch, numbersMatch } from './matching.js';

const str = (v: unknown, dflt = '~') => (v == null || v === '' ? dflt : String(v));
const num = (v: unknown) => (typeof v === 'number' ? v : v == null ? undefined : Number(v));

// ---------------------------------------------------------------------------
// FIND / LOOKUP
// ---------------------------------------------------------------------------

const find_user: CuratedTool = {
  minRole: 'user',
  schema: {
    name: 'find_user',
    description: 'Search for a NetSapiens user by name, login, email, or extension. Returns matching users in the given domain (defaults to your own).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name fragment, login, email, or extension' },
        domain: { type: 'string', description: 'Domain to search in. Defaults to your own.' },
        limit: { type: 'number', default: 10, description: 'Max matches to return (default 10)' },
      },
      required: ['query'],
    },
  },
  handler: async (args, client) => {
    const query = str(args.query, '');
    const limit = num(args.limit) ?? 10;
    // /domains/{domain}/users has no server-side name/login/email/extension
    // filter (only limit/start) — the API silently ignores an unrecognized
    // filter param, so fetch broadly and match client-side.
    const r = await client.request({
      method: 'GET',
      pathTemplate: '/domains/{domain}/users',
      pathParams: { domain: str(args.domain) },
      queryParams: { limit: 1000 },
    });
    if (!r.success || !Array.isArray(r.data)) return textResult(r);
    const matches = (r.data as Array<Record<string, unknown>>).filter((u) =>
      fieldsMatch(u, ['user', 'name-first-name', 'name-last-name', 'login-username', 'email'], query),
    );
    return textResult({ ...r, data: matches.slice(0, limit) });
  },
};

const find_domain: CuratedTool = {
  minRole: 'domain_admin',
  schema: {
    name: 'find_domain',
    description: 'Look up a NetSapiens domain by name or filter. Use without a query to list domains you can see.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Domain name fragment. Omit to list all visible domains.' },
        limit: { type: 'number', default: 25 },
      },
    },
  },
  handler: async (args, client) => {
    const query = args.query ? String(args.query) : '';
    const limit = num(args.limit) ?? 25;
    // /domains has no server-side name filter (only limit/start) — fetch
    // broadly and match client-side when a query is given.
    const r = await client.request({
      method: 'GET',
      pathTemplate: '/domains',
      queryParams: { limit: query ? 1000 : limit },
    });
    if (!r.success || !Array.isArray(r.data)) return textResult(r);
    const list = r.data as Array<Record<string, unknown>>;
    const matches = query ? list.filter((d) => fieldsMatch(d, ['domain', 'description'], query)) : list;
    return textResult({ ...r, data: matches.slice(0, limit) });
  },
};

const find_contact: CuratedTool = {
  minRole: 'user',
  schema: {
    name: 'find_contact',
    description: 'Search your contacts by name, number, or email.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        domain: { type: 'string' },
        limit: { type: 'number', default: 25 },
      },
      required: ['query'],
    },
  },
  handler: async (args, client) => {
    const query = str(args.query, '');
    const limit = num(args.limit) ?? 25;
    // /domains/{domain}/users/{user}/contacts has no name/number/email filter
    // (only includeDomain) — fetch the contact list and match client-side.
    const r = await client.request({
      method: 'GET',
      pathTemplate: '/domains/{domain}/users/~/contacts',
      pathParams: { domain: str(args.domain) },
    });
    if (!r.success || !Array.isArray(r.data)) return textResult(r);
    const matches = (r.data as Array<Record<string, unknown>>).filter(
      (c) =>
        fieldsMatch(c, ['name-first-name', 'name-middle-name', 'name-last-name', 'email', 'company'], query) ||
        numbersMatch(
          [c['phonenumber-work'], c['phonenumber-cell'], c['phonenumber-fax'], c['phonenumber-home']].filter((v) => v != null).join(','),
          query,
        ),
    );
    return textResult({ ...r, data: matches.slice(0, limit) });
  },
};

const find_phone_number: CuratedTool = {
  minRole: 'domain_admin',
  schema: {
    name: 'find_phone_number',
    description: 'Look up a phone number in your domain (or a specific domain). Returns routing, assignment, and number details.',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'string', description: 'E.164 or domestic format' },
        domain: { type: 'string' },
      },
      required: ['number'],
    },
  },
  handler: async (args, client) => {
    const number = String(args.number);
    // /domains/{domain}/phonenumbers has no query filter at all — fetch the
    // full domain number list and match client-side.
    const r = await client.request({
      method: 'GET',
      pathTemplate: '/domains/{domain}/phonenumbers',
      pathParams: { domain: str(args.domain) },
    });
    if (!r.success || !Array.isArray(r.data)) return textResult(r);
    const matches = (r.data as Array<Record<string, unknown>>).filter((p) => numbersMatch(String(p.phonenumber ?? ''), number));
    return textResult({ ...r, data: matches });
  },
};

const find_device: CuratedTool = {
  minRole: 'domain_admin',
  schema: {
    name: 'find_device',
    description: 'Look up a phone/device by MAC, extension, or model in your domain.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'MAC, extension, or model fragment' },
        domain: { type: 'string' },
      },
      required: ['query'],
    },
  },
  handler: async (args, client) => {
    const query = String(args.query);
    // /domains/{domain}/devices has no query filter at all — fetch the full
    // domain device list and match client-side.
    const r = await client.request({
      method: 'GET',
      pathTemplate: '/domains/{domain}/devices',
      pathParams: { domain: str(args.domain) },
    });
    if (!r.success || !Array.isArray(r.data)) return textResult(r);
    const matches = (r.data as Array<Record<string, unknown>>).filter((d) =>
      fieldsMatch(d, ['device', 'user', 'device-sip-registration-user-agent', 'device-models-model'], query),
    );
    return textResult({ ...r, data: matches });
  },
};

// ---------------------------------------------------------------------------
// CALL HISTORY & LIVE
// ---------------------------------------------------------------------------

const recent_calls: CuratedTool = {
  minRole: 'user',
  schema: {
    name: 'recent_calls',
    description: 'Recent call detail records (CDR). Defaults to your own calls. Pass `user` to look at another user; pass `domain` for a domain-wide view.',
    inputSchema: {
      type: 'object',
      properties: {
        user: { type: 'string', description: 'User to inspect. Defaults to you (`~`).' },
        domain: { type: 'string' },
        limit: { type: 'number', default: 25 },
        since: { type: 'string', description: 'ISO date — only calls after this timestamp' },
      },
    },
  },
  handler: async (args, client) => {
    // `datetime-start` is the real param — `start-time-after` doesn't exist on
    // this endpoint. It's also a REQUIRED PAIR with `datetime-end`: sending
    // `datetime-start` alone is silently ignored by the API (confirmed against
    // live data), so bound the other end at "now" whenever `since` is given.
    const since = args.since ? String(args.since) : undefined;
    const until = since ? new Date().toISOString() : undefined;
    const r = await client.request({
      method: 'GET',
      pathTemplate: '/domains/{domain}/users/{user}/cdrs',
      pathParams: { domain: str(args.domain), user: str(args.user) },
      queryParams: { limit: num(args.limit) ?? 25, 'datetime-start': since, 'datetime-end': until },
    });
    return textResult(r);
  },
};

const active_calls: CuratedTool = {
  minRole: 'domain_admin',
  schema: {
    name: 'active_calls',
    description: 'Calls currently active in the domain.',
    inputSchema: {
      type: 'object',
      properties: { domain: { type: 'string' }, limit: { type: 'number', default: 50 } },
    },
  },
  handler: async (args, client) => {
    const r = await client.request({
      method: 'GET',
      pathTemplate: '/domains/{domain}/calls',
      pathParams: { domain: str(args.domain) },
      queryParams: { limit: num(args.limit) ?? 50 },
    });
    return textResult(r);
  },
};

const call_details: CuratedTool = {
  minRole: 'user',
  schema: {
    name: 'call_details',
    description: 'Details for a specific call by call_id.',
    inputSchema: {
      type: 'object',
      properties: {
        call_id: { type: 'string' },
        domain: { type: 'string' },
        user: { type: 'string', default: '~' },
      },
      required: ['call_id'],
    },
  },
  handler: async (args, client) => {
    const r = await client.request({
      method: 'GET',
      pathTemplate: '/domains/{domain}/users/{user}/calls/{callid}',
      pathParams: { domain: str(args.domain), user: str(args.user), callid: String(args.call_id) },
    });
    return textResult(r);
  },
};

const call_trace: CuratedTool = {
  minRole: 'domain_admin',
  schema: {
    name: 'call_trace',
    description: 'SIP flow / call trace for a specific call. Useful for diagnosing why a call did what it did.',
    inputSchema: { type: 'object', properties: { call_id: { type: 'string' } }, required: ['call_id'] },
  },
  handler: async (args, client) => {
    const r = await client.request({
      method: 'GET',
      pathTemplate: '/sipflow/{callid}',
      pathParams: { callid: String(args.call_id) },
    });
    return textResult(r);
  },
};

const place_call: CuratedTool = {
  minRole: 'user',
  schema: {
    name: 'place_call',
    description: 'Originate a call ("click to call") — your device rings first, then NS dials the destination.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Destination number or extension' },
        from: { type: 'string', description: 'Your extension; defaults to you' },
        domain: { type: 'string' },
      },
      required: ['to'],
    },
  },
  handler: async (args, client) => {
    const r = await client.request({
      method: 'POST',
      pathTemplate: '/domains/{domain}/users/{user}/calls',
      pathParams: { domain: str(args.domain), user: str(args.from) },
      body: { destination: String(args.to) },
    });
    return textResult(r);
  },
};

const transfer_call: CuratedTool = {
  minRole: 'domain_admin',
  schema: {
    name: 'transfer_call',
    description: 'Transfer an active call. Blind by default; pass type="peer" for an attended transfer.',
    inputSchema: {
      type: 'object',
      properties: {
        call_id: { type: 'string' },
        to: { type: 'string', description: 'Destination number/extension' },
        type: { type: 'string', enum: ['blind', 'peer'], default: 'blind' },
        user: { type: 'string', default: '~' },
        domain: { type: 'string' },
      },
      required: ['call_id', 'to'],
    },
  },
  handler: async (args, client) => {
    const isPeer = String(args.type ?? 'blind') === 'peer';
    const pathTemplate = isPeer
      ? '/domains/{domain}/users/{user}/calls/{callid}/transfer/peer'
      : '/domains/{domain}/users/{user}/calls/{callid}/transfer';
    const r = await client.request({
      method: 'PATCH',
      pathTemplate,
      pathParams: { domain: str(args.domain), user: str(args.user), callid: String(args.call_id) },
      body: { destination: String(args.to) },
    });
    return textResult(r);
  },
};

const end_call: CuratedTool = {
  minRole: 'domain_admin',
  destructive: true,
  schema: {
    name: 'end_call',
    description: 'Disconnect an active call.',
    inputSchema: {
      type: 'object',
      properties: {
        call_id: { type: 'string' },
        user: { type: 'string', default: '~' },
        domain: { type: 'string' },
      },
      required: ['call_id'],
    },
  },
  handler: async (args, client) => {
    const r = await client.request({
      method: 'DELETE',
      pathTemplate: '/domains/{domain}/users/{user}/calls/{callid}',
      pathParams: { domain: str(args.domain), user: str(args.user), callid: String(args.call_id) },
    });
    return textResult(r);
  },
};

// ---------------------------------------------------------------------------
// VOICEMAIL
// ---------------------------------------------------------------------------

const my_voicemails: CuratedTool = {
  minRole: 'user',
  schema: {
    name: 'my_voicemails',
    description: 'List your voicemails. Pass folder ("new", "saved", "trash") to filter.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'new | saved | trash | (omit for all)' },
        limit: { type: 'number', default: 25 },
      },
    },
  },
  handler: async (args, client) => {
    const folder = args.folder ? String(args.folder) : undefined;
    const r = folder
      ? await client.request({
          method: 'GET',
          pathTemplate: '/domains/~/users/~/voicemails/{folder}',
          pathParams: { folder },
          queryParams: { limit: num(args.limit) ?? 25 },
        })
      : await client.request({
          method: 'GET',
          pathTemplate: '/domains/~/users/~/voicemails',
          queryParams: { limit: num(args.limit) ?? 25 },
        });
    return textResult(r);
  },
};

const read_voicemail: CuratedTool = {
  minRole: 'user',
  schema: {
    name: 'read_voicemail',
    description: 'Open a specific voicemail (metadata + download URL/transcript if available).',
    inputSchema: { type: 'object', properties: { voicemail_id: { type: 'string' } }, required: ['voicemail_id'] },
  },
  handler: async (args, client) => {
    const r = await client.request({
      method: 'GET',
      pathTemplate: '/domains/~/users/~/voicemails/{id}',
      pathParams: { id: String(args.voicemail_id) },
    });
    return textResult(r);
  },
};

const forward_voicemail: CuratedTool = {
  minRole: 'user',
  schema: {
    name: 'forward_voicemail',
    description: 'Forward a voicemail to another user.',
    inputSchema: {
      type: 'object',
      properties: {
        voicemail_id: { type: 'string' },
        to: { type: 'string', description: 'Destination user extension' },
        note: { type: 'string', description: 'Optional note to attach' },
      },
      required: ['voicemail_id', 'to'],
    },
  },
  handler: async (args, client) => {
    const r = await client.request({
      method: 'POST',
      pathTemplate: '/domains/~/users/~/voicemails/{id}/forward',
      pathParams: { id: String(args.voicemail_id) },
      body: { destination: String(args.to), note: args.note ? String(args.note) : undefined },
    });
    return textResult(r);
  },
};

// ---------------------------------------------------------------------------
// MESSAGING (SMS / chat)
// ---------------------------------------------------------------------------

const list_message_sessions: CuratedTool = {
  minRole: 'user',
  schema: {
    name: 'list_message_sessions',
    description: 'Your active message sessions (SMS, chat, group chat).',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', default: 25 } } },
  },
  handler: async (args, client) => {
    const r = await client.request({
      method: 'GET',
      pathTemplate: '/domains/~/users/~/messagesessions',
      queryParams: { limit: num(args.limit) ?? 25 },
    });
    return textResult(r);
  },
};

const read_messages: CuratedTool = {
  minRole: 'user',
  schema: {
    name: 'read_messages',
    description: 'Read messages from a specific message session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        limit: { type: 'number', default: 50 },
      },
      required: ['session_id'],
    },
  },
  handler: async (args, client) => {
    const r = await client.request({
      method: 'GET',
      pathTemplate: '/domains/~/users/~/messagesessions/{session}/messages',
      pathParams: { session: String(args.session_id) },
      queryParams: { limit: num(args.limit) ?? 50 },
    });
    return textResult(r);
  },
};

const send_message: CuratedTool = {
  minRole: 'user',
  schema: {
    name: 'send_message',
    description: 'Send a message (SMS or chat) to a destination.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Destination number or user@domain' },
        text: { type: 'string' },
        type: { type: 'string', enum: ['sms', 'chat'], default: 'sms' },
      },
      required: ['to', 'text'],
    },
  },
  handler: async (args, client) => {
    const r = await client.request({
      method: 'POST',
      pathTemplate: '/domains/~/users/~/messagesessions',
      body: { destination: String(args.to), message: String(args.text), type: String(args.type ?? 'sms') },
    });
    return textResult(r);
  },
};

// ---------------------------------------------------------------------------
// CALL CENTER / QUEUES
// ---------------------------------------------------------------------------

const list_queues: CuratedTool = {
  minRole: 'domain_admin',
  schema: {
    name: 'list_queues',
    description: 'Call queues in the domain.',
    inputSchema: { type: 'object', properties: { domain: { type: 'string' } } },
  },
  handler: async (args, client) => {
    const r = await client.request({
      method: 'GET',
      pathTemplate: '/domains/{domain}/callqueues',
      pathParams: { domain: str(args.domain) },
    });
    return textResult(r);
  },
};

const queue_status: CuratedTool = {
  minRole: 'domain_admin',
  schema: {
    name: 'queue_status',
    description: 'Live status of a queue — waiting calls, available/busy agents, longest wait.',
    inputSchema: {
      type: 'object',
      properties: { queue: { type: 'string' }, domain: { type: 'string' } },
      required: ['queue'],
    },
  },
  handler: async (args, client) => {
    const r = await client.request({
      method: 'GET',
      pathTemplate: '/domains/{domain}/statistics/callqueues/{queue}',
      pathParams: { domain: str(args.domain), queue: String(args.queue) },
    });
    return textResult(r);
  },
};

const agent_login: CuratedTool = {
  minRole: 'user',
  schema: {
    name: 'agent_login',
    description: 'Log an agent into a queue (or all queues with queue="all").',
    inputSchema: {
      type: 'object',
      properties: {
        queue: { type: 'string', default: 'all' },
        agent: { type: 'string', description: 'Agent extension; defaults to you' },
      },
    },
  },
  handler: async (args, client) => {
    const r = await client.request({
      method: 'POST',
      pathTemplate: '/domains/~/callqueues/{queue}/agents/{agent}/login',
      pathParams: { queue: str(args.queue, 'all'), agent: str(args.agent) },
    });
    return textResult(r);
  },
};

const agent_logout: CuratedTool = {
  minRole: 'user',
  schema: {
    name: 'agent_logout',
    description: 'Log an agent out of a queue (or all with queue="all").',
    inputSchema: {
      type: 'object',
      properties: {
        queue: { type: 'string', default: 'all' },
        agent: { type: 'string' },
      },
    },
  },
  handler: async (args, client) => {
    const r = await client.request({
      method: 'POST',
      pathTemplate: '/domains/~/callqueues/{queue}/agents/{agent}/logout',
      pathParams: { queue: str(args.queue, 'all'), agent: str(args.agent) },
    });
    return textResult(r);
  },
};

const agent_status: CuratedTool = {
  minRole: 'user',
  schema: {
    name: 'agent_status',
    description: 'Get an agent\'s current queue status. Defaults to yourself.',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' } } },
  },
  handler: async (args, client) => {
    const r = await client.request({
      method: 'GET',
      pathTemplate: '/domains/~/callqueues/all/agents/{agent}',
      pathParams: { agent: str(args.agent) },
    });
    return textResult(r);
  },
};

// ---------------------------------------------------------------------------
// SELF-SERVICE
// ---------------------------------------------------------------------------

const my_devices: CuratedTool = {
  minRole: 'user',
  schema: {
    name: 'my_devices',
    description: 'Devices registered to your user.',
    inputSchema: { type: 'object', properties: {} },
  },
  handler: async (_args, client) => {
    const r = await client.request({
      method: 'GET',
      pathTemplate: '/domains/~/users/~/devices',
    });
    return textResult(r);
  },
};

const my_answer_rules: CuratedTool = {
  minRole: 'user',
  schema: {
    name: 'my_answer_rules',
    description: 'Your answer rules (call routing decisions per time-frame).',
    inputSchema: { type: 'object', properties: {} },
  },
  handler: async (_args, client) => {
    const r = await client.request({
      method: 'GET',
      pathTemplate: '/domains/~/users/~/answerrules',
    });
    return textResult(r);
  },
};

const update_my_answer_rule: CuratedTool = {
  minRole: 'user',
  schema: {
    name: 'update_my_answer_rule',
    description: 'Update one of your answer rules by time-frame name.',
    inputSchema: {
      type: 'object',
      properties: {
        timeframe: { type: 'string' },
        update: { type: 'object', description: 'Partial fields to update (action, destination, etc.)' },
      },
      required: ['timeframe', 'update'],
    },
  },
  handler: async (args, client) => {
    const r = await client.request({
      method: 'PUT',
      pathTemplate: '/domains/~/users/~/answerrules/{timeframe}',
      pathParams: { timeframe: String(args.timeframe) },
      body: args.update,
    });
    return textResult(r);
  },
};

// ---------------------------------------------------------------------------
// REPORTS
// ---------------------------------------------------------------------------

const call_statistics: CuratedTool = {
  minRole: 'domain_admin',
  schema: {
    name: 'call_statistics',
    description: 'Aggregate call-queue statistics for a domain or specific queue.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        queue: { type: 'string', description: 'Specific queue, or omit for aggregate' },
        since: { type: 'string', description: 'ISO date' },
      },
    },
  },
  handler: async (args, client) => {
    const pathTemplate = args.queue
      ? '/domains/{domain}/statistics/callqueues/{queue}'
      : '/domains/{domain}/statistics/callqueues/aggregate';
    const pathParams: Record<string, string> = { domain: str(args.domain) };
    if (args.queue) pathParams.queue = String(args.queue);
    // `datetime-start` is the real param — `start-time-after` doesn't exist on
    // this endpoint. It's also a REQUIRED PAIR with `datetime-end`: sending
    // `datetime-start` alone is silently ignored by the API (confirmed against
    // live data), so bound the other end at "now" whenever `since` is given.
    const since = args.since ? String(args.since) : undefined;
    const until = since ? new Date().toISOString() : undefined;
    const r = await client.request({
      method: 'GET',
      pathTemplate,
      pathParams,
      queryParams: { 'datetime-start': since, 'datetime-end': until },
    });
    return textResult(r);
  },
};

const agent_statistics: CuratedTool = {
  minRole: 'domain_admin',
  schema: {
    name: 'agent_statistics',
    description: 'Agent performance stats — calls handled, talk time, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        agent: { type: 'string' },
        since: { type: 'string' },
      },
    },
  },
  handler: async (args, client) => {
    const pathTemplate = args.agent
      ? '/domains/{domain}/statistics/agent/{agent}'
      : '/domains/{domain}/statistics/agent';
    const pathParams: Record<string, string> = { domain: str(args.domain) };
    if (args.agent) pathParams.agent = String(args.agent);
    // `datetime-start` is the real param — `start-time-after` doesn't exist on
    // this endpoint. It's also a REQUIRED PAIR with `datetime-end`: sending
    // `datetime-start` alone is silently ignored by the API (confirmed against
    // live data), so bound the other end at "now" whenever `since` is given.
    const since = args.since ? String(args.since) : undefined;
    const until = since ? new Date().toISOString() : undefined;
    const r = await client.request({
      method: 'GET',
      pathTemplate,
      pathParams,
      queryParams: { 'datetime-start': since, 'datetime-end': until },
    });
    return textResult(r);
  },
};

// ---------------------------------------------------------------------------
// Exported catalog
// ---------------------------------------------------------------------------

export const CURATED_CATALOG: CuratedTool[] = [
  // user-tier (~14)
  find_user,
  find_contact,
  recent_calls,
  call_details,
  place_call,
  my_voicemails,
  read_voicemail,
  forward_voicemail,
  list_message_sessions,
  read_messages,
  send_message,
  agent_login,
  agent_logout,
  agent_status,
  my_devices,
  my_answer_rules,
  update_my_answer_rule,
  // domain_admin-tier (~11)
  find_domain,
  find_phone_number,
  find_device,
  active_calls,
  call_trace,
  transfer_call,
  end_call,
  list_queues,
  queue_status,
  call_statistics,
  agent_statistics,
  // workflow / multi-call composites (~9)
  ...WORKFLOW_TOOLS,
];
