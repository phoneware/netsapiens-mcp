# What the NetSapiens controller source tells us about our tools

Findings from reading the NetSapiens v2 API implementation (the CakePHP controllers, dated 2025-12-07, in the Phoneware Team Drive under `Netsapiens Controller Files`). This is the server that answers every call our tools make, so where it disagrees with `spec/netsapiens-api-v2.json`, the controllers are right.

## What the files are

| File | What it is |
|---|---|
| `RestsController.php` | The v2 router. `__getObjectParams()` is one 1,350-line regex chain mapping every URL to an internal object + params. 128 canonical route templates. |
| `AppController.php` | Auth, scope, and the ACO permission model. `checkScope()` / `__getAcoAction()` decide what a token may do. |
| `<Object>Controller.php` (75) | Per-object handlers. Each decides which query params it honors and what it validates. |
| `Component/*Component.php` (44) | Call-center statistic definitions: metric code + the exact SQL aggregate. |
| `fields.csv` | Internal DB column → API field name map (Apikeys, reseller, Domains, Users). |

## Finding 1: our spec understates the API, and it costs us tokens

The vendored OpenAPI spec declares list-shaping params on almost nothing. The controllers honor them broadly:

| Param | Declared in our spec (of 214 GET ops) | Controllers that honor it |
|---|---|---|
| `fields` | 10 | 9 |
| `limit` | 21 | 30 |
| `start` | (paired with limit) | 31 |
| `sort` | 1 | 36 |
| `order` | 0 | 5 |

The nine controllers honoring `fields` are exactly the heavy ones: Subscribers, Devices, Cdrs, Callqueues, Conferences, Sites, Settings, Statistics, Charts. Those are the endpoints an MCP hits constantly and whose responses are largest.

Concretely, `find_user` in `src/tools/curated/catalog.ts` fetches `limit: 1000` full user records and filters client-side on five fields, because the spec gave it no better option. `fields=user,name-first-name,name-last-name,login-username,email` would cut that payload by roughly an order of magnitude for identical behavior.

**Implication:** enrich the spec (or the generator) with `fields`/`limit`/`start`/`sort`/`order` on the operations whose controller honors them, and thread `fields` through the curated composites. This is the single highest-leverage change available.

## Finding 2: `/count` and `/list` are universal, and we expose neither properly

`__getObjectParams()` strips a `/count` or `/list` suffix off **any** collection URL before it does any object matching (`RestsController.php:152-165`). So both are generic capabilities of the whole collection surface, not per-endpoint features.

- `/count` returns a total without the rows. Our spec has 46 count paths; the router accepts the suffix everywhere.
- `/list` returns a **reduced, allowlisted field set** (13 controllers implement `list_object`). `list_subscribers()` defaults `fields` to `Subscriber->allowedList` and rejects anything outside the allowlist with a 400.

`/list` is a built-in cheap-projection mode that we currently never call. Zero `/list` paths appear in our spec.

**Implication:** add a `count` / `list` mode to list-shaped tools, or a `mode: full|list|count` argument. "How many users are in this domain" should cost one small response, not 1,000 records.

## Finding 3: the controllers carry 1,743 parameter docs the spec doesn't have

Our spec: 481 operations, all with a summary, but only **127 (26%) with a non-empty description**, median 135 characters, and parameter descriptions almost entirely empty.

The controllers carry apidoc annotations: **286 `@api` blocks, 1,743 `@apiParam`**, with optionality marked (`[device]` = optional), plus `@apiSuccess` field docs. Example:

```php
/**
 * @api {post} ?object=agent&action=count Count Agents in a Callqueue
 * @apiParam {String} domain    Name of domain containing the Agent(s) to count.
 * @apiParam {String} queue     Name of Callqueue containing the Agents(s) to count.
 * @apiParam {String} [device]  Filters Agents to count by their Device.
 * @apiSuccess {String} total   Number of Agents in the specified Callqueue.
 * @apiPermission Reseller
 */
```

**Implication:** parse the apidoc blocks and merge them into the spec at generation time. Tool and parameter descriptions are what the model uses to pick and fill a tool; ours are mostly blank.

## Finding 4: `@apiPermission` is the authoritative scope map we're currently guessing at

