import type { GenericApiClient } from '../../generated/types.js';

export interface SelfIdentity {
  user: string;
  domain: string;
  name?: string;
}

export async function resolveSelfIdentity(client: GenericApiClient): Promise<SelfIdentity> {
  const r = await client.request({
    method: 'GET',
    pathTemplate: '/domains/{domain}/users/{user}',
    pathParams: { domain: '~', user: '~' },
  });
  const row = (Array.isArray(r.data) ? r.data[0] : r.data) as Record<string, unknown> | undefined;
  const user = r.success && row ? row.user : undefined;
  const domain = r.success && row ? row.domain : undefined;
  if (!r.success || !row || (typeof user !== 'string' && typeof user !== 'number') || typeof domain !== 'string' || !domain) {
    throw new Error('Could not resolve your own extension, so nothing was looked up.');
  }

  let name: string | undefined;
  const fullName = typeof row['name-full-name'] === 'string' ? row['name-full-name'].trim() : undefined;
  if (fullName) {
    name = fullName;
  } else {
    const first = typeof row['name-first-name'] === 'string' ? row['name-first-name'].trim() : (typeof row['first_name'] === 'string' ? row['first_name'].trim() : '');
    const last = typeof row['name-last-name'] === 'string' ? row['name-last-name'].trim() : (typeof row['last_name'] === 'string' ? row['last_name'].trim() : '');
    const combined = [first, last].filter(Boolean).join(' ');
    if (combined) {
      name = combined;
    } else if (typeof row.name === 'string' && row.name.trim()) {
      name = row.name.trim();
    }
  }

  return {
    user: String(user),
    domain: String(domain),
    name,
  };
}

export type QueueAgentResolution =
  | { ok: true; queue: string; queueName?: string; agentId: string; agentName?: string; availabilityType?: string; record?: Record<string, unknown> }
  | { ok: false; reason: 'self_unresolved' | 'queue_not_found' | 'not_an_agent'; message: string; candidate?: string };

function andList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function formatAgentNameWithExt(r: Record<string, unknown>): string {
  const ext = (typeof r.user === 'string' && r.user.trim()) ||
    (typeof r['login-username'] === 'string' && r['login-username'].split('@')[0].trim()) ||
    (typeof r['callqueue-agent-id'] === 'string' && r['callqueue-agent-id'].split('@')[0].trim()) ||
    '';
  const fullName = typeof r['name-full-name'] === 'string' ? r['name-full-name'].trim() : '';
  const first = typeof r['name-first-name'] === 'string' ? r['name-first-name'].trim() : '';
  const last = typeof r['name-last-name'] === 'string' ? r['name-last-name'].trim() : '';
  const name = fullName || [first, last].filter(Boolean).join(' ') || (typeof r.name === 'string' ? r.name.trim() : '');
  if (name && ext) return `${name} (${ext})`;
  if (name) return name;
  if (ext) return ext;
  return String(r['callqueue-agent-id'] ?? '');
}

export function extractAgentName(r: Record<string, unknown>): string | undefined {
  const fullName = typeof r['name-full-name'] === 'string' ? r['name-full-name'].trim() : '';
  const first = typeof r['name-first-name'] === 'string' ? r['name-first-name'].trim() : '';
  const last = typeof r['name-last-name'] === 'string' ? r['name-last-name'].trim() : '';
  const name = fullName || [first, last].filter(Boolean).join(' ') || (typeof r.name === 'string' ? r.name.trim() : '');
  return name || undefined;
}

