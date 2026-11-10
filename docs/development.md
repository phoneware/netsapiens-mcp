# Development

Regenerating tools from the vendored specs and a map of the repo. Back to the [README](../README.md).

## Regenerating tools

The specs are vendored at `spec/netsapiens-api-v2.json` (OpenAPI 3.1) and `spec/netsapiens-api-v1.json` (apidoc dump). To regenerate after a spec update:

```bash
npm run generate    # runs both generators, writes src/generated/
npm run build       # tsc compiles the generated code
```

`prebuild` runs `generate` automatically, so `npm run build` is enough most of the time.

## Repo layout

```
spec/
  netsapiens-api-v2.json        # OpenAPI 3.1 — 481 ops
  netsapiens-api-v1.json        # apidoc dump  — 277 ops
scripts/
  generate-tools.ts             # v2 generator
  generate-v1-tools.ts          # v1 generator
src/
  index.ts                      # entry point (stdio or http)
  http-server.ts                # Express app + MCP transport + auth wiring
  netsapiens-client.ts          # axios-based NS client with v1Call/request adapters
  auth/
    netsapiens-auth-provider.ts # OAuth provider, MFA, signed cookies
    token-store.ts              # file-backed store + TokenStoreLike interface
    firestore-token-store.ts    # Firestore-backed store
    firestore-clients-store.ts  # Firestore-backed DCR registry
    roles.ts                    # NS scope → MCP user role mapping
  tools/
    index.ts                    # registry wrapper: annotations, disables, dispatch
  generated/
    registry.ts                 # generated v2 registry
    tools/*.ts                  # 82 generated v2 tool modules
    v1/
      registry.ts               # generated v1 registry
      tools/*.ts                # 61 generated v1 tool modules
    types.ts                    # ToolDefinition + GenericApiClient
```
