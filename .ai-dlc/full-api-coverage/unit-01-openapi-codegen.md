---
status: completed
depends_on: []
branch: ai-dlc/full-api-coverage/01-openapi-codegen
discipline: backend
ticket: ""
---

# unit-01: OpenAPI-to-MCP Code Generator

## Description
Build a TypeScript code generator that reads the NetSapiens OpenAPI 3.1 specification (`netsapiens-api-v2.json`) and produces MCP tool definitions. This runs at build time (not runtime) and outputs generated TypeScript files that the server imports.

## Discipline
backend - This unit will be executed by backend-focused agents.

## Domain Entities
All 140 schemas from the OpenAPI spec. The generator must understand:
- Path parameters (e.g., `{domain}`, `{user}`, `{device}`)
- Query parameters (e.g., `limit`, `start`, filters)
- Request body schemas (JSON objects with typed properties)
- Response schemas (for documentation in tool descriptions)
- Tags (88 unique tags for grouping tools into modules)

## Data Sources
- **Input**: `spec/netsapiens-api-v2.json` — the vendored OpenAPI 3.1 spec (329 paths, 481 operations)
- **Output**: `src/generated/tools/` directory containing one TypeScript file per API tag category
- **Output**: `src/generated/registry.ts` — a central registry mapping tool names to handlers

## Technical Specification

### Vendoring the Spec
1. Download `https://docs.ns-api.com/v45.0/openapi/netsapiens-api-v2.json` into `spec/netsapiens-api-v2.json`
2. Add `spec/` to the repo so builds are reproducible without network access

### Code Generator Script
Create `scripts/generate-tools.ts` (run via `tsx`):

1. **Parse the OpenAPI spec** using a JSON parser (no need for a full OpenAPI library — the spec is well-formed)

2. **Group operations by tag**: Each operation has 1+ tags. Group by the first tag. Tags map to output file names (e.g., `Users` → `users.ts`, `Call Center/Agents` → `call-center-agents.ts`).

3. **Generate tool name** from each operation:
   - Use `operationId` if present and unique
   - Otherwise derive from `{method}_{path}` with path params replaced (e.g., `GET /domains/{domain}/users` → `get_domain_users`)
   - Ensure all names are unique across the entire spec
   - Use snake_case for tool names

4. **Generate tool schema** for each operation:
   - `name`: the generated tool name
   - `description`: from `summary` + `description` fields in the spec
   - `inputSchema`: JSON Schema object combining:
     - Path parameters as required string properties
     - Query parameters with their types and optionality
     - Request body properties (flattened for simple objects, nested for complex ones)
   - Each property includes `description` from the spec

5. **Generate handler function** for each operation:
   - Extracts path params, query params, and body from the MCP tool arguments
   - Calls the generic API client (from Unit 03) with: HTTP method, path template, params, body
   - Returns the response in the standard MCP format

6. **Generate registry** (`src/generated/registry.ts`):
   - Exports a `Map<string, ToolDefinition>` mapping tool name → `{ schema, handler }`
   - The handler signature: `(args: Record<string, unknown>, client: GenericApiClient) => Promise<MCP CallToolResult>`

### Build Integration
- Add `"generate": "tsx scripts/generate-tools.ts"` to `package.json` scripts
- Add `"prebuild": "npm run generate"` so generation runs before TypeScript compilation
- Generated files go in `src/generated/` and are committed to the repo (so consumers don't need the generator at runtime)
- Add `src/generated/` to `.gitignore` only if the team prefers not to commit generated code — default: commit generated code

### Handling Spec Edge Cases
- Some paths have `#1`, `#2` suffixes (e.g., `/tokens#1`) — strip the suffix for the actual HTTP path, use it only for disambiguation in tool naming
- Some operations share the same path but differ by request body — these are separate tools with different names
- `x-apidog-*` extensions should be ignored
- Enum types should be included in parameter descriptions
- Required vs optional parameters must be correctly mapped

## Success Criteria
- [ ] Generator script runs without errors: `tsx scripts/generate-tools.ts`
- [ ] Produces TypeScript files in `src/generated/tools/` — one per API tag category
- [ ] Produces `src/generated/registry.ts` with all 481 operations registered
- [ ] Every generated tool has a unique name
- [ ] Every generated tool has an inputSchema matching its OpenAPI operation's parameters
- [ ] Every generated handler correctly maps arguments to HTTP method, path, query params, and body
- [ ] Generated TypeScript compiles without errors

## Risks
- **Spec inconsistencies**: Some operations may have incomplete schemas or missing operationIds. Mitigation: fall back to path+method naming; log warnings for incomplete specs.
- **Name collisions**: Multiple operations may generate the same tool name. Mitigation: append a numeric suffix or include the HTTP method in the name.
- **Large output**: 481 tools across many files could be large. Mitigation: this is expected; each file will be manageable since they're grouped by tag.

## Boundaries
This unit does NOT handle:
- The MCP server architecture (Unit 02)
- The generic HTTP client implementation (Unit 03)
- OAuth authentication (Unit 04)
- Runtime tool execution — it only generates the code

## Notes
- The generator should be idempotent — running it twice produces the same output
- Consider generating a `tool-manifest.json` alongside the TypeScript files for debugging/inspection
- The `spec/netsapiens-api-v2.json` file should be fetched once and committed; do not fetch on every build


