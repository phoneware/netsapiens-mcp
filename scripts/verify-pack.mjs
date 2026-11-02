#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_ENTRIES = [
  'package/build/index.js',
  'package/build/lib.js',
  'package/build/store/conformance.js',
  'package/build/store/conformance.d.ts',
  'package/CHANGELOG.md',
  'package/LICENSE',
  'package/README.md',
  'package/build/generated/availability.json',
];

export function listTarballEntries(tarballPath) {
  const stdout = execFileSync('tar', ['-ztf', tarballPath], { encoding: 'utf8' });
  return stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/^\.\//, ''));
}

export function extractPackageJson(tarballPath, entries) {
  const pkgEntry = entries.find(e => e === 'package/package.json' || e.endsWith('/package.json'));
  if (!pkgEntry) {
    throw new Error('package/package.json not found in tarball');
  }
  let stdout;
  try {
    stdout = execFileSync('tar', ['-xzf', tarballPath, '-O', pkgEntry], { encoding: 'utf8' });
  } catch {
    stdout = execFileSync('tar', ['-zxOf', tarballPath, pkgEntry], { encoding: 'utf8' });
  }
  return JSON.parse(stdout);
}

export function verifyPack(tarballPath, options = {}) {
  const results = [];
  const pass = msg => results.push({ status: 'PASS', message: msg });
  const fail = msg => results.push({ status: 'FAIL', message: msg });

  if (!fs.existsSync(tarballPath)) {
    fail(`tarball not found at ${tarballPath}`);
    return { ok: false, results };
  }

  let entries;
  try {
    entries = listTarballEntries(tarballPath);
    pass(`tarball opened: ${entries.length} entries`);
  } catch (err) {
    fail(`failed to list tarball entries: ${err.message}`);
    return { ok: false, results };
  }

  // 1. Required entries present
  for (const req of REQUIRED_ENTRIES) {
    if (entries.includes(req)) {
      pass(`required entry present: ${req}`);
    } else {
      fail(`required entry missing: ${req}`);
    }
  }

  // 2. Forbidden entries absent
  // - package/build/__tests__/**
  const testsEntries = entries.filter(e =>
    e.startsWith('package/build/__tests__/') ||
    e === 'package/build/__tests__' ||
    e.includes('/__tests__/')
  );
  if (testsEntries.length > 0) {
    fail(`forbidden entries present (__tests__): ${testsEntries.join(', ')}`);
  } else {
    pass('forbidden entries absent: __tests__/**');
  }

  // - package/src/**
  const srcEntries = entries.filter(e => e.startsWith('package/src/') || e === 'package/src');
  if (srcEntries.length > 0) {
    fail(`forbidden entries present (src/**): ${srcEntries.join(', ')}`);
  } else {
    pass('forbidden entries absent: src/**');
  }

  // - package/spec/**
  const specEntries = entries.filter(e => e.startsWith('package/spec/') || e === 'package/spec' || e.includes('/spec/'));
  if (specEntries.length > 0) {
    fail(`forbidden entries present (spec/**): ${specEntries.join(', ')}`);
  } else {
    pass('forbidden entries absent: spec/**');
  }

  // - package/scripts/**
  const scriptsEntries = entries.filter(e => e.startsWith('package/scripts/') || e === 'package/scripts');
  if (scriptsEntries.length > 0) {
    fail(`forbidden entries present (scripts/**): ${scriptsEntries.join(', ')}`);
  } else {
    pass('forbidden entries absent: scripts/**');
  }

  // - package/docs/**
  const docsEntries = entries.filter(e => e.startsWith('package/docs/') || e === 'package/docs');
  if (docsEntries.length > 0) {
    fail(`forbidden entries present (docs/**): ${docsEntries.join(', ')}`);
  } else {
    pass('forbidden entries absent: docs/**');
  }

  // - any *.node file
  const nodeEntries = entries.filter(e => e.endsWith('.node'));
  if (nodeEntries.length > 0) {
    fail(`forbidden entries present (*.node): ${nodeEntries.join(', ')}`);
  } else {
    pass('forbidden entries absent: *.node');
  }

  // - any *.ts file (except *.d.ts)
  const tsEntries = entries.filter(e => e.endsWith('.ts') && !e.endsWith('.d.ts'));
  if (tsEntries.length > 0) {
    fail(`forbidden entries present (*.ts non-dts): ${tsEntries.join(', ')}`);
  } else {
    pass('forbidden entries absent: *.ts (non-d.ts)');
  }

  // - any .env* file
  const envEntries = entries.filter(e => /(^|\/)\.env/i.test(e));
  if (envEntries.length > 0) {
    fail(`forbidden entries present (.env*): ${envEntries.join(', ')}`);
  } else {
    pass('forbidden entries absent: .env*');
  }

  // 3. Packed package.json checks
  let pkg;
  try {
    pkg = extractPackageJson(tarballPath, entries);
    pass('extracted package.json');
  } catch (err) {
    fail(`failed to extract package.json: ${err.message}`);
    return { ok: false, results };
  }

  // Version check
  let expectedVersion = options.expectedVersion ||
    process.argv[3] ||
    process.env.VERSION ||
    process.env.TAG ||
    (process.env.GITHUB_REF_NAME ? process.env.GITHUB_REF_NAME.replace(/^v/, '') : undefined);

  if (!expectedVersion) {
    // If not explicitly provided, try extracting from tarball filename if it ends with -<semver>.tgz
    const m = path.basename(tarballPath).match(/^.+-(\d+\.\d+\.\d+.*)\.tgz$/);
    if (m) {
      expectedVersion = m[1];
    }
  }

  if (expectedVersion) {
    const cleanExpected = expectedVersion.replace(/^v/, '');
    if (pkg.version === cleanExpected) {
      pass(`version matches expected: ${pkg.version}`);
    } else {
      fail(`version mismatch: package.json has "${pkg.version}", expected "${cleanExpected}"`);
    }
  } else {
    if (pkg.version) {
      pass(`package.json version present: ${pkg.version}`);
    } else {
      fail('package.json missing version');
    }
  }

  // dependencies does NOT include @google-cloud/firestore
  if (pkg.dependencies && '@google-cloud/firestore' in pkg.dependencies) {
    fail('dependencies must NOT include @google-cloud/firestore');
  } else {
    pass('dependencies does not include @google-cloud/firestore');
  }

  // peerDependencies includes @google-cloud/firestore and vitest, both with peerDependenciesMeta optional: true
  const peers = pkg.peerDependencies || {};
  const meta = pkg.peerDependenciesMeta || {};

  const firestoreInPeers = '@google-cloud/firestore' in peers;
  const vitestInPeers = 'vitest' in peers;
  const firestoreOptional = meta['@google-cloud/firestore']?.optional === true;
  const vitestOptional = meta['vitest']?.optional === true;

  if (firestoreInPeers && vitestInPeers && firestoreOptional && vitestOptional) {
    pass('peerDependencies and optional peerDependenciesMeta valid for @google-cloud/firestore and vitest');
  } else {
    if (!firestoreInPeers) fail('peerDependencies missing @google-cloud/firestore');
    if (!vitestInPeers) fail('peerDependencies missing vitest');
    if (!firestoreOptional) fail('peerDependenciesMeta["@google-cloud/firestore"].optional must be true');
    if (!vitestOptional) fail('peerDependenciesMeta["vitest"].optional must be true');
  }

  // exports includes "./testing/store-conformance"
  if (pkg.exports && pkg.exports['./testing/store-conformance']) {
    pass('exports includes "./testing/store-conformance"');
  } else {
    fail('exports missing "./testing/store-conformance"');
  }

  // repository.url check
  const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const validUrls = [
    'https://github.com/phoneware/netsapiens-mcp.git',
    'git+https://github.com/phoneware/netsapiens-mcp.git',
  ];
  if (repoUrl && validUrls.includes(repoUrl)) {
    pass(`repository.url is valid: ${repoUrl}`);
  } else {
    fail(`repository.url must be "https://github.com/phoneware/netsapiens-mcp.git" or "git+https://github.com/phoneware/netsapiens-mcp.git", got "${repoUrl}"`);
  }

  const ok = results.every(r => r.status === 'PASS');
  return { ok, results };
}

function runCli() {
  const tarballPath = process.argv[2];
  if (!tarballPath) {
    console.error('Usage: verify-pack.mjs <tarball-path> [expected-version]');
    process.exit(1);
  }

  const { ok, results } = verifyPack(tarballPath);
  for (const r of results) {
    console.log(`${r.status} ${r.message}`);
  }

  process.exit(ok ? 0 : 1);
}

const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('verify-pack.mjs') ||
  process.argv[1].endsWith('verify-pack.js') ||
  (import.meta.url && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
);

if (isDirectRun) {
  runCli();
}
