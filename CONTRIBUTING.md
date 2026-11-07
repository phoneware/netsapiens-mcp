# Contributing

## Contribute a NetSapiens version observation

Probe only a host you operate or have permission to test. The script sends unauthenticated GET requests to the documented routes at no more than two requests per second. Requests can appear in the host logs as 400 or 404 responses.

Clone the repository, install dependencies, and run the probe against your host:

```sh
git clone https://github.com/phoneware/netsapiens-mcp
cd netsapiens-mcp
npm ci
npm run specs:probe -- --api-url https://<your-host>
```

The script writes `spec/v2/observations/<apiVersion>.json`. It refuses to overwrite an existing file. Check that the output contains no hostnames, IP addresses, usernames, or tokens, then commit the unmodified file and open a pull request. Confirm that you operate the host or have permission to probe it and that the file is the unmodified probe output.

The probe checks a control route before recording results. It stops on repeated authorization, rate-limit, server, or connection failures. Observation validation checks the file against the published specifications and rejects incomplete or blocked probes.
