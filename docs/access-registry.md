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

Any string is a valid reason, including the empty string and a string longer than 200 characters. The client keeps the first 64 characters of a reason, replaces each character outside printable ASCII with `?`, and reports the empty string as `unspecified`. Both of these deny decisions are valid:

```json
{
  "version": 1,
  "decision": "deny",
  "reason": "",
  "revision": "0",
  "ttlSeconds": 60
}
```

```json
{
  "version": 1,
  "decision": "deny",
  "reason": "An example reason that runs well past the 200 characters an earlier parser allowed, and past the 64 characters the client keeps. The decision is still a deny, and the client shortens the reason before any log or error message uses it.",
  "revision": "0",
  "ttlSeconds": 60
}
```

### Members

| Member | Rule |
|---|---|
| `version` | Must be the number 1. |
| `decision` | `allow` or `deny`. |
| `revision` | 1 to 128 characters from `A-Z a-z 0-9 . _ : -`. The client compares it with `If-None-Match`. |
| `ttlSeconds` | An integer of at least 1. The client clamps it to 5 to 300 seconds. |
| `reason` | Deny only. Any string, including an empty one. The client keeps a sanitized copy, as described under Decision response. |
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

## Parsing entry points

The package exports three functions from its entry point. Each takes one kind of input:

| Function | Takes | Use it when |
|---|---|---|
| `parseRegistryDecisionText(text)` | The response body as text | The body is read as text. The text is parsed exactly once. |
| `parseRegistryDecisionValue(value)` | A value already parsed, such as the result of `res.json()` | An embedder already holds a parsed value. A string is refused, because a string may be JSON text that was encoded twice. |
| `parseRegistryDecision(input)` | Either | Compatibility only. A string is read as text and any other value as a parsed value. Do not use it in new code. |

Embedders that return `res.json()` MUST use `parseRegistryDecisionValue`. Clients that read the body as text MUST use `parseRegistryDecisionText`. A body encoded twice parses to a JSON string, which is a contract error on either path.

## Status handling

| Outcome | Client treatment |
|---|---|
| `200`, valid body | Authoritative: allow or deny. |
| `304` when `If-None-Match` matches | The cached entry is still current. |
| Any other status, including `404` | Registry error. Never "not enrolled". |
| Network error, or no answer within the timeout (default 3000 ms) | Registry error. |
| Body is not JSON | Registry error, class `invalid_json`. |
| Body parses to a JSON string, which a body encoded twice does | Registry error, class `contract`. |
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
- `invalid-double-encoded.json`: a JSON string holding decision JSON. That is what a body encoded twice parses to, so it is refused on both parsing paths.

## Platforms and redirect URIs

A redirect URI is permitted when it matches one platform entry under these rules. The rules apply to every entry:

- The URI has no userinfo, no fragment, and no whitespace, control character or backslash.
- `loopback` permits `http` or `https` on the hosts `localhost`, `127.0.0.1`, `[::1]` or `::1`, on any port and any path.
- An https entry permits an `https` URI with the same host and port, and the same path once trailing slashes are removed from both. A query on the redirect URI is ignored.
- `*` permits any valid URI.

A platform entry that is not one of the three forms makes the response a contract error, which the client handles as any other registry error.

## Identity

The client builds the identity the registry keys on from the sign-in:

- **Tenant.** The home domain. Leading and trailing ASCII space (0x20) and tab are trimmed, and nothing else is. What remains must be printable ASCII (0x21 to 0x7E) with no `@` and no blank inside it. Uppercase ASCII letters are then lowercased.
- **User.** The NetSapiens user name, with the same rules and no domain.
- **Subject.** `user@tenant`.
- **Platform.** The origin of the NetSapiens API URL: scheme, host and port, with the host lowercased and default ports removed.

A name that breaks these rules is refused, never normalized. Non-ASCII letters, no break and ideographic spaces, the byte order mark, zero width characters, line and paragraph separators and control characters all fail. Two raw names therefore never share a registry key. A name that is empty after trimming is refused too. A conforming registry applies the same rule to the names it stores and compares.

Mixed-case ASCII input and lowercase input produce the same identity, so a sign-in string and a portal URL that differ only in ASCII case address the same registry entry.

## Effective policy

For each request, the client decides in this order and reports the first refusal:

1. A tool name matches a deny entry, either by its canonical name or its exposed name, or by a group it belongs to: refused, `denied`.
2. No allow entry matches the tool: refused, `not_allowed`.
3. `access` is `read` and the tool is in `@write`: refused, `read_only`.
4. The tool is in `@content:<kind>` and `content.<kind>` is `deny`: refused, `content:<kind>`.
5. `unclassifiedOutput` is `deny` and the tool is in `@unclassified`: refused, `unclassified`.
6. Otherwise the tool is allowed.

The decision runs on every dispatch, including calls that reach a tool through another tool, through a search, or through a promotion.

**Names and patterns.** A tool name longer than 256 characters is refused as `not_allowed` before any pattern is tried, under every policy, the unset one included. No tool the package ships has a name that long, so the limit refuses no real tool. Patterns match the whole name. `*` matches any run of characters, including none and line breaks. Every other character matches only itself. Matching takes time linear in the name, so a pattern cannot stall a call.

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
- **Freshness.** An answer's age is the larger of two measures of the time since its request was sent: the monotonic clock, which never runs backwards, and the wall clock, where a step backwards counts as zero. An answer is fresh while its age is below the clamped `ttlSeconds`. So a backwards clock step cannot extend freshness, while a forward jump, or a machine that slept while the monotonic clock stood still, ages an answer sooner, and it is revalidated sooner. An answer that was sent after the monotonic clock's current reading has no known age: it is stale and is never last known good.
- **Revalidation.** A stale entry triggers one revalidation per key at a time, sent with `If-None-Match`. A `200` replaces the entry. A `304` marks the entry validated now.
- **Last known good.** When revalidation fails, the cached decision is used while its age, measured as for freshness, is below `MAX_STALE`. The default `MAX_STALE` is 600 seconds. The deployment sets it between 0 and 3600 seconds, and the registry cannot change it.
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

## Sign-in and sessions

With the registry configured, a person signs in only when the registry allows their subject on their domain and the AI app's redirect URI is approved. Every check fails closed.

- **Identity.** The NetSapiens user and domain are verified before the registry is asked. Token sign-in carries the user record that NetSapiens returned for the token. Password sign-in reads that record strictly. An API key has no user record, so it is refused, and so is a record that names no user or no domain.
- **Decision.** `allow` issues a code only when the policy approves the redirect URI. `deny` refuses. An unavailable registry answers `503`. A refused sign-in stores no authorization code.
- **Resume.** A sign-in that pauses on an interstitial is decided again when its resume token is redeemed.
- **Session.** The verified domain, user, role and redirect URI are stored with the session, and a hook cannot set them. A session without them, such as one created before the registry was configured, must sign in again. The stored identity must name the account the session runs as, after the normalization sign-in applies, so case does not matter. A session whose identity names another account must sign in again.
- **Each request and refresh.** A bearer token is checked against the current decision. A denied tenant, an unapproved redirect or a missing identity answers `401`. A refresh that finds the same answers `invalid_grant` and revokes the session family. An unavailable registry lets existing sessions continue.

Each sign-in and refused session writes an `Access sign-in` or `Access session` log line with its outcome and reason. An unavailable decision also logs its `cause`: `timeout` or `network` when the registry could not be reached in time or at all, `outage` when no cause was reported, `http_status`, `auth`, `contract` or `critical` when its answer is refused, and `policy_invalid` when the policy cannot be applied. A plain outage logs the reason `registry_unavailable`. The other causes log `registry_error`, or `policy_invalid` for a policy. No log line carries a token, an argument value or a registry body.

## Environment

The variables, their defaults and their limits are listed in the configuration reference, which is generated from the code. Three rules matter here.

- Setting `MCP_ACCESS_REGISTRY_URL` turns the registry on. Every other registry variable is then validated, and a malformed value stops the server with a `ConfigError`.
- The registry needs the HTTP transport. With the URL set, `MCP_TRANSPORT=stdio` exits with a `ConfigError`, because stdio could not enforce the registry and would fail open.
- `/health` reports `"accessRegistry": "enforced"` only while the registry is on. Unset, the field is absent.

## Enforcement

With the registry on, the decision is applied at each point where access is decided.

