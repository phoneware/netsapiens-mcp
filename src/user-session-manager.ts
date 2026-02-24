/**
 * User Session Manager for Multi-User MCP Server
 * Manages per-user OAuth sessions for centralized deployments
 *
 * USAGE: This is an advanced feature for centralized server deployments.
 * For local desktop usage, the standard OAuth implementation is sufficient.
 */

import { NetSapiensClient } from './netsapiens-client.js';
import { NetSapiensConfig } from './types/config.js';

export interface UserCredentials {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

export interface UserSession {
  userId: string;
  client: NetSapiensClient;
  lastAccess: number;
}

export class UserSessionManager {
  private sessions: Map<string, UserSession> = new Map();
  private apiUrl: string;
  private sessionTimeout: number;

  constructor(apiUrl: string, sessionTimeoutMs: number = 30 * 60 * 1000) {
    this.apiUrl = apiUrl;
    this.sessionTimeout = sessionTimeoutMs;

    // Cleanup expired sessions every 5 minutes
    setInterval(() => this.cleanupExpiredSessions(), 5 * 60 * 1000);
  }

  /**
   * Get or create a NetSapiens client for a specific user
   * @param userId - Unique identifier for the user
   * @param credentials - User's OAuth credentials
   */
  getClientForUser(userId: string, credentials: UserCredentials): NetSapiensClient {
    // Check if we have an active session
    const existingSession = this.sessions.get(userId);
    if (existingSession) {
      existingSession.lastAccess = Date.now();
      return existingSession.client;
    }

    // Create new session
    const config: NetSapiensConfig = {
      apiUrl: this.apiUrl,
      oauth: credentials,
      timeout: 30000
    };

    const client = new NetSapiensClient(config);

    this.sessions.set(userId, {
      userId,
      client,
      lastAccess: Date.now()
    });

    return client;
  }

  /**
   * Remove a user's session
   */
  removeUserSession(userId: string): void {
    this.sessions.delete(userId);
  }

  /**
   * Clean up sessions that haven't been used recently
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();
    const expiredUserIds: string[] = [];

    for (const [userId, session] of this.sessions.entries()) {
      if (now - session.lastAccess > this.sessionTimeout) {
        expiredUserIds.push(userId);
      }
    }

    for (const userId of expiredUserIds) {
      this.sessions.delete(userId);
      console.log(`Cleaned up expired session for user: ${userId}`);
    }
  }

  /**
   * Get session statistics
   */
  getStats(): { totalSessions: number; activeSessions: number } {
    const now = Date.now();
    let activeSessions = 0;

    for (const session of this.sessions.values()) {
      if (now - session.lastAccess < this.sessionTimeout) {
        activeSessions++;
      }
    }

    return {
      totalSessions: this.sessions.size,
      activeSessions
    };
  }
}
