#!/bin/bash
# FINAL Phase 6 verification — complete protocol:
# pristine reset -> seed AI-drain settle check -> per-suite restart +
# FULL route warmup -> AI autoProcess off for storage suites -> one run each.
set -e
cd /home/z/my-project

login_cookie() {
  curl -s -X POST http://localhost:3000/api/v1/auth/login -H "Content-Type: application/json" \
    -d "$1" -D - -o /dev/null | grep -i "^set-cookie" | cut -d' ' -f2 | cut -d';' -f1
}
restart_and_warm() {
  python3 scripts/start-dev-daemon.py
  sleep 14
  echo "$1" > /dev/null
  SYSA=$(login_cookie '{"email":"sysadmin@demo.gov.in","password":"Demo@Pass1"}')
  echo "$SYSA" > /tmp/warmup-cookie.txt
  bash scripts/warmup-routes.sh
}
ai_config() {
  curl -s -X PUT http://localhost:3000/api/v1/ai/config -H "Content-Type: application/json" \
    -H "Cookie: $(cat /tmp/warmup-cookie.txt)" -d "{\"autoProcess\":$1}" -o /dev/null -w "ai=$1:%{http_code}\n"
}
suite() {
  echo "=== phase$1 ==="
  bun test tests/api/phase$1.test.ts 2>&1 | grep -vE "prisma:query" | grep -E "^ *[0-9]+ (pass|fail)|^\(fail\)" | tail -4
}

reset_and_seed() {
  rm -f db/custom.db
  bun prisma db push --accept-data-loss >/dev/null 2>&1
  bun prisma/seed.ts 2>&1 | grep -vE "prisma:query" | grep -E "COMPLETED:5|Graph: 6/6"
  bun scripts/apply-sqlite-guards.ts >/dev/null 2>&1
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
