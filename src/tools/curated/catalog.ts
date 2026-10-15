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
import { textResult, STANDARD_WRAPPER_RULES } from './types.js';
import { ROLE_HIERARCHY, type UserRole } from '../../auth/roles.js';
import { WORKFLOW_TOOLS, lookupCallForTrace } from './workflows.js';
import { fieldsMatch, numbersMatch } from './matching.js';
import type { GenericApiClient } from '../../generated/types.js';

const str = (v: unknown, dflt = '~') => (v == null || v === '' ? dflt : String(v));
const num = (v: unknown) => (typeof v === 'number' ? v : v == null ? undefined : Number(v));

export function matchesCallId(record: Record<string, unknown>, callId: string): boolean {
 return (
  record['id'] === callId ||
  record['call-orig-call-id'] === callId ||
  record['call-term-call-id'] === callId ||
  record['call-parent-call-id'] === callId ||
  record['call-through-call-id'] === callId ||
  record['orig_callid'] === callId ||
  record['term_callid'] === callId ||
  record['by_callid'] === callId ||
  record['servedCallId'] === callId ||
  record['cdr_id'] === callId
 );
}

// NetSapiens reads every date bound as UTC wall time and ignores any offset. Measured on
// /domains/{d}/users/{u}/cdrs/count (2026-10-15): "2026-10-14 23:00:00" and
// "2026-10-14T23:00:00Z" both found a call at 23:02Z; "2026-10-14T16:00:00-07:00", the same
// instant, found nothing. So every bound is converted to its UTC instant before sending.
const DAY_MS = 24 * 60 * 60 * 1000;
const pad2 = (n: number) => String(n).padStart(2, '0');

