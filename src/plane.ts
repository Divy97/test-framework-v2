// The control plane: pairing, dispatch, and the authorization that replaces topology.
//
// Locally, "one writer" is enforced by there being one process on one machine
// (ADR-0009). Hosted, the orchestrator moves to somebody's laptop and that mechanism
// is gone — so the rule has to be re-established as a check rather than a fact about
// deployment. This module is that check.
//
// Its shape follows from one decision: the plane MINTS the run id and never writes an
// event. Dispatch lives in `jobs`, which is configuration like `installations` and
// `recipes` already are; the log stays a thing exactly one runner appends to. A runner
// that invents a run id matches no job and is refused, and a runner that guesses
// somebody else's matches a job dispatched elsewhere and is refused for that.
//
// What this module deliberately does NOT do is decide whether a runner's observations
// are true. It cannot: the container ran on hardware we do not own. ADR-0019 states
// what the product may claim as a result, and the honest answer is that evidence is
// scoped to the installation that produced it.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Db } from './store.js';
import type { RunEvent } from './events.js';

/** A paired machine. The token is not here — only its hash ever is. */
/**
 * A machine allowed to take work, and which work it may take.
 *
 * `installationId: null` means ANY installation — the worker this project operates
 * itself (M10, 10e). Until M10 every runner belonged to one installation because every
 * runner was somebody's laptop, and the filter in `claimJob` was the whole of the
 * boundary. A hosted worker cannot be per-installation: it is one process serving
 * everyone who installs the App.
 *
 * The widening is deliberately narrow. `null` is only ever written by the operator
 * script, never by anything a user can reach; a runner that names an installation is
 * still confined to it exactly as before; and no route anywhere reads this field to
 * decide what a run may touch — that comes from the `jobs` row, so a global runner gets
 * what the job it holds is entitled to and nothing else.
 */
export type Runner = { id: string; installationId: number | null; name: string };

/** One unit of work: a delivery the plane accepted, waiting for a machine. */
export type Job = { runId: string; installationId: number; repo: string; intake: unknown };

/**
 * `tfr_` so a leaked token is greppable in a log, a paste, or a support ticket, and
 * 32 bytes because this is the only thing standing between a stranger and the right to
 * write somebody's evidence.
 */
const TOKEN_PREFIX = 'tfr_';
const TOKEN_BYTES = 32;

/** How often the long poll looks again. Presence is worth more than a tight loop. */
const POLL_INTERVAL_MS = 500;

const digest = (token: string): string => createHash('sha256').update(token).digest('hex');
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Pair a machine to an installation and return the token ONCE.
 *
 * The caller is a human who is already authenticated with GitHub OAuth and has been
 * checked against this installation — that check belongs to the surface, not here, and
 * this function must never be reachable without it.
 */
export async function pairRunner(
  client: Db,
  options: { installationId: number | null; name: string },
): Promise<{ runner: Runner; token: string }> {
  const id = randomUUID();
  const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
  await client.query(
    'insert into runners (id, installation_id, name, token_hash) values ($1, $2, $3, $4)',
    [id, options.installationId, options.name, digest(token)],
  );
  return { runner: { id, installationId: options.installationId, name: options.name }, token };
}

/**
 * Who is this, or nobody.
 *
 * Looked up BY hash rather than compared after fetching: the index does the work, and
 * there is no row-by-row secret comparison for anyone to time. The `timingSafeEqual`
 * below is belt-and-braces on the one comparison that remains, and costs nothing.
 *
 * A revoked runner verifies as nobody, which is the point of keeping the row.
 */
