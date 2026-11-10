#!/bin/bash
# Candidate runner. Runs inside the hardened proof container as UID 10001 with /stage read-only,
# no network, no capabilities and a read-only root. Output is bounded: phase lines plus tails of
# failing logs. Exit status is the verdict.
#
#   inner.sh <canary-gateway-ipv4> <canary-port>   full candidate run
#   inner.sh --launch-probe                        emulator launch form validation only (control);
#                                                  takes no gateway, so the boundary phase is skipped
#
# Order matches CI: committed-source check and Vitest, then build, then pack. The archived tree is
# compared with the working tree at each step, so a build or pack that rewrites tracked files fails.
set -Eeuo pipefail
umask 077
export PATH=/usr/local/bin:/usr/bin:/bin LANG=C

readonly work=/work
readonly stage=/stage
readonly jar=/stage/cloud-firestore-emulator.jar
readonly java_flags=(-XX:-UsePerfData -Xmx1g -Duser.language=en)

mode=candidate
gateway=''
canary_port=''
if [ "${1:-}" = --launch-probe ]; then
  [ "$#" -eq 1 ] || { echo 'proof: usage: inner.sh --launch-probe' >&2; exit 2; }
  mode=launch-probe
else
  [ "$#" -eq 2 ] || { echo 'proof: usage: inner.sh <gateway> <port>' >&2; exit 2; }
  gateway=$1
  canary_port=$2
  case "$gateway" in ''|*[!0-9.]*) echo 'proof: bad gateway' >&2; exit 2;; esac
  case "$canary_port" in ''|*[!0-9]*) echo 'proof: bad port' >&2; exit 2;; esac
fi

emulator=''
emulator_identity=''
emulator_form=''
current=initialization

phase() { printf 'proof-phase %s %s\n' "$1" "$2"; }

cleanup() {
  local rc=$?
  trap - EXIT
  if [ "$rc" -ne 0 ]; then phase "$current" failed; fi
  if [ -n "$emulator" ]; then
    kill "$emulator" 2>/dev/null || :
    wait "$emulator" 2>/dev/null || :
  fi
  exit "$rc"
}
trap cleanup EXIT

# run_phase <name> <command...>: full log stays in /work; only a bounded tail is printed on failure.
run_phase() {
  local name=$1 rc=0
  shift
  current=$name
  "$@" >"$work/logs/$name.log" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then
    tail -c 8192 "$work/logs/$name.log" | cut -c1-1024 >&2 || :
    return "$rc"
  fi
  phase "$name" passed
}

# start_emulator: tries each launch form the jar supports until one owns 127.0.0.1:8080 and answers
# the protected-project marker and reset API. Each attempt has its own 120 s monotonic budget in the checker.
start_emulator() {
  local form
  local -a forms argv
  mapfile -t forms < <(python3 "$stage/check-tree.py" launch "$jar")
  [ "${#forms[@]}" -gt 0 ] || return 1
  for form in "${forms[@]}"; do
    case "$form" in
      jar-firebase) argv=(-jar "$jar" --host 127.0.0.1 --port 8080) ;;
      class) argv=(-cp "$jar" com.google.cloud.datastore.emulator.firestore.CloudFirestore start --host=127.0.0.1 --port=8080) ;;
      jar-start) argv=(-jar "$jar" start --host=127.0.0.1 --port=8080) ;;
      *) return 1 ;;
    esac
    "$work/jre/bin/java" "${java_flags[@]}" "${argv[@]}" >"$work/logs/emulator-$form.log" 2>&1 &
    emulator=$!
    if node "$stage/check-boundary.cjs" emulator "$emulator" 2>"$work/logs/emulator-$form.check"; then
      emulator_identity=$(node "$stage/check-boundary.cjs" identity "$emulator") || return 1
      emulator_form=$form
      return 0
    fi
    kill "$emulator" 2>/dev/null || :
    wait "$emulator" 2>/dev/null || :
    emulator=''
    printf 'proof: emulator form %s did not become ready\n' "$form" >&2
    tail -c 2048 "$work/logs/emulator-$form.check" | cut -c1-512 >&2 || :
  done
  return 1
}

check_emulator_identity() {
  [ -n "$emulator_identity" ] && [ "$(node "$stage/check-boundary.cjs" identity "$emulator")" = "$emulator_identity" ]
}

current=preflight
[ "$(id -u)" = 10001 ] || { echo 'proof: not running as uid 10001' >&2; exit 1; }
[ ! -e /opt/cutover ] && [ ! -e /run/cutover ] || { echo 'proof: fixed cutover paths already exist' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'proof: python3 is missing from the image' >&2; exit 1; }
mkdir -p "$work/src" "$work/jre" "$work/cache" "$work/home" "$work/logs"
phase "$current" passed

current=environment
node "$stage/check-boundary.cjs" env /proc/1/environ
node "$stage/check-boundary.cjs" status
phase "$current" passed

# The boundary phase needs the canary, so only a candidate run performs it. The launch probe is
# validated by its own controls in the host launcher.
if [ "$mode" = candidate ]; then
  current=boundary
  node "$stage/check-boundary.cjs" boundary "$gateway" "$canary_port"
  phase "$current" passed
fi

current=filesystem
python3 "$stage/check-filesystem.py" all
phase "$current" passed

current=integrity
(cd "$stage" && sha256sum --quiet -c SHA256SUMS)
phase "$current" passed