export async function resolveQueueAgent(
  client: GenericApiClient,
  opts: { queue?: unknown; agent?: unknown },
): Promise<QueueAgentResolution> {
  const rawAgent = opts.agent != null ? String(opts.agent).trim() : '';
  try {
    // 1. queue is the non-empty string or 'all'.
    const queue = opts.queue != null && String(opts.queue).trim() !== '' ? String(opts.queue).trim() : 'all';

    // 2. Self via resolveSelfIdentity. On failure: self_unresolved.
    let self: SelfIdentity;
    try {
      self = await resolveSelfIdentity(client);
    } catch {
      return {
        ok: false,
        reason: 'self_unresolved',
        message: 'Could not resolve your own extension, so nothing was changed.',
        candidate: rawAgent || '~',
      };
    }

    // 3. Candidate id: empty or ~ gives ${self.user}@${self.domain}; a value containing @ is used as given; a bare value gives ${value}@${self.domain}.
    const candidate = !rawAgent || rawAgent === '~'
      ? `${self.user}@${self.domain}`
      : rawAgent.includes('@')
        ? rawAgent
        : `${rawAgent}@${self.domain}`;

    const isSelf = candidate === `${self.user}@${self.domain}`;
    const selfName = isSelf ? self.name : undefined;

    // 4. queue === 'all': return ok with agentId = candidate and do no membership read.
    if (queue === 'all') {
      return {
        ok: true,
        queue: 'all',
        agentId: candidate,
        agentName: selfName,
      };
    }

    // 5. GET /domains/~/callqueues/{queue}: a 404 gives queue_not_found. On success, queueName is description. Ignore other failures.
    const queueRes = await client.request({
      method: 'GET',
      pathTemplate: '/domains/{domain}/callqueues/{queue}',
      pathParams: { domain: '~', queue },
    });

    if (!queueRes.success) {
      const is404 = Boolean(queueRes.error && /\b404\b|not found/i.test(queueRes.error));
      if (is404) {
        return {
          ok: false,
          reason: 'queue_not_found',
          message: `There is no call queue ${queue}, so nothing was changed.`,
          candidate,
        };
      }
    }

    const qData = (Array.isArray(queueRes.data) ? queueRes.data[0] : queueRes.data) as Record<string, unknown> | undefined;
    const queueName = qData && typeof qData.description === 'string' && qData.description.trim()
      ? qData.description.trim()
      : undefined;

    // 6. GET /domains/~/callqueues/{queue}/agents/{candidate}: an object means a member. agentId is the record's callqueue-agent-id.
    const agentRes = await client.request({
      method: 'GET',
      pathTemplate: '/domains/{domain}/callqueues/{queue}/agents/{agent}',
      pathParams: { domain: '~', queue, agent: candidate },
    });

    if (agentRes.success && agentRes.data) {
      const rec = (Array.isArray(agentRes.data) ? agentRes.data[0] : agentRes.data) as Record<string, unknown> | undefined;
      if (rec && typeof rec === 'object' && Object.keys(rec).length > 0 && !('error' in rec)) {
        const agentId = String(rec['callqueue-agent-id'] ?? candidate);
        const agentName = extractAgentName(rec) ?? selfName;
        const availabilityType = typeof rec['callqueue-agent-availability-type'] === 'string'
          ? rec['callqueue-agent-availability-type']
          : undefined;
        return {
          ok: true,
          queue,
          queueName,
          agentId,
          agentName,
          availabilityType,
          record: rec,
        };
      }
    }

    // 7. Otherwise GET /domains/~/callqueues/{queue}/agents: a record whose callqueue-agent-id or login-username equals the candidate is a member.
    const rosterRes = await client.request({
      method: 'GET',
      pathTemplate: '/domains/{domain}/callqueues/{queue}/agents',
      pathParams: { domain: '~', queue },
    });

    if (rosterRes.success && Array.isArray(rosterRes.data)) {
      const match = rosterRes.data.find((a: Record<string, unknown>) => {
        return a['callqueue-agent-id'] === candidate || a['login-username'] === candidate;
      }) as Record<string, unknown> | undefined;

      if (match) {
        const agentId = String(match['callqueue-agent-id'] ?? candidate);
        const agentName = extractAgentName(match) ?? selfName;
        const availabilityType = typeof match['callqueue-agent-availability-type'] === 'string'
          ? match['callqueue-agent-availability-type']
          : undefined;
        return {
          ok: true,
          queue,
          queueName,
          agentId,
          agentName,
          availabilityType,
          record: match,
        };
      }
    }

    // 8. not_an_agent message: ${who} is not an agent in ${where}, so nothing was changed., followed by Its agents are ${andList(names with extensions)}. when the roster was readable.
    const who = isSelf && self.name ? `${self.name} (${self.user})` : candidate;
    const where = queueName ? `the ${queueName} queue (${queue})` : `queue ${queue}`;
    let message = `${who} is not an agent in ${where}, so nothing was changed.`;

    if (rosterRes.success && Array.isArray(rosterRes.data) && rosterRes.data.length > 0) {
      const formatted = rosterRes.data.map((r: Record<string, unknown>) => formatAgentNameWithExt(r)).filter(Boolean);
      if (formatted.length > 0) {
        message += ` Its agents are ${andList(formatted)}.`;
      }
    }

    return {
      ok: false,
      reason: 'not_an_agent',
      message,
      candidate,
    };
  } catch {
    // resolveQueueAgent never throws
    return {
      ok: false,
      reason: 'self_unresolved',
      message: 'Could not resolve your own extension, so nothing was changed.',
      candidate: rawAgent || '~',
    };
  }
}
