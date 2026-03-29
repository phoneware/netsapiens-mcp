/**
 * NetSapiens API Client for NetSapiens MCP Server
 * Handles all interactions with the NetSapiens platform
 */

import axios, { AxiosInstance, AxiosResponse } from 'axios';
import {
  NetSapiensConfig,
  NetSapiensApiResponse,
  NetSapiensUser,
  NetSapiensDomain,
  NetSapiensCDR,
  NetSapiensDevice,
  NetSapiensPhoneNumber,
  NetSapiensCallQueue,
  NetSapiensAgent,
  NetSapiensAutoAttendant,
  NetSapiensAnswerRule,
  NetSapiensGreeting,
  NetSapiensVoicemail,
  NetSapiensMusicOnHold,
  NetSapiensBilling,
  NetSapiensReseller,
  NetSapiensConference,
  NetSapiensConferenceParticipant,
  NetSapiensRoute,
  NetSapiensRouteConnection,
  NetSapiensConnection,
  NetSapiensContact,
  NetSapiensSite,
  NetSapiensTimeframe,
  NetSapiensSubscription,
  NetSapiensDialPlan,
  NetSapiensDialRule,
  NetSapiensDialPolicy,
  NetSapiensDialPermission,
  NetSapiensAddress,
  NetSapiensAddressEndpoint,
  NetSapiensCertificate,
  NetSapiensImageFile,
  NetSapiensTemplate,
  NetSapiensPhoneConfig,
  NetSapiensPhoneTemplate,
  NetSapiensPhoneMac,
  NetSapiensPhoneModel,
  NetSapiensDeviceProfile,
  NetSapiensHoldMessage,
  NetSapiensNumberFilter,
  NetSapiensRecording,
  NetSapiensTranscription,
  NetSapiensMessageSession,
  NetSapiensMessage,
  NetSapiensSmsNumber,
  NetSapiensSmsBlock,
  NetSapiensVoicemailReminder,
  NetSapiensApiKeyInfo,
  NetSapiensJwtInfo,
  NetSapiensActiveCall,
  NetSapiensQueuedCall,
  NetSapiensQuota,
  NetSapiensDashboard,
  NetSapiensChart,
  NetSapiensHoliday,
  NetSapiensVideoCompany,
  NetSapiensVideoHost,
  NetSapiensVideoProduct,
  NetSapiensVideoSubscription,
  NetSapiensMeeting,
  NetSapiensMeetingLog,
  NetSapiensVoice,
  NetSapiensFirebaseAccount,
  NetSapiensSipFlow,
  NetSapiensDepartment,
  NetSapiensPresence,
  NetSapiensConfigDefinition,
  NetSapiensConfiguration,
  NetSapiensInsight,
  NetSapiensCallQueueReport,
  NetSapiensPhoneServer
} from './types/config.js';
import { OAuthManager } from './oauth-manager.js';

export class NetSapiensClient {
  private client: AxiosInstance;
  private config: NetSapiensConfig;
  private oauthManager?: OAuthManager;

  constructor(config: NetSapiensConfig) {
    this.config = config;

    // Initialize OAuth manager if OAuth config is provided
    if (config.oauth) {
      this.oauthManager = new OAuthManager({
        apiUrl: config.apiUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        username: config.oauth.username,
        password: config.oauth.password
      });
    }

    this.client = axios.create({
      baseURL: `${config.apiUrl}/ns-api/v2`,
      timeout: config.timeout || 30000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'NetSapiens-MCP/1.1.1'
      }
    });

