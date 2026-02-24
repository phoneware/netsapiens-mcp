# NetSapiens MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![NetSapiens API v2](https://img.shields.io/badge/NetSapiens-API%20v2-blue)](https://docs.ns-api.com/)
[![MCP Protocol](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-green)](https://modelcontextprotocol.io/)

> **🎯 Production-Ready NetSapiens Integration**
> Comprehensive MCP server providing AI agents with full access to NetSapiens VoIP platform

A Model Context Protocol (MCP) server that provides AI agents with seamless access to the NetSapiens VoIP platform. This server enables AI applications to interact with NetSapiens functionality including user management, call detail records, and system information.

## ⚡ Features

- **🔐 Dual Authentication**: Support for both API tokens and OAuth 2.0
- **🔄 Auto Token Refresh**: Automatic OAuth token refresh for seamless operation
- **👤 User-Specific Access**: OAuth enables per-user authentication and permissions
- **👥 User Management**: Search users, get details, devices, answer rules, greetings, and voicemails
- **📞 Phone Number Management**: List and manage phone numbers across domains
- **🎯 Call Center Operations**: Manage call queues, agents, login/logout, and statistics
- **📊 Call Analytics**: Access CDR records, agent statistics, and call patterns
- **🏢 Domain Administration**: Complete domain management and configuration
- **🤖 Auto Attendant**: Configure and manage automated attendants
- **🎵 Media Management**: Handle greetings, voicemail, and music on hold
- **💰 Billing Integration**: Access billing information and usage data
- **🔧 Real-time Operations**: Live access to NetSapiens platform data
- **⚡ Error Handling**: Robust error handling with detailed logging
- **🛡️ Rate Limiting**: Built-in rate limiting for API protection
- **📝 TypeScript**: Full TypeScript support with comprehensive type safety

## 🏗️ Architecture

```
netsapiens-mcp/
├── src/
│   ├── index.ts              # Main MCP server implementation
│   └── netsapiens-client.ts  # NetSapiens API client
├── types/
│   └── config.ts             # TypeScript type definitions
├── docs/                     # Documentation
├── build/                    # Compiled JavaScript output
├── package.json              # Project dependencies
├── tsconfig.json             # TypeScript configuration
└── README.md                 # This file
```

## 🚀 Quick Start

### Prerequisites

- Node.js 18.0.0 or higher
- npm or yarn package manager
- NetSapiens API credentials

### Installation

#### Option 1: From npm (Recommended)

```bash
npm install -g netsapiens-mcp
```

#### Option 2: From Source

1. **Clone the repository**
   ```bash
   git clone https://github.com/phoneware/netsapiens-mcp.git
   cd netsapiens-mcp
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Build the project**
   ```bash
   npm run build
   ```

4. **Configure in your MCP client**
   
   Add the server to your MCP client configuration with your NetSapiens credentials (see MCP Client Setup section below)

### Development Mode

For development with hot reloading:

```bash
npm run dev
```

### Docker Deployment

#### Option 1: Using Docker Compose (Recommended)

1. **Create a `.env` file** with your configuration:
   ```env
   NETSAPIENS_API_URL=https://edge.phoneware.cloud
   NETSAPIENS_API_TOKEN=your_api_token_here
   DEBUG=false
   ```

2. **Run with Docker Compose**:
   ```bash
   docker-compose up -d
   ```

3. **View logs**:
   ```bash
   docker-compose logs -f
   ```

4. **Stop the server**:
   ```bash
   docker-compose down
   ```

#### Option 2: Using Docker CLI

1. **Build the image**:
   ```bash
   docker build -t netsapiens-mcp .
   ```

2. **Run the container**:
   ```bash
   docker run -i \
     -e NETSAPIENS_API_URL=https://edge.phoneware.cloud \
     -e NETSAPIENS_API_TOKEN=your_api_token_here \
     netsapiens-mcp
   ```

#### Using with MCP Clients (Docker)

To use the Docker container with MCP clients, you'll need to configure your MCP client to use the Docker container. Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "netsapiens": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e", "NETSAPIENS_API_URL=https://edge.phoneware.cloud",
        "-e", "NETSAPIENS_API_TOKEN=your_api_token_here",
        "netsapiens-mcp"
      ]
    }
  }
}
```

## 🔧 Configuration

This MCP server is configured entirely through your MCP client's configuration file. **No separate `.env` file is needed** - all configuration is passed through environment variables in the MCP client config.

> **💡 Multi-User Deployments:** For centralized server deployments serving multiple users, see [DEPLOYMENT.md](DEPLOYMENT.md) for architecture patterns and best practices.

### Authentication Methods

The server supports two authentication methods:

#### Method 1: API Token (Simple)

Use a static API token for server-to-server authentication.

**Required:**
- `NETSAPIENS_API_TOKEN`: Your NetSapiens API token

#### Method 2: OAuth 2.0 (User-Specific)

Use OAuth 2.0 for user-specific authentication with automatic token refresh. **Recommended for multi-user environments.**

**Required:**
- `NETSAPIENS_OAUTH_CLIENT_ID`: Your OAuth client ID
- `NETSAPIENS_OAUTH_CLIENT_SECRET`: Your OAuth client secret
- `NETSAPIENS_OAUTH_USERNAME`: NetSapiens username (e.g., `user@domain.com`)
- `NETSAPIENS_OAUTH_PASSWORD`: NetSapiens password

**Note:** OAuth credentials take precedence if both OAuth and API token are provided.

### Common Configuration

- `NETSAPIENS_API_URL`: Your NetSapiens API endpoint (default: `https://edge.phoneware.cloud`)
- `DEBUG`: Set to `true` to enable debug logging (default: `false`)
- `NETSAPIENS_TIMEOUT`: API request timeout in milliseconds (default: `30000`)

## 🔌 MCP Client Setup

### OpenCode

For OpenCode, add the MCP server to your configuration file at `~/.opencode/mcp.json`:

**Using API Token:**
```json
{
  "mcpServers": {
    "netsapiens": {
      "command": "netsapiens-mcp",
      "env": {
        "NETSAPIENS_API_URL": "https://edge.phoneware.cloud",
        "NETSAPIENS_API_TOKEN": "your_api_token_here"
      }
    }
  }
}
```

**Using OAuth 2.0:**
```json
{
  "mcpServers": {
    "netsapiens": {
      "command": "netsapiens-mcp",
      "env": {
        "NETSAPIENS_API_URL": "https://edge.phoneware.cloud",
        "NETSAPIENS_OAUTH_CLIENT_ID": "your_client_id",
        "NETSAPIENS_OAUTH_CLIENT_SECRET": "your_client_secret",
        "NETSAPIENS_OAUTH_USERNAME": "user@domain.com",
        "NETSAPIENS_OAUTH_PASSWORD": "your_password"
      }
    }
  }
}
```

**If installed from source:**
```json
{
  "mcpServers": {
    "netsapiens": {
      "command": "node",
      "args": ["/path/to/netsapiens-mcp/build/index.js"],
      "env": {
        "NETSAPIENS_API_URL": "https://edge.phoneware.cloud",
        "NETSAPIENS_API_TOKEN": "your_api_token_here"
      }
    }
  }
}
```

### Claude Desktop

For Claude Desktop, add the server to your configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

**If installed via npm:**
```json
{
  "mcpServers": {
    "netsapiens": {
      "command": "netsapiens-mcp",
      "env": {
        "NETSAPIENS_API_URL": "https://edge.phoneware.cloud",
        "NETSAPIENS_API_TOKEN": "your_api_token_here"
      }
    }
  }
}
```

**If installed from source:**
```json
{
  "mcpServers": {
    "netsapiens": {
      "command": "node",
      "args": ["/path/to/netsapiens-mcp/build/index.js"],
      "env": {
        "NETSAPIENS_API_URL": "https://edge.phoneware.cloud",
        "NETSAPIENS_API_TOKEN": "your_api_token_here"
      }
    }
  }
}
```

### Cursor

For Cursor, add the server to your MCP configuration file at `~/.cursor/mcp.json`:

**If installed via npm:**
```json
{
  "mcpServers": {
    "netsapiens": {
      "command": "netsapiens-mcp",
      "env": {
        "NETSAPIENS_API_URL": "https://edge.phoneware.cloud",
        "NETSAPIENS_API_TOKEN": "your_api_token_here"
      }
    }
  }
}
```

**If installed from source:**
```json
{
  "mcpServers": {
    "netsapiens": {
      "command": "node",
      "args": ["/path/to/netsapiens-mcp/build/index.js"],
      "env": {
        "NETSAPIENS_API_URL": "https://edge.phoneware.cloud",
        "NETSAPIENS_API_TOKEN": "your_api_token_here"
      }
    }
  }
}
```

### Configuration Notes

- Replace `/path/to/netsapiens-mcp` with the actual path to your installation
- Replace `your_api_token_here` with your actual NetSapiens API token
- All configuration is handled through the MCP client - no separate `.env` file is needed
- After configuration, restart your MCP client to load the server

## 🛠️ Available Tools (23 Total)

### 👥 User Management
#### 1. Search Users
Search for users in the NetSapiens system by username.
```json
{
  "name": "search_users",
  "arguments": {
    "query": "john.doe",
    "domain": "company.com",
    "limit": 20
  }
}
```

#### 2. Get User Details
Retrieve detailed information about a specific user.
```json
{
  "name": "get_user",
  "arguments": {
    "userId": "john.doe",
    "domain": "company.com"
  }
}
```

#### 3. Get User Devices
Get devices assigned to a specific user.
```json
{
  "name": "get_user_devices",
  "arguments": {
    "userId": "john.doe",
    "domain": "company.com"
  }
}
```

### 📞 Phone Number Management
#### 4. Get Phone Numbers
Get phone numbers for a domain.
```json
{
  "name": "get_phone_numbers",
  "arguments": {
    "domain": "company.com",
    "limit": 50
  }
}
```

#### 5. Get Phone Number Details
Get details of a specific phone number.
```json
{
  "name": "get_phone_number",
  "arguments": {
    "domain": "company.com",
    "phoneNumber": "+15551234567"
  }
}
```

### 🏢 Domain Management
#### 6. Get Domains
Get list of domains in the NetSapiens system.
```json
{
  "name": "get_domains",
  "arguments": {}
}
```

#### 7. Get Domain Details
Get detailed information about a specific domain.
```json
{
  "name": "get_domain",
  "arguments": {
    "domain": "company.com"
  }
}
```

### 🎯 Call Center Management
#### 8. Get Call Queues
Get call queues for a domain.
```json
{
  "name": "get_call_queues",
  "arguments": {
    "domain": "company.com"
  }
}
```

#### 9. Get Call Queue Details
Get details of a specific call queue.
```json
{
  "name": "get_call_queue",
  "arguments": {
    "domain": "company.com",
    "queueId": "sales-queue"
  }
}
```

#### 10. Get Call Queue Agents
Get agents assigned to a call queue.
```json
{
  "name": "get_call_queue_agents",
  "arguments": {
    "domain": "company.com",
    "queueId": "sales-queue"
  }
}
```

#### 11. Get Agents
Get agents for a domain.
```json
{
  "name": "get_agents",
  "arguments": {
    "domain": "company.com"
  }
}
```

#### 12. Login Agent
Login an agent to a call queue.
```json
{
  "name": "login_agent",
  "arguments": {
    "domain": "company.com",
    "queueId": "sales-queue",
    "agentId": "agent001"
  }
}
```

#### 13. Logout Agent
Logout an agent from a call queue.
```json
{
  "name": "logout_agent",
  "arguments": {
    "domain": "company.com",
    "queueId": "sales-queue",
    "agentId": "agent001"
  }
}
```

### 📊 Call Analytics
#### 14. Get CDR Records
Retrieve call detail records with optional filtering.
```json
{
  "name": "get_cdr_records",
  "arguments": {
    "startDate": "2024-01-01",
    "endDate": "2024-01-31",
    "user": "john.doe",
    "domain": "company.com",
    "limit": 100
  }
}
```

#### 15. Get Agent Statistics
Get agent statistics for a domain.
```json
{
  "name": "get_agent_statistics",
  "arguments": {
    "domain": "company.com",
    "agentId": "agent001"
  }
}
```

### 🤖 Auto Attendant
#### 16. Get Auto Attendants
Get auto attendants for a domain.
```json
{
  "name": "get_auto_attendants",
  "arguments": {
    "domain": "company.com"
  }
}
```

### 📋 Answer Rules
#### 17. Get User Answer Rules
Get answer rules for a user.
```json
{
  "name": "get_user_answer_rules",
  "arguments": {
    "userId": "john.doe",
    "domain": "company.com"
  }
}
```

#### 18. Get User Answer Rule
Get specific answer rule for a user.
```json
{
  "name": "get_user_answer_rule",
  "arguments": {
    "userId": "john.doe",
    "domain": "company.com",
    "timeframe": "business"
  }
}
```

### 🎵 Media Management
#### 19. Get User Greetings
Get greetings for a user.
```json
{
  "name": "get_user_greetings",
  "arguments": {
    "userId": "john.doe",
    "domain": "company.com"
  }
}
```

#### 20. Get User Voicemails
Get voicemails for a user.
```json
{
  "name": "get_user_voicemails",
  "arguments": {
    "userId": "john.doe",
    "domain": "company.com"
  }
}
```

#### 21. Get Music on Hold
Get music on hold files for a domain.
```json
{
  "name": "get_music_on_hold",
  "arguments": {
    "domain": "company.com"
  }
}
```

### 💰 Billing
#### 22. Get Billing
Get billing information for a domain.
```json
{
  "name": "get_billing",
  "arguments": {
    "domain": "company.com"
  }
}
```

### 🔧 System
#### 23. Test Connection
Test connectivity to the NetSapiens API.
```json
{
  "name": "test_connection",
  "arguments": {}
}
```

## 📝 API Examples

### Searching for Users

```typescript
// Search for users with "john" in a specific domain
const result = await mcp.callTool('search_users', {
  query: 'john',
  domain: 'company.com',
  limit: 10
});
```

### Getting User Details

```typescript
// Get detailed information about a specific user
const result = await mcp.callTool('get_user', {
  userId: 'john.doe',
  domain: 'company.com'
});
```

### Getting Call Records

```typescript
// Get call records for a specific user in the last month
const result = await mcp.callTool('get_cdr_records', {
  startDate: '2024-01-01',
  endDate: '2024-01-31',
  user: 'john.doe',
  domain: 'company.com'
});
```

### Getting User Devices

```typescript
// Get devices assigned to a user
const result = await mcp.callTool('get_user_devices', {
  userId: 'john.doe',
  domain: 'company.com'
});
```

## 🏃‍♂️ Development

### Available Scripts

- `npm run build` - Compile TypeScript to JavaScript
- `npm run dev` - Run in development mode with hot reloading
- `npm start` - Run the compiled server
- `npm run watch` - Watch mode for development
- `npm run clean` - Clean build directory

### Project Structure

```
src/
├── index.ts                 # Main server entry point
├── netsapiens-client.ts     # NetSapiens API client
└── tools/                   # Individual tool implementations

types/
├── config.ts               # Configuration types
└── netsapiens.ts           # NetSapiens API types
```

### Adding New Tools

1. Define the tool in the `ListToolsRequestSchema` handler
2. Add a handler method in the `CallToolRequestSchema` handler
3. Implement the tool logic in the NetSapiens client
4. Update type definitions as needed

## 🔒 Security

### 🔐 MCP Security Best Practices

- **API Tokens**: Configure your NetSapiens API tokens securely in your MCP client configuration
- **Token Security**: Use strong API tokens and rotate them regularly
- **Access Control**: Ensure API tokens have minimal required permissions
- **Rate Limiting**: Built-in rate limiting prevents API abuse
- **Error Handling**: Secure error logging without exposing sensitive data
- **Input Validation**: All inputs are validated before processing

### 🚨 Security Guidelines

1. **Secure MCP Configuration**: Store your MCP client configuration files securely
2. **Strong API Tokens**: Use secure NetSapiens API tokens and rotate regularly
3. **Monitor Access**: Check NetSapiens access logs for unauthorized usage
4. **Regular Audits**: Run `npm audit` regularly for dependency vulnerabilities
5. **Keep Updated**: Maintain latest versions for security patches
6. **HTTPS Only**: All API communications use secure HTTPS connections
7. **Environment Isolation**: Use different tokens for development/production environments

## 🐛 Troubleshooting

### Common Issues

1. **Connection Failed**
   - Verify your API URL and token in `.env`
   - Check network connectivity to NetSapiens server
   - Ensure API token has proper permissions

2. **Build Errors**
   - Run `npm run clean` and rebuild
   - Check TypeScript configuration
   - Verify all dependencies are installed

3. **Tool Not Found**
   - Ensure the tool name matches exactly
   - Check the tool is properly registered in `ListToolsRequestSchema`

### Debug Mode

Enable debug logging by setting `DEBUG=true` in your `.env` file:

```env
DEBUG=true
```

## 📚 Documentation

- [NetSapiens API Documentation](https://docs.ns-api.com/)
- [Model Context Protocol Specification](https://modelcontextprotocol.io/)
- [MCP SDK Documentation](https://github.com/modelcontextprotocol/typescript-sdk)

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🏢 About OITVOIP

OITVOIP provides comprehensive VoIP solutions powered by the NetSapiens platform. This MCP server enables seamless integration between AI applications and our VoIP infrastructure.

---

**Built with ❤️ by the OITVOIP team**

*From frontend finesse to backend brilliance - we stack it all!* ⭐