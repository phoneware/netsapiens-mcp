# Public PATH Statement

An operator installs the published netsapiens-mcp package, starts it with an explicit NetSapiens URL and platform list, and a user signs in through the server's login page; that user sees and can call only the tools their NetSapiens host's release and their role allow, and the sign-in survives a restart in the default encrypted SQLite store, or across instances in Firestore.

## Commands

Before release (using packed tarball):
```bash
node scripts/consumer-e2e.mjs --tarball <netsapiens-mcp-3.0.0.tgz>
```

After release (from registry):
```bash
node scripts/consumer-e2e.mjs --registry 3.0.0
```

## Transport & Verification

- Installs package in an isolated consumer directory.
- Invokes package binary via `npx --yes netsapiens-mcp` or direct CLI entrypoint.
- Verifies Streamable HTTP server startup against configured NetSapiens platforms.
- Exercises Dynamic Client Registration (RFC 7591), PKCE S256, and login page token sign-in.
- Proves SQLite store file permissions (0600), process lock exclusion, and zero plaintext token leakage at rest.
- Proves session persistence across server restart for SQLite, and 401 invalid_token refusal on memory store restart.
- Proves Firestore multi-instance bearer sharing and exported store conformance.
- Proves TypeScript consumer compilation against `netsapiens-mcp/lib` exports.
