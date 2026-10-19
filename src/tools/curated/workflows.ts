/**
 * Workflow tools — composites that chain multiple NetSapiens calls to deliver
 * a higher-level user intent in one tool call. Saves the model from
 * tool-call ping-pong and collapses common multi-step admin/user flows.
 *
 * Independent reads run in parallel via Promise.all; failures in any one
 * sub-call are captured into the shaped result rather than throwing, so the
 * model always gets a usable response with whatever succeeded.
 */

import type { CuratedTool } from './types.js';
import { textResult, STANDARD_WRAPPER_RULES } from './types.js';
import type { GenericApiClient, NetSapiensApiResponse } from '../../generated/types.js';
import { fieldsMatch, isOnOrAfter, numbersMatch, parseNsBoolean, isNsTraceExpected } from './matching.js';
export { parseNsBoolean, isNsTraceExpected };
import { ROLE_HIERARCHY, type UserRole } from '../../auth/roles.js';
import { matchesCallId, nsDateWindow, resolveSelfUser } from './catalog.js';
import { resolveQueueAgent } from './queue-agent.js';
import { attachVoicemailTranscripts } from './voicemail-transcripts.js';

const str = (v: unknown, dflt = '~') => (v == null || v === '' ? dflt : String(v));


/** Settle a request and surface failures as a `{ error }` field instead of throwing. */
async function safe<T = unknown>(p: Promise<NetSapiensApiResponse<T>>): Promise<{ ok: boolean; data?: T; error?: string }> {
 try {
  const r = await p;
  if (r.success) return { ok: true, data: r.data };
  return { ok: false, error: r.error || 'request failed' };
 } catch (err: unknown) {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
 }
}



export interface CallLookupOptions {
 callId: string;
 domain?: string;
 user?: string;
 servers?: string;
 startTime?: string;
 endTime?: string;
 userRole?: UserRole;
}

export interface CallLookupSuccess {
 source: 'active' | 'cdr';
 callData: Record<string, unknown>;
 server: string;
 startTime?: string;
 endTime?: string;
 isTraceExpected: boolean;
}

export interface CallLookupFailure {
 error: string;
 detail: string;
 searchedWindow: { start: string; end: string };
 callData?: Record<string, unknown>;
}

export async function lookupCallForTrace(
 options: CallLookupOptions,
 client: GenericApiClient,
): Promise<{ ok: true; data: CallLookupSuccess; searchedWindow: { start: string; end: string } } | { ok: false; failure: CallLookupFailure }> {
 const domain = str(options.domain);
 const user = str(options.user);
 const callid = options.callId;

 const windowEnd = options.endTime ? String(options.endTime) : new Date().toISOString();
 const windowStart = options.startTime
  ? String(options.startTime)
  : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
 const searchedWindow = { start: windowStart, end: windowEnd };

 if (options.servers) {
  return {
   ok: true,
   data: {
    source: 'active',
    callData: {},
    server: String(options.servers),
    startTime: options.startTime,
    endTime: options.endTime,
    isTraceExpected: true,
   },
   searchedWindow,
  };
 }

 // 1. Try active call lookup first (returns 404 for completed calls)
 const activeRes = await safe(
  client.request({
   method: 'GET',
   pathTemplate: '/domains/{domain}/users/{user}/calls/{callid}',
   pathParams: { domain, user, callid },
  }),
 );

 if (activeRes.ok && activeRes.data && typeof activeRes.data === 'object' && !Array.isArray(activeRes.data)) {
  const callData = activeRes.data as Record<string, unknown>;
  const server = (callData['core-server'] ?? callData['hostname']) as string | undefined;
  if (server) {
   const startTime = (options.startTime ?? callData['call-start-datetime']) as string | undefined;
   const endTime = (options.endTime ?? callData['call-disconnect-datetime']) as string | undefined;
   return {
    ok: true,
    data: {
     source: 'active',
     callData,
     server,
     startTime: startTime ? String(startTime) : undefined,
     endTime: endTime ? String(endTime) : undefined,
     isTraceExpected: true,
    },
    searchedWindow,
   };
  }
 }

 // 2. Active call was not found (completed call) -> search CDRs
 const isResellerOrAbove = options.userRole && ROLE_HIERARCHY[options.userRole] >= ROLE_HIERARCHY.reseller;

 let matchedCdr: Record<string, unknown> | undefined;

 if (isResellerOrAbove) {
  // Reseller and above use /cdrs with orig_callid then term_callid
  let cdrRes = await safe(
   client.request({
    method: 'GET',
    pathTemplate: '/cdrs',
    queryParams: {
     'datetime-start': windowStart,
     'datetime-end': windowEnd,
     orig_callid: callid,
     limit: 10,
    },
   }),
  );
  let records = Array.isArray(cdrRes.data) ? (cdrRes.data as Array<Record<string, unknown>>) : [];
  matchedCdr = records.find((r) => matchesCallId(r, callid));

  if (!matchedCdr) {
   cdrRes = await safe(
    client.request({
     method: 'GET',
     pathTemplate: '/cdrs',
     queryParams: {
      'datetime-start': windowStart,
      'datetime-end': windowEnd,
      term_callid: callid,
      limit: 10,
     },
    }),
   );
   records = Array.isArray(cdrRes.data) ? (cdrRes.data as Array<Record<string, unknown>>) : [];
   matchedCdr = records.find((r) => matchesCallId(r, callid));
  }
 } else {
  // Domain admin and below use /domains/{domain}/cdrs with client-side matching
  const cdrRes = await safe(
   client.request({
    method: 'GET',
    pathTemplate: '/domains/{domain}/cdrs',
    pathParams: { domain },
    queryParams: {
     'datetime-start': windowStart,
     'datetime-end': windowEnd,
     limit: 100,
    },
   }),
  );
  const records = Array.isArray(cdrRes.data) ? (cdrRes.data as Array<Record<string, unknown>>) : [];
  matchedCdr = records.find((r) => matchesCallId(r, callid));
 }

 if (!matchedCdr) {
  return {
   ok: false,
   failure: {
    error: 'Call not found',
    detail: `No active call or CDR found matching call_id "${callid}" in the searched window. Try providing explicit start_time and end_time (or servers).`,
    searchedWindow,
   },
  };
 }

 const server = (matchedCdr['core-server'] ?? matchedCdr['hostname']) as string | undefined;
 if (!server) {
  return {
   ok: false,
   failure: {
    error: 'Core server not found in CDR',
    detail: `Matched CDR record for call_id "${callid}" did not specify core-server or hostname.`,
    searchedWindow,
    callData: matchedCdr,
   },
  };
 }

 const traceExpectedRaw = matchedCdr['is-trace-expected'] ?? matchedCdr['expected_trace'];
 const isTraceExpected = isNsTraceExpected(traceExpectedRaw);

 if (!isTraceExpected) {
  return {
   ok: false,
   failure: {
    error: 'Call trace is not available for this call',
    detail: `Log retention has elapsed (is-trace-expected: "${traceExpectedRaw}"). Detailed SIP logs are no longer available on ${server}.`,
    searchedWindow,
    callData: matchedCdr,
   },
  };
 }

 const startTime = (options.startTime ?? matchedCdr['call-start-datetime'] ?? matchedCdr['time_start']) as string | undefined;
 const endTime = (options.endTime ?? matchedCdr['call-disconnect-datetime'] ?? matchedCdr['time_release']) as string | undefined;

 return {
  ok: true,
  data: {
   source: 'cdr',
   callData: matchedCdr,
   server,
   startTime: startTime ? String(startTime) : undefined,
   endTime: endTime ? String(endTime) : undefined,
   isTraceExpected: true,
  },
  searchedWindow,
 };
}

// ---------------------------------------------------------------------------
// 1. diagnose_call: CDR + SIP trace + queue context in one shot
// ---------------------------------------------------------------------------

