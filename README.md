# NetSapiens MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Release](https://img.shields.io/badge/release-v3.0.0-blue.svg)](https://github.com/phoneware/netsapiens-mcp/releases)
[![CI](https://github.com/phoneware/netsapiens-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/phoneware/netsapiens-mcp/actions/workflows/ci.yml)

A Model Context Protocol (MCP) server connecting LLM assistants to the NetSapiens VoIP platform API. Supports per-user OAuth 2.1 browser sign-in in HTTP mode, local stdio CLI execution with static token or password credentials, role-based tool visibility, host-version-aware route filtering, and encrypted session storage at rest.

## Who It Is For

VoIP operators, service providers, and NetSapiens partners who want AI assistants (such as Claude, ChatGPT, or custom AI agents) working directly with the NetSapiens API under defined permissions.

## Comparison with docs.ns-api.com/mcp

NetSapiens provides an official reference documentation MCP at `docs.ns-api.com/mcp`. That server exposes five generic HTTP utility tools (including raw HAR request execution) designed for documentation exploration.

In contrast, `netsapiens-mcp` provides:
- **Per-user sign-in:** In HTTP mode, each user authenticates with their own NetSapiens credentials through an OAuth 2.1 browser authorization code flow; raw user passwords never enter model context. In stdio mode, single-user operation uses an API token or credentials passed via environment variables.
- **Role-aware tools:** Each user only sees and invokes tools their NetSapiens role allows (`super_user`, `reseller`, `domain_admin`, `office_manager`, `user`).
- **Version-aware availability:** Tool catalogs adapt automatically to the reported release of the target NetSapiens host (44.3 through 46.0).
- **Curated workflows:** High-level composite tools for complex operations alongside over 1,100 granular API tools.
- **Credential protection:** Encrypted session storage at rest in HTTP mode, policy filters, and automated secret scrubbing.

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
3. Claude will register dynamically via OAuth 2.1 Dynamic Client Registration.
4. Users complete login on the NetSapiens MCP login page.

## Role Tiers

Tools are filtered by the authenticated user's NetSapiens role tier:

<!-- facts:roles -->
| Role Tier | Priority | NetSapiens User Scopes |
|---|---|---|
| `system_admin` | 4 | Super User, System Admin |
| `reseller` | 3 | Reseller |
| `domain_admin` | 2 | Office Manager, Site Manager, Domain Admin, Call Center Supervisor |
| `user` | 1 | Call Center Agent, Advanced User, Basic User, Simple User, No Portal |
<!-- /facts:roles -->

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
| `<namespace>_auth_codes` | PKCE authorization codes | `ttlAt` | Single-use, expires in 5 minutes |
| `<namespace>_resume_tokens` | MCP resumption nonces | `ttlAt` | Single-use, expires in 2 hours |
| `<namespace>_oauth_clients` | Registered OAuth clients | None | Persistent client configurations |
| `<namespace>_usage` | User rate-limiting counters | None | Persistent call count telemetry |
<!-- /facts:firestore-collections -->

### Runtime & Node Support

Node 22.13 or later. On Node 22, Node marks `node:sqlite` experimental and prints a warning when the default store opens; Node 24.15 and later mark it a release candidate. The Docker image uses Node 24.

## Security & Architecture Limits

- **Local Storage Isolation:** SQLite database files are initialized with mode 0600 permissions on POSIX systems.
- **Windows SQLite ACLs:** On Windows systems, POSIX permission bits are not supported by the underlying operating system. The SQLite database, WAL, and journal files inherit access controls from their parent directory. Operators running on Windows should ensure the directory containing the SQLite database is restricted to the desired service account.
- **Credential Protection at Rest:** In HTTP mode, session tokens, refresh tokens, and credentials are encrypted using AES-256-GCM before storage. Dynamic Client Registration records (`oauth_clients`) are unencrypted metadata containing client names and redirect URIs.
- **Stdio Token Cache:** In stdio mode, tokens are cached unencrypted in `~/.netsapiens-mcp-tokens.json` (mode 0600 on POSIX).
- **Secret Invalidation:** Rotating `MCP_SESSION_SECRET` immediately terminates and invalidates all existing HTTP sessions. `MCP_SESSION_SECRET` is required in HTTP mode; stdio mode uses an ephemeral in-memory key and ignores this variable.
- **Usage Retention:** In-store rate limiting telemetry counters do not expire automatically.

## Configuration Reference

<!-- facts:env-table -->
| Variable | Transports | Required | Default | Description |
|---|---|---|---|---|
| `NETSAPIENS_API_URL` | http, stdio | Yes | None | NetSapiens host origin. |
| `NETSAPIENS_PLATFORMS` | http | No | None | JSON object of allowed platforms; ignored in stdio mode. |
| `NETSAPIENS_VERSION_TTL_SECONDS` | http, stdio | No | `3600` | Version cache TTL in seconds; positive integer or exit 1. |
| `MCP_PLATFORMS` | http, stdio | No | None | Removed in 3.0.0; use NETSAPIENS_PLATFORMS. |
| `MCP_PERSISTENCE` | http | No | `sqlite` | sqlite, firestore or memory; any other value exits 1. file exits 1 with ConfigError: MCP_PERSISTENCE=file was removed in 3.0.0; the default store is sqlite (see MCP_STORE_PATH). Unset with GOOGLE_CLOUD_PROJECT exits 1 with ConfigError: MCP_PERSISTENCE is not set. 2.x chose Firestore because GOOGLE_CLOUD_PROJECT is set; 3.0.0 never infers the store. Set MCP_PERSISTENCE=firestore or MCP_PERSISTENCE=sqlite. Firestore without its package exits 1 with ConfigError: MCP_PERSISTENCE=firestore needs @google-cloud/firestore: npm install @google-cloud/firestore. Memory logs warn: memory store: every sign-in is lost on restart; one process only. |
| `MCP_STORE_NAMESPACE` | http | No | `mcp, or readonly_mcp when MCP_READ_ONLY=true` | Must match ^[a-z][a-z0-9_]{0,30}$ or exit 1. Firestore collection prefix and SQLite default filename; the SQLite file records it and refuses any other. |
| `MCP_STORE_PATH` | http | No | `<os.homedir()>/.netsapiens-mcp/<namespace>.sqlite` | SQLite only; a relative path or setting it with another backend exits 1. |
| `MCP_SESSION_SECRET` | http | Yes | None | At least 32 characters or exit 1 with ConfigError: MCP_SESSION_SECRET must be at least 32 characters. Signs and seals login state and derives the store key; changing it signs everyone out. |
| `GOOGLE_CLOUD_PROJECT` | http | No | None | Does not select a store. With MCP_PERSISTENCE=firestore, the Google client library reads it as usual. |
| `MCP_TOKEN_STORE_PATH` | http | No | None | ConfigError: MCP_TOKEN_STORE_PATH was removed in 3.0.0; use MCP_STORE_PATH |
| `FIRESTORE_AUTH_CODES_COLLECTION` | http | No | None | ConfigError: FIRESTORE_AUTH_CODES_COLLECTION was removed in 3.0.0; use MCP_STORE_NAMESPACE |
| `FIRESTORE_RESUME_TOKENS_COLLECTION` | http | No | None | ConfigError: FIRESTORE_RESUME_TOKENS_COLLECTION was removed in 3.0.0; use MCP_STORE_NAMESPACE |
| `NETSAPIENS_API_TOKEN` | stdio | No | None | Static API token, or provide all four OAuth credentials. |
| `NETSAPIENS_OAUTH_CLIENT_ID` | http, stdio | No | None | OAuth client ID; required in HTTP mode or for stdio OAuth. |
| `NETSAPIENS_OAUTH_CLIENT_SECRET` | http, stdio | No | None | OAuth client secret; required in HTTP mode or for stdio OAuth. |
| `NETSAPIENS_OAUTH_USERNAME` | stdio | No | None | OAuth username for stdio. |
| `NETSAPIENS_OAUTH_PASSWORD` | stdio | No | None | OAuth password for stdio. |
| `MCP_TRANSPORT` | http, stdio | No | `stdio` | Transport selection. |
| `DEBUG` | http, stdio | No | `false` | Enable debug output. |
| `LOG_LEVEL` | http, stdio | No | None | Logging level. |
| `MCP_BASE_URL` | http | No | None | Public server base URL. |
| `MCP_PORT` | http | No | `3000` | HTTP listening port. |
| `MCP_HOST` | http | No | `0.0.0.0` | HTTP listening address. |
| `MCP_CORS_ORIGIN` | http | No | `*` | CORS origin. |
| `MCP_ICON_URL` | http, stdio | No | None | Server icon URL. |
| `MCP_LOGIN_HEADER` | http | No | None | Login page heading. |
| `MCP_LOGIN_LOGO_URL` | http | No | None | Login page logo URL. |
| `MCP_SERVER_TITLE` | http, stdio | No | None | Server title. |
| `MCP_WEBSITE_URL` | http, stdio | No | None | Server website URL. |
| `MCP_STATELESS` | http | No | None | Control HTTP session mode. |
| `MCP_TOKEN_LIFETIME_HOURS` | http | No | `168` | Issued token lifetime in hours. |
| `MCP_READ_ONLY` | http, stdio | No | `false` | Disable modifying tools. |
| `MCP_TOOL_MODE` | http, stdio | No | None | Select tool catalog. |
| `MCP_TOOLS_PAGE_SIZE` | http, stdio | No | None | Tool list page size. |
| `MCP_DISABLED_TOOLS` | http, stdio | No | None | Tool name patterns to disable. |
| `MCP_DISABLED_ACTIONS` | http, stdio | No | None | Actions to disable. |
| `MCP_DISABLE_DESTRUCTIVE` | http, stdio | No | `false` | Disable destructive tools. |
| `MCP_DISABLE_ROLE_FILTER` | http, stdio | No | `false` | Disable role filtering. |
| `MCP_CONFIRM_DESTRUCTIVE` | http, stdio | No | `false` | Request confirmation for destructive operations. |
| `MCP_CONFIRM_FALLBACK` | http, stdio | No | None | Confirmation fallback policy. |
| `MCP_DISABLE_PROMOTION` | http, stdio | No | `false` | Disable tool promotion. |
| `MCP_PROMOTE_THRESHOLD` | http, stdio | No | None | Tool promotion threshold. |
| `MCP_PROMOTE_WINDOW_DAYS` | http, stdio | No | None | Tool promotion window. |
| `MCP_SYNCHRONOUS_WRITES` | http, stdio | No | None | Control synchronous upstream writes. |
<!-- /facts:env-table -->

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
