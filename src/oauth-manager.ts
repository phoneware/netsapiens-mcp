import http from 'node:http';
import { URL, URLSearchParams } from 'node:url';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { NetSapiensOAuthConfig } from './types/config.js';

interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  obtained_at: number;
}

const TOKEN_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '~',
  '.netsapiens-mcp',
);
const TOKEN_FILE = path.join(TOKEN_DIR, 'oauth-tokens.json');

export class OAuthManager {
  private apiUrl: string;
  private oauthConfig: NetSapiensOAuthConfig;
  private tokens: StoredTokens | null = null;

  constructor(apiUrl: string, oauthConfig: NetSapiensOAuthConfig) {
    this.apiUrl = apiUrl;
    this.oauthConfig = oauthConfig;
  }

  async authenticate(): Promise<string> {
    // 1. Try stored tokens first
    const stored = this.loadStoredTokens();
    if (stored) {
      if (!this.isTokenExpired(stored)) {
        this.tokens = stored;
        return stored.access_token;
      }
      // Try refresh if we have a refresh token
      if (stored.refresh_token) {
        try {
          const refreshed = await this.refreshToken(stored.refresh_token);
          return refreshed;
        } catch {
          console.error('[OAuth] Token refresh failed, re-authenticating...');
        }
      }
    }

    // 2. Determine flow based on config
    if (this.oauthConfig.username && this.oauthConfig.password) {
      return this.passwordGrant();
    }

    // 3. Authorization Code flow (client_id + client_secret without username/password)
    return this.authorizationCodeFlow();
  }

  async getAccessToken(): Promise<string> {
    if (this.tokens && !this.isTokenExpired(this.tokens)) {
      return this.tokens.access_token;
    }

    if (this.tokens?.refresh_token) {
      try {
        return await this.refreshToken(this.tokens.refresh_token);
      } catch {
        console.error('[OAuth] Token refresh failed, re-authenticating...');
      }
    }

    return this.authenticate();
  }

  private isTokenExpired(tokens: StoredTokens): boolean {
    if (!tokens.expires_in) return false;
    const expiresAt = tokens.obtained_at + tokens.expires_in * 1000;
    // Consider expired 60 seconds early to avoid edge cases
    return Date.now() >= expiresAt - 60_000;
  }

  // ==================== Password Grant ====================

  private async passwordGrant(): Promise<string> {
    const params = new URLSearchParams({
      grant_type: 'password',
      client_id: this.oauthConfig.clientId,
      client_secret: this.oauthConfig.clientSecret,
      username: this.oauthConfig.username!,
      password: this.oauthConfig.password!,
    });

    const response = await axios.post(
      `${this.apiUrl}/ns-api/oauth2/token/`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    const tokens: StoredTokens = {
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token,
      expires_in: response.data.expires_in,
      obtained_at: Date.now(),
    };

    this.tokens = tokens;
    this.saveTokens(tokens);
    return tokens.access_token;
  }

  // ==================== Authorization Code Flow ====================

  private async authorizationCodeFlow(): Promise<string> {
    const code = await this.getAuthorizationCode();
    return this.exchangeCodeForTokens(code.code, code.redirectUri);
  }

  private getAuthorizationCode(): Promise<{ code: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      const server = http.createServer();
      let settled = false;
      let capturedRedirectUri = '';

      const cleanup = () => {
        if (!settled) {
          settled = true;
          server.close();
        }
      };

      // Timeout after 120 seconds
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Authorization timed out after 120 seconds'));
      }, 120_000);

      server.on('request', (req, res) => {
        const url = new URL(req.url || '/', `http://localhost`);

        if (url.pathname !== '/callback') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }

        const error = url.searchParams.get('error');
        if (error) {
          const errorDesc = url.searchParams.get('error_description') || error;
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<html><body><h1>Authorization Failed</h1><p>${escapeHtml(errorDesc)}</p><p>You can close this window.</p></body></html>`);
          clearTimeout(timeout);
          cleanup();
          reject(new Error(`OAuth authorization failed: ${errorDesc}`));
          return;
        }

        const code = url.searchParams.get('code');
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>Error</h1><p>No authorization code received.</p><p>You can close this window.</p></body></html>');
          clearTimeout(timeout);
          cleanup();
          reject(new Error('No authorization code received in callback'));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Authorization Successful</h1><p>You can close this window and return to the application.</p></body></html>');
        clearTimeout(timeout);
        cleanup();

        resolve({ code, redirectUri: capturedRedirectUri });
      });

      // Listen on random port, bound to localhost only
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        capturedRedirectUri = `http://localhost:${port}/callback`;
        const redirectUri = capturedRedirectUri;

        const authorizeUrl = new URL(`${this.apiUrl}/ns-api/oauth2/authorize`);
        authorizeUrl.searchParams.set('client_id', this.oauthConfig.clientId);
        authorizeUrl.searchParams.set('redirect_uri', redirectUri);
        authorizeUrl.searchParams.set('response_type', 'code');

        const urlStr = authorizeUrl.toString();

        console.error(`Authorization required. Opening browser... If browser doesn't open, visit: ${urlStr}`);

        this.openBrowser(urlStr);
      });

      server.on('error', (err) => {
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`Failed to start callback server: ${err.message}`));
      });
    });
  }

  private async exchangeCodeForTokens(code: string, redirectUri: string): Promise<string> {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: this.oauthConfig.clientId,
      client_secret: this.oauthConfig.clientSecret,
    });

    const response = await axios.post(
      `${this.apiUrl}/ns-api/oauth2/token/`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    const tokens: StoredTokens = {
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token,
      expires_in: response.data.expires_in,
      obtained_at: Date.now(),
    };

    this.tokens = tokens;
    this.saveTokens(tokens);
    return tokens.access_token;
  }

  // ==================== Token Refresh ====================

  private async refreshToken(refreshToken: string): Promise<string> {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.oauthConfig.clientId,
      client_secret: this.oauthConfig.clientSecret,
    });

    const response = await axios.post(
      `${this.apiUrl}/ns-api/oauth2/token/`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    const tokens: StoredTokens = {
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token || refreshToken,
      expires_in: response.data.expires_in,
      obtained_at: Date.now(),
    };

    this.tokens = tokens;
    this.saveTokens(tokens);
    return tokens.access_token;
  }

  // ==================== Token Storage ====================

  private loadStoredTokens(): StoredTokens | null {
    try {
      if (!fs.existsSync(TOKEN_FILE)) return null;
      const data = fs.readFileSync(TOKEN_FILE, 'utf-8');
      return JSON.parse(data) as StoredTokens;
    } catch {
      return null;
    }
  }

  private saveTokens(tokens: StoredTokens): void {
    try {
      if (!fs.existsSync(TOKEN_DIR)) {
        fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), {
        mode: 0o600,
      });
    } catch (err) {
      console.error('[OAuth] Failed to save tokens:', err);
    }
  }

  // ==================== Browser Opening ====================

  private openBrowser(url: string): void {
    try {
      const platform = process.platform;
      if (platform === 'darwin') {
        execSync(`open ${JSON.stringify(url)}`);
      } else if (platform === 'linux') {
        execSync(`xdg-open ${JSON.stringify(url)}`);
      } else if (platform === 'win32') {
        execSync(`start "" ${JSON.stringify(url)}`);
      }
    } catch {
      // Browser open is best-effort; URL is already printed to stderr
    }
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
