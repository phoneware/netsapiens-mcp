#!/bin/sh
# Acquisition only. Runs in the pinned node image on the default bridge (npm needs the registry),
# with /input (package.json, package-lock.json) mounted read-only. No candidate code runs here: scripts
# are disabled and only the two manifests are read. stdout carries only the npm cache tar. npm output
# goes to /work/logs; stderr carries a bounded tail on failure only.
set -eu
exec 3>&1 1>&2

export HOME=/work/home
export npm_config_cache=/work/cache npm_config_logs_dir=/work/logs
export npm_config_userconfig=/dev/null npm_config_globalconfig=/work/home/empty-npmrc
export npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false
export npm_config_ignore_scripts=true

mkdir -p /work/home /work/cache /work/logs /work/lock /work/warm
: >/work/home/empty-npmrc

# run_logged <label> <command...>: output goes to a file; only a 4 KiB tail is printed on failure.
run_logged() {
  label=$1
  shift
  if ! "$@" >>"/work/logs/$label.log" 2>&1; then
    tail -c 4096 "/work/logs/$label.log" >&2 || :
    echo "warm: $label failed" >&2
    exit 1
  fi
}

# Lock-exact tarballs for `npm ci --offline` in the candidate container.
cp /input/package.json /input/package-lock.json /work/lock/
cd /work/lock
run_logged lock npm ci --ignore-scripts

# Packuments and range resolutions for the consumer legs, which install ranges.
for id in base fs7 fs8 fs9 types7 types8 types9; do
  mkdir -p "/work/warm/$id"
  cd "/work/warm/$id"
  run_logged "init-$id" npm init -y
  case "$id" in
    base) run_logged "$id" npm install --ignore-scripts --legacy-peer-deps --no-audit --no-fund '@modelcontextprotocol/sdk@^1.32.2' 'axios@^1.20.0' 'express@^5.0.0' 'express-rate-limit@^8.2.2' 'zod@^3.25.0 || ^4.0.0' 'vitest@^4.1.11' typescript @types/node ;;
    fs7) run_logged "$id" npm install --ignore-scripts --legacy-peer-deps --no-audit --no-fund '@google-cloud/firestore@^7' 'vitest@^4.1.11' ;;
    fs8) run_logged "$id" npm install --ignore-scripts --legacy-peer-deps --no-audit --no-fund '@google-cloud/firestore@^8' 'vitest@^4.1.11' ;;
    fs9) run_logged "$id" npm install --ignore-scripts --legacy-peer-deps --no-audit --no-fund '@google-cloud/firestore@^9' 'vitest@^4.1.11' ;;
    types7) run_logged "$id" npm install --ignore-scripts --legacy-peer-deps --no-audit --no-fund '@google-cloud/firestore@7.11.0' ;;
    types8) run_logged "$id" npm install --ignore-scripts --legacy-peer-deps --no-audit --no-fund '@google-cloud/firestore@8.6.0' ;;
    types9) run_logged "$id" npm install --ignore-scripts --legacy-peer-deps --no-audit --no-fund '@google-cloud/firestore@9.0.0' ;;
  esac
done

cd /work
tar -C /work/cache --exclude=./_logs -cf - . >&3
