# NetSapiens MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![NetSapiens API](https://img.shields.io/badge/NetSapiens-v1%20%2B%20v2-blue)](https://docs.ns-api.com/)
[![MCP Protocol](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-green)](https://modelcontextprotocol.io/)
[![Cloud Run](https://img.shields.io/badge/Cloud%20Run-Hosted-4285F4?logo=googlecloud&logoColor=white)](https://cloud.google.com/run)

> 🚀 **Hosted, multi-user MCP for NetSapiens**
> Any AI agent — Claude, ChatGPT, anything that speaks MCP — logs in as a real NetSapiens user, drives the full v1 + v2 API, and stays connected indefinitely. Credentials never touch the model.

## ⚡ Features

- 🔐 **Hosted OAuth proxy** — The server *is* the OAuth 2.1 authorization server. The user signs in on a browser page hosted here, not in the chat. NetSapiens credentials never enter the model's context.
- 🛡️ **MFA built into the flow** — Real NetSapiens accounts have a second factor. When the upstream returns an MFA challenge, the user gets a passcode page; the bearer that reaches the AI carries the verified session.
- 🔁 **Transparent NetSapiens refresh** — Upstream access tokens are refreshed silently before they expire. AI sessions stay alive across long conversations.
- 🍪 **Cookieless login state** — OAuth pending state and MFA challenges ride in the login form itself, HMAC-signed (and AES-256-GCM sealed for MFA). No cookies, no server-side session, so restarts and Cloud Run instance switches mid-login don't break anything.
- 🗄️ **Firestore persistence** — Issued tokens and dynamic client registrations survive deploys, scaling events, and instance churn. No one gets logged out on a release.
- 🤝 **Claude *and* ChatGPT support** — Public-client dynamic registration (`token_endpoint_auth_method=none`, PKCE only) means ChatGPT connects out of the box alongside confidential clients like Claude.
- 🧬 **727 auto-generated tools from the specs** — v2 OpenAPI (481) + v1 apidoc (274), regenerated on every build. When NetSapiens ships a new endpoint, drop in the new spec and rebuild.
- 🎯 **Curated catalog by default (~39 task-shaped tools)** — Find-this, do-that composites scaled to a model's working memory. Set `MCP_TOOL_MODE=full` to restore the full 727-tool listing.
- 🧵 **Multi-call workflows** — `diagnose_call`, `user_profile`, `queue_health`, `agent_dashboard`, `switch_queue`, `find_and_call`, `recent_activity_for_number`, `voicemail_inbox_summary`, `schedule_forwarding`. Each replaces 2–5 round-trips with one shaped response.
- 🔍 **API discovery escape hatch** — When the catalog doesn't cover it, the model uses `search_api` to find a tool by keyword across the full 727, then invokes it by name with `call_api`. Same filters apply.
- 🚫 **Security stripped at generation time** — Token, JWT, API-key, certificate, and credential endpoints are excluded from the registry *at build time*. The model can't mint or revoke credentials because there's no tool to do it.
- 👥 **Scope-aware role filtering** — A Basic User sees ~25 self-service tools; an Office Manager / Reseller / Super User sees the full ~39 plus administrative operations. NetSapiens still enforces server-side.
- 🪛 **Operator-tunable** — Disable globs (`MCP_DISABLED_TOOLS=delete_*,remove_*`), action blocks (`MCP_DISABLED_ACTIONS`), semantic destructive toggle (`MCP_DISABLE_DESTRUCTIVE=true` — blocks any tool that mutates irreversibly, including composites like `end_call`), in-band confirmation prompt (`MCP_CONFIRM_DESTRUCTIVE=true` — the model has to get the user's blessing in the AI client before any destructive call), branded login page (`MCP_LOGIN_HEADER`, `MCP_ICON_URL`). No code change for per-deployment policy.
- 🧠 **Per-user tool promotion** — Generated tools the user reaches for repeatedly via `call_api` get promoted into their personal default tool list automatically. Per NetSapiens user, persisted to Firestore, threshold-based, all filters still apply. The server `sendToolListChanged` notification fires once on the call that crosses the threshold.
- 🧪 **A real test suite** — 230 passing, including a draft-2020-12 JSON Schema guard that compiles every tool's input schema on every test run, so a bad spec can't silently break the connector.
- 🚀 **Auto-deploy from `main`** — Cloud Build runs the suite, builds the image, pushes it to Artifact Registry, and rolls out a new Cloud Run revision. Env vars carry over; CI ships code, ops sets config.

## 📋 What this server is

- **Two MCP transports.** `stdio` for local CLI integrations and `http` (Streamable HTTP) for hosted deployments. Production uses `http`.
- **Auto-generated tools.** 481 tools from the NetSapiens v2 OpenAPI spec plus 274 from the v1 apidoc dump, all regenerated on every build from `spec/netsapiens-api-v2.json` and `spec/netsapiens-api-v1.json`.
- **Hosted OAuth login.** The server acts as its own OAuth authorization server. The user enters NetSapiens credentials in a login page served by this MCP server — credentials never pass through the AI. MFA is supported.
- **Transparent token refresh.** Upstream NetSapiens tokens are refreshed silently when they expire; AI clients see continuous sessions.
- **Cookieless flow state.** OAuth pending state and MFA challenges ride in the form, signed so they can't be forged, so logins survive container restarts, instance switches, and a browser that drops cookies.
- **Firestore persistence.** MCP tokens and DCR client registrations live in Firestore when `MCP_PERSISTENCE=firestore` (recommended on Cloud Run) so reconnects survive deploys.
- **Public-client DCR.** Honors `token_endpoint_auth_method=none` for clients like ChatGPT that authenticate via PKCE only.
- **Tool gating.** Read/write annotations on every tool, plus glob-based disable patterns (`MCP_DISABLED_TOOLS`) and action-level disables (`MCP_DISABLED_ACTIONS`).

## 🏗️ Architecture

```
AI client (Claude/ChatGPT)
  │  OAuth 2.1 DCR + browser login
  ▼
[ MCP HTTP server (this repo) ]    ← OAuth proxy, login page, MFA
  │  bearer token + PKCE
  ▼
[ NetSapiens API (v1 + v2) ]
```

Per-user upstream NetSapiens tokens are stored alongside our MCP-issued tokens. Every tool call attaches the right upstream bearer; tools never see credentials.

## 💻 Running locally (stdio)

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

## 🌐 Running as a hosted server (HTTP)

```bash
export MCP_TRANSPORT=http
export MCP_PORT=3000
export MCP_BASE_URL=https://mcp.example.com
export NETSAPIENS_API_URL=https://edge.example.com
export NETSAPIENS_OAUTH_CLIENT_ID=<operator-client-id>
export NETSAPIENS_OAUTH_CLIENT_SECRET=<operator-client-secret>
export MCP_SESSION_SECRET=<32+ random hex>     # signs and seals login-state blobs
npm start
```

Connect from Claude / ChatGPT by giving it the URL `https://mcp.example.com/mcp`. The client will DCR-register, redirect the user to `/authorize`, the user signs in, and the bearer flows back to the AI automatically.

### Stateless by default

The HTTP transport runs **stateless**: every `POST /mcp` builds its own MCP server, NetSapiens client, and transport from the request's bearer, then tears them down. Nothing is retained between requests, so any instance can serve any request and a deploy or a scale-down never strands a client mid-session.

`GET /mcp` and `DELETE /mcp` answer `405` in this mode, which is what the streamable-HTTP spec prescribes when the server offers no SSE stream and has no session to terminate. Compliant clients treat that as "don't retry".

Sessions still buy two things, both server-initiated: the elicitation confirmation prompt and `notifications/tools/list_changed` for tool promotion. Set `MCP_STATELESS=false` if you want them. If `MCP_CONFIRM_DESTRUCTIVE=true` and you have not set `MCP_STATELESS` either way, sessions are kept automatically rather than silently degrading that gate.

| Mode | Session affinity needed | Elicitation prompts | list_changed notifications |
|---|---|---|---|
| `MCP_STATELESS=true` (default) | No | No | No |
| `MCP_STATELESS=false` | Yes | Yes | Yes |

## ☁️ Cloud Run deployment

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
| `MCP_SESSION_SECRET` | 32+ char random; signs and seals login state & must be stable across instances |
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

## 🔐 OAuth flow (detailed)

1. AI client hits `GET /.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server` for discovery.
2. AI client POSTs `/register` (RFC 7591 DCR). Public clients pass `token_endpoint_auth_method=none` and get back a `client_id` only; confidential clients get `client_id` + `client_secret`. Registrations persist in Firestore.
3. AI redirects the user's browser to `/authorize?...` with PKCE parameters. The server signs the pending request into a hidden `auth_state` field on the login form and renders the page. No cookie, no server-side session.
4. User submits credentials → server hits `POST {NS}/ns-api/v2/tokens` (password grant). If NS responds with `mfa_type`/`mfa_vendor`, the server seals the partial state into a hidden `mfa_state` field and prompts for a passcode.
5. On success, the server issues an authorization code and redirects back to the AI client.
6. AI exchanges the code at `/token` for our MCP-issued bearer + refresh token. The upstream NS token is stored alongside.
7. On every `/mcp` request, the server verifies the bearer, transparently refreshes the upstream NS token if it's within 60s of expiry, and forwards the request through the right NS handler.

**Why no cookies.** There is no session to keep here. `/authorize` receives everything the flow needs (client_id, redirect_uri, PKCE challenge, state), and the only job is handing those same params back at `POST /login`. A cookie is browser-global and request-independent, which is exactly wrong for that: a second `/authorize` in another tab overwrites the first tab's copy, a completed flow clears it out from under a tab still open, and any browser that withholds it takes the whole sign-in down with "Your sign-in session has expired." State that travels with the page has none of those failure modes — one copy per rendered form, signed so it can't be forged.

The blob holds public OAuth request params, and the code it leads to still lands on the client's registered redirect URI behind PKCE, so the window is a generous 2 hours: a tab that sat open just signs in. The MFA blob is AES-256-GCM **sealed** rather than merely signed, because it carries the password needed for the NS `grant_type=mfa` call and must not be readable in page source. With no cookies there is no `SameSite` behavior to lean on, so cross-site POSTs to `/login` and `/mfa` are rejected via `Sec-Fetch-Site`, and both pages are served `no-store`.

Rejections are logged with a reason (`no_state_present`, `expired`, `bad_signature`, `malformed`). A `bad_signature` cluster means `MCP_SESSION_SECRET` changed or differs between instances.

## 🧰 Tools

The server exposes **a curated catalog of ~39 task-shaped tools by default** instead of the full 727-operation generated registry. With 700+ tools in the listing, even capable AI models stall on tool selection and burn context on enumeration; a focused default surface fixes that without losing reach.

The catalog has three layers:

1. **Thin composites** (~28) — one-or-two-call wrappers over common NS endpoints: `find_user`, `find_contact`, `find_domain`, `find_phone_number`, `find_device`, `recent_calls`, `active_calls`, `call_details`, `call_trace`, `place_call`, `transfer_call`, `end_call`, `my_voicemails`, `read_voicemail`, `forward_voicemail`, `list_message_sessions`, `read_messages`, `send_message`, `list_queues`, `queue_status`, `agent_login`, `agent_logout`, `agent_status`, `my_devices`, `my_answer_rules`, `update_my_answer_rule`, `call_statistics`, `agent_statistics`.
2. **Workflow tools** (14) — multi-call composites that chain endpoints to deliver a higher-level intent in one shot: `diagnose_call`, `user_profile`, `queue_health`, `agent_dashboard`, `switch_queue`, `find_and_call`, `recent_activity_for_number`, `voicemail_inbox_summary`, `schedule_forwarding`, `provision_user`, `deprovision_user`, `provision_call_queue`, `deprovision_call_queue`, `set_hold_message`.
3. **API discovery / escape hatch** (2) — `search_api` and `call_api` (see next section).

The catalog is **scope-aware**: a basic NS user sees ~25 self-service tools; a domain admin or above sees the full ~39 including supervisory and diagnostic operations. The catalog lives in `src/tools/curated/catalog.ts` and `src/tools/curated/workflows.ts`; edit there and rebuild.

Set `MCP_TOOL_MODE=full` to expose the entire 727-tool generated registry instead (legacy behavior).

Every tool (curated, workflow, or generated) carries:

- `annotations.readOnlyHint` — `true` for GETs/lookups, `false` for mutations.
- `annotations.destructiveHint` — `true` for delete-style operations.

### Writes are synchronous, and multi-step operations are single tools

42 NetSapiens write operations accept a `synchronous` body parameter that defaults to `no`. With `no`, the API answers 202 with an empty body **before the write has replicated far enough to be read back**, so any create-then-verify sequence races: the model writes, re-reads, finds nothing, and reports a failure that did not happen. NetSapiens' own controllers set `synchronous=yes` whenever they chain a write into a later read.

This server defaults `synchronous` to `yes` on every tool whose schema accepts it, never overriding an explicit value. `MCP_SYNCHRONOUS_WRITES=false` restores the API's own default.

Two composites cover operations that are a chain rather than a call:

- **`provision_user`** — creating a user writes only the user record: no device, no DID. A user in that state cannot register a phone or take an outside call. This runs user → device → DID in order with synchronous writes, stops at the first failure instead of orphaning a device on a user that does not exist, and reports what is still unconfigured.
- **`deprovision_user`** — deleting a user cascades server-side to their devices, contacts, addresses, timeframes, voicemail, and MFA, but **not** to DIDs routed at them or their queue agent rows. Those are left pointing at a destination that no longer exists. This inventories both first, deletes the user, then releases the leftovers. `dry_run: true` shows exactly what would go without touching anything.

- **`provision_call_queue`** / **`deprovision_call_queue`** — the same shape for queues. Creating a queue writes the queue and its huntgroup but no agents and no number, so it answers nothing and nobody can reach it. Deleting one removes the queue and huntgroup and leaves every agent membership behind, plus any DID pointed at it.

A full sweep of which NetSapiens operations are chains, and which end of the wire runs them, is in the findings doc. Creating a domain, creating an auto attendant, and creating or deleting a timeframe are all handled server-side in a single call, so they get no composite.

These are grounded in the platform behavior documented in [`docs/netsapiens-controller-findings.md`](docs/netsapiens-controller-findings.md).

### Dead ends, and how they are closed

A generated tool can look callable and be impossible to complete. Three kinds showed up, and each is now handled rather than left for the model to discover:

- **Multipart uploads.** The generator treats a `multipart/form-data` body like a JSON one, so it emitted 12 tools that send JSON to endpoints which parse a raw upload. They are hidden from `search_api` and rejected at dispatch with the working alternative named. Greetings, music-on-hold, and images all have a text-to-speech or base64 variant. Hold messages have neither, so `set_hold_message` sends a genuine multipart upload from base64 audio.
- **Fields the spec understates.** `POST /callqueues` validates `domain`, `queue`, **and** `description` in the controller, while the spec marks only the first two required. `provision_call_queue` now always sends one.
- **Invented field names.** A body key NetSapiens does not recognise is ignored, and the call still answers success, so the tool reports work it never did. `spec-conformance.test.ts` drives every write composite against a recording client and fails if any body key is absent from the spec for that operation. It would have caught the `rule-action` bug the day it was written.

### What each tool carries

Every exposed tool ships the fields the current MCP revision defines, so clients can render and reason about it without guessing:

- **`title`** — human-readable display name (`get_domain_users` → "Get Domain Users"), used in tool lists and permission prompts while `name` stays stable for dispatch.
- **`annotations`** — `readOnlyHint` and `destructiveHint` as before, plus `idempotentHint` (reads, PUTs, and DELETEs repeat safely; creates do not) and `openWorldHint` (always true — every tool reaches a live NetSapiens platform).
- **`structuredContent`** — attached to any result whose text block is valid JSON, so the model gets data instead of re-parsing prose. The text block stays for clients that don't read structured content.

`tools/list` is paginated with opaque cursors (`MCP_TOOLS_PAGE_SIZE`, default 250), which matters in `full` mode where the listing is 700+ entries.

The server also sends `instructions` on initialize: the NetSapiens conventions that otherwise cause failed calls (`~` for self, the `YYYY-MM-DD HH:MM:SS` datetime format, unfiltered collection endpoints needing `limit`). Stated once per session rather than repeated across 700 descriptions.

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

## ⏱️ Bearer token lifetime

The MCP bearer we issue to the AI client carries `expires_in: 604800` (7 days) by default. Refresh tokens are issued alongside, so well-behaved MCP clients can transparently mint a new bearer when this one expires by POSTing `grant_type=refresh_token` to `/token`.

Why 7 days instead of the more typical 1 hour? Some MCP clients (Claude's web UI and ChatGPT's connector among them) have had bugs that prevent automatic refresh on a 401 — when that happens the user sees a "session expired, reconnect" prompt in the middle of a working conversation. A 7-day bearer means the cliff is hit far less often. Refresh still works for the cases it does fire on, but most sessions never reach that path.

Tunable per deployment via `MCP_TOKEN_LIFETIME_HOURS` (default `168`, min 1, max 2160 = 90 days). NetSapiens upstream tokens are refreshed silently inside `verifyAccessToken` regardless, and the refreshed token is pushed into the live MCP session's API client on every request — NS rotates (and invalidates) the old token on refresh, so a session that kept its original token would 401 on every NS call for the rest of its life. Concurrent requests share a single in-flight refresh per bearer for the same reason.

Logs help debugging:

- `MCP bearer expired — client should refresh` — fires whenever a request comes in with an expired bearer. If this fires AND a fresh `/token` POST does not follow shortly after, the AI client isn't refreshing.
- `MCP bearer refreshed via refresh_token` — fires on every successful refresh, so you can confirm clients are using the refresh-token path.
- `Refresh token presented but unknown — user will be asked to reconnect` — fires if a stored refresh token can't be found (e.g. an old client cached one from before a token-store wipe).

## 🛡️ Destructive-action confirmation (elicitation gate)

Set `MCP_CONFIRM_DESTRUCTIVE=true` to make the server pause before any destructive tool runs and ask the user to confirm in-band, using the MCP `elicitation/create` capability. The user sees a "Confirm `end_call` on `call_id=XYZ`? Yes/No" prompt directly in their AI client; only on accept does the call execute. Decline or cancel and the model gets a clear "user declined" error to relay back.

`MCP_DISABLE_DESTRUCTIVE` wins over confirmation: if a tool is disabled outright, we don't waste the user's time prompting for a call we'd reject.

**Client capability:** The MCP spec requires the client to advertise `capabilities.elicitation`. Claude supports it; ChatGPT support is uncertain and should be verified per-deployment. If the connected client doesn't support elicitation, fail-closed is the default (the destructive call is refused with a clear error). Set `MCP_CONFIRM_FALLBACK=allow` to instead bypass the confirmation on incapable clients (operator opt-in only — defeats the purpose for those sessions).

## 🧠 Per-user tool promotion

When a user reaches for a generated tool repeatedly through `call_api`, the server learns and promotes it into the user's default tool list automatically. Next time the user connects, the tool is right there in the listing — no search-and-call dance.

Mechanics:

- Tracked per **NetSapiens username** (from the authenticated bearer), not per AI client. Use the same NS account across Claude and ChatGPT and your promotions follow you.
- Stored in the Firestore collection `mcp_tool_usage` when `MCP_PERSISTENCE=firestore` (default on Cloud Run); in-memory otherwise.
- Promotion fires when count ≥ `MCP_PROMOTE_THRESHOLD` (default `3`) within the last `MCP_PROMOTE_WINDOW_DAYS` (default `14`) days.
- **Demotion is automatic.** Once a tool's most recent call falls outside the window it drops back out of the user's catalog without any explicit action. The list is always a reflection of recent activity, not a permanent inheritance.
- **Dynamic list refresh.** After every successful tool call, the server diffs the user's live promoted set against a per-session snapshot. If anything changed — a fresh promotion crossed the threshold, or a previously-promoted tool just decayed — it fires `notifications/tools/list_changed` once, so AI clients re-list mid-session without reconnecting. When nothing changed, no notification is sent and the model isn't disturbed.
- Promotion **never bypasses other filters**: a tool hidden by `MCP_DISABLED_TOOLS`, role tier, `MCP_DISABLE_DESTRUCTIVE`, or the generation-time security strip stays hidden, no matter how many times it gets called.
- Opt out per deployment with `MCP_DISABLE_PROMOTION=true`.

**Privacy note:** This stores per-user tool-name counts and timestamps in Firestore. No arguments, no responses, no PII — just `{username, toolName, count, lastUsed}` rows. Worth mentioning in a deployment's user docs so it's not a surprise.

## 🎨 Customizing the login page

Set `MCP_LOGIN_HEADER` for the heading text and `MCP_ICON_URL` for the logo:

```bash
gcloud run services update netsapiens-mcp \
  --update-env-vars="MCP_LOGIN_HEADER=Login to Acme,MCP_ICON_URL=https://your-cdn/logo.png"
```

The same icon is served at `/favicon.ico` and `/favicon.png` so AI clients pick it up for their connector list. The favicon route fetches and caches the image bytes — it doesn't redirect, because some MCP clients won't follow redirects for favicons.

## 🔄 Regenerating tools

The specs are vendored at `spec/netsapiens-api-v2.json` (OpenAPI 3.1) and `spec/netsapiens-api-v1.json` (apidoc dump). To regenerate after a spec update:

```bash
npm run generate    # runs both generators, writes src/generated/
npm run build       # tsc compiles the generated code
```

`prebuild` runs `generate` automatically, so `npm run build` is enough most of the time.

## 📊 Health and observability

- `GET /health` — uptime, transport mode (`stateless` / `session`), active sessions, NS API URL, version.
- Structured JSON logs to stderr (use `LOG_LEVEL=debug` for verbose).
- Each MCP request logs through Cloud Run's standard `httpRequest` schema; auth events log to `jsonPayload.message`.

## 📁 Repo layout

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
    netsapiens-auth-provider.ts # OAuth provider, MFA, signed form state
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

## 📜 License

MIT
