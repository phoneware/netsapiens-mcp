import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8');

// Only these commits may be referenced. They are the planner's pins.
const PINS: Record<string, true> = {
  'actions/checkout@11d5960a326750d5838078e36cf38b85af677262': true,
  'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020': true,
  'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02': true,
  'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093': true,
  'actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be': true,
};

const HEADER = [
  'name: Release',
  '',
  'on:',
  '  push:',
  '    tags:',
  "      - 'v*.*.*'",
  '  workflow_dispatch:',
  '    inputs:',
  '      version:',
  "        description: 'Version to rehearse. A dispatch never publishes.'",
  '        type: string',
  '        required: true',
  '',
  'permissions: {}',
  '',
  'concurrency:',
  '  group: release-${{ github.ref }}',
  '  cancel-in-progress: false',
  '',
  '',
].join('\n');

const TAG_PUSH = "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')";
const DISPATCH = "github.event_name == 'workflow_dispatch'";
const REGISTRY = '--registry https://registry.npmjs.org/';
const NAME_CHECK = 'test "$TARBALL" = "netsapiens-mcp-$VERSION.tgz"';

// Matches a command only where a shell starts one: line start, after a run key, after ; & | ( or a case pattern.
// Words inside quoted JavaScript (for example "npm version") and step names are not commands.
const NPM_CMD = /(?:^[ \t-]*(?:run: )?|[;&|(]\s*|\)\s+)npm (-{0,2}[a-z][a-z-]*)/gm;
const NODE_CMD = /(?:^[ \t-]*(?:run: )?|[;&|(]\s*|\)\s+)node (-[a-z]|[\w./-]+)/gm;

type Spec = {
  runsOn: string;
  needs: string[];
  when?: string;
  environment?: string;
  permissions: Record<string, string>;
  checkouts: number;
  npm?: string[];
  node?: string[];
};

// The authority map from the planner: who runs what, with which token.
const SPEC: Record<string, Spec> = {
  build: {
    runsOn: 'ubicloud-standard-2',
    needs: [],
    permissions: { contents: 'read', checks: 'read' },
    checkouts: 1,
  },
  scan: {
    runsOn: 'ubuntu-24.04',
    needs: ['build'],
    permissions: { contents: 'read' },
    checkouts: 1,
    npm: [],
    node: ['scripts/release-gate.mjs', 'scripts/scan-forbidden.mjs'],
  },
  publish: {
    runsOn: 'ubuntu-24.04',
    needs: ['build', 'scan'],
    when: TAG_PUSH,
    environment: 'npm-publish',
    permissions: { contents: 'read', checks: 'read', 'id-token': 'write', attestations: 'write' },
    checkouts: 1,
    npm: ['publish'],
    node: ['-e', 'scripts/release-gate.mjs'],
  },
  'verify-registry': {
    runsOn: 'ubuntu-24.04',
    needs: ['build', 'publish'],
    when: TAG_PUSH,
    permissions: {},
    checkouts: 0,
    npm: ['init', 'install', 'pack', 'audit'],
    node: ['-p'],
  },
  'github-release': {
    runsOn: 'ubuntu-24.04',
    needs: ['build', 'publish', 'verify-registry'],
    when: TAG_PUSH,
    permissions: { contents: 'write' },
    checkouts: 0,
    npm: [],
    node: [],
  },
  rehearse: {
    runsOn: 'ubuntu-24.04',
    needs: ['build', 'scan'],
    when: DISPATCH,
    permissions: { contents: 'read', checks: 'read' },
    checkouts: 1,
    npm: ['publish'],
    node: ['-e', 'scripts/release-gate.mjs'],
  },
};

const count = (text: string, needle: string): number => text.split(needle).length - 1;
const matches = (text: string, re: RegExp): RegExpMatchArray[] => [...text.matchAll(re)];
const commandsOf = (body: string, re: RegExp): string[] => matches(body, re).map((m) => m[1]!);

