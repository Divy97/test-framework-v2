import { defineConfig } from 'vitest/config';

// `.env` holds DATABASE_URL, and `test/store.test.ts` is the only coverage the SQL
// has. Without this it skipped for want of a variable that was sitting on disk — a
// skip nobody would notice, which is the worst kind. `loadEnvFile` is Node 22's own,
// so no dotenv; wrapped because a machine with no `.env` is a valid state and the
// test's skip message is the correct outcome there.
try {
  process.loadEnvFile?.('.env');
} catch {
  // No .env. `test/store.test.ts` will say so in its skip message.
}

// The engine fixtures shell out to real git and run a repro three times, so the
// slowest tests sit near vitest's 5s default and fail under load. Raise the
// ceiling rather than let a green suite depend on how busy the machine is.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    // `.claude/worktrees/*` holds full checkouts of this repository, so the default
    // glob collected every test file TWICE — 18 files where there are 9, and every
    // container test run against a copy of `src` nobody is editing. It doubled the
    // suite's wall clock and, worse, a stale worktree could fail on code that is
    // not the code under change. Excluded rather than deleted: the worktrees are
    // not this suite's to remove.
    // `demo/**` is a REPOSITORY, not part of this suite. Its own tests are a
    // `node --test` suite that the environment recipe runs inside the sandbox —
    // which is the whole point of it — and vitest cannot load them anyway, since
    // vite does not resolve `node:sqlite`. Collecting them here would also mean
    // this engine's suite failing when the demo's deliberate bugs are being worked
    // on, which is exactly backwards.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**', 'demo/**'],
  },
});