`src/tools/index.ts` infers required scope from regexes over tool names (`TIER_RULES`), with a comment admitting it is "intentionally small and conservative." The controllers state it outright: **269 `@apiPermission` annotations** — Reseller (143), User (46), OMP/Office Manager (58), Super User (19), Site (1).

The runtime model is in `AppController.__getAcoAction()`, which maps the request to one of `create` / `read` / `update` / `delete` / `list`, and **defaults unknown actions to `create`, the highest-privilege bucket**. Also worth knowing: an API key can be marked `readonly`, in which case NS rejects anything that isn't `read` / `list` / `count` with a 403 (`AppController.php:3356`).

**Implication:** replace the regex tier rules with the annotated permission per operation, and mirror the `readonly` concept as a server-level read-only mode.

## Finding 5: there is a whole analytics surface we don't expose

Three routes exist in the router and in **none** of our spec:

```
/v2/domains/{domain}/statistics/{stattype}
/v2/domains/{domain}/statistics/{stattype}/{statpivot}
/v2/domains/{domain}/statistics/{stattype}/{statpivot}/{statgroup}
```

`Component/*Component.php` is the metric vocabulary, each file declaring a code and its SQL:

| Code | Meaning (from the SQL) |
|---|---|
| `AHT` | `AVG(op_duration+time_disp)` — average handle time |
| `ATT` | `AVG(op_time_talking)` — average talk time |
| `AWT` / `AAS` | `AVG(queue_duration)` — average wait / speed of answer |
| `ACW` | `AVG(time_disp)` — after-call work |
| `SL` | count within the SLA threshold, excluding abandoned — service level |
| `CO`, `AC`, `CB`, `CH`, `DT`, `VM` | call counts by disposition |
| `TT` | `SUM(op_time_talking)` — total talk time |
| `AM`, `B`, `L`, `M`, `W`, `O`, `UM` | agent time in state (available, break, lunch, meeting, web, other, unavailable), minutes |
| `SMS_VOL`, `SMS_AHT` | SMS volume and handle time |

Required params are `start_date` / `end_date` in `YYYY-MM-DD HH:MM:SS` (a bare date is widened to `00:00:00` / `23:59:59`), and the error text for a missing type is literally *"Please provide a type, maybe try 'queue' for starters."*

Another 27 router paths are absent from our spec, including `/domains/{domain}/cdrs/{callid}`, `/domains/{domain}/restore`, the meetings/attendee/instance subtree, and the video subscription endpoints.

**Implication:** a first-class `call_center_stats` tool with a documented metric enum, instead of leaving the model to guess at an endpoint it can't currently see.

## Finding 6: field naming is dual, and the map exists

`fields.csv` maps internal column names to API field names (`key_id` → `key-id`, `active_call` → `active-calls-total-current`). The API speaks hyphenated names; the controllers and any `fields=` value speak a mix. 1,086 lines across Apikeys, reseller, Domains, and Users.

**Implication:** ship this as reference data behind a lookup so `fields=` values and filter names are correct by construction rather than by trial and error.

## Finding 7: a single operation is often a chain, and one link is genuinely missing from our calls

The premise worth testing: an operation in OMP does several things, and a single MCP or direct API call does not account for all of them. The source answers this in three parts, and only the third is a problem on our side.

### Where the API already does the whole chain

`POST /v2/domains/{domain}/attendants` looks like one write. `AttendantsController::create()` performs roughly eight, across four object types (`AttendantsController.php:225-290`):

1. create a dialplan named `{domain}_{user}`
2. create a catch-all dialrule in it
3. create the subscriber (`srv_code=system-aa`)
4. create the forwarding answer rule
5. `setDialrule` for the `Prompt_100` tier
6. `setDialrule` for `AAMain` catch-all
7. `setDialrule` for `ToUserNotFound` catch-all
8. build the tier/prompt structure via `v2handleTier`

Deleting a user is the same story in reverse. `SubscribersController::delete()` cascades to cdrschedules, callqueue email reports, **every device the user owns**, voicemail nags, timeframes, addresses, contacts, the video host, message sessions (config-gated), and MFA enrollment before it removes the subscriber row.

