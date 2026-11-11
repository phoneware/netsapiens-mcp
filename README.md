<p align="center">
  <img alt="NetSapiens MCP Server" src="https://github.com/phoneware/netsapiens-mcp/raw/main/docs/assets/mark.svg" width="160">
</p>

<h1 align="center">NetSapiens MCP Server</h1>

<p align="center">
  <b>Run your NetSapiens phone system from Claude, ChatGPT, or any MCP client.</b><br>
  Each person signs in as themselves, and their assistant gets tools for calls, voicemail, messages, queues, agents, and provisioning.
</p>

<p align="center">
  <a href="#-quickstart">Quickstart</a> &middot;
  <a href="#-connecting-mcp-clients">Connect a client</a> &middot;
  <a href="https://github.com/phoneware/netsapiens-mcp/blob/main/docs/reference.md">Reference</a> &middot;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://github.com/phoneware/netsapiens-mcp/releases"><img src="https://img.shields.io/badge/release-v3.0.0-blue.svg" alt="Release"></a>
  <a href="https://github.com/phoneware/netsapiens-mcp/actions/workflows/ci.yml"><img src="https://github.com/phoneware/netsapiens-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/MCP-compatible-0891b2.svg" alt="MCP compatible">
  <img src="https://img.shields.io/badge/node-%E2%89%A522.13-3c873a.svg" alt="Node 22.13 or later">
</p>

---

## 💬 Ask it things

| Say this | The assistant uses |
|---|---|
| "Why did the call from 602-555-0143 go to voicemail?" | `diagnose_call` |
| "How many calls did we take yesterday?" | `call_volume` |
| "Which queues have people waiting right now?" | `queue_health` |
| "Tell me everything about Dana Reyes." | `user_profile` |
| "Summarize my new voicemails." | `voicemail_inbox_summary` |
| "Forward my calls to my cell." | `schedule_forwarding` |
| "Move me from Support to Sales." | `switch_queue` |
| "Set up a new user with a desk phone and a number." | `provision_user` |

## ✨ Highlights

- 🔐 **Sign in as yourself.** In HTTP mode, users log in through an OAuth 2.1 browser flow. Passwords never reach the model.
- 🎚️ **Sees what your role allows.** Four role tiers, from user to system admin, decide which tools each person gets.
- 🧬 **Matches your host.** The server reads your NetSapiens release (44.3 through 46.0) and serves the tools documented for it.
- 🛠️ **More than 40 task-shaped tools.** Find a user, trace a call, check a queue, read a voicemail, provision a queue.
- 🔎 **The whole API.** More than 1,300 operations are available through `search_api` and `call_api`.
- 💾 **Stays signed in.** Sessions live in an encrypted SQLite store and survive restarts. Add Firestore to share them across instances.
- 🛡️ **Guardrails you control.** Read-only mode, destructive-action confirmation, per-tool disable patterns, and automated secret scrubbing.
- 📦 **Runs anywhere.** `npx` for a single user, Docker Compose for a team, or import it as a library.

## 🧭 How it works

<p align="center">
  <img alt="An AI client connects to the NetSapiens MCP Server, which calls the NetSapiens API as the signed-in user" src="https://github.com/phoneware/netsapiens-mcp/raw/main/docs/assets/how-it-works.svg" width="900">
</p>

The official server at `docs.ns-api.com/mcp` helps an assistant read the API documentation. This server lets the assistant work on your system as the signed-in user, with that user's permissions.

## 🚀 Quickstart

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

## 🔌 Connecting MCP Clients

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

## 📚 Documentation

| Guide | What's in it |
|---|---|
| [Reference](https://github.com/phoneware/netsapiens-mcp/blob/main/docs/reference.md) | Role tiers, supported versions, storage, security limits, every environment variable, library usage |
| [Contributing](CONTRIBUTING.md) | Development setup and how to submit version observations |
| [Security](SECURITY.md) | Reporting a vulnerability |

## 📄 License

MIT License. See [LICENSE](LICENSE).
