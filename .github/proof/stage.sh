#!/usr/bin/env bash
# Isolated proof launcher for one candidate commit on a GitHub-hosted runner.
#
# Usage: bash .github/proof/stage.sh <preflight|stage|controls|run|all>
#
# SHA binding. Nothing here hardcodes a SHA. preflight enforces two relations on the checkout:
#   GITHUB_SHA must equal HEAD, the workflow commit that carries these files, and
#   CANDIDATE_SHA must equal HEAD^, the single commit that commit adds to. The workflow supplies
#   both values. A dispatch whose CANDIDATE_SHA input names another commit fails closed here.
#
# Environment. The workflow supplies exactly these; nothing else is read.
#   CANDIDATE_SHA        40 lowercase hex; must equal HEAD^ of the checkout
#   GITHUB_SHA           40 lowercase hex; must equal HEAD of the checkout
#   GITHUB_EVENT_NAME    must be workflow_dispatch
#   GITHUB_REF           must match refs/heads/proof/*
#   GITHUB_WORKSPACE     checkout of the workflow commit, fetch-depth: 2
#   RUNNER_TEMP          per-job scratch directory supplied by Actions
#   GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT   optional; only used to name owned containers
#
# Modes.
#   preflight  git and tree assertions. No network, no docker.
#   stage      git archive of the candidate, pinned https downloads with size and sha256 checks,
#              npm cache built in a bounded acquisition container that never runs candidate code,
#              and a digest manifest (SHA256SUMS) covering every staged file.
#   controls   containment and environment controls. Every negative control must fail for its expected
#              reason, every positive control must pass, on this runner, before the candidate runs.
#   run        controls, then the candidate in one hardened container. The container exit status and
#              the completion marker decide the verdict.
#   all        preflight, stage, run.
#
# Containers are created with `docker create` and removed by the ID this script received, never by name.
# Output is bounded. Text copied from registries or from the candidate is printed between workflow
# stop-commands tokens, so it cannot issue workflow commands. Exit status is the verdict.
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
readonly ACQ_TIMEOUT_SECONDS=1800
readonly RUN_TIMEOUT_SECONDS=2700
readonly CONTROL_TIMEOUT_SECONDS=900
readonly PROOF_UID=10001
# Runner-compatible CPU share. ubuntu-24.04 hosted runners provide 2 vCPUs; --cpus above that is refused.
readonly CONTAINER_CPUS=2

# Lockfile gate: every package must resolve from the public npm registry, with no links. Names are
# printed with ascii(), so a key containing a newline or a "::" prefix cannot reach the log as a command.
readonly LOCK_CHECK='import json, sys
d = json.load(sys.stdin)
if d.get("lockfileVersion") not in (2, 3) or not isinstance(d.get("packages"), dict):
    raise SystemExit("lockfile must be v2 or v3 with a packages map")
bad = []
for name, p in d["packages"].items():
    if name == "":
        continue
    if p.get("link") or p.get("inBundle"):
        bad.append(ascii(name))
        continue
    r = p.get("resolved")
    if not isinstance(r, str) or not r.startswith("https://registry.npmjs.org/"):
        bad.append(ascii(name))
if bad:
    raise SystemExit("lock entries not from registry.npmjs.org or linked: " + ", ".join(bad[:5]))
'

# Tree gate: NUL-separated `git ls-tree -r -z` output. Links, submodules and git or npm
# configuration files anywhere in the tree fail. Names are printed only as escaped bytes.
readonly TREE_CHECK='import sys
bad = []
for entry in open(sys.argv[1], "rb").read().split(b"\0"):
    if not entry:
        continue
    meta, _, name = entry.partition(b"\t")
    mode = meta.split(b" ")[0]
    base = name.rsplit(b"/", 1)[-1]
    if mode in (b"120000", b"160000") or base in (b".gitattributes", b".gitmodules", b".npmrc"):
        bad.append(ascii(name))
if bad:
    print("candidate tree entries refused: " + ", ".join(bad[:5]), file=sys.stderr)
    raise SystemExit(1)