const diagnose_call: CuratedTool = {
 minRole: 'domain_admin',
 schema: {
  name: 'diagnose_call',
  description:
   'Diagnose a specific call: pulls the call detail record, SIP trace, and any associated queue context in a single response. ' +
   'Some portal roles cannot read SIP traces; Super User access is confirmed and Reseller access is unverified, but call records are returned for domain administrators. ' +
   'Use when investigating "why did this call do X" rather than running CDR + sipflow + queue lookups separately.',
  inputSchema: {
   type: 'object',
   properties: {
    call_id: { type: 'string', description: 'Call ID or SIP Call-ID' },
    domain: { type: 'string', description: 'Domain name' },
    user: { type: 'string', default: '~', description: 'User extension' },
    servers: { type: 'string', description: 'Core server FQDN handling the call (optional)' },
    start_time: { type: 'string', description: 'Start time window for trace' },
    end_time: { type: 'string', description: 'End time window for trace' },
   },
   required: ['call_id'],
  },
 },
 targets: { domainArg: 'domain', userArg: 'user' },
 output: {
  rules: [
   ...STANDARD_WRAPPER_RULES,
   { path: 'call_id', field: { class: 'metadata' } },
   { path: 'server_used', field: { class: 'metadata' } },
   { path: 'searched_window', field: { class: 'metadata' } },
   { path: 'searched_window.start', field: { class: 'metadata' } },
   { path: 'searched_window.end', field: { class: 'metadata' } },
   { path: 'detail', field: { class: 'metadata' } },
   { path: 'sip_trace.ok', field: { class: 'metadata' } },
   { path: 'sip_trace.error', field: { class: 'metadata' } },
   { path: 'sip_trace.detail', field: { class: 'metadata' } },
   { path: 'sip_trace.data', resource: 'CallTrace' },
   { path: 'cradle_to_grave.ok', field: { class: 'metadata' } },
   { path: 'cradle_to_grave.error', field: { class: 'metadata' } },
   { path: 'cradle_to_grave.detail', field: { class: 'metadata' } },
   { path: 'cradle_to_grave.data', resource: 'CallTrace' },
   { path: 'cdr', resource: 'CdrD' },
   { path: 'active', resource: 'ActiveCall' },
   { path: 'trace', resource: 'CallTrace' },
  ],
 },
 handler: async (args, client, userRole) => {
  const callid = String(args.call_id);
  const domain = str(args.domain);
  const user = str(args.user);

  const lookup = await lookupCallForTrace(
   {
    callId: callid,
    domain,
    user,
    servers: args.servers ? String(args.servers) : undefined,
    startTime: args.start_time ? String(args.start_time) : undefined,
    endTime: args.end_time ? String(args.end_time) : undefined,
    userRole,
   },
   client,
  );

  if (!lookup.ok) {
   return textResult({
    call_id: callid,
    error: lookup.failure.error,
    detail: lookup.failure.detail,
    searched_window: lookup.failure.searchedWindow,
    cdr: lookup.failure.callData,
   });
  }

  const { server, startTime, endTime, callData } = lookup.data;

  const sipflowParams: Record<string, unknown> = {
   callids: callid,
   servers: server,
   type: 'call_trace',
  };
  if (startTime) sipflowParams.start_time = startTime;
  if (endTime) sipflowParams.end_time = endTime;

  const cradleParams: Record<string, unknown> = {
   callids: callid,
   servers: server,
   type: 'cradle_to_grave',
  };
  if (startTime) cradleParams.start_time = startTime;
  if (endTime) cradleParams.end_time = endTime;

  const [sipflow, cradle] = await Promise.all([
   safe(client.request({ method: 'GET', pathTemplate: '/sipflow', queryParams: sipflowParams })),
   safe(client.request({ method: 'GET', pathTemplate: '/sipflow', queryParams: cradleParams })),
  ]);

  const isRoleDenied = (res: { ok: boolean; error?: string }) =>
   !res.ok && Boolean(res.error && /invalid scope|permission denied|insufficient permission|forbidden/i.test(res.error));

  const roleReason =
   'Your portal role cannot read SIP traces. Super User access is confirmed; Reseller access is unverified.';

  const sipflowResult = isRoleDenied(sipflow)
   ? { ok: false, error: sipflow.error, detail: roleReason }
   : sipflow;
  const cradleResult = isRoleDenied(cradle)
   ? { ok: false, error: cradle.error, detail: roleReason }
   : cradle;

  const topDetail = isRoleDenied(sipflow)
   ? 'Call record found, but your portal role cannot read SIP traces (Super User access is confirmed; Reseller access is unverified).'
   : undefined;

  return textResult({
   call_id: callid,
   cdr: callData,
   server_used: server,
   searched_window: lookup.searchedWindow,
   detail: topDetail,
   sip_trace: sipflowResult,
   cradle_to_grave: cradleResult,
  });
 },
};

// ---------------------------------------------------------------------------
// 2. user_profile — one snapshot of a user (details + devices + rules + activity)
// ---------------------------------------------------------------------------

const user_profile: CuratedTool = {
 minRole: 'user',
 schema: {
  name: 'user_profile',
  description:
   'A combined snapshot of a NetSapiens user: basic details, registered devices, answer rules, recent calls, and voicemail count. ' +
   'Useful for "tell me everything about this user" without making five separate calls.',
  inputSchema: {
   type: 'object',
   properties: {
    user: { type: 'string', default: '~', description: 'User extension/login. Defaults to you.' },
    domain: { type: 'string' },
    recent_calls_limit: { type: 'number', default: 10 },
   },
  },
 },
 targets: { domainArg: 'domain', userArg: 'user' },
 output: {
  rules: [
   ...STANDARD_WRAPPER_RULES,
   { path: 'user', field: { class: 'metadata' } },
   { path: 'domain', field: { class: 'metadata' } },
   { path: 'voicemail_count', field: { class: 'metadata' } },
   { path: 'details.ok', field: { class: 'metadata' } },
   { path: 'details.error', field: { class: 'metadata' } },
   { path: 'details.data', resource: 'User' },
   { path: 'devices.ok', field: { class: 'metadata' } },
   { path: 'devices.error', field: { class: 'metadata' } },
   { path: 'devices.data[]', resource: 'Device' },
   { path: 'answer_rules.ok', field: { class: 'metadata' } },
   { path: 'answer_rules.error', field: { class: 'metadata' } },
   { path: 'answer_rules.data[]', resource: 'Answerrule' },
   { path: 'recent_calls.ok', field: { class: 'metadata' } },
   { path: 'recent_calls.error', field: { class: 'metadata' } },
   { path: 'recent_calls.data[]', resource: 'CdrD' },
   { path: 'voicemails.ok', field: { class: 'metadata' } },
   { path: 'voicemails.error', field: { class: 'metadata' } },
   { path: 'voicemails.data[]', resource: 'Voicemail' },
  ],
 },
 handler: async (args, client) => {
  const domain = str(args.domain);
  const user = str(args.user);
  const limit = typeof args.recent_calls_limit === 'number' ? args.recent_calls_limit : 10;
  const [details, devices, answerRules, recentCalls, voicemails] = await Promise.all([
   safe(client.request({ method: 'GET', pathTemplate: '/domains/{domain}/users/{user}', pathParams: { domain, user } })),
   safe(client.request({ method: 'GET', pathTemplate: '/domains/{domain}/users/{user}/devices', pathParams: { domain, user } })),
   safe(client.request({ method: 'GET', pathTemplate: '/domains/{domain}/users/{user}/answerrules', pathParams: { domain, user } })),
   safe(client.request({ method: 'GET', pathTemplate: '/domains/{domain}/users/{user}/cdrs', pathParams: { domain, user }, queryParams: { limit } })),
   safe(client.request({ method: 'GET', pathTemplate: '/domains/{domain}/users/{user}/voicemails/{folder}', pathParams: { domain, user, folder: 'new' } })),
  ]);
  const voicemailCount = Array.isArray(voicemails.data) ? voicemails.data.length : undefined;
  return textResult({
   user,
   domain,
   details,
   devices,
   answer_rules: answerRules,
   recent_calls: recentCalls,
   voicemail_count: voicemailCount,
   voicemails: voicemails.ok ? undefined : voicemails,
  });
 },
};

// ---------------------------------------------------------------------------
// 3. queue_health — every queue annotated with live + recent stats
// ---------------------------------------------------------------------------