    // Add request interceptor to handle OAuth tokens
    this.client.interceptors.request.use(
      async (config) => {
        if (this.oauthManager) {
          // Get fresh OAuth token
          const token = await this.oauthManager.getAccessToken();
          config.headers.Authorization = `Bearer ${token}`;
        } else if (this.config.apiToken) {
          // Use static API token
          config.headers.Authorization = `Bearer ${this.config.apiToken}`;
        }
        return config;
      },
      (error) => Promise.reject(error)
    );

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        console.error('NetSapiens API Error:', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
          url: error.config?.url
        });
        return Promise.reject(error);
      }
    );
  }

  /**
   * Search for users across all domains in NetSapiens
   */
  async searchUsers(query: string, domain?: string, limit: number = 20): Promise<NetSapiensApiResponse<NetSapiensUser[]>> {
    try {
      let endpoint = '/domains/~/users/~';
      if (domain) {
        endpoint = `/domains/${domain}/users`;
      }

      const response: AxiosResponse = await this.client.get(endpoint, {
        params: {
          user: query,
          limit
        }
      });

      return {
        success: true,
        data: Array.isArray(response.data) ? response.data : [response.data]
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to search users',
        data: []
      };
    }
  }

  /**
   * Get user details by user ID and domain
   */
  async getUser(userId: string, domain: string): Promise<NetSapiensApiResponse<NetSapiensUser>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}`);

      return {
        success: true,
        data: response.data
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to get user',
        data: undefined
      };
    }
  }

  /**
   * Get call detail records (CDR)
   */
  async getCDRRecords(params: {
    startDate?: string;
    endDate?: string;
    user?: string;
    domain?: string;
    limit?: number;
  }): Promise<NetSapiensApiResponse<NetSapiensCDR[]>> {
    try {
      let endpoint = '/cdrs';
      
      // If specific user and domain provided, use user-specific endpoint
      if (params.user && params.domain) {
        endpoint = `/domains/${params.domain}/users/${params.user}/cdrs`;
      } else if (params.domain) {
        endpoint = `/domains/${params.domain}/cdrs`;
      }

      const response: AxiosResponse = await this.client.get(endpoint, {
        params: {
          start_time: params.startDate,
          end_time: params.endDate,
          limit: params.limit || 100
        }
      });

      return {
        success: true,
        data: Array.isArray(response.data) ? response.data : [response.data]
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to get CDR records',
        data: []
      };
    }
  }

  /**
   * Get domain information
   */
  async getDomains(): Promise<NetSapiensApiResponse<NetSapiensDomain[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/domains');

      return {
        success: true,
        data: Array.isArray(response.data) ? response.data : [response.data]
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to get domains',
        data: []
      };
    }
  }

  /**
   * Get specific domain information
   */
  async getDomain(domain: string): Promise<NetSapiensApiResponse<NetSapiensDomain>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}`);

      return {
        success: true,
        data: response.data
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to get domain',
        data: undefined
      };
    }
  }

  /**
   * Get user devices
   */
  async getUserDevices(userId: string, domain: string): Promise<NetSapiensApiResponse<NetSapiensDevice[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/devices`);

      return {
        success: true,
        data: Array.isArray(response.data) ? response.data : [response.data]
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to get user devices',
        data: []
      };
    }
  }

  // ==================== PHONE NUMBER MANAGEMENT ====================
  
  /**
   * Get phone numbers for a domain
   */
  async getPhoneNumbers(domain: string, limit?: number): Promise<NetSapiensApiResponse<NetSapiensPhoneNumber[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/phonenumbers`, {
        params: { limit }
      });

      return {
        success: true,
        data: Array.isArray(response.data) ? response.data : [response.data]
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to get phone numbers',
        data: []
      };
    }
  }

  /**
   * Get specific phone number details
   */
  async getPhoneNumber(domain: string, phoneNumber: string): Promise<NetSapiensApiResponse<NetSapiensPhoneNumber>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/phonenumbers/${phoneNumber}`);

      return {
        success: true,
        data: response.data
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to get phone number',
        data: undefined
      };
    }
  }

  // ==================== CALL QUEUE MANAGEMENT ====================
  
  /**
   * Get call queues for a domain
   */
  async getCallQueues(domain: string): Promise<NetSapiensApiResponse<NetSapiensCallQueue[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/callqueues`);

      return {
        success: true,
        data: Array.isArray(response.data) ? response.data : [response.data]
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to get call queues',
        data: []
      };
    }
  }

  /**
   * Get specific call queue details
   */
  async getCallQueue(domain: string, queueId: string): Promise<NetSapiensApiResponse<NetSapiensCallQueue>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/callqueues/${queueId}`);

      return {
        success: true,
        data: response.data
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to get call queue',
        data: undefined
      };
    }
  }

  /**
   * Get agents for a call queue
   */
  async getCallQueueAgents(domain: string, queueId: string): Promise<NetSapiensApiResponse<NetSapiensAgent[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/callqueues/${queueId}/agents`);

      return {
        success: true,
        data: Array.isArray(response.data) ? response.data : [response.data]
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to get call queue agents',
        data: []
      };
    }
  }

  // ==================== AGENT MANAGEMENT ====================
  
  /**
   * Get agents for a domain
   */
  async getAgents(domain: string): Promise<NetSapiensApiResponse<NetSapiensAgent[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/agents`);

      return {
        success: true,
        data: Array.isArray(response.data) ? response.data : [response.data]
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to get agents',
        data: []
      };
    }
  }

  /**
   * Login an agent to a call queue
   */
  async loginAgent(domain: string, queueId: string, agentId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/callqueues/${queueId}/agents/${agentId}/login`);

      return {
        success: true,
        data: response.data,
        message: 'Agent logged in successfully'
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to login agent',
        data: undefined
      };
    }
  }

  /**
   * Logout an agent from a call queue
   */
  async logoutAgent(domain: string, queueId: string, agentId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/callqueues/${queueId}/agents/${agentId}/logout`);

      return {
        success: true,
        data: response.data,
        message: 'Agent logged out successfully'
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to logout agent',
        data: undefined
      };
    }
  }

  // ==================== AUTO ATTENDANT ====================
  
  /**
   * Get auto attendants for a domain
   */
  async getAutoAttendants(domain: string): Promise<NetSapiensApiResponse<NetSapiensAutoAttendant[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/autoattendants`);

      return {
        success: true,
        data: Array.isArray(response.data) ? response.data : [response.data]
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to get auto attendants',
        data: []
      };
    }
  }

  // ==================== ANSWER RULES ====================
  
  /**
   * Get answer rules for a user
   */
  async getUserAnswerRules(userId: string, domain: string): Promise<NetSapiensApiResponse<NetSapiensAnswerRule[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/answerrules`);

      return {
        success: true,
        data: Array.isArray(response.data) ? response.data : [response.data]
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to get answer rules',
        data: []
      };
    }
  }

  /**
   * Get specific answer rule for a user
   */
  async getUserAnswerRule(userId: string, domain: string, timeframe: string): Promise<NetSapiensApiResponse<NetSapiensAnswerRule>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/answerrules/${timeframe}`);

      return {
        success: true,
        data: response.data
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to get answer rule',
        data: undefined
      };
    }
  }

  // ==================== GREETINGS & VOICEMAIL ====================
  
  /**
   * Get user greetings
   */
  async getUserGreetings(userId: string, domain: string): Promise<NetSapiensApiResponse<NetSapiensGreeting[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/greetings`);

      return {
        success: true,
        data: Array.isArray(response.data) ? response.data : [response.data]
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to get user greetings',
        data: []
      };
    }
  }

  /**
   * Get user voicemails
   */
  async getUserVoicemails(userId: string, domain: string): Promise<NetSapiensApiResponse<NetSapiensVoicemail[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/voicemail`);

      return {
        success: true,
        data: Array.isArray(response.data) ? response.data : [response.data]
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to get user voicemails',
        data: []
      };
    }
  }

  // ==================== MUSIC ON HOLD ====================
  
  /**
   * Get music on hold files for a domain
   */
  async getMusicOnHold(domain: string): Promise<NetSapiensApiResponse<NetSapiensMusicOnHold[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/moh`);

      return {
        success: true,
        data: Array.isArray(response.data) ? response.data : [response.data]
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to get music on hold',
        data: []
      };
    }
  }

  // ==================== BILLING ====================
  
  /**
   * Get billing information for a domain
   */
  async getBilling(domain: string): Promise<NetSapiensApiResponse<NetSapiensBilling>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/billing`);

      return {
        success: true,
        data: response.data
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to get billing information',
        data: undefined
      };
    }
  }

  // ==================== STATISTICS ====================
  
  /**
   * Get agent statistics
   */
  async getAgentStatistics(domain: string, agentId?: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const endpoint = agentId 
        ? `/domains/${domain}/statistics/agent/${agentId}`
        : `/domains/${domain}/statistics/agent`;
      
      const response: AxiosResponse = await this.client.get(endpoint);

      return {
        success: true,
        data: response.data
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to get agent statistics',
        data: undefined
      };
    }
  }

  // ==================== SYSTEM ADMIN ====================

  /** Get API version */
  async getApiVersion(): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get('/version');
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get API version', data: undefined };
    }
  }

  /** Get access log */
  async getAccessLog(params?: { limit?: number; offset?: number }): Promise<NetSapiensApiResponse<any[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/accesslog', { params });
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get access log', data: [] };
    }
  }

  /** Get audit log */
  async getAuditLog(params?: { limit?: number; offset?: number }): Promise<NetSapiensApiResponse<any[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/auditlog', { params });
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get audit log', data: [] };
    }
  }

  /** Request a full system backup */
  async createSystemBackup(data?: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post('/backup', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create system backup', data: undefined };
    }
  }

  /** Manually backup a domain */
  async createDomainBackup(domain: string, data?: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/backup`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create domain backup', data: undefined };
    }
  }

  /** Read available restore points */
  async getRestorePoints(): Promise<NetSapiensApiResponse<any[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/restore');
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get restore points', data: [] };
    }
  }

  /** Restore a specific domain backup */
  async restoreDomainBackup(data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put('/restore', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to restore domain backup', data: undefined };
    }
  }

  /** Query data from iNSight analytics */
  async getInsightAnalytics(label: string, params?: any): Promise<NetSapiensApiResponse<NetSapiensInsight>> {
    try {
      const response: AxiosResponse = await this.client.get(`/insight/${label}`, { params });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get insight analytics', data: undefined };
    }
  }

  // ==================== API KEYS & AUTHENTICATION ====================

  /** Read API keys under your account */
  async listApiKeys(): Promise<NetSapiensApiResponse<NetSapiensApiKeyInfo[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/apikeys');
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to list API keys', data: [] };
    }
  }

  /** Create an API key */
  async createApiKey(data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post('/apikeys', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create API key', data: undefined };
    }
  }

  /** Read info on specific API key */
  async getApiKey(keyId: string): Promise<NetSapiensApiResponse<NetSapiensApiKeyInfo>> {
    try {
      const response: AxiosResponse = await this.client.get(`/apikeys/${keyId}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get API key', data: undefined };
    }
  }

  /** Update an API key */
  async updateApiKey(keyId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/apikeys/${keyId}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update API key', data: undefined };
    }
  }

  /** Revoke an API key */
  async revokeApiKey(keyId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/apikeys/${keyId}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to revoke API key', data: undefined };
    }
  }

  /** Read your own API key info */
  async getMyApiKey(): Promise<NetSapiensApiResponse<NetSapiensApiKeyInfo>> {
    try {
      const response: AxiosResponse = await this.client.get('/apikeys/~');
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get my API key', data: undefined };
    }
  }

  /** Get access token from auth code */
  async getTokenFromAuthCode(data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post('/authCode', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get token from auth code', data: undefined };
    }
  }

  /** Create JWT token from user/pass */
  async createJwt(data: any): Promise<NetSapiensApiResponse<NetSapiensJwtInfo>> {
    try {
      const response: AxiosResponse = await this.client.post('/jwt', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create JWT', data: undefined };
    }
  }

  /** Revoke current JWT */
  async revokeCurrentJwt(): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete('/jwt');
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to revoke JWT', data: undefined };
    }
  }

  /** Read current JWT */
  async getCurrentJwt(): Promise<NetSapiensApiResponse<NetSapiensJwtInfo>> {
    try {
      const response: AxiosResponse = await this.client.get('/jwt');
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get current JWT', data: undefined };
    }
  }

  /** Revoke JWT by JTI */
  async revokeJwtByJti(jti: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/jwt/${jti}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to revoke JWT by JTI', data: undefined };
    }
  }

  /** Revoke JWT(s) by UID (user@domain) */
  async revokeJwtByUid(uid: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/jwt/${uid}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to revoke JWT by UID', data: undefined };
    }
  }

  /** SSO Enroll */
  async ssoEnroll(data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post('/ssoEnroll', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to SSO enroll', data: undefined };
    }
  }

  /** Get access token after MFA (include passcode) */
  async getTokenWithMfa(data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post('/tokens', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get token with MFA', data: undefined };
    }
  }

  /** Create JWT token from refresh JWT */
  async createJwtFromRefresh(data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post('/jwt', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create JWT from refresh', data: undefined };
    }
  }

  /** Create JWT token after MFA request */
  async createJwtAfterMfa(data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post('/jwt', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create JWT after MFA', data: undefined };
    }
  }

  /** Create JWT token for delegated access */
  async createJwtDelegated(data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post('/jwt', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create delegated JWT', data: undefined };
    }
  }

  /** Get access token from refresh token */
  async getTokenFromRefresh(data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post('/tokens', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get token from refresh', data: undefined };
    }
  }

  /** Get access token after MFA request */
  async getTokenAfterMfa(data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post('/tokens', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get token after MFA', data: undefined };
    }
  }

  // ==================== RESELLERS ====================

  /** Get resellers */
  async getResellers(params?: any): Promise<NetSapiensApiResponse<NetSapiensReseller[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/resellers', { params });
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get resellers', data: [] };
    }
  }

  /** Create a reseller */
  async createReseller(data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post('/resellers', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create reseller', data: undefined };
    }
  }

  /** Count resellers */
  async countResellers(): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get('/resellers/count');
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count resellers', data: undefined };
    }
  }

  /** Get specific reseller */
  async getReseller(reseller: string): Promise<NetSapiensApiResponse<NetSapiensReseller>> {
    try {
      const response: AxiosResponse = await this.client.get(`/resellers/${reseller}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get reseller', data: undefined };
    }
  }

  /** Update a reseller */
  async updateReseller(reseller: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/resellers/${reseller}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update reseller', data: undefined };
    }
  }

  /** Delete a reseller */
  async deleteReseller(reseller: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/resellers/${reseller}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete reseller', data: undefined };
    }
  }

  /** Count devices for a reseller */
  async countResellerDevices(reseller: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/resellers/${reseller}/devices/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count reseller devices', data: undefined };
    }
  }

  /** Get quotas for domains in a reseller */
  async getResellerQuotas(reseller: string): Promise<NetSapiensApiResponse<NetSapiensQuota[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/resellers/${reseller}/quotas`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get reseller quotas', data: [] };
    }
  }

  /** Count quotas for a reseller */
  async countResellerQuotas(reseller: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/resellers/${reseller}/quotas/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count reseller quotas', data: undefined };
    }
  }

  /** Count CDR schedules for a reseller */
  async countResellerSchedules(reseller: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/resellers/${reseller}/schedule/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count reseller schedules', data: undefined };
    }
  }

  // ==================== DOMAIN MANAGEMENT (EXTENDED) ====================

  /** Create a domain */
  async createDomain(data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post('/domains', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create domain', data: undefined };
    }
  }

  /** Count domains */
  async countDomains(): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get('/domains/count');
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count domains', data: undefined };
    }
  }

  /** Update a domain */
  async updateDomain(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update domain', data: undefined };
    }
  }

  /** Delete a domain */
  async deleteDomain(domain: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete domain', data: undefined };
    }
  }

  /** Get my domain info */
  async getMyDomain(): Promise<NetSapiensApiResponse<NetSapiensDomain>> {
    try {
      const response: AxiosResponse = await this.client.get('/domains/~');
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get my domain', data: undefined };
    }
  }

  /** Check if domain exists (count) */
  async checkDomainExists(domain: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to check domain exists', data: undefined };
    }
  }

  // ==================== SITES ====================

  /** Get sites in a domain */
  async getSites(domain: string): Promise<NetSapiensApiResponse<NetSapiensSite[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/sites`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get sites', data: [] };
    }
  }

  /** Create a site in a domain */
  async createSite(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/sites`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create site', data: undefined };
    }
  }

  /** Count sites in a domain */
  async countSites(domain: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/sites/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count sites', data: undefined };
    }
  }

  /** List basic site info in a domain */
  async listSites(domain: string): Promise<NetSapiensApiResponse<NetSapiensSite[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/sites/list`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to list sites', data: [] };
    }
  }

  /** Get a specific site */
  async getSite(domain: string, site: string): Promise<NetSapiensApiResponse<NetSapiensSite>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/sites/${site}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get site', data: undefined };
    }
  }

  /** Update a site */
  async updateSite(domain: string, site: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/sites/${site}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update site', data: undefined };
    }
  }

  // ==================== USER MANAGEMENT (EXTENDED) ====================

  /** Get users in a domain */
  async getUsers(domain: string, params?: any): Promise<NetSapiensApiResponse<NetSapiensUser[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users`, { params });
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get users', data: [] };
    }
  }

  /** Create a user in a domain */
  async createUser(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create user', data: undefined };
    }
  }

  /** Count users in a domain */
  async countUsers(domain: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count users', data: undefined };
    }
  }

  /** List basic info on users in a domain */
  async listUsers(domain: string): Promise<NetSapiensApiResponse<NetSapiensUser[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/list`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to list users', data: [] };
    }
  }

  /** Update a user in a domain */
  async updateUser(domain: string, userId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/users/${userId}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update user', data: undefined };
    }
  }

  /** Delete a user from a domain */
  async deleteUser(domain: string, userId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/users/${userId}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete user', data: undefined };
    }
  }

  /** Get my user info */
  async getMyUser(): Promise<NetSapiensApiResponse<NetSapiensUser>> {
    try {
      const response: AxiosResponse = await this.client.get('/domains/~/users/~');
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get my user', data: undefined };
    }
  }

  // ==================== USER DEVICES (EXTENDED) ====================

  /** Create a device for a user */
  async createUserDevice(domain: string, userId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/devices`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create user device', data: undefined };
    }
  }

  /** Count devices for a user */
  async countUserDevices(domain: string, userId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/devices/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count user devices', data: undefined };
    }
  }

  /** Get a specific device for a user */
  async getUserDevice(domain: string, userId: string, device: string): Promise<NetSapiensApiResponse<NetSapiensDevice>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/devices/${device}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get user device', data: undefined };
    }
  }

  /** Update a device for a user */
  async updateUserDevice(domain: string, userId: string, device: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/users/${userId}/devices/${device}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update user device', data: undefined };
    }
  }

  /** Delete a device for a user */
  async deleteUserDevice(domain: string, userId: string, device: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/users/${userId}/devices/${device}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete user device', data: undefined };
    }
  }

  // ==================== DOMAIN DEVICES ====================

  /** Get devices in a domain */
  async getDomainDevices(domain: string): Promise<NetSapiensApiResponse<NetSapiensDevice[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/devices`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain devices', data: [] };
    }
  }

  /** Count devices for a domain */
  async countDomainDevices(domain: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/devices/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count domain devices', data: undefined };
    }
  }

  /** Count devices by specific device in a domain */
  async countDomainDevicesByDevice(domain: string, device: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/devices/${device}/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count devices by device', data: undefined };
    }
  }

  // ==================== PHONE NUMBER MANAGEMENT (EXTENDED) ====================

  /** Add a phone number in a domain */
  async createPhoneNumber(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/phonenumbers`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create phone number', data: undefined };
    }
  }

  /** Count phone numbers for a domain */
  async countPhoneNumbers(domain: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/phonenumbers/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count phone numbers', data: undefined };
    }
  }

  /** Update a phone number in a domain */
  async updatePhoneNumber(domain: string, phoneNumber: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/phonenumbers/${phoneNumber}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update phone number', data: undefined };
    }
  }

  /** Remove a phone number from a domain */
  async deletePhoneNumber(domain: string, phoneNumber: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/phonenumbers/${phoneNumber}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete phone number', data: undefined };
    }
  }

  /** Send phone number to a call queue */
  async sendPhoneNumberToQueue(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/phonenumbers`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to send phone number to queue', data: undefined };
    }
  }

  /** Send phone number to a user */
  async sendPhoneNumberToUser(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/phonenumbers`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to send phone number to user', data: undefined };
    }
  }

  /** Send phone number to offnet number */
  async sendPhoneNumberToOffnet(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/phonenumbers`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to send phone number to offnet', data: undefined };
    }
  }

  /** Move phone number back to available inventory */
  async movePhoneNumberToInventory(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/phonenumbers`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to move phone number to inventory', data: undefined };
    }
  }

  /** Get all phone numbers for system or reseller */
  async getSystemPhoneNumbers(params?: any): Promise<NetSapiensApiResponse<NetSapiensPhoneNumber[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/phonenumbers', { params });
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get system phone numbers', data: [] };
    }
  }

  /** Count all phone numbers for system or reseller */
  async countSystemPhoneNumbers(): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get('/phonenumbers/count');
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count system phone numbers', data: undefined };
    }
  }

  // ==================== CALL QUEUE MANAGEMENT (EXTENDED) ====================

  /** Create a call queue in a domain */
  async createCallQueue(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/callqueues`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create call queue', data: undefined };
    }
  }

  /** Read basic info on call queues in a domain */
  async listCallQueuesBasic(domain: string): Promise<NetSapiensApiResponse<NetSapiensCallQueue[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/callqueues/list`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to list call queues', data: [] };
    }
  }

  /** Update a call queue */
  async updateCallQueue(domain: string, callqueue: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/callqueues/${callqueue}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update call queue', data: undefined };
    }
  }

  /** Delete a call queue */
  async deleteCallQueue(domain: string, callqueue: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/callqueues/${callqueue}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete call queue', data: undefined };
    }
  }

  /** Add an agent to a call queue */
  async addCallQueueAgent(domain: string, callqueue: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/callqueues/${callqueue}/agents`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to add call queue agent', data: undefined };
    }
  }

  /** Count agents in a call queue */
  async countCallQueueAgents(domain: string, callqueue: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/callqueues/${callqueue}/agents/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count call queue agents', data: undefined };
    }
  }

  /** Get a specific agent in a call queue */
  async getCallQueueAgent(domain: string, callqueue: string, agentId: string): Promise<NetSapiensApiResponse<NetSapiensAgent>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/callqueues/${callqueue}/agents/${agentId}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get call queue agent', data: undefined };
    }
  }

  /** Update an agent in a call queue */
  async updateCallQueueAgent(domain: string, callqueue: string, agentId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/callqueues/${callqueue}/agents/${agentId}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update call queue agent', data: undefined };
    }
  }

  /** Remove an agent from a call queue */
  async removeCallQueueAgent(domain: string, callqueue: string, agentId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/callqueues/${callqueue}/agents/${agentId}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to remove call queue agent', data: undefined };
    }
  }

  /** Set agent offline status across all queues */
  async setAgentOfflineStatus(domain: string, agentId: string, status: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.patch(`/domains/${domain}/callqueues/all/agents/${agentId}/${status}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to set agent offline status', data: undefined };
    }
  }

  /** Agent single call mode */
  async agentSingleCall(domain: string, callqueue: string, agentId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.patch(`/domains/${domain}/callqueues/${callqueue}/agents/${agentId}/onecall`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to set agent single call', data: undefined };
    }
  }

  // ==================== CDR MANAGEMENT (EXTENDED) ====================

  /** Count CDRs and SUM minutes (system-level) */
  async countSystemCDRs(params?: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get('/cdrs/count', { params });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count system CDRs', data: undefined };
    }
  }

  /** Count CDRs and SUM minutes for a domain */
  async countDomainCDRs(domain: string, params?: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/cdrs/count`, { params });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count domain CDRs', data: undefined };
    }
  }

  /** Read CDRs for a site in a domain */
  async getSiteCDRs(domain: string, params?: any): Promise<NetSapiensApiResponse<NetSapiensCDR[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/cdrs`, { params });
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get site CDRs', data: [] };
    }
  }

  /** Search CDRs for a domain */
  async searchDomainCDRs(domain: string, params?: any): Promise<NetSapiensApiResponse<NetSapiensCDR[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/cdrs`, { params });
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to search domain CDRs', data: [] };
    }
  }

  /** Count CDRs for a specific user */
  async countUserCDRs(domain: string, userId: string, params?: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/cdrs/count`, { params });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count user CDRs', data: undefined };
    }
  }

  // ==================== ACTIVE CALLS ====================

  /** Read active calls in a domain */
  async getDomainActiveCalls(domain: string, params?: any): Promise<NetSapiensApiResponse<NetSapiensActiveCall[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/calls`, { params });
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain active calls', data: [] };
    }
  }

  /** Count active calls in a domain */
  async countDomainActiveCalls(domain: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/calls/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count domain active calls', data: undefined };
    }
  }

  /** Report active calls (system-level) */
  async reportActiveCalls(data?: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post('/calls/report', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to report active calls', data: undefined };
    }
  }

  /** Read active calls for a user */
  async getUserActiveCalls(domain: string, userId: string): Promise<NetSapiensApiResponse<NetSapiensActiveCall[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/calls`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get user active calls', data: [] };
    }
  }

  /** Get a specific active call */
  async getActiveCall(domain: string, userId: string, callId: string): Promise<NetSapiensApiResponse<NetSapiensActiveCall>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/calls/${callId}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get active call', data: undefined };
    }
  }

  /** Make a new call */
  async makeCall(domain: string, userId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/calls`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to make call', data: undefined };
    }
  }

  /** Disconnect a call */
  async disconnectCall(domain: string, userId: string, callId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/users/${userId}/calls/${callId}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to disconnect call', data: undefined };
    }
  }

  /** Answer a call */
  async answerCall(domain: string, userId: string, callId: string, data?: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.patch(`/domains/${domain}/users/${userId}/calls/${callId}/answer`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to answer call', data: undefined };
    }
  }

  /** Hold an active call */
  async holdCall(domain: string, userId: string, callId: string, data?: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.patch(`/domains/${domain}/users/${userId}/calls/${callId}/hold`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to hold call', data: undefined };
    }
  }

  /** Un-hold an active call */
  async unholdCall(domain: string, userId: string, callId: string, data?: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.patch(`/domains/${domain}/users/${userId}/calls/${callId}/unhold`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to unhold call', data: undefined };
    }
  }

  /** Transfer a call */
  async transferCall(domain: string, userId: string, callId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.patch(`/domains/${domain}/users/${userId}/calls/${callId}/transfer`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to transfer call', data: undefined };
    }
  }

  /** Transfer peer call */
  async transferPeerCall(domain: string, userId: string, callId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.patch(`/domains/${domain}/users/${userId}/calls/${callId}/transferPeer`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to transfer peer call', data: undefined };
    }
  }

  /** Reject a call */
  async rejectCall(domain: string, userId: string, callId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/users/${userId}/calls/${callId}/reject`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to reject call', data: undefined };
    }
  }

  // ==================== CONFERENCES ====================

  /** Get conferences in a domain */
  async getConferences(domain: string): Promise<NetSapiensApiResponse<NetSapiensConference[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/conferences`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get conferences', data: [] };
    }
  }

  /** Create a conference for a domain */
  async createConference(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/conferences`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create conference', data: undefined };
    }
  }

  /** Count conferences in a domain */
  async countConferences(domain: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/conferences/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count conferences', data: undefined };
    }
  }

  /** Get a specific conference */
  async getConference(domain: string, conference: string): Promise<NetSapiensApiResponse<NetSapiensConference>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/conferences/${conference}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get conference', data: undefined };
    }
  }

  /** Update a conference */
  async updateConference(domain: string, conference: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/conferences/${conference}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update conference', data: undefined };
    }
  }

  /** Delete a conference */
  async deleteConference(domain: string, conference: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/conferences/${conference}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete conference', data: undefined };
    }
  }

  /** Get conference CDR */
  async getConferenceCDR(domain: string, conference: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/conferences/${conference}/cdr`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get conference CDR', data: undefined };
    }
  }

  /** Get participants from a conference */
  async getConferenceParticipants(domain: string, conference: string): Promise<NetSapiensApiResponse<NetSapiensConferenceParticipant[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/conferences/${conference}/participants`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get conference participants', data: [] };
    }
  }

  /** Create a participant for a conference */
  async createConferenceParticipant(domain: string, conference: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/conferences/${conference}/participants`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create conference participant', data: undefined };
    }
  }

  /** Update a participant in a conference */
  async updateConferenceParticipant(domain: string, conference: string, participant: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/conferences/${conference}/participants/${participant}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update conference participant', data: undefined };
    }
  }

  /** Delete a participant from a conference */
  async deleteConferenceParticipant(domain: string, conference: string, participant: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/conferences/${conference}/participants/${participant}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete conference participant', data: undefined };
    }
  }

  // ==================== AUTO ATTENDANT (EXTENDED) ====================

  /** Create an auto attendant for a domain */
  async createAutoAttendant(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/autoattendants`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create auto attendant', data: undefined };
    }
  }

  /** Get a specific auto attendant for a user */
  async getUserAutoAttendant(domain: string, userId: string, prompt: string): Promise<NetSapiensApiResponse<NetSapiensAutoAttendant>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/autoattendants/${prompt}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get user auto attendant', data: undefined };
    }
  }

  /** Update a specific auto attendant for a user */
  async updateUserAutoAttendant(domain: string, userId: string, prompt: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/users/${userId}/autoattendants/${prompt}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update user auto attendant', data: undefined };
    }
  }

  /** Delete a specific auto attendant for a user */
  async deleteUserAutoAttendant(domain: string, userId: string, prompt: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/users/${userId}/autoattendants/${prompt}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete user auto attendant', data: undefined };
    }
  }

  // ==================== ANSWER RULES (EXTENDED) ====================

  /** Create an answer rule for a user */
  async createUserAnswerRule(domain: string, userId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/answerrules`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create answer rule', data: undefined };
    }
  }

  /** Count answer rules for a user */
  async countUserAnswerRules(domain: string, userId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/answerrules/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count answer rules', data: undefined };
    }
  }

  /** Reorder answer rules for a user */
  async reorderUserAnswerRules(domain: string, userId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/users/${userId}/answerrules/reorder`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to reorder answer rules', data: undefined };
    }
  }

  /** Update an answer rule for a user */
  async updateUserAnswerRule(domain: string, userId: string, timeframe: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/users/${userId}/answerrules/${timeframe}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update answer rule', data: undefined };
    }
  }

  /** Delete an answer rule for a user */
  async deleteUserAnswerRule(domain: string, userId: string, timeframe: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/users/${userId}/answerrules/${timeframe}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete answer rule', data: undefined };
    }
  }

  /** Get my answer rules */
  async getMyAnswerRules(): Promise<NetSapiensApiResponse<NetSapiensAnswerRule[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/domains/~/users/~/answerrules');
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get my answer rules', data: [] };
    }
  }

  // ==================== TIMEFRAMES (DOMAIN) ====================

  /** Get all timeframes for a domain (shared) */
  async getDomainTimeframes(domain: string): Promise<NetSapiensApiResponse<NetSapiensTimeframe[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/timeframes`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain timeframes', data: [] };
    }
  }

  /** Create a timeframe for a domain (type determined by body: always, specific_dates, days_of_week, holidays, custom) */
  async createDomainTimeframe(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/timeframes`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create domain timeframe', data: undefined };
    }
  }

  /** Get a specific timeframe for a domain */
  async getDomainTimeframe(domain: string, id: string): Promise<NetSapiensApiResponse<NetSapiensTimeframe>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/timeframes/${id}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain timeframe', data: undefined };
    }
  }

  /** Update a domain timeframe (handles date ranges, days of week, holidays, custom, conversion) */
  async updateDomainTimeframe(domain: string, id: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/timeframes/${id}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update domain timeframe', data: undefined };
    }
  }

  /** Delete a domain timeframe or entry within a timeframe */
  async deleteDomainTimeframe(domain: string, id: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/timeframes/${id}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete domain timeframe', data: undefined };
    }
  }

  /** Add entries to a domain timeframe (date ranges, holidays, custom entries) */
  async addDomainTimeframeEntry(domain: string, id: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/timeframes/${id}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to add domain timeframe entry', data: undefined };
    }
  }

  // ==================== TIMEFRAMES (USER) ====================

  /** Get all timeframes for a user */
  async getUserTimeframes(domain: string, userId: string): Promise<NetSapiensApiResponse<NetSapiensTimeframe[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/timeframes`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get user timeframes', data: [] };
    }
  }

  /** Create a timeframe for a user (type determined by body) */
  async createUserTimeframe(domain: string, userId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/timeframes`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create user timeframe', data: undefined };
    }
  }

  /** Get a specific timeframe for a user */
  async getUserTimeframe(domain: string, userId: string, id: string): Promise<NetSapiensApiResponse<NetSapiensTimeframe>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/timeframes/${id}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get user timeframe', data: undefined };
    }
  }

  /** Update a user timeframe */
  async updateUserTimeframe(domain: string, userId: string, id: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/users/${userId}/timeframes/${id}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update user timeframe', data: undefined };
    }
  }

  /** Delete a user timeframe or entry within a timeframe */
  async deleteUserTimeframe(domain: string, userId: string, id: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/users/${userId}/timeframes/${id}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete user timeframe', data: undefined };
    }
  }

  /** Add entries to a user timeframe */
  async addUserTimeframeEntry(domain: string, userId: string, id: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/timeframes/${id}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to add user timeframe entry', data: undefined };
    }
  }

  /** Delete all timeframes for a user */
  async deleteAllUserTimeframes(): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete('/');
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete all user timeframes', data: undefined };
    }
  }

  // ==================== GREETINGS (EXTENDED) ====================

  /** Create a greeting from TTS or base64 */
  async createUserGreeting(domain: string, userId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/greetings`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create greeting', data: undefined };
    }
  }

  /** Create a greeting from file upload (multipart/form-data) */
  async createUserGreetingUpload(domain: string, userId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/greetings`, data, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create greeting from upload', data: undefined };
    }
  }

  /** Count greetings for a user */
  async countUserGreetings(domain: string, userId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/greetings/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count greetings', data: undefined };
    }
  }

  /** Get a specific greeting for a user */
  async getUserGreeting(domain: string, userId: string, index: number): Promise<NetSapiensApiResponse<NetSapiensGreeting>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/greetings/${index}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get greeting', data: undefined };
    }
  }

  /** Update a greeting (TTS or base64) */
  async updateUserGreeting(domain: string, userId: string, index: number, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/users/${userId}/greetings/${index}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update greeting', data: undefined };
    }
  }

  /** Update a greeting from file upload (multipart/form-data) */
  async updateUserGreetingUpload(domain: string, userId: string, index: number, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/users/${userId}/greetings/${index}`, data, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update greeting from upload', data: undefined };
    }
  }

  /** Delete a specific greeting */
  async deleteUserGreeting(domain: string, userId: string, index: number): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/users/${userId}/greetings/${index}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete greeting', data: undefined };
    }
  }

  // ==================== VOICEMAIL (EXTENDED) ====================

  /** Get voicemails for a user by folder */
  async getUserVoicemailsByFolder(domain: string, userId: string, folder: string): Promise<NetSapiensApiResponse<NetSapiensVoicemail[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/voicemails/${folder}`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get voicemails by folder', data: [] };
    }
  }

  /** Count voicemails for a user by folder */
  async countUserVoicemailsByFolder(domain: string, userId: string, folder: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/voicemails/${folder}/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count voicemails', data: undefined };
    }
  }

  /** Get a specific voicemail */
  async getUserVoicemail(domain: string, userId: string, folder: string, filename: string): Promise<NetSapiensApiResponse<NetSapiensVoicemail>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/voicemails/${folder}/${filename}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get voicemail', data: undefined };
    }
  }

  /** Delete a voicemail */
  async deleteUserVoicemail(domain: string, userId: string, folder: string, filename: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/users/${userId}/voicemails/${folder}/${filename}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete voicemail', data: undefined };
    }
  }

  /** Forward a voicemail to another user */
  async forwardUserVoicemail(domain: string, userId: string, folder: string, filename: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.patch(`/domains/${domain}/users/${userId}/voicemails/${folder}/${filename}/forward`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to forward voicemail', data: undefined };
    }
  }

  /** Move a voicemail to save folder */
  async saveUserVoicemail(domain: string, userId: string, folder: string, filename: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.patch(`/domains/${domain}/users/${userId}/voicemails/${folder}/${filename}/save`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to save voicemail', data: undefined };
    }
  }

  // ==================== VOICEMAIL REMINDERS ====================

  /** Get voicemail reminders for a user */
  async getUserVoicemailReminders(domain: string, userId: string): Promise<NetSapiensApiResponse<NetSapiensVoicemailReminder[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/vmailnag`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get voicemail reminders', data: [] };
    }
  }

  /** Create a voicemail reminder */
  async createUserVoicemailReminder(domain: string, userId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/vmailnag`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create voicemail reminder', data: undefined };
    }
  }

  /** Update voicemail reminders for a user */
  async updateUserVoicemailReminders(domain: string, userId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/users/${userId}/vmailnag`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update voicemail reminders', data: undefined };
    }
  }

  /** Delete voicemail reminders for a user */
  async deleteUserVoicemailReminders(domain: string, userId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/users/${userId}/vmailnag`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete voicemail reminders', data: undefined };
    }
  }

  /** Count voicemail reminders for a user */
  async countUserVoicemailReminders(domain: string, userId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/vmailnag/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count voicemail reminders', data: undefined };
    }
  }

  // ==================== MUSIC ON HOLD (EXTENDED) ====================

  /** Create MOH for a domain (TTS or base64 JSON) */
  async createDomainMoh(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/moh`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create domain MOH', data: undefined };
    }
  }

  /** Create MOH for a domain from file upload */
  async createDomainMohUpload(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/moh`, data, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create domain MOH from upload', data: undefined };
    }
  }

  /** Count MOH for a domain */
  async countDomainMoh(domain: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/moh/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count domain MOH', data: undefined };
    }
  }

  /** Update MOH for a domain (TTS or base64 JSON) */
  async updateDomainMoh(domain: string, index: number, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/moh/${index}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update domain MOH', data: undefined };
    }
  }

  /** Update MOH for a domain from file upload */
  async updateDomainMohUpload(domain: string, index: number, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/moh/${index}`, data, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update domain MOH from upload', data: undefined };
    }
  }

  /** Delete MOH for a domain */
  async deleteDomainMoh(domain: string, index: number): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/moh/${index}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete domain MOH', data: undefined };
    }
  }

  /** Get MOH for a user */
  async getUserMoh(domain: string, userId: string): Promise<NetSapiensApiResponse<NetSapiensMusicOnHold[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/moh`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get user MOH', data: [] };
    }
  }

  /** Create MOH for a user (TTS or base64 JSON) */
  async createUserMoh(domain: string, userId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/moh`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create user MOH', data: undefined };
    }
  }

  /** Create MOH for a user from file upload */
  async createUserMohUpload(domain: string, userId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/moh`, data, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create user MOH from upload', data: undefined };
    }
  }

  /** Count MOH for a user */
  async countUserMoh(domain: string, userId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/moh/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count user MOH', data: undefined };
    }
  }

  /** Update MOH for a user (TTS or base64 JSON) */
  async updateUserMoh(domain: string, userId: string, index: number, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/users/${userId}/moh/${index}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update user MOH', data: undefined };
    }
  }

  /** Update MOH for a user from file upload */
  async updateUserMohUpload(domain: string, userId: string, index: number, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/users/${userId}/moh/${index}`, data, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update user MOH from upload', data: undefined };
    }
  }

  /** Delete MOH for a user */
  async deleteUserMoh(domain: string, userId: string, index: number): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/users/${userId}/moh/${index}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete user MOH', data: undefined };
    }
  }

  // ==================== HOLD MESSAGES (DOMAIN) ====================

  /** Get hold messages for a domain */
  async getDomainHoldMessages(domain: string): Promise<NetSapiensApiResponse<NetSapiensHoldMessage[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/msg`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain hold messages', data: [] };
    }
  }

  /** Create a hold message for a domain */
  async createDomainHoldMessage(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/msg`, data, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create domain hold message', data: undefined };
    }
  }

  /** Count hold messages for a domain */
  async countDomainHoldMessages(domain: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/msg/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count domain hold messages', data: undefined };
    }
  }

  /** Update a hold message for a domain */
  async updateDomainHoldMessage(domain: string, index: number, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/msg/${index}`, data, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update domain hold message', data: undefined };
    }
  }

  /** Delete a hold message for a domain */
  async deleteDomainHoldMessage(domain: string, index: number): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/msg/${index}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete domain hold message', data: undefined };
    }
  }

  // ==================== HOLD MESSAGES (USER) ====================

  /** Get hold messages for a user */
  async getUserHoldMessages(domain: string, userId: string): Promise<NetSapiensApiResponse<NetSapiensHoldMessage[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/msg`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get user hold messages', data: [] };
    }
  }

  /** Create a hold message for a user */
  async createUserHoldMessage(domain: string, userId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/msg`, data, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create user hold message', data: undefined };
    }
  }

  /** Count hold messages for a user */
  async countUserHoldMessages(domain: string, userId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/msg/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count user hold messages', data: undefined };
    }
  }

  /** Update a hold message for a user */
  async updateUserHoldMessage(domain: string, userId: string, index: number, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/users/${userId}/msg/${index}`, data, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update user hold message', data: undefined };
    }
  }

  /** Delete a hold message for a user */
  async deleteUserHoldMessage(domain: string, userId: string, index: number): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/users/${userId}/msg/${index}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete user hold message', data: undefined };
    }
  }

  // ==================== CONTACTS (DOMAIN) ====================

  /** Get domain contacts (shared) */
  async getDomainContacts(domain: string): Promise<NetSapiensApiResponse<NetSapiensContact[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/contacts`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain contacts', data: [] };
    }
  }

  /** Create a shared contact */
  async createDomainContact(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/contacts`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create domain contact', data: undefined };
    }
  }

  /** Get a specific domain contact */
  async getDomainContact(domain: string, contactId: string): Promise<NetSapiensApiResponse<NetSapiensContact>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/contacts/${contactId}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain contact', data: undefined };
    }
  }

  /** Update a shared contact */
  async updateDomainContact(domain: string, contactId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/contacts/${contactId}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update domain contact', data: undefined };
    }
  }

  /** Delete a shared contact */
  async deleteDomainContact(domain: string, contactId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/contacts/${contactId}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete domain contact', data: undefined };
    }
  }

  // ==================== CONTACTS (USER) ====================

  /** Get contacts for a user */
  async getUserContacts(domain: string, userId: string): Promise<NetSapiensApiResponse<NetSapiensContact[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/contacts`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get user contacts', data: [] };
    }
  }

  /** Create a contact for a user */
  async createUserContact(domain: string, userId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/contacts`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create user contact', data: undefined };
    }
  }

  /** Count contacts for a user */
  async countUserContacts(domain: string, userId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/contacts/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count user contacts', data: undefined };
    }
  }

  /** Get a specific contact for a user */
  async getUserContact(domain: string, userId: string, contactId: string): Promise<NetSapiensApiResponse<NetSapiensContact>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/contacts/${contactId}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get user contact', data: undefined };
    }
  }

  /** Update a contact for a user */
  async updateUserContact(domain: string, userId: string, contactId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/users/${userId}/contacts/${contactId}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update user contact', data: undefined };
    }
  }

  /** Delete a contact for a user */
  async deleteUserContact(domain: string, userId: string, contactId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/users/${userId}/contacts/${contactId}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete user contact', data: undefined };
    }
  }

  /** Get my contacts */
  async getMyContacts(): Promise<NetSapiensApiResponse<NetSapiensContact[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/domains/~/users/~/contacts');
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get my contacts', data: [] };
    }
  }

  // ==================== PHONE CONFIGURATION ====================

  /** Create phone configuration for a MAC address */
  async createPhoneConfig(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/phoneconfiguration`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create phone configuration', data: undefined };
    }
  }

  /** Count phone configurations in a domain */
  async countPhoneConfigs(domain: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/phoneconfiguration/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count phone configurations', data: undefined };
    }
  }

  /** Get phone configuration for a specific MAC */
  async getPhoneConfig(domain: string, mac: string): Promise<NetSapiensApiResponse<NetSapiensPhoneConfig>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/phoneconfiguration/${mac}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get phone configuration', data: undefined };
    }
  }

  /** Update phone configuration for a MAC address */
  async updatePhoneConfig(domain: string, mac: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/phoneconfiguration/${mac}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update phone configuration', data: undefined };
    }
  }

  /** Delete phone configuration for a MAC address */
  async deletePhoneConfig(domain: string, mac: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/phoneconfiguration/${mac}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete phone configuration', data: undefined };
    }
  }

  // ==================== PHONE TEMPLATES ====================

  /** Get phone templates for a domain */
  async getDomainPhoneTemplates(domain: string): Promise<NetSapiensApiResponse<NetSapiensPhoneTemplate[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/phonetemplates`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get phone templates', data: [] };
    }
  }

  /** Create a phone template */
  async createPhoneTemplate(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/phonetemplates`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create phone template', data: undefined };
    }
  }

  /** Count phone templates for a domain */
  async countPhoneTemplates(domain: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/phonetemplates/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count phone templates', data: undefined };
    }
  }

  /** Get a specific phone template */
  async getPhoneTemplate(domain: string, name: string): Promise<NetSapiensApiResponse<NetSapiensPhoneTemplate>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/phonetemplates/${name}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get phone template', data: undefined };
    }
  }

  /** Update a phone template */
  async updatePhoneTemplate(domain: string, name: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/phonetemplates/${name}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update phone template', data: undefined };
    }
  }

  /** Delete a phone template */
  async deletePhoneTemplate(domain: string, name: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/phonetemplates/${name}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete phone template', data: undefined };
    }
  }

  // ==================== DEVICE PROFILES ====================

  /** Get device profiles */
  async getDeviceProfiles(): Promise<NetSapiensApiResponse<NetSapiensDeviceProfile[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/deviceprofiles');
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get device profiles', data: [] };
    }
  }

  /** Count device profiles */
  async countDeviceProfiles(): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get('/deviceprofiles/count');
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count device profiles', data: undefined };
    }
  }

  /** Get a specific device profile by make/model */
  async getDeviceProfile(make: string, model: string): Promise<NetSapiensApiResponse<NetSapiensDeviceProfile>> {
    try {
      const response: AxiosResponse = await this.client.get(`/deviceprofiles/${make}/${model}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get device profile', data: undefined };
    }
  }

  // ==================== PHONES/MAC (DOMAIN) ====================

  /** Get MAC addresses in a domain */
  async getDomainPhones(domain: string): Promise<NetSapiensApiResponse<NetSapiensPhoneMac[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/phones`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain phones', data: [] };
    }
  }

  /** Add a MAC address for a domain */
  async createDomainPhone(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/phones`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create domain phone', data: undefined };
    }
  }

  /** Update a MAC address in a domain */
  async updateDomainPhone(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/phones`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update domain phone', data: undefined };
    }
  }

  /** Remove a MAC address from a domain */
  async deleteDomainPhone(domain: string, data?: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/phones`, { data });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete domain phone', data: undefined };
    }
  }

  /** Get a specific MAC address in a domain */
  async getDomainPhoneByMac(domain: string, mac: string): Promise<NetSapiensApiResponse<NetSapiensPhoneMac>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/phones/${mac}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain phone', data: undefined };
    }
  }

  // ==================== PHONES/MAC (SYSTEM) ====================

  /** Get MAC addresses (system-level) */
  async getSystemPhones(params?: any): Promise<NetSapiensApiResponse<NetSapiensPhoneMac[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/phones', { params });
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get system phones', data: [] };
    }
  }

  /** Add a MAC address (system-level) */
  async createSystemPhone(data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post('/phones', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create system phone', data: undefined };
    }
  }

  /** Update a MAC address (system-level) */
  async updateSystemPhone(data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put('/phones', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update system phone', data: undefined };
    }
  }

  /** Remove a MAC address (system-level) */
  async deleteSystemPhone(data?: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete('/phones', { data });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete system phone', data: undefined };
    }
  }

  /** Count MAC addresses (system-level) */
  async countSystemPhones(): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get('/phones/count');
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count system phones', data: undefined };
    }
  }

  /** Get list of supported/provisionable phone models */
  async getPhoneModels(params?: any): Promise<NetSapiensApiResponse<NetSapiensPhoneModel[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/phones/models', { params });
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get phone models', data: [] };
    }
  }

  /** Get list of provisionable server profiles */
  async getPhoneServers(): Promise<NetSapiensApiResponse<NetSapiensPhoneServer[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/phones/servers');
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get phone servers', data: [] };
    }
  }

  /** Get provisionable server details */
  async getPhoneServer(server: string): Promise<NetSapiensApiResponse<NetSapiensPhoneServer>> {
    try {
      const response: AxiosResponse = await this.client.get(`/phones/servers/${server}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get phone server', data: undefined };
    }
  }

  /** Get a specific MAC address (system-level) */
  async getSystemPhoneByMac(mac: string): Promise<NetSapiensApiResponse<NetSapiensPhoneMac>> {
    try {
      const response: AxiosResponse = await this.client.get(`/phones/${mac}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get system phone', data: undefined };
    }
  }

  // ==================== RECORDINGS ====================

  /** Get a recording by call ID for a domain */
  async getDomainRecording(domain: string, callId: string): Promise<NetSapiensApiResponse<NetSapiensRecording>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/recordings/${callId}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain recording', data: undefined };
    }
  }

  /** Get a recording by call ID for a user */
  async getUserRecording(domain: string, userId: string, callId: string): Promise<NetSapiensApiResponse<NetSapiensRecording>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/recordings/${callId}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get user recording', data: undefined };
    }
  }

  // ==================== TRANSCRIPTIONS ====================

  /** Get transcription for a specific call */
  async getTranscription(domain: string, params?: any): Promise<NetSapiensApiResponse<NetSapiensTranscription>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/transcriptions`, { params });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get transcription', data: undefined };
    }
  }

  // ==================== MESSAGING ====================

  /** Get message sessions for a domain */
  async getDomainMessageSessions(domain: string): Promise<NetSapiensApiResponse<NetSapiensMessageSession[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/messagesessions`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain message sessions', data: [] };
    }
  }

  /** Start a new message session */
  async startMessageSession(domain: string, userId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/messages`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to start message session', data: undefined };
    }
  }

  /** Get message sessions for a user */
  async getUserMessageSessions(domain: string, userId: string): Promise<NetSapiensApiResponse<NetSapiensMessageSession[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/messagesessions`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get user message sessions', data: [] };
    }
  }

  /** Get a specific message session */
  async getUserMessageSession(domain: string, userId: string, session: string): Promise<NetSapiensApiResponse<NetSapiensMessageSession>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/messagesessions/${session}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get message session', data: undefined };
    }
  }

  /** Update a message session (participants or name) */
  async updateMessageSession(domain: string, userId: string, session: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/users/${userId}/messagesessions/${session}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update message session', data: undefined };
    }
  }

  /** Delete a message session */
  async deleteMessageSession(domain: string, userId: string, session: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/users/${userId}/messagesessions/${session}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete message session', data: undefined };
    }
  }

  /** Leave a message session */
  async leaveMessageSession(domain: string, userId: string, session: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/users/${userId}/messagesessions/${session}/leave`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to leave message session', data: undefined };
    }
  }

  /** Get messages for a session */
  async getSessionMessages(domain: string, userId: string, session: string, params?: any): Promise<NetSapiensApiResponse<NetSapiensMessage[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/messagesessions/${session}/messages`, { params });
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get session messages', data: [] };
    }
  }

  /** Send a message (chat, group chat, media, SMS, group SMS, or MMS - determined by body) */
  async sendMessage(domain: string, userId: string, session: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/messagesessions/${session}/messages`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to send message', data: undefined };
    }
  }

  // ==================== SMS NUMBERS ====================

  /** Get SMS numbers for a domain */
  async getDomainSmsNumbers(domain: string): Promise<NetSapiensApiResponse<NetSapiensSmsNumber[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/smsnumbers`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain SMS numbers', data: [] };
    }
  }

  /** Create an SMS number */
  async createSmsNumber(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/smsnumbers`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create SMS number', data: undefined };
    }
  }

  /** Update an SMS number */
  async updateSmsNumber(domain: string, smsnumber: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/smsnumbers/${smsnumber}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update SMS number', data: undefined };
    }
  }

  /** Delete an SMS number */
  async deleteSmsNumber(domain: string, smsnumber: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/smsnumbers/${smsnumber}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete SMS number', data: undefined };
    }
  }

  /** Get all SMS numbers (system-level) */
  async getSystemSmsNumbers(params?: any): Promise<NetSapiensApiResponse<NetSapiensSmsNumber[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/smsnumbers', { params });
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get system SMS numbers', data: [] };
    }
  }

  /** Get SMS numbers for a user */
  async getUserSmsNumbers(domain: string, userId: string): Promise<NetSapiensApiResponse<NetSapiensSmsNumber[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/smsnumbers`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get user SMS numbers', data: [] };
    }
  }

  /** Count SMS numbers for a user */
  async countUserSmsNumbers(domain: string, userId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/smsnumbers/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count user SMS numbers', data: undefined };
    }
  }

  // ==================== SMS BLOCKS ====================

  /** Get SMS blocks for a domain */
  async getDomainSmsBlocks(domain: string): Promise<NetSapiensApiResponse<NetSapiensSmsBlock[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/smsblocks`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain SMS blocks', data: [] };
    }
  }

  /** Add SMS blocks for a domain */
  async createDomainSmsBlock(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/smsblocks`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create domain SMS block', data: undefined };
    }
  }

  /** Update an SMS block for a domain */
  async updateDomainSmsBlock(domain: string, id: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/smsblocks/${id}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update domain SMS block', data: undefined };
    }
  }

  /** Delete an SMS block for a domain */
  async deleteDomainSmsBlock(domain: string, id: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/smsblocks/${id}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete domain SMS block', data: undefined };
    }
  }

  /** Get SMS blocks for all domains (system-level) */
  async getSystemSmsBlocks(params?: any): Promise<NetSapiensApiResponse<NetSapiensSmsBlock[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/smsblocks', { params });
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get system SMS blocks', data: [] };
    }
  }

  // ==================== STATISTICS (EXTENDED) ====================

  /** Get DNIS statistics for all queues */
  async getDnisStatistics(domain: string, params?: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/statistics/DNIS`, { params });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get DNIS statistics', data: undefined };
    }
  }

  /** Get DNIS statistics for a single queue */
  async getDnisQueueStatistics(domain: string, callqueue: string, params?: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/statistics/DNIS/callqueues/${callqueue}`, { params });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get DNIS queue statistics', data: undefined };
    }
  }

  /** Get agent statistics for a single queue */
  async getAgentStatisticsForQueue(domain: string, callqueue: string, params?: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/statistics/agent/callqueues/${callqueue}`, { params });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get agent statistics for queue', data: undefined };
    }
  }

  /** Get agent log */
  async getAgentLog(domain: string, params?: any): Promise<NetSapiensApiResponse<any[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/statistics/agentLog`, { params });
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get agent log', data: [] };
    }
  }

  /** Get call queue statistics aggregated */
  async getCallQueueStatsAggregate(domain: string, params?: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/statistics/callqueues/aggregate`, { params });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get call queue stats aggregate', data: undefined };
    }
  }

  /** Get call queue statistics per queue */
  async getCallQueueStatsPerQueue(domain: string, params?: any): Promise<NetSapiensApiResponse<any[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/statistics/callqueues/per-queue`, { params });
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get call queue stats per queue', data: [] };
    }
  }

  /** Get call queue statistics for a specific queue */
  async getCallQueueStats(domain: string, callqueue: string, params?: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/statistics/callqueues/${callqueue}`, { params });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get call queue stats', data: undefined };
    }
  }

  // ==================== BILLING & QUOTAS (EXTENDED) ====================

  /** Get quotas for a domain */
  async getDomainQuotas(domain: string): Promise<NetSapiensApiResponse<NetSapiensQuota[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/quotas`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain quotas', data: [] };
    }
  }

  /** Count quotas for a domain */
  async countDomainQuotas(domain: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/quotas/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count domain quotas', data: undefined };
    }
  }

  // ==================== DIAL PLANS (DOMAIN) ====================

  /** Create a dial plan for a domain */
  async createDomainDialPlan(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/dialplans`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create domain dial plan', data: undefined };
    }
  }

  /** Update a dial plan for a domain */
  async updateDomainDialPlan(domain: string, dialplan: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/dialplans/${dialplan}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update domain dial plan', data: undefined };
    }
  }

  /** Delete a dial plan for a domain */
  async deleteDomainDialPlan(domain: string, dialplan: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/dialplans/${dialplan}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete domain dial plan', data: undefined };
    }
  }

  /** Get dial rules in a dial plan */
  async getDomainDialRules(domain: string, dialplan: string): Promise<NetSapiensApiResponse<NetSapiensDialRule[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/dialplans/${dialplan}/dialrules`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain dial rules', data: [] };
    }
  }

  /** Create a dial rule in a dial plan */
  async createDomainDialRule(domain: string, dialplan: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/dialplans/${dialplan}/dialrules`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create domain dial rule', data: undefined };
    }
  }

  /** Count dial rules in a dial plan */
  async countDomainDialRules(domain: string, dialplan: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/dialplans/${dialplan}/dialrules/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count domain dial rules', data: undefined };
    }
  }

  /** Get a specific dial rule */
  async getDomainDialRule(domain: string, dialplan: string, dialrule: string): Promise<NetSapiensApiResponse<NetSapiensDialRule>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/dialplans/${dialplan}/dialrules/${dialrule}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain dial rule', data: undefined };
    }
  }

  /** Update a dial rule */
  async updateDomainDialRule(domain: string, dialplan: string, dialrule: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/dialplans/${dialplan}/dialrules/${dialrule}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update domain dial rule', data: undefined };
    }
  }

  /** Delete a dial rule */
  async deleteDomainDialRule(domain: string, dialplan: string, dialrule: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/dialplans/${dialplan}/dialrules/${dialrule}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete domain dial rule', data: undefined };
    }
  }

  // ==================== DIAL PLANS (SYSTEM) ====================

  /** Get system dial plans */
  async getSystemDialPlans(): Promise<NetSapiensApiResponse<NetSapiensDialPlan[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/dialplans');
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get system dial plans', data: [] };
    }
  }

  /** Create a global dial plan */
  async createSystemDialPlan(data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post('/dialplans', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create system dial plan', data: undefined };
    }
  }

  // ==================== DIAL POLICY (DOMAIN) ====================

  /** Get a specific dial policy in a domain */
  async getDomainDialPolicy(domain: string, policy: string): Promise<NetSapiensApiResponse<NetSapiensDialPolicy>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/dialpolicy/${policy}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain dial policy', data: undefined };
    }
  }

  /** Update a dial policy in a domain */
  async updateDomainDialPolicy(domain: string, policy: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/dialpolicy/${policy}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update domain dial policy', data: undefined };
    }
  }

  /** Delete a dial policy in a domain */
  async deleteDomainDialPolicy(domain: string, policy: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/dialpolicy/${policy}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete domain dial policy', data: undefined };
    }
  }

  /** Get permissions in a dial policy (domain) */
  async getDomainDialPermissions(domain: string, policy: string): Promise<NetSapiensApiResponse<NetSapiensDialPermission[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/dialpolicy/${policy}/permission`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain dial permissions', data: [] };
    }
  }

  /** Add a permission to a dial policy (domain) */
  async createDomainDialPermission(domain: string, policy: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/dialpolicy/${policy}/permission`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create domain dial permission', data: undefined };
    }
  }

  /** Get a specific permission in a dial policy (domain) */
  async getDomainDialPermission(domain: string, policy: string, id: string): Promise<NetSapiensApiResponse<NetSapiensDialPermission>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/dialpolicy/${policy}/permission/${id}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain dial permission', data: undefined };
    }
  }

  /** Update a permission in a dial policy (domain) */
  async updateDomainDialPermission(domain: string, policy: string, id: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/dialpolicy/${policy}/permission/${id}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update domain dial permission', data: undefined };
    }
  }

  /** Delete a permission from a dial policy (domain) */
  async deleteDomainDialPermission(domain: string, policy: string, id: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/dialpolicy/${policy}/permission/${id}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete domain dial permission', data: undefined };
    }
  }

  // ==================== DIAL POLICY (SYSTEM) ====================

  /** Get system dial policies */
  async getSystemDialPolicies(): Promise<NetSapiensApiResponse<NetSapiensDialPolicy[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/dialpolicy');
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get system dial policies', data: [] };
    }
  }

  /** Create a system dial policy */
  async createSystemDialPolicy(data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post('/dialpolicy', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create system dial policy', data: undefined };
    }
  }

  /** Get a specific system dial policy */
  async getSystemDialPolicy(policy: string): Promise<NetSapiensApiResponse<NetSapiensDialPolicy>> {
    try {
      const response: AxiosResponse = await this.client.get(`/dialpolicy/${policy}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get system dial policy', data: undefined };
    }
  }

  /** Update a system dial policy */
  async updateSystemDialPolicy(policy: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/dialpolicy/${policy}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update system dial policy', data: undefined };
    }
  }

  /** Delete a system dial policy */
  async deleteSystemDialPolicy(policy: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/dialpolicy/${policy}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete system dial policy', data: undefined };
    }
  }

  /** Get permissions in a system dial policy */
  async getSystemDialPermissions(policy: string): Promise<NetSapiensApiResponse<NetSapiensDialPermission[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/dialpolicy/${policy}/permission`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get system dial permissions', data: [] };
    }
  }

  /** Add a permission to a system dial policy */
  async createSystemDialPermission(policy: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/dialpolicy/${policy}/permission`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create system dial permission', data: undefined };
    }
  }

  /** Get a specific permission in a system dial policy */
  async getSystemDialPermission(policy: string, id: string): Promise<NetSapiensApiResponse<NetSapiensDialPermission>> {
    try {
      const response: AxiosResponse = await this.client.get(`/dialpolicy/${policy}/permission/${id}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get system dial permission', data: undefined };
    }
  }

  /** Update a permission in a system dial policy */
  async updateSystemDialPermission(policy: string, id: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/dialpolicy/${policy}/permission/${id}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update system dial permission', data: undefined };
    }
  }

  /** Delete a permission from a system dial policy */
  async deleteSystemDialPermission(policy: string, id: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/dialpolicy/${policy}/permission/${id}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete system dial permission', data: undefined };
    }
  }

  // ==================== SUBSCRIPTIONS (DOMAIN) ====================

  /** Get event subscriptions for a domain */
  async getDomainSubscriptions(domain: string): Promise<NetSapiensApiResponse<NetSapiensSubscription[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/subscriptions`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain subscriptions', data: [] };
    }
  }

  /** Create an event subscription for a domain */
  async createDomainSubscription(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/subscriptions`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create domain subscription', data: undefined };
    }
  }

  /** Update an event subscription for a domain */
  async updateDomainSubscription(domain: string, id: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/subscriptions/${id}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update domain subscription', data: undefined };
    }
  }

  /** Delete a subscription for a domain */
  async deleteDomainSubscription(domain: string, id: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/subscriptions/${id}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete domain subscription', data: undefined };
    }
  }

  // ==================== SUBSCRIPTIONS (SYSTEM) ====================

  /** Get system event subscriptions */
  async getSystemSubscriptions(): Promise<NetSapiensApiResponse<NetSapiensSubscription[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/subscriptions');
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get system subscriptions', data: [] };
    }
  }

  /** Create a system event subscription */
  async createSystemSubscription(data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post('/subscriptions', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create system subscription', data: undefined };
    }
  }

  /** Get a specific system event subscription */
  async getSystemSubscription(id: string): Promise<NetSapiensApiResponse<NetSapiensSubscription>> {
    try {
      const response: AxiosResponse = await this.client.get(`/subscriptions/${id}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get system subscription', data: undefined };
    }
  }

  /** Update a system event subscription */
  async updateSystemSubscription(id: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/subscriptions/${id}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update system subscription', data: undefined };
    }
  }

  /** Delete a system subscription */
  async deleteSystemSubscription(id: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/subscriptions/${id}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete system subscription', data: undefined };
    }
  }

  // ==================== ROUTES & ROUTE CONNECTIONS ====================

  /** Get routes */
  async getRoutes(): Promise<NetSapiensApiResponse<NetSapiensRoute[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/routes');
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get routes', data: [] };
    }
  }

  /** Create a route */
  async createRoute(data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post('/routes', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create route', data: undefined };
    }
  }

  /** Count routes */
  async countRoutes(): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get('/routes/count');
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count routes', data: undefined };
    }
  }

  /** Update a route */
  async updateRoute(routeId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/routes/${routeId}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update route', data: undefined };
    }
  }

  /** Delete a route */
  async deleteRoute(routeId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/routes/${routeId}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete route', data: undefined };
    }
  }

  /** Get route connections for a route */
  async getRouteConnections(routeId: string): Promise<NetSapiensApiResponse<NetSapiensRouteConnection[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/routes/${routeId}/routecon`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get route connections', data: [] };
    }
  }

  /** Create a route connection */
  async createRouteConnection(routeId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/routes/${routeId}/routecon`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create route connection', data: undefined };
    }
  }

  /** Update a route connection */
  async updateRouteConnection(routeId: string, index: number, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/routes/${routeId}/routecon/${index}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update route connection', data: undefined };
    }
  }

  /** Delete a route connection */
  async deleteRouteConnection(routeId: string, index: number): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/routes/${routeId}/routecon/${index}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete route connection', data: undefined };
    }
  }

  /** Count all route connections */
  async countRouteConnections(): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get('/routecon/count');
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count route connections', data: undefined };
    }
  }

  // ==================== CONNECTIONS (DOMAIN) ====================

  /** Get all connections for a domain */
  async getDomainConnections(domain: string): Promise<NetSapiensApiResponse<NetSapiensConnection[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/connections`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain connections', data: [] };
    }
  }

  /** Get a specific connection for a domain */
  async getDomainConnection(domain: string, connectionId: string): Promise<NetSapiensApiResponse<NetSapiensConnection>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/connections/${connectionId}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain connection', data: undefined };
    }
  }

  /** Update a connection for a domain */
  async updateDomainConnection(domain: string, origMatchPattern: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/connections/${origMatchPattern}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update domain connection', data: undefined };
    }
  }

  /** Delete a connection for a domain */
  async deleteDomainConnection(domain: string, connectionId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/connections/${connectionId}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete domain connection', data: undefined };
    }
  }

  // ==================== CONNECTIONS (SYSTEM) ====================

  /** Get all system connections */
  async getSystemConnections(): Promise<NetSapiensApiResponse<NetSapiensConnection[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/connections');
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get system connections', data: [] };
    }
  }

  /** Create a system connection */
  async createSystemConnection(data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post('/connections', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create system connection', data: undefined };
    }
  }

  /** Count all system connections */
  async countSystemConnections(): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get('/connections/count');
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count system connections', data: undefined };
    }
  }

  // ==================== NUMBER FILTERS ====================

  /** Get blocked numbers for a domain */
  async getDomainNumberFilters(domain: string): Promise<NetSapiensApiResponse<NetSapiensNumberFilter[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/number-filters`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain number filters', data: [] };
    }
  }

  /** Add blocked numbers for a domain */
  async addDomainNumberFilter(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/number-filters`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to add domain number filter', data: undefined };
    }
  }

  /** Delete blocked numbers for a domain */
  async deleteDomainNumberFilter(domain: string, data?: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/number-filters`, { data });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete domain number filter', data: undefined };
    }
  }

  /** Get blocked numbers for a user */
  async getUserNumberFilters(domain: string, userId: string): Promise<NetSapiensApiResponse<NetSapiensNumberFilter[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/number-filters`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get user number filters', data: [] };
    }
  }

  /** Add blocked numbers for a user */
  async addUserNumberFilter(domain: string, userId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/number-filters`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to add user number filter', data: undefined };
    }
  }

  /** Delete blocked numbers for a user */
  async deleteUserNumberFilter(domain: string, userId: string, data?: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/users/${userId}/number-filters`, { data });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete user number filter', data: undefined };
    }
  }

  // ==================== ADDRESSES (DOMAIN) ====================

  /** Get addresses for a domain */
  async getDomainAddresses(domain: string): Promise<NetSapiensApiResponse<NetSapiensAddress[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/addresses`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain addresses', data: [] };
    }
  }

  /** Create an address for a domain */
  async createDomainAddress(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/addresses`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create domain address', data: undefined };
    }
  }

  /** Count addresses for a domain */
  async countDomainAddresses(domain: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/addresses/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count domain addresses', data: undefined };
    }
  }

  /** Update an address for a domain */
  async updateDomainAddress(domain: string, addressId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/addresses/${addressId}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update domain address', data: undefined };
    }
  }

  /** Delete an address for a domain */
  async deleteDomainAddress(domain: string, addressId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/addresses/${addressId}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete domain address', data: undefined };
    }
  }

  /** Get address endpoints for a domain */
  async getDomainAddressEndpoints(domain: string): Promise<NetSapiensApiResponse<NetSapiensAddressEndpoint[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/addresses/endpoints`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain address endpoints', data: [] };
    }
  }

  /** Create an address endpoint */
  async createDomainAddressEndpoint(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/addresses/endpoints`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create domain address endpoint', data: undefined };
    }
  }

  /** Update an address endpoint */
  async updateDomainAddressEndpoint(domain: string, endpoint: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/addresses/endpoints/${endpoint}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update domain address endpoint', data: undefined };
    }
  }

  /** Delete an address endpoint */
  async deleteDomainAddressEndpoint(domain: string, endpoint: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/addresses/endpoints/${endpoint}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete domain address endpoint', data: undefined };
    }
  }

  /** Validate an address */
  async validateDomainAddress(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/addresses/validate`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to validate domain address', data: undefined };
    }
  }

  // ==================== ADDRESSES (USER) ====================

  /** Get addresses for a user */
  async getUserAddresses(domain: string, userId: string): Promise<NetSapiensApiResponse<NetSapiensAddress[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/addresses`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get user addresses', data: [] };
    }
  }

  /** Create an address for a user */
  async createUserAddress(domain: string, userId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/addresses`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create user address', data: undefined };
    }
  }

  /** Get a specific address for a user */
  async getUserAddress(domain: string, userId: string, addressId: string): Promise<NetSapiensApiResponse<NetSapiensAddress>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/addresses/${addressId}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get user address', data: undefined };
    }
  }

  /** Update an address for a user */
  async updateUserAddress(domain: string, userId: string, addressId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/users/${userId}/addresses/${addressId}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update user address', data: undefined };
    }
  }

  /** Delete an address for a user */
  async deleteUserAddress(domain: string, userId: string, addressId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/users/${userId}/addresses/${addressId}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete user address', data: undefined };
    }
  }

  // ==================== VIDEO/IOTUM (DOMAIN) ====================

  /** Get Iotum video company for a domain */
  async getVideoCompany(domain: string): Promise<NetSapiensApiResponse<NetSapiensVideoCompany>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/video`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get video company', data: undefined };
    }
  }

  /** Create Iotum video company */
  async createVideoCompany(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/video`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create video company', data: undefined };
    }
  }

  /** Update Iotum video company */
  async updateVideoCompany(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/video`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update video company', data: undefined };
    }
  }

  /** Delete a video company */
  async deleteVideoCompany(domain: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/video`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete video company', data: undefined };
    }
  }

  /** Get available video products */
  async getVideoAvailableProducts(domain: string): Promise<NetSapiensApiResponse<NetSapiensVideoProduct[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/video/availableproducts`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get video available products', data: [] };
    }
  }

  /** Get all video hosts in a domain */
  async getVideoHosts(domain: string): Promise<NetSapiensApiResponse<NetSapiensVideoHost[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/video/hosts`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get video hosts', data: [] };
    }
  }

  /** Get video company products */
  async getVideoProducts(domain: string): Promise<NetSapiensApiResponse<NetSapiensVideoProduct[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/video/products`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get video products', data: [] };
    }
  }

  /** Create a video subscription */
  async createVideoSubscription(domain: string, slug: string, data?: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/video/subscription/${slug}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create video subscription', data: undefined };
    }
  }

  /** Delete a video subscription */
  async deleteVideoSubscription(domain: string, slug: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/video/subscription/${slug}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete video subscription', data: undefined };
    }
  }

  /** Update video subscriptions */
  async updateVideoSubscriptions(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/video/subscriptions`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update video subscriptions', data: undefined };
    }
  }

  /** Get video domain resellers (system-level) */
  async getVideoResellers(): Promise<NetSapiensApiResponse<any[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/video/resellers');
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get video resellers', data: [] };
    }
  }

  // ==================== VIDEO/IOTUM (USER) ====================

  /** Get user video host */
  async getUserVideo(domain: string, userId: string): Promise<NetSapiensApiResponse<NetSapiensVideoHost>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/video`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get user video', data: undefined };
    }
  }

  /** Get user video conferences */
  async getUserVideoConferences(domain: string, userId: string): Promise<NetSapiensApiResponse<any[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/video/conference`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get user video conferences', data: [] };
    }
  }

  /** Create an ad-hoc video conference */
  async createUserVideoConference(domain: string, userId: string, data?: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/video/conference`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create video conference', data: undefined };
    }
  }

  /** Get user video contacts */
  async getUserVideoContacts(domain: string, userId: string): Promise<NetSapiensApiResponse<any[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/video/contacts`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get user video contacts', data: [] };
    }
  }

  /** Create a host for a user */
  async createUserHost(domain: string, userId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/host`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create user host', data: undefined };
    }
  }

  /** Update a user's host */
  async updateUserHost(domain: string, userId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/users/${userId}/host`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update user host', data: undefined };
    }
  }

  /** Delete a user's host */
  async deleteUserHost(domain: string, userId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/users/${userId}/host`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete user host', data: undefined };
    }
  }

  /** Create host contacts for a user */
  async createUserHostContacts(domain: string, userId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/host/contacts`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create user host contacts', data: undefined };
    }
  }

  // ==================== MEETINGS ====================

  /** Get meetings for a user */
  async getUserMeetings(domain: string, userId: string): Promise<NetSapiensApiResponse<NetSapiensMeeting[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/meetings`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get user meetings', data: [] };
    }
  }

  /** Create a meeting */
  async createUserMeeting(domain: string, userId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/meetings`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create meeting', data: undefined };
    }
  }

  /** Count meetings */
  async countUserMeetings(domain: string, userId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/meetings/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count meetings', data: undefined };
    }
  }

  /** Request a meeting ID */
  async requestMeetingId(domain: string, userId: string, data?: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/meetings/getId`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to request meeting ID', data: undefined };
    }
  }

  /** Create a meeting with a specific ID */
  async createUserMeetingWithId(domain: string, userId: string, meetingId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/meetings/${meetingId}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create meeting with ID', data: undefined };
    }
  }

  /** Get a specific meeting */
  async getUserMeeting(domain: string, userId: string, meetingId: string): Promise<NetSapiensApiResponse<NetSapiensMeeting>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/meetings/${meetingId}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get meeting', data: undefined };
    }
  }

  /** Update a meeting */
  async updateUserMeeting(domain: string, userId: string, meetingId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/domains/${domain}/users/${userId}/meetings/${meetingId}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update meeting', data: undefined };
    }
  }

  /** Delete a meeting */
  async deleteUserMeeting(domain: string, userId: string, meetingId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/domains/${domain}/users/${userId}/meetings/${meetingId}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete meeting', data: undefined };
    }
  }

  /** Count a specific meeting */
  async countUserMeeting(domain: string, userId: string, meetingId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/meetings/${meetingId}/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count meeting', data: undefined };
    }
  }

  /** Create a meeting log event */
  async createMeetingLog(domain: string, userId: string, meetingId: string, instance: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/meetings/${meetingId}/instance/${instance}/log`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create meeting log', data: undefined };
    }
  }

  /** Get meeting log events */
  async getMeetingLog(domain: string, userId: string, meetingId: string, instance: string): Promise<NetSapiensApiResponse<NetSapiensMeetingLog[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/meetings/${meetingId}/instance/${instance}/log`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get meeting log', data: [] };
    }
  }

  /** Register for a meeting */
  async registerMeeting(meetingRegistrationId: string, data?: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/meetings/register/${meetingRegistrationId}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to register meeting', data: undefined };
    }
  }

  // ==================== HOLIDAYS ====================

  /** Get list of supported countries */
  async getHolidayCountries(): Promise<NetSapiensApiResponse<any[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/holidays/countries');
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get holiday countries', data: [] };
    }
  }

  /** Get list of supported regions */
  async getHolidayRegions(): Promise<NetSapiensApiResponse<any[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/holidays/regions');
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get holiday regions', data: [] };
    }
  }

  /** Get holidays by country */
  async getHolidaysByCountry(country: string, year: number): Promise<NetSapiensApiResponse<NetSapiensHoliday[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/holidays/${country}/${year}`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get holidays by country', data: [] };
    }
  }

  /** Get holidays by country and region */
  async getHolidaysByCountryAndRegion(country: string, region: string, year: number): Promise<NetSapiensApiResponse<NetSapiensHoliday[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/holidays/${country}/${region}/${year}`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get holidays by country and region', data: [] };
    }
  }

  // ==================== CERTIFICATES ====================

  /** Get SSL certificates */
  async getCertificates(): Promise<NetSapiensApiResponse<NetSapiensCertificate[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/certificates');
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get certificates', data: [] };
    }
  }

  /** Create an SSL certificate */
  async createCertificate(data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post('/certificates', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create certificate', data: undefined };
    }
  }

  /** Get an SSL certificate by common name */
  async getCertificate(name: string): Promise<NetSapiensApiResponse<NetSapiensCertificate>> {
    try {
      const response: AxiosResponse = await this.client.get(`/certificates/${name}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get certificate', data: undefined };
    }
  }

  /** Update an SSL certificate */
  async updateCertificate(name: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/certificates/${name}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update certificate', data: undefined };
    }
  }

  /** Delete an SSL certificate */
  async deleteCertificate(name: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/certificates/${name}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete certificate', data: undefined };
    }
  }

  // ==================== IMAGES ====================

  /** Get an image */
  async getImage(filename: string): Promise<NetSapiensApiResponse<NetSapiensImageFile>> {
    try {
      const response: AxiosResponse = await this.client.get(`/images/${filename}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get image', data: undefined };
    }
  }

  /** Create an image (JSON + Base64 or multipart upload) */
  async createImage(filename: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/images/${filename}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create image', data: undefined };
    }
  }

  /** Create an image from file upload */
  async createImageUpload(filename: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/images/${filename}`, data, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create image from upload', data: undefined };
    }
  }

  /** Update an image */
  async updateImage(filename: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/images/${filename}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update image', data: undefined };
    }
  }

  /** Delete an image */
  async deleteImage(filename: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/images/${filename}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete image', data: undefined };
    }
  }

  // ==================== TEMPLATES ====================

  /** Get a template */
  async getTemplate(filename: string): Promise<NetSapiensApiResponse<NetSapiensTemplate>> {
    try {
      const response: AxiosResponse = await this.client.get(`/templates/${filename}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get template', data: undefined };
    }
  }

  /** Create a template */
  async createTemplate(filename: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/templates/${filename}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create template', data: undefined };
    }
  }

  /** Update a template */
  async updateTemplate(filename: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/templates/${filename}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update template', data: undefined };
    }
  }

  /** Delete a template */
  async deleteTemplate(filename: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/templates/${filename}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete template', data: undefined };
    }
  }

  // ==================== DEPARTMENTS & PRESENCE ====================

  /** List departments in a domain */
  async listDepartments(domain: string): Promise<NetSapiensApiResponse<NetSapiensDepartment[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/departments/list`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to list departments', data: [] };
    }
  }

  /** List presence in a department */
  async listDepartmentPresence(domain: string, department: string): Promise<NetSapiensApiResponse<NetSapiensPresence[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/departments/${department}/presence/list`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to list department presence', data: [] };
    }
  }

  /** List presence in a domain */
  async listDomainPresence(domain: string): Promise<NetSapiensApiResponse<NetSapiensPresence[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/presence/list`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to list domain presence', data: [] };
    }
  }

  // ==================== DASHBOARDS & CHARTS ====================

  /** Count charts for a dashboard */
  async countDomainCharts(domain: string, dashboardId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/charts/${dashboardId}/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count charts', data: undefined };
    }
  }

  /** Get chart list for a dashboard */
  async getDomainChartList(domain: string, dashboardId: string): Promise<NetSapiensApiResponse<NetSapiensChart[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/charts/${dashboardId}/list`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get chart list', data: [] };
    }
  }

  /** Count dashboards for a user */
  async countUserDashboards(domain: string, userId: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/dashboards/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count user dashboards', data: undefined };
    }
  }

  /** Get dashboard list for a user */
  async getUserDashboardList(domain: string, userId: string): Promise<NetSapiensApiResponse<NetSapiensDashboard[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/dashboards/list`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get user dashboard list', data: [] };
    }
  }

  // ==================== SCHEDULES ====================

  /** Count CDR schedules for a domain */
  async countDomainSchedules(domain: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/schedule/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count domain schedules', data: undefined };
    }
  }

  /** Count CDR schedules by name */
  async countDomainSchedulesByName(domain: string, scheduleName: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/schedule/${scheduleName}/count`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count domain schedules by name', data: undefined };
    }
  }

  // ==================== EMAIL ====================

  /** Send email using template */
  async sendUserEmail(domain: string, userId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/email`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to send email', data: undefined };
    }
  }

  /** Verify email */
  async verifyUserEmail(domain: string, userId: string, token: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/email/verify/${token}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to verify email', data: undefined };
    }
  }

  // ==================== VOICES / TTS ====================

  /** Synthesize voice (TTS) via POST */
  async synthesizeVoice(domain: string, userId: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/users/${userId}/voices`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to synthesize voice', data: undefined };
    }
  }

  /** Synthesize voice (TTS) via GET */
  async synthesizeVoiceGet(domain: string, userId: string, params?: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/voices`, { params });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to synthesize voice', data: undefined };
    }
  }

  /** Get available voices for a language */
  async getAvailableVoices(domain: string, userId: string, language: string): Promise<NetSapiensApiResponse<NetSapiensVoice[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/users/${userId}/voices/${language}`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get available voices', data: [] };
    }
  }

  // ==================== FIREBASE ====================

  /** Read firebase service accounts */
  async getFirebaseAccounts(): Promise<NetSapiensApiResponse<NetSapiensFirebaseAccount[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/firebase');
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get firebase accounts', data: [] };
    }
  }

  /** Add firebase service account */
  async addFirebaseAccount(data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post('/firebase', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to add firebase account', data: undefined };
    }
  }

  // ==================== SIP FLOW / CALL TRACE ====================

  /** Get call trace (SIPFlow) */
  async getCallTrace(params: any): Promise<NetSapiensApiResponse<NetSapiensSipFlow>> {
    try {
      const response: AxiosResponse = await this.client.get('/sipflow', { params });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get call trace', data: undefined };
    }
  }

  /** Get cradle-to-grave info for a call */
  async getCradleToGrave(params: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get('/sipflow', { params: { ...params, format: 'cradle_to_grave' } });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get cradle to grave', data: undefined };
    }
  }

  /** Get CSV of call trace */
  async getCallTraceCSV(params: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get('/sipflow', { params: { ...params, format: 'csv' } });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get call trace CSV', data: undefined };
    }
  }

  // ==================== QUEUED CALLS ====================

  /** Add a queued call */
  async addQueuedCall(domain: string, callqueue: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/queuedcall/${callqueue}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to add queued call', data: undefined };
    }
  }

  /** Read queued calls */
  async getQueuedCalls(domain: string, queue: string): Promise<NetSapiensApiResponse<NetSapiensQueuedCall[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/queuedcall/${queue}`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get queued calls', data: [] };
    }
  }

  // ==================== CALL QUEUE REPORTS ====================

  /** Get abandoned calls for all queues */
  async getAbandonedCalls(domain: string, params?: any): Promise<NetSapiensApiResponse<NetSapiensCallQueueReport[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/callqueuereport/abandoned`, { params });
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get abandoned calls', data: [] };
    }
  }

  /** Get abandoned calls for a specific queue */
  async getAbandonedCallsForQueue(domain: string, callqueue: string, params?: any): Promise<NetSapiensApiResponse<NetSapiensCallQueueReport>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/callqueuereport/abandoned/${callqueue}`, { params });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get abandoned calls for queue', data: undefined };
    }
  }

  // ==================== CONFIGURATIONS ====================

  /** Get all configuration definitions */
  async getConfigDefinitions(): Promise<NetSapiensApiResponse<NetSapiensConfigDefinition[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/config-definitions');
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get config definitions', data: [] };
    }
  }

  /** Create a configuration definition */
  async createConfigDefinition(data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post('/config-definitions', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create config definition', data: undefined };
    }
  }

  /** Get a specific configuration definition */
  async getConfigDefinition(configName: string): Promise<NetSapiensApiResponse<NetSapiensConfigDefinition>> {
    try {
      const response: AxiosResponse = await this.client.get(`/config-definitions/${configName}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get config definition', data: undefined };
    }
  }

  /** Update a configuration definition */
  async updateConfigDefinition(configName: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put(`/config-definitions/${configName}`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update config definition', data: undefined };
    }
  }

  /** Delete a configuration definition */
  async deleteConfigDefinition(configName: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/config-definitions/${configName}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete config definition', data: undefined };
    }
  }

  /** Get all configurations */
  async getConfigurations(): Promise<NetSapiensApiResponse<NetSapiensConfiguration[]>> {
    try {
      const response: AxiosResponse = await this.client.get('/configurations');
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get configurations', data: [] };
    }
  }

  /** Create a configuration */
  async createConfiguration(data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post('/configurations', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create configuration', data: undefined };
    }
  }

  /** Update a configuration */
  async updateConfiguration(data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.put('/configurations', data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update configuration', data: undefined };
    }
  }

  /** Count configurations */
  async countConfigurations(): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get('/configurations/count');
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to count configurations', data: undefined };
    }
  }

  /** Get a specific configuration */
  async getConfiguration(configName: string): Promise<NetSapiensApiResponse<NetSapiensConfiguration>> {
    try {
      const response: AxiosResponse = await this.client.get(`/configurations/${configName}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get configuration', data: undefined };
    }
  }

  /** Delete a configuration */
  async deleteConfiguration(configName: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.delete(`/configurations/${configName}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete configuration', data: undefined };
    }
  }

  // ==================== METHOD ALIASES (tool compatibility) ====================

  // --- Addresses ---
  listUserAddresses(domain: string, userId: string) { return this.getUserAddresses(domain, userId); }
  listDomainAddresses(domain: string) { return this.getDomainAddresses(domain); }
  validateAddress(domain: string, data: any) { return this.validateDomainAddress(domain, data); }
  listAddressEndpoints(domain: string) { return this.getDomainAddressEndpoints(domain); }
  createAddressEndpoint(domain: string, data: any) { return this.createDomainAddressEndpoint(domain, data); }
  updateAddressEndpoint(domain: string, endpoint: string, data: any) { return this.updateDomainAddressEndpoint(domain, endpoint, data); }
  deleteAddressEndpoint(domain: string, endpoint: string) { return this.deleteDomainAddressEndpoint(domain, endpoint); }
  async countAddresses(domain: string): Promise<NetSapiensApiResponse<any>> {
    return this.countDomainAddresses(domain);
  }

  // --- Answer Rules ---
  createAnswerRule(domain: string, userId: string, data: any) { return this.createUserAnswerRule(domain, userId, data); }
  updateAnswerRule(domain: string, userId: string, timeframe: string, data: any) { return this.updateUserAnswerRule(domain, userId, timeframe, data); }
  deleteAnswerRule(domain: string, userId: string, timeframe: string) { return this.deleteUserAnswerRule(domain, userId, timeframe); }
  reorderAnswerRules(domain: string, userId: string, order: any) { return this.reorderUserAnswerRules(domain, userId, order); }
  countAnswerRules(domain: string, userId: string) { return this.countUserAnswerRules(domain, userId); }

  // --- Call Queues ---
  getQueueAgent(domain: string, queueId: string, agentId: string) { return this.getCallQueueAgent(domain, queueId, agentId); }
  addQueueAgent(domain: string, queueId: string, data: any) { return this.addCallQueueAgent(domain, queueId, data); }
  updateQueueAgent(domain: string, queueId: string, agentId: string, data: any) { return this.updateCallQueueAgent(domain, queueId, agentId, data); }
  removeQueueAgent(domain: string, queueId: string, agentId: string) { return this.removeCallQueueAgent(domain, queueId, agentId); }
  setAgentStatus(domain: string, agentId: string, status: string) { return this.setAgentOfflineStatus(domain, agentId, status); }
  countQueueAgents(domain: string, queueId: string) { return this.countCallQueueAgents(domain, queueId); }

  // --- Active Calls ---
  listUserActiveCalls(domain: string, userId: string) { return this.getUserActiveCalls(domain, userId); }
  listActiveCalls(domain: string) { return this.getDomainActiveCalls(domain); }
  async countActiveCalls(domain: string): Promise<NetSapiensApiResponse<any>> {
    return this.countDomainActiveCalls(domain);
  }
  transferCallPeer(domain: string, userId: string, callId: string, to: any) { return this.transferPeerCall(domain, userId, callId, to); }

  // --- CDRs ---
  async countCDRRecords(domain: string, user?: string, startDate?: string, endDate?: string): Promise<NetSapiensApiResponse<any>> {
    return this.countDomainCDRs(domain, { user, startDate, endDate });
  }
  async searchCDRRecords(domain: string, query: string, startDate?: string, endDate?: string, limit?: number): Promise<NetSapiensApiResponse<any>> {
    return this.searchDomainCDRs(domain, { query, startDate, endDate, limit });
  }

  // --- Conferences ---
  listConferences(domain: string) { return this.getConferences(domain); }
  listConferenceParticipants(domain: string, conference: string) { return this.getConferenceParticipants(domain, conference); }
  addConferenceParticipant(domain: string, conference: string, data: any) { return this.createConferenceParticipant(domain, conference, data); }
  removeConferenceParticipant(domain: string, conference: string, participant: string) { return this.deleteConferenceParticipant(domain, conference, participant); }
  getConferenceCdr(domain: string, conference: string) { return this.getConferenceCDR(domain, conference); }

  // --- Contacts ---
  listUserContacts(domain: string, userId: string) { return this.getUserContacts(domain, userId); }
  listDomainContacts(domain: string) { return this.getDomainContacts(domain); }

  // --- Dial Plans ---
  async listDomainDialPlans(domain: string): Promise<NetSapiensApiResponse<NetSapiensDialPlan[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/dialplans`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain dial plans', data: [] };
    }
  }
  listSystemDialPlans() { return this.getSystemDialPlans(); }
  updateDialPlan(domain: string, dialplan: string, data: any) { return this.updateDomainDialPlan(domain, dialplan, data); }
  deleteDialPlan(domain: string, dialplan: string) { return this.deleteDomainDialPlan(domain, dialplan); }
  listDialRules(domain: string, dialplan: string) { return this.getDomainDialRules(domain, dialplan); }
  getDialRule(domain: string, dialplan: string, dialrule: string) { return this.getDomainDialRule(domain, dialplan, dialrule); }
  createDialRule(domain: string, dialplan: string, data: any) { return this.createDomainDialRule(domain, dialplan, data); }
  updateDialRule(domain: string, dialplan: string, dialrule: string, data: any) { return this.updateDomainDialRule(domain, dialplan, dialrule, data); }
  deleteDialRule(domain: string, dialplan: string, dialrule: string) { return this.deleteDomainDialRule(domain, dialplan, dialrule); }
  countDialRules(domain: string, dialplan: string) { return this.countDomainDialRules(domain, dialplan); }

  // --- Dial Policy ---
  async listDomainDialPolicies(domain: string): Promise<NetSapiensApiResponse<NetSapiensDialPolicy[]>> {
    try {
      const response: AxiosResponse = await this.client.get(`/domains/${domain}/dialpolicy`);
      return { success: true, data: Array.isArray(response.data) ? response.data : [response.data] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get domain dial policies', data: [] };
    }
  }
  listSystemDialPolicies() { return this.getSystemDialPolicies(); }
  async createDomainDialPolicy(domain: string, data: any): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.post(`/domains/${domain}/dialpolicy`, data);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create domain dial policy', data: undefined };
    }
  }
  listDomainDialPermissions(domain: string, policy: string) { return this.getDomainDialPermissions(domain, policy); }
  listSystemDialPermissions(policy: string) { return this.getSystemDialPermissions(policy); }
  addDomainDialPermission(domain: string, policy: string, data: any) { return this.createDomainDialPermission(domain, policy, data); }
  addSystemDialPermission(policy: string, data: any) { return this.createSystemDialPermission(policy, data); }

  // --- Domains ---
  domainExists(domain: string) { return this.checkDomainExists(domain); }

  // --- Greetings ---
  getGreeting(domain: string, userId: string, index: number) { return this.getUserGreeting(domain, userId, index); }
  createGreeting(domain: string, userId: string, data: any) { return this.createUserGreeting(domain, userId, data); }
  updateGreeting(domain: string, userId: string, index: number, data: any) { return this.updateUserGreeting(domain, userId, index, data); }
  deleteGreeting(domain: string, userId: string, index: number) { return this.deleteUserGreeting(domain, userId, index); }
  countGreetings(domain: string, userId: string) { return this.countUserGreetings(domain, userId); }

  // --- Hold Messages ---
  listUserHoldMessages(domain: string, userId: string) { return this.getUserHoldMessages(domain, userId); }
  listDomainHoldMessages(domain: string) { return this.getDomainHoldMessages(domain); }

  // --- Messaging ---
  listUserMessageSessions(domain: string, userId: string) { return this.getUserMessageSessions(domain, userId); }
  listDomainMessageSessions(domain: string) { return this.getDomainMessageSessions(domain); }
  getMessageSession(domain: string, userId: string, sessionId: string) { return this.getUserMessageSession(domain, userId, sessionId); }
  createMessageSession(domain: string, userId: string, data: any) { return this.startMessageSession(domain, userId, data); }
  getMessages(domain: string, userId: string, sessionId: string) { return this.getSessionMessages(domain, userId, sessionId); }
  listSmsNumbers(domain: string) { return this.getDomainSmsNumbers(domain); }
  listSystemSmsNumbers() { return this.getSystemSmsNumbers(); }
  listSmsBlocks(domain: string) { return this.getDomainSmsBlocks(domain); }
  addSmsBlock(domain: string, data: any) { return this.createDomainSmsBlock(domain, data); }
  updateSmsBlock(domain: string, blockId: string, data: any) { return this.updateDomainSmsBlock(domain, blockId, data); }
  deleteSmsBlock(domain: string, blockId: string) { return this.deleteDomainSmsBlock(domain, blockId); }
  listSystemSmsBlocks() { return this.getSystemSmsBlocks(); }

  // --- Misc (holidays, dashboards, charts, schedules, email, devices, quotas) ---
  listHolidayCountries() { return this.getHolidayCountries(); }
  listHolidayRegions() { return this.getHolidayRegions(); }
  getHolidaysByRegion(country: string, region: string, year: number) { return this.getHolidaysByCountryAndRegion(country, region, year); }
  listDashboards(domain: string, userId: string) { return this.getUserDashboardList(domain, userId); }
  listCharts(domain: string, dashboardId: string) { return this.getDomainChartList(domain, dashboardId); }
  countScheduleByName(domain: string, scheduleName: string) { return this.countDomainSchedulesByName(domain, scheduleName); }
  sendEmail(domain: string, userId: string, data: any) { return this.sendUserEmail(domain, userId, data); }
  verifyEmail(domain: string, userId: string, token: string) { return this.verifyUserEmail(domain, userId, token); }
  listDomainDevices(domain: string) { return this.getDomainDevices(domain); }
  listDomainQuotas(domain: string) { return this.getDomainQuotas(domain); }

  // --- Music on Hold ---
  getUserMusicOnHold(domain: string, userId: string) { return this.getUserMoh(domain, userId); }
  createUserMusicOnHold(domain: string, userId: string, data: any) { return this.createUserMoh(domain, userId, data); }
  createMusicOnHold(domain: string, data: any) { return this.createDomainMoh(domain, data); }
  updateUserMusicOnHold(domain: string, userId: string, index: number, data: any) { return this.updateUserMoh(domain, userId, index, data); }
  updateMusicOnHold(domain: string, index: number, data: any) { return this.updateDomainMoh(domain, index, data); }
  deleteUserMusicOnHold(domain: string, userId: string, index: number) { return this.deleteUserMoh(domain, userId, index); }
  deleteMusicOnHold(domain: string, index: number) { return this.deleteDomainMoh(domain, index); }
  countUserMusicOnHold(domain: string, userId: string) { return this.countUserMoh(domain, userId); }
  countMusicOnHold(domain: string) { return this.countDomainMoh(domain); }

  // --- Number Filters (Blocked Numbers) ---
  listUserBlockedNumbers(domain: string, userId: string) { return this.getUserNumberFilters(domain, userId); }
  listDomainBlockedNumbers(domain: string) { return this.getDomainNumberFilters(domain); }
  addUserBlockedNumbers(domain: string, userId: string, data: any) { return this.addUserNumberFilter(domain, userId, data); }
  addDomainBlockedNumbers(domain: string, data: any) { return this.addDomainNumberFilter(domain, data); }
  deleteUserBlockedNumbers(domain: string, userId: string, data?: any) { return this.deleteUserNumberFilter(domain, userId, data); }
  deleteDomainBlockedNumbers(domain: string, data?: any) { return this.deleteDomainNumberFilter(domain, data); }

  // --- Phone Numbers ---
  addPhoneNumber(domain: string, data: any) { return this.createPhoneNumber(domain, data); }
  removePhoneNumber(domain: string, phoneNumber: string) { return this.deletePhoneNumber(domain, phoneNumber); }
  listSystemPhoneNumbers(limit?: number, offset?: number) { return this.getSystemPhoneNumbers({ limit, offset }); }

  // --- Phones ---
  listDomainPhones(domain: string) { return this.getDomainPhones(domain); }
  listSystemPhones() { return this.getSystemPhones(); }
  getDomainPhone(domain: string, mac: string) { return this.getDomainPhoneByMac(domain, mac); }
  addDomainPhone(domain: string, data: any) { return this.createDomainPhone(domain, data); }
  removeDomainPhone(domain: string, data?: any) { return this.deleteDomainPhone(domain, data); }
  getSystemPhone(mac: string) { return this.getSystemPhoneByMac(mac); }
  addSystemPhone(data: any) { return this.createSystemPhone(data); }
  removeSystemPhone(data?: any) { return this.deleteSystemPhone(data); }
  listPhoneTemplates(domain: string) { return this.getDomainPhoneTemplates(domain); }
  listDeviceProfiles() { return this.getDeviceProfiles(); }
  getPhoneModelDetails(model: string) { return this.getPhoneModels({ model }); }
  listPhoneModelsByVendor(vendor: string) { return this.getPhoneModels({ vendor }); }
  listPhoneModels() { return this.getPhoneModels(); }

  // --- Resellers ---
  listResellers(limit?: number, offset?: number) { return this.getResellers({ limit, offset }); }
  async getResellerStats(reseller: string, stat: string): Promise<NetSapiensApiResponse<any>> {
    try {
      const response: AxiosResponse = await this.client.get(`/resellers/${reseller}/${stat}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message || `Failed to get reseller ${stat}`, data: undefined };
    }
  }

  // --- Routes ---
  listRoutes() { return this.getRoutes(); }
  listRouteConnections(routeId: string) { return this.getRouteConnections(routeId); }
  listDomainConnections(domain: string) { return this.getDomainConnections(domain); }

  // --- Sites ---
  listSitesBasic(domain: string) { return this.getSites(domain); }

  // --- Statistics ---
  getQueueStatisticsAggregate(domain: string) { return this.getCallQueueStatsAggregate(domain); }
  getQueueStatisticsPerQueue(domain: string) { return this.getCallQueueStatsPerQueue(domain); }
  getQueueStatistics(domain: string, queueId: string) { return this.getCallQueueStats(domain, queueId); }
  getDnisStatisticsForQueue(domain: string, queueId: string) { return this.getDnisQueueStatistics(domain, queueId); }

  // --- Subscriptions ---
  listDomainSubscriptions(domain: string) { return this.getDomainSubscriptions(domain); }
  listSystemSubscriptions() { return this.getSystemSubscriptions(); }
  getSubscription(subscriptionId: string) { return this.getSystemSubscription(subscriptionId); }

  // --- System (backup, restore, insight, certs, configs, sip, firebase) ---
  backupSystem() { return this.createSystemBackup(); }
  backupDomain(domain: string) { return this.createDomainBackup(domain); }
  listRestorePoints() { return this.getRestorePoints(); }
  restoreDomain(domain: string, restorePoint: any) { return this.restoreDomainBackup({ domain, restorePoint }); }
  getInsight(label: string) { return this.getInsightAnalytics(label); }
  listCertificates() { return this.getCertificates(); }
  listConfigurations() { return this.getConfigurations(); }
  listConfigDefinitions() { return this.getConfigDefinitions(); }
  async getSipFlow(callId: string, format?: string): Promise<NetSapiensApiResponse<any>> {
    return this.getCallTrace({ callId, format });
  }
  listFirebase() { return this.getFirebaseAccounts(); }
  addFirebase(data: any) { return this.addFirebaseAccount(data); }

  // --- Timeframes ---
  listUserTimeframes(domain: string, userId: string) { return this.getUserTimeframes(domain, userId); }
  listTimeframes(domain: string) { return this.getDomainTimeframes(domain); }
  getTimeframe(domain: string, id: string) { return this.getDomainTimeframe(domain, id); }
  createTimeframe(domain: string, data: any) { return this.createDomainTimeframe(domain, data); }
  updateTimeframe(domain: string, id: string, data: any) { return this.updateDomainTimeframe(domain, id, data); }
  deleteTimeframe(domain: string, id: string) { return this.deleteDomainTimeframe(domain, id); }

  // --- Users ---
  listUsersBasic(domain: string) { return this.listUsers(domain); }

  // --- Video Meetings ---
  listVideoHosts(domain: string) { return this.getVideoHosts(domain); }
  listAvailableVideoProducts(domain: string) { return this.getVideoAvailableProducts(domain); }
  listVideoProducts(domain: string) { return this.getVideoProducts(domain); }
  listMeetings(domain: string, userId: string) { return this.getUserMeetings(domain, userId); }
  getMeeting(domain: string, userId: string, meetingId: string) { return this.getUserMeeting(domain, userId, meetingId); }
  createMeeting(domain: string, userId: string, data: any) { return this.createUserMeeting(domain, userId, data); }
  updateMeeting(domain: string, userId: string, meetingId: string, data: any) { return this.updateUserMeeting(domain, userId, meetingId, data); }
  deleteMeeting(domain: string, userId: string, meetingId: string) { return this.deleteUserMeeting(domain, userId, meetingId); }
  getMeetingLogs(domain: string, userId: string, meetingId: string, instanceId: string) { return this.getMeetingLog(domain, userId, meetingId, instanceId); }

  // --- Voicemails ---
  getVoicemail(domain: string, userId: string, folder: string, filename: string) { return this.getUserVoicemail(domain, userId, folder, filename); }
  deleteVoicemail(domain: string, userId: string, folder: string, filename: string) { return this.deleteUserVoicemail(domain, userId, folder, filename); }
  forwardVoicemail(domain: string, userId: string, folder: string, filename: string, toUser: string) { return this.forwardUserVoicemail(domain, userId, folder, filename, { toUser }); }
  saveVoicemail(domain: string, userId: string, folder: string, filename: string) { return this.saveUserVoicemail(domain, userId, folder, filename); }
  countVoicemails(domain: string, userId: string, folder?: string) { return this.countUserVoicemailsByFolder(domain, userId, folder || 'INBOX'); }
  listVoicemailReminders(domain: string, userId: string) { return this.getUserVoicemailReminders(domain, userId); }
  createVoicemailReminder(domain: string, userId: string, data: any) { return this.createUserVoicemailReminder(domain, userId, data); }
  updateVoicemailReminders(domain: string, userId: string, data: any) { return this.updateUserVoicemailReminders(domain, userId, data); }
  deleteVoicemailReminders(domain: string, userId: string) { return this.deleteUserVoicemailReminders(domain, userId); }
  countVoicemailReminders(domain: string, userId: string) { return this.countUserVoicemailReminders(domain, userId); }

  /**
   * Test API connectivity
   */
  async testConnection(): Promise<NetSapiensApiResponse<boolean>> {
    try {
      const response = await this.client.get('/domains', {
        params: {
          limit: 1
        }
      });

      return {
        success: true,
        data: true,
        message: 'Connection successful'
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Connection failed',
        data: false
      };
    }
  }
}