# NetSapiens MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP Protocol](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-green)](https://modelcontextprotocol.io/)

A hosted Model Context Protocol (MCP) server that exposes the full NetSapiens platform (both v1 and v2 APIs) to AI agents like Claude and ChatGPT. It runs as an HTTP service behind OAuth 2.1, performs the browser-based login on behalf of each user, and keeps connections alive across redeploys with Firestore-backed persistence.

## What this server is

- **Two MCP transports.** `stdio` for local CLI integrations and `http` (Streamable HTTP) for hosted deployments. Production uses `http`.
- **Auto-generated tools.** 481 tools from the NetSapiens v2 OpenAPI spec plus 274 from the v1 apidoc dump, all regenerated on every build from `spec/netsapiens-api-v2.json` and `spec/netsapiens-api-v1.json`.
- **Hosted OAuth login.** The server acts as its own OAuth authorization server. The user enters NetSapiens credentials in a login page served by this MCP server — credentials never pass through the AI. MFA is supported.
- **Transparent token refresh.** Upstream NetSapiens tokens are refreshed silently when they expire; AI clients see continuous sessions.
- **Stateless flow state.** OAuth pending state and MFA challenges ride in HMAC-signed cookies, so logins survive container restarts and Cloud Run instance switches.
- **Firestore persistence.** MCP tokens and DCR client registrations live in Firestore when `MCP_PERSISTENCE=firestore` (recommended on Cloud Run) so reconnects survive deploys.
- **Public-client DCR.** Honors `token_endpoint_auth_method=none` for clients like ChatGPT that authenticate via PKCE only.
- **Tool gating.** Read/write annotations on every tool, plus glob-based disable patterns (`MCP_DISABLED_TOOLS`) and action-level disables (`MCP_DISABLED_ACTIONS`).

## Architecture

```
AI client (Claude/ChatGPT)
  │  OAuth 2.1 DCR + browser login
  ▼
[ MCP HTTP server (this repo) ]    ← OAuth proxy, login page, MFA, cookies
  │  bearer token + PKCE
  ▼
[ NetSapiens API (v1 + v2) ]
```

Per-user upstream NetSapiens tokens are stored alongside our MCP-issued tokens. Every tool call attaches the right upstream bearer; tools never see credentials.

## Running locally (stdio)

```bash
npm install
npm run build
export NETSAPIENS_API_URL=https://edge.example.com
export NETSAPIENS_API_TOKEN=<your-token>      # OR set OAuth username/password
npm start                                      # MCP_TRANSPORT defaults to stdio
```

Add this entry to your local MCP client config (Claude Desktop, etc.):

```json
{
  "mcpServers": {
    "netsapiens": {
      "command": "node",
      "args": ["/path/to/netsapiens-mcp/build/index.js"]
    }
  }
}
```

## Running as a hosted server (HTTP)

```bash
export MCP_TRANSPORT=http
export MCP_PORT=3000
export MCP_BASE_URL=https://mcp.example.com
export NETSAPIENS_API_URL=https://edge.example.com
export NETSAPIENS_OAUTH_CLIENT_ID=<operator-client-id>
export NETSAPIENS_OAUTH_CLIENT_SECRET=<operator-client-secret>
export MCP_SESSION_SECRET=<32+ random hex>     # signs login-state cookies
npm start
```

Connect from Claude / ChatGPT by giving it the URL `https://mcp.example.com/mcp`. The client will DCR-register, redirect the user to `/authorize`, the user signs in, and the bearer flows back to the AI automatically.

## Cloud Run deployment

This repo ships with a Cloud Run-friendly Dockerfile and a `cloudbuild.yaml`. The minimum production stack:

| Component | Purpose |
|---|---|
| Cloud Run service | Runs the HTTP server with session affinity and `min-instances=1` |
| Global Load Balancer + static IP | Stable A record target if you want to point DNS at an IP instead of `ghs.googlehosted.com` |
| Managed SSL cert | Auto-provisioned for the custom domain |
| Firestore (native mode) | Persistent token store and DCR client registry |
| Cloud Run service account → `roles/datastore.user` | Firestore access |

Build, push, deploy:

```bash
gcloud builds submit --config cloudbuild.yaml --project=<your-project>
```

Required env vars on Cloud Run:

| Var | Notes |
|---|---|
| `MCP_TRANSPORT=http` | enable the HTTP transport |
| `MCP_BASE_URL` | public URL, e.g. `https://mcp.example.com` |
| `NETSAPIENS_API_URL` | upstream NS API, e.g. `https://edge.example.com` |
| `NETSAPIENS_OAUTH_CLIENT_ID` / `_SECRET` | NDP-provisioned client used for the password grant |
| `MCP_SESSION_SECRET` | 32+ char random; signs cookies & must be stable across instances |
| `MCP_PERSISTENCE=firestore` | enable Firestore-backed tokens and clients |
| `GOOGLE_CLOUD_PROJECT` | Firestore project ID (auto-set on Cloud Run) |

Optional:

