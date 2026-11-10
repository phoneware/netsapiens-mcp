# Tools

The tool catalog, API discovery, and how per-user promotion works. Back to the [README](../README.md).

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

## API discovery: how the model reaches the long tail

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

## Recommended disable patterns

For operational (non-security) trimming per deployment, `MCP_DISABLED_TOOLS` still applies on top. Common choice:

```
delete_*,remove_*
```

- `delete_*`, `remove_*` — destructive operations you may not want an AI performing

## v1 vs v2

`v1_*` names are RPC-style (`?object=X&action=Y`) v2 names are REST. Many v2 endpoints have a v1 counterpart. If the v2 coverage is sufficient for your deployment, hide all of v1 with `MCP_DISABLED_TOOLS=...,v1_*`.

## Per-user tool promotion

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
