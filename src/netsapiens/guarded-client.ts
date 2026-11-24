import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CompiledPolicy, PolicyDecision } from '../access/policy.js';
import type { GenericApiClient, NetSapiensApiResponse } from '../generated/types.js';
import { v1OperationKey } from '../governance/content-operations.js';
import type { ContentKind } from '../governance/types.js';
import type { NetSapiensClient } from '../netsapiens-client.js';
import type { AvailabilityContext } from './availability.js';
import { isDestructiveV1Action, normalizeOperationKey } from './operation-key.js';
import {
  expandPathTemplate,
  hasPlaceholder,
  operationKeyOfFinalPath,
  pathParameterRefusal,
  pathRefusalMessage,
} from './request-path.js';

export class GuardedNetSapiensClient implements GenericApiClient {
  constructor(
    public readonly rawClient: NetSapiensClient,
    public readonly availabilityContext: AvailabilityContext,
  ) {}

  async request<T = unknown>(opts: {
    method: string;
    pathTemplate: string;
    pathParams?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    body?: unknown;
    multipart?: { field: string; filename: string; base64: string; contentType?: string };
  }): Promise<NetSapiensApiResponse<T>> {
    const key = normalizeOperationKey(opts.method, opts.pathTemplate);
    if (!this.availabilityContext.isAvailable(key)) {
      const version = this.availabilityContext.versionInfo?.apiVersion ?? 'unknown';
      throw new Error(`Operation '${key}' is not available on this NetSapiens host (reported release: ${version}).`);
    }
    return this.rawClient.request<T>(opts);
  }
}

type RequestOptions = {
  method: string;
  pathTemplate: string;
  pathParams?: Record<string, string>;
  queryParams?: Record<string, unknown>;
  body?: unknown;
  multipart?: { field: string; filename: string; base64: string; contentType?: string };
};

/** The message for an operation the policy or a foreign target refuses. It says nothing about the target's enrollment. */
const NOT_PERMITTED = 'This operation is not permitted for this account.';

/**
 * A NetSapiens request the operation guard refused. It is raised before any HTTP request is sent. `operationKey` and
 * `reason` are for the audit log; the client sees `message` only.
 */
export class OperationRefusedError extends McpError {
  readonly operationKey: string;
  readonly reason: string;

  constructor(operationKey: string, reason: string, message: string) {
    super(ErrorCode.InvalidRequest, message);
    this.operationKey = operationKey;
    this.reason = reason;
  }
}

/** A verdict on one explicit foreign target (spec D3 (b)). */
export type ForeignVerdict =
  | { readonly kind: 'refuse'; readonly reason: string }
  /** `policy` is the target's own policy when its tenant is enrolled. Undefined when it is not, which adds nothing. */
  | { readonly kind: 'allow'; readonly policy?: CompiledPolicy };

/** The explicit targets a request may name, judged against the signed-in person's home domain. */
export interface ForeignTargets {
  /** The home domain, trimmed and lowercased. A request that names it has no foreign target. */
  readonly home: string;
  /** Judges one foreign target. A rejection refuses the request. */
  judge(domain: string): Promise<ForeignVerdict>;
}

/** What a NetSapiens request is, as the gate sees it before it is sent. */
export type GuardedOperation =
  | {
      readonly kind: 'v2';
      readonly method: string;
      readonly pathTemplate: string;
      readonly pathParams: Readonly<Record<string, unknown>> | undefined;
      readonly queryParams: Readonly<Record<string, unknown>> | undefined;
    }
  | {
      readonly kind: 'v1';
      readonly object: string;
      readonly action: string;
      readonly params: Readonly<Record<string, unknown>> | undefined;
    };

/** The check every NetSapiens request passes through in registry mode. */
export interface OperationGate {
  /** Resolves when the operation may be sent. Rejects with OperationRefusedError when it may not, before any HTTP request. */
  admit(op: GuardedOperation): Promise<void>;
}

export interface OperationGateOptions {
  readonly policy: CompiledPolicy;
  /** Absent when the caller cannot name a home domain. An explicit foreign target is then refused, since nothing judges it. */
  readonly targets?: ForeignTargets;
  /** Filled by admit(): the content kinds that the explicit foreign targets of this dispatch add to its projection. */
  readonly foreignStrip: Set<ContentKind>;
}

/** Explicit domains a request names, normalized. The self sentinel "~" and an empty value name no domain. */
function explicitDomains(values: readonly unknown[]): string[] {
  const domains = new Set<string>();
  for (const value of values) {
    const items: readonly unknown[] = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (item === undefined || item === null) continue;
      const domain = String(item).trim().toLowerCase();
      if (domain === '' || domain === '~') continue;
      domains.add(domain);
    }
  }
  return [...domains];
}

