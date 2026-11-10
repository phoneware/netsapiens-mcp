# Hosting and configuration

Run the server over HTTP, deploy it to Cloud Run, and tune it per deployment. Back to the [README](../README.md).

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

## Customizing the login page

Set `MCP_LOGIN_HEADER` for the heading text and `MCP_ICON_URL` for the logo:

```bash
gcloud run services update netsapiens-mcp \
  --update-env-vars="MCP_LOGIN_HEADER=Login to Acme,MCP_ICON_URL=https://your-cdn/logo.png"
```

The same icon is served at `/favicon.ico` and `/favicon.png` so AI clients pick it up for their connector list. The favicon route fetches and caches the image bytes — it doesn't redirect, because some MCP clients won't follow redirects for favicons.

## Bearer token lifetime

The MCP bearer we issue to the AI client carries `expires_in: 604800` (7 days) by default. Refresh tokens are issued alongside, so well-behaved MCP clients can transparently mint a new bearer when this one expires by POSTing `grant_type=refresh_token` to `/token`.

Why 7 days instead of the more typical 1 hour? Some MCP clients (Claude's web UI and ChatGPT's connector among them) have had bugs that prevent automatic refresh on a 401 — when that happens the user sees a "session expired, reconnect" prompt in the middle of a working conversation. A 7-day bearer means the cliff is hit far less often. Refresh still works for the cases it does fire on, but most sessions never reach that path.

Tunable per deployment via `MCP_TOKEN_LIFETIME_HOURS` (default `168`, min 1, max 2160 = 90 days). NetSapiens upstream tokens are refreshed silently inside `verifyAccessToken` regardless, and the refreshed token is pushed into the live MCP session's API client on every request — NS rotates (and invalidates) the old token on refresh, so a session that kept its original token would 401 on every NS call for the rest of its life. Concurrent requests share a single in-flight refresh per bearer for the same reason.

Logs help debugging:

- `MCP bearer expired — client should refresh` — fires whenever a request comes in with an expired bearer. If this fires AND a fresh `/token` POST does not follow shortly after, the AI client isn't refreshing.
- `MCP bearer refreshed via refresh_token` — fires on every successful refresh, so you can confirm clients are using the refresh-token path.
- `Refresh token presented but unknown — user will be asked to reconnect` — fires if a stored refresh token can't be found (e.g. an old client cached one from before a token-store wipe).

## Health and observability

- `GET /health` — uptime, active sessions, NS API URL, version.
- Structured JSON logs to stderr (use `LOG_LEVEL=debug` for verbose).
- Each MCP request logs through Cloud Run's standard `httpRequest` schema; auth events log to `jsonPayload.message`.
