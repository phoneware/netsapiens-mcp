#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Extract markdown content under `## <version>` heading up to the next `## ` heading or EOF.
 * Returns trimmed markdown string, or null if version is not found.
 */
export function extractChangelogSection(content, version) {
 if (!version) {
  throw new Error('Version argument is required');
 }
 const cleanVersion = version.replace(/^v/, '');
 const escapedVersion = cleanVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

 // Matches an h2 heading for the version:
 // e.g. ## 3.0.0, ## [3.0.0], ## v3.0.0, ## [v3.0.0] - 2026-10-31, etc.
 const headingRegex = new RegExp(
  `^##\\s+(?:\\[)?v?${escapedVersion}(?:\\])?(?:[\\t ].*)?$`,
  'm'
 );

 const match = headingRegex.exec(content);
 if (!match) {
  return null;
 }

 const startIdx = match.index + match[0].length;
 const rest = content.slice(startIdx);

 // Look for the next h2 heading (starting with `## ` at line start)
 const nextHeadingRegex = /^##\s+/m;
 const nextMatch = nextHeadingRegex.exec(rest);

 const sectionRaw = nextMatch ? rest.slice(0, nextMatch.index) : rest;
 return sectionRaw.trim();
}

function runCli() {
 const version = process.argv[2];
 if (!version) {
  console.error('Usage: changelog-section.mjs <version> [changelog-path]');
  process.exit(1);
 }

 const changelogPath = process.argv[3] || process.env.CHANGELOG_PATH || path.resolve(process.cwd(), 'CHANGELOG.md');
 if (!fs.existsSync(changelogPath)) {
  console.error(`Error: CHANGELOG.md not found at ${changelogPath}`);
  process.exit(1);
 }

 const content = fs.readFileSync(changelogPath, 'utf8');
 const section = extractChangelogSection(content, version);

 if (section === null) {
  console.error(`Error: Version ${version} not found in ${changelogPath}`);
  process.exit(1);
 }

 console.log(section);
}

const isDirectRun = process.argv[1] && (
 process.argv[1].endsWith('changelog-section.mjs') ||
 process.argv[1].endsWith('changelog-section.js') ||
 (import.meta.url && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
);

if (isDirectRun) {
 runCli();
}