function jobBodies(text: string): Map<string, string> {
  const at = text.indexOf('\njobs:\n');
  if (at < 0) throw new Error('no jobs block');
  expect(text.slice(0, at + 1)).toBe(HEADER);
  const rest = text.slice(at + '\njobs:\n'.length);
  if (/^\S/m.test(rest)) throw new Error('unexpected top-level key after jobs');
  const heads = matches(rest, /^  ([a-z][a-z-]*):\n/gm);
  const jobs = new Map<string, string>();
  heads.forEach((head, i) => {
    const start = head.index! + head[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index! : rest.length;
    jobs.set(head[1]!, rest.slice(start, end));
  });
  if (jobs.size !== heads.length) throw new Error('duplicate job name');
  return jobs;
}

function field(body: string, key: string): string | undefined {
  const found = matches(body, new RegExp(`^    ${key}: (.+)$`, 'gm'));
  if (found.length > 1) throw new Error(`duplicate ${key}`);
  return found[0]?.[1];
}

function needsOf(body: string): string[] {
  const list = body.match(/^    needs: \[([^\]]*)\]$/m);
  if (list) return list[1]!.split(',').map((item) => item.trim());
  const single = field(body, 'needs');
  return single ? [single] : [];
}

function permissionsOf(body: string): Record<string, string> {
  const inline = body.match(/^    permissions: \{([^}]*)\}$/m);
  if (!inline) throw new Error('job has no inline permissions');
  const inner = inline[1]!.trim();
  if (!inner) return {};
  return Object.fromEntries(inner.split(',').map((pair) => pair.trim().split(': ') as [string, string]));
}

function inOrder(body: string, needles: string[]): void {
  let last = -1;
  for (const needle of needles) {
    expect(count(body, needle)).toBe(1);
    const at = body.indexOf(needle);
    expect(at).toBeGreaterThan(last);
    last = at;
  }
}