function refuseUnlessAllowed(operationKey: string, decision: PolicyDecision): void {
  if (!decision.allowed) throw new OperationRefusedError(operationKey, decision.reason, NOT_PERMITTED);
}

/**
 * Judges the explicit targets of one request (spec D3 (b)). The home domain is never judged. An enrolled target's
 * content denials refuse the operation, and its denied and stripped kinds are added to this dispatch's projection.
 */
async function admitTargets(
  operationKey: string,
  ref: { readonly kind: 'v2'; readonly method: string; readonly key: string } | { readonly kind: 'v1'; readonly action: string; readonly key: string },
  domains: readonly string[],
  options: OperationGateOptions,
): Promise<void> {
  for (const domain of domains) {
    if (options.targets !== undefined && domain === options.targets.home) continue;
    if (options.targets === undefined) {
      throw new OperationRefusedError(operationKey, 'foreign_target_unjudged', NOT_PERMITTED);
    }
    const verdict = await options.targets.judge(domain);
    if (verdict.kind === 'refuse') throw new OperationRefusedError(operationKey, verdict.reason, NOT_PERMITTED);
    if (verdict.policy === undefined) continue;
    const content = verdict.policy.operationDecision(ref);
    // The target's own content denials refuse a request aimed at it, and so does its read-only access (D3 (b)).
    if (!content.allowed && (content.reason.startsWith('content:') || content.reason === 'read_only')) {
      throw new OperationRefusedError(operationKey, `foreign:${content.reason}`, NOT_PERMITTED);
    }
    for (const kind of [...verdict.policy.deniedKinds, ...verdict.policy.strippedKinds]) {
      options.foreignStrip.add(kind);
    }
  }
}

/** A v1 call's object and action are form fields. A param that replaces either would send a different operation. */
const V1_IDENTITY_PARAMS = ['object', 'action'] as const;

async function admitV1(op: Extract<GuardedOperation, { kind: 'v1' }>, options: OperationGateOptions): Promise<void> {
  const key = v1OperationKey(op.object, op.action);
  for (const name of V1_IDENTITY_PARAMS) {
    const value = op.params?.[name];
    if (value !== undefined && value !== null) {
      throw new OperationRefusedError(key, `v1_identity_param:${name}`, NOT_PERMITTED);
    }
  }
  // A destructive v1 action is judged as the DELETE it performs, so the policy's destructive rule covers it (P2).
  const ref = isDestructiveV1Action(op.object, op.action)
    ? { kind: 'v2' as const, method: 'DELETE', key }
    : { kind: 'v1' as const, action: op.action, key };
  refuseUnlessAllowed(key, options.policy.operationDecision(ref));
  await admitTargets(key, ref, explicitDomains([op.params?.domain]), options);
}

async function admitV2(op: Extract<GuardedOperation, { kind: 'v2' }>, options: OperationGateOptions): Promise<void> {
  const key = normalizeOperationKey(op.method, op.pathTemplate);
  // Path values are checked before anything else: a value that moves the request has no operation to judge.
  const refusal = pathParameterRefusal(op.pathParams, true);
  if (refusal !== undefined) {
    throw new OperationRefusedError(key, `path_value:${refusal.reason}`, pathRefusalMessage(refusal.name, refusal.reason));
  }
  const expanded = expandPathTemplate(op.pathTemplate, op.pathParams);
  if (hasPlaceholder(expanded)) {
    throw new OperationRefusedError(key, 'path_parameter_missing', 'The request was not sent: a path parameter is missing.');
  }
  // The operation key must describe the path the HTTP layer sends, not only the template it was built from.
  if (operationKeyOfFinalPath(op.method, op.pathTemplate, expanded) !== key) {
    throw new OperationRefusedError(key, 'operation_key_mismatch', 'The request was not sent: its path is not the operation it names.');
  }
  const ref = { kind: 'v2' as const, method: op.method.toUpperCase(), key };
  refuseUnlessAllowed(key, options.policy.operationDecision(ref));
  await admitTargets(key, ref, explicitDomains([op.pathParams?.domain, op.queryParams?.domain]), options);
}

/** The gate a dispatch applies to every NetSapiens request it makes. */
export function createOperationGate(options: OperationGateOptions): OperationGate {
  return {
    async admit(op: GuardedOperation): Promise<void> {
      if (op.kind === 'v1') {
        await admitV1(op, options);
      } else {
        await admitV2(op, options);
      }
    },
  };
}