'

# Archive gate: regular files and directories only, no traversal, no links.
readonly TAR_CHECK='import sys, tarfile
count = 0
with tarfile.open(sys.argv[1], "r:") as t:
    for m in t:
        count += 1
        if m.name.startswith("/") or ".." in m.name.split("/"):
            raise SystemExit("unsafe member name")
        if not (m.isreg() or m.isdir()):
            raise SystemExit("non-regular archive member")
print(count)
'

# Identity files for the container. Only uid 10001 exists, with home /work/home.
readonly PASSWD_LINES='root:x:0:0:root:/root:/usr/sbin/nologin
proof:x:10001:10001:proof:/work/home:/usr/sbin/nologin'
readonly GROUP_LINES='root:x:0:
proof:x:10001:'

# HOME check run under env -i, the exact shape of the consumer config leg. Without a passwd entry,
# Node's os.homedir() fails inside libuv with uv_os_homedir, which is the expected negative text.
readonly HOME_CHECK='if(require("node:os").homedir()!=="/work/home")process.exit(1)'

say() { printf 'proof: %s %s\n' "$1" "$2"; }
die() { printf 'proof: FAILED %s\n' "$*" >&2; exit 1; }

# emit_untrusted: stdin is printed between a random stop-commands token and its closing token, so
# registry or candidate text cannot issue workflow commands or masks.
emit_untrusted() {
  local token
  token=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  printf '::stop-commands::%s\n' "$token"
  cat
  printf '::%s::\n' "$token"
}

RUN_TAG=$(printf '%s-%s-%s' "${GITHUB_RUN_ID:-local}" "${GITHUB_RUN_ATTEMPT:-0}" "$$" | tr -c 'A-Za-z0-9_.-' '-')
WORK_ROOT=''
STAGE=''
ACQ=''
HELPERS=''
GATEWAY=''
CANARY_PID=''
CANARY_LOG=''
CANARY_UDP_LOG=''
CANARY_PORT=''
CANARY_PORT_FILE=''
ACQ_ID=''
CONTROL_ID=''
RUN_ID=''
BASE=()

ctl_name() { printf 'nsmcp-%s-%s' "$RUN_TAG" "$1"; }
# count_lines <file>: number of canary hits recorded in a log. A missing file counts as zero.
count_lines() { [ -f "$1" ] && wc -l <"$1" | tr -d ' ' || echo 0; }

# canary_diagnostics: on a count that does not move, report hit counts, whether the canary process is
# alive, and which UDP sockets are bound to the canary port. No candidate text is printed; the canary's
# own log tail is printed between stop-commands tokens.
canary_diagnostics() {
  local alive=no
  if [ -n "${CANARY_PID:-}" ] && kill -0 "$CANARY_PID" 2>/dev/null; then alive=yes; fi
  say diagnostics "canary_alive=$alive port=$CANARY_PORT tcp_hits=$(count_lines "$CANARY_LOG") udp_hits=$(count_lines "$CANARY_UDP_LOG")"
  if command -v ss >/dev/null 2>&1; then
    ss -uanH 2>/dev/null | awk -v p=":$CANARY_PORT" '$4 ~ (p "$") { print "udp-socket " $1 " " $4 }' | head -n 4 | emit_untrusted || :
  fi
  tail -c 1024 "$WORK_ROOT/canary.out" 2>/dev/null | cut -c1-256 | emit_untrusted || :
}

