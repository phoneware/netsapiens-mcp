// CI-only negative controls. This changes a disposable copy, never the checkout.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const [fileArg, mutation] = process.argv.slice(2);
if (!fileArg || !process.env.RUNNER_TEMP) throw new Error('A disposable RUNNER_TEMP and mutation path are required');
const root = realpathSync(process.env.RUNNER_TEMP);
const file = realpathSync(fileArg);
const suffix = mutation === 'first-write-latch'
  ? `${sep}src${sep}cutover${sep}canonical-core.mjs`
  : mutation === 'private-first-write-latch'
    ? `${sep}private${sep}cutover-protocol.mjs`
    : `${sep}src${sep}store${sep}cutover-protocol.mjs`;
if (!file.startsWith(`${root}${sep}`) || !file.endsWith(suffix)) {
  throw new Error('Mutation target must be the named disposable source or bundle under RUNNER_TEMP');
}
const mutations = {
  'first-write-latch': [['if (!control.irreversible) {', 'if (false) {']],
  'private-first-write-latch': [['if (!control.irreversible) {', 'if (false) {']],
  'malformed-marker': [
    ['validateMigrationIdentityFields(m, namespace, expectedEpoch, migrationRunId);', 'void m;'],
    ['if (f[k] !== p[k] || m[k] !== p[k]) {', 'if (f[k] !== p[k]) {'],
  ],
  'unexpected-target': [[
    'if (!expectedWrittenTargets.has(targetKey)) {\n      throw new CutoverFenceError(`Cannot activate: extra target document',
    'if (false) {\n      throw new CutoverFenceError(`Cannot activate: extra target document',
  ]],
  'finalization-latch': [['if (markerDoc.emptyNamespace !== true && !control.irreversible) {', 'if (false) {']],
};
if (!Object.hasOwn(mutations, mutation)) throw new Error('Unknown proof mutation');
let content = readFileSync(file, 'utf8');
for (const [before, after] of mutations[mutation]) {
  if (content.split(before).length !== 2) throw new Error(`Mutation anchor is not unique: ${mutation}`);
  content = content.replace(before, after);
}
writeFileSync(file, content);