function checkWorkflow(text: string): void {
  const jobs = jobBodies(text);
  expect([...jobs.keys()].sort()).toEqual(Object.keys(SPEC).sort());

  const uses = matches(text, /^\s*(?:- )?uses: (\S+)/gm).map((m) => m[1]!);
  expect(uses.length).toBeGreaterThan(0);
  expect(uses.filter((ref) => PINS[ref] !== true)).toEqual([]);
  expect(count(text, 'actions/attest-build-provenance@')).toBe(1);

  expect(count(text, 'secrets.')).toBe(1);
  expect(matches(text, /^\s+environment:/gm)).toHaveLength(1);
  expect(text).not.toMatch(/^\s*cache:/m);
  expect(count(text, 'id-token:')).toBe(1);
  expect(count(text, 'attestations:')).toBe(1);
  expect(count(text, 'npm publish ')).toBe(4);
  expect(count(text, REGISTRY)).toBe(4);
  expect(count(text, '--dry-run')).toBe(2);
  expect(count(text, '--verify-tag')).toBe(1);
  expect(count(text, '--expect publish')).toBe(1);
  // The tarball name gate runs in publish and rehearse, as its own whole line.
  expect(matches(text, /^        run: test "\$TARBALL" = "netsapiens-mcp-\$VERSION\.tgz"$/gm)).toHaveLength(2);

  for (const [name, spec] of Object.entries(SPEC)) {
    const body = jobs.get(name)!;
    expect(field(body, 'runs-on'), name).toBe(spec.runsOn);
    expect(needsOf(body), name).toEqual(spec.needs);
    expect(field(body, 'if'), name).toBe(spec.when);
    expect(field(body, 'environment'), name).toBe(spec.environment);
    expect(permissionsOf(body), name).toEqual(spec.permissions);
    expect(count(body, 'actions/checkout@'), name).toBe(spec.checkouts);
    expect(count(body, 'persist-credentials: false'), name).toBe(spec.checkouts);
    expect(body).not.toContain('persist-credentials: true');
    expect(body).not.toMatch(/\bnpx\b/);
    if (spec.npm) {
      const subs = commandsOf(body, NPM_CMD);
      expect(subs.filter((sub) => !spec.npm!.includes(sub)), name).toEqual([]);
    }
    if (spec.node) {
      const targets = commandsOf(body, NODE_CMD);
      expect(targets.filter((target) => !spec.node!.includes(target)), name).toEqual([]);
    }

    // Every publish line is either the real publish (provenance, never dry) or the rehearsal (dry, never provenance).
    // Both pin the registry explicitly, so the gate's registry and npm's registry cannot disagree.
    const publishes = body.split('\n').filter((line) => line.includes('npm publish '));
    if (name === 'publish') {
      expect(publishes).toHaveLength(2);
      for (const line of publishes) {
        expect(line).toContain('--ignore-scripts');
        expect(line).toContain(REGISTRY);
        expect(line).toContain('--provenance');
        expect(line).not.toContain('--dry-run');
      }
    } else if (name === 'rehearse') {
      expect(publishes).toHaveLength(2);
      for (const line of publishes) {
        expect(line).toContain('--ignore-scripts');
        expect(line).toContain(REGISTRY);
        expect(line).toContain('--dry-run');
        expect(line).not.toContain('--provenance');
      }
    } else {
      expect(publishes, name).toHaveLength(0);
    }
  }

  const build = jobs.get('build')!;
  inOrder(build, [
    'release-gate.mjs version',
    'release-gate.mjs source',
    'run: npm ci',
    'name: Run tests',
    'run: npm run build',
    'name: Freeze package',
    'name: Upload frozen tarball',
    'name: Verify package contents',
    'name: Check frozen artifact',
    'name: Run consumer e2e',
    'name: Verify frozen artifact after consumers',
    'name: Upload release notes',
  ]);
  expect(build).toContain('node scripts/consumer-e2e.mjs --tarball "$RUNNER_TEMP/release-tarball/$TARBALL" --legs install,config,sqlite,memory,version');
  expect(build).toContain('node scripts/consumer-e2e.mjs --tarball "$RUNNER_TEMP/release-tarball/$TARBALL" --legs firestore --firestore-major 8');
  expect(build).toContain("NSMCP_REQUIRE_FIRESTORE_EMULATOR: '1'");
  expect(build).toContain('node scripts/verify-pack.mjs "$RUNNER_TEMP/release-tarball/$TARBALL"');

  const scan = jobs.get('scan')!;
  expect(scan).toContain('ref: ${{ github.sha }}');
  inOrder(scan, [
    'name: Check artifact before scanning',
    'node scripts/release-gate.mjs artifact --tarball "$RUNNER_TEMP/dist/$TARBALL"',
    'name: Scan package',
    'secrets.FORBIDDEN_CONTENT_PATTERNS',
    'test -n "$FORBIDDEN_CONTENT_PATTERNS"',
    'node scripts/scan-forbidden.mjs --pack "$RUNNER_TEMP/dist/$TARBALL"',
  ]);

  // The tarball name is fixed before the gate and before attestation, so a glob or odd name never reaches either.
  const publish = jobs.get('publish')!;
  inOrder(publish, [
    'name: Check tarball name before gate',
    'id: gate',
    'test "$GITHUB_REF" = "refs/tags/v$VERSION"',
    'release-gate.mjs source',
    'release-gate.mjs artifact',
    'release-gate.mjs registry --name netsapiens-mcp --version "$VERSION" --sha512 "$SHA512" | tee -a "$GITHUB_OUTPUT"',
    'actions/attest-build-provenance',
    'case "$VERSION" in',
    'release-gate.mjs readback --repo "$GITHUB_REPOSITORY" --name netsapiens-mcp --version "$VERSION" --sha512 "$SHA512" --sha "$GITHUB_SHA" --ref "$GITHUB_REF"',
  ]);
  expect(count(publish, "if: steps.gate.outputs.action == 'publish'")).toBe(2);
  expect(publish).not.toContain('--expect');
  expect(publish).not.toContain('release-notes');
  expect(publish).toContain('sparse-checkout: scripts/release-gate.mjs');

  const verify = jobs.get('verify-registry')!;
  inOrder(verify, ['npm_config_ignore_scripts=true', 'npm install --no-audit --no-fund "netsapiens-mcp@$VERSION"']);

  // Release lookup fails closed: only a verified 404 creates, only a verified 200 with the digest passes,
  // and every other status (including no status, from a network failure) exits non-zero.
  const release = jobs.get('github-release')!;
  inOrder(release, [
    'name: Create GitHub Release',
    'gh api --include "repos/$GITHUB_REPOSITORY/releases/tags/$tag"',
    'case "$code" in',
    '200)',
    '"sha256:$SHA256"',
    'exit 0 ;;',
    '404)',
    'gh release create "$tag" "$file" --repo "$GITHUB_REPOSITORY" --verify-tag',
    '*)',
    'exit 1 ;;',
  ]);
  expect(release).not.toMatch(/if gh api/);
  expect(release).toMatch(/^            200\)\n[\s\S]*?\n              exit 0 ;;\n            404\)\n/m);
  expect(release).toMatch(/^            404\)\n              gh release create .*;;\n            \*\)\n/m);
  expect(release).toMatch(/^            \*\)\n              echo "::error::[^\n]*\n              exit 1 ;;\n/m);

  const rehearse = jobs.get('rehearse')!;
  inOrder(rehearse, [
    'name: Check tarball name before gate',
    'release-gate.mjs source',
    'release-gate.mjs artifact',
    'release-gate.mjs registry --name netsapiens-mcp --version "$VERSION" --sha512 "$SHA512" --expect publish',
    'case "$VERSION" in',
  ]);
  expect(rehearse).not.toContain('release-notes');
}