const queue_health: CuratedTool = {
 minRole: 'domain_admin',
 schema: {
  name: 'queue_health',
  description:
   'List of all call queues in the domain, each annotated with its current waiting/agents and last-hour stats. ' +
   'One call instead of N+1 (list queues + status-per-queue).',
  inputSchema: {
   type: 'object',
   properties: {
    domain: { type: 'string' },
    max_queues: { type: 'number', default: 25, description: 'Cap the per-queue status fan-out to avoid huge responses.' },
    since: { type: 'string', description: 'Start of statistics window' },
    until: { type: 'string', description: 'End of statistics window' },
    start_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
    end_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
   },
  },
 },
 targets: { domainArg: 'domain' },
 output: {
  rules: [
   ...STANDARD_WRAPPER_RULES,
   { path: 'domain', field: { class: 'metadata' } },
   { path: 'queue_count', field: { class: 'metadata' } },
   { path: 'returned', field: { class: 'metadata' } },
   { path: 'truncated', field: { class: 'metadata' } },
   { path: 'queues[].queue_id', field: { class: 'metadata' } },
   { path: 'queues[].queue', resource: 'CallQueue' },
   { path: 'queues[].status.ok', field: { class: 'metadata' } },
   { path: 'queues[].status.error', field: { class: 'metadata' } },
   { path: 'queues[].status.data', resource: 'QueueStat' },
   { path: 'queues[].status.data[]', resource: 'QueueStat' },
  ],
 },
 handler: async (args, client) => {
  const domain = str(args.domain);
  const cap = typeof args.max_queues === 'number' ? args.max_queues : 25;
  const queuesResp = await safe<Array<Record<string, unknown>>>(
   client.request({ method: 'GET', pathTemplate: '/domains/{domain}/callqueues', pathParams: { domain } }),
  );
  if (!queuesResp.ok) return textResult({ error: 'Failed to list queues', detail: queuesResp.error });
  const queues = Array.isArray(queuesResp.data) ? queuesResp.data : [];
  const limited = queues.slice(0, cap);

  const window = nsDateWindow(args.since ?? args.start_date, args.until ?? args.end_date);

  const annotated = await Promise.all(
   limited.map(async (q) => {
    const queueId = String(q['callqueue'] ?? q['queue'] ?? q['name'] ?? '');
    if (!queueId) return { queue: q, status: { ok: false, error: 'no queue id in record' } };
    const queueDomain = domain === '~' && typeof q['domain'] === 'string' ? q['domain'] : domain;
    const status = await safe(
     client.request({
      method: 'GET',
      pathTemplate: '/domains/{domain}/statistics/callqueues/{queue}',
      pathParams: { domain: queueDomain, queue: queueId },
      queryParams: { start_date: window.start, end_date: window.end },
     }),
    );
    return { queue: q, queue_id: queueId, status };
   }),
  );
  return textResult({
   domain,
   queue_count: queues.length,
   returned: annotated.length,
   truncated: queues.length > cap,
   queues: annotated,
  });
 },
};

// ---------------------------------------------------------------------------
// 4. agent_dashboard — what an agent wants to see about themselves today
// ---------------------------------------------------------------------------

const agent_dashboard: CuratedTool = {
 minRole: 'user',
 schema: {
  name: 'agent_dashboard',
  description:
   'A snapshot of an agent\'s last 24 hours: current queue status (logged in to which queues), recent call activity, and agent statistics. ' +
   'Defaults to the authenticated user.',
  inputSchema: {
   type: 'object',
   properties: {
    agent: { type: 'string', default: '~', description: 'Agent extension. Defaults to you.' },
    domain: { type: 'string' },
    since: { type: 'string', description: 'Start of statistics window' },
    until: { type: 'string', description: 'End of statistics window' },
    start_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
    end_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
   },
  },
 },
 targets: { domainArg: 'domain', agentArg: 'agent' },
 output: {
  rules: [
   ...STANDARD_WRAPPER_RULES,
   { path: 'agent', field: { class: 'metadata' } },
   { path: 'domain', field: { class: 'metadata' } },
   { path: 'status.ok', field: { class: 'metadata' } },
   { path: 'status.error', field: { class: 'metadata' } },
   { path: 'status.data', resource: 'Agent' },
   { path: 'status.data[]', resource: 'Agent' },
   { path: 'recent_calls.ok', field: { class: 'metadata' } },
   { path: 'recent_calls.error', field: { class: 'metadata' } },
   { path: 'recent_calls.data[]', resource: 'CdrD' },
   { path: 'statistics.ok', field: { class: 'metadata' } },
   { path: 'statistics.error', field: { class: 'metadata' } },
   { path: 'statistics.data', resource: 'QueueStat' },
   { path: 'statistics.data[]', resource: 'QueueStat' },
   { path: 'statistics.data.*', resource: 'QueueStat' },
  ],
 },
 handler: async (args, client, userRole) => {
  const domain = str(args.domain);
  // One agent, always: "~" or nothing is the signed-in user, resolved here or the call fails.
  // Every part below (status, statistics, calls) asks about that agent only.
  const agent = args.agent == null || args.agent === '' || args.agent === '~' ? await resolveSelfUser(client) : String(args.agent);
  const isBasicUser = userRole != null && ROLE_HIERARCHY[userRole] < ROLE_HIERARCHY.domain_admin;
  const window = nsDateWindow(args.since ?? args.start_date, args.until ?? args.end_date);

  let statusPromise: Promise<{ ok: boolean; data?: unknown; error?: string }>;
  if (!isBasicUser) {
   statusPromise = (async () => {
    const r = await safe(client.request({
     method: 'GET',
     pathTemplate: '/domains/{domain}/agents',
     pathParams: { domain },
    }));
    if (r.ok && Array.isArray(r.data)) {
     const matched = (r.data as Array<Record<string, unknown>>).filter((a) => {
      const aid = String(a['callqueue-agent-id'] ?? '');
      const login = String(a['login-username'] ?? '');
      return aid === agent || aid.startsWith(`${agent}@`) || login === agent || login.startsWith(`${agent}@`);
     });
     if (matched.length > 0) return { ok: true, data: matched.length === 1 ? matched[0] : matched };
     return { ok: false, error: 'Agent not found' };
    }
    return r;
   })();
  } else {
   statusPromise = (async () => {
    const qList = await safe(client.request({
     method: 'GET',
     pathTemplate: '/domains/{domain}/callqueues/list',
     pathParams: { domain },
    }));
    if (qList.ok && Array.isArray(qList.data)) {
     const queues = qList.data as Array<Record<string, unknown>>;
     const results: Array<Record<string, unknown>> = [];
     for (const q of queues) {
      const qId = String(q['callqueue'] ?? q['queue'] ?? '');
      if (!qId) continue;
      const aRes = await safe(client.request({
       method: 'GET',
       pathTemplate: '/domains/{domain}/callqueues/{queue}/agents/{agent}',
       pathParams: { domain, queue: qId, agent },
      }));
      if (aRes.ok && aRes.data) results.push(aRes.data as Record<string, unknown>);
     }
     return { ok: true, data: results.length === 1 ? results[0] : results };
    }
    return qList;
   })();
  }

  const stats = await safe(client.request({
   method: 'GET',
   pathTemplate: '/domains/{domain}/statistics/agent/{agent}',
   pathParams: { domain, agent },
   queryParams: { start_date: window.start, end_date: window.end },
  }));

  const [status, recentCalls] = await Promise.all([
   statusPromise,
   safe(client.request({ method: 'GET', pathTemplate: '/domains/{domain}/users/{user}/cdrs', pathParams: { domain, user: agent }, queryParams: { limit: 25 } })),
  ]);
  return textResult({ agent, domain, status, recent_calls: recentCalls, statistics: stats });
 },
};

// ---------------------------------------------------------------------------
// 5. switch_queue — atomic logout-from-A + login-to-B with rollback context
// ---------------------------------------------------------------------------

const switch_queue: CuratedTool = {
 minRole: 'user',
 schema: {
  name: 'switch_queue',
  description:
   'Atomically move an agent from one queue to another (logout from `from`, then login to `to`). ' +
   'Returns both call results so partial-failure states are visible.',
  inputSchema: {
   type: 'object',
   properties: {
    from: { type: 'string', description: 'Queue to leave' },
    to: { type: 'string', description: 'Queue to join' },
    agent: { type: 'string', default: '~', description: 'Agent extension. Defaults to you.' },
    domain: { type: 'string' },
   },
   required: ['from', 'to'],
  },
 },
 targets: { domainArg: 'domain', agentArg: 'agent' },
 output: {
  rules: [
   ...STANDARD_WRAPPER_RULES,
   { path: 'step', field: { class: 'metadata' } },
   { path: 'from', field: { class: 'metadata' } },
   { path: 'to', field: { class: 'metadata' } },
   { path: 'agent', field: { class: 'metadata' } },
   { path: 'logout.ok', field: { class: 'metadata' } },
   { path: 'logout.error', field: { class: 'metadata' } },
   { path: 'logout.data', resource: 'Agent' },
   { path: 'login.ok', field: { class: 'metadata' } },
   { path: 'login.error', field: { class: 'metadata' } },
   { path: 'login.data', resource: 'Agent' },
  ],
 },
 handler: async (args, client) => {
  const domain = str(args.domain);
  const from = String(args.from);
  const to = String(args.to);

  const fromRes = await resolveQueueAgent(client, { queue: from, agent: args.agent });
  if (!fromRes.ok) {
   const candidate = (fromRes as any).candidate ?? (fromRes as any).agentId ?? (args.agent ? String(args.agent) : '~');
   return textResult({ ok: false, step: 'resolve', from, to, agent: candidate, note: fromRes.message });
  }

  const toRes = await resolveQueueAgent(client, { queue: to, agent: args.agent });
  if (!toRes.ok) {
   const candidate = (toRes as any).candidate ?? fromRes.agentId ?? (args.agent ? String(args.agent) : '~');
   return textResult({ ok: false, step: 'resolve', from, to, agent: candidate, note: toRes.message });
  }

  const agent = fromRes.agentId;

  const logout = await safe(
   client.request({ method: 'PATCH', pathTemplate: '/domains/{domain}/callqueues/{queue}/agents/{agent}/logout', pathParams: { domain, queue: from, agent } }),
  );
  if (!logout.ok) {
   return textResult({ ok: false, step: 'logout', from, to, agent, logout, note: 'logout from source queue failed; no login attempted' });
  }
  const login = await safe(
   client.request({ method: 'PATCH', pathTemplate: '/domains/{domain}/callqueues/{queue}/agents/{agent}/login', pathParams: { domain, queue: to, agent } }),
  );
  if (!login.ok) {
   return textResult({
    ok: false,
    step: 'login',
    from,
    to,
    agent,
    logout,
    login,
    note: `agent is now LOGGED OUT of ${from} but failed to log into ${to}. Consider re-logging into ${from} or retrying login to ${to}.`,
   });
  }
  return textResult({ ok: true, from, to, agent, logout, login });
 },
};

