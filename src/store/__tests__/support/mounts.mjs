// Test-only guard for the protected factory's fixed mounts. The factory reads only /opt/cutover and
// /run/cutover, so these suites can run only where those paths belong to the suite. The gate is
// explicit: a disposable container with the marker, or CI. A host that already has either mount is
// refused, and the suite never removes a mount it did not create.
import { existsSync, rmSync } from 'node:fs';

export const OPT = '/opt/cutover';
export const RUN = '/run/cutover';

export function containerGateOpen() {
  return process.env.NETSAPIENS_CUTOVER_CONTAINER === '1' &&
    (process.env.CI === 'true' || process.env.NETSAPIENS_CUTOVER_TEMP_CONTAINER === '1');
}

export function assertCanOwnMounts() {
  if (existsSync(OPT) || existsSync(RUN)) {
    throw new Error(`${OPT} or ${RUN} already exists; refusing to touch host mounts. Run this suite only in a disposable container or CI.`);
  }
}

// Removes the mounts. Callers invoke this only after assertCanOwnMounts() succeeded for this run.
export function releaseMounts() {
  rmSync(OPT, { recursive: true, force: true });
  rmSync(RUN, { recursive: true, force: true });
}
