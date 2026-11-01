import type { AtomicIssueParams, AtomicRedeemAndIssueParams } from './types.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createStore, REFRESH_RETRY_WINDOW_MS } from './store.js';
import type {
  AccessRow,
  AuthCodeRow,
  BackendRotateParams,
  BackendRotateResult,
  FamilyRow,
  RefreshPointerRow,
  McpStore,
  RevokeCondition,
  ResumeRow,
  SessionRow,
  StoreBackend,
  StoreCapabilities,
  UpstreamGrantRow,
} from './types.js';

export class MemoryBackend implements StoreBackend {
  readonly name = 'memory';
  readonly capabilities: StoreCapabilities = { persistent: false, multiInstance: false, exclusive: false, expiry: 'sweep' };
  readonly state = {
    access: new Map<string, AccessRow>(),
    refresh: new Map<string, RefreshPointerRow>(),
    families: new Map<string, FamilyRow>(),
    upstream: new Map<string, UpstreamGrantRow>(),
    retiredFamilies: new Map<string, string>(),
    authCodes: new Map<string, AuthCodeRow>(),
    resumeTokens: new Map<string, ResumeRow>(),
    usage: new Map<string, { userHash: string; toolName: string; count: number; lastUsed: number }>(),
    clients: new Map<string, OAuthClientInformationFull>(),
    sessions: new Map<string, SessionRow>(),
  };

  async getAccess(id: string): Promise<AccessRow | undefined> { return this.state.access.get(id); }
  async putAccess(row: AccessRow): Promise<void> { this.state.access.set(row.id, row); }
  async deleteAccess(id: string): Promise<void> { this.state.access.delete(id); }

  async getRefresh(id: string): Promise<RefreshPointerRow | undefined> { return this.state.refresh.get(id); }
  async putRefresh(row: RefreshPointerRow): Promise<void> { this.state.refresh.set(row.id, row); }
  async deleteRefresh(id: string): Promise<void> { this.state.refresh.delete(id); }

  async getFamily(id: string): Promise<FamilyRow | undefined> { return this.state.families.get(id); }
  async putFamily(row: FamilyRow): Promise<void> { this.state.families.set(row.id, row); }

  async atomicIssue(params: AtomicIssueParams): Promise<void> {
    this.state.access.set(params.accessRow.id, params.accessRow);
    this.state.refresh.set(params.refreshRow.id, params.refreshRow);
    this.state.families.set(params.familyRow.id, params.familyRow);
    this.state.upstream.set(params.upstreamRow.id, params.upstreamRow);
  }

  async getUpstream(id: string): Promise<UpstreamGrantRow | undefined> { return this.state.upstream.get(id); }
  async putUpstream(row: UpstreamGrantRow): Promise<void> { this.state.upstream.set(row.id, row); }
  async updateUpstream(id: string, mutate: (cur: UpstreamGrantRow) => UpstreamGrantRow | null | undefined): Promise<UpstreamGrantRow | undefined> {
    const cur = this.state.upstream.get(id);
    if (!cur) return undefined;
    const next = mutate(cur);
    if (next === null) { this.state.upstream.delete(id); return undefined; }
    if (next !== undefined) this.state.upstream.set(id, next);
    return next ?? cur;
  }

  async findFamilyByRetiredId(retiredId: string): Promise<FamilyRow | undefined> {
    const familyId = this.state.retiredFamilies.get(retiredId);
    return familyId ? this.state.families.get(familyId) : undefined;
  }

