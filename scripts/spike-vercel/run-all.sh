#!/bin/sh
# Run every item in order and keep the PASS/FAIL/INFO lines. Cleans up first and last.
set -u
cd "$(dirname "$0")/../.."
out=${1:-docs/milestone-10-spike.log}
: > "$out"
for script in scripts/spike-vercel/00-cleanup.ts scripts/spike-vercel/0[1-9]-*.ts scripts/spike-vercel/1[0-2]-*.ts scripts/spike-vercel/00-cleanup.ts; do
  echo "== $script" | tee -a "$out"
  npx tsx --env-file=.env "$script" 2>&1 | grep -E '^(PASS|FAIL|INFO|SKIP)' | tee -a "$out" || true
done
echo; echo "written to $out"; grep -c '^FAIL' "$out" | sed 's/^/FAIL lines: /'
