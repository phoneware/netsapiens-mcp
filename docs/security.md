# Security model

What the model can and cannot reach, and how destructive actions are gated. Back to the [README](../README.md).

## Infra/security endpoints are stripped at generation

Auth and credential endpoints are **excluded at generation time** — they never enter the registry — because exposing them as AI tools is a security risk (the server handles auth itself; these would let the model mint/read/revoke tokens, keys, certs, or service-account creds). The generators drop:

- **v2 tags**: `Authentication/Access Token (Oauth)`, `Authentication/API Key`, `Authentication/JWT`, `Firebase`, `SSL Certificates`, plus the `/email/verify/{token}` flow.
- **v1 objects**: `sfu` (mints media-server access tokens); `oauth2/token` endpoints are inherently skipped (no `object=` param).

This removes 27 v2 + 1 v1 operations (755 → 727). To change the exclusion list, edit `EXCLUDED_TAGS`/`EXCLUDED_PATH_RE` in `scripts/generate-tools.ts` and `EXCLUDED_OBJECTS` in `scripts/generate-v1-tools.ts`, then `npm run generate`.

## Role-tier filtering

NetSapiens authorization is scope-tier (Super User > Reseller > Office Manager > Basic User) plus domain/territory ownership, enforced server-side with a 403 — there is no per-endpoint capability introspection endpoint to query up front. The user's scope is the only access signal available at connection time, and we read it at login.

On top of NS's own enforcement, the server hides clearly-privileged resource families from lower tiers as a UX nicety so the AI doesn't see tools it can't use:

- **system_admin only**: certificates, templates, images, routes, connections, firebase, backup/restore, access/audit logs, system configuration, system-wide dial policy, SFU, insight.
- **reseller minimum**: reseller management, domain create/delete/billing.
- **everything else**: visible to all authenticated users; NS enforces ownership.

The map is intentionally small and conservative — only families we're confident require a tier are gated, so a tool a user could legitimately call is never hidden. NS remains the real gatekeeper for the long tail. Disable the behavior entirely with `MCP_DISABLE_ROLE_FILTER=true` (then everything is visible and NS does all enforcement via 403).

## Destructive-action confirmation (elicitation gate)

Set `MCP_CONFIRM_DESTRUCTIVE=true` to make the server pause before any destructive tool runs and ask the user to confirm in-band, using the MCP `elicitation/create` capability. The user sees a "Confirm `end_call` on `call_id=XYZ`? Yes/No" prompt directly in their AI client; only on accept does the call execute. Decline or cancel and the model gets a clear "user declined" error to relay back.

`MCP_DISABLE_DESTRUCTIVE` wins over confirmation: if a tool is disabled outright, we don't waste the user's time prompting for a call we'd reject.

**Client capability:** The MCP spec requires the client to advertise `capabilities.elicitation`. Claude supports it; ChatGPT support is uncertain and should be verified per-deployment. If the connected client doesn't support elicitation, fail-closed is the default (the destructive call is refused with a clear error). Set `MCP_CONFIRM_FALLBACK=allow` to instead bypass the confirmation on incapable clients (operator opt-in only — defeats the purpose for those sessions).