| Var | Notes |
|---|---|
| `MCP_LOGIN_HEADER` | login page heading text (defaults to "NetSapiens MCP — Sign In") |
| `MCP_ICON_URL` | URL to a square PNG; used for `/favicon.*` and as the logo above the login form |
| `MCP_LOGIN_LOGO_URL` | override for just the login-form logo |
| `MCP_DISABLED_TOOLS` | comma-separated globs to hide tools (e.g. `delete_*,remove_*,*token*`) |
| `MCP_DISABLED_ACTIONS` | comma-separated action arg values to block on `manage_*` tools |
| `MCP_CORS_ORIGIN` | CORS origin for the MCP transport (defaults to `*`) |

## OAuth flow (detailed)

1. AI client hits `GET /.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server` for discovery.
2. AI client POSTs `/register` (RFC 7591 DCR). Public clients pass `token_endpoint_auth_method=none` and get back a `client_id` only; confidential clients get `client_id` + `client_secret`. Registrations persist in Firestore.
3. AI redirects the user's browser to `/authorize?...` with PKCE parameters. The server stores the pending request in a signed cookie (`mcp_pending_auth`, 15 min TTL) and renders the login page.
4. User submits credentials → server hits `POST {NS}/ns-api/v2/tokens` (password grant). If NS responds with `mfa_type`/`mfa_vendor`, the server stores the partial state in `mcp_mfa_challenge` and prompts for a passcode.
5. On success, the server issues an authorization code and redirects back to the AI client. Cookies are cleared.
6. AI exchanges the code at `/token` for our MCP-issued bearer + refresh token. The upstream NS token is stored alongside.
7. On every `/mcp` request, the server verifies the bearer, transparently refreshes the upstream NS token if it's within 60s of expiry, and forwards the request through the right NS handler.

## Tools

The server exposes **a curated catalog of ~39 task-shaped tools by default** instead of the full 727-operation generated registry. With 700+ tools in the listing, even capable AI models stall on tool selection and burn context on enumeration; a focused default surface fixes that without losing reach.

The catalog has three layers:

1. **Thin composites** (~28) — one-or-two-call wrappers over common NS endpoints: `find_user`, `find_contact`, `find_domain`, `find_phone_number`, `find_device`, `recent_calls`, `active_calls`, `call_details`, `call_trace`, `place_call`, `transfer_call`, `end_call`, `my_voicemails`, `read_voicemail`, `forward_voicemail`, `list_message_sessions`, `read_messages`, `send_message`, `list_queues`, `queue_status`, `agent_login`, `agent_logout`, `agent_status`, `my_devices`, `my_answer_rules`, `update_my_answer_rule`, `call_statistics`, `agent_statistics`.
2. **Workflow tools** (9) — multi-call composites that chain endpoints to deliver a higher-level intent in one shot: `diagnose_call`, `user_profile`, `queue_health`, `agent_dashboard`, `switch_queue`, `find_and_call`, `recent_activity_for_number`, `voicemail_inbox_summary`, `schedule_forwarding`.
3. **API discovery / escape hatch** (2) — `search_api` and `call_api` (see next section).

The catalog is **scope-aware**: a basic NS user sees ~25 self-service tools; a domain admin or above sees the full ~39 including supervisory and diagnostic operations. The catalog lives in `src/tools/curated/catalog.ts` and `src/tools/curated/workflows.ts`; edit there and rebuild.

Set `MCP_TOOL_MODE=full` to expose the entire 727-tool generated registry instead (legacy behavior).

Every tool (curated, workflow, or generated) carries:

- `annotations.readOnlyHint` — `true` for GETs/lookups, `false` for mutations.
- `annotations.destructiveHint` — `true` for delete-style operations.

### API discovery: how the model reaches the long tail

The curated catalog is intentionally small. When the model needs something not in it — read an audit log, list certificates, configure a specific dial-policy rule — it discovers and calls into the full 727-operation registry via two meta-tools:

- **`search_api(query, limit?)`** — keyword search across every generated tool's name and description. Returns ranked matches (token hits weighted, tool-name hits weighted higher). Use case: "I need to find the right tool." Example:
  ```json
  { "query": "auditlog", "limit": 5 }
  ```
  returns matches like `get_auditlog`, with short descriptions.

- **`call_api(tool_name, args)`** — invoke any tool the registry knows about by exact name, with arbitrary args:
  ```json
  { "tool_name": "get_auditlog", "args": { "limit": 50 } }
  ```

The discovery flow:

1. Model has a goal not covered by the curated catalog.
2. Model calls `search_api({ query })` to find candidates.
3. Model picks the best match (using its name + description).
4. Model calls `call_api({ tool_name, args })` to execute it.

This means the model browses the API the way a developer browses docs: search, read, call. The curated set handles the everyday work without an enumeration step; the meta-tools handle everything else without flooding the tool list.

All filters apply identically through `call_api`: `MCP_DISABLED_TOOLS`, `MCP_DISABLED_ACTIONS`, role-tier filtering. A user trying to `call_api` into `get_accesslog` (system-admin tier) gets the same "higher access tier required" rejection they'd get from the catalog. Security stripping happens at *generation* time — auth/token/JWT/API-key/cert/firebase endpoints are not in the registry to find, so `search_api` will never surface them and `call_api` will never invoke them. The escape hatch can't reach what isn't there.

