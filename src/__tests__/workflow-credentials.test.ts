import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflows = {
  ci: readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'),
  cutover: readFileSync(resolve(root, '.github/workflows/cutover-proof.yml'), 'utf8'),
};

// Fail closed on unfamiliar YAML layouts rather than overlooking a checkout.
const checkoutPattern = /^      - uses: actions\/checkout@(?:v4|11d5960a326750d5838078e36cf38b85af677262)[ \t]*\n([\s\S]*?)(?=^      - |^  [\w-]+:|(?![\s\S]))/gm;

function checkWorkflow(source: string): void {
  const beforeJobs = source.split(/^jobs:[ \t]*$/m);
  expect(beforeJobs).toHaveLength(2);
  const permissionBlock = beforeJobs[0].match(/^permissions:[^\n]*\n[\s\S]*$/m);
  expect(permissionBlock?.[0].trimEnd()).toBe('permissions:\n  contents: read');
  expect(source.match(/^\s*permissions:/gm)).toHaveLength(1);

  const checkouts = [...beforeJobs[1].matchAll(checkoutPattern)];
  expect(checkouts.length).toBeGreaterThan(0);
  expect(source.match(/actions\/checkout/g)).toHaveLength(checkouts.length);
  for (const [, inputs] of checkouts) {
    const lines = inputs.trimEnd().split('\n');
    expect(lines.shift()).toBe('        with:');
    const keys = lines.map((line) => {
      const input = line.match(/^          ([\w-]+): (\S+)$/);
      expect(input).not.toBeNull();
      return input![1];
    });
    expect(new Set(keys).size).toBe(keys.length);
    expect(lines.filter((line) => line.includes('persist-credentials'))).toEqual(['          persist-credentials: false']);
  }
}

describe('workflow checkout credential boundaries', () => {
  for (const [name, source] of Object.entries(workflows)) {
    it(`${name} has read-only permissions and unpersisted checkout credentials`, () => {
      checkWorkflow(source);
    });

    it(`${name} rejects unsafe permission and checkout mutations`, () => {
      expect(() => checkWorkflow(source.replace(/^permissions:[ \t]*\n  contents: read[ \t]*\n/m, ''))).toThrow();
      expect(() => checkWorkflow(source.replace('  contents: read', '  contents: read\n  id-token: write'))).toThrow();
      expect(() => checkWorkflow(source.replace('          persist-credentials: false', '          persist-credentials: false\n          persist-credentials: true'))).toThrow();
      expect(() => checkWorkflow(source.replace('- uses: actions/checkout@v4', '- name: checkout\n        uses: actions/checkout@v4'))).toThrow();
      expect(() => checkWorkflow(source.replace('actions/checkout@v4', 'actions/checkout@v5'))).toThrow();
      const restrictions = [...source.matchAll(/^          persist-credentials: false[ \t]*$/gm)];
      expect(restrictions.length).toBeGreaterThan(0);
      for (const restriction of restrictions) {
        const mutated = source.slice(0, restriction.index) + source.slice(restriction.index! + restriction[0].length);
        expect(() => checkWorkflow(mutated)).toThrow();
      }
    });
  }
});

describe('isolated proof dispatch routing', () => {
  const jobs = ['test', 'consumer', 'consumer-firestore', 'docker', 'windows'];
  const ordinary = "${{ github.event_name != 'workflow_dispatch' || !inputs.isolated_proof }}";
  const aggregate = "${{ always() && (github.event_name != 'workflow_dispatch' || !inputs.isolated_proof) }}";
  const isolated = "${{ github.event_name == 'workflow_dispatch' && inputs.isolated_proof }}";
  const jobBody = (source: string, job: string) => source.match(new RegExp(`^  ${job}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|$(?![\\s\\S]))`, 'm'))?.[1];
  function checkRouting(source: string) {
    for (const job of jobs) expect(jobBody(source, job)).toContain(`    if: ${ordinary}\n`);
    expect(jobBody(source, 'ci')).toContain(`    if: ${aggregate}\n`);
    expect(jobBody(source, 'isolated-proof')).toContain(`    if: ${isolated}\n`);
  }
  it('keeps the ordinary jobs and isolated proof mutually exclusive on proof dispatch', () => {
    checkRouting(workflows.ci);
  });
  it('rejects a missing gate on each job', () => {
    for (const job of [...jobs, 'ci', 'isolated-proof']) {
      const body = jobBody(workflows.ci, job)!;
      const mutated = body.replace(/^    if:.*\n/m, '');
      expect(mutated).not.toBe(body);
      expect(() => checkRouting(workflows.ci.replace(body, mutated))).toThrow();
    }
  });
});