export async function verifyRunner(client: Db, token: string | undefined): Promise<Runner | null> {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
  const wanted = digest(token);
  const { rows } = await client.query(
    'select id, installation_id, name, token_hash from runners where token_hash = $1 and revoked_at is null',
    [wanted],
  );
  const row = rows[0] as
    | { id: string; installation_id: string | null; name: string; token_hash: string }
    | undefined;
  if (!row) return null;
  const a = Buffer.from(row.token_hash, 'utf8');
  const b = Buffer.from(wanted, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  // `bigint` arrives as a string from pg, and an installation id compared as a string
  // in one place and a number in another is a comparison that silently never matches.
  // `null` stays null — `Number(null)` is 0, which is a valid-looking installation id
  // and would confine the global worker to an installation nobody has.
  return {
    id: row.id,
    installationId: row.installation_id === null ? null : Number(row.installation_id),
    name: row.name,
  };
}

/** Every machine paired to an installation, revoked ones included — the row is the record. */
export async function listRunners(
  client: Db,
  installationId: number,
): Promise<(Runner & { pairedAt: string; lastSeen: string | null; revokedAt: string | null })[]> {
  const { rows } = await client.query(
    `select id, installation_id, name, paired_at, last_seen, revoked_at
       from runners where installation_id = $1 order by paired_at desc`,
    [installationId],
  );
  const iso = (value: Date | null) => (value === null ? null : new Date(value).toISOString());
  return rows.map((row) => ({
    id: row.id,
    installationId: Number(row.installation_id),
    name: row.name,
    pairedAt: new Date(row.paired_at).toISOString(),
    lastSeen: iso(row.last_seen),
    revokedAt: iso(row.revoked_at),
  }));
}

/**
 * Stop a machine writing, without losing who wrote what.
 *
 * Scoped to an installation, and REQUIRED to be — not because the caller cannot be
 * trusted to check, but because one of them did not. The route authorized the
 * repository in its path and then passed the runner id from the URL straight through,
 * so anyone with access to any repository could revoke somebody else's runner by id: a
 * cross-tenant denial of service, found by review after it shipped.
 *
 * The check belongs here rather than at the call site for exactly that reason. A future
 * route that accepts a runner id from a URL cannot forget an argument it has to supply,
 * and a mismatch updates nothing rather than the wrong row.
 *
 * Returns whether it revoked anything, so a caller can tell "not yours" from "already
 * revoked" instead of reporting success either way.
 */
export async function revokeRunner(
  client: Db,
  runnerId: string,
  installationId: number | null,
): Promise<boolean> {
  const { rowCount } = await client.query(
    // `is not distinct from`, not `=`. A global runner's `installation_id` is null, and
    // `null = null` is null — so with `=` the row matched nothing and the most valuable
    // credential in the system could not be revoked by any value at all, including null.
    // One `tfr_` string claims any installation's job and then mints that installation's
    // GitHub token; the only remedy was hand-written SQL.
    //
    // This does NOT widen who may revoke what. The caller supplies the installation, and
    // the only caller that can supply null is the operator script — the dashboard route
    // passes an installation the signed-in person can see, exactly as before, and a
    // confined runner still cannot be revoked by naming the wrong one.
    `update runners set revoked_at = now()
       where id = $1 and installation_id is not distinct from $2::bigint and revoked_at is null`,
    [runnerId, installationId],
  );
  return (rowCount ?? 0) > 0;
}

/** Note that a runner is alive. Called on every poll, so presence is never stale by more than one. */
export async function sawRunner(client: Db, runnerId: string): Promise<void> {
  await client.query('update runners set last_seen = now() where id = $1', [runnerId]);
}

/**
 * Accept a delivery and mint the run id it will be known by, forever.
 *
 * This is the whole of the plane's authority over the log: it decides that a run
 * exists and who may write it. It writes no event — the first event of the run is
 * `RUN_REQUESTED`, and it comes from the runner along with everything else, so the
 * stream has one author from seq 1 (ADR-0009).
 */
export async function enqueueJob(
  client: Db,
  options: {
    installationId: number;
    repo: string;
    intake: unknown;
    /** The GitHub user id of whoever pressed Start (M10); absent for a webhook delivery. */
    requestedBy?: number;
    /** Copied out of the intake so `openJobFor` is an index lookup, not a jsonb scan. */
    issueNumber?: number;
  },
): Promise<string> {
  const runId = randomUUID();
  await client.query(
    `insert into jobs (run_id, installation_id, repo, intake, requested_by, issue_number)
       values ($1, $2, $3, $4, $5, $6)`,
    [
      runId,
      options.installationId,
      options.repo,
      JSON.stringify(options.intake),
      options.requestedBy ?? null,
      options.issueNumber ?? null,
    ],
  );
  return runId;
}

/**
 * The run already under way for this issue, if there is one (M10).
 *
 * Two presses of Start — or one while the first run is still going — would queue two
 * runs that clone the same commit and race to open two pull requests. `finished_at` is
 * stamped by the runner on every ending, so an unfinished job is one that is genuinely
 * in flight; the two-hour ceiling is for the one whose runner died with it, which would
 * otherwise block this issue forever.
 *
 * Check-then-insert, not a constraint, and honestly so: two presses in the same instant
 * can both pass. A unique partial index cannot express the two-hour ceiling, and an
 * advisory lock needs one connection held across a transaction, which `Db` being a pool
 * (ADR-0020) does not hand a route. The button disables itself on click (10i); this is
 * the server's best effort behind it, and it is worth knowing which of the two is which.
 */
export async function openJobFor(client: Db, repo: string, issueNumber: number): Promise<string | null> {
  const { rows } = await client.query(
    `select run_id from jobs
       where repo = $1 and issue_number = $2 and finished_at is null
         and queued_at > now() - interval '2 hours'
       order by queued_at desc
       limit 1`,
    [repo, issueNumber],
  );
  const row = rows[0] as { run_id: string } | undefined;
  return row?.run_id ?? null;
}

/**
 * Take the oldest unclaimed job for this runner's installation, or wait for one.
 *
 * `for update skip locked` because two runners paired to the same installation will
 * poll at the same moment, and the alternative to skipping is one of them blocking on
 * a row it is about to be told it cannot have.
 *
 * ponytail: a long poll, not a stream. ADR-0005 argues for SSE where the traffic is a
 * FEED — many messages, resumable — and dispatch is one small message at a time. The
 * `Route` contract is request/response, so a stream here would mean surgery on
 * `startStatusServer` for a message that arrives every few minutes. Move to SSE when a
 * runner needs to be told more than one thing at a time.
 */
export async function claimJob(
  client: Db,
  runner: Runner,
  options: { waitMs?: number } = {},
): Promise<Job | null> {
  const deadline = Date.now() + (options.waitMs ?? 0);
  for (;;) {
    const { rows } = await client.query(
      // `$1 is null or installation_id = $1` — one predicate, two runners.
      //
      // A runner that names an installation is filtered to it, exactly as before: this
      // is the boundary that stops one person's laptop taking another person's work, and
      // widening it by accident would be the worst bug in this file. A runner that names
      // none takes the oldest job of anyone's, which is what a worker we operate has to
      // do to serve every installation from one process.
      //
      // Cast, because pg cannot infer a type for a parameter that is only ever compared
      // to null — without it the driver sends an untyped null and the comparison against
      // `bigint` fails at plan time.
      `update jobs set runner_id = $2, dispatched_at = now()
         where run_id = (
           select run_id from jobs
             where ($1::bigint is null or installation_id = $1::bigint) and runner_id is null
             order by queued_at
             limit 1
             for update skip locked
         )
       returning run_id, installation_id, repo, intake`,
      [runner.installationId, runner.id],
    );
    const row = rows[0] as { run_id: string; installation_id: string; repo: string; intake: unknown } | undefined;
    if (row) {
      return {
        runId: row.run_id,
        installationId: Number(row.installation_id),
        repo: row.repo,
        intake: row.intake,
      };
    }
    if (Date.now() >= deadline) return null;
    await wait(POLL_INTERVAL_MS);
  }
}

/**
 * What a job says about itself: its repository, and who pressed Start (M10).
 *
 * Read from `jobs` rather than taken from the caller, and that is the whole point of it
 * existing. The two routes that hand values to a worker — the repository's secrets and
 * the requester's model key — must scope them to THIS run, not to a repository or a user
 * the runner names. A runner authorized for a run gets exactly what that run's row says.
 *
 * `requestedBy` is null for a job that arrived by webhook, which no longer starts runs on
 * the plane. Absence is "before the button existed", not "unknown".
 */
export async function jobFacts(
  client: Db,
  runId: string,
): Promise<{ repo: string; installationId: number; requestedBy: number | null } | null> {
  const { rows } = await client.query(
    'select repo, installation_id, requested_by from jobs where run_id = $1',
    [runId],
  );
  const row = rows[0] as { repo: string; installation_id: string; requested_by: string | null } | undefined;
  if (!row) return null;
  return {
    repo: row.repo,
    installationId: Number(row.installation_id),
    requestedBy: row.requested_by === null ? null : Number(row.requested_by),
  };
}

/** The job is over, however it ended. Bookkeeping only — never authorization. */
export async function finishJob(client: Db, runId: string): Promise<void> {
  await client.query('update jobs set finished_at = now() where run_id = $1', [runId]);
}

/**
 * What a runner is refused for, said in the words the caller should return.
 *
 * Prose rather than a boolean because the two refusals are different facts and a
 * runner operator has to be able to tell them apart: a run that does not exist is a
 * client bug, and a run dispatched elsewhere is either a stale process or an attack.
 */
export type Refusal = { refused: string; appended?: number };

/**
 * Append a batch of events on behalf of a runner.
 *
 * Three properties, and each one is load-bearing:
 *
 * 1. **Authorized.** The job for this run must have been dispatched to THIS runner.
 *    Not "same installation" — the runner that was given the work is the only writer
 *    of it, which is ADR-0009's rule surviving the move off one machine.
 * 2. **Idempotent.** A runner on a home connection will retry a batch it already sent.
 *    `(run_id, seq)` is unique, so a replay of identical bytes is a no-op that returns
 *    success. Anything else would push operators toward "just skip the retry", which
 *    loses events.
 * 3. **Immutable.** The same seq with DIFFERENT bytes is refused and the whole batch
 *    is rolled back. That is the append-only claim made real: the log cannot be edited
 *    by the one participant with a legitimate reason to write to it.
 */
export async function appendFromRunner(
  client: Db,
  runner: Runner,
  runId: string,
  events: RunEvent[],
): Promise<{ appended: number } | Refusal> {
  const { rows } = await client.query(
    'select runner_id from jobs where run_id = $1',
    [runId],
  );
  const job = rows[0] as { runner_id: string | null } | undefined;
  if (!job) return { refused: 'no such run' };
  if (job.runner_id !== runner.id) return { refused: 'this run was dispatched to another runner' };

  // NO TRANSACTION, and it is a decision rather than an omission.
  //
  // Two reasons. The domain one: an append-only log has no "un-append". Events already
  // written are observations that happened, and rolling three of them back because the
  // fourth collided would delete facts to punish a client bug.
  //
  // The mechanical one: `Db` is a POOL. Each `query()` is answered by whichever
  // connection is free, so a `begin` issued here and a `commit` issued three statements
  // later are not promised to reach the same one — the transaction would open on one
  // connection and be committed on another, or never. A real transaction needs a client
  // checked out of the pool and released in a `finally`, which is worth writing when
  // something actually needs to be atomic. This does not.
  //
  // What makes that safe is that there is nothing to serialise: authorization admits
  // exactly one runner per run, so the only concurrent writer of a given run is that
  // runner retrying itself, and `on conflict do nothing` makes a retry a no-op.
  let appended = 0;
  for (const event of events) {
    if (event.run_id !== runId) {
      return { refused: `event ${event.seq} names run ${event.run_id}, not ${runId}` };
    }
    const payload = JSON.stringify(event.payload);
    const inserted = await client.query(
      `insert into events (run_id, seq, type, payload, ts) values ($1, $2, $3, $4, $5)
         on conflict (run_id, seq) do nothing`,
      [event.run_id, event.seq, event.type, payload, event.ts],
    );
    if (inserted.rowCount === 1) {
      appended += 1;
      continue;
    }
    // Already there. Identical content is a retry; different content is an attempt to
    // rewrite history, and the difference is the entire value of the log.
    //
    // Compared BY POSTGRES, with `payload = $3::jsonb`, and that is not a stylistic
    // choice. `jsonb` does not preserve key order — it normalises on the way in — so a
    // round-tripped payload stringifies differently from the bytes the runner sent, and
    // a `JSON.stringify` comparison here refused every honest retry as a forgery. The
    // idempotency test found it on the first run.
    const existing = await client.query(
      'select type, payload = $3::jsonb as same from events where run_id = $1 and seq = $2',
      [event.run_id, event.seq, payload],
    );
    const had = existing.rows[0] as { type: string; same: boolean } | undefined;
    if (!had || had.type !== event.type || !had.same) {
      return { refused: `seq ${event.seq} is already recorded with different content`, appended };
    }
  }
  return { appended };
}
