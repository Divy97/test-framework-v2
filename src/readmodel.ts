// The read model and the bill (M6c, M6d): two tables that hold no truth.
//
// `run_projection` is a disposable cache over the event log — `rebuildProjection` drops
// every row and replays, and a test asserts the result is byte-identical. That property
// is the most interesting thing this milestone produces, because it is what makes the
// README's first architectural claim checkable rather than merely stated.
//
// `run_usage` and `run_compute` are the exception that proves the rule: they are NOT
// derivable from the log, deliberately. Inventing an event class to describe our own
// spending would put a fact about us into a log about the user's bug (ADR-0006), so what
// a run cost lives beside the log and never inside it. That means it cannot be rebuilt by
// replay, and losing it loses real information — which is the price of keeping the log
// clean, paid knowingly.
//
// Two halves of one bill: `run_usage` is the model, `run_compute` is the machines. Before
// 10e the second was always zero, because the machines were the operator's own laptop.

import { projectRun, type RunRow } from './projection.js';
import { readRun, type Db } from './store.js';

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));

const toRow = (row: Record<string, unknown>): RunRow => ({
  run_id: String(row.run_id),
  repo: String(row.repo),
  issue_number: Number(row.issue_number),
  status: row.status as RunRow['status'],
  tier: Number(row.tier),
  confidence: Number(row.confidence),
  ceiling: Number(row.ceiling),
  scoring: Number(row.scoring),
  regression: row.regression as RunRow['regression'],
  pr_url: row.pr_url === null ? null : String(row.pr_url),
  started_at: iso(row.started_at),
  ended_at: row.ended_at === null ? null : iso(row.ended_at),
  last_seq: Number(row.last_seq),
});

const COLUMNS =
  'run_id, repo, issue_number, status, tier, confidence, ceiling, scoring, regression, pr_url, started_at, ended_at, last_seq';

/**
 * Write one run's row, replacing whatever was there.
 *
 * Idempotent by construction: the row is a pure function of the events, so writing it
 * twice from the same log writes the same bytes. That is what lets the caller re-project
 * on every append without tracking whether it already had.
 */
export async function saveRunRow(client: Db, row: RunRow): Promise<void> {
  await client.query(
    `insert into run_projection (${COLUMNS})
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (run_id) do update set
         repo = $2, issue_number = $3, status = $4, tier = $5, confidence = $6,
         ceiling = $7, scoring = $8, regression = $9, pr_url = $10,
         started_at = $11, ended_at = $12, last_seq = $13`,
    [
      row.run_id, row.repo, row.issue_number, row.status, row.tier, row.confidence,
      row.ceiling, row.scoring, row.regression, row.pr_url, row.started_at,
      row.ended_at, row.last_seq,
    ],
  );
}

/** Re-derive one run's row from its events. Returns null if the run has no events. */
export async function projectOne(client: Db, runId: string): Promise<RunRow | null> {
  const row = projectRun(await readRun(client, runId));
  if (row) await saveRunRow(client, row);
  return row;
}

export async function listRuns(client: Db, repo?: string): Promise<RunRow[]> {
  const { rows } = repo
    ? await client.query(
        `select ${COLUMNS} from run_projection where repo = $1 order by started_at desc`,
        [repo],
      )
    : await client.query(`select ${COLUMNS} from run_projection order by started_at desc`);
  return rows.map(toRow);
}

