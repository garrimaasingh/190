#!/bin/bash
# Task 12 — Phase 6 re-verification with FULL regression, hardened ordering:
#   1. KILL server BEFORE reset (free ~2GB RSS — seed + push are heavy; the
#      background run died from memory pressure / silent set -e exit)
#   2. pristine reset + seed + guards (VERBOSE on failure — no swallowed output)
#   3. restart + warmup before EVERY suite, one run per suite (runbook rules)
#   4. Cycle A: suites 1,2,3,4,5,8 — Cycle B: fresh reset + suite 6
set -u
cd /home/z/my-project

log() { echo "[$(date +%H:%M:%S)] $*"; }

login_cookie() {
  curl -s -X POST http://localhost:3000/api/v1/auth/login -H "Content-Type: application/json" \
    -d "$1" -D - -o /dev/null | grep -i "^set-cookie" | cut -d' ' -f2 | cut -d';' -f1
}

kill_server() {
  lsof -ti tcp:3000 | xargs -r kill -9 2>/dev/null
  pkill -9 -f 'next-server' 2>/dev/null || true
  pkill -9 -f 'next dev' 2>/dev/null || true
  # wait until port actually free
  for i in $(seq 1 20); do
    lsof -ti tcp:3000 >/dev/null 2>&1 || break
    sleep 1
  done
  sleep 2
}

reset_and_seed() {
  log "pristine reset: killing server first (free memory)"
  kill_server
  rm -f db/custom.db
  if ! bun prisma db push --accept-data-loss > /tmp/t12-push.log 2>&1; then
    echo "FATAL: db push failed"; tail -20 /tmp/t12-push.log; exit 1
  fi
  if ! bun prisma/seed.ts > /tmp/t12-seed.log 2>&1; then
    echo "FATAL: seed failed"; tail -30 /tmp/t12-seed.log; exit 1
  fi
  if ! grep -q "COMPLETED:5" /tmp/t12-seed.log; then
    echo "FATAL: seed did not reach COMPLETED:5 (AI pipeline did not settle)"; tail -30 /tmp/t12-seed.log; exit 1
  fi
  bun scripts/apply-sqlite-guards.ts > /tmp/t12-guards.log 2>&1 || { echo "FATAL: guards failed"; tail -10 /tmp/t12-guards.log; exit 1; }
  grep -E "Graph CASE" /tmp/t12-seed.log | head -6
  log "reset complete (seed COMPLETED:5, guards applied)"
}

restart_and_warm() {
  log "restart + warm"
  python3 scripts/start-dev-daemon.py > /tmp/t12-daemon.log 2>&1
  sleep 14
  SYSA=$(login_cookie '{"email":"sysadmin@demo.gov.in","password":"Demo@Pass1"}')
  if [ -z "$SYSA" ]; then echo "FATAL: warmup login failed"; exit 1; fi
  echo "$SYSA" > /tmp/warmup-cookie.txt
  bash scripts/warmup-routes.sh > /tmp/t12-warmup.log 2>&1 || { echo "FATAL: warmup failed"; tail -10 /tmp/t12-warmup.log; exit 1; }
  tail -1 /tmp/t12-warmup.log
}

ai_config() {
  curl -s -X PUT http://localhost:3000/api/v1/ai/config -H "Content-Type: application/json" \
    -H "Cookie: $(cat /tmp/warmup-cookie.txt)" -d "{\"autoProcess\":$1}" -o /dev/null -w "ai=$1:%{http_code}"
  echo
}

suite() {
  log "=== phase$1 ==="
  bun test tests/api/phase$1.test.ts > /tmp/t12-p$1.log 2>&1
  grep -vE "prisma:query" /tmp/t12-p$1.log | grep -E "^ *[0-9]+ (pass|fail)" | tail -2
  if grep -qE "^ *[1-9][0-9]* fail|^ *1 fail" /tmp/t12-p$1.log; then
    grep -vE "prisma:query" /tmp/t12-p$1.log | grep "(fail)" | head -6
  fi
}

echo "########## CYCLE A — baseline 1,2,3,4,5,8 ##########"
reset_and_seed
restart_and_warm
ai_config false
suite 1
restart_and_warm
suite 2
restart_and_warm
suite 3
restart_and_warm
suite 4
restart_and_warm
ai_config true
suite 5
restart_and_warm
suite 8

echo "########## CYCLE B — phase 6 on its own pristine DB ##########"
reset_and_seed
restart_and_warm
ai_config false
suite 6

echo "########## DONE ##########"
