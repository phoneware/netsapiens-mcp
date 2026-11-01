// Copied from @phoneware/mcp-oauth-kit 1.0.0 (phoneware/monorepo packages/mcp-oauth-kit/src/ledger.ts at 8447d361111612739343ee0fb83a15c328db372d). Edit the canonical file, then re-copy.
import { createHash, randomUUID } from 'node:crypto';

export const REFRESH_RETRY_WINDOW_MS = 30_000;
export const DEFAULT_ACCESS_TOKEN_TTL_MS = 3_600_000;
export const MAX_RETIRED_REFRESH_FINGERPRINTS = 64;

export function refreshFingerprint(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('base64url');
}

export interface BaseStoredToken {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  refreshFamilyId?: string;
  expiresAt: number;
  scopes?: string[];
  [key: string]: unknown;
}

export interface StoredRefreshRecord<T extends BaseStoredToken> {
  status: 'active' | 'consumed';
  familyId: string;
  token: T;
  successorRefreshToken?: string;
  consumedAt?: number;
}

export interface StoredRefreshFamily {
  id: string;
  currentAccessToken: string;
  currentRefreshToken: string;
  previousAccessToken?: string;
  previousRefreshToken?: string;
  retiredRefreshFingerprints: string[];
  updatedAt?: number | string;
}

export type RefreshLookupResult<T extends BaseStoredToken> =
  | { status: 'active'; token: T; familyId: string }
  | { status: 'retry'; token: T; familyId: string }
  | { status: 'replay'; familyId?: string }
  | { status: 'missing' };

export type RefreshRotationResult<T extends BaseStoredToken> =
  | { status: 'claimed'; token: T }
  | { status: 'retry'; token: T }
  | { status: 'replay' }
  | { status: 'missing' };

export interface TokenLedger<T extends BaseStoredToken> {
  issue(token: T): Promise<T>;
  getByAccessToken(accessToken: string): Promise<T | undefined>;
  lookupRefresh(
    refreshToken: string,
    expectedClientId?: string,
    now?: number,
  ): Promise<RefreshLookupResult<T>>;
  rotate(
    oldRefreshToken: string,
    replacement: T,
    expectedClientId: string,
    now?: number,
  ): Promise<RefreshRotationResult<T>>;
  revokeFamily(familyId: string): Promise<void>;
  revokeByToken(token: string): Promise<void>;
}

export class MemoryTokenLedger<T extends BaseStoredToken> implements TokenLedger<T> {
  private readonly byAccess = new Map<string, T>();
  private readonly byRefresh = new Map<string, StoredRefreshRecord<T>>();
  private readonly families = new Map<string, StoredRefreshFamily>();
  private readonly retiredFamilies = new Map<string, string>();

  get size(): number {
    return this.byAccess.size;
  }

  async issue(token: T): Promise<T> {
    const familyId = token.refreshFamilyId ?? randomUUID();
    const stored: T = { ...token, refreshFamilyId: familyId };
    this.byAccess.set(stored.accessToken, stored);
    this.byRefresh.set(stored.refreshToken, {
      status: 'active',
      familyId,
      token: stored,
    });
    this.families.set(familyId, {
      id: familyId,
      currentAccessToken: stored.accessToken,
      currentRefreshToken: stored.refreshToken,
      retiredRefreshFingerprints: [],
      updatedAt: Date.now(),
    });
    return stored;
  }

  async getByAccessToken(accessToken: string): Promise<T | undefined> {
    return this.byAccess.get(accessToken);
  }

  async lookupRefresh(
    refreshToken: string,
    expectedClientId?: string,
    now: number = Date.now(),
  ): Promise<RefreshLookupResult<T>> {
    const record = this.byRefresh.get(refreshToken);
    if (!record) {
      const retiredFamilyId = this.retiredFamilies.get(refreshFingerprint(refreshToken));
      if (!retiredFamilyId) return { status: 'missing' };
      await this.revokeFamily(retiredFamilyId);
      return { status: 'replay', familyId: retiredFamilyId };
    }

    if (expectedClientId && record.token.clientId !== expectedClientId) {
      return { status: 'missing' };
    }

    const family = this.families.get(record.familyId);
    if (record.status === 'consumed') {
      const successor = record.successorRefreshToken
        ? this.byRefresh.get(record.successorRefreshToken)
        : undefined;
      const withinRetryWindow =
        record.consumedAt !== undefined && now - record.consumedAt <= REFRESH_RETRY_WINDOW_MS;
      if (
        withinRetryWindow &&
        family?.previousRefreshToken === refreshToken &&
        successor?.status === 'active' &&
        (!expectedClientId || successor.token.clientId === expectedClientId)
      ) {
        return { status: 'retry', token: successor.token, familyId: record.familyId };
      }
      await this.revokeFamily(record.familyId);
      return { status: 'replay', familyId: record.familyId };
    }

    return { status: 'active', token: record.token, familyId: record.familyId };
  }