// ---------------------------------------------------------------------------
// 6. find_and_call — lookup then place_call in one shot
// ---------------------------------------------------------------------------

const find_and_call: CuratedTool = {
 minRole: 'user',
 schema: {
  name: 'find_and_call',
  description:
   'Find a user or contact by name/login/extension/email, then initiate a click-to-call to their extension. ' +
   'If multiple matches exist, returns the candidates without calling so the model can confirm with the user.',
  inputSchema: {
   type: 'object',
   properties: {
    query: { type: 'string' },
    domain: { type: 'string' },
    from: { type: 'string', default: '~', description: 'Your extension. Defaults to you.' },
    confirm: { type: 'boolean', default: false, description: 'If true, place the call even with multiple matches (uses top match).' },
   },
   required: ['query'],
  },
 },
 targets: { domainArg: 'domain', userArg: 'from' },
 output: {
  rules: [
   ...STANDARD_WRAPPER_RULES,
   { path: 'query', field: { class: 'metadata' } },
   { path: 'dialed', field: { class: 'metadata' } },
   { path: 'matches[].source', field: { class: 'metadata' } },
   { path: 'matches[].extension', field: { class: 'metadata' } },
   { path: 'matches[].record.user', field: { class: 'record_id', recordType: 'user' } },
   { path: 'matches[].record', resource: 'Contact' },
   { path: 'matches[].record', resource: 'User' },
   { path: 'match.source', field: { class: 'metadata' } },
   { path: 'match.extension', field: { class: 'metadata' } },
   { path: 'match.record.user', field: { class: 'record_id', recordType: 'user' } },
   { path: 'match.record', resource: 'Contact' },
   { path: 'match.record', resource: 'User' },
   { path: 'call.ok', field: { class: 'metadata' } },
   { path: 'call.error', field: { class: 'metadata' } },
   { path: 'call.data', resource: 'CallRequest' },
  ],
 },
 handler: async (args, client) => {
  const domain = str(args.domain);
  const from = str(args.from);
  const q = String(args.query);
  const confirm = args.confirm === true;

  // Search both users and contacts in parallel. Neither /domains/{domain}/users
  // nor /domains/{domain}/users/{user}/contacts has a server-side name/login/
  // email filter (only limit/start and includeDomain respectively) — the API
  // silently ignores an unrecognized filter param, so fetch broadly and match
  // client-side instead.
  const [users, contacts] = await Promise.all([
   safe<Array<Record<string, unknown>>>(
    client.request({ method: 'GET', pathTemplate: '/domains/{domain}/users', pathParams: { domain }, queryParams: { limit: 1000 } }),
   ),
   safe<Array<Record<string, unknown>>>(
    client.request({ method: 'GET', pathTemplate: '/domains/{domain}/users/~/contacts', pathParams: { domain } }),
   ),
  ]);
  const userMatches = (Array.isArray(users.data) ? users.data : []).filter((u) =>
   fieldsMatch(u, ['user', 'name-first-name', 'name-last-name', 'login-username', 'email'], q),
  );
  const contactMatches = (Array.isArray(contacts.data) ? contacts.data : []).filter(
   (c) =>
    fieldsMatch(c, ['name-first-name', 'name-middle-name', 'name-last-name', 'email', 'company'], q) ||
    numbersMatch(
     [c['phonenumber-work'], c['phonenumber-cell'], c['phonenumber-fax'], c['phonenumber-home']].filter((v) => v != null).join(','),
     q,
    ),
  );

  // Pick an extension out of each candidate
  const candidates: Array<{ source: 'user' | 'contact'; extension?: string; record: Record<string, unknown> }> = [];
  for (const u of userMatches) {
   const ext = String(u['user'] ?? u['extension'] ?? u['name_first_last'] ?? '');
   if (ext) candidates.push({ source: 'user', extension: ext, record: u });
  }
  for (const c of contactMatches) {
   const ext = String(c['extension'] ?? c['number'] ?? c['phone'] ?? '');
   if (ext) candidates.push({ source: 'contact', extension: ext, record: c });
  }

  if (candidates.length === 0) {
   return textResult({ ok: false, query: q, matches: [], note: 'No users or contacts matched.' });
  }
  if (candidates.length > 1 && !confirm) {
   return textResult({
    ok: false,
    query: q,
    matches: candidates,
    note: 'Multiple matches. Re-run with `confirm: true` to call the top match, or specify the exact extension via place_call.',
   });
  }
  const target = candidates[0].extension!;
  const call = await safe(
   client.request({ method: 'POST', pathTemplate: '/domains/{domain}/users/{user}/calls', pathParams: { domain, user: from }, body: { destination: target } }),
  );
  return textResult({ ok: call.ok, query: q, dialed: target, match: candidates[0], call });
 },
};

// ---------------------------------------------------------------------------
// 7. recent_activity_for_number — calls + messages involving a number
// ---------------------------------------------------------------------------

const recent_activity_for_number: CuratedTool = {
 minRole: 'domain_admin',
 schema: {
  name: 'recent_activity_for_number',
  description:
   'All recent activity touching a phone number — inbound + outbound calls plus message sessions. ' +
   'Great for "tell me about this caller" lookups.',
  inputSchema: {
   type: 'object',
   properties: {
    number: { type: 'string', description: 'E.164 or domestic format.' },
    domain: { type: 'string' },
    since: { type: 'string', description: 'ISO date — only activity after this timestamp.' },
    limit: { type: 'number', default: 25 },
   },
   required: ['number'],
  },
 },
 targets: { domainArg: 'domain' },
 output: {
  rules: [
   ...STANDARD_WRAPPER_RULES,
   { path: 'number', field: { class: 'metadata' } },
   { path: 'domain', field: { class: 'metadata' } },
   { path: 'since', field: { class: 'metadata' } },
   { path: 'calls.ok', field: { class: 'metadata' } },
   { path: 'calls.error', field: { class: 'metadata' } },
   { path: 'calls.data[]', resource: 'CdrD' },
   { path: 'message_sessions.ok', field: { class: 'metadata' } },
   { path: 'message_sessions.error', field: { class: 'metadata' } },
   { path: 'message_sessions.data[]', resource: 'Messagesession' },
  ],
 },
 handler: async (args, client) => {
  const domain = str(args.domain);
  const number = String(args.number);
  const since = args.since ? String(args.since) : undefined;
  const limit = typeof args.limit === 'number' ? args.limit : 25;
  // `datetime-start`/`datetime-end` are a REQUIRED PAIR on the CDR search
  // endpoint — sending `datetime-start` alone is silently ignored and
  // returns unbounded history (confirmed against live data). So whenever
  // `since` is given, bound the other end at "now".
  const until = since ? new Date().toISOString() : undefined;
  // The CDR search variant of this endpoint filters on `caller`/`dialled`
  // (partial match) — there's no single param that means "either side of
  // the call", so query both directions and merge.
  const [callsAsCaller, callsAsDialled, messageSessions] = await Promise.all([
   safe<Array<Record<string, unknown>>>(
    client.request({
     method: 'GET',
     pathTemplate: '/domains/{domain}/cdrs',
     pathParams: { domain },
     queryParams: { caller: number, limit, 'datetime-start': since, 'datetime-end': until },
    }),
   ),
   safe<Array<Record<string, unknown>>>(
    client.request({
     method: 'GET',
     pathTemplate: '/domains/{domain}/cdrs',
     pathParams: { domain },
     queryParams: { dialled: number, limit, 'datetime-start': since, 'datetime-end': until },
    }),
   ),
   safe<Array<Record<string, unknown>>>(
    client.request({
     method: 'GET',
     pathTemplate: '/domains/{domain}/messagesessions',
     pathParams: { domain },
     queryParams: { limit: Math.max(limit * 4, 100) },
    }),
   ),
  ]);

  const callsById = new Map<unknown, Record<string, unknown>>();
  for (const batch of [callsAsCaller, callsAsDialled]) {
   if (!batch.ok || !Array.isArray(batch.data)) continue;
   for (const call of batch.data) {
    // Client-side backstop on top of the server-side datetime-start/end
    // bound (see note above on why the server side alone isn't trusted).
    if (since && !isOnOrAfter(call['call-start-datetime'] ?? call['call-answer-datetime'], since)) continue;
    callsById.set(call.id ?? JSON.stringify(call), call);
   }
  }
  const calls = {
   ok: callsAsCaller.ok || callsAsDialled.ok,
   error: callsAsCaller.ok || callsAsDialled.ok ? undefined : (callsAsCaller.error ?? callsAsDialled.error),
   data: Array.from(callsById.values()).slice(0, limit),
  };

  const matchesNumber = (session: Record<string, unknown>) => {
   const haystack = [session['messagesession-remote'], session['messagesession-sms-number'], session['messagesession-participants']]
    .filter((v) => v != null)
    .map(String)
    .join(',');
   return numbersMatch(haystack, number);
  };
  const filteredSessions = messageSessions.ok && Array.isArray(messageSessions.data)
   ? messageSessions.data
    .filter(matchesNumber)
    .filter((s) => !since || isOnOrAfter(s['messagesession-last-timestamp'] ?? s['messagesession-start-timestamp'], since))
    .slice(0, limit)
   : messageSessions.data;
  return textResult({
   number,
   domain,
   since,
   calls,
   message_sessions: { ok: messageSessions.ok, error: messageSessions.error, data: filteredSessions },
  });
 },
};

