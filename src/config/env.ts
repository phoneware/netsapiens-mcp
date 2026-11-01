export interface EnvVar {
 name: string;
 transports: readonly ('http' | 'stdio')[];
 required: boolean;
 default: string | null;
 effect: string;
}

export const ENV_VARS: readonly EnvVar[] = [
 { name: 'NETSAPIENS_API_URL', transports: ['http', 'stdio'], required: true, default: null, effect: 'NetSapiens host origin.' },
 { name: 'NETSAPIENS_PLATFORMS', transports: ['http'], required: false, default: null, effect: 'JSON object of allowed platforms; ignored in stdio mode.' },
 { name: 'NETSAPIENS_VERSION_TTL_SECONDS', transports: ['http', 'stdio'], required: false, default: '3600', effect: 'Version cache TTL in seconds; positive integer or exit 1.' },
 { name: 'MCP_PLATFORMS', transports: ['http', 'stdio'], required: false, default: null, effect: 'Removed in 3.0.0; use NETSAPIENS_PLATFORMS.' },
 { name: 'MCP_PERSISTENCE', transports: ['http'], required: false, default: 'sqlite', effect: 'sqlite, firestore or memory; any other value exits 1. file exits 1 with ConfigError: MCP_PERSISTENCE=file was removed in 3.0.0; the default store is sqlite (see MCP_STORE_PATH). Unset with GOOGLE_CLOUD_PROJECT exits 1 with ConfigError: MCP_PERSISTENCE is not set. 2.x chose Firestore because GOOGLE_CLOUD_PROJECT is set; 3.0.0 never infers the store. Set MCP_PERSISTENCE=firestore or MCP_PERSISTENCE=sqlite. Firestore without its package exits 1 with ConfigError: MCP_PERSISTENCE=firestore needs @google-cloud/firestore: npm install @google-cloud/firestore. Memory logs warn: memory store: every sign-in is lost on restart; one process only.' },
 { name: 'MCP_STORE_NAMESPACE', transports: ['http'], required: false, default: 'mcp, or readonly_mcp when MCP_READ_ONLY=true', effect: 'Must match ^[a-z][a-z0-9_]{0,30}$ or exit 1. Firestore collection prefix and SQLite default filename; the SQLite file records it and refuses any other.' },
 { name: 'MCP_STORE_PATH', transports: ['http'], required: false, default: '<os.homedir()>/.netsapiens-mcp/<namespace>.sqlite', effect: 'SQLite only; a relative path or setting it with another backend exits 1.' },
 { name: 'MCP_SESSION_SECRET', transports: ['http'], required: true, default: null, effect: 'At least 32 characters or exit 1 with ConfigError: MCP_SESSION_SECRET must be at least 32 characters. Signs and seals login state and derives the store key; changing it signs everyone out.' },
 { name: 'GOOGLE_CLOUD_PROJECT', transports: ['http'], required: false, default: null, effect: 'Does not select a store. With MCP_PERSISTENCE=firestore, the Google client library reads it as usual.' },
 { name: 'MCP_TOKEN_STORE_PATH', transports: ['http'], required: false, default: null, effect: 'ConfigError: MCP_TOKEN_STORE_PATH was removed in 3.0.0; use MCP_STORE_PATH' },
 { name: 'FIRESTORE_AUTH_CODES_COLLECTION', transports: ['http'], required: false, default: null, effect: 'ConfigError: FIRESTORE_AUTH_CODES_COLLECTION was removed in 3.0.0; use MCP_STORE_NAMESPACE' },
 { name: 'FIRESTORE_RESUME_TOKENS_COLLECTION', transports: ['http'], required: false, default: null, effect: 'ConfigError: FIRESTORE_RESUME_TOKENS_COLLECTION was removed in 3.0.0; use MCP_STORE_NAMESPACE' },
 { name: 'NETSAPIENS_API_TOKEN', transports: ['stdio'], required: false, default: null, effect: 'Static API token, or provide all four OAuth credentials.' },
 { name: 'NETSAPIENS_OAUTH_CLIENT_ID', transports: ['http', 'stdio'], required: false, default: null, effect: 'OAuth client ID; required in HTTP mode or for stdio OAuth.' },
 { name: 'NETSAPIENS_OAUTH_CLIENT_SECRET', transports: ['http', 'stdio'], required: false, default: null, effect: 'OAuth client secret; required in HTTP mode or for stdio OAuth.' },
 { name: 'NETSAPIENS_OAUTH_USERNAME', transports: ['stdio'], required: false, default: null, effect: 'OAuth username for stdio.' },
 { name: 'NETSAPIENS_OAUTH_PASSWORD', transports: ['stdio'], required: false, default: null, effect: 'OAuth password for stdio.' },
 { name: 'MCP_TRANSPORT', transports: ['http', 'stdio'], required: false, default: 'stdio', effect: 'Transport selection.' },
 { name: 'DEBUG', transports: ['http', 'stdio'], required: false, default: 'false', effect: 'Enable debug output.' },
 { name: 'LOG_LEVEL', transports: ['http', 'stdio'], required: false, default: null, effect: 'Logging level.' },
 { name: 'MCP_BASE_URL', transports: ['http'], required: false, default: null, effect: 'Public server base URL.' },
 { name: 'MCP_PORT', transports: ['http'], required: false, default: '3000', effect: 'HTTP listening port.' },
 { name: 'MCP_HOST', transports: ['http'], required: false, default: '0.0.0.0', effect: 'HTTP listening address.' },
 { name: 'MCP_CORS_ORIGIN', transports: ['http'], required: false, default: '*', effect: 'CORS origin.' },
 { name: 'MCP_ICON_URL', transports: ['http', 'stdio'], required: false, default: null, effect: 'Server icon URL.' },
 { name: 'MCP_LOGIN_HEADER', transports: ['http'], required: false, default: null, effect: 'Login page heading.' },
 { name: 'MCP_LOGIN_LOGO_URL', transports: ['http'], required: false, default: null, effect: 'Login page logo URL.' },
 { name: 'MCP_SERVER_TITLE', transports: ['http', 'stdio'], required: false, default: null, effect: 'Server title.' },
 { name: 'MCP_WEBSITE_URL', transports: ['http', 'stdio'], required: false, default: null, effect: 'Server website URL.' },
 { name: 'MCP_STATELESS', transports: ['http'], required: false, default: null, effect: 'Control HTTP session mode.' },
 { name: 'MCP_TOKEN_LIFETIME_HOURS', transports: ['http'], required: false, default: '168', effect: 'Issued token lifetime in hours.' },
 { name: 'MCP_READ_ONLY', transports: ['http', 'stdio'], required: false, default: 'false', effect: 'Disable modifying tools.' },
 { name: 'MCP_TOOL_MODE', transports: ['http', 'stdio'], required: false, default: null, effect: 'Select tool catalog.' },
 { name: 'MCP_TOOLS_PAGE_SIZE', transports: ['http', 'stdio'], required: false, default: null, effect: 'Tool list page size.' },
 { name: 'MCP_DISABLED_TOOLS', transports: ['http', 'stdio'], required: false, default: null, effect: 'Tool name patterns to disable.' },
 { name: 'MCP_DISABLED_ACTIONS', transports: ['http', 'stdio'], required: false, default: null, effect: 'Actions to disable.' },
 { name: 'MCP_DISABLE_DESTRUCTIVE', transports: ['http', 'stdio'], required: false, default: 'false', effect: 'Disable destructive tools.' },
 { name: 'MCP_DISABLE_ROLE_FILTER', transports: ['http', 'stdio'], required: false, default: 'false', effect: 'Disable role filtering.' },
 { name: 'MCP_CONFIRM_DESTRUCTIVE', transports: ['http', 'stdio'], required: false, default: 'false', effect: 'Request confirmation for destructive operations.' },
 { name: 'MCP_CONFIRM_FALLBACK', transports: ['http', 'stdio'], required: false, default: null, effect: 'Confirmation fallback policy.' },
 { name: 'MCP_DISABLE_PROMOTION', transports: ['http', 'stdio'], required: false, default: 'false', effect: 'Disable tool promotion.' },
 { name: 'MCP_PROMOTE_THRESHOLD', transports: ['http', 'stdio'], required: false, default: null, effect: 'Tool promotion threshold.' },
 { name: 'MCP_PROMOTE_WINDOW_DAYS', transports: ['http', 'stdio'], required: false, default: null, effect: 'Tool promotion window.' },
 { name: 'MCP_SYNCHRONOUS_WRITES', transports: ['http', 'stdio'], required: false, default: null, effect: 'Control synchronous upstream writes.' },
];
