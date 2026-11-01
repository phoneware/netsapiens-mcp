#!/usr/bin/env tsx

/**
 * NetSapiens Availability Diff CLI
 *
 * Compares `src/generated/availability.json` between two Git revisions.
 * Prints a summary of count changes and flipped keys as Markdown.
 *
 * Usage:
 *   tsx scripts/availability-diff.ts <base> <head>
 */

import { execSync } from 'node:child_process';
import type { AvailabilityData } from './generate-availability.js';

function readAvailabilityAtRef(ref: string): AvailabilityData {
  try {
    const raw = execSync(`git show ${ref}:src/generated/availability.json`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 50 * 1024 * 1024,
    });
    return JSON.parse(raw) as AvailabilityData;
  } catch (err) {
    throw new Error(`Failed to read src/generated/availability.json at ref '${ref}': ${(err as Error).message}`);
  }
}

export function diffAvailability(baseData: AvailabilityData, headData: AvailabilityData): string {
  const baseBranches = baseData.branches ?? [];
  const headBranches = headData.branches ?? [];

  const baseV2Keys = Object.keys(baseData.v2 ?? {});
  const headV2Keys = Object.keys(headData.v2 ?? {});

  const baseV1Keys = Object.keys(baseData.v1 ?? {});
  const headV1Keys = Object.keys(headData.v1 ?? {});

  // Compute baseline (keys present in all branches)
  const isBaseBaseline = (entry: { branches?: string[]; documented?: string[] }) => {
    const b = entry.documented ?? entry.branches ?? [];
    return baseBranches.length > 0 && baseBranches.every((br) => b.includes(br));
  };
  const isHeadBaseline = (entry: { branches?: string[]; documented?: string[] }) => {
    const b = entry.documented ?? entry.branches ?? [];
    return headBranches.length > 0 && headBranches.every((br) => b.includes(br));
  };

  const baseBaselineCount = baseV2Keys.filter((k) => isBaseBaseline(baseData.v2[k])).length;
  const headBaselineCount = headV2Keys.filter((k) => isHeadBaseline(headData.v2[k])).length;

  const baseSet = new Set(baseV2Keys);
  const headSet = new Set(headV2Keys);

  const addedKeys = headV2Keys.filter((k) => !baseSet.has(k)).sort();
  const removedKeys = baseV2Keys.filter((k) => !headSet.has(k)).sort();

  // Keys present in both with branch or observation differences
  const changedDocumentation: Array<{
    key: string;
    baseBranches: string[];
    headBranches: string[];
  }> = [];

  const changedObservations: Array<{
    key: string;
    version: string;
    baseStatus?: string;
    headStatus?: string;
  }> = [];

  for (const k of headV2Keys) {
    if (baseSet.has(k)) {
      const baseEntry = baseData.v2[k];
      const headEntry = headData.v2[k];

      const baseB = (baseEntry.documented ?? baseEntry.branches ?? []).slice().sort().join(', ');
      const headB = (headEntry.documented ?? headEntry.branches ?? []).slice().sort().join(', ');
      if (baseB !== headB) {
        changedDocumentation.push({
          key: k,
          baseBranches: baseEntry.documented ?? baseEntry.branches ?? [],
          headBranches: headEntry.documented ?? headEntry.branches ?? [],
        });
      }

      const allObsVersions = Array.from(
        new Set([...Object.keys(baseEntry.observed ?? {}), ...Object.keys(headEntry.observed ?? {})]),
      ).sort();

      for (const ver of allObsVersions) {
        const baseStatus = baseEntry.observed?.[ver];
        const headStatus = headEntry.observed?.[ver];
        if (baseStatus !== headStatus) {
          changedObservations.push({
            key: k,
            version: ver,
            baseStatus,
            headStatus,
          });
        }
      }
    }
  }

  // Build Markdown
  const lines: string[] = [];
  lines.push('# Availability Diff');
  lines.push('');
  lines.push('## Summary Counts');
  lines.push('');
  lines.push('| Metric | Base | Head | Delta |');
  lines.push('|---|---|---|---|');

  const fmtDelta = (delta: number) => (delta > 0 ? `+${delta}` : `${delta}`);
  lines.push(`| v2 Total Keys | ${baseV2Keys.length} | ${headV2Keys.length} | ${fmtDelta(headV2Keys.length - baseV2Keys.length)} |`);
  lines.push(`| v2 Baseline Keys | ${baseBaselineCount} | ${headBaselineCount} | ${fmtDelta(headBaselineCount - baseBaselineCount)} |`);
  lines.push(`| v1 Total Keys | ${baseV1Keys.length} | ${headV1Keys.length} | ${fmtDelta(headV1Keys.length - baseV1Keys.length)} |`);
  lines.push(`| Observations | ${(baseData.observations ?? []).length} | ${(headData.observations ?? []).length} | ${fmtDelta((headData.observations ?? []).length - (baseData.observations ?? []).length)} |`);
  lines.push('');

  lines.push('## Flipped Keys');
  lines.push('');
  lines.push(`- **Added v2 Keys:** ${addedKeys.length}`);
  lines.push(`- **Removed v2 Keys:** ${removedKeys.length}`);
  lines.push(`- **Documentation Changes:** ${changedDocumentation.length}`);
  lines.push(`- **Observation Flips:** ${changedObservations.length}`);
  lines.push('');

  if (addedKeys.length > 0) {
    lines.push('### Added Keys');
    lines.push('');
    for (const k of addedKeys.slice(0, 50)) {
      lines.push(`- \`${k}\``);
    }
    if (addedKeys.length > 50) {
      lines.push(`- ... and ${addedKeys.length - 50} more`);
    }
    lines.push('');
  }

  if (removedKeys.length > 0) {
    lines.push('### Removed Keys');
    lines.push('');
    for (const k of removedKeys.slice(0, 50)) {
      lines.push(`- \`${k}\``);
    }
    if (removedKeys.length > 50) {
      lines.push(`- ... and ${removedKeys.length - 50} more`);
    }
    lines.push('');
  }

  if (changedDocumentation.length > 0) {
    lines.push('### Changed Branch Documentation');
    lines.push('');
    for (const item of changedDocumentation.slice(0, 30)) {
      lines.push(`- \`${item.key}\`: [${item.baseBranches.join(', ')}] -> [${item.headBranches.join(', ')}]`);
    }
    if (changedDocumentation.length > 30) {
      lines.push(`- ... and ${changedDocumentation.length - 30} more`);
    }
    lines.push('');
  }

  if (changedObservations.length > 0) {
    lines.push('### Observation Status Flips');
    lines.push('');
    for (const item of changedObservations.slice(0, 30)) {
      lines.push(`- \`${item.key}\` (${item.version}): ${item.baseStatus ?? 'none'} -> ${item.headStatus ?? 'none'}`);
    }
    if (changedObservations.length > 30) {
      lines.push(`- ... and ${changedObservations.length - 30} more`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function main(): void {
  const baseRef = process.argv[2];
  const headRef = process.argv[3];

  if (!baseRef || !headRef) {
    console.error('Usage: tsx scripts/availability-diff.ts <base> <head>');
    process.exit(1);
  }

  const baseData = readAvailabilityAtRef(baseRef);
  const headData = readAvailabilityAtRef(headRef);

  const report = diffAvailability(baseData, headData);
  console.log(report);
}

if (process.argv[1] && process.argv[1].endsWith('availability-diff.ts')) {
  main();
}