// ---------------------------------------------------------------------------
// 8. voicemail_inbox_summary: new VMs with caller + transcript condensed
// ---------------------------------------------------------------------------

function normalizeVoicemailFolder(raw?: unknown): 'new' | 'save' | 'trash' | undefined {
 if (typeof raw !== 'string') return undefined;
 const f = raw.toLowerCase().trim();
 if (f === 'new' || f === 'inbox') return 'new';
 if (f === 'save' || f === 'saved') return 'save';
 if (f === 'trash' || f === 'deleted') return 'trash';
 return f as 'new' | 'save' | 'trash';
}

const voicemail_inbox_summary: CuratedTool = {
 minRole: 'user',
 schema: {
  name: 'voicemail_inbox_summary',
  description:
   'Condensed summary of new voicemails: one line per VM with caller, time, duration, transcript snippet (when available), and transcription status. ' +
   'Far less noise than listing the full voicemail records.',
  inputSchema: {
   type: 'object',
   properties: {
    limit: { type: 'number', default: 25 },
    folder: { type: 'string', default: 'new', description: 'Voicemail folder: "new" (inbox), "save" (saved), or "trash". Defaults to "new".' },
   },
  },
 },
 targets: { selfOnly: true },
 output: {
  rules: [
   ...STANDARD_WRAPPER_RULES,
   { path: 'folder', field: { class: 'metadata' } },
   { path: 'count', field: { class: 'metadata' } },
   { path: 'voicemails[].from', field: { class: 'metadata' } },
   { path: 'voicemails[].at', field: { class: 'metadata' } },
   { path: 'voicemails[].duration', field: { class: 'metadata' } },
   { path: 'voicemails[].id', field: { class: 'record_id', recordType: 'voicemail' } },
   { path: 'voicemails[].transcript', field: { class: 'content', kind: 'transcript', media: 'text' } },
   { path: 'voicemails[].transcription_status', field: { class: 'metadata' } },
   { path: 'voicemails[]', resource: 'Voicemail' },
  ],
 },
 handler: async (args, client, userRole) => {
  const limit = typeof args.limit === 'number' ? args.limit : 25;
  const folder = normalizeVoicemailFolder(args.folder) ?? 'new';
  const list = await safe<Array<Record<string, unknown>>>(
   client.request({
    method: 'GET',
    pathTemplate: '/domains/~/users/~/voicemails/{folder}',
    pathParams: { folder },
    queryParams: { limit },
   }),
  );
  if (!list.ok) return textResult({ error: 'Failed to list voicemails', detail: list.error });
  const rawItems = Array.isArray(list.data) ? list.data : [];
  const items = rawItems.slice(0, limit);
  await attachVoicemailTranscripts(client, items, userRole);
  const summary = items.map((vm) => {
   const caller = String(vm['voicemail-from-caller-id-number'] ?? vm['caller-id-number'] ?? vm['from'] ?? vm['caller'] ?? '');
   const callerName = String(vm['voicemail-from-name'] ?? vm['caller-id-name'] ?? vm['from-name'] ?? '');
   const at = String(vm['recorded-datetime'] ?? vm['created-datetime'] ?? vm['datetime'] ?? vm['time-received'] ?? vm['received'] ?? '');
   const dur = vm['file-duration-seconds'] ?? vm['duration'] ?? vm['length'] ?? '';
   const transcriptRaw = String(vm['transcription'] ?? vm['transcription-text'] ?? vm['transcript'] ?? '');
   const transcript = transcriptRaw ? (transcriptRaw.length > 200 ? transcriptRaw.slice(0, 200) + '…' : transcriptRaw) : undefined;
   const transcription_status = (vm['transcription-status'] as string) ?? (transcript ? 'finished' : 'unavailable');
   return {
    from: callerName ? (caller ? `${callerName} <${caller}>` : callerName) : caller,
    at,
    duration: dur,
    transcript,
    transcription_status,
    id: vm['filename'] ?? vm['id'] ?? vm['message-id'],
   };
  });
  return textResult({ folder, count: summary.length, voicemails: summary });
 },
};

// ---------------------------------------------------------------------------
// 9. schedule_forwarding — set an answer rule that forwards calls
// ---------------------------------------------------------------------------

/**
 * NS timeframes take compact dates and times: `YYYYMMDD` and `HHMM`. Models
 * typically emit ISO strings, "YYYY-MM-DD", or natural-ish combinations.
 * Accepts ISO, "YYYY-MM-DD", or "YYYY-MM-DD HH:MM".
 */
export function toNsDateTime(
 value: unknown,
 defaultTime: string,
): { date: string; time: string } | null {
 const raw = String(value ?? '').trim();
 if (!raw) return null;
 const m = raw.match(/^(\d{4})-?(\d{2})-?(\d{2})(?:[T\s]+(\d{2}):?(\d{2}))?/);
 if (!m) return null;
 const [, y, mo, d, hh, mm] = m;
 return { date: `${y}${mo}${d}`, time: hh ? `${hh}${mm}` : defaultTime };
}

function forwardAlways(destination: string | undefined, enabled: boolean) {
 return {
  'forward-always': {
   enabled: enabled ? 'yes' : 'no',
   parameters: enabled && destination ? [destination] : [],
  },
 };
}

