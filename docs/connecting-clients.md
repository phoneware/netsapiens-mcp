# Connecting AI clients

This page covers the hosted HTTP deployment of the NetSapiens MCP Server, where each person signs in as themselves. For each AI client that can connect a custom remote MCP server, it gives the steps as the vendor documents them, the OAuth redirect URI the client sends (the value to approve in an [access registry](access-registry.md)), and the limits the vendor states. The examples use the placeholder host `https://mcp.example.com`.

Vendors change these products often. Each section names the vendor page it came from, and [Sources](#sources) lists every page with the date it was read. Where a vendor does not document something, this page says so.

## What the server needs from a client

- **Endpoint.** `https://<your-host>/mcp`, using Streamable HTTP. Set `MCP_BASE_URL` to the public origin, for example `https://mcp.example.com`. The endpoint and the metadata URLs are built from it.
- **Discovery.** An unauthenticated request gets `401` with `WWW-Authenticate: Bearer resource_metadata="https://<your-host>/.well-known/oauth-protected-resource/mcp"`. Metadata is also served at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`.
- **OAuth.** Authorization code flow with PKCE (`S256`). The endpoints are `/authorize`, `/token`, `/register` for dynamic client registration (RFC 7591), and `/revoke`.
- **Client registration.** The server offers dynamic client registration. It does not advertise client ID metadata documents, so clients that prefer those fall back to registration, as Anthropic and OpenAI describe.
- **Scopes and refresh.** The server does not advertise `scopes_supported`. It issues refresh tokens.
- **Issuer identification.** The server does not return the RFC 9207 `iss` parameter. OpenAI uses its stable redirect URI only for servers that advertise and return `iss`. Other servers get a callback-ID redirect URI.
- **Sign-in.** The server shows its own sign-in page. In OAuth mode it has a Password tab and a "Sign in with a NetSapiens token" tab. Passwords never reach the model. The client receives only the tokens the server issues.
- **Token mode.** With `NETSAPIENS_AUTH_MODE=token`, the server needs no OAuth client. The sign-in page shows only the token form, password sign-in is refused, and each person pastes their own NetSapiens API key or token. When the client refreshes its session, the server checks that NetSapiens still accepts the key and ends the session if it does not.
- **Second factor.** If the operator sets `MCP_SECOND_FACTOR_POLICY`, the selected role tiers must complete an authenticator challenge or use a trusted provider sign-in that the operator has implemented. Pasted tokens are refused for those tiers.

## Redirect URIs to approve

Use this table to fill the `platforms` list of an [access registry](access-registry.md). Each value comes from the vendor page named in the last column.

| Client | Surface | Redirect URI to approve | Source |
|---|---|---|---|
| Claude | claude.ai on the web, Claude Desktop, Claude mobile, Cowork | `https://claude.ai/api/mcp/auth_callback` | Claude authentication |
| Claude | Claude Code | `http://localhost:<port>/callback`, on a port Claude Code picks at sign-in. Approve as `loopback`. | Claude Code MCP |
| Claude | Claude API MCP connector, Agent SDK | None from Anthropic. Your application runs the OAuth flow, so approve the redirect URI it uses, if you approve that application. | Claude API MCP connector, Agent SDK MCP |
| ChatGPT | Plugins, custom MCP server | `https://chatgpt.com/connector/oauth/{callback_id}`. OpenAI does not define `callback_id`, so approve the exact value the connection's management page shows. | OpenAI plugin authentication |
| ChatGPT | Responses API | None from OpenAI. Your application runs the OAuth flow. | OpenAI Responses API MCP guide |
| ChatGPT desktop app, Codex IDE extension | Add server, then Authenticate | Not documented | Codex MCP |
| OpenAI Codex CLI | `codex mcp login` | `http://127.0.0.1/callback/<callback_id>`, with the listening port inserted at sign-in. Approve as `loopback`. | Codex MCP |
| Gemini CLI | `/mcp auth` | `http://localhost:<random-port>/oauth/callback`. Set `redirectUri` to fix the port. Approve as `loopback`. | Gemini CLI MCP |
| VS Code (GitHub Copilot Chat) | Copilot sessions | `http://127.0.0.1:33418` and `https://vscode.dev/redirect`. VS Code does not say which one a sign-in uses. Approve as `loopback` and `https://vscode.dev/redirect`. | VS Code MCP extension guide |
| Microsoft 365 Copilot | Developer-built plugin | `https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect` | Microsoft 365 plugin OAuth |
| Microsoft Copilot Studio | MCP tool with OAuth 2.0 | The callback URL that Copilot Studio shows after Create, when it shows one. The documentation does not print its value. | Copilot Studio MCP |
| Gemini Enterprise | Custom MCP data store, set up by an administrator | `https://vertexaisearch.cloud.google.com/oauth-redirect` | Gemini Enterprise custom MCP |
| Google ADK | Your application | Set by your application. The ADK sample uses `http://localhost:8000/callback`. | ADK authentication |
| GitHub Copilot CLI | `/mcp auth` | Not documented | Copilot CLI reference |
| Visual Studio | Remote MCP servers with OAuth | Not documented | Visual Studio MCP servers |
| Gemini app | Custom app, personal accounts | Not documented | Gemini app help, Gemini developer OAuth |
| Gemini API and SDKs | Remote MCP tool | No OAuth flow documented. The tool takes static `headers`. | Gemini API function calling |

Notes on the table:

- `loopback` covers `http` or `https` on `localhost`, `127.0.0.1`, `[::1]` and `::1`, on any port and any path.
- An `https` entry matches the same host, port and path. Trailing slashes and any query string are ignored.
- This server compares a redirect URI exactly with the one the client registered. The exception is a loopback callback: a client that registered a loopback callback can also sign in from a different port on the same path and query.
- A value marked "not documented" cannot be approved from the vendor's documentation. Leave that client out of a restricted registry until its redirect URI is known.

## Access registry

When the operator sets `MCP_ACCESS_REGISTRY_URL`, a person can sign in only when the registry allows their account and domain and the client's redirect URI is approved. A refused sign-in shows a refusal page and issues no code. If the registry cannot answer, new sign-ins get a 503 page, the tool list is empty, and tool calls are refused. People already signed in keep their sessions.

Approve only the clients you support. A restricted deployment usually approves one. The full contract is in [access-registry.md](access-registry.md).

## Claude

### Claude on the web

Free, Pro, Max and Ultra accounts add their own connectors. The Free plan allows one custom connector. On Team and Enterprise plans, an Owner adds the connector for the organization, and each member then connects with their own account. On Enterprise plans, a member whose custom role includes managing the organization's libraries can add a connector too.

To add a connector as an individual:

1. Go to the Connectors directory. Select **Add**, then **Add custom connector**.
2. Enter a name for the connector and the server URL `https://mcp.example.com/mcp`. Select **Continue** if the dialog shows it.
3. Under **Choose authentication settings**, set **Authentication** to **Sign in now** and **OAuth client** to **Register automatically**. Leave **Request headers** empty.
4. Select **Add**. If the connector shows **Connect**, select it and sign in on the server's sign-in page.

Do not choose **Use Claude's published identity**. Anthropic documents that it requires a server that supports client ID metadata documents, and this server does not advertise that.

To add the connector for an organization:

1. An Owner goes to **Organization settings > Connectors**, selects **Add**, then **Custom**. If Claude asks for the connector type, the Owner chooses **Web**.
2. The Owner enters the name and URL, then completes the steps above.
3. Each member goes to [their connectors](https://claude.ai/customize/connectors/yours) and selects **Connect** to authenticate.

Anthropic documents that the connector dialog's layout varies by organization. If every setting appears on one screen, find the OAuth client and request headers under **Advanced**.

Requests to your server come from Anthropic's infrastructure at `160.79.104.0/21`. Anthropic documents that discovery, registration and token requests get 10 seconds to respond, and refresh requests get 30 seconds. Leave the transport at its default. Only a URL that ends in `/sse` selects the older SSE transport, and this server uses `/mcp`.

### Claude Desktop

The steps are the same as on the web. In the desktop app, select **Customize** in the sidebar, then **Connectors**. If the sidebar shows **Plugins** instead, select **Plugins**. The sign-in page opens in your browser.

For one person on one computer, Claude Desktop can also run the server locally over stdio. Anthropic's Claude Code documentation shows this structure for `claude_desktop_config.json`, with the server's own entry:

```json
{
  "mcpServers": {
    "netsapiens": {
      "type": "stdio",
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

The local server uses one NetSapiens token on that computer. The hosted server gives each person their own sign-in. The Anthropic pages read do not give the file's location.

### Claude mobile

Anthropic's getting-started page says a connected connector is available in conversations on the web, desktop and mobile. The pages read do not describe adding a remote connector from the mobile app.

### Claude Code

1. Add the server:

   ```sh
   claude mcp add --transport http netsapiens https://mcp.example.com/mcp
   ```

2. Sign in. Run `/mcp` in Claude Code and follow the steps in your browser, or run `claude mcp login netsapiens` in your shell.

Over SSH, `claude mcp login` prints the authorization URL instead of opening a browser. Open that URL on your own computer, paste the full redirect URL from that browser's address bar at the prompt, and connect with `ssh -t` so the paste step has an interactive terminal. Add `--no-browser` to force the prompt.

By default, Claude Code picks a random available port for the OAuth callback. This server accepts a loopback callback on any port with the same path, so you do not need `--callback-port`. Use `--callback-port` only for a server that requires a fixed port.

To sign in again, open `/mcp` and select **Re-authenticate**. To sign out, run `claude mcp logout netsapiens`, then `claude mcp remove netsapiens`. Anthropic documents that removing a server does not revoke its tokens at the authorization server, so run `logout` first.

To run a local server over stdio instead:

```sh
claude mcp add --env NETSAPIENS_API_URL=https://netsapiens.example.com --env NETSAPIENS_API_TOKEN=your-api-token --transport stdio netsapiens -- npx --yes netsapiens-mcp@3
```

### Claude API and Agent SDK

Neither product runs an interactive sign-in for this server. Your application does.

- **Messages API MCP connector.** Anthropic documents that "API consumers are expected to handle the OAuth flow and obtain the access token prior to making the API call, and to refresh the token as needed." The connector's examples use the beta header `mcp-client-2025-11-20`. A server definition takes this form:

  ```json
  {"type": "url", "url": "https://mcp.example.com/mcp", "name": "netsapiens", "authorization_token": "<access token>"}
  ```

  A matching `mcp_toolset` entry in the `tools` array makes the server's tools available.

- **Agent SDK.** Anthropic documents that "the SDK doesn't open a browser or run an interactive OAuth flow." Complete the OAuth flow in your own application and pass the access token in the server's `headers`, as `{"Authorization": f"Bearer {access_token}"}`.

## ChatGPT and Codex

### ChatGPT

Custom MCP server connections are made on ChatGPT web. OpenAI's help article says custom MCP server connections and full MCP support are available for ChatGPT Business and Enterprise/Edu customers, and that Pro users can connect custom MCP servers with read and fetch permissions. The article says custom MCP servers are web only, not mobile.

On a Business workspace, admins and owners create and publish the connection. On Enterprise/Edu, admins can grant the **Create plugins with MCPs** permission to selected members with role-based access control.

1. Go to **Plugins**, select the plus button, then select **Add custom MCP server**.
2. Enter a name and, optionally, a description.
3. Under **Connection**, enter the server's public HTTPS MCP endpoint, `https://mcp.example.com/mcp`.
4. Configure authentication. This server uses OAuth.
5. Review the risk warning and select **I understand and want to continue**.
6. Select **Create as a plugin**, then review the discovered tools.

Install the plugin, start a new conversation, type @ in the prompt box, and select the plugin. OpenAI's help article says you do not need to turn on Developer Mode first.

ChatGPT sends the callback-ID redirect URI listed in the table. Copy the exact value the connection's management page shows into your registry. OpenAI's documentation says its stable redirect URI, `https://chatgpt.com/connector_platform_oauth_redirect`, applies only to servers that advertise issuer identification and return `iss`. This server does neither.

Refresh tokens: OpenAI asks providers to list `offline_access` in `scopes_supported`, so that ChatGPT can request a refresh token. This server does not advertise scopes. The help article says that without `offline_access`, ChatGPT "may lose access after the original authorization expires" and users "may need to reauthenticate." Test a connection after its first access token expires before relying on it.

After an admin approves a connection, ChatGPT keeps a snapshot of the server's tools. Changes the server developer makes later are not applied until an admin reviews and publishes an update.

### Codex CLI

1. Add the server to `~/.codex/config.toml`:

   ```toml
   [mcp_servers.netsapiens]
   url = "https://mcp.example.com/mcp"
   ```

2. Sign in with `codex mcp login netsapiens`. Without a local browser, run `codex mcp login netsapiens --no-browser` and open the printed URL.
3. Check the connection with `codex mcp list`, or with `/mcp` in the Codex interface.

Codex uses dynamic client registration for this server. It chooses client ID metadata documents only when the server advertises them, and the Codex documentation says: "Otherwise, Codex uses DCR when available." Codex's sign-in callback is `http://127.0.0.1/callback/<callback_id>`, with the listening port inserted at sign-in.

To turn the server off without deleting it, set `enabled = false` in its table. The Codex documentation shows no command to remove a server or log out.

### ChatGPT desktop app and Codex IDE extension

The ChatGPT desktop app, Codex CLI and IDE extension share one MCP configuration. In the desktop app:

1. Open **Settings**, then select **MCP servers**.
2. Select **Add server**.
3. Enter a name, choose **STDIO** or **Streamable HTTP**, and provide the server's URL.
4. Save the server, then select **Restart**.

The server list shows which servers require OAuth. Select **Authenticate** when a server requires sign-in. Type `/mcp` in the composer to view connected servers. The pages read do not say which redirect URI these surfaces use.

### OpenAI Responses API

Pass the server in the `tools` array with the `mcp` type, the server URL and an access token:

```json
{"type": "mcp", "server_label": "netsapiens", "server_url": "https://mcp.example.com/mcp", "authorization": "<access token>"}
```

OpenAI documents that the Responses API does not store the `authorization` value, so your application must send it in each request that creates a response. Your application runs the OAuth flow itself and approves its own redirect URI in the registry.

## Gemini

### Gemini CLI

On May 19, 2026, Google announced that on June 18, 2026, Gemini CLI would stop serving requests for Google AI Pro and Ultra subscribers and for free Gemini Code Assist for individuals. Those users move to Antigravity CLI. Gemini CLI remains available to Gemini Code Assist Standard and Enterprise customers, and through paid Gemini and Gemini Enterprise Agent Platform API keys.

1. Add the server to the `mcpServers` object in `settings.json`:

   ```json
   {
     "mcpServers": {
       "netsapiens": {
         "httpUrl": "https://mcp.example.com/mcp"
       }
     }
   }
   ```

   `httpUrl` selects Streamable HTTP. `url` selects SSE, which this server does not use. You can also run `gemini mcp add --transport http netsapiens https://mcp.example.com/mcp`.

2. In an interactive session, run `/mcp auth netsapiens`, then sign in when the browser opens.

Without an `oauth` block, Gemini CLI performs dynamic client registration if the server supports it. Its callback is `http://localhost:<random-port>/oauth/callback`. Set `redirectUri` to fix the port. The documentation says sign-in does not work in headless environments without browser access, in SSH sessions without X11 forwarding, or in containers without browser support.

To remove the server, run `gemini mcp remove netsapiens`. To turn it off without removing it, run `gemini mcp disable netsapiens`.

### Gemini app

Custom apps connect in the Gemini web app. Google's help article requires that you are 18 or over and in the US, that you sign in with a personal Google Account, and that History is on. Work and school accounts cannot connect custom apps.

1. On gemini.google.com, select **Settings**, then **Connected Apps**. If you do not find it, select **Personal Intelligence**, then **Connected Apps**.
2. Under **Custom apps**, select **Add a custom app**.
3. Enter `https://mcp.example.com/mcp` and select **Next**. Select **Show more** next to **Advanced features** and enter credentials only if the server does not support Dynamic Client Registration. This server does.
4. Follow the on-screen instructions.

Google's developer documentation says the Gemini app currently requires a `registration_endpoint` in the discovery document, even for servers that support client ID metadata documents. This server publishes one.

To turn a custom app off, find it under **Custom apps** and turn it off. To remove it, select **More details**, then **Remove app**.

### Gemini Enterprise

An administrator adds a custom MCP server as a data store under **Connected Data Stores**. Before creating it, the administrator must override the organization policy constraint that blocks Custom MCP data store creation, and grant the Discovery Engine Editor role (`roles/discoveryengine.editor`).

Google's setup page says to register Gemini Enterprise as an OAuth client application with your identity provider, then obtain the `client_id` and `client_secret`. Set the authorization redirect URL to `https://vertexaisearch.cloud.google.com/oauth-redirect`. The setup page does not describe dynamic client registration, and Gemini Enterprise accepts only Streamable HTTP servers. Whether this server's `/register` endpoint works with Gemini Enterprise has not been tested.

By default, no tools or actions from a custom MCP server are enabled. Enable the ones you need.

### Gemini API and Google ADK

- **Gemini API.** A tool entry of type `mcp_server` takes the server `url` and optional `headers`, which are sent with every request. The documentation describes no OAuth flow for this tool, so your application supplies the access token in `headers`. SSE servers are not supported.
- **Google ADK.** Create `McpToolset(connection_params=StreamableHTTPConnectionParams(url="https://mcp.example.com/mcp"))` and add it to an agent's `tools`. For OAuth, use ADK's `auth_scheme` and `auth_credential` parameters rather than setting headers yourself. ADK does not fix the redirect URI. Your application supplies it, and the documentation says it must be pre-registered with your OAuth provider.

### Antigravity CLI

Google's May 19, 2026 announcement directs individual subscribers to Antigravity CLI. Its migration guide shows a remote server under `serverUrl`. The guide does not describe OAuth, so this page does not claim that Antigravity CLI can sign in to this server.

### Gemini Code Assist in IDEs

The agent mode of Gemini Code Assist in VS Code and IntelliJ is in Preview. Its documented examples connect a remote server through a stdio bridge, `npx` running `mcp-remote`. The page does not describe OAuth for remote servers.

## GitHub Copilot and Microsoft Copilot

### VS Code (GitHub Copilot Chat)

1. Select **Copilot** in the **Session Target** dropdown.
2. Run **Chat: Open Customizations**, select **MCP Servers**, then select **Add Server** (**+**) in the **User** group.
3. Choose **HTTP (HTTP or Server-Sent Events)**, enter `https://mcp.example.com/mcp`, and enter a server ID such as `netsapiens`.
4. Select **Global**, then **Copilot Global**. Complete any sign-in prompt, then check the connection with a tool call.

The same server can go in the Copilot user configuration file, `~/.copilot/mcp-config.json`, or in `$COPILOT_HOME/mcp-config.json` when `COPILOT_HOME` is set:

```json
{
  "mcpServers": {
    "netsapiens": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "tools": ["*"]
    }
  }
}
```

VS Code requires version 1.99 or later. For members of a Copilot Business or Enterprise organization, the **MCP servers in Copilot** policy must be enabled. VS Code documents `.vscode/mcp.json` as the deprecated Local harness format, and new Copilot configurations should not use it.

To turn a server off without removing it, open its ellipsis (**...**) menu and select **Disable**. Select **Uninstall** to remove it.

### GitHub Copilot CLI

1. Run `copilot mcp add --transport http netsapiens https://mcp.example.com/mcp`.
2. Run `/mcp auth netsapiens`. This opens a browser authentication prompt.

To remove the server, run `copilot mcp remove netsapiens`. If your organization sets a registry URL and an allowlist policy, only the servers the policy permits can run. The Copilot CLI documentation names no redirect URI for MCP sign-in.

### Visual Studio

Use **Add custom MCP server** to add a remote server by name and URL. Microsoft's documentation says Visual Studio supports OAuth for remote servers under the MCP authorization specification. It names no redirect URI.

### JetBrains IDEs

GitHub's Copilot documentation shows a JetBrains example that sets a static `Authorization` header under `requestInit`. The page describes no sign-in for a JetBrains remote server. JetBrains' own documentation was not checked.

### GitHub Copilot coding agent

Not supported with OAuth as of 2026-11-23. GitHub's documentation says that for MCP servers configured in repository settings or custom agent profiles, "Copilot cloud agent and Copilot code review do not currently support remote servers that use OAuth for authentication and authorization." See [GitHub's configuration page](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers).

### Microsoft Copilot Studio

1. On the **Tools** page of your agent, select **Add a tool**, then **New tool**.
2. In the **Create new** section, select **Model Context Protocol**. The MCP onboarding wizard appears.
3. Enter the **Server name**, **Server description** and **Server URL** (`https://mcp.example.com/mcp`).
4. For authentication, choose **OAuth 2.0**, and select **Dynamic discovery** as the OAuth 2.0 authentication type. Microsoft describes that option as the one for servers that support OAuth 2.0 dynamic client registration with discovery. This server publishes both.
5. Select **Create**. Copilot Studio may then show a callback URL. If it does, approve that exact value in the registry. The documentation does not print its value.
6. In the **Add tool** dialog, select **Create a new connection and add the MCP server to your agent**.

Copilot Studio supports the Streamable transport. It no longer supports SSE for MCP after August 2025.

### Microsoft 365 Copilot

Microsoft's documentation describes a Microsoft 365 Copilot plugin that connects supported Microsoft experiences to tools on a remote Model Context Protocol server. The guide is written for developers, who register the server in the `agentConnectors` array of the Microsoft 365 app manifest. To register with the OAuth provider, add the redirect URI `https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect`. The pages read do not describe an end user adding a remote MCP server by URL.

### Microsoft Teams

Microsoft's Teams MCP guide describes turning a Teams agent into an MCP server. The pages read do not describe connecting a remote MCP server to Teams. Not documented as of 2026-11-23.

## Troubleshooting

- **"Couldn't reach the MCP server" (Claude).** Claude could not read this server's discovery metadata. Anthropic describes this symptom when the `401` has no `WWW-Authenticate` header that names `resource_metadata` and the well-known paths return `404`. Check that an unauthenticated request to `https://<your-host>/mcp` returns `401` with a `WWW-Authenticate` header that names `resource_metadata`.
- **`Unregistered redirect_uri`.** The `/authorize` endpoint refuses a redirect URI the client did not register. A loopback client may use another port on the same path. For other clients, compare the URI with the table.
- **Sign-in refused, or a 503 page.** A refusal means the account or domain is not enrolled or enabled, or the redirect URI is not approved. A 503 means the registry cannot be reached. The `Access sign-in` log line gives the reason and never includes a token.
- **The tool list is empty.** The registry cannot be reached, or its decision allows no tools.
- **Everyone is signed out.** Changing `MCP_SESSION_SECRET` signs everyone out.
- **ChatGPT asks users to sign in again.** See the `offline_access` note under ChatGPT.
- **A client rejects a tool name as too long.** This server shortens generated tool names longer than 64 characters, and adds a short hash when the shortened name is still too long. Anthropic's directory review criteria ask for tool names of 64 characters or fewer, for listings. Claude Code's error reference says it leaves out a tool whose full `mcp__<server>__<tool>` name is longer than 128 characters. The OpenAI pages read state no tool-name limit.

## Sources

Each page was read on 2026-11-23 unless noted. All sources are vendor documentation.

Anthropic:

- https://claude.com/docs/connectors/building/authentication.md
- https://claude.com/docs/connectors/custom/add-unlisted.md
- https://claude.com/docs/connectors/getting-started.md
- https://claude.com/docs/connectors/building/review-criteria.md
- https://code.claude.com/docs/en/mcp.md
- https://code.claude.com/docs/en/agent-sdk/mcp.md
- https://code.claude.com/docs/en/errors.md
- https://platform.claude.com/docs/en/agents-and-tools/mcp-connector

OpenAI:

- https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt
- https://developers.openai.com/plugins/build/auth
- https://learn.chatgpt.com/docs/extend/mcp.md?surface=cli
- https://learn.chatgpt.com/docs/extend/mcp.md?surface=desktop
- https://developers.openai.com/api/docs/guides/tools-connectors-mcp.md

Google:

- https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md
- https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ (post dated May 19, 2026)
- https://antigravity.google/docs/cli/gcli-migration
- https://support.google.com/gemini/answer/17209137
- https://developers.google.com/connected-apps/mcp/oauth
- https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server.md.txt
- https://aistudio.google.com/docs/function-calling
- https://adk.dev/tools-custom/mcp-tools/
- https://adk.dev/tools-custom/authentication/
- https://docs.cloud.google.com/gemini/docs/codeassist/use-agentic-chat-pair-programmer.md.txt

Microsoft and GitHub:

- https://code.visualstudio.com/docs/agent-customization/mcp-servers.md
- https://code.visualstudio.com/docs/agents/reference/mcp-configuration.md
- https://code.visualstudio.com/api/extension-guides/ai/mcp
- https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/extend-copilot-chat-with-mcp (the VS Code and JetBrains examples)
- https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
- https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
- https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers
- https://learn.microsoft.com/en-us/visualstudio/ide/mcp-servers
- https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent
- https://learn.microsoft.com/en-us/plugins/plugin-authentication-oauth
- https://learn.microsoft.com/en-us/plugins/configure-plugin-mcp-servers
- https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/integrate-ai/mcp-server