export function toNsDateTime(d: Date): string {
 return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** A caller's bound. A bare date is the first second of that UTC day, or its last second for an end. */
export function parseNsBound(value: string, edge: 'start' | 'end'): Date {
 const s = value.trim();
 const bare = /^(\d{4}-\d{2}-\d{2})$/.exec(s);
 const wall = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/.exec(s);
 const parsed = bare
  ? new Date(`${bare[1]}T${edge === 'start' ? '00:00:00' : '23:59:59'}Z`)
  : wall
   ? new Date(`${wall[1]}T${wall[2]}${wall[3] ?? ':00'}Z`)
   : new Date(s);
 if (isNaN(parsed.getTime())) {
  throw new Error(`Could not read the date "${value}". Use YYYY-MM-DD, YYYY-MM-DD HH:MM:SS (UTC) or an ISO timestamp with an offset.`);
    }
 return parsed;
}

/**
 * The window a date-bounded tool sends. Caller bounds win, and each missing bound defaults on
 * its own: the end to now, the start to 24 hours before the end, so an end-only question about
 * the past still asks about the day before that end.
 */
export function nsDateWindow(since?: unknown, until?: unknown, now = new Date()): { start: string; end: string } {
 const given = (v: unknown) => (v == null || v === '' ? undefined : String(v));
 const endAt = given(until) ? parseNsBound(given(until)!, 'end') : now;
 const startAt = given(since) ? parseNsBound(given(since)!, 'start') : new Date(endAt.getTime() - DAY_MS);
 return { start: toNsDateTime(startAt), end: toNsDateTime(endAt) };
 }

/** The signed-in user's extension, for tools whose `~` means "me". Throws rather than widen. */
export async function resolveSelfUser(client: GenericApiClient): Promise<string> {
 const r = await client.request({ method: 'GET', pathTemplate: '/domains/{domain}/users/{user}', pathParams: { domain: '~', user: '~' } });
 const row = (Array.isArray(r.data) ? r.data[0] : r.data) as Record<string, unknown> | undefined;
 const user = r.success && row ? row.user : undefined;
 if (typeof user !== 'string' && typeof user !== 'number') {
  throw new Error('Could not resolve your own extension, so nothing was looked up.');
 }
 return String(user);
}

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
 targets: { domainArg: 'domain' },
 output: { rules: [...STANDARD_WRAPPER_RULES, { path: 'data[]', resource: 'User' }] },
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
  if (!r.success) {
   if (r.error && /invalid scope|401/i.test(r.error)) {
    const selfRes = await client.request({
     method: 'GET',
     pathTemplate: '/domains/{domain}/users/~',
     pathParams: { domain: str(args.domain) },
    });
    if (selfRes.success && selfRes.data && typeof selfRes.data === 'object') {
     const self = selfRes.data as Record<string, unknown>;
     const matches = fieldsMatch(self, ['user', 'name-first-name', 'name-last-name', 'login-username', 'email'], query) ? [self] : [];
     return textResult({ success: true, data: matches, note: 'Basic users can only view their own user profile.' });
    }
   }
   return textResult(r);
  }
  if (!Array.isArray(r.data)) return textResult(r);
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
  description:
   'Look up a NetSapiens domain by name or filter. For domain administrators and below, this returns ' +
   "the caller's own domain. For resellers and system administrators, this lists all visible domains. " +
   'Use without a query to see your domain or list visible domains.',
  inputSchema: {
   type: 'object',
   properties: {
    query: {
     type: 'string',
     description:
      'Domain name fragment. For resellers and above, omit to list all visible domains. ' +
      'For domain administrators, omit to return your own domain.',
    },
    limit: { type: 'number', default: 25 },
   },
  },
 },
 targets: {},
 output: { rules: [...STANDARD_WRAPPER_RULES, { path: 'data[]', resource: 'Domain' }] },
 handler: async (args, client, userRole) => {
  const query = args.query ? String(args.query) : '';
  const limit = num(args.limit) ?? 25;
  const isReseller = userRole != null && ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY.reseller;

  if (!isReseller) {
   // Domain administrators only have access to their own domain.
   // Fetch the caller domain via /domains/{domain} with '~'.
   const r = await client.request({
    method: 'GET',
    pathTemplate: '/domains/{domain}',
    pathParams: { domain: '~' },
    queryParams: {},
   });
   if (!r.success) return textResult(r);
   const raw = r.data;
   const list: Array<Record<string, unknown>> = Array.isArray(raw)
    ? (raw as Array<Record<string, unknown>>)
    : raw && typeof raw === 'object'
     ? [raw as Record<string, unknown>]
     : [];
   const matches = query ? list.filter((d) => fieldsMatch(d, ['domain', 'description'], query)) : list;
   return textResult({ ...r, data: matches.slice(0, limit) });
  }

  // Resellers and system administrators have access to list visible domains.
  // /domains has no server-side name filter (only limit/start): fetch
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
 targets: { domainArg: 'domain' },
 output: { rules: [...STANDARD_WRAPPER_RULES, { path: 'data[]', resource: 'Contact' }] },
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
 targets: { domainArg: 'domain' },
 output: { rules: [...STANDARD_WRAPPER_RULES, { path: 'data[]', resource: 'Phonenumber' }] },
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
 targets: { domainArg: 'domain' },
 output: {
  rules: [
   ...STANDARD_WRAPPER_RULES,
   { path: 'data[].device-provisioning-password', field: { class: 'secret' } },
   { path: 'data[].device-sip-registration-password', field: { class: 'secret' } },
   { path: 'data[].global-one-time-pass', field: { class: 'secret' } },
   { path: 'data[]', resource: 'Phone' },
   { path: 'data[]', resource: 'Device' },
  ],
 },
 handler: async (args, client) => {
  const query = String(args.query ?? '').trim();
  const domain = str(args.domain);

  // NetSapiens v2 answers 404 No Route Found to /domains/{domain}/devices.
  // 1. Handset-provisioned hardware phones (by MAC, model, line extension) live at /domains/{domain}/phones.
  const phonesPromise = client.request({
   method: 'GET',
   pathTemplate: '/domains/{domain}/phones',
   pathParams: { domain },
  });

  // 2. Per-user SIP device registrations live at /domains/{domain}/users/{user}/devices.
  // When query is an extension or username, query the user's devices.
  const isCandidateUser = query.length > 0 && !/[\s/]/.test(query);
  const userDevicesPromise = isCandidateUser
   ? client.request({
    method: 'GET',
    pathTemplate: '/domains/{domain}/users/{user}/devices',
    pathParams: { domain, user: query },
   })
   : Promise.resolve({ success: true, data: [] });

  const [phonesRes, userDevRes] = await Promise.all([phonesPromise, userDevicesPromise]);

  if (!phonesRes.success && !userDevRes.success) {
   return textResult(phonesRes);
  }

  const rawPhones = Array.isArray(phonesRes.data)
   ? (phonesRes.data as Array<Record<string, unknown>>).map((p) => {
    const mapped: Record<string, unknown> = { ...p };
    if (!mapped.device && (p['device-provisioning-mac-address'] || p.mac)) {
     mapped.device = p['device-provisioning-mac-address'] || p.mac;
    }
    if (!mapped.user && (p['device-provisioning-line-1-extensions'] || p['device-provisioning-username'])) {
     mapped.user = p['device-provisioning-line-1-extensions'] || p['device-provisioning-username'];
    }
    if (!mapped['device-models-model'] && (p['device-models-brand-and-model'] || p.model)) {
     mapped['device-models-model'] = p['device-models-brand-and-model'] || p.model;
    }
    if (!mapped['device-sip-registration-user-agent'] && (p['device-models-brand-and-model'] || p.model)) {
     mapped['device-sip-registration-user-agent'] = p['device-models-brand-and-model'] || p.model;
    }
    return mapped;
   })
   : [];

  const rawUserDevices = Array.isArray(userDevRes.data)
   ? (userDevRes.data as Array<Record<string, unknown>>)
   : [];

  const combined: Array<Record<string, unknown>> = [];
  const seen = new Set<unknown>();
  for (const item of [...rawPhones, ...rawUserDevices]) {
   const key = item.device ?? item['device-provisioning-mac-address'] ?? item.mac;
   if (key && seen.has(key)) continue;
   if (key) seen.add(key);
   combined.push(item);
  }

  const matches = combined.filter((d) =>
   fieldsMatch(
    d,
    [
     'device',
     'user',
     'mac',
     'device-provisioning-mac-address',
     'device-models-brand-and-model',
     'device-models-model',
     'device-sip-registration-user-agent',
     'device-sip-allowed-user-agent',
     'device-provisioning-line-1-extensions',
     'device-provisioning-username',
    ],
    query,
   ),
  );
  return textResult({ success: true, data: matches });
 },
};

