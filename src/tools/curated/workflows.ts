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
import { textResult } from './types.js';
import type { GenericApiClient, NetSapiensApiResponse } from '../../generated/types.js';

const str = (v: unknown, dflt = '~') => (v == null || v === '' ? dflt : String(v));

/** Compare phone numbers loosely: strip everything but digits and match on the trailing 10 (NANP), so E.164 vs domestic formatting doesn't break equality. */
function numbersMatch(haystack: string, number: string): boolean {
  const digits = (s: string) => s.replace(/\D/g, '');
  const needle = digits(number).slice(-10);
  if (!needle) return false;
  return digits(haystack).includes(needle);
}

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

// ---------------------------------------------------------------------------
// 1. diagnose_call — CDR + SIP trace + queue context in one shot
// ---------------------------------------------------------------------------

const diagnose_call: CuratedTool = {
  minRole: 'domain_admin',
  schema: {
    name: 'diagnose_call',
    description:
      'Diagnose a specific call: pulls the call detail record, SIP trace, and any associated queue context in a single response. ' +
      'Use when investigating "why did this call do X" rather than running CDR + sipflow + queue lookups separately.',
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
    const domain = str(args.domain);
    const user = str(args.user);
    const callid = String(args.call_id);
    const [cdr, sipflow, cradle] = await Promise.all([
      safe(client.request({ method: 'GET', pathTemplate: '/domains/{domain}/users/{user}/calls/{callid}', pathParams: { domain, user, callid } })),
      safe(client.request({ method: 'GET', pathTemplate: '/sipflow/{callid}', pathParams: { callid } })),
      safe(client.request({ method: 'GET', pathTemplate: '/cradle2grave/{callid}', pathParams: { callid } })),
    ]);
    return textResult({
      call_id: callid,
      cdr,
      sip_trace: sipflow,
      cradle_to_grave: cradle,
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
      'A combined snapshot of a NetSapiens user — basic details, registered devices, answer rules, recent calls, and voicemail count. ' +
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
  handler: async (args, client) => {
    const domain = str(args.domain);
    const user = str(args.user);
    const limit = typeof args.recent_calls_limit === 'number' ? args.recent_calls_limit : 10;
    const [details, devices, answerRules, recentCalls, voicemails] = await Promise.all([
      safe(client.request({ method: 'GET', pathTemplate: '/domains/{domain}/users/{user}', pathParams: { domain, user } })),
      safe(client.request({ method: 'GET', pathTemplate: '/domains/{domain}/users/{user}/devices', pathParams: { domain, user } })),
      safe(client.request({ method: 'GET', pathTemplate: '/domains/{domain}/users/{user}/answerrules', pathParams: { domain, user } })),
      safe(client.request({ method: 'GET', pathTemplate: '/domains/{domain}/users/{user}/cdrs', pathParams: { domain, user }, queryParams: { limit } })),
      safe(client.request({ method: 'GET', pathTemplate: '/domains/{domain}/users/{user}/voicemails', pathParams: { domain, user } })),
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
      voicemails: voicemails.ok ? undefined : voicemails, // surface error if it failed
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
      },
    },
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
    const annotated = await Promise.all(
      limited.map(async (q) => {
        const queueId = String(q['callqueue'] ?? q['queue'] ?? q['name'] ?? '');
        if (!queueId) return { queue: q, status: { ok: false, error: 'no queue id in record' } };
        const status = await safe(
          client.request({ method: 'GET', pathTemplate: '/domains/{domain}/statistics/callqueues/{queue}', pathParams: { domain, queue: queueId } }),
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
      'A snapshot of an agent\'s day: current queue status (logged in to which queues), today\'s call activity, and agent statistics. ' +
      'Defaults to the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', default: '~', description: 'Agent extension. Defaults to you.' },
        domain: { type: 'string' },
      },
    },
  },
  handler: async (args, client) => {
    const domain = str(args.domain);
    const agent = str(args.agent);
    // Compute "today" from a passed-in timestamp would be cleaner, but for now
    // ask NS for today by passing the start-of-day ISO derived elsewhere.
    // Without Date.now access here we keep it spec-aligned: fetch last 25 calls
    // and a per-agent stats summary; let the model filter by date if needed.
    const [status, recentCalls, stats] = await Promise.all([
      safe(client.request({ method: 'GET', pathTemplate: '/domains/{domain}/callqueues/all/agents/{agent}', pathParams: { domain, agent } })),
      safe(client.request({ method: 'GET', pathTemplate: '/domains/{domain}/users/{user}/cdrs', pathParams: { domain, user: agent }, queryParams: { limit: 25 } })),
      safe(client.request({ method: 'GET', pathTemplate: '/domains/{domain}/statistics/agent/{agent}', pathParams: { domain, agent } })),
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
  handler: async (args, client) => {
    const domain = str(args.domain);
    const agent = str(args.agent);
    const from = String(args.from);
    const to = String(args.to);
    const logout = await safe(
      client.request({ method: 'POST', pathTemplate: '/domains/{domain}/callqueues/{queue}/agents/{agent}/logout', pathParams: { domain, queue: from, agent } }),
    );
    if (!logout.ok) {
      return textResult({ ok: false, step: 'logout', from, to, agent, logout, note: 'logout from source queue failed; no login attempted' });
    }
    const login = await safe(
      client.request({ method: 'POST', pathTemplate: '/domains/{domain}/callqueues/{queue}/agents/{agent}/login', pathParams: { domain, queue: to, agent } }),
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
  handler: async (args, client) => {
    const domain = str(args.domain);
    const from = str(args.from);
    const q = String(args.query);
    const confirm = args.confirm === true;

    // Search both users and contacts in parallel
    const [users, contacts] = await Promise.all([
      safe<Array<Record<string, unknown>>>(
        client.request({ method: 'GET', pathTemplate: '/domains/{domain}/users', pathParams: { domain }, queryParams: { user: q, limit: 10 } }),
      ),
      safe<Array<Record<string, unknown>>>(
        client.request({ method: 'GET', pathTemplate: '/domains/{domain}/users/~/contacts', pathParams: { domain }, queryParams: { contact: q, limit: 10 } }),
      ),
    ]);
    const userMatches = Array.isArray(users.data) ? users.data : [];
    const contactMatches = Array.isArray(contacts.data) ? contacts.data : [];

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
  handler: async (args, client) => {
    const domain = str(args.domain);
    const number = String(args.number);
    const since = args.since ? String(args.since) : undefined;
    const limit = typeof args.limit === 'number' ? args.limit : 25;
    // The CDR search variant of this endpoint filters on `caller`/`dialled`
    // (partial match) — there's no single param that means "either side of
    // the call", so query both directions and merge. `datetime-start` is
    // only sent when `since` is given; the bare listing form tolerates its
    // absence.
    const [callsAsCaller, callsAsDialled, messageSessions] = await Promise.all([
      safe<Array<Record<string, unknown>>>(
        client.request({
          method: 'GET',
          pathTemplate: '/domains/{domain}/cdrs',
          pathParams: { domain },
          queryParams: { caller: number, limit, 'datetime-start': since },
        }),
      ),
      safe<Array<Record<string, unknown>>>(
        client.request({
          method: 'GET',
          pathTemplate: '/domains/{domain}/cdrs',
          pathParams: { domain },
          queryParams: { dialled: number, limit, 'datetime-start': since },
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
        callsById.set(call.id ?? JSON.stringify(call), call);
      }
    }
    const calls = {
      ok: callsAsCaller.ok || callsAsDialled.ok,
      error: callsAsCaller.ok || callsAsDialled.ok ? undefined : (callsAsCaller.error ?? callsAsDialled.error),
      data: Array.from(callsById.values()).slice(0, limit),
    };
    // The domain-wide messagesessions endpoint has no server-side "involving
    // this number" filter, so filter client-side against the participant
    // fields the API does return.
    const matchesNumber = (session: Record<string, unknown>) => {
      const haystack = [session['messagesession-remote'], session['messagesession-sms-number'], session['messagesession-participants']]
        .filter((v) => v != null)
        .map(String)
        .join(',');
      return numbersMatch(haystack, number);
    };
    const filteredSessions = messageSessions.ok && Array.isArray(messageSessions.data)
      ? messageSessions.data.filter(matchesNumber).slice(0, limit)
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
// 8. voicemail_inbox_summary — new VMs with caller + transcript condensed
// ---------------------------------------------------------------------------

const voicemail_inbox_summary: CuratedTool = {
  minRole: 'user',
  schema: {
    name: 'voicemail_inbox_summary',
    description:
      'Condensed summary of new voicemails: one line per VM with caller, time, duration, and transcript snippet (when available). ' +
      'Far less noise than listing the full voicemail records.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 25 },
        folder: { type: 'string', default: 'new', description: 'Voicemail folder (default "new").' },
      },
    },
  },
  handler: async (args, client) => {
    const limit = typeof args.limit === 'number' ? args.limit : 25;
    const folder = String(args.folder ?? 'new');
    const list = await safe<Array<Record<string, unknown>>>(
      client.request({
        method: 'GET',
        pathTemplate: '/domains/~/users/~/voicemails/{folder}',
        pathParams: { folder },
        queryParams: { limit },
      }),
    );
    if (!list.ok) return textResult({ error: 'Failed to list voicemails', detail: list.error });
    const items = Array.isArray(list.data) ? list.data : [];
    const summary = items.map((vm) => {
      const caller = String(vm['caller-id-number'] ?? vm['from'] ?? vm['caller'] ?? '');
      const callerName = String(vm['caller-id-name'] ?? vm['from-name'] ?? '');
      const at = String(vm['datetime'] ?? vm['time-received'] ?? vm['received'] ?? '');
      const dur = vm['duration'] ?? vm['length'] ?? '';
      const transcript = String(vm['transcription-text'] ?? vm['transcription'] ?? vm['transcript'] ?? '');
      return {
        from: callerName ? `${callerName} <${caller}>` : caller,
        at,
        duration: dur,
        transcript: transcript ? (transcript.length > 200 ? transcript.slice(0, 200) + '…' : transcript) : undefined,
        id: vm['filename'] ?? vm['id'] ?? vm['message-id'],
      };
    });
    return textResult({ folder, count: summary.length, voicemails: summary });
  },
};

// ---------------------------------------------------------------------------
// 9. schedule_forwarding — set an answer rule that forwards calls
// ---------------------------------------------------------------------------

const schedule_forwarding: CuratedTool = {
  minRole: 'user',
  schema: {
    name: 'schedule_forwarding',
    description:
      'Forward your incoming calls to a destination via the "always" answer rule. ' +
      'Pass `disable: true` to clear forwarding. (Time-bounded forwarding requires a custom time-frame; use call_api with answerrule + timeframe tools for that.)',
    inputSchema: {
      type: 'object',
      properties: {
        destination: { type: 'string', description: 'Number or extension to forward to.' },
        disable: { type: 'boolean', default: false, description: 'If true, clear the always-forward rule.' },
        timeframe: { type: 'string', default: 'Default', description: 'Answer-rule time-frame to modify (default "Default").' },
      },
    },
  },
  handler: async (args, client) => {
    const timeframe = String(args.timeframe ?? 'Default');
    const disable = args.disable === true;
    const destination = args.destination ? String(args.destination) : undefined;
    if (!disable && !destination) {
      return textResult({ error: 'Either destination or disable=true is required.' });
    }
    const body = disable
      ? { 'rule-action': 'do-not-forward' }
      : { 'rule-action': 'forward-all-calls', 'forward-destination': destination };
    const r = await safe(
      client.request({
        method: 'PUT',
        pathTemplate: '/domains/~/users/~/answerrules/{timeframe}',
        pathParams: { timeframe },
        body,
      }),
    );
    return textResult({
      ok: r.ok,
      timeframe,
      destination: disable ? null : destination,
      result: r,
      note: 'This updates the answer rule for the given time-frame. For time-bounded forwarding (e.g. "until Friday 5pm"), create a custom time-frame first via call_api with the time-frame endpoints, then point an answer rule at it.',
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
];