// Fixture edits: each must hit exactly one occurrence, so a mutation can never pass by drifting.
function once(text: string, from: string, to: string): string {
  expect(count(text, from)).toBe(1);
  return text.replace(from, () => to);
}

function inJob(text: string, job: string, from: string, to: string): string {
  const body = jobBodies(text).get(job);
  if (body === undefined) throw new Error(`no job ${job}`);
  const mutated = once(body, from, to);
  return text.replace(body, () => mutated);
}

function removeStep(text: string, job: string, startName: string, endName: string): string {
  const body = jobBodies(text).get(job)!;
  const block = body.match(new RegExp(`      - name: ${startName}\\n[\\s\\S]*?(?=      - name: ${endName}\\n)`))?.[0];
  if (!block) throw new Error(`fixture: ${startName}`);
  const mutated = body.replace(block, () => '');
  return text.replace(body, () => mutated);
}

describe('release workflow', () => {
  it('has the planned jobs, authority, pins, gates and step order', () => {
    checkWorkflow(workflow);
  });

  const mutations: Array<[string, (text: string) => string]> = [
    ['widened workflow-level permissions', (t) => once(t, 'permissions: {}\n\nconcurrency:', 'permissions: { contents: read }\n\nconcurrency:')],
    ['an added pull_request trigger', (t) => once(t, 'on:\n  push:', 'on:\n  pull_request:\n  push:')],
    ['build holding id-token', (t) => inJob(t, 'build', 'permissions: { contents: read, checks: read }', 'permissions: { contents: read, checks: read, id-token: write }')],
    ['scan holding id-token', (t) => inJob(t, 'scan', 'permissions: { contents: read }', 'permissions: { contents: read, id-token: write }')],
    ['publish losing attestations write', (t) => inJob(t, 'publish', ', attestations: write', '')],
    ['publish on a self-hosted runner', (t) => inJob(t, 'publish', 'runs-on: ubuntu-24.04', 'runs-on: ubicloud-standard-2')],
    ['publish without the npm-publish environment', (t) => inJob(t, 'publish', '    environment: npm-publish\n', '')],
    ['publish gated off the tag', (t) => inJob(t, 'publish', `    if: ${TAG_PUSH}`, "    if: github.event_name != 'pull_request'")],
    ['rehearsal gated on every event', (t) => inJob(t, 'rehearse', `    if: ${DISPATCH}`, '    if: always()')],
    ['publish running npm ci', (t) => inJob(t, 'publish', '      - name: Verify npm version', '      - run: npm ci\n      - name: Verify npm version')],
    ['publish with a package cache', (t) => inJob(t, 'publish', '          node-version: 24\n          registry-url', '          node-version: 24\n          cache: npm\n          registry-url')],
    ['publish without --ignore-scripts', (t) => inJob(t, 'publish', '--ignore-scripts --access public --provenance', '--access public --provenance')],
    ['publish checkout keeping credentials', (t) => inJob(t, 'publish', '          persist-credentials: false\n', '          persist-credentials: true\n')],
    ['scan checkout pinned to a tag', (t) => inJob(t, 'scan', 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262', 'actions/checkout@v4')],
    ['publish ignoring the scan', (t) => inJob(t, 'publish', 'needs: [build, scan]', 'needs: [build]')],
    ['publish skipping the artifact gate', (t) => inJob(t, 'publish', '          node scripts/release-gate.mjs artifact --tarball "$RUNNER_TEMP/dist/$TARBALL" --version "$VERSION" --sha256 "$SHA256" --sha512 "$SHA512"\n', '')],
    ['publish step ungated by the registry result', (t) => inJob(t, 'publish', "        if: steps.gate.outputs.action == 'publish'\n        run: |\n          case", '        run: |\n          case')],
    ['publish gate using --expect publish', (t) => inJob(t, 'publish', '--sha512 "$SHA512" | tee', '--sha512 "$SHA512" --expect publish | tee')],
    ['publish readback dropped', (t) => inJob(t, 'publish', ' --ref "$GITHUB_REF"\n', '\n')],
    ['tag equality check removed', (t) => inJob(t, 'publish', 'test "$GITHUB_REF" = "refs/tags/v$VERSION"', 'true')],
    ['publish downloading release notes instead of the tarball', (t) => inJob(t, 'publish', 'name: release-tarball', 'name: release-notes')],
    ['rehearsal dropping --dry-run', (t) => inJob(t, 'rehearse', '--access public --dry-run', '--access public')],
    ['rehearsal adding provenance', (t) => inJob(t, 'rehearse', '--access public --dry-run', '--access public --provenance --dry-run')],
    ['rehearsal holding id-token', (t) => inJob(t, 'rehearse', 'permissions: { contents: read, checks: read }', 'permissions: { contents: read, checks: read, id-token: write }')],
    ['rehearsal bound to the registry environment', (t) => inJob(t, 'rehearse', '    runs-on: ubuntu-24.04\n', '    runs-on: ubuntu-24.04\n    environment: npm-publish\n')],
    ['rehearsal without --expect publish', (t) => inJob(t, 'rehearse', ' --expect publish', '')],
    ['verify-registry installing with scripts on', (t) => inJob(t, 'verify-registry', 'npm_config_ignore_scripts=true', 'npm_config_ignore_scripts=false')],
    ['verify-registry running npm ci', (t) => inJob(t, 'verify-registry', '          npm audit signatures', '          npm audit signatures\n          npm ci')],
    ['release creation without --verify-tag', (t) => inJob(t, 'github-release', ' --verify-tag', '')],
    ['release job running candidate code', (t) => inJob(t, 'github-release', '      - name: Create GitHub Release', '      - run: npm run build\n      - name: Create GitHub Release')],
    ['release skipping verify-registry', (t) => inJob(t, 'github-release', 'needs: [build, publish, verify-registry]', 'needs: [build, publish]')],
    ['release lookup dropping --include so status is unreadable', (t) => inJob(t, 'github-release', 'gh api --include "repos/', 'gh api "repos/')],
    ['release creation on any lookup status', (t) => inJob(t, 'github-release', '            404)\n', '            404|*)\n')],
    ['release creation as the error fallback', (t) => inJob(t, 'github-release', '              echo "::error::', '              gh release create "$tag" "$file" --repo "$GITHUB_REPOSITORY" --verify-tag --title "$tag" --notes-file "$RUNNER_TEMP/notes/notes.md" ;;\n              echo "::error::')],
    ['error branch exiting zero', (t) => inJob(t, 'github-release', '              exit 1 ;;', '              exit 0 ;;')],
    ['existing release accepted without a digest', (t) => inJob(t, 'github-release', '= "sha256:$SHA256"', '= "sha256:x"')],
    ['existing release falling through to create', (t) => inJob(t, 'github-release', '              exit 0 ;;', '              ;;')],
    ['publish without the registry pin on the stable line', (t) => inJob(t, 'publish', `${REGISTRY} --ignore-scripts --access public --provenance`, '--ignore-scripts --access public --provenance')],
    ['publish without the registry pin on the next-tag line', (t) => inJob(t, 'publish', `${REGISTRY} --ignore-scripts --access public --tag next --provenance`, '--ignore-scripts --access public --tag next --provenance')],
    ['publish pointed at another registry', (t) => inJob(t, 'publish', `${REGISTRY} --ignore-scripts --access public --provenance`, '--registry https://registry.example.test/ --ignore-scripts --access public --provenance')],
    ['rehearsal without the registry pin on the stable line', (t) => inJob(t, 'rehearse', `${REGISTRY} --ignore-scripts --access public --dry-run`, '--ignore-scripts --access public --dry-run')],
    ['rehearsal without the registry pin on the next-tag line', (t) => inJob(t, 'rehearse', `${REGISTRY} --ignore-scripts --access public --tag next --dry-run`, '--ignore-scripts --access public --tag next --dry-run')],
    ['publish without the tarball name gate', (t) => inJob(t, 'publish', `      - name: Check tarball name before gate\n        run: ${NAME_CHECK}\n`, '')],
    ['rehearsal without the tarball name gate', (t) => inJob(t, 'rehearse', `      - name: Check tarball name before gate\n        run: ${NAME_CHECK}\n`, '')],
    ['tarball name gate weakened to always pass', (t) => inJob(t, 'publish', `        run: ${NAME_CHECK}\n`, '        run: true\n')],
    ['tarball name gate reduced to a glob match', (t) => inJob(t, 'publish', `        run: ${NAME_CHECK}\n`, '        run: test "$TARBALL" = netsapiens-mcp-*.tgz\n')],
    ['tarball name gate with a fallback that passes', (t) => inJob(t, 'publish', `        run: ${NAME_CHECK}\n`, `        run: ${NAME_CHECK} || true\n`)],
    ['tarball name gate moved after the gate', (t) => {
      const body = jobBodies(t).get('publish')!;
      const block = `      - name: Check tarball name before gate\n        run: ${NAME_CHECK}\n`;
      const moved = once(once(body, block, ''), '      - name: Attest release tarball provenance\n', `${block}      - name: Attest release tarball provenance\n`);
      return t.replace(body, () => moved);
    }],
    ['tarball name gate moved after attestation', (t) => {
      const body = jobBodies(t).get('publish')!;
      const block = `      - name: Check tarball name before gate\n        run: ${NAME_CHECK}\n`;
      const moved = once(body.replace(block, () => ''), '      - name: Publish to npm\n', `${block}      - name: Publish to npm\n`);
      return t.replace(body, () => moved);
    }],
    ['scanner secret exposed to build', (t) => inJob(t, 'build', '      - run: npm run build', '      - run: npm run build\n        env:\n          FORBIDDEN_CONTENT_PATTERNS: ${{ secrets.FORBIDDEN_CONTENT_PATTERNS }}')],
    ['scan without the empty-secret fail-closed', (t) => inJob(t, 'scan', '          test -n "$FORBIDDEN_CONTENT_PATTERNS"\n', '')],
    ['scan skipping the artifact check', (t) => inJob(t, 'scan', 'node scripts/release-gate.mjs artifact --tarball "$RUNNER_TEMP/dist/$TARBALL" --version "$VERSION" --sha256 "$SHA256" --sha512 "$SHA512"', 'true')],
    ['scan installing dependencies', (t) => inJob(t, 'scan', '      - name: Scan package', '      - run: npm ci\n      - name: Scan package')],
    ['scan on a revision other than the source SHA', (t) => inJob(t, 'scan', '          ref: ${{ github.sha }}\n', '')],
    ['consumers running before the freeze', (t) => {
      const body = jobBodies(t).get('build')!;
      const block = body.match(/      - name: Run consumer e2e\n[\s\S]*?(?=      - name: Verify frozen artifact after consumers\n)/)?.[0];
      if (!block) throw new Error('fixture: consumer block');
      const moved = once(body.replace(block, () => ''), '      - name: Freeze package\n', `${block}      - name: Freeze package\n`);
      return t.replace(body, () => moved);
    }],
    ['no digest check after consumers', (t) => removeStep(t, 'build', 'Verify frozen artifact after consumers', 'Prepare release notes')],
    ['consumers testing the workspace copy', (t) => inJob(t, 'build', 'consumer-e2e.mjs --tarball "$RUNNER_TEMP/release-tarball/$TARBALL" --legs install', 'consumer-e2e.mjs --tarball "$TARBALL" --legs install')],
    ['build without the version gate', (t) => inJob(t, 'build', 'node scripts/release-gate.mjs version', 'echo version')],
    ['build caching dependencies', (t) => inJob(t, 'build', '          node-version: 24\n', '          node-version: 24\n          cache: npm\n')],
    ['build keeping credentials', (t) => inJob(t, 'build', 'persist-credentials: false', 'persist-credentials: true')],
    ['attestation moved into build', (t) => inJob(t, 'build', '      - name: Verify package contents', '      - uses: actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be # v2\n        with:\n          subject-path: x\n      - name: Verify package contents')],
    ['an unpinned setup-node tag', (t) => inJob(t, 'verify-registry', 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020', 'actions/setup-node@v4')],
  ];

  for (const [label, mutate] of mutations) {
    it(`rejects ${label}`, () => {
      const mutated = mutate(workflow);
      expect(mutated).not.toBe(workflow);
      expect(() => checkWorkflow(mutated)).toThrow();
    });
  }
});
