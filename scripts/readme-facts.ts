#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { toolRegistry } from '../src/generated/registry.js';
import { v1ToolRegistry } from '../src/generated/v1/registry.js';
import { CURATED_CATALOG } from '../src/tools/curated/catalog.js';
import { ENV_VARS } from '../src/config/env.js';
import { firestoreCollections } from '../src/store/firestore.js';
import { resolveDocsBranch } from '../src/netsapiens/availability.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

export interface ReadmeFacts {
  toolCounts: {
    v2Total: number;
    v1Total: number;
    curatedTotal: number;
    metaTotal: number;
  };
  versionMatrix: string;
  backendsTable: string;
  firestoreCollectionsTable: string;
  envTable: string;
  rolesTable: string;
  libExports: string[];
}

export function generateReadmeFacts(): ReadmeFacts {
  // 1. Tool counts
  const v2Total = toolRegistry.size;
  const v1Total = v1ToolRegistry.size;
  const curatedTotal = CURATED_CATALOG.length;
  const metaTotal = 2;

  // 2. Version matrix
  const branchesJson: string[] = JSON.parse(
    readFileSync(path.join(repoRoot, 'spec/v2/BRANCHES.json'), 'utf8'),
  );
  const sourcesJson: Record<string, { retrievedAt: string | null }> = JSON.parse(
    readFileSync(path.join(repoRoot, 'spec/SOURCES.json'), 'utf8'),
  );
  const availJson = JSON.parse(
    readFileSync(path.join(repoRoot, 'src/generated/availability.json'), 'utf8'),
  );

  const lines = [
    '| Host line | Documentation used | Observed on a live host | Read tools | Write tools |',
    '|---|---|---|---|---|',
  ];

  for (const b of branchesJson) {
    const srcKey = `spec/v2/${b}.json`;
    const retrieved = sourcesJson[srcKey]?.retrievedAt
      ? sourcesJson[srcKey].retrievedAt!.split('T')[0]
      : 'unrecorded';
    const obsList = (availJson.observations ?? []).filter(
      (o: any) => resolveDocsBranch(o.apiVersion, branchesJson).docsBranch === b,
    );
    const obsText = obsList.length > 0
      ? obsList.map((o: any) => `${o.apiVersion} (${o.source})`).join(', ')
      : 'not yet';

    // Count tools documented in this branch
    let readCount = 0;
    let writeCount = 0;
    for (const [, def] of toolRegistry) {
      const op = def.operation;
      if (op && op.family === 'v2') {
        const v2Entry = availJson.v2?.[op.key];
        if (v2Entry?.documented?.includes(b)) {
          if (op.method === 'GET') readCount++;
          else writeCount++;
        }
      }
    }

    lines.push(`| ${b} | ${b} (retrieved ${retrieved}) | ${obsText} | ${readCount} | ${writeCount} |`);
  }

  // Newer than documented row
  const newestBranch = branchesJson[branchesJson.length - 1];
  let newestRead = 0;
  let newestWrite = 0;
  for (const [, def] of toolRegistry) {
    const op = def.operation;
    if (op && op.family === 'v2') {
      const v2Entry = availJson.v2?.[op.key];
      if (v2Entry?.documented?.includes(newestBranch)) {
        if (op.method === 'GET') newestRead++;
        else newestWrite++;
      }
    }
  }
  lines.push(`| newer than ${newestBranch.split('.')[0]} | ${newestBranch} (newer than documented) | not yet | ${newestRead} | ${newestWrite} |`);

  const versionMatrix = lines.join('\n');

  // 3. Backends table
  const backendsTable = [
    '| Backend | Persistent | Multi-instance | Concurrency / Locking | Expiry Mechanism |',
    '|---|---|---|---|---|',
    '| `sqlite` (default) | Yes | No (single process) | Exclusive SQLite lock (`StoreLockedError`) | In-process sweep on interval |',
    '| `firestore` (optional) | Yes | Yes (distributed) | Atomic document CAS & refresh lease | Cloud Firestore TTL policy |',
    '| `memory` (test/ephemeral) | No | No (single process) | In-process Map/Set memory isolation | In-process sweep on interval |',
  ].join('\n');

  // 4. Firestore collections table
  const collections = firestoreCollections('<namespace>');
  const firestoreCollectionsTable = [
    '| Collection Name | Document Contents | TTL Field | Lifecycle / Retention |',
    '|---|---|---|---|',
    `| \`${collections.sessions}\` | Encrypted access tokens & family bindings | \`ttlAt\` | Cleaned up after 30 days access retention |`,
    `| \`${collections.refreshTokens}\` | Refresh token pointers & successor states | None | Permanent until explicit revocation or replay |`,
    `| \`${collections.refreshFamilies}\` | Refresh family generation & client bindings | None | Permanent until explicit revocation or replay |`,
    `| \`${collections.upstreamGrants}\` | Encrypted NetSapiens credentials & leases | None | Permanent until explicit revocation |`,
    `| \`${collections.authCodes}\` | PKCE authorization codes | \`ttlAt\` | Single-use, expires in 5 minutes |`,
    `| \`${collections.resumeTokens}\` | MCP resumption nonces | \`ttlAt\` | Single-use, expires in 2 hours |`,
    `| \`${collections.oauthClients}\` | Registered OAuth clients | None | Persistent client configurations |`,
    `| \`${collections.usage}\` | User rate-limiting counters | None | Persistent call count telemetry |`,
  ].join('\n');

  // 5. Full environment variables table
  const allEnvTable = [
    '| Variable | Transports | Required | Default | Description |',
    '|---|---|---|---|---|',
    ...ENV_VARS.map(
      (v) =>
        `| \`${v.name}\` | ${v.transports.join(', ')} | ${v.required ? 'Yes' : 'No'} | ${v.default ? `\`${v.default}\`` : 'None'} | ${v.effect} |`,
    ),
  ].join('\n');

  // 6. Roles hierarchy table
  const rolesTable = [
    '| Role Tier | Priority | NetSapiens User Scopes |',
    '|---|---|---|',
    '| `system_admin` | 4 | Super User, System Admin |',
    '| `reseller` | 3 | Reseller |',
    '| `domain_admin` | 2 | Office Manager, Site Manager, Domain Admin, Call Center Supervisor |',
    '| `user` | 1 | Call Center Agent, Advanced User, Basic User, Simple User, No Portal |',
  ].join('\n');

  // 6. Lib exports
  const libSrc = readFileSync(path.join(repoRoot, 'src/lib.ts'), 'utf8');
  const libExports: string[] = [];
  const exportMatches = libSrc.matchAll(/export\s+\{([^}]+)\}/g);
  for (const match of exportMatches) {
    const rawNames = match[1].split(',');
    for (const name of rawNames) {
      const trimmed = name.trim();
      if (trimmed) libExports.push(trimmed);
    }
  }

  return {
    toolCounts: {
      v2Total,
      v1Total,
      curatedTotal,
      metaTotal,
    },
    versionMatrix,
    backendsTable,
    firestoreCollectionsTable,
    envTable: allEnvTable,
    rolesTable,
    libExports,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const facts = generateReadmeFacts();
  console.log(JSON.stringify(facts, null, 2));
}
