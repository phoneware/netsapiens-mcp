/**
 * Per-user tool-usage tracking. Powers automatic promotion of frequently-
 * used generated tools into the user's default tool list.
 */

import type { UsageRecord, UsageStore } from '../../store/types.js';

export type { UsageRecord, UsageStore } from '../../store/types.js';

let singleton: UsageStore | null = null;

export function setUsageStore(store: UsageStore): void {
 singleton = store;
}

export function getUsageStore(): UsageStore {
 if (!singleton) throw new Error('usage store not configured');
 return singleton;
}

export function _resetUsageStoreForTests(store?: UsageStore): void {
 singleton = store ?? null;
}
