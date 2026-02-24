# NetSapiens MCP Deployment Guide

This guide explains different deployment architectures for the NetSapiens MCP server and how to handle multi-user scenarios.

## 📋 Table of Contents

- [Deployment Architectures](#deployment-architectures)
- [Local Desktop Deployment](#local-desktop-deployment)
- [Centralized Server Deployment](#centralized-server-deployment)
- [Multi-User Scenarios](#multi-user-scenarios)
- [Security Considerations](#security-considerations)

## 🏗️ Deployment Architectures

### Architecture 1: Local Desktop (Recommended for Most Users)

Each user runs their own MCP server instance on their local machine.

```
┌─────────────┐     ┌─────────────┐     ┌──────────────────┐
│ User 1      │────▶│ MCP Server  │────▶│ NetSapiens API   │
│ (Claude App)│     │ (User 1's   │     │ (User 1 context) │
└─────────────┘     │  OAuth)     │     └──────────────────┘
                    └─────────────┘

┌─────────────┐     ┌─────────────┐     ┌──────────────────┐
│ User 2      │────▶│ MCP Server  │────▶│ NetSapiens API   │
│ (Claude App)│     │ (User 2's   │     │ (User 2 context) │
└─────────────┘     │  OAuth)     │     └──────────────────┘
                    └─────────────┘
```

**Pros:**
- ✅ Simple configuration
- ✅ Perfect user isolation
- ✅ Each user authenticates with their own credentials
- ✅ Works offline (cached tokens)
- ✅ No shared server infrastructure needed

**Cons:**
- ❌ Each user must install and configure separately
- ❌ Updates must be deployed to each machine

**Use Cases:**
- Claude Desktop
- Cursor IDE
- Individual developer machines
- Small teams (< 10 users)

### Architecture 2: Centralized Server - Multiple Instances

Run separate MCP server instances for each user on a central server.

```
                    ┌─────────────────┐
                    │ Central Server  │
                    │                 │
┌─────────────┐     │ ┌─────────────┐ │     ┌──────────────────┐
│ User 1      │────▶│ │ MCP Server  │ │────▶│ NetSapiens API   │
│             │     │ │ Instance 1  │ │     │ (User 1 context) │
└─────────────┘     │ └─────────────┘ │     └──────────────────┘
                    │                 │
┌─────────────┐     │ ┌─────────────┐ │     ┌──────────────────┐
│ User 2      │────▶│ │ MCP Server  │ │────▶│ NetSapiens API   │
│             │     │ │ Instance 2  │ │     │ (User 2 context) │
└─────────────┘     │ └─────────────┘ │     └──────────────────┘
                    │                 │
                    └─────────────────┘
```

**Pros:**
- ✅ Complete user isolation
- ✅ Centralized updates
- ✅ Each user authenticates individually
- ✅ Easy to scale horizontally

**Cons:**
- ❌ More resource intensive (one process per user)
- ❌ Requires orchestration (Docker Compose, Kubernetes)

**Use Cases:**
- Medium teams (10-100 users)
- Enterprise deployments
- Kubernetes/container orchestration
- When resource usage is not a concern

### Architecture 3: Centralized Server - Shared Instance (Future)

Single MCP server instance handling multiple users with dynamic sessions.

```
                    ┌─────────────────────────┐
                    │ Central Server          │
                    │                         │
┌─────────────┐     │ ┌─────────────────────┐ │
│ User 1      │────▶│ │                     │ │
│             │     │ │   MCP Server        │ │
└─────────────┘     │ │   + Session Mgr     │ │
                    │ │                     │ │
┌─────────────┐     │ │  ┌──────────────┐  │ │     ┌──────────────────┐
│ User 2      │────▶│ │  │ User Sessions│  │ │────▶│ NetSapiens API   │
│             │     │ │  │ - User 1     │  │ │     │ (Multi-user)     │
└─────────────┘     │ │  │ - User 2     │  │ │     └──────────────────┘
                    │ │  │ - User 3     │  │ │
┌─────────────┐     │ │  └──────────────┘  │ │
│ User 3      │────▶│ │                     │ │
│             │     │ └─────────────────────┘ │
└─────────────┘     │                         │
                    └─────────────────────────┘
```

**Status:** 🚧 Not yet implemented (requires MCP protocol enhancements)

**Pros:**
- ✅ Resource efficient (single process)
- ✅ Centralized updates
- ✅ Easy to manage

**Cons:**
- ❌ Complex session management
- ❌ Requires user credential passing in protocol
- ❌ Not yet available

**Use Cases:**
- Large teams (100+ users)
- When resource optimization is critical
- Future consideration

## 🖥️ Local Desktop Deployment

### Setup for Claude Desktop

**1. Install the package:**

```bash
npm install -g netsapiens-mcp
```

**2. Configure Claude Desktop:**

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "netsapiens": {
      "command": "netsapiens-mcp",
      "env": {
        "NETSAPIENS_API_URL": "https://edge.phoneware.cloud",
        "NETSAPIENS_OAUTH_CLIENT_ID": "your_client_id",
        "NETSAPIENS_OAUTH_CLIENT_SECRET": "your_client_secret",
        "NETSAPIENS_OAUTH_USERNAME": "your.email@domain.com",
        "NETSAPIENS_OAUTH_PASSWORD": "your_password"
      }
    }
  }
}
```

**3. Restart Claude Desktop**

Each user configures their own credentials. Perfect isolation!

## 🖧 Centralized Server Deployment

### Option 1: Docker Compose - Multiple Instances

**1. Create `.env` file with user credentials:**

```env
# User 1
USER1_CLIENT_ID=client_id_1
USER1_CLIENT_SECRET=client_secret_1
USER1_USERNAME=user1@domain.com
USER1_PASSWORD=password1

# User 2
USER2_CLIENT_ID=client_id_2
USER2_CLIENT_SECRET=client_secret_2
USER2_USERNAME=user2@domain.com
USER2_PASSWORD=password2

# User 3
USER3_CLIENT_ID=client_id_3
USER3_CLIENT_SECRET=client_secret_3
USER3_USERNAME=user3@domain.com
USER3_PASSWORD=password3
```

**2. Use the multi-user compose file:**

```bash
docker-compose -f docker-compose.multi-user.yml up -d
```

**3. Users connect to their specific instance:**

Each user's MCP client configuration points to their dedicated container.

### Option 2: Kubernetes - StatefulSet

For Kubernetes deployments, use a StatefulSet with one pod per user:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: netsapiens-mcp
spec:
  serviceName: netsapiens-mcp
  replicas: 3  # One per user
  selector:
    matchLabels:
      app: netsapiens-mcp
  template:
    metadata:
      labels:
        app: netsapiens-mcp
    spec:
      containers:
      - name: mcp-server
        image: netsapiens-mcp:latest
        env:
        - name: NETSAPIENS_API_URL
          value: "https://edge.phoneware.cloud"
        # User-specific OAuth credentials loaded from Secrets
        - name: NETSAPIENS_OAUTH_CLIENT_ID
          valueFrom:
            secretKeyRef:
              name: netsapiens-oauth-user-${POD_INDEX}
              key: client_id
        # ... etc
```

## 👥 Multi-User Scenarios

### Scenario 1: Each User on Local Machine

**Solution:** Local Desktop Deployment (Architecture 1)

**Implementation:** Standard installation, each user configures their own OAuth credentials.

### Scenario 2: 10-50 Users, Centralized

**Solution:** Multiple Docker Instances (Architecture 2)

**Implementation:** Docker Compose with separate service per user.

**Resource Estimate:**
- ~50MB RAM per instance
- ~10MB disk per instance
- For 50 users: ~2.5GB RAM, ~500MB disk

### Scenario 3: 100+ Users, Centralized

**Solution:** Kubernetes with dynamic scaling (Architecture 2)

**Implementation:** Use Kubernetes StatefulSet or Deployment with HPA.

**Future:** Wait for Architecture 3 (session management) for better resource efficiency.

## 🔒 Security Considerations

### Password Storage

**Current Implementation:**
- OAuth credentials are stored in MCP client config (environment variables)
- Tokens are cached in `~/.netsapiens-mcp/oauth-tokens.json` with 0600 permissions

**Best Practices:**

1. **Local Desktop:**
   - Encrypt config files at rest
   - Use OS keychain/credential manager (future enhancement)
   - Regularly rotate passwords

2. **Centralized Server:**
   - Use Kubernetes Secrets or Docker Secrets
   - Encrypt secrets at rest
   - Use RBAC to limit access
   - Audit credential access

### Network Security

**Firewall Rules:**
- MCP server needs HTTPS (443) access to NetSapiens API
- No inbound connections required (MCP uses stdio transport)

**TLS:**
- All API communication uses HTTPS
- OAuth token exchange is encrypted

### Token Lifecycle

- Access tokens expire (typically 1 hour)
- Refresh tokens used for renewal
- Tokens auto-refresh 5 minutes before expiry
- Sessions cleaned up after 30 minutes of inactivity

## 🚀 Recommended Approach

| Team Size | Recommendation | Architecture |
|-----------|---------------|--------------|
| 1-10 users | Local Desktop | Architecture 1 |
| 10-50 users | Docker Compose Multi-Instance | Architecture 2 |
| 50-100 users | Kubernetes Multi-Instance | Architecture 2 |
| 100+ users | Wait for Session Manager | Architecture 3 (future) |

## 📞 Support

For deployment questions or issues, please open an issue at:
https://github.com/phoneware/netsapiens-mcp/issues
