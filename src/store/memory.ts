import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createStore } from './store.js';
import type { AuthCodeRow, ResumeRow, SessionRow, StoreBackend, StoreCapabilities } from './types.js';

export class MemoryBackend implements StoreBackend {
  readonly name = 'memory';
  readonly capabilities: StoreCapabilities = { persistent: false, multiInstance: false, exclusive: false, expiry: 'sweep' };
  private sessions = new Map<string, SessionRow>();
  private codes = new Map<string, AuthCodeRow>();
  private resumes = new Map<string, ResumeRow>();
  private clients = new Map<string, OAuthClientInformationFull>();
  private usage = new Map<string, Map<string, { count: number; lastUsed: number }>>();
  async getSession(id: string) { return this.sessions.get(id); }
  async findSessionByRefreshId(id: string) { return [...this.sessions.values()].find(row => row.refreshId === id); }
  async putSession(row: SessionRow) { this.sessions.set(row.id, row); }
  async updateSession(id: string, mutate: (row: SessionRow) => SessionRow | null | undefined) {
    const current = this.sessions.get(id);
    if (!current) return undefined;
    const next = mutate(current);
    if (next === null) { this.sessions.delete(id); return undefined; }
    if (next !== undefined) this.sessions.set(id, next);
    return next ?? current;
  }
  async deleteSession(id: string) { this.sessions.delete(id); }
  async putAuthCode(row: AuthCodeRow) { this.codes.set(row.id, row); }
  async getAuthCode(id: string) { return this.codes.get(id); }
  async takeAuthCode(id: string) { const row = this.codes.get(id); this.codes.delete(id); return row; }
  async insertResumeIfAbsent(row: ResumeRow, now: number) {
    const current = this.resumes.get(row.id);
    if (current && current.expiresAt > now) return false;
    this.resumes.set(row.id, row); return true;
  }
  async incrementUsage(user: string, tool: string, now: number) {
    let tools = this.usage.get(user); if (!tools) { tools = new Map(); this.usage.set(user, tools); }
    const current = tools.get(tool); tools.set(tool, { count: (current?.count ?? 0) + 1, lastUsed: now });
  }
  async listUsage(user: string) { return [...(this.usage.get(user) ?? new Map()).entries()].map(([toolName, record]) => ({ toolName, ...record })); }
  async getClient(id: string) { return this.clients.get(id); }
  async putClient(client: OAuthClientInformationFull) { this.clients.set(client.client_id, client); }
  async sweep(now: number) {
    let count = 0;
    for (const [id, row] of this.sessions) if (row.retainUntil <= now) { this.sessions.delete(id); count++; }
    for (const [id, row] of this.codes) if (row.expiresAt <= now) { this.codes.delete(id); count++; }
    for (const [id, row] of this.resumes) if (row.expiresAt <= now) { this.resumes.delete(id); count++; }
    return count;
  }
  async close() { this.sessions.clear(); this.codes.clear(); this.resumes.clear(); this.clients.clear(); this.usage.clear(); }
}

export function createMemoryStore({ namespace, key }: { namespace: string; key: Uint8Array }) {
  return createStore(new MemoryBackend(), { namespace, key });
}