So for these, one call is the whole operation. We are not skipping steps.

### Where the chain has a real gap, for everyone

`delete_subscriber` contains **zero** references to `dialrule`, `phonenumber`, or queue agent membership. Delete a user who has a DID pointed at them and the dialrule survives, now routing to a destination that no longer exists. Same for their agent rows in a call queue. That gap is in the platform, not in our client, so OMP has it too, but it means "delete user" is not a complete teardown and a tool that presents it as one is misleading.

Creating is not symmetric with deleting either: `SubscribersController::create()` has no device creation in it at all. "Add a user" is at minimum create subscriber → create device → (optionally) assign a DID via a dialrule → (optionally) answer rules. Our surface exposes each as an unrelated primitive with nothing signposting the sequence.

### Where we are actually missing a step: `synchronous`

**42 write operations (31 POST, 11 PUT) accept a `synchronous` body parameter. It defaults to `no`. Nothing in this repo ever sets it.**

The spec states the semantics plainly:

> When synchronous is requested with "yes" the response will be a 200 on success and will contain a valid JSON representation of the new resource. If no or left off request a 202 "Accepted" will be given [...] Synchronous responses will be a little slower as the API will process the geo replication request and wait till the local copy has been written and can be read back before sending a response.

The controllers implement exactly that: twelve handlers carry a poll loop that re-reads the object up to 20 times at 100ms intervals and returns the real record once it appears (for example `DevicesController.php:1895`). Without the flag they return a configurable success code (`NsHttpStatusCodeSuccessCreate`) and an empty body, before the write is guaranteed readable.

The strongest evidence that this matters is that NetSapiens' own code sets it when chaining. `AttendantsController.php:256` sets `$sub_create['synchronous'] = "yes"` precisely because the next six steps read that subscriber back. The router hard-sets it for message sends (`RestsController.php:980`).

Any MCP flow shaped like "create it, then read it back to confirm or to get its ID" is racing geo replication today. The model sees an empty 202, re-reads, finds nothing, and concludes the write failed.

**Implication:** set `synchronous=yes` on curated write composites and on any generated write whose schema accepts it, at least wherever a read-back follows. It costs latency by design; that is the trade NetSapiens documented. Where a chain has a platform-side gap (DIDs and queue membership on user delete), say so in the tool description rather than letting the model assume the teardown was complete.

## Suggested order

0. **Set `synchronous=yes` on writes that get read back** (Finding 7). This is the only item here fixing a live correctness bug rather than an efficiency or discoverability one.
1. **Spec enrichment at generation time** — add `fields`/`limit`/`start`/`sort`/`order` per controller support, merge in the apidoc descriptions and `@apiPermission`. One generator change, improves every tool at once.
2. **`fields` in the curated composites** — start with `find_user`, `find_device`, `recent_calls`; the biggest payloads for the least work.
3. **`count` / `list` modes** on list-shaped tools.
4. **`call_center_stats`** over the statistics routes, with the metric enum above.
5. **Permission map** from `@apiPermission`, replacing `TIER_RULES`.
6. **A read-only server mode**, mirroring the NS `readonly` API key semantics.

## Reproducing this

The findings above came from these, run inside the controller directory:

```bash
# Route templates the router actually serves
grep -oE 'logRequest\("[^"]+"' RestsController.php | sed 's/logRequest("//;s/"//' | sort -u

# Which controllers honor each list-shaping param
for p in fields limit start sort order; do
  echo "$p: $(grep -lE "\\\$form\['$p'\]" *.php | wc -l)"
done

# The statistics metric catalog
for f in Component/*Component.php; do
  grep -m1 -oE '\$id *= *"[^"]+"' "$f"
  grep -m1 -oE "\\\$logic *= *'[^']+'" "$f"
done

# Per-endpoint required scope
grep -h '@apiPermission' *.php | sed 's/.*@apiPermission *//' | sort | uniq -c | sort -rn

# Handlers that implement the synchronous read-back poll
grep -n "synchronous" *.php

# What a delete actually cascades to (and what it misses)
sed -n '4334,4494p' SubscribersController.php | grep -E "loadModel|nsDelete|__delete"
```
