# Access registry: wire contract v1

An access registry tells netsapiens-mcp which NetSapiens tenants, users, AI platforms and tools a deployment may expose. The registry is optional. When none is configured, the connector behaves exactly as it did before, and nothing in this document applies.

This document is the contract. Any service that answers the request below with the response shape described here can serve as the registry. The contract is vendor-neutral: it names no operator, customer or AI product.

## Principles

- **Narrow only.** The deployment's own guardrails run first and are the ceiling. The registry can remove capabilities. It cannot restore one the deployment disabled.
- **Closed by default inside an enrolled tenant.** A tool is allowed only when an allow entry matches it. Use `["*"]` to allow every tool.
- **Deny beats allow.** A deny entry that matches a tool removes it, whatever allow entries also match.
- **Fail closed.** Anything the client cannot read as an authoritative decision is a registry error, and a registry error is never read as "not enrolled".

## Request

```
GET {registry}/v1/decision
    ?connector=netsapiens-mcp
    &platform=https%3A%2F%2Fpbx.example.com
    &tenant=examplepractice
    &subject=1001%40examplepractice
    &role=Office%20Manager
    &tier=domain_admin
Authorization: Bearer <credential>
Accept: application/json
If-None-Match: "<revision>"
```

`If-None-Match` is optional.

| Parameter | Value |
|---|---|
| `connector` | Connector identifier. `netsapiens-mcp` by default; the deployment can set another. |
| `platform` | The NetSapiens API origin, normalized as described under Identity. |
| `tenant` | The domain being evaluated, lowercased. |
| `subject` | The signed-in account as `user@home-domain`, lowercased. |
| `role` | The NetSapiens user-scope string as NetSapiens returned it, or the empty string when unknown. |
| `tier` | `system_admin`, `reseller`, `domain_admin` or `user`. |

When `tenant` equals the home domain of `subject`, the registry evaluates the account's own domain. When they differ, the request names a foreign target. The client sends a foreign-target request only where the deployment's policy allows foreign targets.

## Decision response

A registry answers `200` with a JSON body for every authoritative decision, allow and deny alike. An allow carries a policy:

```json
{
  "version": 1,
  "decision": "allow",
  "revision": "9f2c1e7a40b3d6e1",
  "ttlSeconds": 60,
  "policy": {
    "tools": { "allow": ["@curated"], "deny": ["@destructive"] },
    "access": "read",
    "content": {
      "call_recording": "deny",
      "transcript": "deny",
      "voicemail": "deny",
      "sms_text": "deny",
      "ai_summary": "deny",
      "fax_page": "deny"
    },
    "unclassifiedOutput": "deny",
    "platforms": ["https://ai.example.com/oauth/callback"]
  }
}
```

A deny carries a reason:

```json
{
  "version": 1,
  "decision": "deny",
  "reason": "tenant_not_enrolled",
  "revision": "0",
  "ttlSeconds": 60
}
```

Deny reasons in use are `tenant_not_enrolled`, `tenant_disabled`, `subject_not_enabled`, `platform_not_enrolled`, `foreign_access_denied` and `connector_not_enabled`. A reason the client does not know is still a deny:

```json
{
  "version": 1,
  "decision": "deny",
  "reason": "registry_maintenance",
  "revision": "maint-2026-11-23",
  "ttlSeconds": 30
}
```

### Members

| Member | Rule |
|---|---|
| `version` | Must be the number 1. |
| `decision` | `allow` or `deny`. |
| `revision` | 1 to 128 characters from `A-Z a-z 0-9 . _ : -`. The client compares it with `If-None-Match`. |
| `ttlSeconds` | An integer of at least 1. The client clamps it to 5 to 300 seconds. |
| `reason` | Deny only. A non-empty string of at most 200 characters. |
| `policy` | Allow only. Required. See Policy below. |
| `critical` | An array of member names. Any non-empty array makes the whole response a contract error. |
| Any other member | Ignored. |

A registry that adds a restriction this contract does not define must name it in `critical`. Ignoring an unknown member is safe only for members that do not restrict access. A client that does not understand a restriction would otherwise run without it.

### Policy

| Member | Rule |
|---|---|
| `tools.allow`, `tools.deny` | Arrays of at most 512 entries. Each entry is a non-blank string of at most 200 characters: a name pattern where `*` matches any run of characters, or a group beginning with `@`. |
| `access` | `read` or `write`. |
| `content` | An object with all six kinds: `call_recording`, `transcript`, `voicemail`, `sms_text`, `ai_summary` and `fax_page`. Each is `deny`, `strip` or `allow`. A missing kind is a contract error. |
| `unclassifiedOutput` | `deny` or `allow`. |
| `platforms` | An array of at most 512 entries, each an https URI without userinfo, fragment or query; the word `loopback`; or `*`. See Platforms and redirect URIs. |

## Status handling

| Outcome | Client treatment |
|---|---|
| `200`, valid body | Authoritative: allow or deny. |
| `304` when `If-None-Match` matches | The cached entry is still current. |
| Any other status, including `404` | Registry error. Never "not enrolled". |
| Network error, or no answer within the timeout (default 3000 ms) | Registry error. |
| Body is not JSON | Registry error, class `invalid_json`. |
| Body over 64 KiB | Registry error, class `oversize`. |
| Contract violation | Registry error, class `contract`. |
| Non-empty `critical` | Registry error, class `critical`. |
| A deny names an unknown group, or the policy is otherwise not enforceable | Policy error. The result is `unavailable`. |