### Infra/security endpoints are stripped at generation

Auth and credential endpoints are **excluded at generation time** — they never enter the registry — because exposing them as AI tools is a security risk (the server handles auth itself; these would let the model mint/read/revoke tokens, keys, certs, or service-account creds). The generators drop:

- **v2 tags**: `Authentication/Access Token (Oauth)`, `Authentication/API Key`, `Authentication/JWT`, `Firebase`, `SSL Certificates`, plus the `/email/verify/{token}` flow.
- **v1 objects**: `sfu` (mints media-server access tokens); `oauth2/token` endpoints are inherently skipped (no `object=` param).

This removes 27 v2 + 1 v1 operations (755 → 727). To change the exclusion list, edit `EXCLUDED_TAGS`/`EXCLUDED_PATH_RE` in `scripts/generate-tools.ts` and `EXCLUDED_OBJECTS` in `scripts/generate-v1-tools.ts`, then `npm run generate`.

### Recommended disable patterns

For operational (non-security) trimming per deployment, `MCP_DISABLED_TOOLS` still applies on top. Common choice:

```
delete_*,remove_*
```

- `delete_*`, `remove_*` — destructive operations you may not want an AI performing

### v1 vs v2

`v1_*` names are RPC-style (`?object=X&action=Y`) v2 names are REST. Many v2 endpoints have a v1 counterpart. If the v2 coverage is sufficient for your deployment, hide all of v1 with `MCP_DISABLED_TOOLS=...,v1_*`.

### Role-tier filtering

NetSapiens authorization is scope-tier (Super User > Reseller > Office Manager > Basic User) plus domain/territory ownership, enforced server-side with a 403 — there is no per-endpoint capability introspection endpoint to query up front. The user's scope is the only access signal available at connection time, and we read it at login.

On top of NS's own enforcement, the server hides clearly-privileged resource families from lower tiers as a UX nicety so the AI doesn't see tools it can't use:

- **system_admin only**: certificates, templates, images, routes, connections, firebase, backup/restore, access/audit logs, system configuration, system-wide dial policy, SFU, insight.
- **reseller minimum**: reseller management, domain create/delete/billing.
- **everything else**: visible to all authenticated users; NS enforces ownership.

The map is intentionally small and conservative — only families we're confident require a tier are gated, so a tool a user could legitimately call is never hidden. NS remains the real gatekeeper for the long tail. Disable the behavior entirely with `MCP_DISABLE_ROLE_FILTER=true` (then everything is visible and NS does all enforcement via 403).

## Customizing the login page

Set `MCP_LOGIN_HEADER` for the heading text and `MCP_ICON_URL` for the logo:

```bash
gcloud run services update netsapiens-mcp \
  --update-env-vars="MCP_LOGIN_HEADER=Login to Acme,MCP_ICON_URL=https://your-cdn/logo.png"
```

The same icon is served at `/favicon.ico` and `/favicon.png` so AI clients pick it up for their connector list. The favicon route fetches and caches the image bytes — it doesn't redirect, because some MCP clients won't follow redirects for favicons.

## Regenerating tools

The specs are vendored at `spec/netsapiens-api-v2.json` (OpenAPI 3.1) and `spec/netsapiens-api-v1.json` (apidoc dump). To regenerate after a spec update:

```bash
npm run generate    # runs both generators, writes src/generated/
npm run build       # tsc compiles the generated code
```

`prebuild` runs `generate` automatically, so `npm run build` is enough most of the time.

## Health and observability

- `GET /health` — uptime, active sessions, NS API URL, version.
- Structured JSON logs to stderr (use `LOG_LEVEL=debug` for verbose).
- Each MCP request logs through Cloud Run's standard `httpRequest` schema; auth events log to `jsonPayload.message`.

## Repo layout

```
spec/
  netsapiens-api-v2.json        # OpenAPI 3.1 — 481 ops
  netsapiens-api-v1.json        # apidoc dump  — 277 ops
scripts/
  generate-tools.ts             # v2 generator
  generate-v1-tools.ts          # v1 generator
src/
  index.ts                      # entry point (stdio or http)
  http-server.ts                # Express app + MCP transport + auth wiring
  netsapiens-client.ts          # axios-based NS client with v1Call/request adapters
  auth/
    netsapiens-auth-provider.ts # OAuth provider, MFA, signed cookies
    token-store.ts              # file-backed store + TokenStoreLike interface
    firestore-token-store.ts    # Firestore-backed store
    firestore-clients-store.ts  # Firestore-backed DCR registry
    roles.ts                    # NS scope → MCP user role mapping
  tools/
    index.ts                    # registry wrapper: annotations, disables, dispatch
  generated/
    registry.ts                 # generated v2 registry
    tools/*.ts                  # 82 generated v2 tool modules
    v1/
      registry.ts               # generated v1 registry
      tools/*.ts                # 61 generated v1 tool modules
    types.ts                    # ToolDefinition + GenericApiClient
```

## License

MIT
