import { describe, expect, it } from 'vitest';
import { normalizeOperationKey } from '../netsapiens/operation-key.js';

describe('operation keys', () => {
  it('normalizes methods, suffixes and parameter segments', () => {
    expect(normalizeOperationKey('get', '/domains/{domain}/users/~/#17')).toBe('GET /domains/{}/users/{}');
    expect(normalizeOperationKey('post', '/')).toBe('POST /');
    expect(normalizeOperationKey('delete', '/thing#3')).toBe('DELETE /thing');
    expect(normalizeOperationKey('patch', '/x/{id}/y')).toBe('PATCH /x/{}/y');
  });
  it('rejects unsupported methods', () => {
    expect(() => normalizeOperationKey('HEAD', '/')).toThrow();
  });
});