require_env() {
  [[ "${CANDIDATE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || die "CANDIDATE_SHA must be 40 lowercase hex"
  [[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || die "GITHUB_SHA must be 40 lowercase hex"
  [ "${GITHUB_EVENT_NAME:-}" = workflow_dispatch ] || die "event must be workflow_dispatch"
  if ! [[ "${GITHUB_REF:-}" =~ ^refs/heads/proof/[A-Za-z0-9._/-]+$ ]] || [[ "$GITHUB_REF" == *..* ]]; then
    die "ref must be refs/heads/proof/*"
  fi
  [[ "${GITHUB_WORKSPACE:-}" == /* ]] || die "GITHUB_WORKSPACE is not set"
  git -C "$GITHUB_WORKSPACE" rev-parse --git-dir >/dev/null 2>&1 || die "GITHUB_WORKSPACE is not a git checkout"
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
  local head parent tree_file diff_rc=0
  git -C "$GITHUB_WORKSPACE" rev-parse --verify --quiet "$CANDIDATE_SHA^{commit}" >/dev/null \
    || die "candidate commit is not present in the checkout"
  head=$(git -C "$GITHUB_WORKSPACE" rev-parse --verify HEAD) || die "cannot resolve HEAD"
  [ "$head" = "$GITHUB_SHA" ] || die "HEAD is not GITHUB_SHA"
  parent=$(git -C "$GITHUB_WORKSPACE" rev-parse --verify HEAD^) \
    || die "HEAD^ is missing; the checkout needs fetch-depth: 2"
  [ "$parent" = "$CANDIDATE_SHA" ] || die "HEAD^ is not CANDIDATE_SHA"

  # Exit 0 means no difference outside .github; 1 means a difference; anything else is a git failure.
  git -C "$GITHUB_WORKSPACE" diff --quiet --no-ext-diff --no-renames HEAD^ HEAD \
    -- . ':(exclude,glob).github/**' || diff_rc=$?
  case "$diff_rc" in
    0) ;;
    1) die "workflow commit changes a path outside .github/" ;;
    *) die "git diff failed (exit $diff_rc)" ;;
  esac

  tree_file=$(mktemp "$RUNNER_TEMP/nsmcp-tree.XXXXXX") || die "cannot create a tree listing"
  if ! git -C "$GITHUB_WORKSPACE" ls-tree -r -z --full-tree "$CANDIDATE_SHA" >"$tree_file"; then
    rm -f "$tree_file"
    die "git ls-tree failed"
  fi
  if ! python3 -c "$TREE_CHECK" "$tree_file"; then
    rm -f "$tree_file"
    die "candidate tree has a link, submodule or git or npm configuration file"
  fi
  rm -f "$tree_file"

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

# acquire_cache: the acquisition container is created, started and removed by ID. Its stdout is
# capped at the cache bound during the stream, its stderr at 64 KiB, and it is killed at a deadline.
acquire_cache() {
  local rc=0 size
  ACQ_ID=$(docker create --pull never --init --log-driver none --name "$(ctl_name acquire)" \
    --user "$PROOF_UID:$PROOF_UID" \
    --cap-drop ALL --security-opt no-new-privileges --read-only \
    --pids-limit 512 --memory 6g --memory-swap 6g --cpus "$CONTAINER_CPUS" --workdir /work \
    --tmpfs "/work:rw,nosuid,nodev,exec,size=3g,uid=$PROOF_UID,gid=$PROOF_UID,mode=0700" \
    --tmpfs "/tmp:rw,nosuid,nodev,size=512m,mode=1777" \
    --mount "type=bind,source=$ACQ/input,target=/input,readonly" \
    -e HOME=/work/home -e LANG=C -e PATH=/usr/local/bin:/usr/bin:/bin \
    "$IMAGE" /bin/sh /input/warm-deps.sh) || die "acquisition container could not be created"
  timeout --kill-after=30 "$ACQ_TIMEOUT_SECONDS" docker start -a "$ACQ_ID" \
    2> >(head -c 65536 >"$ACQ/acquire.log") \
    | head -c "$((CACHE_MAX_BYTES + 1))" >"$ACQ/cache.tar" || rc=$?
  docker rm -f "$ACQ_ID" >/dev/null 2>&1 || :
  ACQ_ID=''
  size=$(stat -c %s "$ACQ/cache.tar" 2>/dev/null || echo 0)
  if [ "$rc" -ne 0 ] || [ "$size" -eq 0 ] || [ "$size" -gt "$CACHE_MAX_BYTES" ]; then
    rm -f "$ACQ/cache.tar"
    tail -c 4096 "$ACQ/acquire.log" 2>/dev/null | cut -c1-512 | emit_untrusted >&2 || :
    die "acquisition failed or exceeded its bound (exit $rc, bytes $size)"
  fi
  install -m 0444 "$ACQ/cache.tar" "$STAGE/cache.tar"
  rm -f "$ACQ/cache.tar"
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

  # The protected inventory is derived from the archive on the host, pinned in the digest manifest,
  # and independently re-derived inside the container before any candidate code runs.
  python3 "$HELPERS/check-tree.py" list "$STAGE/source.tar" >"$STAGE/expected-tests.txt" \
    || die "archive test inventory failed"
  [ -s "$STAGE/expected-tests.txt" ] || die "archive has no protected test inventory"
  chmod 0444 "$STAGE/expected-tests.txt"

  printf '%s\n' "$PASSWD_LINES" >"$STAGE/passwd"
  printf '%s\n' "$GROUP_LINES" >"$STAGE/group"
  chmod 0444 "$STAGE/passwd" "$STAGE/group"

  fetch "$JRE_URL" "$STAGE/jre.tar.gz" "$JRE_SHA256" "$JRE_BYTES"
  fetch "$EMULATOR_URL" "$STAGE/cloud-firestore-emulator.jar" "$EMULATOR_SHA256" "$EMULATOR_BYTES"

  docker pull "$IMAGE" >"$ACQ/pull.log" 2>&1 || { tail -c 2048 "$ACQ/pull.log" | cut -c1-512 | emit_untrusted >&2 || :; die "image pull failed"; }
  [ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$IMAGE")" = linux/amd64 ] \
    || die "pinned image is not linux/amd64"

  git -C "$GITHUB_WORKSPACE" show "$CANDIDATE_SHA:package.json" >"$ACQ/input/package.json" || die "cannot read package.json"
  git -C "$GITHUB_WORKSPACE" show "$CANDIDATE_SHA:package-lock.json" >"$ACQ/input/package-lock.json" \
    || die "cannot read package-lock.json"
  chmod 0444 "$ACQ/input/package.json" "$ACQ/input/package-lock.json"
  install -m 0444 "$HELPERS/warm-deps.sh" "$ACQ/input/warm-deps.sh"
  acquire_cache
  check_tar "$STAGE/cache.tar"

  install -m 0444 "$HELPERS/inner.sh" "$HELPERS/check-boundary.cjs" "$HELPERS/check-filesystem.py" \
    "$HELPERS/check-tree.py" "$STAGE/"
  (
    cd "$STAGE"
    sha256sum source.tar jre.tar.gz cloud-firestore-emulator.jar cache.tar \
      inner.sh check-boundary.cjs check-filesystem.py check-tree.py \
      expected-tests.txt passwd group > SHA256SUMS
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

# build_base <ro|rw> <container-name> [passwd|nopasswd]: the hardened argument set shared by every container.
# nopasswd exists only so the HOME control can show that the passwd entry is what makes HOME resolve.
build_base() {
  local root=$1 name=$2 identity=${3:-passwd}
  BASE=(
    --pull never --init --name "$name" --user "$PROOF_UID:$PROOF_UID"
    --cap-drop ALL --security-opt no-new-privileges --ipc none
    --pids-limit 1024 --memory 8g --memory-swap 8g --cpus "$CONTAINER_CPUS"
    --tmpfs "/tmp:rw,exec,nosuid,nodev,size=512m,mode=1777"
    --tmpfs "/opt:rw,nosuid,nodev,size=512m,uid=$PROOF_UID,gid=$PROOF_UID,mode=0755"
    --tmpfs "/run:rw,noexec,nosuid,nodev,size=64m,uid=$PROOF_UID,gid=$PROOF_UID,mode=0755"
    --tmpfs "/work:rw,exec,nosuid,nodev,size=3g,uid=$PROOF_UID,gid=$PROOF_UID,mode=0700"
    --mount "type=bind,source=$STAGE,target=/stage,readonly"
    --workdir /work
    -e HOME=/work/home -e LANG=C -e PATH=/usr/local/bin:/usr/bin:/bin
    --log-opt max-size=1m --log-opt max-file=1
  )
  if [ "$identity" = passwd ]; then
    BASE+=(
      --mount "type=bind,source=$STAGE/passwd,target=/etc/passwd,readonly"
      --mount "type=bind,source=$STAGE/group,target=/etc/group,readonly"
    )
  fi
  if [ "$root" = ro ]; then BASE+=(--read-only); fi
}

# start_canary: one host process with a TCP canary and a UDP canary on the same port number.
# TCP hits go to CANARY_LOG, one line per accepted connection. UDP hits go to CANARY_UDP_LOG, one line
# per datagram, and each datagram receives a fixed reply. Only bridge containers can reach either.
start_canary() {
  command -v node >/dev/null 2>&1 || die "node is required on the runner for the canary"
  need_docker
  GATEWAY=$(docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}') \
    || die "docker bridge network not found"
  [[ "$GATEWAY" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "bridge gateway is not IPv4"
  CANARY_LOG="$WORK_ROOT/canary.log"
  CANARY_UDP_LOG="$WORK_ROOT/canary-udp.log"
  CANARY_PORT_FILE="$WORK_ROOT/canary.port"
  : >"$CANARY_LOG"
  : >"$CANARY_UDP_LOG"
  rm -f "$CANARY_PORT_FILE"
  CANARY_HOST="$GATEWAY" CANARY_LOG="$CANARY_LOG" CANARY_UDP_LOG="$CANARY_UDP_LOG" CANARY_PORT_FILE="$CANARY_PORT_FILE" \
    node - >"$WORK_ROOT/canary.out" 2>&1 <<'JS' &
const net = require('node:net');
const dgram = require('node:dgram');
const fs = require('node:fs');
const { CANARY_HOST: host, CANARY_LOG: log, CANARY_UDP_LOG: udpLog, CANARY_PORT_FILE: portFile } = process.env;
let hits = 0;
const server = net.createServer(socket => {
  hits += 1;
  fs.appendFileSync(log, `${socket.remoteAddress}\n`);
  socket.end('canary-hit\n');
  if (hits >= 50) server.close();
});
server.on('error', e => { console.error(e.code); process.exit(1); });
server.listen(0, host, () => {
  const port = server.address().port;
  const udp = dgram.createSocket('udp4');
  udp.on('error', e => { console.error(e.code); process.exit(1); });
  udp.on('message', (_msg, rinfo) => {
    fs.appendFileSync(udpLog, `${rinfo.address}\n`);
    udp.send('canary-udp-hit\n', rinfo.port, rinfo.address, err => { if (err) console.error('udp reply send: ' + err.code); });
  });
  udp.bind(port, host, () => fs.writeFileSync(portFile, String(port)));
});
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
  say canary "listening on the bridge gateway (tcp and udp)"
}

stop_canary() {
  if [ -n "${CANARY_PID:-}" ]; then
    kill "$CANARY_PID" 2>/dev/null || :
    wait "$CANARY_PID" 2>/dev/null || :
    CANARY_PID=''
  fi
}

# wait_lines <file> <want>: the canary log is appended by a separate process, so a hit may land a moment
# after the container exits. Poll for up to 3 s before judging the count.
wait_lines() {
  local file=$1 want=$2 i
  for i in $(seq 1 30); do
    [ "$(count_lines "$file")" = "$want" ] && return 0
    sleep 0.1
  done
  canary_diagnostics
  return 1
}

# control <pass|fail> <label> <expected-output-regex|-> -- <docker create args and image command...>
# A pass must exit 0. A fail must exit non-zero AND print the expected text, so a Docker error, a
# crash, or an unrelated failure cannot count as the negative control.
control() {
  local want=$1 label=$2 expect=$3 rc=0 out id
  shift 4
  out="$WORK_ROOT/control-$label.log"
  id=$(docker create "$@") || die "control $label could not be created"
  CONTROL_ID=$id
  timeout --kill-after=10 "$CONTROL_TIMEOUT_SECONDS" docker start -a "$id" >"$out" 2>&1 || rc=$?
  docker rm -f "$id" >/dev/null 2>&1 || :
  CONTROL_ID=''
  if [ "$want" = pass ]; then
    if [ "$rc" -ne 0 ]; then
      tail -c 2048 "$out" | cut -c1-512 | emit_untrusted >&2 || :
      canary_diagnostics
      die "control $label failed (exit $rc)"
    fi
    if [ -s "$out" ]; then head -c 512 "$out" | cut -c1-256 | emit_untrusted || :; fi
  else
    [ "$rc" -ne 0 ] || die "negative control $label passed, so the check cannot fail"
    if ! grep -Fq -- "$expect" "$out"; then
      tail -c 2048 "$out" | cut -c1-512 | emit_untrusted >&2 || :
      die "negative control $label failed for an unexpected reason"
    fi
  fi
  say "control:$label" "$want-as-required"
}

controls() {
  verify_stage
  [ -n "${CANARY_PID:-}" ] || die "canary is not running"
  local name tcp0 tcp1 udp0 udp1 canary_file rw_dir

  # TCP reachability. The bridge reaches the host canary (positive). A single-target TCP probe that
  # must be unreachable reports "unexpected connection" and records one canary hit (negative). From
  # network none the same probe is unreachable and records nothing (positive).
  tcp0=$(count_lines "$CANARY_LOG")
  name=$(ctl_name reach-canary); build_base ro "$name"
  control pass reach-canary - -- "${BASE[@]}" --network bridge \
    "$IMAGE" node /stage/check-boundary.cjs reach "$GATEWAY" "$CANARY_PORT"
  wait_lines "$CANARY_LOG" "$((tcp0 + 1))" || die "canary did not record the TCP positive-control connection"
  tcp1=$(count_lines "$CANARY_LOG")

  name=$(ctl_name probe-tcp-bridge); build_base ro "$name"
  control fail tcp-bridge-must-fail 'unexpected connection' -- "${BASE[@]}" --network bridge \
    "$IMAGE" node /stage/check-boundary.cjs probe-tcp "$GATEWAY" "$CANARY_PORT" 4
  wait_lines "$CANARY_LOG" "$((tcp1 + 1))" || die "TCP bridge probe did not record its canary hit"
  tcp1=$(count_lines "$CANARY_LOG")

  name=$(ctl_name probe-tcp-none); build_base ro "$name"
  control pass tcp-probe-no-network - -- "${BASE[@]}" --network none \
    "$IMAGE" node /stage/check-boundary.cjs probe-tcp "$GATEWAY" "$CANARY_PORT" 4
  [ "$(count_lines "$CANARY_LOG")" = "$tcp1" ] || die "TCP canary received a connection from the no-network probe"

  # UDP reachability, shown separately from TCP. Each control is judged by the host canary's UDP hit count,
  # not by a reply: the bridge positive must record one datagram arrival, the bridge negative must print
  # "udp send succeeded" and record one arrival, and the no-network positive must fail as unreachable and
  # record none. A canary reply, when it returns, is printed only as a diagnostic.
  udp0=$(count_lines "$CANARY_UDP_LOG")
  name=$(ctl_name reach-udp); build_base ro "$name"
  control pass reach-udp-canary - -- "${BASE[@]}" --network bridge \
    "$IMAGE" node /stage/check-boundary.cjs reach-udp "$GATEWAY" "$CANARY_PORT"
  wait_lines "$CANARY_UDP_LOG" "$((udp0 + 1))" || die "UDP canary did not record the positive-control datagram"
  udp1=$(count_lines "$CANARY_UDP_LOG")

  name=$(ctl_name probe-udp-bridge); build_base ro "$name"
  control fail udp-bridge-must-fail 'udp send succeeded' -- "${BASE[@]}" --network bridge \
    "$IMAGE" node /stage/check-boundary.cjs probe-udp "$GATEWAY" "$CANARY_PORT" 4
  wait_lines "$CANARY_UDP_LOG" "$((udp1 + 1))" || die "UDP bridge probe did not record its canary datagram"
  udp1=$(count_lines "$CANARY_UDP_LOG")

  name=$(ctl_name probe-udp-none); build_base ro "$name"
  control pass udp-probe-no-network - -- "${BASE[@]}" --network none \
    "$IMAGE" node /stage/check-boundary.cjs probe-udp "$GATEWAY" "$CANARY_PORT" 4
  [ "$(count_lines "$CANARY_UDP_LOG")" = "$udp1" ] || die "UDP canary received a datagram from the no-network probe"

  name=$(ctl_name boundary-bridge); build_base ro "$name"
  control fail boundary-bridge-must-fail 'unexpected network devices' -- "${BASE[@]}" --network bridge \
    "$IMAGE" node /stage/check-boundary.cjs boundary "$GATEWAY" "$CANARY_PORT"

  name=$(ctl_name boundary-none); build_base ro "$name"
  control pass boundary-no-network - -- "${BASE[@]}" --network none \
    "$IMAGE" node /stage/check-boundary.cjs boundary "$GATEWAY" "$CANARY_PORT"
  [ "$(count_lines "$CANARY_LOG")" = "$tcp1" ] || die "TCP canary received a connection from the no-network container"
  [ "$(count_lines "$CANARY_UDP_LOG")" = "$udp1" ] || die "UDP canary received a datagram from the no-network container"

  # Environment, read the way the candidate phase reads it: from bash, reading the container's own
  # environment through /proc/1 (the init process), so bash's exports (PWD, SHLVL, _) are not counted.
  name=$(ctl_name env-allowlist); build_base ro "$name"
  control pass env-allowlist - -- "${BASE[@]}" --network none \
    "$IMAGE" /bin/bash -c 'node /stage/check-boundary.cjs env /proc/1/environ'
  name=$(ctl_name env-canary-token); build_base ro "$name"
  control fail env-canary-token-must-fail 'denied environment names: ACTIONS_RUNTIME_TOKEN' -- "${BASE[@]}" \
    --network none -e ACTIONS_RUNTIME_TOKEN=canary \
    "$IMAGE" /bin/bash -c 'node /stage/check-boundary.cjs env /proc/1/environ'

  name=$(ctl_name status-hardened); build_base ro "$name"
  control pass status-hardened - -- "${BASE[@]}" --network none \
    "$IMAGE" node /stage/check-boundary.cjs status
  name=$(ctl_name status-cap-add); build_base ro "$name"
  control fail status-cap-add-must-fail 'is not empty' -- "${BASE[@]}" --network none \
    --cap-add NET_ADMIN "$IMAGE" node /stage/check-boundary.cjs status
  name=$(ctl_name status-seccomp); build_base ro "$name"
  control fail status-seccomp-unconfined-must-fail 'seccomp mode is not 2 (filter)' -- "${BASE[@]}" \
    --network none --security-opt seccomp=unconfined "$IMAGE" node /stage/check-boundary.cjs status
  name=$(ctl_name status-apparmor); build_base ro "$name"
  control fail status-apparmor-unconfined-must-fail 'AppArmor profile is not docker-default' -- "${BASE[@]}" \
    --network none --security-opt apparmor=unconfined "$IMAGE" node /stage/check-boundary.cjs status

  # Config leg: the consumer config leg spawns npx with an env of PATH only, so HOME must come from the
  # passwd entry. The positive control proves it; the negative removes that entry and must fail with
  # Node's uv_os_homedir error, which is not present in the check source itself.
  name=$(ctl_name home-passwd); build_base ro "$name"
  control pass home-from-passwd - -- "${BASE[@]}" --network none \
    "$IMAGE" env -i PATH=/usr/local/bin:/usr/bin:/bin node -e "$HOME_CHECK"
  name=$(ctl_name home-nopasswd); build_base ro "$name" nopasswd
  control fail home-without-passwd-must-fail 'uv_os_homedir' -- "${BASE[@]}" --network none \
    "$IMAGE" env -i PATH=/usr/local/bin:/usr/bin:/bin node -e "$HOME_CHECK"

  name=$(ctl_name devices); build_base ro "$name"
  control pass devices-allowlist - -- "${BASE[@]}" --network none \
    "$IMAGE" python3 /stage/check-filesystem.py devices

  canary_file="$WORK_ROOT/canary-file"
  rm -f "$canary_file"
  printf 'canary\n' >"$canary_file"
  chmod 0444 "$canary_file"
  name=$(ctl_name mount-canary); build_base ro "$name"
  control fail mount-canary-must-fail 'unexpected mount: /canary-host' -- "${BASE[@]}" --network none \
    --mount "type=bind,source=$canary_file,target=/canary-host,readonly" \
    "$IMAGE" python3 /stage/check-filesystem.py mounts
  name=$(ctl_name mounts); build_base ro "$name"
  control pass mounts-allowlist - -- "${BASE[@]}" --network none \
    "$IMAGE" python3 /stage/check-filesystem.py mounts

  name=$(ctl_name writes-readonly); build_base ro "$name"
  control pass writes-readonly - -- "${BASE[@]}" --network none \
    "$IMAGE" python3 /stage/check-filesystem.py writes
  rw_dir="$WORK_ROOT/rw-canary"
  rm -rf "$rw_dir"
  mkdir -m 0777 "$rw_dir"
  chmod 0777 "$rw_dir"
  name=$(ctl_name writes-rw-canary); build_base ro "$name"
  control fail writes-rw-canary-must-fail 'writable: /canary-rw/nsmcp-write-probe' -- "${BASE[@]}" --network none \
    --mount "type=bind,source=$rw_dir,target=/canary-rw" \
    "$IMAGE" python3 /stage/check-filesystem.py writes /canary-rw

  # Emulator launch form: the candidate-independent jar and JRE must start, own 127.0.0.1:8080 and answer
  # the protected marker and reset API in this container shape. The probe prints the form it proved.
  name=$(ctl_name emulator-launch); build_base ro "$name"
  control pass emulator-launch - -- "${BASE[@]}" --network none \
    "$IMAGE" /bin/bash /stage/inner.sh --launch-probe
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
  local code tcp0 udp0
  tcp0=$(count_lines "$CANARY_LOG")
  udp0=$(count_lines "$CANARY_UDP_LOG")
  build_base ro "nsmcp-proof-$RUN_TAG"
  RUN_ID=$(docker create "${BASE[@]}" --network none "$IMAGE" /bin/bash /stage/inner.sh "$GATEWAY" "$CANARY_PORT") \
    || die "candidate container could not be created"
  docker start "$RUN_ID" >/dev/null || die "candidate container did not start"
  if ! code=$(timeout --kill-after=60 "$RUN_TIMEOUT_SECONDS" docker wait "$RUN_ID"); then
    docker kill "$RUN_ID" >/dev/null 2>&1 || :
    die "candidate did not finish within its bound"
  fi
  docker logs --tail 4000 "$RUN_ID" 2>&1 | cut -c1-1024 >"$WORK_ROOT/candidate.log" || :
  head -c 262144 "$WORK_ROOT/candidate.log" | emit_untrusted
  docker rm -f "$RUN_ID" >/dev/null 2>&1 || :
  RUN_ID=''
  [ "$(count_lines "$CANARY_LOG")" = "$tcp0" ] || die "TCP canary received a connection during the candidate run"
  [ "$(count_lines "$CANARY_UDP_LOG")" = "$udp0" ] || die "UDP canary received a datagram during the candidate run"
  [ "$code" = 0 ] || die "candidate exit status $code"
  grep -qx 'proof-phase complete passed' "$WORK_ROOT/candidate.log" \
    || die "candidate did not reach the completion marker"
  say run "passed exit=$code"
}

run_mode() {
  require_env
  start_canary
  run
}

cleanup() {
  local rc=$? id
  trap - EXIT
  for id in "$ACQ_ID" "$CONTROL_ID" "$RUN_ID"; do
    if [ -n "$id" ]; then docker rm -f "$id" >/dev/null 2>&1 || :; fi
  done
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