const schedule_forwarding: CuratedTool = {
 minRole: 'user',
 title: 'Schedule Forwarding',
 schema: {
  name: 'schedule_forwarding',
  description:
   'Forward your incoming calls to a destination. Without dates this sets the standing "always" answer rule. ' +
   'Give `until` (and optionally `from`) for time-bounded forwarding — "forward to my cell until Friday 5pm" — and this creates the date-range time-frame and the answer rule pointed at it, which NetSapiens treats as two separate operations. ' +
   'Pass `disable: true` to clear the standing rule.',
  inputSchema: {
   type: 'object',
   properties: {
    destination: { type: 'string', description: 'Number or extension to forward to.' },
    disable: { type: 'boolean', default: false, description: 'If true, clear the always-forward rule.' },
    timeframe: { type: 'string', description: 'Answer-rule time-frame to modify. Defaults to "Default" (the standing rule), or to a generated name when from/until are given.' },
    from: { type: 'string', description: 'Start of the forwarding window, "YYYY-MM-DD" or "YYYY-MM-DD HH:MM". Defaults to today at 00:00 when `until` is given.' },
    until: { type: 'string', description: 'End of the forwarding window, "YYYY-MM-DD" or "YYYY-MM-DD HH:MM". Supplying this switches to time-bounded forwarding.' },
   },
  },
 },
 targets: { selfOnly: true },
 output: {
  rules: [
   ...STANDARD_WRAPPER_RULES,
   { path: 'timeframe', field: { class: 'metadata' } },
   { path: 'destination', field: { class: 'metadata' } },
   { path: 'window.from', field: { class: 'metadata' } },
   { path: 'window.until', field: { class: 'metadata' } },
   { path: 'steps[].step', field: { class: 'metadata' } },
   { path: 'steps[].ok', field: { class: 'metadata' } },
   { path: 'steps[].error', field: { class: 'metadata' } },
   { path: 'result.ok', field: { class: 'metadata' } },
   { path: 'result.error', field: { class: 'metadata' } },
   { path: 'result.data', resource: 'Answerrule' },
  ],
 },
 handler: async (args, client) => {
  const disable = args.disable === true;
  const destination = args.destination ? String(args.destination) : undefined;
  if (!disable && !destination) {
   return textResult({ error: 'Either destination or disable=true is required.' });
  }

  // ----- Time-bounded: build the window first, then point a rule at it -----
  if (args.until && !disable) {
   const end = toNsDateTime(args.until, '2359');
   if (!end) {
    return textResult({ error: `Could not read \`until\` ("${String(args.until)}"). Use YYYY-MM-DD or YYYY-MM-DD HH:MM.` });
   }
   const today = new Date();
   const isoToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
   const start = toNsDateTime(args.from ?? isoToday, '0000');
   if (!start) {
    return textResult({ error: `Could not read \`from\` ("${String(args.from)}"). Use YYYY-MM-DD or YYYY-MM-DD HH:MM.` });
   }

   const name = args.timeframe ? String(args.timeframe) : `Forwarding ${start.date}-${end.date}`;
   const steps: Array<{ step: string; ok: boolean; error?: string }> = [];

   const tf = await safe(client.request({
    method: 'POST',
    pathTemplate: '/domains/~/users/~/timeframes',
    body: {
     synchronous: 'yes',
     'timeframe-name': name,
     'timeframe-type': 'specific-dates',
     'timeframe-specific-dates-array': [{
      'timeframe-specific-dates-begin-date': start.date,
      'timeframe-specific-dates-begin-time': start.time,
      'timeframe-specific-dates-end-date': end.date,
      'timeframe-specific-dates-end-time': end.time,
      'timeframe-recurrence-type': 'doesNotRecur',
     }],
    },
   }));
   steps.push({ step: `create time-frame "${name}"`, ok: tf.ok, error: tf.error });

   // An answer rule pointed at a time-frame that does not exist would apply
   // never, and would read as success. Stop instead.
   if (!tf.ok) {
    return textResult({
     ok: false,
     steps,
     note: 'Time-frame creation failed, so no answer rule was created. Nothing was changed.',
    });
   }

   const rule = await safe(client.request({
    method: 'POST',
    pathTemplate: '/domains/~/users/~/answerrules',
    body: {
     synchronous: 'yes',
     'time-frame': name,
     enabled: 'yes',
     ...forwardAlways(destination, true),
    },
   }));
   steps.push({ step: `forward to ${destination} during "${name}"`, ok: rule.ok, error: rule.error });

   return textResult({
    ok: steps.every((s) => s.ok),
    timeframe: name,
    window: { from: `${start.date} ${start.time}`, until: `${end.date} ${end.time}` },
    destination,
    steps,
    note: 'The time-frame is reusable — pass its name as `timeframe` to point more answer rules at the same window.',
   });
  }

  // ----- Standing rule -----
  const timeframe = String(args.timeframe ?? 'Default');
  const r = await safe(
   client.request({
    method: 'PUT',
    pathTemplate: '/domains/~/users/~/answerrules/{timeframe}',
    pathParams: { timeframe },
    body: { enabled: 'yes', ...forwardAlways(destination, !disable) },
   }),
  );
  return textResult({
   ok: r.ok,
   timeframe,
   destination: disable ? null : destination,
   result: r,
  });
 },
};

// ---------------------------------------------------------------------------
// 10. provision_user — the "add a user" chain, not just the subscriber row
// ---------------------------------------------------------------------------

const provision_user: CuratedTool = {
 minRole: 'domain_admin',
 title: 'Provision User',
 schema: {
  name: 'provision_user',
  description:
   'Create a user and the pieces that make them usable: the user record, optionally a device to register a phone against, and optionally a DID routed to them. ' +
   'Creating a user on its own leaves them with no device and no outside number — this runs the full sequence and reports what is still unconfigured. ' +
   'Writes are synchronous, so each step is readable before the next one runs.',
  inputSchema: {
   type: 'object',
   properties: {
    domain: { type: 'string', description: 'Domain to create the user in. Defaults to your own.' },
    user: { type: 'string', description: 'Extension / user id, e.g. "1001".' },
    first_name: { type: 'string' },
    last_name: { type: 'string' },
    email: { type: 'string' },
    scope: {
     type: 'string',
     description: 'NS user scope. Defaults to "Basic User".',
     enum: ['Basic User', 'Simple User', 'Advanced User', 'Call Center Agent', 'Site Manager', 'Call Center Supervisor', 'Office Manager', 'Reseller', 'Super User', 'NDP', 'No Portal'],
     default: 'Basic User',
    },
    device: { type: 'string', description: 'Optional device / SIP registration name to create for the user, e.g. "1001a".' },
    device_password: { type: 'string', description: 'Optional SIP registration password for the new device.' },
    phone_number: { type: 'string', description: 'Optional DID to route to this user.' },
    site: { type: 'string', description: 'Optional site to place the user in.' },
    department: { type: 'string', description: 'Optional department.' },
   },
   required: ['user', 'first_name', 'last_name', 'email'],
  },
 },
 targets: { domainArg: 'domain', userArg: 'user' },
 output: {
  rules: [
   ...STANDARD_WRAPPER_RULES,
   { path: 'user', field: { class: 'metadata' } },
   { path: 'still_unconfigured[]', field: { class: 'metadata' } },
   { path: 'steps[].step', field: { class: 'metadata' } },
   { path: 'steps[].ok', field: { class: 'metadata' } },
   { path: 'steps[].error', field: { class: 'metadata' } },
   { path: 'steps[].detail.device', field: { class: 'record_id', recordType: 'device' } },
   { path: 'steps[].detail.phonenumber', field: { class: 'record_id', recordType: 'phonenumber' } },
   { path: 'steps[].detail.user', field: { class: 'record_id', recordType: 'user' } },
   { path: 'steps[].detail', resource: 'User' },
   { path: 'steps[].detail', resource: 'Device' },
   { path: 'steps[].detail', resource: 'Phonenumber' },
   { path: 'user_record', resource: 'User' },
   { path: 'user_record.error', field: { class: 'metadata' } },
  ],
 },
 handler: async (args, client) => {
  const domain = str(args.domain);
  const user = String(args.user);
  const steps: Array<{ step: string; ok: boolean; detail?: unknown; error?: string }> = [];

  const created = await safe(client.request({
   method: 'POST',
   pathTemplate: '/domains/{domain}/users',
   pathParams: { domain },
   body: {
    synchronous: 'yes',
    user,
    'name-first-name': String(args.first_name),
    'name-last-name': String(args.last_name),
    email: String(args.email),
    'user-scope': str(args.scope, 'Basic User'),
    ...(args.site ? { site: String(args.site) } : {}),
    ...(args.department ? { department: String(args.department) } : {}),
   },
  }));
  steps.push({ step: 'create user', ok: created.ok, detail: created.data, error: created.error });

  // A failed user create makes every later step meaningless, and retrying
  // the whole tool is cleaner than leaving a device orphaned on a user that
  // does not exist.
  if (!created.ok) {
   return textResult({
    ok: false,
    user: `${user}@${domain}`,
    steps,
    note: 'User creation failed; no device or phone number was created.',
   });
  }

  if (args.device) {
   const device = await safe(client.request({
    method: 'POST',
    pathTemplate: '/domains/{domain}/users/{user}/devices',
    pathParams: { domain, user },
    body: {
     synchronous: 'yes',
     device: String(args.device),
     ...(args.device_password ? { 'device-sip-registration-password': String(args.device_password) } : {}),
    },
   }));
   steps.push({ step: 'create device', ok: device.ok, detail: device.data, error: device.error });
  }

  if (args.phone_number) {
   const did = await safe(client.request({
    method: 'POST',
    pathTemplate: '/domains/{domain}/phonenumbers',
    pathParams: { domain },
    body: {
     phonenumber: String(args.phone_number),
     'dial-rule-translation-destination-user': user,
     enabled: 'yes',
    },
   }));
   steps.push({ step: 'assign phone number', ok: did.ok, detail: did.data, error: did.error });
  }

  const verify = await safe(client.request({
   method: 'GET',
   pathTemplate: '/domains/{domain}/users/{user}',
   pathParams: { domain, user },
  }));

  const missing: string[] = [];
  if (!args.device) missing.push('no device — the user cannot register a phone until one is created');
  if (!args.phone_number) missing.push('no DID — the user cannot receive outside calls until a number is routed to them');

  return textResult({
   ok: steps.every((s) => s.ok),
   user: `${user}@${domain}`,
   steps,
   user_record: verify.ok ? verify.data : { error: verify.error },
   still_unconfigured: missing,
  });
 },
};

// ---------------------------------------------------------------------------
// 11. deprovision_user — delete, then clean up what the platform leaves behind
// ---------------------------------------------------------------------------