// ---------------------------------------------------------------------------
// CALL HISTORY & LIVE
// ---------------------------------------------------------------------------

/**
 * `datetime-start` is a REQUIRED PAIR with `datetime-end`: sending one alone is
 * silently ignored by the API (confirmed against live data), so bound the other
 * end at "now" whenever only `since` is given.
 */
function cdrWindow(args: Record<string, unknown>): { 'datetime-start'?: string; 'datetime-end'?: string } {
 const since = args.since ? String(args.since) : undefined;
 const until = args.until ? String(args.until) : since ? new Date().toISOString() : undefined;
 return { 'datetime-start': since, 'datetime-end': until };
}

/**
 * Resolve which CDR breadth the caller actually meant.
 *
 * An office manager (domain_admin and up) asking about "calls" means the
 * office: that is the job. Defaulting them to their own line produced a wrong
 * answer with no error, because the model has no way to know its question was
 * narrowed. A plain user still defaults to themselves, and NS enforces the
 * real boundary on the token either way.
 */
export function cdrScope(args: Record<string, unknown>, userRole?: UserRole): 'mine' | 'user' | 'domain' {
 if (args.user != null && args.user !== '') return 'user';
 const asked = args.scope == null ? undefined : String(args.scope);
 if (asked === 'mine' || asked === 'user' || asked === 'domain') return asked;
 return userRole && ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY.domain_admin ? 'domain' : 'mine';
}

export function cdrScopeNote(
 scope: 'mine' | 'user' | 'domain',
 args: Record<string, unknown>,
 userRole?: UserRole,
): string {
 if (scope === 'domain') {
  return 'every call in the domain, not just yours; pass scope="mine" or user="<extension>" to narrow';
 }
 if (scope === 'user') {
  const target = args.user != null && args.user !== '' ? String(args.user) : '<extension>';
  return `only extension ${target}`;
 }
 if (userRole && ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY.domain_admin) {
  return 'only the signed-in user\'s calls; pass scope="domain" for the whole office';
 }
 return 'only the signed-in user\'s calls';
}

export const SCOPE_PROPERTIES = {
 scope: {
  type: 'string',
  enum: ['mine', 'user', 'domain'],
  description:
   'Whose calls. Defaults to "domain" for office managers and above, "mine" for everyone else. ' +
   'Set "mine" explicitly to narrow a manager back to their own line.',
 },
 user: {
  type: 'string',
  description: 'One specific user by extension or user id, e.g. "290". Implies scope="user" and overrides `scope`.',
 },
 domain: { type: 'string', description: 'Defaults to your own domain.' },
 since: { type: 'string', description: 'Start of window, RFC3339 or "YYYY-MM-DD HH:MM:SS"' },
 until: { type: 'string', description: 'End of window, same format as `since`. Defaults to now when `since` is set.' },
 type: { type: 'string', description: 'Inbound, Outbound, On-net, Off-net, Missed, Received' },
} as const;

const recent_calls: CuratedTool = {
 minRole: 'user',
 schema: {
  name: 'recent_calls',
  description:
   'Recent call detail records (CDR). For an office manager or above this returns the whole domain by ' +
   'default, which is what "how did we do today" means. Pass scope="mine" for just your own calls, or ' +
   '`user` for one person. The response reports the scope it actually used.',
  inputSchema: {
   type: 'object',
   properties: { ...SCOPE_PROPERTIES, limit: { type: 'number', default: 25 } },
  },
 },
 targets: { domainArg: 'domain', userArg: 'user', breadthArg: { name: 'scope', selfValue: 'mine' } },
 output: {
  rules: [
   ...STANDARD_WRAPPER_RULES,
   { path: 'scope', field: { class: 'metadata' } },
   { path: 'scope_note', field: { class: 'metadata' } },
   { path: 'data[]', resource: 'CdrD' },
  ],
 },
 handler: async (args, client, userRole) => {
  const scope = cdrScope(args, userRole);
  const scope_note = cdrScopeNote(scope, args, userRole);
  const queryParams = {
   limit: num(args.limit) ?? 25,
   ...cdrWindow(args),
   type: args.type ? String(args.type) : undefined,
  };
  const r =
   scope === 'domain'
    ? await client.request({
     method: 'GET',
     pathTemplate: '/domains/{domain}/cdrs',
     pathParams: { domain: str(args.domain) },
     queryParams,
    })
    : await client.request({
     method: 'GET',
     pathTemplate: '/domains/{domain}/users/{user}/cdrs',
     pathParams: { domain: str(args.domain), user: str(args.user) },
     queryParams,
    });
  return textResult({ scope, scope_note, ...r });
 },
};

