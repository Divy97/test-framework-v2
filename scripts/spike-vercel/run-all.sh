#!/bin/sh
# Run every item in order and keep the verdict lines. Cleans up first and last.
#
# A script that CRASHES prints no verdict, so its exit is examined too: 0 is done, 1 with
# FAIL lines is a failed item, 2 is SKIP, and anything else — or a 1 with no FAIL line, which
# is an uncaught exception — is recorded as CRASH with its last lines, never left blank.
set -u
cd "$(dirname "$0")/../.."
out=${1:-docs/milestone-10-spike.log}
tmp=$(mktemp)
: > "$out"
for script in scripts/spike-vercel/00-cleanup.ts scripts/spike-vercel/0[1-9]-*.ts scripts/spike-vercel/1[0-2]-*.ts scripts/spike-vercel/00-cleanup.ts; do
  echo "== $script" | tee -a "$out"
  npx tsx --env-file=.env "$script" > "$tmp" 2>&1
  rc=$?
  grep -E '^(PASS|FAIL|INFO|SKIP)' "$tmp" | tee -a "$out"
  fails=$(grep -c '^FAIL' "$tmp")
  if [ "$rc" -gt 2 ] || { [ "$rc" -eq 1 ] && [ "$fails" -eq 0 ]; }; then
    # The error's own lines, then the tail: a Node stack ends in a brace and a version
    # string, which is what a three-line tail showed the first time and told nobody why.
    { echo "CRASH  $script  exit $rc"; grep -E 'Error|error' "$tmp" | head -n 5 | sed 's/^/       /'; tail -n 15 "$tmp" | sed 's/^/       /'; } | tee -a "$out"
  fi
done
rm -f "$tmp"
echo; echo "written to $out"; grep -c '^FAIL' "$out" | sed 's/^/FAIL lines: /'; grep -c '^CRASH' "$out" | sed 's/^/CRASH lines: /'
