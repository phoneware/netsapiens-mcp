import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AxiosInstance } from 'axios';
import axios from 'axios';
import { NetSapiensClient } from '../netsapiens-client.js';
import { OAuthManager } from '../oauth-manager.js';
import {
  STATIC_TOKEN_CONFIG,
  OAUTH_NS_CONFIG,
  MOCK_USERS,
  MOCK_DOMAINS,
  MOCK_CDR_RECORDS,
  MOCK_DEVICES,
  MOCK_PHONE_NUMBERS,
  MOCK_CALL_QUEUES,
  MOCK_AGENTS,
} from './fixtures.js';

// ── Mocks ──

vi.mock('axios');
vi.mock('../oauth-manager.js');

// ── Helpers ──

/** Build a fresh mock AxiosInstance and wire axios.create to return it. */
function createMockAxios() {
  let requestInterceptor: ((config: any) => any) | undefined;

  const mockInstance = {
    get: vi.fn(),
    post: vi.fn(),
    interceptors: {
      request: {
        use: vi.fn((onFulfilled: any) => {
          requestInterceptor = onFulfilled;
        }),
      },
      response: {
        use: vi.fn(),
      },
    },
  } as unknown as AxiosInstance;

  vi.mocked(axios.create).mockReturnValue(mockInstance);

  return {
    mockInstance,
    /** Retrieve the request interceptor callback captured during construction. */
    getRequestInterceptor: () => requestInterceptor!,
  };
}

// ── Tests ──

