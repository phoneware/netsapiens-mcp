---
status: in_progress
depends_on:
  - unit-01-openapi-codegen
branch: ai-dlc/full-api-coverage/02-modular-server
discipline: backend
ticket: ""
---

# unit-02: Modular MCP Server Architecture

## Description
Refactor the MCP server from a monolithic 1,195-line `index.ts` with 23 hard-coded tools to a modular, registry-based architecture that loads all 481 generated tools dynamically.

## Discipline
backend - This unit will be executed by backend-focused agents.

## Domain Entities
- **Tool Registry**: The central map of tool name → tool definition + handler
- **MCP Server**: The `@modelcontextprotocol/sdk` server instance
- **Tool Definition**: Name, description, inputSchema (JSON Schema)
- **Tool Handler**: Function that processes tool calls and returns results

## Data Sources
- **Input**: `src/generated/registry.ts` (produced by Unit 01) — contains all 481 tool definitions and handlers
- **Input**: `src/generated/tools/*.ts` — individual tool modules by category
- **Existing**: `src/index.ts` — current monolithic server to be refactored
- **Existing**: `src/types/config.ts` — configuration types (preserved)

## Technical Specification

### New `src/index.ts` Structure
Replace the current monolithic file with a slim entry point:

```typescript
// 1. Load configuration from environment
// 2. Initialize auth (OAuth manager or API token)
// 3. Create generic API client (from Unit 03)
// 4. Import the tool registry (from Unit 01's generated output)
// 5. Create MCP server
// 6. Register ListToolsRequestSchema handler that returns all tools from registry
// 7. Register CallToolRequestSchema handler that:
//    a. Looks up the tool name in the registry
//    b. Validates arguments against the tool's inputSchema
//    c. Calls the tool's handler with (args, client)
//    d. Returns the result in MCP format
// 8. Connect via StdioServerTransport
```

### Handler Delegation
The `CallToolRequestSchema` handler:
1. Receives `{ name, arguments }` from MCP client
2. Looks up `name` in the registry `Map`
3. If not found: throw `McpError(ErrorCode.MethodNotFound)`
4. Calls `registry.get(name).handler(arguments, client)`
5. Returns the result (already in MCP `CallToolResult` format from the generated handler)

### ListTools Handler
The `ListToolsRequestSchema` handler:
1. Iterates the registry
2. Returns `{ tools: Array.from(registry.values()).map(t => t.schema) }`

### Configuration Loading
Preserve the existing `getConfig()` function from `index.ts` with these modifications:
- Support the new OAuth auth code flow configuration (from Unit 04)
- Keep backward compatibility with existing env vars
- Move to `src/config.ts` if it helps keep `index.ts` slim

### Error Handling
Preserve existing error handling patterns:
- `McpError(ErrorCode.InvalidParams)` for bad arguments
- `McpError(ErrorCode.MethodNotFound)` for unknown tools
- `McpError(ErrorCode.InternalError)` for execution failures
- SIGINT handler for graceful shutdown

### Response Format
All tool handlers (generated in Unit 01) return:
```json
{
  "content": [{
    "type": "text",
    "text": "{\"success\": bool, \"message\": string, \"data\": T, \"error\": string}"
  }]
}
```
This is the existing format — no changes needed. The server just passes through what handlers return.

## Success Criteria
- [ ] `src/index.ts` is under 150 lines (down from 1,195)
- [ ] MCP server starts and connects via StdioServerTransport
- [ ] `ListToolsRequestSchema` returns all 481 tools from the registry
- [ ] `CallToolRequestSchema` correctly delegates to the right handler for any tool name
- [ ] Unknown tool names return `McpError(ErrorCode.MethodNotFound)`
- [ ] `npm run build` compiles the refactored server without errors
- [ ] The old 23 hand-written tool definitions are removed (replaced by generated ones)

## Risks
- **Startup performance**: Loading 481 tools at startup could be slow. Mitigation: tools are just objects in a Map — no lazy loading needed; the registry is a static import.
- **Breaking existing clients**: Tool names may differ between hand-written and generated versions. Mitigation: if backward compatibility were required (user said it's not an NFR), we could alias old names. Since it's not required, proceed with generated names only.

## Boundaries
This unit does NOT handle:
- Generating the tools (Unit 01)
- The generic HTTP client (Unit 03)
- OAuth authentication changes (Unit 04)
- It only restructures how tools are loaded and dispatched.

## Notes
- The current `index.ts` has a `NetSapiensMCPServer` class. The refactored version can keep the class pattern or switch to functional — whichever is simpler.
- The `test_connection` tool from the current implementation should be preserved as a generated tool (it maps to `GET /domains` with limit=1 in the spec, or can be a special non-generated tool).