  async atomicRotate(params: BackendRotateParams): Promise<BackendRotateResult> {
    const oldRef = this.state.refresh.get(params.oldRefreshId);
    if (!oldRef) {
      let retiredFamilyId = this.state.retiredFamilies.get(params.oldRefreshId);
      if (!retiredFamilyId && params.legacyFingerprint) {
        retiredFamilyId = this.state.retiredFamilies.get(params.legacyFingerprint);
      }
      if (retiredFamilyId) {
        await this.atomicRevokeFamily(retiredFamilyId);
        return { status: 'replay', familyId: retiredFamilyId };
      }
      return { status: 'missing' };
    }

    const family = this.state.families.get(oldRef.familyId);
    if (!family || family.status !== 'active') return { status: 'missing' };

    if (oldRef.status === 'consumed') {
      const withinRetry = oldRef.consumedAt !== undefined && params.now - oldRef.consumedAt <= REFRESH_RETRY_WINDOW_MS;
      if (withinRetry && oldRef.successorSealed) {
        return {
          status: 'retry',
          familyId: family.id,
          generation: family.generation,
          successorSealed: oldRef.successorSealed,
        };
      }
      await this.atomicRevokeFamily(family.id);
      return { status: 'replay', familyId: family.id };
    }

    const nextGen = family.generation + 1;

    oldRef.status = 'consumed';
    oldRef.consumedAt = params.now;
    oldRef.successorSealed = params.newSuccessorSealed;

    if (params.retiredFingerprint) {
      this.state.retiredFamilies.set(params.retiredFingerprint, family.id);
    }

    if (family.currentAccessTokenId) {
      this.state.access.delete(family.currentAccessTokenId);
    }
    for (const row of this.state.refresh.values()) {
      if (row.familyId === family.id && row.consumedAt && params.now - row.consumedAt > REFRESH_RETRY_WINDOW_MS) {
        row.successorSealed = undefined;
      }
    }


    this.state.access.set(params.newAccessRow.id, {
      ...params.newAccessRow,
      familyId: family.id,
    });

    this.state.refresh.set(params.newRefreshRow.id, {
      ...params.newRefreshRow,
      familyId: family.id,
      generation: nextGen,
    });

    family.generation = nextGen;
    family.activeRefreshId = params.newRefreshRow.id;
    family.currentAccessTokenId = params.newAccessRow.id;
    family.sealed = params.newFamilySealed;
    family.updatedAt = params.now;

    if (params.newUpstreamSealed) {
      const upstream = this.state.upstream.get(family.id);
      if (upstream) {
        upstream.grantVersion += 1;
        upstream.sealed = params.newUpstreamSealed;
        if (params.newNsExpiresAt !== undefined) upstream.nsExpiresAt = params.newNsExpiresAt;
        upstream.updatedAt = params.now;
        upstream.leaseOwner = undefined;
        upstream.leaseUntil = undefined;
      }
    }

    return {
      status: 'claimed',
      familyId: family.id,
      generation: nextGen,
    };
  }

  async atomicRevokeFamily(familyId: string, condition?: RevokeCondition): Promise<'revoked' | 'stale' | 'missing'> {
    const family = this.state.families.get(familyId);
    if (!family) return 'missing';
    if (family.status !== 'active') return 'stale';

    if (condition?.expectedFamilyGeneration !== undefined && family.generation !== condition.expectedFamilyGeneration) {
      return 'stale';
    }
    if (condition?.expectedUpstreamGrantVersion !== undefined) {
      const upstream = this.state.upstream.get(familyId);
      if (upstream && upstream.grantVersion !== condition.expectedUpstreamGrantVersion) {
        return 'stale';
      }
    }
    if (condition?.expectedLeaseOwner !== undefined) {
      const upstream = this.state.upstream.get(familyId);
      if (upstream && upstream.leaseOwner !== condition.expectedLeaseOwner) {
        return 'stale';
      }
    }


    family.status = 'revoked';
    family.revokedAt = Date.now();
    family.generation += 1;
    family.updatedAt = Date.now();

    if (family.currentAccessTokenId) {
      this.state.access.delete(family.currentAccessTokenId);
    }
    this.state.upstream.delete(familyId);

    for (const row of this.state.refresh.values()) {
      if (row.familyId === familyId) {
        row.status = 'consumed';
        row.consumedAt = Date.now();
        row.successorSealed = undefined;
      }
    }
    return 'revoked';
  }

