# Public PATH Statement

An operator installs the published netsapiens-mcp package, starts it with an explicit NetSapiens URL and platform list, and a user signs in through the server's login page; that user sees and can call only the tools their NetSapiens host's release and their role allow, and the sign-in survives a restart in the default encrypted SQLite store, or across instances in Firestore.

## Commands

Before release (using packed tarball):
```bash
node scripts/consumer-e2e.mjs --tarball <netsapiens-mcp-3.2.0.tgz>
```

After release (from registry):
```bash
node scripts/consumer-e2e.mjs --registry 3.2.0
```

The default command covers the install, config, SQLite, memory, version, library, and MFA legs.
Run the Firestore leg separately against a disposable Firestore emulator:

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GOOGLE_CLOUD_PROJECT=firestore-test NSMCP_REQUIRE_FIRESTORE_EMULATOR=1 node scripts/consumer-e2e.mjs --tarball <netsapiens-mcp-3.2.0.tgz> --legs firestore --firestore-major 8
```

The access registry leg runs the packed package with a registry configured, against a fake NetSapiens and a fake registry. It is not part of the default legs:

```bash
node scripts/consumer-e2e.mjs --tarball <netsapiens-mcp-3.2.0.tgz> --legs registry
```

## Transport & Verification

- Installs package in an isolated consumer directory.
- Invokes package binary via `npx --yes netsapiens-mcp` or direct CLI entrypoint.
- Verifies Streamable HTTP server startup against configured NetSapiens platforms.
- Exercises Dynamic Client Registration (RFC 7591), PKCE S256, and login page token sign-in.
- Proves SQLite store file permissions (0600), process lock exclusion, and zero plaintext token leakage at rest.
- Proves session persistence across server restart for SQLite, and 401 invalid_token refusal on memory store restart.
- Proves Firestore multi-instance bearer sharing and exported store conformance.
- Proves the sign-in attempt budget across Firestore instances. Configure the trusted proxy and Firestore TTL policy before production use.
- Proves TypeScript consumer compilation against `netsapiens-mcp/lib` exports.
- Proves the access registry end to end on the packed package: sign-in refusals, tool and operation refusals that send no NetSapiens request, content denial and its `_withheld` counts, foreign targets, redirect refusal, revocation, registry outage, and the unset baseline.
