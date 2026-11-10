#!/usr/bin/env bash
# Isolated proof launcher for one candidate commit on a GitHub-hosted runner.
#
# Usage: bash .github/proof/stage.sh <preflight|stage|controls|run|all>
#
# Environment. The workflow supplies exactly these; nothing else is read.
#   CANDIDATE_SHA        40 lowercase hex; must equal HEAD^ of the checkout
#   GITHUB_EVENT_NAME    must be workflow_dispatch
#   GITHUB_REF           must match refs/heads/proof/*
#   GITHUB_WORKSPACE     checkout of the workflow commit, fetch-depth: 2
#   RUNNER_TEMP          per-job scratch directory supplied by Actions
#   GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT   optional; only used to name owned containers
#
# Modes.
#   preflight  git and tree assertions. No network, no docker.
#   stage      git archive of the candidate, pinned https downloads with sha256 and
#              size checks, npm cache built in a networked acquisition container that
#              never runs candidate code, SHA256SUMS written.
#   controls   containment controls. Every negative control must fail and every
#              positive control must pass, on this runner, before the candidate runs.
#   run        controls, then the candidate in one hardened container. Exit status
#              of the candidate and its completion marker decide the verdict.
#   all        preflight, stage, run.
#
# Output is a bounded set of "proof: <step> <status>" lines. Exit status is the verdict.
set -Eeuo pipefail
umask 077
export PATH=/usr/local/bin:/usr/bin:/bin LANG=C LC_ALL=C

# Pins. Changing any of them is a reviewed change to this file.
readonly IMAGE='node@sha256:7702d8aa4d5910871692af4480eb3ba86f23047a6417a44d857d06c95d060d3f'
readonly JRE_URL='https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jre_x64_linux_hotspot_21.0.13_9.tar.gz'
readonly JRE_SHA256='a535a1df9c6284d9618872984e026ae0352d1f7e9e0605425c0e6114f47351dd'
readonly JRE_BYTES=52181297
readonly EMULATOR_URL='https://storage.googleapis.com/firebase-preview-drop/emulator/cloud-firestore-emulator-v1.21.0.jar'
readonly EMULATOR_SHA256='c3d3680a89d946a90a027365ea14c26c6472a162bcf37f099bbb1ebd66d25e8e'
readonly EMULATOR_BYTES=138093843
readonly CACHE_MAX_BYTES=2147483648
readonly RUN_TIMEOUT_SECONDS=2700
readonly PROOF_UID=10001

# Lockfile gate: every package must resolve from the public npm registry, with no links.
readonly LOCK_CHECK='import json, sys
d = json.load(sys.stdin)
if d.get("lockfileVersion") not in (2, 3) or not isinstance(d.get("packages"), dict):
    raise SystemExit("lockfile must be v2 or v3 with a packages map")
bad = []
for name, p in d["packages"].items():
    if name == "":
        continue
    if p.get("link") or p.get("inBundle"):
        bad.append(name)
        continue
    r = p.get("resolved")
    if not isinstance(r, str) or not r.startswith("https://registry.npmjs.org/"):
        bad.append(name)
if bad:
    raise SystemExit("lock entries not from registry.npmjs.org or linked: " + ", ".join(bad[:5]))
'

# Archive gate: regular files and directories only, no traversal, no links.
readonly TAR_CHECK='import sys, tarfile
count = 0
with tarfile.open(sys.argv[1], "r:") as t:
    for m in t:
        count += 1
        if m.name.startswith("/") or ".." in m.name.split("/"):
            raise SystemExit("unsafe member name")
        if m.type == tarfile.XGLTYPE:
            continue
        if not (m.isreg() or m.isdir()):
            raise SystemExit("non-regular archive member")
print(count)
'

say() { printf 'proof: %s %s\n' "$1" "$2"; }
die() { printf 'proof: FAILED %s\n' "$*" >&2; exit 1; }

RUN_TAG=$(printf '%s-%s-%s' "${GITHUB_RUN_ID:-local}" "${GITHUB_RUN_ATTEMPT:-0}" "$$" | tr -c 'A-Za-z0-9_.-' '-')
WORK_ROOT=''
STAGE=''
ACQ=''
HELPERS=''
GATEWAY=''
CANARY_PID=''
CANARY_LOG=''
CANARY_PORT=''
CANARY_PORT_FILE=''
RUN_CONTAINER=''
BASE=()

ctl_name() { printf 'nsmcp-%s-%s' "$RUN_TAG" "$1"; }
hits_now() { wc -l <"$CANARY_LOG" | tr -d ' '; }

