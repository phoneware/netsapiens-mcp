import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OAuthManager } from '../oauth-manager.js';
import type { OAuthConfig, OAuthTokens } from '../oauth-manager.js';
import {
  OAUTH_CONFIG,
  MOCK_TOKEN_RESPONSE,
  MOCK_EXPIRED_TOKENS,
  MOCK_FRESH_TOKENS,
} from './fixtures.js';

// ── Mocks ──

vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
  },
}));

vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    chmod: vi.fn(),
    unlink: vi.fn(),
  },
}));

vi.mock('os', () => ({
  default: {
    homedir: vi.fn(() => '/mock-home'),
  },
}));

// Import mocked modules so we can configure them in tests
import axios from 'axios';
import fs from 'fs/promises';
import os from 'os';

const mockedAxios = vi.mocked(axios);
const mockedFs = vi.mocked(fs);
const mockedOs = vi.mocked(os);

describe('OAuthManager', () => {
  let manager: OAuthManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));
    vi.clearAllMocks();

    // Default: no saved tokens on disk
    mockedFs.readFile.mockRejectedValue(new Error('ENOENT'));
    mockedFs.writeFile.mockResolvedValue(undefined);
    mockedFs.mkdir.mockResolvedValue(undefined);
    mockedFs.chmod.mockResolvedValue(undefined);
    mockedFs.unlink.mockResolvedValue(undefined);

    manager = new OAuthManager(OAUTH_CONFIG);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ────────────────────────────────────────────
  // Constructor
  // ────────────────────────────────────────────
  describe('constructor', () => {
    it('should set the token file path under the home directory', () => {
      // The constructor calls os.homedir() to build the tokenFilePath.
      // We verify indirectly: loadTokens should read from the expected path.
      expect(mockedOs.homedir).toHaveBeenCalled();
    });

    it('should build tokenFilePath using os.homedir()', () => {
      // Trigger loadTokens so readFile is called; inspect the path argument.
      // We cannot access private tokenFilePath directly, but saveTokens and loadTokens reveal it.
      const expectedPath = '/mock-home/.netsapiens-mcp/oauth-tokens.json';
      // Force a getAccessToken -> loadTokens call
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'tok',
          refresh_token: 'ref',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });
      return manager.getAccessToken().then(() => {
        expect(mockedFs.readFile).toHaveBeenCalledWith(expectedPath, 'utf-8');
      });
    });
  });

  // ────────────────────────────────────────────
  // Token expiry (isTokenExpired)
  // ────────────────────────────────────────────
  describe('isTokenExpired (via getAccessToken)', () => {
    it('should return cached token when token is not expired', async () => {
      const now = Date.now();
      const freshTokens: OAuthTokens = {
        access_token: 'cached-token',
        refresh_token: 'ref',
        expires_in: 7200,
        token_type: 'Bearer',
        expires_at: now + 7200 * 1000, // far in the future
      };
      (manager as any).tokens = freshTokens;

      const token = await manager.getAccessToken();
      expect(token).toBe('cached-token');
      // Should not have called axios at all
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('should consider token expired when expires_at is in the past', async () => {
      const now = Date.now();
      (manager as any).tokens = {
        access_token: 'old-token',
        refresh_token: 'ref-token',
        expires_in: 3600,
        token_type: 'Bearer',
        expires_at: now - 1000,
      };

      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'refreshed-token',
          refresh_token: 'new-ref',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      const token = await manager.getAccessToken();
      expect(token).toBe('refreshed-token');
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });

    it('should consider token expired when within 5-minute buffer', async () => {
      const now = Date.now();
      // Token expires in 4 minutes (within the 5 minute buffer)
      (manager as any).tokens = {
        access_token: 'soon-expired',
        refresh_token: 'ref-token',
        expires_in: 3600,
        token_type: 'Bearer',
        expires_at: now + 4 * 60 * 1000,
      };

      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'refreshed-token',
          refresh_token: 'new-ref',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      const token = await manager.getAccessToken();
      expect(token).toBe('refreshed-token');
    });

    it('should NOT consider token expired when just outside 5-minute buffer', async () => {
      const now = Date.now();
      // Token expires in 6 minutes (outside the 5 minute buffer)
      (manager as any).tokens = {
        access_token: 'still-valid',
        refresh_token: 'ref-token',
        expires_in: 3600,
        token_type: 'Bearer',
        expires_at: now + 6 * 60 * 1000,
      };

      const token = await manager.getAccessToken();
      expect(token).toBe('still-valid');
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('should consider token expired when expires_at is missing', async () => {
      (manager as any).tokens = {
        access_token: 'no-expiry-token',
        refresh_token: 'ref-token',
        expires_in: 3600,
        token_type: 'Bearer',
        // no expires_at
      };

      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'refreshed-token',
          refresh_token: 'new-ref',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      const token = await manager.getAccessToken();
      expect(token).toBe('refreshed-token');
      expect(mockedAxios.post).toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────
  // getAccessToken flow
  // ────────────────────────────────────────────
  describe('getAccessToken flow', () => {
    it('should load and use stored tokens from file if valid', async () => {
      const now = Date.now();
      const storedTokens: OAuthTokens = {
        access_token: 'stored-token',
        refresh_token: 'stored-ref',
        expires_in: 7200,
        token_type: 'Bearer',
        expires_at: now + 7200 * 1000,
      };
      mockedFs.readFile.mockResolvedValueOnce(JSON.stringify(storedTokens));

      const token = await manager.getAccessToken();
      expect(token).toBe('stored-token');
      expect(mockedFs.readFile).toHaveBeenCalledWith(
        '/mock-home/.netsapiens-mcp/oauth-tokens.json',
        'utf-8',
      );
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('should refresh expired token using refresh_token grant', async () => {
      const now = Date.now();
      (manager as any).tokens = {
        access_token: 'expired-tok',
        refresh_token: 'my-refresh',
        expires_in: 3600,
        token_type: 'Bearer',
        expires_at: now - 1000,
      };

      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      const token = await manager.getAccessToken();
      expect(token).toBe('new-access');

      // Verify refresh grant was used
      const postCall = mockedAxios.post.mock.calls[0];
      const body = postCall[1] as string;
      expect(body).toContain('grant_type=refresh_token');
      expect(body).toContain('refresh_token=my-refresh');
    });

    it('should fall back to password grant when refresh fails', async () => {
      const now = Date.now();
      (manager as any).tokens = {
        access_token: 'expired-tok',
        refresh_token: 'bad-refresh',
        expires_in: 3600,
        token_type: 'Bearer',
        expires_at: now - 1000,
      };

      // First call (refresh) fails
      mockedAxios.post.mockRejectedValueOnce(new Error('Refresh rejected'));
      // Second call (password grant) succeeds
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'fallback-token',
          refresh_token: 'fallback-ref',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const token = await manager.getAccessToken();
      expect(token).toBe('fallback-token');
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);

      // Second call should be password grant
      const secondCallBody = mockedAxios.post.mock.calls[1][1] as string;
      expect(secondCallBody).toContain('grant_type=password');
      consoleSpy.mockRestore();
    });

    it('should authenticate fresh when no tokens exist', async () => {
      // readFile rejects (default mock), so no tokens loaded
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'brand-new-token',
          refresh_token: 'brand-new-ref',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      const token = await manager.getAccessToken();
      expect(token).toBe('brand-new-token');

      const body = mockedAxios.post.mock.calls[0][1] as string;
      expect(body).toContain('grant_type=password');
    });

    it('should not call loadTokens again if tokens are already loaded', async () => {
      const now = Date.now();
      (manager as any).tokens = {
        access_token: 'preloaded',
        refresh_token: 'ref',
        expires_in: 7200,
        token_type: 'Bearer',
        expires_at: now + 7200 * 1000,
      };

      await manager.getAccessToken();
      expect(mockedFs.readFile).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────
  // authenticate (password grant)
  // ────────────────────────────────────────────
  describe('authenticate (password grant)', () => {
    it('should send correct URLSearchParams with all required fields', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'new-token',
          refresh_token: 'new-ref',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      await manager.getAccessToken();

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://api.example.com/ns-api/oauth2/token/',
        expect.any(String),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );

      const body = mockedAxios.post.mock.calls[0][1] as string;
      const params = new URLSearchParams(body);
      expect(params.get('client_id')).toBe('test-client-id');
      expect(params.get('client_secret')).toBe('test-client-secret');
      expect(params.get('username')).toBe('testuser');
      expect(params.get('password')).toBe('testpass');
      expect(params.get('grant_type')).toBe('password');
    });

    it('should save tokens after successful authentication', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'saved-token',
          refresh_token: 'saved-ref',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      await manager.getAccessToken();

      expect(mockedFs.mkdir).toHaveBeenCalled();
      expect(mockedFs.writeFile).toHaveBeenCalled();
      expect(mockedFs.chmod).toHaveBeenCalled();
    });

    it('should calculate expires_at correctly from expires_in', async () => {
      const now = Date.now();
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'tok',
          refresh_token: 'ref',
          expires_in: 7200,
          token_type: 'Bearer',
        },
      });

      await manager.getAccessToken();

      const tokens = (manager as any).tokens as OAuthTokens;
      expect(tokens.expires_at).toBe(now + 7200 * 1000);
    });

    it('should propagate errors with a descriptive message', async () => {
      mockedAxios.post.mockRejectedValueOnce(new Error('Network timeout'));

      await expect(manager.getAccessToken()).rejects.toThrow(
        'OAuth authentication failed: Network timeout',
      );
    });

    it('should include the original error message in the thrown error', async () => {
      mockedAxios.post.mockRejectedValueOnce(new Error('401 Unauthorized'));

      await expect(manager.getAccessToken()).rejects.toThrow('401 Unauthorized');
    });
  });

  // ────────────────────────────────────────────
  // refreshAccessToken
  // ────────────────────────────────────────────
  describe('refreshAccessToken', () => {
    it('should send correct grant_type=refresh_token', async () => {
      const now = Date.now();
      (manager as any).tokens = {
        access_token: 'expired',
        refresh_token: 'valid-refresh',
        expires_in: 3600,
        token_type: 'Bearer',
        expires_at: now - 1000,
      };

      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'refreshed',
          refresh_token: 'new-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      await manager.getAccessToken();

      const body = mockedAxios.post.mock.calls[0][1] as string;
      const params = new URLSearchParams(body);
      expect(params.get('grant_type')).toBe('refresh_token');
    });

    it('should send the refresh_token in the request body', async () => {
      const now = Date.now();
      (manager as any).tokens = {
        access_token: 'expired',
        refresh_token: 'my-specific-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
        expires_at: now - 1000,
      };

      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'new-tok',
          refresh_token: 'new-ref',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      await manager.getAccessToken();

      const body = mockedAxios.post.mock.calls[0][1] as string;
      const params = new URLSearchParams(body);
      expect(params.get('refresh_token')).toBe('my-specific-refresh-token');
    });

    it('should send client_id and client_secret in refresh request', async () => {
      const now = Date.now();
      (manager as any).tokens = {
        access_token: 'expired',
        refresh_token: 'ref',
        expires_in: 3600,
        token_type: 'Bearer',
        expires_at: now - 1000,
      };

      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'new',
          refresh_token: 'new-ref',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      await manager.getAccessToken();

      const body = mockedAxios.post.mock.calls[0][1] as string;
      const params = new URLSearchParams(body);
      expect(params.get('client_id')).toBe('test-client-id');
      expect(params.get('client_secret')).toBe('test-client-secret');
    });

    it('should save new tokens after successful refresh', async () => {
      const now = Date.now();
      (manager as any).tokens = {
        access_token: 'expired',
        refresh_token: 'ref',
        expires_in: 3600,
        token_type: 'Bearer',
        expires_at: now - 1000,
      };

      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'refreshed',
          refresh_token: 'new-ref',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      await manager.getAccessToken();

      expect(mockedFs.writeFile).toHaveBeenCalled();
      const writeCall = mockedFs.writeFile.mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);
      expect(writtenData.access_token).toBe('refreshed');
      expect(writtenData.refresh_token).toBe('new-ref');
    });

    it('should post to the correct token endpoint URL', async () => {
      const now = Date.now();
      (manager as any).tokens = {
        access_token: 'expired',
        refresh_token: 'ref',
        expires_in: 3600,
        token_type: 'Bearer',
        expires_at: now - 1000,
      };

      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'tok',
          refresh_token: 'ref2',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      await manager.getAccessToken();

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://api.example.com/ns-api/oauth2/token/',
        expect.any(String),
        expect.any(Object),
      );
    });
  });

  // ────────────────────────────────────────────
  // Token storage - loadTokens
  // ────────────────────────────────────────────
  describe('loadTokens (via getAccessToken)', () => {
    it('should read from the correct file path', async () => {
      mockedFs.readFile.mockRejectedValueOnce(new Error('ENOENT'));
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'tok',
          refresh_token: 'ref',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      await manager.getAccessToken();

      expect(mockedFs.readFile).toHaveBeenCalledWith(
        '/mock-home/.netsapiens-mcp/oauth-tokens.json',
        'utf-8',
      );
    });

    it('should parse JSON from file and use loaded tokens', async () => {
      const now = Date.now();
      const storedTokens = {
        access_token: 'loaded-from-file',
        refresh_token: 'ref',
        expires_in: 7200,
        token_type: 'Bearer',
        expires_at: now + 7200 * 1000,
      };
      mockedFs.readFile.mockResolvedValueOnce(JSON.stringify(storedTokens));

      const token = await manager.getAccessToken();
      expect(token).toBe('loaded-from-file');
    });

    it('should set tokens to null when file does not exist', async () => {
      mockedFs.readFile.mockRejectedValueOnce(new Error('ENOENT: no such file'));
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'fresh',
          refresh_token: 'ref',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      // getAccessToken should fall through to authenticate
      const token = await manager.getAccessToken();
      expect(token).toBe('fresh');
      expect(mockedAxios.post).toHaveBeenCalled();
    });

    it('should set tokens to null on invalid JSON', async () => {
      mockedFs.readFile.mockResolvedValueOnce('not valid json {{{');
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'after-bad-json',
          refresh_token: 'ref',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      const token = await manager.getAccessToken();
      // JSON.parse throws, loadTokens catches, tokens = null, then authenticate
      expect(token).toBe('after-bad-json');
      expect(mockedAxios.post).toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────
  // Token storage - saveTokens
  // ────────────────────────────────────────────
  describe('saveTokens (via getAccessToken)', () => {
    it('should create directory with mkdir recursive', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'tok',
          refresh_token: 'ref',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      await manager.getAccessToken();

      expect(mockedFs.mkdir).toHaveBeenCalledWith(
        '/mock-home/.netsapiens-mcp',
        { recursive: true },
      );
    });

    it('should write tokens to file with JSON formatting', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'written-token',
          refresh_token: 'written-ref',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      await manager.getAccessToken();

      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        '/mock-home/.netsapiens-mcp/oauth-tokens.json',
        expect.any(String),
        'utf-8',
      );

      const writtenContent = mockedFs.writeFile.mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenContent);
      expect(parsed.access_token).toBe('written-token');
      expect(parsed.refresh_token).toBe('written-ref');
      expect(parsed.expires_at).toBeDefined();
    });

    it('should set file permissions to 0o600', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'tok',
          refresh_token: 'ref',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      await manager.getAccessToken();

      expect(mockedFs.chmod).toHaveBeenCalledWith(
        '/mock-home/.netsapiens-mcp/oauth-tokens.json',
        0o600,
      );
    });

    it('should not attempt to save when tokens are null', async () => {
      // Directly call saveTokens via a scenario where tokens remain null.
      // Since saveTokens is private we cannot call it directly, but we can
      // verify that if tokens is null the fs methods are not invoked for save.
      // clearTokens sets tokens to null but does not call saveTokens.
      // We verify by ensuring writeFile is not called after clearTokens.
      const now = Date.now();
      (manager as any).tokens = {
        access_token: 'tok',
        refresh_token: 'ref',
        expires_in: 3600,
        token_type: 'Bearer',
        expires_at: now + 7200 * 1000,
      };

      vi.clearAllMocks();
      await manager.clearTokens();

      // clearTokens should call unlink but not writeFile
      expect(mockedFs.writeFile).not.toHaveBeenCalled();
      expect(mockedFs.mkdir).not.toHaveBeenCalled();
    });

    it('should log error but not throw when save fails', async () => {
      mockedFs.mkdir.mockRejectedValueOnce(new Error('Permission denied'));
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'tok',
          refresh_token: 'ref',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Should not throw even though save fails
      const token = await manager.getAccessToken();
      expect(token).toBe('tok');
      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to save OAuth tokens:',
        expect.any(Error),
      );

      consoleSpy.mockRestore();
    });
  });

  // ────────────────────────────────────────────
  // clearTokens
  // ────────────────────────────────────────────
  describe('clearTokens', () => {
    it('should set tokens to null', async () => {
      (manager as any).tokens = { ...MOCK_FRESH_TOKENS };

      await manager.clearTokens();

      expect((manager as any).tokens).toBeNull();
    });

    it('should delete the token file', async () => {
      await manager.clearTokens();

      expect(mockedFs.unlink).toHaveBeenCalledWith(
        '/mock-home/.netsapiens-mcp/oauth-tokens.json',
      );
    });

    it('should handle missing file gracefully', async () => {
      mockedFs.unlink.mockRejectedValueOnce(new Error('ENOENT'));

      // Should not throw
      await expect(manager.clearTokens()).resolves.toBeUndefined();
    });

    it('should allow re-authentication after clearing tokens', async () => {
      const now = Date.now();
      (manager as any).tokens = {
        access_token: 'old',
        refresh_token: 'old-ref',
        expires_in: 3600,
        token_type: 'Bearer',
        expires_at: now + 7200 * 1000,
      };

      await manager.clearTokens();
      expect((manager as any).tokens).toBeNull();

      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'brand-new',
          refresh_token: 'brand-new-ref',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      const token = await manager.getAccessToken();
      expect(token).toBe('brand-new');
    });
  });

  // ────────────────────────────────────────────
  // Time-dependent behavior with fake timers
  // ────────────────────────────────────────────
  describe('time-dependent behavior', () => {
    it('should return cached token when expires_at is exactly 5 min 1 sec away', async () => {
      const now = Date.now();
      const fiveMinutesOneSecond = 5 * 60 * 1000 + 1000;
      (manager as any).tokens = {
        access_token: 'barely-valid',
        refresh_token: 'ref',
        expires_in: 3600,
        token_type: 'Bearer',
        expires_at: now + fiveMinutesOneSecond,
      };

      const token = await manager.getAccessToken();
      expect(token).toBe('barely-valid');
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('should consider token expired at exactly the 5-minute boundary', async () => {
      const now = Date.now();
      const exactlyFiveMinutes = 5 * 60 * 1000;
      (manager as any).tokens = {
        access_token: 'boundary-token',
        refresh_token: 'ref',
        expires_in: 3600,
        token_type: 'Bearer',
        expires_at: now + exactlyFiveMinutes,
      };

      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'refreshed',
          refresh_token: 'new-ref',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      const token = await manager.getAccessToken();
      // now >= (now + 5min) - 5min => now >= now => true => expired
      expect(token).toBe('refreshed');
    });

    it('should refresh token after time advances past expiry', async () => {
      const now = Date.now();
      (manager as any).tokens = {
        access_token: 'was-valid',
        refresh_token: 'ref',
        expires_in: 3600,
        token_type: 'Bearer',
        expires_at: now + 3600 * 1000,
      };

      // Initially the token is valid
      const token1 = await manager.getAccessToken();
      expect(token1).toBe('was-valid');
      expect(mockedAxios.post).not.toHaveBeenCalled();

      // Advance time past expiration (including 5 min buffer)
      vi.advanceTimersByTime(3600 * 1000);

      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'time-advanced-token',
          refresh_token: 'new-ref',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      const token2 = await manager.getAccessToken();
      expect(token2).toBe('time-advanced-token');
    });

    it('should compute correct expires_at based on current time', async () => {
      // Set a specific time
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
      const expectedNow = new Date('2025-01-01T00:00:00Z').getTime();

      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'tok',
          refresh_token: 'ref',
          expires_in: 1800,
          token_type: 'Bearer',
        },
      });

      await manager.getAccessToken();

      const tokens = (manager as any).tokens as OAuthTokens;
      expect(tokens.expires_at).toBe(expectedNow + 1800 * 1000);
    });
  });

  // ────────────────────────────────────────────
  // Edge cases
  // ────────────────────────────────────────────
  describe('edge cases', () => {
    it('should handle token response that includes a scope field', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'scoped-token',
          refresh_token: 'ref',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'read write',
        },
      });

      const token = await manager.getAccessToken();
      expect(token).toBe('scoped-token');

      const tokens = (manager as any).tokens as OAuthTokens;
      expect(tokens.scope).toBe('read write');
    });

    it('should handle consecutive getAccessToken calls without re-authenticating', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'first-call-token',
          refresh_token: 'ref',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      const token1 = await manager.getAccessToken();
      const token2 = await manager.getAccessToken();
      const token3 = await manager.getAccessToken();

      expect(token1).toBe('first-call-token');
      expect(token2).toBe('first-call-token');
      expect(token3).toBe('first-call-token');
      // Should only have authenticated once
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });

    it('should use fixture MOCK_FRESH_TOKENS correctly as cached tokens', async () => {
      // Re-create with a known time-safe fixture
      const now = Date.now();
      (manager as any).tokens = {
        ...MOCK_FRESH_TOKENS,
        expires_at: now + 7200 * 1000, // override to be relative to fake timer
      };

      const token = await manager.getAccessToken();
      expect(token).toBe('fresh-access-token');
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });
});
