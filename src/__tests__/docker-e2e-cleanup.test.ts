import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/docker-e2e.mjs', import.meta.url));

describe('docker-e2e failure cleanup', () => {
  it.each([
    { failure: 'image-build', reason: 'docker build exited 42: fake build failure', prefix: 1 },
    { failure: 'volume-create', reason: 'docker volume create exited 43: fake volume failure', prefix: 2 },
  ])('cleans up after $failure fails', ({ failure, reason, prefix }) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'docker-e2e-cleanup-'));
    try {
      const log = path.join(dir, 'docker-calls');
      const fakeDocker = path.join(dir, 'docker');
      writeFileSync(fakeDocker, `#!/bin/sh
printf '%s\n' "$*" >> "$DOCKER_CALL_LOG"
case "$1 $2" in
  'build -t')
    if [ "$DOCKER_FAIL" = image-build ]; then
      printf 'fake build failure' >&2
      exit 42
    fi
    ;;
  'volume create')
    if [ "$DOCKER_FAIL" = volume-create ]; then
      printf 'fake volume failure' >&2
      exit 43
    fi
    ;;
  'rm -f'|'volume rm'|'rmi -f') ;;
  *) printf 'unexpected fake docker call' >&2; exit 97 ;;
esac
`, { mode: 0o755 });

      const result = spawnSync(process.execPath, [script], {
        encoding: 'utf8',
        env: { ...process.env, PATH: dir, DOCKER_CALL_LOG: log, DOCKER_FAIL: failure },
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`FAIL docker ${failure}: ${reason}`);

      const calls = readFileSync(log, 'utf8').trimEnd().split('\n');
      const build = /^build -t nsmcp-docker-e2e:([0-9a-f]{8}) \.$/.exec(calls[0]);
      expect(build).not.toBeNull();
      const runId = build![1];
      const setup = [`build -t nsmcp-docker-e2e:${runId} .`];
      if (prefix === 2) setup.push(`volume create nsmcp-vol-${runId}`);
      expect(calls).toEqual([
        ...setup,
        `rm -f nsmcp-c1-${runId}`,
        `rm -f nsmcp-c2-${runId}`,
        `volume rm nsmcp-vol-${runId}`,
        `rmi -f nsmcp-docker-e2e:${runId}`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
