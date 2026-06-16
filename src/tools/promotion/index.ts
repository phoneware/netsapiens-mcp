/**
 * Per-user tool promotion logic.
 *
 * Reads the user's call_api usage from the usage store and returns the set of
 * generated tool names that have crossed the promotion threshold within the
 * configured window. The registry layer (`src/tools/index.ts`) consults this
 * and appends those tools to the user's exposed catalog — subject to all
 * existing filters (disable, role, destructive, security stripping).
 */

import { getUsageStore } from './usage-store.js';
import { logger } from '../../utils/logger.js';

export { getUsageStore, _resetUsageStoreForTests } from './usage-store.js';
export type { UsageRecord, UsageStore } from './usage-store.js';

const DEFAULT_THRESHOLD = 3;
const DEFAULT_WINDOW_DAYS = 14;

function promotionEnabled(): boolean {
  return process.env.MCP_DISABLE_PROMOTION !== 'true';
}

function getThreshold(): number {
  const raw = process.env.MCP_PROMOTE_THRESHOLD;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_THRESHOLD;
}

function getWindowMs(): number {
  const raw = process.env.MCP_PROMOTE_WINDOW_DAYS;
  const parsed = raw ? Number.parseFloat(raw) : NaN;
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WINDOW_DAYS;
  return Math.round(days * 24 * 60 * 60 * 1000);
}

/**
 * Returns the names of tools that should be promoted into the user's default
 * tool list. Empty when promotion is disabled or the user is unknown.
 */
export async function getPromotedToolNames(userKey: string | undefined): Promise<string[]> {
  if (!userKey || !promotionEnabled()) return [];
  const threshold = getThreshold();
  const windowMs = getWindowMs();
  const cutoff = Date.now() - windowMs;
  try {
    const usage = await getUsageStore().getUserUsage(userKey);
    const names: string[] = [];
    for (const [name, rec] of usage) {
      if (rec.count >= threshold && rec.lastUsed >= cutoff) names.push(name);
    }
    return names;
  } catch (err) {
    logger.warn('getPromotedToolNames failed', { userKey, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/**
 * Best-effort record of a successful call_api invocation. Returns whether
 * THIS call took the tool over the promotion threshold (so the caller can
 * send notifications/tools/list_changed once, not on every subsequent call).
 */
export async function recordCallApiInvocation(
  userKey: string | undefined,
  toolName: string,
): Promise<{ promoted: boolean }> {
  if (!userKey || !promotionEnabled()) return { promoted: false };
  const store = getUsageStore();
  try {
    await store.recordCall(userKey, toolName);
    const usage = await store.getUserUsage(userKey);
    const rec = usage.get(toolName);
    const threshold = getThreshold();
    // True only when the freshly-incremented count lands exactly on the
    // threshold. Anything above it means we already promoted on a previous
    // call and the client has already re-listed.
    const promoted = rec?.count === threshold;
    return { promoted };
  } catch {
    // Usage tracking must never bubble up — already logged inside the store.
    return { promoted: false };
  }
}