  async getSession(id: string): Promise<SessionRow | undefined> { return this.state.sessions.get(id); }
  async findSessionByRefreshId(id: string): Promise<SessionRow | undefined> { return [...this.state.sessions.values()].find(row => row.refreshId === id); }
  async putSession(row: SessionRow): Promise<void> { this.state.sessions.set(row.id, row); }
  async updateSession(id: string, mutate: (row: SessionRow) => SessionRow | null | undefined): Promise<SessionRow | undefined> {
    const current = this.state.sessions.get(id);
    if (!current) return undefined;
    const next = mutate(current);
    if (next === null) { this.state.sessions.delete(id); return undefined; }
    if (next !== undefined) this.state.sessions.set(id, next);
    return next ?? current;
  }
  async deleteSession(id: string): Promise<void> { this.state.sessions.delete(id); }

  async putAuthCode(row: AuthCodeRow): Promise<void> { this.state.authCodes.set(row.id, row); }
  async getAuthCode(id: string): Promise<AuthCodeRow | undefined> { return this.state.authCodes.get(id); }
  async takeAuthCode(id: string): Promise<AuthCodeRow | undefined> { const row = this.state.authCodes.get(id); this.state.authCodes.delete(id); return row; }
  async atomicRedeemCodeAndIssue(params: AtomicRedeemAndIssueParams): Promise<AuthCodeRow | undefined> {
    const row = this.state.authCodes.get(params.codeId);
    if (!row) return undefined;
    this.state.authCodes.delete(params.codeId);
    await this.atomicIssue(params.issue);
    return row;
  }
  async insertResumeIfAbsent(row: ResumeRow, now: number): Promise<boolean> {
    const current = this.state.resumeTokens.get(row.id);
    if (current && current.expiresAt > now) return false;
    this.state.resumeTokens.set(row.id, row); return true;
  }
  async incrementUsage(userHash: string, toolName: string, now: number): Promise<void> {
    const key = `${userHash}__${toolName}`;
    const current = this.state.usage.get(key);
    this.state.usage.set(key, { userHash, toolName, count: (current?.count ?? 0) + 1, lastUsed: now });
  }
  async listUsage(userHash: string): Promise<Array<{ toolName: string; count: number; lastUsed: number }>> {
    return [...this.state.usage.values()].filter(row => row.userHash === userHash).map(({ toolName, count, lastUsed }) => ({ toolName, count, lastUsed }));
  }
  async getClient(id: string): Promise<OAuthClientInformationFull | undefined> { return this.state.clients.get(id); }
  async putClient(client: OAuthClientInformationFull): Promise<void> { this.state.clients.set(client.client_id, client); }

  async sweep(now: number): Promise<number> {
    let count = 0;
    for (const [id, row] of this.state.access) {
      if (row.retainUntil <= now) {
        this.state.access.delete(id);
        count++;
      }
    }
    for (const [id, row] of this.state.authCodes) {
      if (row.expiresAt <= now) {
        this.state.authCodes.delete(id);
        count++;
      }
    }
    for (const [id, row] of this.state.resumeTokens) {
      if (row.expiresAt <= now) {
        this.state.resumeTokens.delete(id);
        count++;
      }
    }
    for (const [id, row] of this.state.sessions) {
      if (row.retainUntil <= now) {
        this.state.sessions.delete(id);
        count++;
      }
    }
    for (const row of this.state.refresh.values()) {
      if (row.consumedAt && now - row.consumedAt > REFRESH_RETRY_WINDOW_MS && row.successorSealed) {
        row.successorSealed = undefined;
      }
    }
    return count;
  }

  async close(): Promise<void> {
    for (const map of Object.values(this.state)) map.clear();
  }
}

export function createMemoryBackend(): MemoryBackend { return new MemoryBackend(); }
export function createMemoryStore({ namespace, key }: { namespace: string; key: Uint8Array }): McpStore {
  return createStore(createMemoryBackend(), { namespace, key });
}
