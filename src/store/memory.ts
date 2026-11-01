import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createStore } from './store.js';
import type { AuthCodeRow, ResumeRow, SessionRow, StoreBackend, StoreCapabilities } from './types.js';

export class MemoryBackend implements StoreBackend {
  readonly name = 'memory';
  readonly capabilities: StoreCapabilities = { persistent: false, multiInstance: false, exclusive: false, expiry: 'sweep' };
  readonly state = {
    sessions: new Map<string, SessionRow>(),
    authCodes: new Map<string, AuthCodeRow>(),
    resumeTokens: new Map<string, ResumeRow>(),
    usage: new Map<string, { userHash: string; toolName: string; count: number; lastUsed: number }>(),
    clients: new Map<string, OAuthClientInformationFull>(),
  };
  async getSession(id: string) { return this.state.sessions.get(id); }
  async findSessionByRefreshId(id: string) { return [...this.state.sessions.values()].find(row => row.refreshId === id); }
  async putSession(row: SessionRow) { this.state.sessions.set(row.id, row); }
  async updateSession(id: string, mutate: (row: SessionRow) => SessionRow | null | undefined) {
    const current = this.state.sessions.get(id);
    if (!current) return undefined;
    const next = mutate(current);
    if (next === null) { this.state.sessions.delete(id); return undefined; }
    if (next !== undefined) this.state.sessions.set(id, next);
    return next ?? current;
  }
  async deleteSession(id: string) { this.state.sessions.delete(id); }
  async putAuthCode(row: AuthCodeRow) { this.state.authCodes.set(row.id, row); }
  async getAuthCode(id: string) { return this.state.authCodes.get(id); }
  async takeAuthCode(id: string) { const row = this.state.authCodes.get(id); this.state.authCodes.delete(id); return row; }
  async insertResumeIfAbsent(row: ResumeRow, now: number) {
    const current = this.state.resumeTokens.get(row.id);
    if (current && current.expiresAt > now) return false;
    this.state.resumeTokens.set(row.id, row); return true;
  }
  async incrementUsage(userHash: string, toolName: string, now: number) {
    const key = `${userHash}__${toolName}`;
    const current = this.state.usage.get(key);
    this.state.usage.set(key, { userHash, toolName, count: (current?.count ?? 0) + 1, lastUsed: now });
  }
  async listUsage(userHash: string) { return [...this.state.usage.values()].filter(row => row.userHash === userHash).map(({ toolName, count, lastUsed }) => ({ toolName, count, lastUsed })); }
  async getClient(id: string) { return this.state.clients.get(id); }
  async putClient(client: OAuthClientInformationFull) { this.state.clients.set(client.client_id, client); }
  async sweep(now: number) {
    let count = 0;
    for (const [id, row] of this.state.sessions) if (row.retainUntil <= now) { this.state.sessions.delete(id); count++; }
    for (const [id, row] of this.state.authCodes) if (row.expiresAt <= now) { this.state.authCodes.delete(id); count++; }
    for (const [id, row] of this.state.resumeTokens) if (row.expiresAt <= now) { this.state.resumeTokens.delete(id); count++; }
    return count;
  }
  async close() { for (const map of Object.values(this.state)) map.clear(); }
}
export function createMemoryBackend(): MemoryBackend { return new MemoryBackend(); }
export function createMemoryStore({ namespace, key }: { namespace: string; key: Uint8Array }) {
  return createStore(createMemoryBackend(), { namespace, key });
}
