#!/bin/bash
# Phase 9 verification protocol — pristine reset, restart+warm between suites,
# ONE run per suite (runbook: suites are not idempotent across re-runs).
set -u
cd /home/z/my-project

restart() {
  PID=$(lsof -t -i :3000 -sTCP:LISTEN 2>/dev/null)
  [ -n "$PID" ] && kill -9 $PID
  sleep 1
  # Runbook (Task 10): cap the V8 heap — the sandbox OOM-kills next-server
  # around 3GB RSS mid-suite otherwise.
  (NODE_OPTIONS="--max-old-space-size=1536" bun --max-old-space-size=1536 run dev > /tmp/justice-dev-outer.log 2>&1 &)
  sleep 7
  bash scripts/warmup-routes.sh > /tmp/warmup.log 2>&1
  echo "[restart+warmup done]"
}

fresh_reset() {
  PID=$(lsof -t -i :3000 -sTCP:LISTEN 2>/dev/null)
  [ -n "$PID" ] && kill -9 $PID
  sleep 1
  bunx prisma db push --force-reset --accept-data-loss --skip-generate > /dev/null 2>&1
  # Runbook (Task 9/12): SQLite immutability guards MUST be re-applied after
  # every db push — without them the audit-ledger DELETE/UPDATE guards are
  # absent and phase4's guard tests mutate real history.
  bun scripts/apply-sqlite-guards.ts > /tmp/reg-guards.log 2>&1 || { echo "FATAL: guards failed"; exit 1; }
  bun prisma/seed.ts > /tmp/reg-seed.log 2>&1
  echo "[pristine reset+guards+seed done]"
}

run_suite() {
  local p=$1
  local out=$(bun test tests/api/phase$p.test.ts 2>&1 | tail -4 | tr '\n' ' ')
  echo "phase$p: $out"
}

case "${1:-all}" in
  reset)
    fresh_reset
    restart
    ;;
  suite)
    # $2 = phase number; restart+warm, then a single run
    restart
    run_suite "$2"
    ;;
  *)
    echo "usage: $0 reset | suite <phase>"
    ;;
esac
