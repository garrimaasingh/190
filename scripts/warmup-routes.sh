#!/usr/bin/env bash
# Warm up every API route after a dev-server restart.
#
# WHY (Phase 6 ops lesson): Next.js dev compiles each route on first
# hit; under this sandbox's memory pressure the first compile
# occasionally races and returns 500 ("Unexpected end of JSON input" /
# spurious handler errors). The worklog documented this as the
# "transient cold-compile failure — stable re-run" pattern. Warmup
# compiles every route module BEFORE suites run; any status code
# (401/403/404/405) proves the module compiled. Retries each route
# once on 5xx.
#
# Usage: bash scripts/warmup-routes.sh [cookie-file-or-empty]
set -u
cd /home/z/my-project

COOKIE_HEADER=""
if [ -f /tmp/warmup-cookie.txt ]; then
  COOKIE_HEADER="Cookie: $(cat /tmp/warmup-cookie.txt)"
fi

mapfile -t ROUTES < <(find src/app/api/v1 -name route.ts | sed 's|^src/app/api||; s|/route\.ts$||; s|\[\([a-zA-Z]*\)\]|warmup|g')

fail=0
warmed=0
for r in "${ROUTES[@]}"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -X GET "http://localhost:3000/api/v1${r#/api/v1}" -H "$COOKIE_HEADER" --max-time 60 2>/dev/null || echo 000)
  if [[ "$code" =~ ^5 || "$code" == "000" ]]; then
    sleep 1
    code=$(curl -s -o /dev/null -w "%{http_code}" -X GET "http://localhost:3000/api/v1${r#/api/v1}" -H "$COOKIE_HEADER" --max-time 60 2>/dev/null || echo 000)
  fi
  if [[ "$code" =~ ^5 || "$code" == "000" ]]; then
    echo "WARM-FAIL $code /api/v1${r#/api/v1}"
    fail=$((fail+1))
  else
    warmed=$((warmed+1))
  fi
done
echo "[warmup] $warmed routes compiled, $fail failures"
exit $fail
