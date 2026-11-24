# Connecting AI clients

This page covers the hosted HTTP deployment of the NetSapiens MCP Server, where each person signs in as themselves. For each AI client that can connect a custom remote MCP server, it gives the steps as the vendor documents them, the OAuth redirect URI the client sends, and the entry to approve in an [access registry](access-registry.md). The examples use the placeholder host `https://mcp.example.com`.

Vendor products change often. If a step does not match what you see, check the vendor page in [Sources](#sources), which records the date each page was read.

## What the server needs from a client

- **Endpoint.** `https://<your-host>/mcp`, using Streamable HTTP. Set `MCP_BASE_URL` to the public origin, such as `https://mcp.example.com`. The endpoint and the metadata are built from it, so enter the URL exactly as shown here, including `/mcp`.
- **Discovery.** A request without a token gets `401` with `WWW-Authenticate: Bearer resource_metadata="https://<your-host>/.well-known/oauth-protected-resource/mcp"`. The metadata is served at `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`.
- **OAuth.** The authorization code flow with PKCE (`S256`). Authorization is at `/authorize`, tokens come from `/token`, and revocation is at `/revoke`.
- **Registration.** Dynamic client registration (RFC 7591) at `/register`. The server does not advertise client ID metadata documents, so a client that prefers them registers dynamically instead.
- **Sign-in.** The server's own sign-in page. In OAuth mode it has a Password tab (Username and Password) and a "Sign in with a NetSapiens token" tab (Platform and NetSapiens Token or API Key). The client receives only the OAuth tokens the server issues. Passwords never reach the model.
- **Token mode.** With `NETSAPIENS_AUTH_MODE=token` there is no OAuth client. The page shows only the token form, password sign-in is refused, and each person pastes their own NetSapiens API key or token. The server checks the key again when the client refreshes its session, and ends the session if NetSapiens no longer accepts the key.
- **Second factor.** If the operator sets `MCP_SECOND_FACTOR_POLICY`, the selected NetSapiens role tiers complete an authenticator challenge, and pasted tokens are refused for those tiers.

## Redirect URIs to approve

Use this table to fill the `platforms` list of an [access registry](access-registry.md). The source for each row is in [Sources](#sources).

| Client | Surface | Redirect URI the client sends | Entry to approve | Source |
|---|---|---|---|---|
| Claude | claude.ai on the web, Claude Desktop, Claude mobile, Cowork | `https://claude.ai/api/mcp/auth_callback` | `https://claude.ai/api/mcp/auth_callback` | Claude authentication |
| Claude | Claude Code | `http://localhost:<port>/callback`, with a port chosen at sign-in (some releases use `127.0.0.1`) | `loopback` | Claude Code MCP, Claude authentication |
| ChatGPT | Plugins, custom MCP server | `https://chatgpt.com/connector/oauth/{callback_id}`, as shown on the connection's management page | The exact value shown, one entry per value | OpenAI plugin authentication |
| OpenAI Codex CLI | `codex mcp login` | `http://127.0.0.1/callback/<callback_id>`, with the listener port added at sign-in | `loopback` | Codex MCP |
| Gemini CLI | `gemini mcp add`, `/mcp auth` | `http://localhost:<random port>/oauth/callback`, or a fixed port when `redirectUri` is set | `loopback` | Gemini CLI MCP |
| VS Code (Copilot Chat) | MCP servers | `http://127.0.0.1:33418` or `https://vscode.dev/redirect`. The docs do not say which one a given sign-in uses. | `loopback` and `https://vscode.dev/redirect` | VS Code MCP extension guide |
| Microsoft 365 Copilot | Declarative agent with an MCP plugin | `https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect` | That URI | Microsoft 365 plugin authentication |
| Microsoft Copilot Studio | MCP tool with OAuth 2.0 | A callback URL that Copilot Studio shows after you add the server. The docs do not print it. | The exact value shown | Copilot Studio MCP |
| Gemini Enterprise | Custom MCP data store, set up by an administrator | `https://vertexaisearch.cloud.google.com/oauth-redirect` | That URI | Gemini Enterprise custom MCP |
| Google ADK | Your application | Set by your application. The ADK sample uses `http://localhost:8000/callback`. | The value your application uses | ADK authentication |
| GitHub Copilot CLI | `/mcp auth` | Not documented | Cannot be listed from the docs | Copilot CLI MCP |
| Visual Studio | MCP OAuth | Not documented | Cannot be listed from the docs | Visual Studio MCP |
| Gemini app | Custom app, personal accounts | Not documented | Cannot be listed from the docs | Gemini app help |

Notes on the table:

- The `loopback` entry covers `http` or `https` on `localhost`, `127.0.0.1`, `[::1]` and `::1`, on any port and any path.
- An `https` entry matches the same host, port and path. There is no path wildcard, so each ChatGPT callback ID needs its own entry.
- This server compares a redirect URI exactly with the one the client registered. Loopback callbacks are the exception: any port on the same path is accepted.
- This server does not return the RFC 9207 `iss` parameter. ChatGPT therefore uses the callback-ID form. The stable form, `https://chatgpt.com/connector_platform_oauth_redirect`, needs the server to advertise `authorization_response_iss_parameter_supported` and return `iss` on every authorization response. It does not do that yet.
- Where the table says "not documented", do not guess a value. Find out the value from the client's own setup screen, or leave that client out of a restricted registry.

## Access registry

When the operator sets `MCP_ACCESS_REGISTRY_URL`, a person can sign in only when the registry allows their account and domain, and the client's redirect URI is approved. A refused sign-in shows a refusal page and issues no code. If the registry cannot answer, new sign-ins get a 503 page, the tool list is empty, and tool calls are refused. People who are already signed in stay signed in.

Approve only the clients you support. A restricted deployment usually approves one. The full contract is in [access-registry.md](access-registry.md).

## Claude

### Claude on the web

Individual plans (Free, Pro, Max and Ultra) add their own connectors. The Free plan allows one custom connector. On Team and Enterprise plans, an Owner adds the connector for the organization, and members then connect with their own account.

1. Go to the Connectors directory, select **Add**, then **Add custom connector**. On Team or Enterprise, go to **Organization settings > Connectors**, select **Add**, then **Custom**, and choose **Web** if Claude asks for the connector type.
2. Enter a name and the MCP server URL `https://mcp.example.com/mcp`, then select **Continue**.
3. Under **Choose authentication settings**, set **Authentication** to **Sign in now** and **OAuth client** to **Register automatically**. Leave **Request headers** empty. Do not choose **Use Claude's published identity**: it needs a server that advertises client ID metadata documents, and this server does not.
4. Select **Add**. If the connector shows **Connect**, select it and sign in on the server's sign-in page.

The dialog's layout varies by organization. If every setting appears on one screen, find the OAuth client and request headers under **Advanced**.

On Team plans only Owners and Primary Owners can add a custom connector. On Enterprise plans, Owners, Primary Owners, and people with a custom role that includes **Manage access to Libraries** can add one. Other members connect to the connector an Owner added: go to **Customize > Connectors**, find the connector labeled "Custom", and select **Connect**.

To remove a connector, select **Remove** or use the three-dot menu on its row. If Claude loses access later, the row shows **Reconnect**. You cannot change authentication settings after you add a connector, so remove it and add it again.

Limits from Anthropic's documentation:

- Claude connects from Anthropic's infrastructure, so the server must be reachable from the internet. `localhost` does not work.
- Claude cannot connect to a URL that specifies a port other than 443.
- Outbound requests come from `160.79.104.0/21`, if you need to allow them.
- Discovery, registration and token requests must answer within 10 seconds, and refresh requests within 30 seconds.
- A connector uses Streamable HTTP unless its URL ends in `/sse`.

### Claude Desktop

Custom connectors are added the same way as on the web. In the desktop app, select **Customize** in the sidebar, then **Connectors**. If the sidebar shows **Plugins** instead, select **Plugins**. The sign-in page opens in your browser.

On one computer, for one person, Claude Desktop can also run the server locally over stdio. Add this entry to the `mcpServers` object in `claude_desktop_config.json`:

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

The local server uses one NetSapiens token and runs on that computer. The hosted server gives each person their own sign-in.

### Claude mobile

Connectors that you add on the web or in Claude Desktop are available in the Claude mobile app. Adding a connector from the mobile app is in beta, so this page does not describe that flow.

### Claude Code

1. Add the server:

   ```sh
   claude mcp add --transport http netsapiens https://mcp.example.com/mcp
   ```

2. Sign in. Run `/mcp` in Claude Code and follow the browser steps, or run `claude mcp login netsapiens` in your shell. Over SSH, `claude mcp login` prints the authorization URL. Open it on your own computer, then paste the full redirect URL from that browser's address bar back at the prompt. Connect with `ssh -t` so that the paste works.

You do not need `--callback-port`. This server accepts any loopback port on the same callback path.

To sign in again, run `/mcp` and select **Re-authenticate**, or run `claude mcp login netsapiens`. To sign out, run `claude mcp logout netsapiens` and then `claude mcp remove netsapiens`. Removing a server deletes its stored tokens, but Claude Code does not revoke them at the authorization server unless you run `logout` first.

To run a local stdio server instead, use `claude mcp add netsapiens -- npx --yes netsapiens-mcp@3`.

### Claude API and Agent SDK

Neither runs an interactive sign-in, so there is no redirect URI for this server to approve.

- **Messages API MCP connector.** The connector reaches a publicly reachable HTTP server (Streamable HTTP or SSE). Your application obtains the access token and passes it as `authorization_token`:

  ```json
  {"type": "url", "url": "https://mcp.example.com/mcp", "name": "netsapiens", "authorization_token": "<access token>"}
  ```

  The connector is in beta, and its documentation names the beta header to send.
- **Agent SDK.** The SDK does not open a browser or run OAuth. Complete the OAuth flow in your application and pass the access token in the server's headers, or sign in from an interactive Claude Code session on the same machine before the run.

## ChatGPT and Codex

### ChatGPT (Plugins)

Custom MCP server connections are made on the ChatGPT web app. They are available on ChatGPT Business and Enterprise/Edu, and Pro users can connect custom MCP servers with read and fetch permissions. On a Business workspace, admins and owners create and publish the connection. On Enterprise/Edu, admins can grant the **Create plugins with MCPs** permission to selected members with role-based access control.

1. Go to **Plugins**, select the plus button, then select **Add custom MCP server**.
2. Enter a name and, optionally, a description.
3. Under **Connection**, enter the server's public HTTPS MCP endpoint, `https://mcp.example.com/mcp`.
4. Configure authentication. This server uses OAuth.
5. Review the risk warning and select **I understand and want to continue**.
6. Select **Create as a plugin**, then review the discovered tools.
7. Install the plugin, start a new conversation, type @ in the prompt box, and select the plugin.

You do not need to turn on Developer Mode first.

ChatGPT sends the callback-ID redirect URI from the table. Copy the exact value shown on the connection's management page into the registry.

OpenAI asks OAuth providers to advertise `offline_access` in `scopes_supported` so that ChatGPT can renew access. This server does not advertise scopes. OpenAI says that without `offline_access`, ChatGPT "may lose access after the original authorization expires" and users "may need to reauthenticate". Test the expiry before you rely on the connection.

To disconnect, users can disconnect apps from **Settings > Plugins**. Uninstalling a plugin can disconnect all accounts connected through it.

### Codex CLI

1. Add the server to `~/.codex/config.toml`:

   ```toml
   [mcp_servers.netsapiens]
   url = "https://mcp.example.com/mcp"
   ```

   You can also run `codex mcp add netsapiens --url https://mcp.example.com/mcp`.

2. Sign in with `codex mcp login netsapiens`. Without a local browser, run `codex mcp login netsapiens --no-browser`, then paste the full redirect URL back into the terminal.
3. Check the connection with `codex mcp list`, or with `/mcp` in the Codex interface.

Codex uses dynamic client registration for this server, because the server does not advertise client ID metadata documents and no client ID is configured. To disable the server without deleting it, set `enabled = false` in its table. The Codex documentation does not describe a remove command.

### OpenAI Responses API

Your application passes the server in the `tools` array with `"type": "mcp"` and `server_url`, and it passes an OAuth access token in `authorization`. Your application runs the OAuth flow. The Responses API does not store the `authorization` value, so send it with every request.

```json
{"type": "mcp", "server_label": "netsapiens", "server_url": "https://mcp.example.com/mcp", "authorization": "<access token>"}
```

## Gemini

### Gemini CLI

Google's May 19, 2026 announcement says that on June 18, 2026, Gemini CLI stops serving requests for Google AI Pro and Ultra, and for free Gemini Code Assist for individuals. Those users move to Antigravity CLI. Gemini CLI stays available to Gemini Code Assist Standard and Enterprise users, and through paid Gemini and Gemini Enterprise Agent Platform API keys.

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

2. In an interactive session, run `/mcp auth netsapiens`, and sign in when the browser opens.

Without an `oauth` block, Gemini CLI performs dynamic client registration when the server supports it. Its callback is `http://localhost:<random-port>/oauth/callback`, and setting `redirectUri` fixes the port.

To remove the server, run `gemini mcp remove netsapiens`. To disable it and keep its configuration, run `gemini mcp disable netsapiens`.

Sign-in does not work without browser access, in an SSH session without X11 forwarding, or in a container without browser support.

### Gemini app

Connect custom apps only in the Gemini web app at gemini.google.com. You must be 18 or older and in the US, and you must sign in with a personal Google Account. Work and school accounts cannot connect custom apps.

1. On gemini.google.com, select **Settings**, then **Connected Apps**. If you do not see it, select **Personal Intelligence**, then **Connected Apps**.
2. Under **Custom apps**, select **Add a custom app**.
3. Enter `https://mcp.example.com/mcp`, then select **Next**. Credentials are needed only when the server does not support dynamic client registration, and this server does.
4. Follow the on-screen instructions.

Google's documentation requires the discovery document to include `registration_endpoint`, and this server publishes one. The redirect URI for user-added custom apps is not documented, so it cannot be listed here.

To turn a custom app off, find it under **Custom apps** and turn it off. To remove it, select **More details**, then **Remove app**.

### Gemini Enterprise

An administrator adds a custom MCP server as a data store. Google's setup steps are:

1. Open Gemini Enterprise, select **Apps**, and select the app.
2. Select **Connected Data Stores**, then **New data store**.
3. Under **Select a data source**, search for "Custom MCP Server" and select **Add MCP server**.
4. Under **Authentication settings**, choose **OAuth 2.0** (MCP Server URL, Authorization URL, Token URL, Client ID, Client Secret, Scopes) or **No authentication**. Select **Verify Auth**, then **Continue**.
5. Set the location and name, then select **Create**.

Before that, the administrator must override the organization policy constraint that blocks custom MCP data store creation, allow the server's hostnames, and grant the Discovery Engine Editor role. When you register the OAuth client, set the authorization redirect URL to `https://vertexaisearch.cloud.google.com/oauth-redirect`.

Gemini Enterprise accepts only Streamable HTTP servers, and it requires a client ID and client secret. Its setup page does not document dynamic registration. This server's `/register` endpoint can issue a client, but whether Gemini Enterprise accepts that client has not been tested. By default, no tools from a custom MCP server are enabled.

### Gemini API and Google ADK

- **Gemini API.** A REST tool entry of type `mcp_server` takes a `url` and optional `headers`. It supports Streamable HTTP servers only. The documented authentication is static headers, and no OAuth flow is documented, so your application supplies the bearer token. The Python and JavaScript SDK support for MCP is labeled experimental, and its examples use stdio servers.
- **Google ADK.** Create a `McpToolset` with `StreamableHTTPConnectionParams(url="https://mcp.example.com/mcp", headers=...)`. For OAuth, use ADK's `auth_scheme` and `auth_credential` parameters. ADK leaves the redirect URI to your application. The sample uses `http://localhost:8000/callback`, which must match your OAuth client configuration.

### Antigravity CLI

Antigravity CLI is the successor to Gemini CLI for individual plans. Its migration guide shows remote servers under `serverUrl` and does not describe OAuth. This page does not claim that Antigravity CLI can sign in to this server.

### Gemini Code Assist in IDEs

Gemini Code Assist agent mode in VS Code and IntelliJ does not document a native remote server entry. The documented route is a stdio bridge, `npx mcp-remote`, which is in preview. The page does not describe OAuth for remote servers.

## GitHub Copilot and Microsoft Copilot

### VS Code (GitHub Copilot Chat)

1. Select **Copilot** in the **Session Target** dropdown.
2. Run **Chat: Open Customizations**, select **MCP Servers**, then select **Add Server** (**+**) in the **User** group.
3. Choose **HTTP (HTTP or Server-Sent Events)**, enter `https://mcp.example.com/mcp`, and enter a server ID such as `netsapiens`.
4. Select **Global**, then **Copilot Global**. Complete any sign-in prompt, then check the connection with a tool call.

Alternatively, add this to `~/.copilot/mcp-config.json`, or to `$COPILOT_HOME/mcp-config.json` when `COPILOT_HOME` is set:

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

VS Code's `.vscode/mcp.json` is the deprecated Local harness format, and new Copilot configurations should not use it. Copilot Business and Enterprise users need the **MCP servers in Copilot** policy enabled.

To disable a server without removing it, open its ellipsis (**...**) menu and select **Disable**. Select **Uninstall** to remove it.

### GitHub Copilot CLI

1. Run `copilot mcp add --transport http netsapiens https://mcp.example.com/mcp`.
2. Run `/mcp auth netsapiens` to sign in. The command opens a browser prompt.

To remove the server, run `copilot mcp remove netsapiens`. If your organization sets a registry URL and an allowlist policy, only servers that the policy permits can run. The Copilot CLI documentation names no redirect URI for MCP sign-in, so the CLI cannot be listed in the registry from the docs.

### Visual Studio and JetBrains

- **Visual Studio.** In the chat pane, select **Agent** mode, select **Tools**, then the plus button, then **Add custom MCP server** (Visual Studio 2026) or the **Add MCP server** dialog (Visual Studio 2022). Visual Studio supports OAuth for remote servers under the MCP authorization specification, but Microsoft's page names no redirect URI.
- **JetBrains IDEs.** The GitHub Copilot page documents remote servers only with a static `Authorization` header. OAuth is not documented.

### GitHub Copilot coding agent

Not supported with OAuth as of 2026-11-23. GitHub's documentation says that for servers configured in repository settings or custom agent profiles, Copilot cloud agent and Copilot code review "do not currently support remote servers that use OAuth for authentication and authorization." See [GitHub's MCP configuration page](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers).

### Microsoft Copilot Studio

1. On the **Tools** page of your agent, select **Add a tool**, then **New tool**.
2. Under **Create new**, select **Model Context Protocol**.
3. Enter the **Server name**, **Server description**, and **Server URL** (`https://mcp.example.com/mcp`), and choose **OAuth 2.0**.
4. Select **Create**, then, in the **Add tool** dialog, select **Create a new connection** and **Add to agent**.

Copilot Studio supports the Streamable transport, and it no longer supports SSE for MCP after August 2025. Its OAuth 2.0 options are **Dynamic discovery**, **Dynamic**, and **Manual**. Its documentation does not say which option uses dynamic client registration, so test the option you choose.

After you add the server, Copilot Studio shows a callback URL. Approve that exact value in the registry. Its value is not printed in the documentation.

### Microsoft 365 Copilot

A Microsoft 365 Copilot plugin can connect to a remote MCP server. A developer builds the declarative agent with Microsoft 365 Agents Toolkit. The Accounts pane must show **Custom App Upload Enabled** and **Copilot Access Enabled**. The developer then selects **Sign in to Microsoft 365** and **Provision**, and a user selects the agent in Microsoft 365 chat and selects **Sign in to {agent-name}** when prompted.

The redirect URI to add to the OAuth provider registration is `https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect`. A user signs out of an agent from **Chat settings > Agents**, which clears the stored OAuth token.

### Microsoft Teams

Microsoft's Teams MCP documentation describes turning a Teams agent into an MCP server. It does not document connecting a custom remote MCP server to Teams. Not documented as of 2026-11-23. See [Microsoft's Teams MCP server documentation](https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/integrate-ai/mcp-server).