/** A method the registry-mode client does not expose. Calling it refuses, and it sends nothing. */
function refusedMethod(name: string): () => Promise<never> {
  return () => Promise.reject(new OperationRefusedError(`client.${name}`, 'method_not_permitted', NOT_PERMITTED));
}

/**
 * The registry-mode view of a client. Only request, v1Call, setApiToken and setApiUrl reach the target, and both
 * request paths pass the gate first. Every other method refuses, and every other property reads as undefined, so no
 * handler reaches the raw client or its configuration around the gate.
 */
function gatedClient(
  target: NetSapiensClient,
  availabilityContext: AvailabilityContext | undefined,
  gate: OperationGate,
): NetSapiensClient {
  return new Proxy(target, {
    get(proxied, prop, receiver) {
      if (prop === 'request') {
        return async function gatedRequest<T = unknown>(opts: RequestOptions): Promise<NetSapiensApiResponse<T>> {
          await gate.admit({
            kind: 'v2',
            method: opts.method,
            pathTemplate: opts.pathTemplate,
            pathParams: opts.pathParams,
            queryParams: opts.queryParams,
          });
          if (availabilityContext !== undefined) {
            const key = normalizeOperationKey(opts.method, opts.pathTemplate);
            if (!availabilityContext.isAvailable(key)) {
              const version = availabilityContext.versionInfo?.apiVersion ?? 'unknown';
              throw new Error(`Operation '${key}' is not available on this NetSapiens host (reported release: ${version}).`);
            }
          }
          // Redirects are refused: the gate judged the operation this request names, and only that operation may be reached.
          return proxied.request<T>({ ...opts, followRedirects: false });
        };
      }
      if (prop === 'v1Call') {
        return async function gatedV1Call<T = unknown>(
          object: string,
          action: string,
          params: Record<string, unknown> | undefined,
        ): Promise<NetSapiensApiResponse<T>> {
          await gate.admit({ kind: 'v1', object, action, params });
          // Redirects are refused, as for request: the gate judged the operation named, and only that operation may be reached.
          return proxied.v1Call<T>(object, action, params, { followRedirects: false });
        };
      }
      if (prop === 'setApiToken' || prop === 'setApiUrl') {
        const value = Reflect.get(proxied, prop, receiver);
        return typeof value === 'function' ? value.bind(proxied) : undefined;
      }
      if (prop === 'availabilityContext' || prop === '__availabilityContext') return availabilityContext;
      if (typeof prop === 'symbol') return Reflect.get(proxied, prop, receiver);
      const value = Reflect.get(proxied, prop, receiver);
      return typeof value === 'function' ? refusedMethod(prop) : undefined;
    },
  });
}

/**
 * Creates a guarded wrapper around a NetSapiensClient.
 *
 * Without `options.gate`, the wrapper intercepts `request(...)` to assert that the operation is available on the host
 * before any HTTP call is dispatched, exactly as it always has. With a gate, the wrapper is the registry-mode view
 * described on gatedClient, and availability is still asserted for `request`.
 */
export function createGuardedClient(
  rawClient: NetSapiensClient,
  availabilityContext: AvailabilityContext | undefined,
  options: { readonly gate?: OperationGate } = {},
): NetSapiensClient {
  // If already a guarded proxy, avoid double-wrapping
  const targetClient = '__rawClient' in rawClient && rawClient.__rawClient
    ? (rawClient.__rawClient as NetSapiensClient)
    : rawClient;
  if (options.gate !== undefined) return gatedClient(targetClient, availabilityContext, options.gate);
  return new Proxy(targetClient, {
    get(target, prop, receiver) {
      if (prop === '__rawClient' || prop === 'rawClient') {
        return target;
      }
      if (prop === '__availabilityContext' || prop === 'availabilityContext') {
        return availabilityContext;
      }
      if (prop === 'request') {
        return async function guardedRequest<T = unknown>(opts: RequestOptions): Promise<NetSapiensApiResponse<T>> {
          const key = normalizeOperationKey(opts.method, opts.pathTemplate);
          if (availabilityContext !== undefined && !availabilityContext.isAvailable(key)) {
            const version = availabilityContext.versionInfo?.apiVersion ?? 'unknown';
            throw new Error(`Operation '${key}' is not available on this NetSapiens host (reported release: ${version}).`);
          }
          return target.request<T>(opts);
        };
      }
      const val = Reflect.get(target, prop, receiver);
      if (typeof val === 'function') {
        return val.bind(target);
      }
      return val;
    },
  });
}
