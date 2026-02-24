---
status: in_progress
depends_on: []
branch: ai-dlc/full-api-coverage/03-generic-client
discipline: backend
ticket: ""
---

# unit-03: Generic API Client

## Description
Replace the 24 hand-written API methods in `netsapiens-client.ts` with a single generic HTTP client that takes an HTTP method, path template, parameters, and body — then returns the standardized response. This is what the generated tool handlers (Unit 01) call to make API requests.

## Discipline
backend - This unit will be executed by backend-focused agents.

## Domain Entities
- **GenericApiClient**: The single class/module that all generated tools use for API calls
- **NetSapiensApiResponse<T>**: The existing response wrapper type (`success`, `message`, `data`, `error`)
- **Request configuration**: HTTP method, path template, path params, query params, request body, headers

## Data Sources
- **Existing**: `src/netsapiens-client.ts` (607 lines) — current hand-written client to be replaced
- **Existing**: `src/types/config.ts` — `NetSapiensConfig`, `NetSapiensApiResponse<T>` types
- **Existing**: `src/oauth-manager.ts` — provides access tokens for request interceptor

## Technical Specification

### New `src/netsapiens-client.ts`
Replace the current file with a generic client. Key method:

```typescript
async request<T = unknown>(options: {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  pathTemplate: string;      // e.g., '/domains/{domain}/users/{user}'
  pathParams?: Record<string, string>;  // e.g., { domain: 'acme.com', user: 'jsmith' }
  queryParams?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}): Promise<NetSapiensApiResponse<T>>
```

### Path Parameter Interpolation
Given `pathTemplate = '/domains/{domain}/users/{user}'` and `pathParams = { domain: 'acme.com', user: 'jsmith' }`:
- Replace each `{param}` with the URL-encoded value from `pathParams`
- Throw if a required path param is missing
- The path template comes directly from the OpenAPI spec paths

### Query Parameter Handling
- Filter out `undefined` values
- Append as URL query string: `?limit=20&start=0`
- Support array values by repeating the key: `?status=active&status=pending`

### Request Body
- Serialize as JSON for `application/json` content type
- Support `multipart/form-data` for file upload endpoints (greetings, MOH, images, templates)
- Support `application/x-www-form-urlencoded` if needed by any endpoints

### Authentication (Request Interceptor)
Preserve the existing pattern:
1. Before each request, get the current access token
2. If OAuth is configured: call `oauthManager.getAccessToken()` (handles refresh automatically)
3. If API token is configured: use the static token
4. Set `Authorization: Bearer {token}` header

### Response Handling
Preserve the existing patterns:
1. Successful response (2xx): return `{ success: true, data: response.data, message: 'OK' }`
2. Error response (4xx/5xx): return `{ success: false, error: error.message, message: 'Request failed' }`
3. Network error: return `{ success: false, error: error.message, message: 'Network error' }`
4. Array normalization: if the response is a single object where an array was expected, wrap it in an array (existing behavior)

### Axios Configuration
Preserve existing setup:
- `baseURL`: `${config.apiUrl}/ns-api/v2`
- `timeout`: `config.timeout` (default 30000)
- Headers: `Content-Type: application/json`, `Accept: application/json`, `User-Agent: NetSapiens-MCP/{version}`

### Exported Interface
```typescript
export interface GenericApiClient {
  request<T = unknown>(options: RequestOptions): Promise<NetSapiensApiResponse<T>>;
}

export function createApiClient(config: NetSapiensConfig): GenericApiClient;
```

This interface is what Unit 01's generated handlers import and call.

## Success Criteria
- [ ] Single `request()` method handles all HTTP methods (GET, POST, PUT, PATCH, DELETE)
- [ ] Path parameters are correctly interpolated: `/domains/{domain}` → `/domains/acme.com`
- [ ] Query parameters are correctly appended as URL query string
- [ ] Request bodies are serialized as JSON
- [ ] Auth token is injected via request interceptor (OAuth or API token)
- [ ] Responses are wrapped in `NetSapiensApiResponse<T>` format
- [ ] Error responses return `{ success: false }` instead of throwing
- [ ] `npm run build` compiles the new client without errors
- [ ] The old 24 hand-written methods are removed

## Risks
- **Multipart uploads**: Some endpoints (greetings, MOH, images) accept file uploads via `multipart/form-data` or base64 JSON. Mitigation: detect content type from the operation spec and switch serialization accordingly. Initially, JSON body is sufficient for most operations; file upload support can use base64 JSON endpoints.
- **Array normalization**: The current client wraps single objects in arrays for certain endpoints. Mitigation: the generic client should NOT do this — let the generated handlers handle response normalization if needed, since most consumers expect the raw API response shape.

## Boundaries
This unit does NOT handle:
- Tool definitions or the MCP protocol (Unit 01, Unit 02)
- OAuth flow changes (Unit 04) — it only consumes the token via the existing `getAccessToken()` interface
- It is a pure HTTP client with no knowledge of MCP.

## Notes
- The `createApiClient` factory function should accept the `OAuthManager` instance (or token provider function) as a dependency, not import it directly. This keeps the client testable.
- Consider accepting a token provider function `() => Promise<string>` instead of the full OAuthManager, for cleaner separation.

