import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { deriveStoreKey } from '../store/codec.js';
import { createSqliteStore } from '../store/sqlite.js';
import { createMemoryStore } from '../store/memory.js';
import type { McpStore } from '../store/types.js';
import type { FirestoreLike } from '../store/firestore.js';
import { logger } from '../utils/logger.js';

export interface StoreFromEnvResult {
  store: McpStore;
  close: () => Promise<void>;
  isPersistent: boolean;
  multiInstance: boolean;
  backend: 'memory' | 'sqlite' | 'firestore';
  namespace: string;
}

export async function createStoreFromEnv(env?: NodeJS.ProcessEnv): Promise<StoreFromEnvResult> {
  // 1. Validate removed variables
  const tokenStorePath = env?.MCP_TOKEN_STORE_PATH !== undefined ? env.MCP_TOKEN_STORE_PATH : process.env.MCP_TOKEN_STORE_PATH;
  if (tokenStorePath !== undefined) {
    throw new Error('ConfigError: MCP_TOKEN_STORE_PATH was removed in 3.0.0; use MCP_STORE_PATH');
  }
  const authCodesCollection = env?.FIRESTORE_AUTH_CODES_COLLECTION !== undefined ? env.FIRESTORE_AUTH_CODES_COLLECTION : process.env.FIRESTORE_AUTH_CODES_COLLECTION;
  if (authCodesCollection !== undefined) {
    throw new Error('ConfigError: FIRESTORE_AUTH_CODES_COLLECTION was removed in 3.0.0; use MCP_STORE_NAMESPACE');
  }
  const resumeTokensCollection = env?.FIRESTORE_RESUME_TOKENS_COLLECTION !== undefined ? env.FIRESTORE_RESUME_TOKENS_COLLECTION : process.env.FIRESTORE_RESUME_TOKENS_COLLECTION;
  if (resumeTokensCollection !== undefined) {
    throw new Error('ConfigError: FIRESTORE_RESUME_TOKENS_COLLECTION was removed in 3.0.0; use MCP_STORE_NAMESPACE');
  }

  // 2. Validate session secret
  const secret = env?.MCP_SESSION_SECRET ?? process.env.MCP_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('ConfigError: MCP_SESSION_SECRET must be at least 32 characters');
  }
  // 3. Validate persistence mode
  const persistenceRaw = env?.MCP_PERSISTENCE !== undefined ? env.MCP_PERSISTENCE : process.env.MCP_PERSISTENCE;
  const gcpProject = env?.GOOGLE_CLOUD_PROJECT !== undefined ? env.GOOGLE_CLOUD_PROJECT : process.env.GOOGLE_CLOUD_PROJECT;

  if (persistenceRaw === 'file') {
    throw new Error('ConfigError: MCP_PERSISTENCE=file was removed in 3.0.0; the default store is sqlite (see MCP_STORE_PATH)');
  }

  if (!persistenceRaw && gcpProject) {
    throw new Error(
      'ConfigError: MCP_PERSISTENCE is not set. 2.x chose Firestore because GOOGLE_CLOUD_PROJECT is set; ' +
      '3.0.0 never infers the store. Set MCP_PERSISTENCE=firestore or MCP_PERSISTENCE=sqlite.',
    );
  }

  const persistence = (persistenceRaw || 'sqlite') as 'sqlite' | 'firestore' | 'memory';
  if (persistence !== 'sqlite' && persistence !== 'firestore' && persistence !== 'memory') {
    throw new Error(`ConfigError: MCP_PERSISTENCE must be sqlite, firestore or memory, got "${persistenceRaw}"`);
  }

  // 4. Validate namespace
  const isReadOnly = (env?.MCP_READ_ONLY ?? process.env.MCP_READ_ONLY) === 'true';
  const defaultNamespace = isReadOnly ? 'readonly_mcp' : 'mcp';
  const namespaceParam = env?.MCP_STORE_NAMESPACE !== undefined ? env.MCP_STORE_NAMESPACE : process.env.MCP_STORE_NAMESPACE;
  const namespace = namespaceParam ?? defaultNamespace;
  const namespaceRegex = /^[a-z][a-z0-9_]{0,30}$/;
  if (!namespaceRegex.test(namespace)) {
    throw new Error(`ConfigError: MCP_STORE_NAMESPACE must match ^[a-z][a-z0-9_]{0,30}$, got "${namespace}"`);
  }

  // 5. Validate store path
  const storePath = env?.MCP_STORE_PATH !== undefined ? env.MCP_STORE_PATH : process.env.MCP_STORE_PATH;
  if (storePath !== undefined && persistence !== 'sqlite') {
    throw new Error(`ConfigError: MCP_STORE_PATH is only valid with MCP_PERSISTENCE=sqlite; got backend "${persistence}"`);
  }

  let dbPath: string | undefined;
  if (persistence === 'sqlite') {
    if (storePath !== undefined) {
      if (!isAbsolute(storePath)) {
        throw new Error(`ConfigError: MCP_STORE_PATH must be an absolute path, got "${storePath}"`);
      }
      dbPath = storePath;
    } else {
      dbPath = join(homedir(), '.netsapiens-mcp', `${namespace}.sqlite`);
    }

    // Check for legacy 2.x token files
    for (const legacyName of ['http-tokens.json', 'http-tokens-readonly.json']) {
      const legacyPath = join(homedir(), '.netsapiens-mcp', legacyName);
      if (existsSync(legacyPath)) {
        const warnMsg = `warn: ${legacyPath} is a 2.x token file. 3.0.0 does not read it, and it holds plaintext tokens. Delete it: rm ${legacyPath}`;
        console.error(warnMsg);
        logger.warn(warnMsg);
      }
    }
  }

  const key = deriveStoreKey(secret);

  let store: McpStore;
  if (persistence === 'sqlite') {
    const startMsg = `store: sqlite ${dbPath} (namespace ${namespace})`;
    console.error(startMsg);
    logger.info(startMsg);
    store = createSqliteStore({ path: dbPath!, namespace, key });
  } else if (persistence === 'firestore') {
    // Exception: @google-cloud/firestore is an optional peer dependency and cannot be statically imported.
    let firestoreModule: { Firestore: new (opts: { projectId?: string; ignoreUndefinedProperties?: boolean }) => unknown };
    try {
      firestoreModule = (await import('@google-cloud/firestore')) as unknown as typeof firestoreModule;
    } catch {
      throw new Error('ConfigError: MCP_PERSISTENCE=firestore needs @google-cloud/firestore: npm install @google-cloud/firestore');
    }
    const Firestore = firestoreModule.Firestore;
    const db = new Firestore({ projectId: gcpProject, ignoreUndefinedProperties: true }) as unknown as FirestoreLike;
    const { createFirestoreStore } = await import('../store/firestore.js');
    const startMsg = `store: firestore (namespace ${namespace})`;
    console.error(startMsg);
    logger.info(startMsg);
    store = createFirestoreStore({ db, namespace, key });
  } else {
    // memory
    const warnMsg = 'warn: memory store: every sign-in is lost on restart; one process only';
    console.error(warnMsg);
    logger.warn('memory store: every sign-in is lost on restart; one process only');
    store = createMemoryStore({ namespace, key });
  }

  return {
    store,
    close: () => store.close(),
    isPersistent: store.capabilities.persistent,
    multiInstance: store.capabilities.multiInstance,
    backend: persistence,
    namespace,
  };
}