const call_volume: CuratedTool = {
 minRole: 'user',
 schema: {
  name: 'call_volume',
  description:
   'Count calls and sum minutes over a time window. With no dates it covers the last 24 hours; with only `until`, the 24 hours before it. Bounds without an offset are UTC. ' +
   'Use this for "how many calls" questions: `recent_calls` is capped by `limit` and cannot produce a count. Same scope rules as `recent_calls`, ' +
   'so an office manager gets the whole domain by default. The response reports the scope it used.',
  inputSchema: { type: 'object', properties: { ...SCOPE_PROPERTIES } },
 },
 targets: { domainArg: 'domain', userArg: 'user', breadthArg: { name: 'scope', selfValue: 'mine' } },
 output: {
  rules: [
   ...STANDARD_WRAPPER_RULES,
   { path: 'scope', field: { class: 'metadata' } },
   { path: 'scope_note', field: { class: 'metadata' } },
   { path: 'data', resource: 'Count' },
   { path: 'total', field: { class: 'metadata' } },
   { path: 'total-duration', field: { class: 'metadata' } },
   { path: 'minutes', field: { class: 'metadata' } },
   { path: 'seconds', field: { class: 'metadata' } },
  ],
 },
 handler: async (args, client, userRole) => {
  const scope = cdrScope(args, userRole);
  const scope_note = cdrScopeNote(scope, args, userRole);
  const window = nsDateWindow(args.since, args.until);
  const queryParams: Record<string, unknown> = {
   'datetime-start': window.start,
   'datetime-end': window.end,
   type: args.type ? String(args.type) : undefined,
  };
  const r =
   scope === 'domain'
    ? await client.request({
     method: 'GET',
     pathTemplate: '/domains/{domain}/cdrs/count',
     pathParams: { domain: str(args.domain) },
     queryParams,
    })
    : await client.request({
     method: 'GET',
     pathTemplate: '/domains/{domain}/users/{user}/cdrs/count',
     pathParams: { domain: str(args.domain), user: str(args.user) },
     queryParams,
    });
  return textResult({ scope, scope_note, ...r });
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
 targets: { domainArg: 'domain' },
 output: { rules: [...STANDARD_WRAPPER_RULES, { path: 'data[]', resource: 'ActiveCall' }] },
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
  description: 'Details for a specific call by call_id. Accepts active call IDs, CDR IDs from recent_calls, or SIP call IDs.',
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
 targets: { domainArg: 'domain', userArg: 'user' },
 output: {
  rules: [
   ...STANDARD_WRAPPER_RULES,
   { path: 'data', resource: 'CdrD' },
   { path: 'data', resource: 'ActiveCall' },
  ],
 },
 handler: async (args, client, userRole) => {
  const callid = String(args.call_id);
  const domain = str(args.domain);
  const user = str(args.user);
  const notFound = (res: { success: boolean; error?: string }) => !res.success && /\b404\b|not found/i.test(res.error ?? '');

  // 1. A live call. Only "not found" moves on to the CDRs; any other refusal is the answer.
  const activeRes = await client.request({
   method: 'GET',
   pathTemplate: '/domains/{domain}/users/{user}/calls/{callid}',
   pathParams: { domain, user, callid },
  });
  if (activeRes.success && activeRes.data && typeof activeRes.data === 'object' && !Array.isArray(activeRes.data)) {
   return textResult(activeRes);
  }
  if (!activeRes.success && !notFound(activeRes)) return textResult(activeRes);

  // 2. The CDRs. An office manager searches the domain; a basic user, or a login the domain
  // route refuses with Invalid Scope, searches their own. A row counts only if its own ids
  // match, because a route may ignore a filter it does not support and return other calls.
  const isBasicUser = userRole == null || ROLE_HIERARCHY[userRole] < ROLE_HIERARCHY.domain_admin;
  const ownCdrs = { pathTemplate: '/domains/{domain}/users/{user}/cdrs', pathParams: { domain, user } as Record<string, string> };
  let cdrRoute = isBasicUser ? ownCdrs : { pathTemplate: '/domains/{domain}/cdrs', pathParams: { domain } as Record<string, string> };
  for (const filter of [{ orig_callid: callid, limit: 10 }, { term_callid: callid, limit: 10 }, { limit: 50 }]) {
   let r = await client.request({ method: 'GET', ...cdrRoute, queryParams: filter });
   if (!r.success && cdrRoute !== ownCdrs && /invalid scope/i.test(r.error ?? '')) {
    cdrRoute = ownCdrs;
    r = await client.request({ method: 'GET', ...cdrRoute, queryParams: filter });
   }
   if (!r.success) return textResult(r);
   const matched = Array.isArray(r.data)
    ? (r.data as Array<Record<string, unknown>>).find((row) => matchesCallId(row, callid))
    : undefined;
    if (matched) return textResult({ success: true, data: matched });
   }
  return textResult({ success: false, error: 'Call not found' });
 },
};

const call_trace: CuratedTool = {
 minRole: 'domain_admin',
 schema: {
  name: 'call_trace',
  description:
   'SIP flow / call trace for a specific call. Reading SIP traces on /sipflow requires Super User access (Reseller is unverified). ' +
   'Useful for diagnosing why a call did what it did.',
  inputSchema: {
   type: 'object',
   properties: {
    call_id: { type: 'string', description: 'Call ID or SIP Call-ID' },
    domain: { type: 'string', description: 'Domain name (defaults to ~)' },
    user: { type: 'string', description: 'User extension (defaults to ~)' },
    servers: { type: 'string', description: 'Core server FQDN handling the call (looked up from call details if omitted)' },
    start_time: { type: 'string', description: 'Search window start timestamp' },
    end_time: { type: 'string', description: 'Search window end timestamp' },
   },
   required: ['call_id'],
  },
 },
 targets: { domainArg: 'domain', userArg: 'user' },
 output: {
  rules: [
   ...STANDARD_WRAPPER_RULES,
   { path: 'call_id', field: { class: 'metadata' } },
   { path: 'detail', field: { class: 'metadata' } },
   { path: 'searched_window', field: { class: 'metadata' } },
   { path: 'searched_window.start', field: { class: 'metadata' } },
   { path: 'searched_window.end', field: { class: 'metadata' } },
   { path: 'data', resource: 'CallTrace' },
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
   });
  }

  const { server, startTime, endTime } = lookup.data;

  const queryParams: Record<string, unknown> = {
   callids: callid,
   servers: server,
   type: 'call_trace',
  };
  if (startTime) queryParams.start_time = startTime;
  if (endTime) queryParams.end_time = endTime;

  const r = await client.request({
   method: 'GET',
   pathTemplate: '/sipflow',
   queryParams,
  });

  if (!r.success) {
   const isRoleDenied = Boolean(
    r.error && (r.error.includes('401') || r.error.includes('403') || r.error.toLowerCase().includes('invalid scope')),
   );
   if (isRoleDenied) {
    return textResult({
     call_id: callid,
     success: false,
     error: r.error,
     detail: 'Your portal role cannot read SIP traces. Reading SIP traces on /sipflow requires Super User access (Reseller is unverified).',
     searched_window: lookup.searchedWindow,
    });
   }
  }

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
 targets: { domainArg: 'domain', userArg: 'from' },
 output: { rules: [...STANDARD_WRAPPER_RULES, { path: 'data', resource: 'CallRequest' }] },
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
 targets: { domainArg: 'domain', userArg: 'user' },
 output: { rules: [...STANDARD_WRAPPER_RULES, { path: 'data', resource: 'CallRequest' }] },
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
 targets: { domainArg: 'domain', userArg: 'user' },
 output: { rules: [...STANDARD_WRAPPER_RULES, { path: 'data', resource: 'CallRequest' }] },
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

const VOICEMAIL_FOLDERS: ReadonlyArray<'new' | 'save' | 'trash'> = ['new', 'save', 'trash'];

function normalizeVoicemailFolder(raw?: unknown): 'new' | 'save' | 'trash' | undefined {
 if (typeof raw !== 'string') return undefined;
 const f = raw.toLowerCase().trim();
 if (f === 'new' || f === 'inbox') return 'new';
 if (f === 'save' || f === 'saved') return 'save';
 if (f === 'trash' || f === 'deleted') return 'trash';
 if (f === 'all') return undefined;
 return f as 'new' | 'save' | 'trash';
}

const my_voicemails: CuratedTool = {
 minRole: 'user',
 schema: {
  name: 'my_voicemails',
  description: 'List your voicemails. Pass folder ("new" or "inbox", "save" or "saved", "trash") to filter, or omit to list across all folders.',
  inputSchema: {
   type: 'object',
   properties: {
    folder: { type: 'string', description: 'Folder name: "new" (inbox), "save" (saved), "trash", or omit for all folders.' },
    limit: { type: 'number', default: 25 },
   },
  },
 },
 targets: { selfOnly: true },
 output: { rules: [...STANDARD_WRAPPER_RULES, { path: 'data[]', resource: 'Voicemail' }] },
 handler: async (args, client) => {
  const limit = num(args.limit) ?? 25;
  const targetFolder = normalizeVoicemailFolder(args.folder);
  if (targetFolder) {
   const r = await client.request({
    method: 'GET',
    pathTemplate: '/domains/~/users/~/voicemails/{folder}',
    pathParams: { folder: targetFolder },
    queryParams: { limit },
   });
   if (r && Array.isArray(r.data)) {
    r.data = r.data.map((item: Record<string, unknown>) => ({ ...item, folder: targetFolder }));
   }
   return textResult(r);
  }
  const responses = await Promise.all(
   VOICEMAIL_FOLDERS.map(async (folder) => {
    try {
     const res = await client.request({
      method: 'GET',
      pathTemplate: '/domains/~/users/~/voicemails/{folder}',
      pathParams: { folder },
      queryParams: { limit },
     });
     const items = Array.isArray(res?.data) ? (res.data as Array<Record<string, unknown>>) : [];
     return items.map((item) => ({ ...item, folder }));
    } catch {
     return [];
    }
   }),
  );
  const merged = responses.flat();
  return textResult({
   success: true,
   data: merged.slice(0, limit),
  });
 },
};

const read_voicemail: CuratedTool = {
 minRole: 'user',
 schema: {
  name: 'read_voicemail',
  description: 'Open a specific voicemail (metadata + download URL/transcript if available). Pass folder ("new", "save", "trash") if known, or omit to search.',
  inputSchema: {
   type: 'object',
   properties: {
    voicemail_id: { type: 'string', description: 'Voicemail filename or ID' },
    folder: { type: 'string', description: 'Folder name: "new" (inbox), "save" (saved), or "trash". If omitted, searches new, save, then trash.' },
   },
   required: ['voicemail_id'],
  },
 },
 targets: { selfOnly: true },
 output: {
  rules: [
   ...STANDARD_WRAPPER_RULES,
   { path: 'data', resource: 'Voicemail' },
   { path: 'data[]', resource: 'Voicemail' },
  ],
 },
 handler: async (args, client) => {
  const filename = String(args.voicemail_id);
  const targetFolder = normalizeVoicemailFolder(args.folder);
  if (targetFolder) {
   const r = await client.request({
    method: 'GET',
    pathTemplate: '/domains/~/users/~/voicemails/{folder}/{filename}',
    pathParams: { folder: targetFolder, filename },
   });
   return textResult(r);
  }
  for (const folder of VOICEMAIL_FOLDERS) {
   try {
    const r = await client.request({
     method: 'GET',
     pathTemplate: '/domains/~/users/~/voicemails/{folder}/{filename}',
     pathParams: { folder, filename },
    });
    if (r?.success !== false && r?.data) {
     if (Array.isArray(r.data) && r.data.length === 0) {
      continue;
     }
     return textResult(r);
    }
   } catch {
    // continue to next folder
   }
  }
  return textResult({ success: false, error: 'Voicemail not found' });
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
    voicemail_id: { type: 'string', description: 'Voicemail filename or ID' },
    to: { type: 'string', description: 'Destination user extension' },
    folder: { type: 'string', description: 'Folder name: "new" (inbox), "save" (saved), or "trash". Defaults to "new".' },
    note: { type: 'string', description: 'Optional note to attach' },
   },
   required: ['voicemail_id', 'to'],
  },
 },
 targets: { selfOnly: true },
 output: { rules: [...STANDARD_WRAPPER_RULES, { path: 'data', resource: 'Voicemail' }] },
 handler: async (args, client) => {
  const folder = normalizeVoicemailFolder(args.folder) ?? 'new';
  const r = await client.request({
   method: 'PATCH',
   pathTemplate: '/domains/~/users/~/voicemails/{folder}/{filename}/forward',
   pathParams: { folder, filename: String(args.voicemail_id) },
   body: { 'voicemail-forward-new-destination': String(args.to) },
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
 targets: { selfOnly: true },
 output: { rules: [...STANDARD_WRAPPER_RULES, { path: 'data[]', resource: 'Messagesession' }] },
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
 targets: { selfOnly: true },
 output: { rules: [...STANDARD_WRAPPER_RULES, { path: 'data[]', resource: 'Message' }] },
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
  description: 'Send a message (SMS or chat) to a destination or an existing message session.',
  inputSchema: {
   type: 'object',
   properties: {
    to: { type: 'string', description: 'Destination: user extension (e.g. "102") or user@domain for chat; E.164 / 10-digit phone number for SMS.' },
    text: { type: 'string', description: 'Message body text.' },
    type: {
     type: 'string',
     enum: ['sms', 'chat'],
     description: 'Message type: "chat" between internal users, "sms" to external phone numbers. Defaults to "chat" for extensions or user@domain, "sms" for phone numbers.',
    },
    session_id: { type: 'string', description: 'Optional existing message session ID. When provided, sends the message into that session.' },
    from: { type: 'string', description: 'Optional outbound phone number for SMS (from-number).' },
   },
   required: ['to', 'text'],
  },
 },
 targets: { selfOnly: true },
 output: { rules: [...STANDARD_WRAPPER_RULES, { path: 'data', resource: 'Message' }] },
 handler: async (args, client) => {
  const dest = Array.isArray(args.to)
   ? args.to.map((t) => String(t).trim())
   : String(args.to).trim();

  let msgType = args.type ? String(args.type) : undefined;
  if (!msgType) {
   const firstDest = Array.isArray(dest) ? dest[0] ?? '' : dest;
   const digitsOnly = firstDest.replace(/[\s().-]/g, '');
   const isPhone = /^\+?[1-9]\d{9,14}$/.test(digitsOnly);
   msgType = isPhone ? 'sms' : 'chat';
  }

  const body: Record<string, unknown> = {
   destination: dest,
   message: String(args.text),
   type: msgType,
  };

  if (args.from || (args as Record<string, unknown>)['from_number']) {
   body['from-number'] = String(args.from ?? (args as Record<string, unknown>)['from_number']);
  }

  const sessionId = args.session_id ? String(args.session_id) : (args as Record<string, unknown>)['session'] ? String((args as Record<string, unknown>)['session']) : undefined;

  if (sessionId) {
   const r = await client.request({
    method: 'POST',
    pathTemplate: '/domains/~/users/~/messagesessions/{session}/messages',
    pathParams: { session: sessionId },
    body,
   });
   return textResult(r);
  }

  const r = await client.request({
   method: 'POST',
   pathTemplate: '/domains/~/users/~/messages',
   body,
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
 targets: { domainArg: 'domain' },
 output: { rules: [...STANDARD_WRAPPER_RULES, { path: 'data[]', resource: 'CallQueue' }] },
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
  description: 'Statistics for one queue over a window: waiting calls, available/busy agents, longest wait. With no dates it covers the last 24 hours; with only an end, the 24 hours before it. Bounds without an offset are UTC.',
  inputSchema: {
   type: 'object',
   properties: {
    queue: { type: 'string' },
    domain: { type: 'string' },
    start_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
    end_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
    since: { type: 'string', description: 'Start of window' },
    until: { type: 'string', description: 'End of window' },
   },
   required: ['queue'],
  },
 },
 targets: { domainArg: 'domain' },
 output: {
  rules: [
   ...STANDARD_WRAPPER_RULES,
   { path: 'data', resource: 'CallQueue' },
   { path: 'data[]', resource: 'CallQueue' },
   { path: 'data', resource: 'QueueStat' },
   { path: 'data[]', resource: 'QueueStat' },
  ],
 },
 handler: async (args, client) => {
  const domain = str(args.domain);
  const window = nsDateWindow(args.since ?? args.start_date, args.until ?? args.end_date);
  const startDate = window.start;
  const endDate = window.end;
  const r = await client.request({
   method: 'GET',
   pathTemplate: '/domains/{domain}/statistics/callqueues/{queue}',
   pathParams: { domain, queue: String(args.queue) },
   queryParams: { start_date: startDate, end_date: endDate },
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
 targets: { agentArg: 'agent' },
 output: { rules: [...STANDARD_WRAPPER_RULES, { path: 'data', resource: 'Agent' }] },
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
 targets: { agentArg: 'agent' },
 output: { rules: [...STANDARD_WRAPPER_RULES, { path: 'data', resource: 'Agent' }] },
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
  inputSchema: {
   type: 'object',
   properties: {
    agent: { type: 'string', description: 'Agent extension or user@domain. Defaults to yourself.' },
    queue: { type: 'string', description: 'Call queue name or extension. Optional.' },
    domain: { type: 'string' },
   },
  },
 },
 targets: { domainArg: 'domain', agentArg: 'agent' },
 output: {
  rules: [
   ...STANDARD_WRAPPER_RULES,
   { path: 'data', resource: 'Agent' },
   { path: 'data[]', resource: 'Agent' },
  ],
 },
 handler: async (args, client, userRole) => {
  const domain = str(args.domain);
  const agent = args.agent ? String(args.agent) : '~';
  const queue = args.queue ? String(args.queue) : undefined;
  const isBasicUser = userRole == null || ROLE_HIERARCHY[userRole] < ROLE_HIERARCHY.domain_admin;

  if (!isBasicUser) {
   // Domain admin or above: /domains/{domain}/agents returns all agents in the domain
   const r = await client.request({
    method: 'GET',
    pathTemplate: '/domains/{domain}/agents',
    pathParams: { domain },
   });
   if (r.success && Array.isArray(r.data)) {
    let agents = r.data as Array<Record<string, unknown>>;
    if (queue) {
     agents = agents.filter((a) => a['callqueue'] === queue);
    }
    // "~" is the signed-in agent: resolve it or fail, never fall through to the whole roster.
    const targetAgent = agent === '~' ? await resolveSelfUser(client) : agent;
     agents = agents.filter((a) => {
      const aid = String(a['callqueue-agent-id'] ?? '');
      const login = String(a['login-username'] ?? '');
      return (
       aid === targetAgent ||
       aid.startsWith(`${targetAgent}@`) ||
       login === targetAgent ||
       login.startsWith(`${targetAgent}@`)
      );
     });
    if (agents.length === 0) {
     return textResult({ success: false, error: 'Agent not found' });
    }
    if (agents.length === 1) {
     return textResult({ success: true, data: agents[0] });
    }
    return textResult({ success: true, data: agents });
   }
  }

  // Basic User or fallback when /agents is unavailable:
  if (queue) {
   const r = await client.request({
    method: 'GET',
    pathTemplate: '/domains/{domain}/callqueues/{queue}/agents/{agent}',
    pathParams: { domain, queue, agent },
   });
   return textResult(r);
  }

  // Queue omitted: list visible queues from /callqueues/list and query agent status
  const qList = await client.request({
   method: 'GET',
   pathTemplate: '/domains/{domain}/callqueues/list',
   pathParams: { domain },
  });
  if (qList.success && Array.isArray(qList.data)) {
   const queues = qList.data as Array<Record<string, unknown>>;
   const results: Array<Record<string, unknown>> = [];
   for (const q of queues) {
    const qId = String(q['callqueue'] ?? q['queue'] ?? '');
    if (!qId) continue;
    const aRes = await client.request({
     method: 'GET',
     pathTemplate: '/domains/{domain}/callqueues/{queue}/agents/{agent}',
     pathParams: { domain, queue: qId, agent },
    });
    if (aRes.success && aRes.data && typeof aRes.data === 'object' && !Array.isArray(aRes.data)) {
     results.push(aRes.data as Record<string, unknown>);
    }
   }
   if (results.length === 1) {
    return textResult({ success: true, data: results[0] });
   }
   return textResult({ success: true, data: results });
  }

  return textResult({ success: false, error: 'Could not determine agent queue status' });
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
 targets: { selfOnly: true },
 output: { rules: [...STANDARD_WRAPPER_RULES, { path: 'data[]', resource: 'Device' }] },
 handler: async (_args, client, userRole) => {
  const isBasicUser = userRole != null && ROLE_HIERARCHY[userRole] < ROLE_HIERARCHY.domain_admin;
  if (isBasicUser) {
   return textResult({
    success: true,
    data: [],
    note: 'Device list is not available for your login scope.',
   });
  }
  const r = await client.request({
   method: 'GET',
   pathTemplate: '/domains/~/users/~/devices',
  });
  if (!r.success && r.error && /invalid scope|401/i.test(r.error)) {
   return textResult({
    success: true,
    data: [],
    note: 'Device list is not available for your login scope.',
   });
  }
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
 targets: { selfOnly: true },
 output: { rules: [...STANDARD_WRAPPER_RULES, { path: 'data[]', resource: 'Answerrule' }] },
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
 targets: { selfOnly: true },
 output: { rules: [...STANDARD_WRAPPER_RULES, { path: 'data', resource: 'Answerrule' }] },
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
  description: 'Aggregate call-queue statistics for a domain or specific queue. With no dates it covers the last 24 hours; with only an end, the 24 hours before it. Bounds without an offset are UTC.',
  inputSchema: {
   type: 'object',
   properties: {
    domain: { type: 'string' },
    queue: { type: 'string', description: 'Specific queue, or omit for aggregate' },
    since: { type: 'string', description: 'ISO date' },
    until: { type: 'string', description: 'ISO date' },
    start_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
    end_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
   },
  },
 },
 targets: { domainArg: 'domain' },
 output: {
  rules: [
   ...STANDARD_WRAPPER_RULES,
   { path: 'data', resource: 'QueueStat' },
   { path: 'data[]', resource: 'QueueStat' },
  ],
 },
 handler: async (args, client) => {
  const domain = str(args.domain);
  const pathTemplate = args.queue
   ? '/domains/{domain}/statistics/callqueues/{queue}'
   : '/domains/{domain}/statistics/callqueues/aggregate';
  const pathParams: Record<string, string> = { domain };
  if (args.queue) pathParams.queue = String(args.queue);
  // Measured 2026-10-15: the statistics routes take start_date/end_date as "YYYY-MM-DD HH:MM:SS".
  const window = nsDateWindow(args.since ?? args.start_date, args.until ?? args.end_date);
  const r = await client.request({
   method: 'GET',
   pathTemplate,
   pathParams,
   queryParams: { start_date: window.start, end_date: window.end },
  });
  return textResult(r);
 },
};

const agent_statistics: CuratedTool = {
 minRole: 'domain_admin',
 schema: {
  name: 'agent_statistics',
  description: 'Agent performance stats: calls handled, talk time, etc. Omit `agent` for every agent in the domain; `agent: "~"` is you. With no dates it covers the last 24 hours; with only an end, the 24 hours before it. Bounds without an offset are UTC.',
  inputSchema: {
   type: 'object',
   properties: {
    domain: { type: 'string' },
    agent: { type: 'string', description: 'Agent extension, "~" for yourself, or omit for every agent.' },
    since: { type: 'string' },
    until: { type: 'string' },
    start_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
    end_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
   },
  },
 },
 targets: { domainArg: 'domain', agentArg: 'agent' },
 output: {
  rules: [
   ...STANDARD_WRAPPER_RULES,
   { path: 'data', resource: 'QueueStat' },
   { path: 'data[]', resource: 'QueueStat' },
   { path: 'data.*', resource: 'QueueStat' },
  ],
 },
 handler: async (args, client) => {
  // "~" is the signed-in agent, never "everyone": resolve it, or fail rather than widen.
  const agent = args.agent == null || args.agent === '' ? undefined : args.agent === '~' ? await resolveSelfUser(client) : String(args.agent);
  const domain = str(args.domain);
  const pathTemplate = agent
   ? '/domains/{domain}/statistics/agent/{agent}'
   : '/domains/{domain}/statistics/agent';
  const pathParams: Record<string, string> = { domain };
  if (agent) pathParams.agent = agent;
  const window = nsDateWindow(args.since ?? args.start_date, args.until ?? args.end_date);
  const r = await client.request({
   method: 'GET',
   pathTemplate,
   pathParams,
   queryParams: { start_date: window.start, end_date: window.end },
  });
  // Only the every-agent route answers with a dictionary keyed by agent; one agent is a flat object.
  if (!agent && r.success && r.data && typeof r.data === 'object' && !Array.isArray(r.data)) {
   const items = Object.entries(r.data as Record<string, unknown>).map(([agentId, stats]) => ({
     agent: agentId,
     ...(typeof stats === 'object' && stats !== null ? (stats as Record<string, unknown>) : {}),
    }));
    return textResult({ ...r, data: items });
  }
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
 call_volume,
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