export async function readRunRow(client: Db, runId: string): Promise<RunRow | null> {
  const { rows } = await client.query(`select ${COLUMNS} from run_projection where run_id = $1`, [runId]);
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Drop every row and rebuild from the log. The property, not a maintenance script.
 *
 * *"Delete the entire dashboard database and it rebuilds from the log"* is what milestone
 * 6 calls the most interesting thing it produces, and a claim like that is worth exactly
 * as much as the command that demonstrates it. `delete` rather than `truncate` so a
 * caller CAN run it inside a transaction — which, `Db` being a pool (ADR-0020), means a
 * caller holding one connection it checked out itself. Handed the pool, these two
 * statements may land on different connections and no transaction contains them.
 */
export async function rebuildProjection(client: Db): Promise<{ rebuilt: number; skipped: string[] }> {
  await client.query('delete from run_projection');
  const { rows } = await client.query('select distinct run_id from events');
  let rebuilt = 0;
  const skipped: string[] = [];
  for (const row of rows) {
    const runId = String(row.run_id);
    // Per-run, so one bad stream costs one row and not the command. `serve.ts` already
    // catches per-run for the same reason; the rebuild did not, and a rebuild that dies
    // on the first malformed log is a rebuild nobody can run — which would make 6c's
    // property true in principle and unusable in practice.
    try {
      if (await projectOne(client, runId)) rebuilt += 1;
      else skipped.push(runId);
    } catch {
      skipped.push(runId);
    }
  }
  return { rebuilt, skipped };
}

export type UsageRow = {
  run_id: string;
  phase: string;
  /**
   * Which phase of this name it was — 0 for the first, 1 for the second.
   *
   * A run has TWO `agent` phases, the repro agent and the fix agent, and without this the
   * second overwrote the first. Optional so every existing caller keeps compiling and
   * defaults to 0, which is right for every phase there is only one of.
   */
  n?: number;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  provider: string;
  model: string;
};

export async function saveUsage(client: Db, row: UsageRow): Promise<void> {
  await client.query(
    `insert into run_usage (run_id, phase, n, turns, input_tokens, output_tokens,
                            cache_read_input_tokens, cache_creation_input_tokens, provider, model)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (run_id, phase, n) do update set
         turns = $4, input_tokens = $5, output_tokens = $6,
         cache_read_input_tokens = $7, cache_creation_input_tokens = $8,
         provider = $9, model = $10`,
    [
      row.run_id, row.phase, row.n ?? 0, row.turns, row.input_tokens, row.output_tokens,
      row.cache_read_input_tokens, row.cache_creation_input_tokens, row.provider, row.model,
    ],
  );
}

/** What one sandbox cost, as the platform reported it when the session was stopped. */
export type ComputeRow = {
  run_id: string;
  sandbox_id: string;
  phase: string;
  active_cpu_ms: number | null;
  duration_ms: number | null;
  ingress_bytes: number | null;
  egress_bytes: number | null;
};

export async function saveCompute(client: Db, row: ComputeRow): Promise<void> {
  await client.query(
    `insert into run_compute (run_id, sandbox_id, phase, active_cpu_ms, duration_ms, ingress_bytes, egress_bytes)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (run_id, sandbox_id) do update set
         phase = $3, active_cpu_ms = $4, duration_ms = $5, ingress_bytes = $6, egress_bytes = $7`,
    [row.run_id, row.sandbox_id, row.phase, row.active_cpu_ms, row.duration_ms, row.ingress_bytes, row.egress_bytes],
  );
}

/** Null stays null. `Number(null)` is 0, and a zero here would be a measurement. */
const measure = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

export async function readCompute(client: Db, runId: string): Promise<ComputeRow[]> {
  const { rows } = await client.query(
    `select run_id, sandbox_id, phase, active_cpu_ms, duration_ms, ingress_bytes, egress_bytes
       from run_compute where run_id = $1 order by observed_at, sandbox_id`,
    [runId],
  );
  return rows.map((row) => ({
    run_id: String(row.run_id),
    sandbox_id: String(row.sandbox_id),
    phase: String(row.phase),
    active_cpu_ms: measure(row.active_cpu_ms),
    duration_ms: measure(row.duration_ms),
    ingress_bytes: measure(row.ingress_bytes),
    egress_bytes: measure(row.egress_bytes),
  }));
}

export async function readUsage(client: Db, runId: string): Promise<UsageRow[]> {
  const { rows } = await client.query(
    `select run_id, phase, n, turns, input_tokens, output_tokens,
            cache_read_input_tokens, cache_creation_input_tokens, provider, model
       from run_usage where run_id = $1 order by phase, n`,
    [runId],
  );
  return rows.map((row) => ({
    run_id: String(row.run_id),
    phase: String(row.phase),
    n: Number(row.n ?? 0),
    turns: Number(row.turns),
    input_tokens: Number(row.input_tokens),
    output_tokens: Number(row.output_tokens),
    cache_read_input_tokens: Number(row.cache_read_input_tokens),
    cache_creation_input_tokens: Number(row.cache_creation_input_tokens),
    provider: String(row.provider),
    model: String(row.model),
  }));
}
