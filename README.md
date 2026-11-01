# NetSapiens MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Release](https://img.shields.io/badge/release-v3.0.0-blue.svg)](https://github.com/phoneware/netsapiens-mcp/releases)
[![CI](https://github.com/phoneware/netsapiens-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/phoneware/netsapiens-mcp/actions/workflows/ci.yml)

An enterprise Model Context Protocol (MCP) server connecting LLM assistants to the NetSapiens VoIP platform API. Features per-user OAuth 2.1 authentication, role-based tool visibility, host-version-aware route filtering, and encrypted credential storage.

## Who It Is For

VoIP operators, service providers, and NetSapiens partners who want AI assistants (such as Claude, ChatGPT, or custom AI agents) working securely inside NetSapiens with each user's own permissions and identity.

## Comparison with docs.ns-api.com/mcp

NetSapiens provides an official reference documentation MCP at `docs.ns-api.com/mcp`. That server exposes five generic HTTP utility tools (including raw HAR request execution) designed for documentation exploration.

In contrast, `netsapiens-mcp` is designed for production multi-tenant operation:
- **Per-user sign-in:** Each human user or agent authenticates with their own NetSapiens credentials through an authorization-code flow; raw user passwords never enter model context.
- **Role-aware tools:** Each user only sees and invokes tools their NetSapiens role allows (`super_user`, `reseller`, `domain_admin`, `office_manager`, `user`).
- **Version-aware availability:** Tool catalogs adapt automatically to the reported release of the target NetSapiens host (44.3 through 46.0).
- **Curated workflows:** High-level composite tools for complex operations (call diagnostics, queue agent management, scheduled forwarding) alongside 1,100+ granular API tools.
- **Enterprise security:** Encrypted credential storage at rest, policy filters, and automated secret scrubbing.

## Quickstart

### Local Stdio (Single User via npx)

Run the server directly from the npm registry using `npx`:

```sh
export NETSAPIENS_API_URL="https://netsapiens.example.com"
export NETSAPIENS_API_TOKEN="your-api-token"

npx --yes netsapiens-mcp@3
```

Alternatively, provide OAuth credentials for stdio authentication:

```sh
export NETSAPIENS_API_URL="https://netsapiens.example.com"
export NETSAPIENS_OAUTH_CLIENT_ID="your-client-id"
export NETSAPIENS_OAUTH_CLIENT_SECRET="your-client-secret"
export NETSAPIENS_OAUTH_USERNAME="you@example.com"
export NETSAPIENS_OAUTH_PASSWORD="your-password"

npx --yes netsapiens-mcp@3
```

### Hosted HTTP (Docker Compose)

Deploy the multi-user HTTP service with SQLite persistence:

```sh
# Copy sample configuration and set your secret
cp .env.example .env
# Edit .env with your NETSAPIENS_API_URL and a random 32+ character MCP_SESSION_SECRET

docker compose up -d
```

The service will listen on port 3000 at `http://localhost:3000/mcp`.

## Connecting MCP Clients

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "netsapiens": {
      "command": "npx",
      "args": ["--yes", "netsapiens-mcp@3"],
      "env": {
        "NETSAPIENS_API_URL": "https://netsapiens.example.com",
        "NETSAPIENS_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

### Claude Code

Connect to a hosted HTTP server deployment:

```sh
claude mcp add --transport http netsapiens https://mcp.example.com/mcp
```

Or run locally via stdio:

```sh
claude mcp add netsapiens -- npx --yes netsapiens-mcp@3
```

### Claude.ai Custom Connector

For web and team workspaces:
1. In Claude.ai Settings > Integrations, select "Add custom MCP connector".
2. Enter your server's endpoint: `https://mcp.example.com/mcp`.
4. Users complete login on the NetSapiens MCP login page.

## Supported NetSapiens Versions

The server detects each connected host's API version via `GET /ns-api/v2/version` and serves tools documented for that release.

<!-- facts:version-matrix -->
| Host line | Documentation used | Observed on a live host | Read tools | Write tools |
|---|---|---|---|---|
| 44.3 | 44.3 (retrieved 2026-10-29) | not yet | 132 | 198 |
| 44.4 | 44.4 (retrieved 2026-10-29) | 44.4.10 (maintainer) | 139 | 199 |
| 45.0 | 45.0 (retrieved 2026-10-29) | not yet | 207 | 247 |
| 46.0 | 46.0 (retrieved 2026-10-29) | not yet | 568 | 548 |
| newer than 46 | 46.0 (newer than documented) | not yet | 568 | 548 |
<!-- /facts:version-matrix -->

## Storage & Persistence

The server supports three storage engines for session and token persistence:

<!-- facts:backends -->
| Backend | Persistent | Multi-instance | Concurrency / Locking | Expiry Mechanism |
|---|---|---|---|---|
| `sqlite` (default) | Yes | No (single process) | Exclusive SQLite lock (`StoreLockedError`) | In-process sweep on interval |
| `firestore` (optional) | Yes | Yes (distributed) | Atomic document CAS & refresh lease | Cloud Firestore TTL policy |
| `memory` (test/ephemeral) | No | No (single process) | In-process Map/Set memory isolation | In-process sweep on interval |
<!-- /facts:backends -->

### Firestore Collections & TTL Fields

When configured with `MCP_PERSISTENCE=firestore`, the following collection layout is created under `MCP_STORE_NAMESPACE`:

<!-- facts:firestore-collections -->
| Collection Name | Document Contents | TTL Field | Lifecycle / Retention |
|---|---|---|---|
| `<namespace>_sessions` | Encrypted session tokens & NS refresh credentials | `ttlAt` | Cleaned up after 30 days retention |
| `<namespace>_auth_codes` | PKCE authorization codes | `expiresAt` | Single-use, expires in 5 minutes |
| `<namespace>_resume_tokens` | MCP resumption nonces | `expiresAt` | Single-use, expires in 2 hours |
| `<namespace>_oauth_clients` | Registered OAuth clients | None | Persistent client configurations |
| `<namespace>_usage` | User rate-limiting counters | None | Persistent call count telemetry |
<!-- /facts:firestore-collections -->

### Runtime & Node Support

Node 22.13 or later. On Node 22, Node marks `node:sqlite` experimental and prints a warning when the default store opens; Node 24.15 and later mark it a release candidate. The Docker image uses Node 24.

## Security & Architecture Limits

- **Local Storage Isolation:** SQLite database files are initialized with mode 0600 permissions on POSIX systems.
- **Windows SQLite ACLs:** On Windows systems, POSIX permission bits are not supported by the underlying operating system. The SQLite database, WAL, and journal files inherit access controls from their parent directory. Operators running on Windows should ensure the directory containing the SQLite database is restricted to the desired service account.
- **Credential Protection at Rest:** Session tokens, refresh tokens, and credentials are encrypted using AES-256-GCM before storage.
- **Secret Invalidation:** Rotating `MCP_SESSION_SECRET` immediately terminates and invalidates all existing sessions.
- **Dynamic Client Registration:** OAuth client registration records are unencrypted metadata containing client names and redirect URIs.
- **Usage Retention:** In-store rate limiting telemetry counters do not expire automatically.

## Configuration Reference

<!-- facts:store-env -->
| Variable | Required | Default | Description |
|---|---|---|---|
| `MCP_PERSISTENCE` | No | `sqlite` | sqlite, firestore or memory; any other value exits 1. file exits 1 with ConfigError: MCP_PERSISTENCE=file was removed in 3.0.0; the default store is sqlite (see MCP_STORE_PATH). Unset with GOOGLE_CLOUD_PROJECT exits 1 with ConfigError: MCP_PERSISTENCE is not set. 2.x chose Firestore because GOOGLE_CLOUD_PROJECT is set; 3.0.0 never infers the store. Set MCP_PERSISTENCE=firestore or MCP_PERSISTENCE=sqlite. Firestore without its package exits 1 with ConfigError: MCP_PERSISTENCE=firestore needs @google-cloud/firestore: npm install @google-cloud/firestore. Memory logs warn: memory store: every sign-in is lost on restart; one process only. |
| `MCP_STORE_NAMESPACE` | No | `mcp, or readonly_mcp when MCP_READ_ONLY=true` | Must match ^[a-z][a-z0-9_]{0,30}$ or exit 1. Firestore collection prefix and SQLite default filename; the SQLite file records it and refuses any other. |
| `MCP_STORE_PATH` | No | `<os.homedir()>/.netsapiens-mcp/<namespace>.sqlite` | SQLite only; a relative path or setting it with another backend exits 1. |
| `MCP_SESSION_SECRET` | Yes | None | At least 32 characters or exit 1 with ConfigError: MCP_SESSION_SECRET must be at least 32 characters. Signs and seals login state and derives the store key; changing it signs everyone out. |
| `GOOGLE_CLOUD_PROJECT` | No | None | Does not select a store. With MCP_PERSISTENCE=firestore, the Google client library reads it as usual. |
<!-- /facts:store-env -->

## Library Usage

`netsapiens-mcp` exposes its core auth, storage, and client primitives as an importable library for custom servers:

```typescript
import {
  NetSapiensClient,
  NetSapiensAuthProvider,
  createStore,
  createSqliteStore,
  createFirestoreStore,
  createMemoryStore,
} from 'netsapiens-mcp/lib';
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on development and submitting version observations.

## License

MIT License. Copyright (c) 2024 OITVOIP.
