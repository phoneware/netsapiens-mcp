// CI-only negative controls. This changes a disposable copy, never the checkout.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const [fileArg, mutation] = process.argv.slice(2);
if (!fileArg || !process.env.RUNNER_TEMP) throw new Error('A disposable RUNNER_TEMP and bundle path are required');
const root = realpathSync(process.env.RUNNER_TEMP);
const file = realpathSync(fileArg);
if (!file.startsWith(`${root}${sep}`) || !file.endsWith(`${sep}src${sep}store${sep}cutover-protocol.mjs`)) {
  throw new Error('Mutation target must be a disposable bundle under RUNNER_TEMP');
}
const mutations = {
  'first-write-latch': [['if (!control.irreversible) {', 'if (false) {']],
  'malformed-marker': [
    ['validateMigrationIdentityFields(m, namespace, expectedEpoch, migrationRunId);', 'void m;'],
    ['if (f[k] !== p[k] || m[k] !== p[k]) {', 'if (f[k] !== p[k]) {'],
  ],
  'unexpected-target': [['if (!expectedWrittenTargets.has(targetKey)) {', 'if (false) {']],
  'finalization-latch': [['if (markerDoc.emptyNamespace !== true && !control.irreversible) {', 'if (false) {']],
};
if (!Object.hasOwn(mutations, mutation)) throw new Error('Unknown proof mutation');
let content = readFileSync(file, 'utf8');
for (const [before, after] of mutations[mutation]) {
  if (content.split(before).length !== 2) throw new Error(`Mutation anchor is not unique: ${mutation}`);
  content = content.replace(before, after);
}
writeFileSync(file, content);
