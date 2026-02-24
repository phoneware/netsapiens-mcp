---
workflow: default
git:
  change_strategy: intent
  auto_merge: true
  auto_squash: false
announcements: []
created: 2026-02-23
status: active
epic: ""
---

# Full NetSapiens API v2 Coverage with OAuth Auth Code Flow

## Problem
The NetSapiens MCP server currently exposes only 23 read-only tools, covering a fraction of the 481 operations available in the NetSapiens API v2. Write operations (create, update, delete) are entirely missing, and many resource categories (live calls, messaging, contacts, meetings, timeframes, sites, connections, routes, configurations, etc.) have no coverage at all. Additionally, the current authentication requires storing user credentials (username/password) in environment variables, which is a security and usability concern.

## Solution
Auto-generate MCP tool definitions from the official NetSapiens OpenAPI 3.1 specification (`netsapiens-api-v2.json`, 329 paths, 481 operations, 140 schemas, 88 tags). Replace the monolithic hand-written architecture with a modular, registry-based system that loads generated tools. Replace the 24 hand-written API client methods with a single generic HTTP client. Add OAuth Authorization Code flow for browser-based authentication without storing user credentials.

## Domain Model

### Entities
- **Reseller** (10 properties) - Multi-tenant reseller hierarchy
- **Domain** (42 properties) - Top-level organizational unit containing users, devices, phone numbers, call queues, sites, contacts, addresses, connections, configurations
- **User** (55 properties) - Phone system users with devices, answer rules, contacts, voicemails, greetings, meetings, active calls, CDRs, messages
- **Device** (39 properties) - Physical/virtual phones assigned to users
- **Phonenumber** (9 properties) - Phone numbers assignable to users, queues, or offnet destinations
- **CallQueue** (28 properties) - ACD queues with agents, statistics, and queued calls
- **Agent** (25 properties) - Call center agents with login/logout/status actions
- **Answerrule** (20 properties) - Call routing rules per user with timeframe-based logic
- **Timeframe** (4+ properties, subtypes: DOW, Holiday, SpecificDate, Custom) - Scheduling constructs for answer rules
- **Contact** (12 properties) - User and shared domain contacts
- **Message/Messagesession** (21/23 properties) - Chat, SMS, MMS, group messaging
- **Meeting** (40 properties) - Video meetings with Iotum integration
- **ActiveCall** (23 properties) - Live calls with control actions (transfer, hold, answer, reject)
- **CDR** (85-99 properties) - Call detail records with transcription and sentiment
- **Audiofile** (19 properties) - Greetings, MOH, hold messages with TTS and file upload
- **Subscription** (15 properties) - Webhook event subscriptions
- **Site** (32 properties) - Physical locations within domains
- **Connection** (59 properties) - SIP trunking connections
- **Route/RouteConnection** (8/9 properties) - Call routing configuration
- **Configuration/ConfigDefinition** (9/13 properties) - System configuration key-value pairs
- **Address** (18 properties) - E911/physical addresses
- **SmsNumber** (7 properties) - SMS-enabled phone numbers
- **Recording** (13 properties) - Call recordings
- **DialRule/Dialplan** (21/4 properties) - Dial plan routing rules
- **NdpPhone** (55 properties) - Phone MAC provisioning

### Relationships
- Reseller has many Domains
- Domain has many Users, PhoneNumbers, CallQueues, Sites, Contacts, Addresses, Connections, Configurations
- User has many Devices, AnswerRules, Contacts, Voicemails, Greetings, Meetings, ActiveCalls, CDRs, Messages
- CallQueue has many Agents
- Timeframes belong to Domain (shared) or User
- AnswerRules reference Timeframes

### Data Sources
- **OpenAPI Spec** (OpenAPI 3.1.0): `netsapiens-api-v2.json` — 329 paths, 481 operations, 140 schemas, 88 tags
- **NetSapiens API v2**: REST API at `{instance}/ns-api/v2`, bearer token auth
- **Auth endpoints**: `POST /ns-api/oauth2/token/` (password grant), `GET /ns-api/oauth2/authorize` (auth code), `POST /ns-api/oauth2/token/` (code exchange)

### Data Gaps
- The OpenAPI spec's `POST /authCode` endpoint uses the password-grant schema; the actual OAuth authorize endpoint (`/ns-api/oauth2/authorize`) is not documented in the spec but exists on NetSapiens instances. The builder must discover the correct authorize URL pattern from the NetSapiens platform documentation or instance.

## Success Criteria
- [ ] All 481 operations from the OpenAPI spec are exposed as MCP tools
- [ ] Each generated tool has correct parameter schemas matching the OpenAPI spec (path params, query params, request bodies)
- [ ] Each generated tool returns structured JSON responses consistent with the existing format (`success`, `message`, `data`, `error`)
- [ ] Tools are organized into logical modules by API tag/category (not a monolithic file)
- [ ] A code generator reads `netsapiens-api-v2.json` at build time and produces TypeScript tool definitions
- [ ] Tool names follow a consistent convention derived from operationId or path+method
- [ ] OAuth Authorization Code flow is supported: user authenticates via browser redirect, no username/password in env vars required
- [ ] OAuth flow starts a temporary local callback server, opens browser to NetSapiens authorize endpoint, exchanges auth code for tokens
- [ ] Token refresh continues to work automatically (existing behavior preserved)
- [ ] Multiple auth methods supported: Authorization Code flow (primary), password grant (legacy), API token (fallback)
- [ ] The MCP server starts successfully and lists all tools via `ListToolsRequestSchema`
- [ ] `npm run build` compiles without errors

## Context
- Current codebase: monolithic `index.ts` (1,195 lines) with 23 hand-written read-only tools, `netsapiens-client.ts` (607 lines) with 24 hand-written API methods, `oauth-manager.ts` (201 lines) with password grant flow
- The OpenAPI spec is available at `https://docs.ns-api.com/v45.0/openapi/netsapiens-api-v2.json` and should be vendored into the repo for build-time code generation
- The existing OAuth implementation uses Resource Owner Password Credentials grant (client_id + client_secret + username + password)
- The `spectrumvoip/netsapiens-openapi-php` project on GitHub confirms the spec can be used for code generation
- NetSapiens API version: v45.0
