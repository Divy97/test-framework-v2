# The spike (M10, 10a)

Thirteen things Vercel Sandbox has to be shown to do before the executor is built on it —
the list is `docs/milestone-10.md` § "The spike, itemised". Each script prints `PASS` or
`FAIL` with the number beside it, or `SKIP` with what it needs.

```sh
# Either: log the Vercel CLI in and link this directory — the SDK reads that session and
# resolves the team and project itself (creating a default project if none exists):
npm i -g vercel && vercel login && vercel link --yes
# Or: an account token plus ids in .env — VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID.
scripts/spike-vercel/run-all.sh            # items 0–12, results in docs/milestone-10-spike.log
scripts/spike-vercel/13-push-images.sh     # CLI: vercel vcr; token path also needs VERCEL_TEAM_SLUG + VERCEL_PROJECT_NAME
# …wait for VCR to finish preparing the pushed image (Sandbox.create says `image_not_ready` until then), then:
ENGINE_VERCEL_AGENT_IMAGE=<ref> npx tsx --env-file=.env scripts/spike-vercel/06-chromium.ts
```

What the review of these scripts established about the managed image, without a token:
`vercel/sandbox/node:22` is Ubuntu, runs as `ubuntu` (uid 1000, passwordless `sudo`),
`/bin/sh` is dash, and it ships no `procps`, `nc` or `wget` — so `writeFiles` needs
`/opt/env` and `/work` made writable first (`prepare()` in `lib.ts`, which the executor
will need too), the probes are node one-liners, and nothing uses `pgrep` or bash-isms.

The linked Vercel project exists for two things only — Sandbox microVMs and the container
registry — and nothing is ever deployed to it. `vercel link` connects the GitHub repo by
default, and Vercel then tries to build every push (there is no `public/`, so it fails
loudly); the project has been disconnected from Git, and `vercel.json` at the repository
root says `git.deploymentEnabled: false` so a future re-link cannot quietly re-enable it.

`SPIKE_STREAM_SECONDS` (default 300, the criterion's five minutes) sets item 5's stream; `SPIKE_COLD_N` (default 10)
sets item 9's sample. `00-cleanup.ts` stops anything tagged `spike=m10` a crashed script
left running. Nothing here is engine code, and nothing here is asserted by the suite;
`npx tsc -p scripts/spike-vercel/tsconfig.json` checks the scripts against the SDK's types,
which is the only check they get until a token exists.
