/**
 * OAuth Token Manager for NetSapiens MCP Server
 * Handles OAuth 2.0 authentication flow and token management
 */

import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export interface OAuthConfig {
  apiUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  expires_at?: number; // Calculated expiration timestamp
}

export class OAuthManager {
  private config: OAuthConfig;
  private tokens: OAuthTokens | null = null;
  private tokenFilePath: string;

  constructor(config: OAuthConfig) {
    this.config = config;
    // Store tokens in user's home directory
    const configDir = path.join(os.homedir(), '.netsapiens-mcp');
    this.tokenFilePath = path.join(configDir, 'oauth-tokens.json');
  }

  /**
   * Get a valid access token, refreshing if necessary
   */
  async getAccessToken(): Promise<string> {
    // Try to load existing tokens
    if (!this.tokens) {
      await this.loadTokens();
    }

    // If we have tokens and they're not expired, return access token
    if (this.tokens && !this.isTokenExpired()) {
      return this.tokens.access_token;
    }

    // Try to refresh if we have a refresh token
    if (this.tokens?.refresh_token) {
      try {
        await this.refreshAccessToken();
        return this.tokens!.access_token;
      } catch (error) {
        console.error('Failed to refresh token, obtaining new token:', error);
      }
    }

    // Otherwise, get a new token
    await this.authenticate();
    return this.tokens!.access_token;
  }

  /**
   * Authenticate using username and password (Resource Owner Password Credentials grant)
   */
  private async authenticate(): Promise<void> {
    try {
      const response = await axios.post(
        `${this.config.apiUrl}/ns-api/oauth2/token/`,
        new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          username: this.config.username,
          password: this.config.password,
          grant_type: 'password'
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      this.tokens = {
        ...response.data,
        expires_at: Date.now() + (response.data.expires_in * 1000)
      };

      await this.saveTokens();
    } catch (error: any) {
      throw new Error(`OAuth authentication failed: ${error.message}`);
    }
  }

  /**
   * Refresh the access token using the refresh token
   */
  private async refreshAccessToken(): Promise<void> {
    if (!this.tokens?.refresh_token) {
      throw new Error('No refresh token available');
    }

    try {
      const response = await axios.post(
        `${this.config.apiUrl}/ns-api/oauth2/token/`,
        new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          refresh_token: this.tokens.refresh_token,
          grant_type: 'refresh_token'
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      this.tokens = {
        ...response.data,
        expires_at: Date.now() + (response.data.expires_in * 1000)
      };

      await this.saveTokens();
    } catch (error: any) {
      throw new Error(`Token refresh failed: ${error.message}`);
    }
  }

  /**
   * Check if the current token is expired or about to expire (within 5 minutes)
   */
  private isTokenExpired(): boolean {
    if (!this.tokens?.expires_at) {
      return true;
    }

    // Consider token expired if it expires within 5 minutes
    const bufferTime = 5 * 60 * 1000; // 5 minutes in milliseconds
    return Date.now() >= (this.tokens.expires_at - bufferTime);
  }

  /**
   * Load tokens from file
   */
  private async loadTokens(): Promise<void> {
    try {
      const data = await fs.readFile(this.tokenFilePath, 'utf-8');
      this.tokens = JSON.parse(data);
    } catch (error) {
      // File doesn't exist or can't be read, that's okay
      this.tokens = null;
    }
  }

  /**
   * Save tokens to file
   */
  private async saveTokens(): Promise<void> {
    if (!this.tokens) {
      return;
    }

    try {
      // Ensure directory exists
      const dir = path.dirname(this.tokenFilePath);
      await fs.mkdir(dir, { recursive: true });

      // Save tokens
      await fs.writeFile(
        this.tokenFilePath,
        JSON.stringify(this.tokens, null, 2),
        'utf-8'
      );

      // Set file permissions to be readable/writable only by the owner
      await fs.chmod(this.tokenFilePath, 0o600);
    } catch (error) {
      console.error('Failed to save OAuth tokens:', error);
    }
  }

  /**
   * Clear stored tokens
   */
  async clearTokens(): Promise<void> {
    this.tokens = null;
    try {
      await fs.unlink(this.tokenFilePath);
    } catch (error) {
      // File might not exist, that's okay
    }
  }
}