const deprovision_user: CuratedTool = {
 minRole: 'domain_admin',
 title: 'Deprovision User',
 destructive: true,
 schema: {
  name: 'deprovision_user',
  description:
   'Remove a user completely: deletes the user (which cascades to their devices, contacts, addresses, timeframes and voicemail), then removes the two things NetSapiens leaves behind — DIDs still routed to them, and their call queue agent memberships. ' +
   'Deleting a user through the plain endpoint leaves those DIDs pointing at a destination that no longer exists. ' +
   'Pass dry_run to see exactly what would be removed without touching anything.',
  inputSchema: {
   type: 'object',
   properties: {
    domain: { type: 'string', description: 'Domain the user lives in. Defaults to your own.' },
    user: { type: 'string', description: 'Extension / user id to remove.' },
    dry_run: { type: 'boolean', default: false, description: 'Report what would be removed, change nothing.' },
   },
   required: ['user'],
  },
 },
 targets: { domainArg: 'domain', userArg: 'user' },
 output: {
  rules: [
   ...STANDARD_WRAPPER_RULES,
   { path: 'dry_run', field: { class: 'metadata' } },
   { path: 'user', field: { class: 'metadata' } },
   { path: 'cascaded_by_netsapiens[]', field: { class: 'metadata' } },
   { path: 'inventory_warnings[]', field: { class: 'metadata' } },
   { path: 'steps[].step', field: { class: 'metadata' } },
   { path: 'steps[].ok', field: { class: 'metadata' } },
   { path: 'steps[].error', field: { class: 'metadata' } },
   { path: 'plan.user', field: { class: 'metadata' } },
   { path: 'plan.deletes_user', field: { class: 'metadata' } },
   { path: 'plan.cascaded_by_netsapiens[]', field: { class: 'metadata' } },
   { path: 'plan.phone_numbers_to_release[]', field: { class: 'metadata' } },
   { path: 'plan.queue_memberships_to_remove[].queue', field: { class: 'metadata' } },
   { path: 'plan.queue_memberships_to_remove[].agent_id', field: { class: 'metadata' } },
  ],
 },
 handler: async (args, client) => {
  const domain = str(args.domain);
  const user = String(args.user);
  const uid = `${user}@${domain}`;
  const dryRun = args.dry_run === true;

  const [numbers, agents] = await Promise.all([
   safe(client.request({ method: 'GET', pathTemplate: '/domains/{domain}/phonenumbers', pathParams: { domain } })),
   safe(client.request({ method: 'GET', pathTemplate: '/domains/{domain}/agents', pathParams: { domain } })),
  ]);

  const numberRows = Array.isArray(numbers.data) ? (numbers.data as Array<Record<string, unknown>>) : [];
  const orphanNumbers = numberRows.filter((n) => {
   const dest = String(n['dial-rule-translation-destination-user'] ?? '');
   return dest === user || dest === uid;
  });

  const agentRows = Array.isArray(agents.data) ? (agents.data as Array<Record<string, unknown>>) : [];
  const agentMemberships = agentRows.filter((a) => {
   const id = String(a['callqueue-agent-id'] ?? '');
   return id === uid || id.startsWith(`${uid}:`);
  });

  const plan = {
   user: uid,
   deletes_user: true,
   cascaded_by_netsapiens: ['devices', 'contacts', 'addresses', 'timeframes', 'voicemail nags', 'cdr schedules', 'callqueue email reports', 'MFA enrollment'],
   phone_numbers_to_release: orphanNumbers.map((n) => n.phonenumber),
   queue_memberships_to_remove: agentMemberships.map((a) => ({ queue: a.callqueue, agent_id: a['callqueue-agent-id'] })),
  };

  if (dryRun) {
   return textResult({ dry_run: true, plan });
  }

  const steps: Array<{ step: string; ok: boolean; error?: string }> = [];

  const deleted = await safe(client.request({
   method: 'DELETE',
   pathTemplate: '/domains/{domain}/users/{user}',
   pathParams: { domain, user },
  }));
  steps.push({ step: `delete user ${uid}`, ok: deleted.ok, error: deleted.error });

  for (const n of orphanNumbers) {
   const phonenumber = String(n.phonenumber);
   const r = await safe(client.request({
    method: 'DELETE',
    pathTemplate: '/domains/{domain}/phonenumbers/{phonenumber}',
    pathParams: { domain, phonenumber },
   }));
   steps.push({ step: `release phone number ${phonenumber}`, ok: r.ok, error: r.error });
  }

  for (const a of agentMemberships) {
   const callqueue = String(a.callqueue);
   const agentId = String(a['callqueue-agent-id']);
   const r = await safe(client.request({
    method: 'DELETE',
    pathTemplate: '/domains/{domain}/callqueues/{callqueue}/agents/{callqueue-agent-id}',
    pathParams: { domain, callqueue, 'callqueue-agent-id': agentId },
   }));
   steps.push({ step: `remove ${agentId} from queue ${callqueue}`, ok: r.ok, error: r.error });
  }

  return textResult({
   ok: steps.every((s) => s.ok),
   user: uid,
   steps,
   cascaded_by_netsapiens: plan.cascaded_by_netsapiens,
   inventory_warnings: [
    ...(numbers.ok ? [] : [`could not list phone numbers (${numbers.error}), any DIDs routed to this user may still exist`]),
    ...(agents.ok ? [] : [`could not list queue agents (${agents.error}), queue memberships may still exist`]),
   ],
  });
 },
};

// ---------------------------------------------------------------------------
// 12. provision_call_queue — a queue with nobody in it answers nothing
// ---------------------------------------------------------------------------

function toUid(value: unknown, domain: string): string {
 const raw = String(value);
 return raw.includes('@') ? raw : `${raw}@${domain}`;
}

const provision_call_queue: CuratedTool = {
 minRole: 'domain_admin',
 title: 'Provision Call Queue',
 schema: {
  name: 'provision_call_queue',
  description:
   'Create a call queue and staff it: the queue itself, its agents, and optionally a DID routed to it. ' +
   'Creating a queue on its own leaves it with no agents (so nothing answers) and no number (so nobody can reach it) — this runs the whole sequence and reports what is still missing.',
  inputSchema: {
   type: 'object',
   properties: {
    domain: { type: 'string', description: 'Domain to create the queue in. Defaults to your own.' },
    callqueue: { type: 'string', description: 'Queue name / extension, e.g. "support" or "2000".' },
    agents: {
     type: 'array',
     items: { type: 'string' },
     description: 'Users to staff the queue. Accepts "1001" or "1001@domain".',
    },
    phone_number: { type: 'string', description: 'Optional DID to route to this queue.' },
    description: { type: 'string', description: 'Queue description. NetSapiens requires one; defaults to the queue name.' },
   },
   required: ['callqueue'],
  },
 },
 targets: { domainArg: 'domain' },
 output: {
  rules: [
   ...STANDARD_WRAPPER_RULES,
   { path: 'callqueue', field: { class: 'metadata' } },
   { path: 'agents_added[]', field: { class: 'metadata' } },
   { path: 'still_unconfigured[]', field: { class: 'metadata' } },
   { path: 'steps[].step', field: { class: 'metadata' } },
   { path: 'steps[].ok', field: { class: 'metadata' } },
   { path: 'steps[].error', field: { class: 'metadata' } },
   { path: 'steps[].detail', resource: 'CallQueue' },
  ],
 },
 handler: async (args, client) => {
  const domain = str(args.domain);
  const callqueue = String(args.callqueue);
  const agents = Array.isArray(args.agents) ? args.agents : [];
  const steps: Array<{ step: string; ok: boolean; detail?: unknown; error?: string }> = [];

  const created = await safe(client.request({
   method: 'POST',
   pathTemplate: '/domains/{domain}/callqueues',
   pathParams: { domain },
   body: {
    synchronous: 'yes',
    callqueue,
    domain,
    description: args.description ? String(args.description) : callqueue,
   },
  }));
  steps.push({ step: `create queue ${callqueue}`, ok: created.ok, detail: created.data, error: created.error });

  if (!created.ok) {
   return textResult({
    ok: false,
    callqueue: `${callqueue}@${domain}`,
    steps,
    note: 'Queue creation failed; no agents were added and no number was assigned.',
   });
  }

  for (const a of agents) {
   const agentId = toUid(a, domain);
   const r = await safe(client.request({
    method: 'POST',
    pathTemplate: '/domains/{domain}/callqueues/{callqueue}/agents',
    pathParams: { domain, callqueue },
    body: { 'callqueue-agent-id': agentId },
   }));
   steps.push({ step: `add agent ${agentId}`, ok: r.ok, error: r.error });
  }

  if (args.phone_number) {
   const did = await safe(client.request({
    method: 'POST',
    pathTemplate: '/domains/{domain}/phonenumbers',
    pathParams: { domain },
    body: {
     phonenumber: String(args.phone_number),
     'dial-rule-translation-destination-user': callqueue,
     enabled: 'yes',
    },
   }));
   steps.push({ step: `route ${String(args.phone_number)} to the queue`, ok: did.ok, error: did.error });
  }

  const missing: string[] = [];
  if (agents.length === 0) missing.push('no agents: calls will queue with nobody to answer them');
  if (!args.phone_number) missing.push('no DID: outside callers cannot reach this queue directly');

  return textResult({
   ok: steps.every((s) => s.ok),
   callqueue: `${callqueue}@${domain}`,
   agents_added: agents.map((a) => toUid(a, domain)),
   steps,
   still_unconfigured: missing,
  });
 },
};

