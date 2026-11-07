// Test-only SYNTHETIC closed-scope bundle. The production bundle keeps the reviewed scope open
// (complete:false, unscanned sources listed). For positive runner proofs only, this returns an in-memory copy
// of the built bundle whose scope is closed (complete:true, unscanned empty). Nothing is written to the
// repository, the production core, or any shared record; the bytes are mounted only at the fixed container
// paths under the container gate. The production bundle stays open, so production still refuses.
//
// The mutation anchor must match exactly once in the built bundle, so a changed bundle fails loudly.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const PRODUCTION_BUNDLE = resolve(here, '..', '..', 'cutover-protocol.mjs');
export const OPEN_SCOPE_TEXT = 'complete: false,\n    unscanned: Object.freeze(["sibling services", "terraform", "workflows"]),';
export const CLOSED_SCOPE_TEXT = 'complete: true,\n    unscanned: Object.freeze([]),';

export function productionBundleBytes() {
  return readFileSync(PRODUCTION_BUNDLE);
}

export function closedBundleBytes() {
  const text = productionBundleBytes().toString('utf8');
  const count = text.split(OPEN_SCOPE_TEXT).length - 1;
  if (count !== 1) throw new Error(`open scope anchor matched ${count} times; the synthetic closed bundle needs exactly one`);
  return Buffer.from(text.replace(OPEN_SCOPE_TEXT, CLOSED_SCOPE_TEXT), 'utf8');
}