describe('NetSapiensClient', () => {
  let mockAxios: ReturnType<typeof createMockAxios>;
  let client: NetSapiensClient;

  // ────────────────────────────────────────────
  // Constructor
  // ────────────────────────────────────────────
  describe('constructor', () => {
    it('should create an axios instance with correct baseURL, timeout, and headers', () => {
      mockAxios = createMockAxios();
      client = new NetSapiensClient(STATIC_TOKEN_CONFIG);

      expect(axios.create).toHaveBeenCalledWith({
        baseURL: 'https://api.example.com/ns-api/v2',
        timeout: 5000,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'NetSapiens-MCP/1.1.1',
        },
      });
    });

    it('should default timeout to 30000 when not provided', () => {
      mockAxios = createMockAxios();
      client = new NetSapiensClient({ apiUrl: 'https://api.example.com', apiToken: 'tok' });

      expect(axios.create).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 30000 }),
      );
    });

    it('should register request and response interceptors', () => {
      mockAxios = createMockAxios();
      client = new NetSapiensClient(STATIC_TOKEN_CONFIG);

      expect(mockAxios.mockInstance.interceptors.request.use).toHaveBeenCalledTimes(1);
      expect(mockAxios.mockInstance.interceptors.response.use).toHaveBeenCalledTimes(1);
    });

    it('should create OAuthManager when oauth config is provided', () => {
      mockAxios = createMockAxios();
      client = new NetSapiensClient(OAUTH_NS_CONFIG);

      expect(OAuthManager).toHaveBeenCalledWith({
        apiUrl: 'https://api.example.com',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        username: 'testuser',
        password: 'testpass',
      });
    });
  });

  // ────────────────────────────────────────────
  // Request interceptor
  // ────────────────────────────────────────────
  describe('request interceptor', () => {
    it('should add static Bearer token when apiToken is configured', async () => {
      mockAxios = createMockAxios();
      client = new NetSapiensClient(STATIC_TOKEN_CONFIG);

      const interceptor = mockAxios.getRequestInterceptor();
      const config = { headers: {} as Record<string, string> };

      const result = await interceptor(config);

      expect(result.headers.Authorization).toBe('Bearer test-static-token');
    });

    it('should add OAuth Bearer token when oauth is configured', async () => {
      mockAxios = createMockAxios();
      const mockGetAccessToken = vi.fn().mockResolvedValue('oauth-token-abc');
      vi.mocked(OAuthManager).mockImplementation(function (this: any) {
        this.getAccessToken = mockGetAccessToken;
      } as any);

      client = new NetSapiensClient(OAUTH_NS_CONFIG);

      const interceptor = mockAxios.getRequestInterceptor();
      const config = { headers: {} as Record<string, string> };

      const result = await interceptor(config);

      expect(mockGetAccessToken).toHaveBeenCalled();
      expect(result.headers.Authorization).toBe('Bearer oauth-token-abc');
    });
  });

  // ────────────────────────────────────────────
  // API methods – success paths
  // ────────────────────────────────────────────
  describe('API methods', () => {
    beforeEach(() => {
      mockAxios = createMockAxios();
      client = new NetSapiensClient(STATIC_TOKEN_CONFIG);
    });

    // searchUsers
    it('searchUsers should GET the wildcard endpoint with query params', async () => {
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: MOCK_USERS });

      const result = await client.searchUsers('john');

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith('/domains/~/users/~', {
        params: { user: 'john', limit: 20 },
      });
      expect(result).toEqual({ success: true, data: MOCK_USERS });
    });

    it('searchUsers should use domain-specific endpoint when domain is provided', async () => {
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: MOCK_USERS });

      await client.searchUsers('jane', 'example.com', 10);

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith('/domains/example.com/users', {
        params: { user: 'jane', limit: 10 },
      });
    });

    it('searchUsers should wrap non-array response in array', async () => {
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: MOCK_USERS[0] });

      const result = await client.searchUsers('john');

      expect(result.data).toEqual([MOCK_USERS[0]]);
    });

    // getUser
    it('getUser should GET the correct user endpoint', async () => {
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: MOCK_USERS[0] });

      const result = await client.getUser('john', 'example.com');

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith('/domains/example.com/users/john');
      expect(result).toEqual({ success: true, data: MOCK_USERS[0] });
    });

    // getCDRRecords
    it('getCDRRecords should use generic /cdrs when no user or domain', async () => {
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: MOCK_CDR_RECORDS });

      const result = await client.getCDRRecords({ startDate: '2025-01-01', endDate: '2025-01-31' });

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith('/cdrs', {
        params: { start_time: '2025-01-01', end_time: '2025-01-31', limit: 100 },
      });
      expect(result).toEqual({ success: true, data: MOCK_CDR_RECORDS });
    });

    it('getCDRRecords should use domain endpoint when only domain provided', async () => {
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: MOCK_CDR_RECORDS });

      await client.getCDRRecords({ domain: 'example.com' });

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith('/domains/example.com/cdrs', expect.any(Object));
    });

    it('getCDRRecords should use user-specific endpoint when user and domain provided', async () => {
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: MOCK_CDR_RECORDS });

      await client.getCDRRecords({ user: 'john', domain: 'example.com', limit: 50 });

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith(
        '/domains/example.com/users/john/cdrs',
        { params: { start_time: undefined, end_time: undefined, limit: 50 } },
      );
    });

    // getDomains / getDomain
    it('getDomains should GET /domains', async () => {
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: MOCK_DOMAINS });

      const result = await client.getDomains();

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith('/domains');
      expect(result).toEqual({ success: true, data: MOCK_DOMAINS });
    });

    it('getDomain should GET /domains/:domain', async () => {
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: MOCK_DOMAINS[0] });

      const result = await client.getDomain('example.com');

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith('/domains/example.com');
      expect(result).toEqual({ success: true, data: MOCK_DOMAINS[0] });
    });

    // getUserDevices
    it('getUserDevices should GET the devices endpoint', async () => {
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: MOCK_DEVICES });

      const result = await client.getUserDevices('john', 'example.com');

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith('/domains/example.com/users/john/devices');
      expect(result).toEqual({ success: true, data: MOCK_DEVICES });
    });

    // getPhoneNumbers / getPhoneNumber
    it('getPhoneNumbers should GET the phonenumbers endpoint with optional limit', async () => {
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: MOCK_PHONE_NUMBERS });

      const result = await client.getPhoneNumbers('example.com', 50);

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith('/domains/example.com/phonenumbers', {
        params: { limit: 50 },
      });
      expect(result).toEqual({ success: true, data: MOCK_PHONE_NUMBERS });
    });

    it('getPhoneNumber should GET a specific phone number endpoint', async () => {
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: MOCK_PHONE_NUMBERS[0] });

      const result = await client.getPhoneNumber('example.com', '15551234567');

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith('/domains/example.com/phonenumbers/15551234567');
      expect(result).toEqual({ success: true, data: MOCK_PHONE_NUMBERS[0] });
    });

    // getCallQueues / getCallQueue / getCallQueueAgents
    it('getCallQueues should GET the callqueues endpoint', async () => {
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: MOCK_CALL_QUEUES });

      const result = await client.getCallQueues('example.com');

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith('/domains/example.com/callqueues');
      expect(result).toEqual({ success: true, data: MOCK_CALL_QUEUES });
    });

    it('getCallQueue should GET a specific callqueue endpoint', async () => {
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: MOCK_CALL_QUEUES[0] });

      const result = await client.getCallQueue('example.com', 'q1');

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith('/domains/example.com/callqueues/q1');
      expect(result).toEqual({ success: true, data: MOCK_CALL_QUEUES[0] });
    });

    it('getCallQueueAgents should GET agents for a specific queue', async () => {
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: MOCK_AGENTS });

      const result = await client.getCallQueueAgents('example.com', 'q1');

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith('/domains/example.com/callqueues/q1/agents');
      expect(result).toEqual({ success: true, data: MOCK_AGENTS });
    });

    // getAgents / loginAgent / logoutAgent
    it('getAgents should GET agents for a domain', async () => {
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: MOCK_AGENTS });

      const result = await client.getAgents('example.com');

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith('/domains/example.com/agents');
      expect(result).toEqual({ success: true, data: MOCK_AGENTS });
    });

    it('loginAgent should POST to the agent login endpoint', async () => {
      vi.mocked(mockAxios.mockInstance.post).mockResolvedValue({ data: { status: 'ok' } });

      const result = await client.loginAgent('example.com', 'q1', 'agent1');

      expect(mockAxios.mockInstance.post).toHaveBeenCalledWith(
        '/domains/example.com/callqueues/q1/agents/agent1/login',
      );
      expect(result).toEqual({ success: true, data: { status: 'ok' }, message: 'Agent logged in successfully' });
    });

    it('logoutAgent should POST to the agent logout endpoint', async () => {
      vi.mocked(mockAxios.mockInstance.post).mockResolvedValue({ data: { status: 'ok' } });

      const result = await client.logoutAgent('example.com', 'q1', 'agent1');

      expect(mockAxios.mockInstance.post).toHaveBeenCalledWith(
        '/domains/example.com/callqueues/q1/agents/agent1/logout',
      );
      expect(result).toEqual({ success: true, data: { status: 'ok' }, message: 'Agent logged out successfully' });
    });

    // getAutoAttendants
    it('getAutoAttendants should GET the autoattendants endpoint', async () => {
      const mockAAs = [{ object: 'autoattendant', domain: 'example.com', name: 'Main' }];
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: mockAAs });

      const result = await client.getAutoAttendants('example.com');

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith('/domains/example.com/autoattendants');
      expect(result).toEqual({ success: true, data: mockAAs });
    });

    // getUserAnswerRules / getUserAnswerRule
    it('getUserAnswerRules should GET answer rules for a user', async () => {
      const mockRules = [{ object: 'answerrule', timeframe: 'default', user: 'john', domain: 'example.com' }];
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: mockRules });

      const result = await client.getUserAnswerRules('john', 'example.com');

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith('/domains/example.com/users/john/answerrules');
      expect(result).toEqual({ success: true, data: mockRules });
    });

    it('getUserAnswerRule should GET a specific answer rule by timeframe', async () => {
      const mockRule = { object: 'answerrule', timeframe: 'business-hours', user: 'john', domain: 'example.com' };
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: mockRule });

      const result = await client.getUserAnswerRule('john', 'example.com', 'business-hours');

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith(
        '/domains/example.com/users/john/answerrules/business-hours',
      );
      expect(result).toEqual({ success: true, data: mockRule });
    });

    // getUserGreetings
    it('getUserGreetings should GET greetings for a user', async () => {
      const mockGreetings = [{ object: 'greeting', index: 0, user: 'john', domain: 'example.com' }];
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: mockGreetings });

      const result = await client.getUserGreetings('john', 'example.com');

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith('/domains/example.com/users/john/greetings');
      expect(result).toEqual({ success: true, data: mockGreetings });
    });

    // getUserVoicemails
    it('getUserVoicemails should GET voicemails for a user', async () => {
      const mockVMs = [{ object: 'voicemail', user: 'john', domain: 'example.com', duration: 30 }];
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: mockVMs });

      const result = await client.getUserVoicemails('john', 'example.com');

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith('/domains/example.com/users/john/voicemail');
      expect(result).toEqual({ success: true, data: mockVMs });
    });

    // getMusicOnHold
    it('getMusicOnHold should GET the moh endpoint', async () => {
      const mockMOH = [{ object: 'moh', index: 0, domain: 'example.com', filename: 'hold.wav' }];
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: mockMOH });

      const result = await client.getMusicOnHold('example.com');

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith('/domains/example.com/moh');
      expect(result).toEqual({ success: true, data: mockMOH });
    });

    // getBilling
    it('getBilling should GET the billing endpoint', async () => {
      const mockBilling = { domain: 'example.com', charges: 99.99 };
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: mockBilling });

      const result = await client.getBilling('example.com');

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith('/domains/example.com/billing');
      expect(result).toEqual({ success: true, data: mockBilling });
    });

    // getAgentStatistics
    it('getAgentStatistics should GET domain-level stats when no agentId', async () => {
      const mockStats = { calls: 100, avg_wait: 15 };
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: mockStats });

      const result = await client.getAgentStatistics('example.com');

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith('/domains/example.com/statistics/agent');
      expect(result).toEqual({ success: true, data: mockStats });
    });

    it('getAgentStatistics should GET agent-specific stats when agentId is provided', async () => {
      const mockStats = { calls: 42 };
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: mockStats });

      const result = await client.getAgentStatistics('example.com', 'agent1');

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith('/domains/example.com/statistics/agent/agent1');
      expect(result).toEqual({ success: true, data: mockStats });
    });

    // testConnection
    it('testConnection should GET /domains with limit 1 and return success message', async () => {
      vi.mocked(mockAxios.mockInstance.get).mockResolvedValue({ data: MOCK_DOMAINS });

      const result = await client.testConnection();

      expect(mockAxios.mockInstance.get).toHaveBeenCalledWith('/domains', { params: { limit: 1 } });
      expect(result).toEqual({ success: true, data: true, message: 'Connection successful' });
    });
  });

  // ────────────────────────────────────────────
  // Error handling
  // ────────────────────────────────────────────
  describe('error handling', () => {
    beforeEach(() => {
      mockAxios = createMockAxios();
      client = new NetSapiensClient(STATIC_TOKEN_CONFIG);
    });

    it('searchUsers should return success:false with error message on failure', async () => {
      vi.mocked(mockAxios.mockInstance.get).mockRejectedValue(new Error('Network error'));

      const result = await client.searchUsers('john');

      expect(result).toEqual({ success: false, error: 'Network error', data: [] });
    });

    it('getUser should return success:false with data undefined on failure', async () => {
      vi.mocked(mockAxios.mockInstance.get).mockRejectedValue(new Error('Not found'));

      const result = await client.getUser('john', 'example.com');

      expect(result).toEqual({ success: false, error: 'Not found', data: undefined });
    });

    it('getCDRRecords should return success:false with empty array on failure', async () => {
      vi.mocked(mockAxios.mockInstance.get).mockRejectedValue(new Error('Timeout'));

      const result = await client.getCDRRecords({});

      expect(result).toEqual({ success: false, error: 'Timeout', data: [] });
    });

    it('getDomains should return success:false with empty array on failure', async () => {
      vi.mocked(mockAxios.mockInstance.get).mockRejectedValue(new Error('Unauthorized'));

      const result = await client.getDomains();

      expect(result).toEqual({ success: false, error: 'Unauthorized', data: [] });
    });

    it('loginAgent should return success:false on failure', async () => {
      vi.mocked(mockAxios.mockInstance.post).mockRejectedValue(new Error('Agent not found'));

      const result = await client.loginAgent('example.com', 'q1', 'badagent');

      expect(result).toEqual({ success: false, error: 'Agent not found', data: undefined });
    });

    it('testConnection should return success:false with data false on failure', async () => {
      vi.mocked(mockAxios.mockInstance.get).mockRejectedValue(new Error('Connection refused'));

      const result = await client.testConnection();

      expect(result).toEqual({ success: false, error: 'Connection refused', data: false });
    });
  });
});
