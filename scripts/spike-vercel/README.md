# The spike (M10, 10a)

Thirteen things Vercel Sandbox has to be shown to do before the executor is built on it —
the list is `docs/milestone-10.md` § "The spike, itemised". Each script prints `PASS` or
`FAIL` with the number beside it, or `SKIP` with what it needs.

```sh
# .env needs VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID (Hobby is enough)
scripts/spike-vercel/run-all.sh            # items 0–12, results in docs/milestone-10-spike.log
scripts/spike-vercel/13-push-images.sh     # needs VERCEL_TEAM_SLUG + VERCEL_PROJECT_NAME too
ENGINE_VERCEL_AGENT_IMAGE=<ref> npx tsx --env-file=.env scripts/spike-vercel/06-chromium.ts
```

`SPIKE_STREAM_SECONDS` (default 60) lengthens item 5's stream; `SPIKE_COLD_N` (default 10)
sets item 9's sample. `00-cleanup.ts` stops anything tagged `spike=m10` a crashed script
left running. Nothing here is engine code, and nothing here is asserted by the suite;
`npx tsc -p scripts/spike-vercel/tsconfig.json` checks the scripts against the SDK's types,
which is the only check they get until a token exists.
