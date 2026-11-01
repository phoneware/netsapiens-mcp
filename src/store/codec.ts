import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

export class StoreConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'StoreConfigError'; }
}
export class StoreLockedError extends Error {
  constructor(message: string) { super(message); this.name = 'StoreLockedError'; }
}
export class RetryableRefreshError extends Error {
  constructor(message = 'Timed out waiting for upstream token refresh') { super(message); this.name = 'RetryableRefreshError'; }
}
export class LeaseLostError extends Error {
  constructor(message = 'Refresh lease expired or owned by another instance') { super(message); this.name = 'LeaseLostError'; }
}

export function deriveStoreKey(sessionSecret: string): Buffer {
  if (sessionSecret.length < 32) throw new StoreConfigError('MCP_SESSION_SECRET must be at least 32 characters');
  return Buffer.from(hkdfSync('sha256', Buffer.from(sessionSecret), Buffer.from('netsapiens-mcp/store/v1'), Buffer.from('root'), 32));
}

export function createCodec(root: Uint8Array) {
  const idKey = Buffer.from(hkdfSync('sha256', root, '', 'id', 32));
  const encKey = Buffer.from(hkdfSync('sha256', root, '', 'enc', 32));
  return {
    id(purpose: 'session' | 'refresh' | 'code' | 'user', value: string): string {
      return createHmac('sha256', idKey).update(`${purpose}\0${value}`).digest('hex');
    },
    seal(value: unknown, aad: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encKey, iv);
      cipher.setAAD(Buffer.from(aad));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
    },
    open<T>(sealed: string, aad: string): T | undefined {
      try {
        const parts = sealed.split('.');
        if (parts.length !== 4 || parts[0] !== 'v1') return undefined;
        const iv = Buffer.from(parts[1], 'base64url');
        const tag = Buffer.from(parts[3], 'base64url');
        if (iv.length !== 12 || tag.length !== 16) return undefined;
        const decipher = createDecipheriv('aes-256-gcm', encKey, iv);
        decipher.setAAD(Buffer.from(aad));
        decipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8')) as T;
      } catch { return undefined; }
    },
  };
}