## Troubleshooting

- **Couldn't reach the MCP server (Claude).** Claude could not read this server's metadata. Check that `https://<host>/mcp` answers a request without a token with `401` and a `WWW-Authenticate` header that names `resource_metadata`, and that the host is reachable from the internet.
- **Unregistered redirect_uri.** The `/authorize` endpoint refuses a redirect URI that the client did not register. For a loopback client, any port on the same path is accepted. For any other client, compare the URI with the table above.
- **Sign-in refused, or a 503 page.** A refusal means the account or domain is not enrolled or enabled, or the redirect URI is not approved. A 503 means the registry cannot be reached. The `Access sign-in` log line gives the reason and never includes a token.
- **The tool list is empty.** The registry cannot be reached, or the decision allows no tools.
- **The client asks people to sign in again.** Possible causes: the client's refresh was refused (`invalid_grant`), the registry denied the person at refresh, `MCP_SESSION_SECRET` changed (which signs everyone out), or in token mode the NetSapiens key was revoked.
- **ChatGPT asks users to sign in again.** See the `offline_access` note under ChatGPT.
- **A client rejects a tool name as too long.** This server keeps every tool name at 64 characters or fewer. It shortens generated names and adds a hash when it must. Anthropic's directory review checklist asks for 64 characters or fewer. Claude Code documents a 128-character limit on the full `mcp__<server>__<tool>` name. The OpenAI pages checked state no tool-name limit.

