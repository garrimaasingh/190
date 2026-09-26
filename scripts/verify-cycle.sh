#!/bin/bash
# Cycle A: baseline suites (1,2,3,4,5,8) with server restart between suites (OOM mitigation)
set -e
cd /home/z/my-project
restart() {
  python3 scripts/start-dev-daemon.py
  sleep 14
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/api/v1/auth/login -H "Content-Type: application/json" -d '{"email":"arjun.sharma@demo.gov.in","password":"Demo@Pass1"}')
  echo "[restart] login probe: $code"
}
for p in 1 2 3 4 5 8; do
  echo "=== phase$p ==="
  bun test tests/api/phase$p.test.ts 2>&1 | grep -vE "prisma:query" | grep -E "^ *[0-9]+ (pass|fail)|^\(fail\)" | tail -4
  restart
done
