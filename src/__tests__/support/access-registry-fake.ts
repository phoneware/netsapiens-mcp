/**
 * Fixtures for the access registry tests: an in-process registry that answers with the wire contract's JSON text, a
 * controllable clock, and the policy and identity values the tests share.
 */
import type { EnabledAccessRegistryConfig } from '../../access/config.js';
import type { AccessPolicyV1 } from '../../access/contract.js';
import type { FetchDecision, RegistryKey, RegistryRequest, RegistryResponse } from '../../access/registry-client.js';
import type { AccessIdentity } from '../../access/types.js';

export const TENANT = 'domain.com';
export const SUBJECT = 'alice@domain.com';
export const PLATFORM = 'https://fake.example.com';
/** A redirect URI the policy approves. */
export const REDIRECT = 'https://ai.example.com/cb';
/** A redirect URI no policy in these tests approves. */
export const OTHER_REDIRECT = 'https://other.example.com/cb';

const WALL_START = 1_700_000_000_000;

export function registryConfig(maxStaleSeconds = 600): EnabledAccessRegistryConfig {
  return {
    enabled: true,
    baseUrl: 'https://registry.example.com',
    auth: { mode: 'none' },
    connector: 'netsapiens-mcp',
    maxStaleSeconds,
    timeoutMs: 3000,
  };
}

/** A complete policy: read only, every content kind denied, unclassified output denied, one approved redirect. */
export function policy(patch: Partial<AccessPolicyV1> = {}): AccessPolicyV1 {
  return {
    tools: { allow: ['@curated'], deny: ['@destructive'] },
    access: 'read',
    content: {
      call_recording: 'deny',
      transcript: 'deny',
      voicemail: 'deny',
      sms_text: 'deny',
      ai_summary: 'deny',
      fax_page: 'deny',
    },
    unclassifiedOutput: 'deny',
    platforms: [REDIRECT],
    ...patch,
  };
}

export function identity(user = 'alice', tenant = TENANT): AccessIdentity {
  return {
    platform: PLATFORM,
    tenant,
    user,
    subject: `${user}@${tenant}`,
    role: 'Office Manager',
    tier: 'domain_admin',
  };
}

export type Answer =
  | { readonly decision: 'allow'; readonly revision: string; readonly policy: AccessPolicyV1; readonly ttlSeconds?: number }
  | { readonly decision: 'deny'; readonly reason: string };

/** The decision as the registry sends it on the wire, before it is serialized. */
export function wireDecision(answer: Answer): Record<string, unknown> {
  if (answer.decision === 'deny') {
    return { version: 1, decision: 'deny', reason: answer.reason, revision: '0', ttlSeconds: 60 };
  }
  return {
    version: 1,
    decision: 'allow',
    revision: answer.revision,
    ttlSeconds: answer.ttlSeconds ?? 60,
    policy: answer.policy,
  };
}

/**
 * A programmable registry. A subject answer (user@domain) wins over the tenant's answer (domain). With no answer a
 * tenant is not enrolled, as the registry itself would say. Setting `response` makes every request answer that way,
 * which is how a test takes the registry down or makes it answer something malformed.
 */
export class FakeRegistry {
  /** When set, every request gets this response, and the programmed answers are not consulted. */
  response: RegistryResponse | undefined = undefined;
  /** Every decision request the client sent, in order. */
  readonly seen: RegistryKey[] = [];
  private readonly answers = new Map<string, Answer>();

  set(match: string, answer: Answer): void {
    this.answers.set(match.toLowerCase(), answer);
  }

  readonly fetchDecision: FetchDecision = async ({ key }: RegistryRequest): Promise<RegistryResponse> => {
    this.seen.push(key);
    if (this.response !== undefined) return this.response;
    const answer: Answer =
      this.answers.get(key.subject) ?? this.answers.get(key.tenant) ?? { decision: 'deny', reason: 'tenant_not_enrolled' };
    return { kind: 'text', body: JSON.stringify(wireDecision(answer)) };
  };
}

/** Monotonic and wall-clock readings that move only when a test advances them. */
export class FakeClock {
  private elapsed = 0;

  readonly monotonic = (): number => 1_000 + this.elapsed;

  readonly wall = (): number => WALL_START + this.elapsed;

  advance(milliseconds: number): void {
    this.elapsed += milliseconds;
  }
}
