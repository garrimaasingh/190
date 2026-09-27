#!/usr/bin/env bash
# Package the project into a lean downloadable zip (no node_modules/.next/etc.)
set -euo pipefail

ROOT=/home/z/my-project
OUT_DIR=$ROOT/download
STAMP=$(date +%Y%m%d)
OUT=$OUT_DIR/justice-platform-project-$STAMP.zip

mkdir -p "$OUT_DIR"
rm -f "$OUT"

cd "$ROOT"
zip -r -q "$OUT" . \
  -x "node_modules/*" \
  -x ".next/*" \
  -x "skills/*" \
  -x "tool-results/*" \
  -x "download/*" \
  -x ".git/*" \
  -x "*.log" \
  -x "tsconfig.tsbuildinfo" \
  -x "db/custom.db-journal" \
  -x "db/custom.db-wal" \
  -x "db/custom.db-shm"

echo "--- Archive created:"
ls -lh "$OUT"

echo "--- Integrity test:"
unzip -t -qq "$OUT" && echo "OK: all entries valid"

echo "--- Entry count + top-level contents:"
unzip -l "$OUT" | tail -1
unzip -l "$OUT" | awk '{print $4}' | cut -d/ -f1 | sort -u | rg -v '^$' | head -30

echo "--- Largest entries:"
unzip -l "$OUT" | sort -k1 -n -r | head -8
