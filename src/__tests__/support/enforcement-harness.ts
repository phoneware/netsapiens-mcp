/**
 * Shared plumbing for the access enforcement suites: the fake NetSapiens with every route module they use, a stand-in
 * MCP server that records the handlers registerAllTools installs, and the auth info a signed-in session carries.
 */
import { vi, type Mock } from 'vitest';
import { startFakeNetSapiens } from '../../../scripts/fake-netsapiens/index.mjs';
import { cdrsRoute } from '../../../scripts/fake-netsapiens/routes/cdrs.mjs';
import { messagesRoute } from '../../../scripts/fake-netsapiens/routes/messages.mjs';
import { recordingsRoute } from '../../../scripts/fake-netsapiens/routes/recordings.mjs';
import { transcriptionsRoute } from '../../../scripts/fake-netsapiens/routes/transcriptions.mjs';
import { v1Route } from '../../../scripts/fake-netsapiens/routes/v1.mjs';
import { redirectsRoute } from '../../../scripts/fake-netsapiens/routes/redirects.mjs';
import { voicemailsRoute } from '../../../scripts/fake-netsapiens/routes/voicemails.mjs';
import type { AccessPolicyV1, ContentKind } from '../../access/contract.js';

/** One request the fake received, as its request log records it. */
export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string | string[]>;
  readonly body: unknown;
  readonly hasAuth: boolean;
  readonly headers: Record<string, unknown>;
}

export interface FakeNetSapiens {
  readonly origin: string;
  readonly requests: FakeRequest[];
  close(): Promise<void>;
}

export const ROUTE_MODULES = [cdrsRoute, recordingsRoute, transcriptionsRoute, messagesRoute, voicemailsRoute, v1Route, redirectsRoute];

export async function startFake(): Promise<FakeNetSapiens> {
  return startFakeNetSapiens({ apiVersion: '44.4.10', routeModules: ROUTE_MODULES });
}

export type RequestHandler = (request: unknown, extra: unknown) => Promise<unknown>;

export interface ElicitationReply {
  readonly action: string;
  readonly content?: Record<string, unknown>;
}

/** A stand-in server: it records the handlers registerAllTools installs and exposes the elicitation and notify calls. */
export interface StandInServer {
  readonly server: {
    setRequestHandler(schema: unknown, handler: RequestHandler): void;
    elicitInput: Mock;
    sendToolListChanged: Mock;
  };
  readonly elicitInput: Mock;
  readonly sendToolListChanged: Mock;
  invoke(schema: unknown, request: unknown, extra?: unknown): Promise<unknown>;
}

export function standInServer(reply: ElicitationReply = { action: 'accept', content: { confirm: 'yes' } }): StandInServer {
  const handlers = new Map<unknown, RequestHandler>();
  const elicitInput = vi.fn(async () => reply);
  const sendToolListChanged = vi.fn(async () => undefined);
  const server = {
    setRequestHandler(schema: unknown, handler: RequestHandler): void {
      handlers.set(schema, handler);
    },
    elicitInput,
    sendToolListChanged,
  };
  return {
    server,
    elicitInput,
    sendToolListChanged,
    invoke(schema: unknown, request: unknown, extra?: unknown): Promise<unknown> {
      const handler = handlers.get(schema);
      if (handler === undefined) throw new Error('no handler installed for this schema');
      return handler(request, extra);
    },
  };
}

/** The auth info a signed-in session carries: the reserved keys the registry sign-in writes. */
export function authExtra(apiUrl: string, overrides: Record<string, unknown> = {}): { authInfo: { extra: Record<string, unknown> } } {
  return {
    authInfo: {
      extra: { nsDomain: 'example.com', nsUser: 'alice', nsScope: 'Office Manager', nsApiUrl: apiUrl, ...overrides },
    },
  };
}

export const ALL_CONTENT_ALLOWED: Record<ContentKind, 'allow'> = {
  call_recording: 'allow',
  transcript: 'allow',
  voicemail: 'allow',
  sms_text: 'allow',
  ai_summary: 'allow',
  fax_page: 'allow',
};

/** A registry policy that allows everything unless overridden. */
export function policyOf(overrides: Partial<AccessPolicyV1> = {}): AccessPolicyV1 {
  return {
    tools: { allow: ['*'], deny: [] },
    access: 'write',
    content: { ...ALL_CONTENT_ALLOWED },
    unclassifiedOutput: 'allow',
    platforms: ['*'],
    ...overrides,
  };
}

/** The text of a single-block tool result. Anything else fails the test rather than being read loosely. */
export function textOf(result: unknown): string {
  if (typeof result === 'object' && result !== null && 'content' in result && Array.isArray(result.content)) {
    const first: unknown = result.content[0];
    if (typeof first === 'object' && first !== null && 'text' in first && typeof first.text === 'string') return first.text;
  }
  throw new Error('expected a single text block');
}