  async rotate(
    oldRefreshToken: string,
    replacement: T,
    expectedClientId: string,
    now: number = Date.now(),
  ): Promise<RefreshRotationResult<T>> {
    const record = this.byRefresh.get(oldRefreshToken);
    if (!record) {
      const retiredFamilyId = this.retiredFamilies.get(refreshFingerprint(oldRefreshToken));
      if (!retiredFamilyId) return { status: 'missing' };
      await this.revokeFamily(retiredFamilyId);
      return { status: 'replay' };
    }

    if (record.token.clientId !== expectedClientId) {
      return { status: 'missing' };
    }

    const family = this.families.get(record.familyId);
    if (record.status === 'consumed') {
      const successor = record.successorRefreshToken
        ? this.byRefresh.get(record.successorRefreshToken)
        : undefined;
      const withinRetryWindow =
        record.consumedAt !== undefined && now - record.consumedAt <= REFRESH_RETRY_WINDOW_MS;
      if (
        withinRetryWindow &&
        family?.previousRefreshToken === oldRefreshToken &&
        successor?.status === 'active' &&
        successor.token.clientId === expectedClientId
      ) {
        return { status: 'retry', token: successor.token };
      }
      await this.revokeFamily(record.familyId);
      return { status: 'replay' };
    }

    const activeFamily: StoredRefreshFamily = family ?? {
      id: record.familyId,
      currentAccessToken: record.token.accessToken,
      currentRefreshToken: oldRefreshToken,
      retiredRefreshFingerprints: [],
    };
    const retired = [...activeFamily.retiredRefreshFingerprints];
    if (activeFamily.previousRefreshToken) {
      this.byAccess.delete(activeFamily.previousAccessToken ?? '');
      this.byRefresh.delete(activeFamily.previousRefreshToken);
      retired.push(refreshFingerprint(activeFamily.previousRefreshToken));
    }
    while (retired.length > MAX_RETIRED_REFRESH_FINGERPRINTS) {
      const evicted = retired.shift();
      if (evicted) this.retiredFamilies.delete(evicted);
    }
    for (const fingerprint of retired) {
      this.retiredFamilies.set(fingerprint, record.familyId);
    }

    const stored: T = { ...replacement, refreshFamilyId: record.familyId };
    this.byAccess.delete(record.token.accessToken);
    this.byAccess.set(stored.accessToken, stored);
    this.byRefresh.set(oldRefreshToken, {
      ...record,
      status: 'consumed',
      successorRefreshToken: stored.refreshToken,
      consumedAt: now,
    });
    this.byRefresh.set(stored.refreshToken, {
      status: 'active',
      familyId: record.familyId,
      token: stored,
    });
    this.families.set(record.familyId, {
      id: record.familyId,
      currentAccessToken: stored.accessToken,
      currentRefreshToken: stored.refreshToken,
      previousAccessToken: record.token.accessToken,
      previousRefreshToken: oldRefreshToken,
      retiredRefreshFingerprints: retired,
      updatedAt: now,
    });
    return { status: 'claimed', token: stored };
  }

  async revokeFamily(familyId: string): Promise<void> {
    const family = this.families.get(familyId);
    if (!family) return;
    this.byAccess.delete(family.currentAccessToken);
    this.byRefresh.delete(family.currentRefreshToken);
    if (family.previousAccessToken) this.byAccess.delete(family.previousAccessToken);
    if (family.previousRefreshToken) this.byRefresh.delete(family.previousRefreshToken);
    for (const fingerprint of family.retiredRefreshFingerprints) {
      if (this.retiredFamilies.get(fingerprint) === familyId) {
        this.retiredFamilies.delete(fingerprint);
      }
    }
    this.families.delete(familyId);
  }

  async revokeByToken(token: string): Promise<void> {
    const access = this.byAccess.get(token);
    if (access) {
      if (access.refreshFamilyId) {
        await this.revokeFamily(access.refreshFamilyId);
      } else {
        this.byAccess.delete(token);
      }
      return;
    }

    const refresh = this.byRefresh.get(token);
    if (refresh) {
      await this.revokeFamily(refresh.familyId);
      return;
    }

    const retiredFamilyId = this.retiredFamilies.get(refreshFingerprint(token));
    if (retiredFamilyId) {
      await this.revokeFamily(retiredFamilyId);
    }
  }

  toJSON(): string {
    return JSON.stringify({
      byAccess: Array.from(this.byAccess.entries()),
      byRefresh: Array.from(this.byRefresh.entries()),
      families: Array.from(this.families.entries()),
      retiredFamilies: Array.from(this.retiredFamilies.entries()),
    });
  }

  fromJSON(serialized: string): void {
    const data = JSON.parse(serialized) as {
      byAccess: [string, T][];
      byRefresh: [string, StoredRefreshRecord<T>][];
      families: [string, StoredRefreshFamily][];
      retiredFamilies: [string, string][];
    };
    this.byAccess.clear();
    this.byRefresh.clear();
    this.families.clear();
    this.retiredFamilies.clear();

    for (const [k, v] of data.byAccess) this.byAccess.set(k, v);
    for (const [k, v] of data.byRefresh) this.byRefresh.set(k, v);
    for (const [k, v] of data.families) this.families.set(k, v);
    for (const [k, v] of data.retiredFamilies) this.retiredFamilies.set(k, v);
  }
}
