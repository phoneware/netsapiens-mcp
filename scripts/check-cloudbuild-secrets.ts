#!/usr/bin/env tsx

/**
 * CLI script to validate cloudbuild.yaml against literal secret assignments.
 *
 * Exits with code 1 if violations are found.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { validateCloudBuildSecrets } from '../src/utils/cloudbuild-validator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const repoRoot = resolve(__dirname, '../');
const targetFile = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : resolve(repoRoot, 'cloudbuild.yaml');

if (!existsSync(targetFile)) {
 console.error(`File not found: ${targetFile}`);
 process.exit(1);
}

const content = readFileSync(targetFile, 'utf8');
const violations = validateCloudBuildSecrets(content);

if (violations.length > 0) {
 console.error(`❌ Found ${violations.length} secret violation(s) in ${targetFile}:\n`);
 for (const v of violations) {
  console.error(`  Line ${v.line}: Key '${v.key}' - ${v.reason}`);
 }
 console.error('\nEnvironment variables containing SECRET|PASSWORD|TOKEN|KEY must reference Secret Manager via --update-secrets (e.g. KEY=secret-name:latest).');
 process.exit(1);
} else {
 console.log(`✅ ${targetFile} passes all secret checks (no plaintext secrets).`);
 process.exit(0);
}
