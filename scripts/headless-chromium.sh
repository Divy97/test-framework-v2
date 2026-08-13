#!/bin/sh
# A launcher for `src/browser.ts`, on a machine that is somebody's desktop.
#
# `Browser` spawns `$ENGINE_CHROMIUM` with no `--user-data-dir`. Inside the engine's own
# image that is right: one browser, one container, no profile anybody else is holding. On
# a developer's laptop it is not. Chrome resolves the default profile, finds an instance
# already holding it, hands its command line to that instance and exits 0 — so nothing
# ever listens on 9222, `waitForTarget` polls for twenty seconds and reports "the browser
# did not come up", with the binary sitting exactly where it said it should be. The
# failure names the wrong cause, which is the expensive part.
#
# So this adds the two flags a shared desktop needs and nothing else: a private profile
# directory and the first-run prompts suppressed. Headless, `--no-sandbox`, the debugging
# port and every other decision still come from `src/browser.ts` — that file is the thing
# under test, and a wrapper that started deciding those would be testing itself.
#
# Used only by `test/dashboard.browser.test.ts`, which points `ENGINE_CHROMIUM` here for
# the life of that one file and restores it afterwards.
set -eu

: "${ENGINE_CHROMIUM_BIN:?ENGINE_CHROMIUM_BIN is unset: the caller names the real browser}"

# The caller normally passes a directory it will delete. Falling back to `mktemp -d` keeps
# this runnable by hand, at the cost of a profile nobody reaps — which is why the caller
# passing one is the documented path.
PROFILE="${ENGINE_CHROMIUM_PROFILE:-$(mktemp -d)}"

exec "$ENGINE_CHROMIUM_BIN" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  "$@"