- **Sign-in.** A person signs in only when the registry allows their subject on their domain and the redirect URI is approved. A refusal shows a page and issues no code. An unavailable registry shows a 503 page.
- **Each bearer request.** The current decision is checked. A refusal answers 401. An unavailable registry lets an existing session continue.
- **Refresh.** A refused session revokes its family and answers `invalid_grant`.
- **Tool listing.** A tool the decision does not allow is absent from `tools/list` and hidden from `search_api`. With the registry unavailable, the list is empty.
- **Tool calls.** A tool the decision does not allow is refused when it is named directly, when `call_api` names it, and when a generated tool is called in full mode. A refused call sends nothing to NetSapiens.
- **NetSapiens requests.** Every request the connector sends passes an operation check before it leaves. The check refuses an operation the decision denies, whichever tool asked for it. Redirects are not followed, and a 3xx answer is an error.
- **Results.** Fields of each content kind the decision denies or strips are removed from the result, and `_withheld` counts them by kind. Fields classified as internal are removed. With `unclassifiedOutput: deny`, a field that no declaration names is removed too.
- **Explicit foreign targets.** A request that names another domain in a `domain` path or query parameter is also judged by that domain's own decision. A denied decision refuses the request. An allowed decision applies its denials to that request. A domain that is not enrolled adds nothing, and the caller's own decision still applies.

## Profiles and what a content denial covers

A profile is the decision for one subject on one domain. A content denial is only as complete as the connector's classification, and it covers reads more fully than writes.

- **Reads.** A profile that denies a content kind refuses the tools and NetSapiens operations that read or transmit that kind, and removes the classified content fields from other results, such as call history.
- **Writes that route content.** With write access, an administrator can create destinations that carry content elsewhere: forwarding, schedules, storage, push registrations, SMTP relays, queue agents and carrier URLs. The connector classifies the destinations it knows and refuses them under a denied kind. No list of destinations can be complete, so a content denial alone does not close this class.
- **Recommended for regulated data.** A profile that denies any content kind should also set `access: read`. This is the recommended configuration for regulated data, and `access: read` is the control that closes the write class above.
- **Not content operations.** Two things sit outside the content classes, so a content denial does not cover them. Live-audio routing is one: transferring or answering a live call to another party, forwarding rules, dialing a number into a conference, and call and queue routing. Capture enablement is the other: switching recording, transcription or sentiment on. Only `access: read` or tool selection controls them.
- **Unclassified output.** Fields the connector has not classified are not guaranteed removed. `unclassifiedOutput: deny` is the control for that. It refuses a generated tool with no output mapping and removes every field that no declaration names, so a declaration that omits a metadata field loses that field under this setting too. Check the fields a profile needs before denying unclassified output.

A profile for regulated data usually allows the curated group only, denies every content kind, sets `access: read`, and sets `unclassifiedOutput: deny`. The groups a profile can name are listed under Effective policy.

## What a deployment may claim

For a profile set up as described above, and only for the accounts and domains the registry enrolls:

- Only listed accounts in an enrolled domain can sign in, and only from approved AI apps.
- The connector does not offer or run tools that list, read, play, download or forward call recordings, transcripts, voicemail, message text or AI call summaries, when the profile denies those kinds.
- The connector refuses the underlying NetSapiens requests for those kinds, whichever tool asks: a direct call, `call_api`, a generated tool, a v1 call or a redirect.
- Classified recording links and transcript, summary and message fields are removed from other results, such as call history.
- Changes and revocations take effect within the cache lifetime, which the registry sets (`ttlSeconds`, clamped to 5 to 300 seconds). A registry outage closes new access once the last-known-good window has passed, which is 600 seconds by default. Existing sessions keep working through an outage.

## What a deployment must not claim

- **No HIPAA compliance, de-identification, or PHI or PII redaction or masking.** The connector does none of these. Free text is not masked: notes, names, caller ID text, contact notes, session names and SIP traces pass through.
- **Not that no sensitive data reaches the AI.** Numbers, names, times, durations, queue and contact data still reach the AI, and so does anything the AI can infer from metadata.
- **Not that content is removed wherever it appears.** Fields the connector has not classified are not guaranteed removed. Destinations created with write access are covered only where the connector classifies them.
- **Not that other paths are covered.** The NetSapiens portal, direct API use, other hosts and other connectors are outside this connector.
- **Not that breadth queries are covered.** A request that names no target domain follows the caller's own decision, so a query that spans many domains is judged by that decision alone.
- **Not that the AI platform's data terms are the connector's.** Any data agreement with the AI platform belongs to the customer.

## Versioning

This is version 1. A change that adds a restriction must either ship as a new version or name the restriction in `critical`, so an older client fails closed on it. A change that adds a member which does not restrict access may ship within version 1.