// ---------------------------------------------------------------------------
// 13. deprovision_call_queue — same orphan problem as users
// ---------------------------------------------------------------------------

const deprovision_call_queue: CuratedTool = {
 minRole: 'domain_admin',
 title: 'Deprovision Call Queue',
 destructive: true,
 schema: {
  name: 'deprovision_call_queue',
  description:
   'Remove a call queue completely: deletes the queue, then removes the two things NetSapiens leaves behind — the agent memberships and any DID still routed to the queue. ' +
   'Deleting a queue through the plain endpoint orphans both. Pass dry_run to see what would be removed without touching anything.',
  inputSchema: {
   type: 'object',
   properties: {
    domain: { type: 'string', description: 'Domain the queue lives in. Defaults to your own.' },
    callqueue: { type: 'string', description: 'Queue name / extension to remove.' },
    dry_run: { type: 'boolean', default: false, description: 'Report what would be removed, change nothing.' },
   },
   required: ['callqueue'],
  },
 },
 targets: { domainArg: 'domain' },
 output: {
  rules: [
   ...STANDARD_WRAPPER_RULES,
   { path: 'dry_run', field: { class: 'metadata' } },
   { path: 'callqueue', field: { class: 'metadata' } },
   { path: 'inventory_warnings[]', field: { class: 'metadata' } },
   { path: 'steps[].step', field: { class: 'metadata' } },
   { path: 'steps[].ok', field: { class: 'metadata' } },
   { path: 'steps[].error', field: { class: 'metadata' } },
   { path: 'plan.callqueue', field: { class: 'metadata' } },
   { path: 'plan.deletes_queue', field: { class: 'metadata' } },
   { path: 'plan.agents_to_remove[]', field: { class: 'metadata' } },
   { path: 'plan.phone_numbers_to_release[]', field: { class: 'metadata' } },
  ],
 },
 handler: async (args, client) => {
  const domain = str(args.domain);
  const callqueue = String(args.callqueue);
  const dryRun = args.dry_run === true;

  const [agents, numbers] = await Promise.all([
   safe(client.request({
    method: 'GET',
    pathTemplate: '/domains/{domain}/callqueues/{callqueue}/agents',
    pathParams: { domain, callqueue },
   })),
   safe(client.request({ method: 'GET', pathTemplate: '/domains/{domain}/phonenumbers', pathParams: { domain } })),
  ]);

  const agentRows = Array.isArray(agents.data) ? (agents.data as Array<Record<string, unknown>>) : [];
  const numberRows = Array.isArray(numbers.data) ? (numbers.data as Array<Record<string, unknown>>) : [];
  const orphanNumbers = numberRows.filter((n) => {
   const dest = String(n['dial-rule-translation-destination-user'] ?? '');
   return dest === callqueue || dest === `${callqueue}@${domain}`;
  });

  const plan = {
   callqueue: `${callqueue}@${domain}`,
   deletes_queue: true,
   agents_to_remove: agentRows.map((a) => a['callqueue-agent-id']),
   phone_numbers_to_release: orphanNumbers.map((n) => n.phonenumber),
  };

  if (dryRun) return textResult({ dry_run: true, plan });

  const steps: Array<{ step: string; ok: boolean; error?: string }> = [];

  for (const a of agentRows) {
   const agentId = String(a['callqueue-agent-id']);
   const r = await safe(client.request({
    method: 'DELETE',
    pathTemplate: '/domains/{domain}/callqueues/{callqueue}/agents/{callqueue-agent-id}',
    pathParams: { domain, callqueue, 'callqueue-agent-id': agentId },
   }));
   steps.push({ step: `remove agent ${agentId}`, ok: r.ok, error: r.error });
  }

  const deleted = await safe(client.request({
   method: 'DELETE',
   pathTemplate: '/domains/{domain}/callqueues/{callqueue}',
   pathParams: { domain, callqueue },
  }));
  steps.push({ step: `delete queue ${callqueue}`, ok: deleted.ok, error: deleted.error });

  for (const n of orphanNumbers) {
   const phonenumber = String(n.phonenumber);
   const r = await safe(client.request({
    method: 'DELETE',
    pathTemplate: '/domains/{domain}/phonenumbers/{phonenumber}',
    pathParams: { domain, phonenumber },
   }));
   steps.push({ step: `release phone number ${phonenumber}`, ok: r.ok, error: r.error });
  }

  return textResult({
   ok: steps.every((s) => s.ok),
   callqueue: `${callqueue}@${domain}`,
   steps,
   inventory_warnings: [
    ...(agents.ok ? [] : [`could not list queue agents (${agents.error}), memberships may still exist`]),
    ...(numbers.ok ? [] : [`could not list phone numbers (${numbers.error}), DIDs routed here may still exist`]),
   ],
  });
 },
};

// ---------------------------------------------------------------------------
// 14. set_hold_message: upload audio for hold message
// ---------------------------------------------------------------------------

const set_hold_message: CuratedTool = {
 minRole: 'domain_admin',
 title: 'Set Hold Message',
 schema: {
  name: 'set_hold_message',
  description:
   'Upload a hold message (the announcement played over music on hold) for a domain or a single user. ' +
   'Unlike greetings and music-on-hold, NetSapiens offers no text-to-speech option here — the audio has to be uploaded, so pass it as base64. ' +
   'Supply `index` to replace an existing message, or omit it to add a new one.',
  inputSchema: {
   type: 'object',
   properties: {
    audio_base64: { type: 'string', description: 'The audio file, base64 encoded. WAV or MP3.' },
    filename: { type: 'string', default: 'hold-message.wav', description: 'Filename to send with the upload.' },
    domain: { type: 'string', description: 'Domain the message belongs to. Defaults to your own.' },
    user: { type: 'string', description: 'Set for one user only. Omit for a domain-wide hold message.' },
    index: { type: 'number', description: 'Existing message index to replace. Omit to add a new one.' },
   },
   required: ['audio_base64'],
  },
 },
 targets: { domainArg: 'domain', userArg: 'user' },
 output: {
  rules: [
   ...STANDARD_WRAPPER_RULES,
   { path: 'scope', field: { class: 'metadata' } },
   { path: 'action', field: { class: 'metadata' } },
   { path: 'filename', field: { class: 'metadata' } },
   { path: 'result.ok', field: { class: 'metadata' } },
   { path: 'result.error', field: { class: 'metadata' } },
   { path: 'result.data', resource: 'Audiofile' },
  ],
 },
 handler: async (args, client) => {
  const domain = str(args.domain);
  const audio = String(args.audio_base64 ?? '');
  if (!audio) return textResult({ error: 'audio_base64 is required.' });

  const filename = str(args.filename, 'hold-message.wav');
  const contentType = /\.mp3$/i.test(filename) ? 'audio/mpeg' : 'audio/wav';
  const scoped = args.user != null && args.user !== '';
  const replacing = args.index != null && args.index !== '';

  const pathTemplate = scoped
   ? replacing
    ? '/domains/{domain}/users/{user}/msg/{index}'
    : '/domains/{domain}/users/{user}/msg'
   : replacing
    ? '/domains/{domain}/msg/{index}'
    : '/domains/{domain}/msg';

  const pathParams: Record<string, string> = { domain };
  if (scoped) pathParams.user = String(args.user);
  if (replacing) pathParams.index = String(args.index);

  const r = await safe(client.request({
   method: replacing ? 'PUT' : 'POST',
   pathTemplate,
   pathParams,
   multipart: { field: 'File', filename, base64: audio, contentType },
  }));

  return textResult({
   ok: r.ok,
   scope: scoped ? `${String(args.user)}@${domain}` : domain,
   action: replacing ? `replaced index ${String(args.index)}` : 'added a new hold message',
   filename,
   result: r,
  });
 },
};

// ---------------------------------------------------------------------------

export const WORKFLOW_TOOLS: CuratedTool[] = [
 diagnose_call,
 user_profile,
 queue_health,
 agent_dashboard,
 switch_queue,
 find_and_call,
 recent_activity_for_number,
 voicemail_inbox_summary,
 schedule_forwarding,
 provision_user,
 deprovision_user,
 provision_call_queue,
 deprovision_call_queue,
 set_hold_message,
];