# The JRE is needed by both modes. Its banner must name the pinned Temurin release.
current=jre
tar -xzf "$stage/jre.tar.gz" -C "$work/jre" --strip-components=1 --no-same-owner
java_banner=$("$work/jre/bin/java" -version 2>&1 | sed -n '1p')
case "$java_banner" in
  *'"21.0.13"'*) ;;
  *) echo "proof: unexpected JRE banner: $java_banner" >&2; exit 1 ;;
esac
phase "$current" passed

if [ "$mode" = launch-probe ]; then
  current=emulator-launch
  start_emulator || { echo 'proof: no emulator launch form became ready' >&2; exit 1; }
  check_emulator_identity
  phase "$current" passed
  printf 'proof: launch-probe passed form=%s\n' "$emulator_form"
  exit 0
fi

# Archive-derived inventory, written before any candidate code runs. The host wrote the same list into
# /stage (digest-pinned), and the two must agree.
current=inventory
python3 "$stage/check-tree.py" list "$stage/source.tar" >"$work/expected-tests.txt"
cmp -s "$work/expected-tests.txt" "$stage/expected-tests.txt" || { echo 'proof: inventory differs from stage' >&2; exit 1; }
phase "$current" passed

current=prepare
tar -xf "$stage/source.tar" -C "$work/src" --no-same-owner
python3 "$stage/check-tree.py" compare "$stage/source.tar" "$work/src"
phase "$current" passed

current=emulator
start_emulator || { echo 'proof: no emulator launch form became ready' >&2; exit 1; }
check_emulator_identity
phase "$current" passed

export HOME="$work/home" npm_config_cache="$work/cache" npm_config_logs_dir="$work/logs"
export npm_config_offline=true npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false
export npm_config_userconfig=/dev/null npm_config_globalconfig="$work/home/empty-npmrc"
export npm_config_ignore_scripts=false
unset NPM_CONFIG_IGNORE_SCRIPTS
: >"$work/home/empty-npmrc"
tar -xf "$stage/cache.tar" -C "$work/cache" --no-same-owner
export NETSAPIENS_CUTOVER_CONTAINER=1 NETSAPIENS_CUTOVER_TEMP_CONTAINER=1
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GOOGLE_CLOUD_PROJECT=firestore-test NSMCP_REQUIRE_FIRESTORE_EMULATOR=1
cd "$work/src"

run_phase npm-ci npm ci --offline
run_phase check-cutover npm run check:cutover
current=committed-source
python3 "$stage/check-tree.py" compare "$stage/source.tar" "$work/src"
phase "$current" passed

[ ! -e "$work/vitest.json" ] || { echo 'proof: vitest output already exists' >&2; exit 1; }
run_phase vitest npx vitest run --no-file-parallelism --testTimeout=120000 --hookTimeout=120000 \
  --reporter=json --outputFile="$work/vitest.json"
check_emulator_identity
current=protected-results
node "$stage/check-boundary.cjs" results "$work/vitest.json" "$stage/expected-tests.txt" "$work/src"
phase "$current" passed

run_phase build npm run build
current=post-build-source
python3 "$stage/check-tree.py" compare "$stage/source.tar" "$work/src"
phase "$current" passed

current=pack
if ! npm pack --json --foreground-scripts=false --pack-destination "$work" >"$work/pack.json" 2>"$work/logs/pack.log"; then
  tail -c 8192 "$work/logs/pack.log" | cut -c1-1024 >&2 || :
  exit 1
fi
candidate=$(node -e 'const fs=require("node:fs"),path=require("node:path");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!Array.isArray(x)||x.length!==1||x[0].version!=="3.0.1"||typeof x[0].filename!=="string"||path.basename(x[0].filename)!==x[0].filename)process.exit(1);process.stdout.write(path.join(process.argv[2],x[0].filename))' "$work/pack.json" "$work")
test -f "$candidate"
[ "$(find "$work" -maxdepth 1 -type f -name '*.tgz' | wc -l | tr -d ' ')" = 1 ] || { echo 'proof: pack produced more than one tarball' >&2; exit 1; }
sha256sum "$candidate"
sha512sum "$candidate"
phase "$current" passed

current=post-pack-source
python3 "$stage/check-tree.py" compare "$stage/source.tar" "$work/src"
phase "$current" passed

run_phase verify-pack node scripts/verify-pack.mjs "$candidate" 3.0.1

# Default consumer runs with the environment CI's consumer job has: no emulator or cutover variables.
run_phase consumer-default env -u NETSAPIENS_CUTOVER_CONTAINER -u NETSAPIENS_CUTOVER_TEMP_CONTAINER \
  -u FIRESTORE_EMULATOR_HOST -u GOOGLE_CLOUD_PROJECT -u NSMCP_REQUIRE_FIRESTORE_EMULATOR \
  node scripts/consumer-e2e.mjs --tarball "$candidate"
check_emulator_identity

for major in 7 8 9; do
  current="emulator-reset-$major"
  node "$stage/check-boundary.cjs" emulator "$emulator"
  check_emulator_identity
  phase "$current" passed
  run_phase "consumer-firestore-$major" node scripts/consumer-e2e.mjs --tarball "$candidate" \
    --legs firestore --firestore-major "$major"
  check_emulator_identity
done

current=postflight
(cd "$stage" && sha256sum --quiet -c SHA256SUMS)
node "$stage/check-boundary.cjs" boundary "$gateway" "$canary_port"
python3 "$stage/check-filesystem.py" mounts
python3 "$stage/check-filesystem.py" writes
phase "$current" passed

current=complete
phase "$current" passed
