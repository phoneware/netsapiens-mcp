#!/bin/bash
# Candidate runner. Executes inside the hardened proof container as UID 10001 with
# /stage read-only, no network, no capabilities and a read-only root. Output is
# bounded: phase lines plus the tails of failing logs. Exit status is the verdict.
# Usage: inner.sh <canary-gateway-ipv4> <canary-port>
set -Eeuo pipefail
umask 077
export PATH=/usr/local/bin:/usr/bin:/bin LANG=C

if [ "$#" -ne 2 ]; then echo 'proof: usage: inner.sh <gateway> <port>' >&2; exit 2; fi
gateway=$1
canary_port=$2
case "$gateway" in ''|*[!0-9.]*) echo 'proof: bad gateway' >&2; exit 2;; esac
case "$canary_port" in ''|*[!0-9]*) echo 'proof: bad port' >&2; exit 2;; esac

readonly work=/work
readonly stage=/stage
readonly jar=/stage/cloud-firestore-emulator.jar
emulator=''
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

printf 'proof: candidate and checker share UID 10001; output is functional evidence, not an attestation\n'

current=preflight
[ "$(id -u)" = 10001 ] || { echo 'proof: not running as uid 10001' >&2; exit 1; }
[ ! -e /opt/cutover ] && [ ! -e /run/cutover ] || { echo 'proof: fixed cutover paths already exist' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'proof: python3 is missing from the image' >&2; exit 1; }
phase "$current" passed

current=environment
node "$stage/check-boundary.cjs" env
node "$stage/check-boundary.cjs" status
phase "$current" passed

current=boundary
node "$stage/check-boundary.cjs" boundary "$gateway" "$canary_port"
phase "$current" passed

current=filesystem
python3 "$stage/check-filesystem.py" all
phase "$current" passed

current=integrity
(cd "$stage" && sha256sum --quiet -c SHA256SUMS)
phase "$current" passed

current=prepare
mkdir -p "$work/src" "$work/jre" "$work/cache" "$work/home" "$work/logs"
: >"$work/home/empty-npmrc"
tar -xf "$stage/source.tar" -C "$work/src" --no-same-owner
tar -xzf "$stage/jre.tar.gz" -C "$work/jre" --strip-components=1 --no-same-owner
tar -xf "$stage/cache.tar" -C "$work/cache" --no-same-owner
java_banner=$("$work/jre/bin/java" -version 2>&1 | sed -n '1p')
case "$java_banner" in
  *'"21.0.13"'*) ;;
  *) echo "proof: unexpected JRE banner: $java_banner" >&2; exit 1 ;;
esac
# -jar when the emulator manifest names a main class; otherwise -cp with the CloudFirestore class.
launch=$(python3 - "$jar" <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
names = set(z.namelist())
manifest = z.read("META-INF/MANIFEST.MF").decode("utf-8", "replace") if "META-INF/MANIFEST.MF" in names else ""
if any(line.startswith("Main-Class:") for line in manifest.splitlines()):
    print("jar")
elif "com/google/cloud/datastore/emulator/firestore/CloudFirestore.class" in names:
    print("class")
else:
    raise SystemExit("emulator jar has no usable launch path")
PY
)
phase "$current" passed

export HOME="$work/home" npm_config_cache="$work/cache" npm_config_logs_dir="$work/logs"
export npm_config_offline=true npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false
export npm_config_userconfig=/dev/null npm_config_globalconfig="$work/home/empty-npmrc"
export npm_config_ignore_scripts=false
unset NPM_CONFIG_IGNORE_SCRIPTS

current=emulator
java_opts=(-XX:-UsePerfData -Xmx1g -Duser.language=en)
if [ "$launch" = jar ]; then
  "$work/jre/bin/java" "${java_opts[@]}" -jar "$jar" start --host=127.0.0.1 --port=8080 \
    >"$work/logs/emulator.log" 2>&1 &
else
  "$work/jre/bin/java" "${java_opts[@]}" -cp "$jar" \
    com.google.cloud.datastore.emulator.firestore.CloudFirestore start --host=127.0.0.1 --port=8080 \
    >"$work/logs/emulator.log" 2>&1 &
fi
emulator=$!
if ! node "$stage/check-boundary.cjs" emulator "$emulator"; then
  tail -c 8192 "$work/logs/emulator.log" | cut -c1-1024 >&2 || :
  exit 1
fi
emulator_identity=$(node "$stage/check-boundary.cjs" identity "$emulator")
check_emulator_identity() {
  [ "$(node "$stage/check-boundary.cjs" identity "$emulator")" = "$emulator_identity" ]
}
phase "$current" passed

export NETSAPIENS_CUTOVER_CONTAINER=1 NETSAPIENS_CUTOVER_TEMP_CONTAINER=1
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GOOGLE_CLOUD_PROJECT=firestore-test NSMCP_REQUIRE_FIRESTORE_EMULATOR=1
cd "$work/src"

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

run_phase npm-ci npm ci --offline
run_phase build npm run build
run_phase check-cutover npm run check:cutover
[ ! -e "$work/vitest.json" ] || { echo 'proof: vitest output already exists' >&2; exit 1; }
run_phase vitest npx vitest run --no-file-parallelism --testTimeout=120000 --hookTimeout=120000 \
  --reporter=json --outputFile="$work/vitest.json"
check_emulator_identity
current=protected-results
node "$stage/check-boundary.cjs" results "$work/vitest.json" "$work/src"
phase "$current" passed

current=pack
npm pack --json --pack-destination "$work" >"$work/pack.json" 2>"$work/logs/pack.log"
candidate=$(node -e 'const fs=require("node:fs"),path=require("node:path");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!Array.isArray(x)||x.length!==1||x[0].version!=="3.0.1"||typeof x[0].filename!=="string"||path.basename(x[0].filename)!==x[0].filename)process.exit(1);process.stdout.write(path.join(process.argv[2],x[0].filename))' "$work/pack.json" "$work")
test -f "$candidate"
sha256sum "$candidate"
sha512sum "$candidate"
phase "$current" passed

run_phase verify-pack node scripts/verify-pack.mjs "$candidate" 3.0.1
run_phase consumer-default node scripts/consumer-e2e.mjs --tarball "$candidate"
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
