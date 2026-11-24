import { toolRegistry } from '../src/generated/registry.js';
import { v1ToolRegistry } from '../src/generated/v1/registry.js';
import { OPERATION_OUTPUTS } from '../src/governance/operation-outputs.generated.js';
import { OPERATION_OUTPUTS as OLD_OUTPUTS } from '/tmp/slice-b/r1/old-ops.ts';

let v2 = 0;
let unclassifiedNow = 0;
let unclassifiedBefore = 0;
for (const def of toolRegistry.values()) {
  v2 += 1;
  const key = def.operation?.key;
  if (key === undefined || !Object.hasOwn(OPERATION_OUTPUTS, key)) unclassifiedNow += 1;
  if (key === undefined || !Object.hasOwn(OLD_OUTPUTS, key)) unclassifiedBefore += 1;
}
const v1 = v1ToolRegistry.size;
console.log(
  JSON.stringify({
    generatedV2: v2,
    generatedV1: v1,
    mappedKeysNow: Object.keys(OPERATION_OUTPUTS).length,
    mappedKeysBefore: Object.keys(OLD_OUTPUTS).length,
    unclassifiedNow: unclassifiedNow + v1,
    unclassifiedBefore: unclassifiedBefore + v1,
  }),
);
