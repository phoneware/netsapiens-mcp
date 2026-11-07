# Security Policy

## Reporting Security Vulnerabilities

Please report security issues responsibly. Do not open public issues for potential security vulnerabilities.

Report vulnerabilities through GitHub Private Vulnerability Reporting:
1. Navigate to the repository security advisory page at https://github.com/phoneware/netsapiens-mcp/security/advisories.
2. Click "Report a vulnerability".
3. Provide details of the finding, reproduction steps, affected releases, and potential impact.

Maintainers review security reports promptly and coordinate disclosure and patches through private advisories.

## Security Architecture & Best Practices

- Operator credentials (`NETSAPIENS_OAUTH_CLIENT_SECRET`, `MCP_SESSION_SECRET`) must be kept confidential and injected via environment variables.
- The `MCP_SESSION_SECRET` must be at least 32 characters long. Rotating this secret immediately invalidates all active sessions.
- In HTTP mode, each user signs in via OAuth authorization code flow. Raw user passwords never reach the model or client.
- When running with SQLite persistence, the database file must be protected with mode 0600 permissions on POSIX systems.