require_env() {
  [[ "${CANDIDATE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || die "CANDIDATE_SHA must be 40 lowercase hex"
  [ "${GITHUB_EVENT_NAME:-}" = workflow_dispatch ] || die "event must be workflow_dispatch"
  if ! [[ "${GITHUB_REF:-}" =~ ^refs/heads/proof/[A-Za-z0-9._/-]+$ ]] || [[ "$GITHUB_REF" == *..* ]]; then
    die "ref must be refs/heads/proof/*"
  fi
  [[ "${GITHUB_WORKSPACE:-}" == /* ]] && git -C "$GITHUB_WORKSPACE" rev-parse --git-dir >/dev/null 2>&1 \
    || die "GITHUB_WORKSPACE is not a git checkout"
  [[ "${RUNNER_TEMP:-}" == /* && -d "$RUNNER_TEMP" ]] || die "RUNNER_TEMP is missing"
  WORK_ROOT="$RUNNER_TEMP/nsmcp-proof"
  STAGE="$WORK_ROOT/stage"
  ACQ="$WORK_ROOT/acq"
  HELPERS="$GITHUB_WORKSPACE/.github/proof"
}

need_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is required"
}

preflight() {
  require_env
  local parent path matches
  git -C "$GITHUB_WORKSPACE" rev-parse --verify --quiet "$CANDIDATE_SHA^{commit}" >/dev/null \
    || die "candidate commit is not present in the checkout"
  parent=$(git -C "$GITHUB_WORKSPACE" rev-parse --verify HEAD^) \
    || die "HEAD^ is missing; the checkout needs fetch-depth: 2"
  [ "$parent" = "$CANDIDATE_SHA" ] || die "HEAD^ is not CANDIDATE_SHA"
  while IFS= read -r -d '' path; do
    case "$path" in
      .github/*) ;;
      *) die "workflow commit changes a path outside .github/" ;;
    esac
  done < <(git -C "$GITHUB_WORKSPACE" diff -z --name-only --no-renames HEAD^ HEAD)

  matches=$(git -C "$GITHUB_WORKSPACE" ls-tree -r -z --full-tree "$CANDIDATE_SHA" \
    | tr '\0' '\n' | awk '$1 == "120000" || $1 == "160000" { print }' || true)
  [ -z "$matches" ] || die "candidate tree has a symlink or submodule entry"
  matches=$(git -C "$GITHUB_WORKSPACE" ls-tree -r --name-only --full-tree "$CANDIDATE_SHA" \
    | grep -E '(^|/)(\.gitattributes|\.gitmodules|\.npmrc)$' || true)
  [ -z "$matches" ] || die "candidate tree has git or npm config files"

  git -C "$GITHUB_WORKSPACE" show "$CANDIDATE_SHA:package-lock.json" | python3 -c "$LOCK_CHECK" >/dev/null \
    || die "lockfile gate failed"
  say preflight "passed candidate=$CANDIDATE_SHA tree=$(git -C "$GITHUB_WORKSPACE" rev-parse "$CANDIDATE_SHA^{tree}")"
}

check_tar() {
  python3 -c "$TAR_CHECK" "$1" >/dev/null || die "unsafe archive: $(basename "$1")"
}

fetch() {
  local url=$1 out=$2 sha=$3 bytes=$4
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --location --silent --show-error \
    --max-time 900 --max-filesize "$((bytes + 1024))" --output "$out.part" "$url" \
    || die "download failed: $(basename "$out")"
  [ "$(stat -c %s "$out.part")" = "$bytes" ] || die "size mismatch: $(basename "$out")"
  printf '%s  %s\n' "$sha" "$out.part" | sha256sum -c --quiet - >/dev/null \
    || die "sha256 mismatch: $(basename "$out")"
  mv "$out.part" "$out"
  chmod 0444 "$out"
}

host_stage_shape() {
  [ -z "$(find "$STAGE" -mindepth 1 \( -type l -o \( ! -type f ! -type d \) \) -print -quit)" ] \
    || die "stage holds a symlink or non-regular member"
  [ -z "$(find "$STAGE" -type f -links +1 -print -quit)" ] || die "stage holds a multiply linked file"
}

acquire_cache() {
  local name rc=0
  name=$(ctl_name acquire)
  docker run --pull never --init --name "$name" --user "$PROOF_UID:$PROOF_UID" \
    --cap-drop ALL --security-opt no-new-privileges --read-only \
    --pids-limit 512 --memory 6g --memory-swap 6g --cpus 3 --workdir /work \
    --tmpfs "/work:rw,nosuid,nodev,exec,size=3g,uid=$PROOF_UID,gid=$PROOF_UID,mode=0700" \
    --tmpfs "/tmp:rw,nosuid,nodev,size=512m,mode=1777" \
    --mount "type=bind,source=$ACQ/input,target=/input,readonly" \
    -e HOME=/work/home -e LANG=C -e PATH=/usr/local/bin:/usr/bin:/bin \
    "$IMAGE" /bin/sh /input/warm-deps.sh >"$ACQ/cache.tar" 2>"$ACQ/acquire.log" || rc=$?
  docker rm -f "$name" >/dev/null 2>&1 || :
  if [ "$rc" -ne 0 ]; then
    tail -c 4096 "$ACQ/acquire.log" | cut -c1-512 >&2 || :
    die "acquisition container failed (exit $rc)"
  fi
  [ "$(stat -c %s "$ACQ/cache.tar")" -le "$CACHE_MAX_BYTES" ] || die "cache tar exceeds its bound"
  mv "$ACQ/cache.tar" "$STAGE/cache.tar"
}

stage() {
  preflight
  need_docker
  [ ! -e "$WORK_ROOT" ] || die "$WORK_ROOT already exists; refusing to reuse a stage"
  mkdir -m 0711 "$WORK_ROOT"
  mkdir -m 0755 "$STAGE" "$ACQ" "$ACQ/input"

  git -C "$GITHUB_WORKSPACE" archive --format=tar --output="$STAGE/source.tar" "$CANDIDATE_SHA" \
    || die "git archive failed"
  check_tar "$STAGE/source.tar"
  chmod 0444 "$STAGE/source.tar"

  fetch "$JRE_URL" "$STAGE/jre.tar.gz" "$JRE_SHA256" "$JRE_BYTES"
  fetch "$EMULATOR_URL" "$STAGE/cloud-firestore-emulator.jar" "$EMULATOR_SHA256" "$EMULATOR_BYTES"

  docker pull "$IMAGE" >"$ACQ/pull.log" 2>&1 || { tail -c 2048 "$ACQ/pull.log" >&2 || :; die "image pull failed"; }
  [ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$IMAGE")" = linux/amd64 ] \
    || die "pinned image is not linux/amd64"

  git -C "$GITHUB_WORKSPACE" show "$CANDIDATE_SHA:package.json" >"$ACQ/input/package.json" || die "cannot read package.json"
  git -C "$GITHUB_WORKSPACE" show "$CANDIDATE_SHA:package-lock.json" >"$ACQ/input/package-lock.json" \
    || die "cannot read package-lock.json"
  install -m 0444 "$HELPERS/warm-deps.sh" "$ACQ/input/warm-deps.sh"
  acquire_cache
  check_tar "$STAGE/cache.tar"

  install -m 0444 "$HELPERS/inner.sh" "$HELPERS/check-boundary.cjs" "$HELPERS/check-filesystem.py" "$STAGE/"
  (
    cd "$STAGE"
    sha256sum source.tar jre.tar.gz cloud-firestore-emulator.jar cache.tar \
      inner.sh check-boundary.cjs check-filesystem.py > SHA256SUMS
    chmod 0444 SHA256SUMS
  )
  host_stage_shape
  say stage "passed manifest=$(sha256sum "$STAGE/SHA256SUMS" | cut -c1-16)"
}

verify_stage() {
  need_docker
  [ -f "$STAGE/SHA256SUMS" ] || die "stage not built; run the stage mode first"
  (cd "$STAGE" && sha256sum --quiet -c SHA256SUMS) || die "stage digest mismatch"
  host_stage_shape
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "pinned image is not present; run the stage mode first"
}

# build_base <ro|rw> <container-name>: the hardened argument set shared by every container.
build_base() {
  local root=$1 name=$2
  BASE=(
    --pull never --init --name "$name" --user "$PROOF_UID:$PROOF_UID"
    --cap-drop ALL --security-opt no-new-privileges --ipc none
    --pids-limit 1024 --memory 8g --memory-swap 8g --cpus 3
    --tmpfs "/tmp:rw,exec,nosuid,nodev,size=512m,mode=1777"
    --tmpfs "/opt:rw,nosuid,nodev,size=512m,uid=$PROOF_UID,gid=$PROOF_UID,mode=0755"
    --tmpfs "/run:rw,noexec,nosuid,nodev,size=64m,uid=$PROOF_UID,gid=$PROOF_UID,mode=0755"
    --tmpfs "/work:rw,exec,nosuid,nodev,size=3g,uid=$PROOF_UID,gid=$PROOF_UID,mode=0700"
    --mount "type=bind,source=$STAGE,target=/stage,readonly"
    --workdir /work
    -e HOME=/work/home -e LANG=C -e PATH=/usr/local/bin:/usr/bin:/bin
    --log-opt max-size=1m --log-opt max-file=1
  )
  if [ "$root" = ro ]; then BASE+=(--read-only); fi
}

start_canary() {
  command -v node >/dev/null 2>&1 || die "node is required on the runner for the canary"
  need_docker
  GATEWAY=$(docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}') \
    || die "docker bridge network not found"
  [[ "$GATEWAY" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "bridge gateway is not IPv4"
  CANARY_LOG="$WORK_ROOT/canary.log"
  CANARY_PORT_FILE="$WORK_ROOT/canary.port"
  : >"$CANARY_LOG"
  rm -f "$CANARY_PORT_FILE"
  CANARY_HOST="$GATEWAY" CANARY_LOG="$CANARY_LOG" CANARY_PORT_FILE="$CANARY_PORT_FILE" node - >"$WORK_ROOT/canary.out" 2>&1 <<'JS' &
const net = require('node:net');
const fs = require('node:fs');
const { CANARY_HOST: host, CANARY_LOG: log, CANARY_PORT_FILE: portFile } = process.env;
let hits = 0;
const server = net.createServer(socket => {
  hits += 1;
  fs.appendFileSync(log, `${socket.remoteAddress}\n`);
  socket.end('canary-hit\n');
  if (hits >= 50) server.close();
});
server.on('error', e => { console.error(e.code); process.exit(1); });
server.listen(0, host, () => fs.writeFileSync(portFile, String(server.address().port)));
process.on('SIGTERM', () => process.exit(0));
JS
  CANARY_PID=$!
  local i
  for i in $(seq 1 100); do
    [ -s "$CANARY_PORT_FILE" ] && break
    kill -0 "$CANARY_PID" 2>/dev/null || die "canary exited; see $WORK_ROOT/canary.out"
    sleep 0.1
  done
  CANARY_PORT=$(cat "$CANARY_PORT_FILE")
  [[ "$CANARY_PORT" =~ ^[0-9]+$ ]] || die "canary did not start"
  say canary "listening on the bridge gateway"
}

stop_canary() {
  if [ -n "${CANARY_PID:-}" ]; then
    kill "$CANARY_PID" 2>/dev/null || :
    wait "$CANARY_PID" 2>/dev/null || :
    CANARY_PID=''
  fi
}

# control <pass|fail> <label> <container-name> -- <command...>
control() {
  local want=$1 label=$2 name=$3 rc=0 out
  shift 4
  out="$WORK_ROOT/control-$label.log"
  timeout --kill-after=10 300 "$@" >"$out" 2>&1 || rc=$?
  docker rm -f "$name" >/dev/null 2>&1 || :
  if [ "$want" = pass ]; then
    if [ "$rc" -ne 0 ]; then
      tail -c 2048 "$out" | cut -c1-512 >&2 || :
      die "control $label failed (exit $rc)"
    fi
  elif [ "$rc" -eq 0 ]; then
    die "negative control $label passed, so the check cannot fail"
  fi
  say "control:$label" "$want-as-required"
}

controls() {
  verify_stage
  [ -n "${CANARY_PID:-}" ] || die "canary is not running"
  local name hits0 hits1 canary_file rw_dir
  hits0=$(hits_now)

  name=$(ctl_name reach-canary); build_base ro "$name"
  control pass reach-canary "$name" -- docker run "${BASE[@]}" --network bridge \
    "$IMAGE" node /stage/check-boundary.cjs reach "$GATEWAY" "$CANARY_PORT"
  hits1=$(hits_now)
  [ "$hits1" = "$((hits0 + 1))" ] || die "canary did not record the positive-control connection"

  name=$(ctl_name boundary-bridge); build_base ro "$name"
  control fail boundary-bridge-must-fail "$name" -- docker run "${BASE[@]}" --network bridge \
    "$IMAGE" node /stage/check-boundary.cjs boundary "$GATEWAY" "$CANARY_PORT"

  name=$(ctl_name boundary-none); build_base ro "$name"
  control pass boundary-no-network "$name" -- docker run "${BASE[@]}" --network none \
    "$IMAGE" node /stage/check-boundary.cjs boundary "$GATEWAY" "$CANARY_PORT"
  [ "$(hits_now)" = "$hits1" ] || die "canary received a connection from the no-network container"

  name=$(ctl_name env-allowlist); build_base ro "$name"
  control pass env-allowlist "$name" -- docker run "${BASE[@]}" --network none \
    "$IMAGE" node /stage/check-boundary.cjs env
  name=$(ctl_name env-canary-token); build_base ro "$name"
  control fail env-canary-token-must-fail "$name" -- docker run "${BASE[@]}" --network none \
    -e ACTIONS_RUNTIME_TOKEN=canary "$IMAGE" node /stage/check-boundary.cjs env

  name=$(ctl_name status-hardened); build_base ro "$name"
  control pass status-hardened "$name" -- docker run "${BASE[@]}" --network none \
    "$IMAGE" node /stage/check-boundary.cjs status
  name=$(ctl_name status-cap-add); build_base ro "$name"
  control fail status-cap-add-must-fail "$name" -- docker run "${BASE[@]}" --network none \
    --cap-add NET_ADMIN "$IMAGE" node /stage/check-boundary.cjs status
  name=$(ctl_name status-seccomp); build_base ro "$name"
  control fail status-seccomp-unconfined-must-fail "$name" -- docker run "${BASE[@]}" --network none \
    --security-opt seccomp=unconfined "$IMAGE" node /stage/check-boundary.cjs status

  name=$(ctl_name devices); build_base ro "$name"
  control pass devices-allowlist "$name" -- docker run "${BASE[@]}" --network none \
    "$IMAGE" python3 /stage/check-filesystem.py devices

  canary_file="$WORK_ROOT/canary-file"
  printf 'canary\n' >"$canary_file"
  chmod 0444 "$canary_file"
  name=$(ctl_name mount-canary); build_base ro "$name"
  control fail mount-canary-must-fail "$name" -- docker run "${BASE[@]}" --network none \
    --mount "type=bind,source=$canary_file,target=/canary-host,readonly" \
    "$IMAGE" python3 /stage/check-filesystem.py mounts
  name=$(ctl_name mounts); build_base ro "$name"
  control pass mounts-allowlist "$name" -- docker run "${BASE[@]}" --network none \
    "$IMAGE" python3 /stage/check-filesystem.py mounts

  name=$(ctl_name writes-readonly); build_base ro "$name"
  control pass writes-readonly "$name" -- docker run "${BASE[@]}" --network none \
    "$IMAGE" python3 /stage/check-filesystem.py writes
  rw_dir="$WORK_ROOT/rw-canary"
  mkdir -m 0777 "$rw_dir"
  chmod 0777 "$rw_dir"
  name=$(ctl_name writes-rw-canary); build_base ro "$name"
  control fail writes-rw-canary-must-fail "$name" -- docker run "${BASE[@]}" --network none \
    --mount "type=bind,source=$rw_dir,target=/canary-rw" \
    "$IMAGE" python3 /stage/check-filesystem.py writes /canary-rw
  say controls passed
}

controls_mode() {
  require_env
  start_canary
  controls
}

run() {
  verify_stage
  controls
  local name code hits0
  name="nsmcp-proof-$RUN_TAG"
  hits0=$(hits_now)
  build_base ro "$name"
  RUN_CONTAINER="$name"
  docker run -d "${BASE[@]}" --network none "$IMAGE" /bin/bash /stage/inner.sh "$GATEWAY" "$CANARY_PORT" \
    >/dev/null || die "candidate container did not start"
  if ! code=$(timeout --kill-after=60 "$RUN_TIMEOUT_SECONDS" docker wait "$name"); then
    docker kill "$name" >/dev/null 2>&1 || :
    die "candidate did not finish within its bound"
  fi
  docker logs --tail 4000 "$name" 2>&1 | cut -c1-1024 >"$WORK_ROOT/candidate.log" || :
  head -c 262144 "$WORK_ROOT/candidate.log"
  [ "$(hits_now)" = "$hits0" ] || die "canary received a connection during the candidate run"
  [ "$code" = 0 ] || die "candidate exit status $code"
  grep -qx 'proof-phase complete passed' "$WORK_ROOT/candidate.log" \
    || die "candidate did not reach the completion marker"
  docker rm -f "$name" >/dev/null 2>&1 || :
  RUN_CONTAINER=''
  say run "passed exit=$code"
}

run_mode() {
  require_env
  start_canary
  run
}

cleanup() {
  local rc=$?
  trap - EXIT
  if [ -n "${RUN_CONTAINER:-}" ]; then docker rm -f "$RUN_CONTAINER" >/dev/null 2>&1 || :; fi
  stop_canary
  exit "$rc"
}
trap cleanup EXIT

case "${1:-}" in
  preflight) preflight ;;
  stage) stage ;;
  controls) controls_mode ;;
  run) run_mode ;;
  all)
    preflight
    stage
    run_mode
    ;;
  *) die "usage: stage.sh <preflight|stage|controls|run|all>" ;;
esac
