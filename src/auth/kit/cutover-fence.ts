import { AsyncLocalStorage } from 'node:async_hooks';
import { timingSafeEqual } from 'node:crypto';
import {
  CutoverFenceError,
  deriveStoreKey,
  assertSupportedCutoverNamespace,
  operationStorageId,
  type CutoverFenceConfig,
  withLegacyOperation as canonicalWithLegacyOperation,
  type LegacyOperationContext,
  type WithLegacyOperationOptions,
} from './cutover-protocol.mjs';

export * from './cutover-protocol.mjs';

/** Request-local context only. All durable fence behavior is canonical. */
export const requestOperationContext = new AsyncLocalStorage<LegacyOperationContext>();

export function normalizeFenceConfig(config?: CutoverFenceConfig): CutoverFenceConfig | undefined {
  if (!config?.enforce) return config;
  assertSupportedCutoverNamespace(config.namespace);
  const secret = process.env.MCP_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new CutoverFenceError('Fenced operation requires MCP_SESSION_SECRET of at least 32 characters');
  }
  const identityKey = deriveStoreKey(secret);
  if (config.identityKey &&
    (config.identityKey.length !== identityKey.length || !timingSafeEqual(config.identityKey, identityKey))) {
    throw new CutoverFenceError('Configured cutover identity key does not match the session secret');
  }
  return { ...config, identityKey };
}

export function requireFenceKey(config: CutoverFenceConfig): Uint8Array {
  if (!config.identityKey) throw new CutoverFenceError('Cutover identity key is required');
  return config.identityKey;
}

export function assertOperationKey(config: CutoverFenceConfig | undefined, operation: LegacyOperationContext | undefined): void {
  if (!config?.enforce || !operation) return;
  const expected = operationStorageId(config.namespace, operation.id, requireFenceKey(config));
  if (operation.namespace !== config.namespace || operation.storageId !== expected) {
    throw new CutoverFenceError('Operation identity does not match the configured cutover key');
  }
}

export async function withLegacyOperation<R>(
  options: WithLegacyOperationOptions,
  fn: (ctx: LegacyOperationContext) => Promise<R>,
): Promise<R> {
  const config = normalizeFenceConfig({ namespace: options.namespace, enforce: true, identityKey: options.identityKey });
  if (!config) throw new CutoverFenceError('Cutover configuration is required');
  return canonicalWithLegacyOperation({ ...options, identityKey: requireFenceKey(config) }, (ctx) =>
    requestOperationContext.run(ctx, () => fn(ctx)));
}