## Sources

Read 2026-11-23 unless a line says otherwise. Each source is a vendor's own documentation.

Anthropic:

- https://claude.com/docs/connectors/building/authentication.md
- https://claude.com/docs/connectors/custom/add-unlisted.md
- https://claude.com/docs/connectors/getting-started.md
- https://claude.com/docs/connectors/building/review-criteria.md
- https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- https://code.claude.com/docs/en/mcp.md
- https://code.claude.com/docs/en/agent-sdk/mcp.md
- https://code.claude.com/docs/en/errors.md
- https://platform.claude.com/docs/en/agents-and-tools/mcp-connector

OpenAI:

- https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt
- https://developers.openai.com/plugins/build/auth
- https://learn.chatgpt.com/docs/extend/mcp.md?surface=cli
- https://developers.openai.com/api/docs/guides/tools-connectors-mcp.md

Google:

- https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md
- https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ (post dated May 19, 2026)
- https://antigravity.google/docs/cli/gcli-migration
- https://support.google.com/gemini/answer/17209137
- https://developers.google.com/connected-apps/mcp/dev-mode/usage
- https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server.md.txt
- https://aistudio.google.com/docs/function-calling
- https://adk.dev/tools-custom/mcp-tools/
- https://adk.dev/tools-custom/authentication/

Microsoft and GitHub:

- https://code.visualstudio.com/docs/agent-customization/mcp-servers.md
- https://code.visualstudio.com/docs/agents/reference/mcp-configuration.md
- https://code.visualstudio.com/api/extension-guides/ai/mcp
- https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
- https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
- https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers
- https://learn.microsoft.com/en-us/visualstudio/ide/mcp-servers
- https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent
- https://learn.microsoft.com/en-us/plugins/plugin-authentication-oauth
- https://learn.microsoft.com/en-us/plugins/configure-plugin-mcp-servers
- https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/integrate-ai/mcp-server