The fixtures in `src/__tests__/fixtures/access/` show each class. A valid decision is `allow.json` or `deny.json`. The invalid examples are:

- `invalid-critical.json`: names a restriction the client does not understand.
- `invalid-missing-decision.json`: has no decision.
- `invalid-missing-content-kind.json`: omits the `fax_page` content kind.
- `invalid-bad-access.json`: uses an access mode that is neither `read` nor `write`.
- `invalid-bad-revision.json`: uses a revision with a space and a slash.
- `invalid-bad-ttl.json`: uses a ttl of zero.
- `invalid-version.json`: uses version 2.
- `invalid-http-platform.json`: lists a non-loopback platform over http.

## Platforms and redirect URIs

A redirect URI is permitted when it matches one platform entry under these rules. The rules apply to every entry:

- The URI has no userinfo, no fragment, and no whitespace, control character or backslash.
- `loopback` permits `http` or `https` on the hosts `localhost`, `127.0.0.1`, `[::1]` or `::1`, on any port and any path.
- An https entry permits an `https` URI with the same host and port, and the same path once trailing slashes are removed from both. A query on the redirect URI is ignored.
- `*` permits any valid URI.

A platform entry that is not one of the three forms makes the response a contract error, which the client handles as any other registry error.

## Identity

The client builds the identity the registry keys on from the sign-in:

- **Tenant.** The home domain, trimmed and lowercased. It must not be empty and must not contain whitespace, `@` or a control character.
- **User.** The NetSapiens user name, trimmed and lowercased, without the domain. The same rules apply.
- **Subject.** `user@tenant`.
- **Platform.** The origin of the NetSapiens API URL: scheme, host and port, with the host lowercased and default ports removed.

Mixed-case input and lowercase input produce the same identity, so a sign-in string and a portal URL that differ only in case address the same registry entry.

## Effective policy

For each request, the client decides in this order and reports the first refusal:

1. A tool name matches a deny entry, either by its canonical name or its exposed name, or by a group it belongs to: refused, `denied`.
2. No allow entry matches the tool: refused, `not_allowed`.
3. `access` is `read` and the tool is in `@write`: refused, `read_only`.
4. The tool is in `@content:<kind>` and `content.<kind>` is `deny`: refused, `content:<kind>`.
5. `unclassifiedOutput` is `deny` and the tool is in `@unclassified`: refused, `unclassified`.
6. Otherwise the tool is allowed.

The decision runs on every dispatch, including calls that reach a tool through another tool, through a search, or through a promotion.

Operations are checked before a request leaves the client. An operation is refused when:

- its content kind is denied, or it is unreviewed and any kind is denied;
- the access mode is `read` and the request is not a GET, or the NetSapiens action is not a read action;
- `@destructive` is denied, or the mode is `read`, and the request is a DELETE.

### Groups

| Group | Members |
|---|---|
| `@curated` | The curated tool catalog, including workflow tools. |
| `@meta` | The search and call meta-tools. |
| `@generated` | Every generated tool. |
| `@read` | Tools that are read-only. |
| `@write` | Tools that change state. |
| `@destructive` | Tools that remove or irreversibly change data. |
| `@unclassified` | Generated tools with no output mapping. |
| `@content:<kind>` | Tools whose operations return or transmit that kind of content. |

A group named in `tools.deny` must be one of these. Any other `@` entry in `tools.deny` makes the policy unavailable. An unknown `@` entry in `tools.allow` matches nothing and is logged.

### Output

A result is cleaned after the tool runs. Fields of every kind set to `deny` or `strip` are removed, and the result says how many were removed. When `unclassifiedOutput` is `deny`, a field that no declaration names is removed too. Secrets are removed in every case.

## Caching and fail-closed

- **Cache key.** `(connector, platform, tenant, subject, role, tier)`. The cache holds at most 10,000 entries per process and evicts the least recently used.
- **Freshness.** An entry is fresh while the current time is before its validation time plus the clamped `ttlSeconds`.
- **Revalidation.** A stale entry triggers one revalidation per key at a time, sent with `If-None-Match`. A `200` replaces the entry. A `304` marks the entry validated now.
- **Last known good.** When revalidation fails, the cached decision is used while the current time is before its validation time plus `MAX_STALE`. The default `MAX_STALE` is 600 seconds. The deployment sets it between 0 and 3600 seconds, and the registry cannot change it.
- **Unavailable.** With no cached entry, a registry error is unavailable at once. Past the last-known-good window, the result is unavailable.
- **Deny decisions** are cached and kept last known good in the same way as allows.

While a result is unavailable:

- the tool list is empty;
- tool calls are refused;
- a new sign-in receives a `503` page;
- bearer verification and refresh of existing sessions continue, so people already signed in stay signed in.

A change or revocation takes effect within the cache lifetime. A registry outage closes new access once the last-known-good window has passed.

## Auth modes

The client authenticates to the registry in one of three ways:

| Mode | Behavior |
|---|---|
| `bearer` | A static token supplied by the deployment. |
| `google-id-token` | An identity token from the instance metadata service, for the audience the deployment sets. The token is cached until 300 seconds before it expires. |
| `none` | Permitted for loopback registry URLs only. |

The registry authenticates each caller. It should also allowlist the service identities it accepts.

## Versioning

This is version 1. A change that adds a restriction must either ship as a new version or name the restriction in `critical`, so an older client fails closed on it. A change that adds a member which does not restrict access may ship within version 1.
