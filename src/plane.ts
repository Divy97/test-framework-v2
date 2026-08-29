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
import type pg from 'pg';
import type { RunEvent } from './events.js';

/** A paired machine. The token is not here — only its hash ever is. */
export type Runner = { id: string; installationId: number; name: string };

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
  client: pg.Client,
  options: { installationId: number; name: string },
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
export async function verifyRunner(client: pg.Client, token: string | undefined): Promise<Runner | null> {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
  const wanted = digest(token);
  const { rows } = await client.query(
    'select id, installation_id, name, token_hash from runners where token_hash = $1 and revoked_at is null',
    [wanted],
  );
  const row = rows[0] as { id: string; installation_id: string; name: string; token_hash: string } | undefined;
  if (!row) return null;
  const a = Buffer.from(row.token_hash, 'utf8');
  const b = Buffer.from(wanted, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  // `bigint` arrives as a string from pg, and an installation id compared as a string
  // in one place and a number in another is a comparison that silently never matches.
  return { id: row.id, installationId: Number(row.installation_id), name: row.name };
}

/** Every machine paired to an installation, revoked ones included — the row is the record. */
export async function listRunners(
  client: pg.Client,
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
  client: pg.Client,
  runnerId: string,
  installationId: number,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `update runners set revoked_at = now()
       where id = $1 and installation_id = $2 and revoked_at is null`,
    [runnerId, installationId],
  );
  return (rowCount ?? 0) > 0;
}

/** Note that a runner is alive. Called on every poll, so presence is never stale by more than one. */
export async function sawRunner(client: pg.Client, runnerId: string): Promise<void> {
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
  client: pg.Client,
  options: { installationId: number; repo: string; intake: unknown },
): Promise<string> {
  const runId = randomUUID();
  await client.query(
    'insert into jobs (run_id, installation_id, repo, intake) values ($1, $2, $3, $4)',
    [runId, options.installationId, options.repo, JSON.stringify(options.intake)],
  );
  return runId;
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
  client: pg.Client,
  runner: Runner,
  options: { waitMs?: number } = {},
): Promise<Job | null> {
  const deadline = Date.now() + (options.waitMs ?? 0);
  for (;;) {
    const { rows } = await client.query(
      `update jobs set runner_id = $2, dispatched_at = now()
         where run_id = (
           select run_id from jobs
             where installation_id = $1 and runner_id is null
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

/** The job is over, however it ended. Bookkeeping only — never authorization. */
export async function finishJob(client: pg.Client, runId: string): Promise<void> {
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
  client: pg.Client,
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
  // The mechanical one: `pg.Client` is ONE connection, shared by every request this
  // process serves. A `begin` here interleaves with a concurrent request's statements on
  // the same wire — the classic single-connection transaction bug, and it would appear
  // only under load, as events landing inside somebody else's rollback.
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
