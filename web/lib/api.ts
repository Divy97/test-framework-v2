/**
 * The plane, as this bundle sees it.
 *
 * Every screen is drawn from these calls, which means two states exist here that never
 * existed when pages were rendered on the other side: *in flight* and *the request
 * failed*. Both are modelled explicitly rather than collapsed into "no data", because an
 * empty repository list and a repository list that failed to load are the same picture and
 * opposite facts — and the first thing a person does with the wrong one is file a bug
 * about repositories that are still there.
 *
 * Three rules:
 *
 *   1. **A status is not an exception.** 401, 404, 409 and 412 are answers this API gives
 *      on purpose, each with a page-level meaning ("sign in", "not yours", "already
 *      running", "no key"). Throwing on them would force every caller to unwrap an error
 *      to find a number it was expecting.
 *   2. **Writes always declare JSON.** `routes.ts` refuses a `/api/` write that does not,
 *      by design: the one request shape a browser can send cross-site without a preflight
 *      is exactly the one no JSON client sends, so the content type is part of the CSRF
 *      story rather than a formality.
 *   3. **Nothing here caches.** The plane's answers are a projection of a log that a
 *      worker is appending to right now. A stale repository list is a person pressing
 *      Start on a run that already exists.
 */

export type Answer<T> = { status: number; ok: boolean; data: T | null; error: string | null };

const parse = async <T,>(response: Response): Promise<Answer<T>> => {
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    // HTML where JSON was expected is the shape of a proxy error page or a redirect that
    // was followed. Saying so beats `Unexpected token < in JSON`, which has sent more
    // people to read a stack trace than to read the status code sitting next to it.
    return { status: response.status, ok: false, data: null, error: `the server answered ${response.status} and not JSON` };
  }
  const error =
    response.ok || body === null || typeof body !== 'object'
      ? null
      : ((body as { error?: unknown }).error as string | undefined) ?? `request failed (${response.status})`;
  return { status: response.status, ok: response.ok, data: response.ok ? (body as T) : null, error };
};

/** A network failure, as an `Answer` — so a caller has one shape to handle, not two. */
const unreachable = <T,>(error: unknown): Answer<T> => ({
  status: 0,
  ok: false,
  data: null,
  error: `could not reach the service (${String((error as Error)?.message ?? error)})`,
});

export async function get<T>(path: string, signal?: AbortSignal): Promise<Answer<T>> {
  try {
    return await parse<T>(await fetch(path, { headers: { accept: 'application/json' }, ...(signal ? { signal } : {}) }));
  } catch (error) {
    // An abort is the caller changing its mind — a component unmounting, a search box
    // moving on — and reporting it as a failure paints an error over a screen the reader
    // has already left.
    if ((error as Error)?.name === 'AbortError') throw error;
    return unreachable<T>(error);
  }
}

export async function send<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<Answer<T>> {
  try {
    return await parse<T>(
      await fetch(path, {
        method,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  } catch (error) {
    return unreachable<T>(error);
  }
}

// ── What the plane answers with ────────────────────────────────────────────────────────
//
// Hand-written rather than shared with `src/`. The two are one repository and it is
// tempting to import the server's types here, but this bundle is built by a different
// toolchain into a different artifact, and a type import would drag `pg` and the whole
// engine into a browser build to describe six fields. They are checked against each other
// by `test/api.test.ts`, which asserts the shape of every response below.

/**
 * Whether a run is over, asked of the FOLD rather than of the projection.
 *
 * `run_projection.ended_at` is a cache column and it is not always written — the demo log
 * this repository has fixed since milestone 5 ends `pr_opened` with `ended_at` null, which
 * is a true statement about that log and a contradiction on a screen. Reading it as "still
 * running" put a live indicator, a "verdict not yet" chip and a pulsing timeline on a run
 * that had opened a pull request.
 *
 * `fold.ts` owns what a run's status means (ADR-0009). These four are its terminal ones,
 * and the projection's timestamp is kept only as a second witness — a run can be over
 * without this list knowing about a status added later, but not without one of the two.
 */
const TERMINAL = new Set(['pr_opened', 'unresolved', 'blocked', 'errored']);

export const isOver = (status: string, endedAt: string | null): boolean =>
  TERMINAL.has(status) || endedAt !== null;

export type Me = {
  accounts: boolean;
  signedIn: boolean;
  login: string | null;
  mode: 'local' | 'plane';
  installUrl: string;
  modelKey: { provider: string } | null;
  secrets: { enabled: boolean };
  github: boolean;
  forgetting: boolean;
};

export type RepoRow = {
  repo: string;
  account: string;
  connectedAt: string;
  onboarded: boolean;
  runs: number;
};

/**
 * `run_projection`, as `readmodel.ts`'s `toRow` actually builds it.
 *
 * Checked field by field against `src/readmodel.ts:23` and `src/projection.ts`. It carried
 * `reproduced` and `pr_number`, neither of which is a column — both were always `undefined`
 * — and omitted `regression` and `last_seq`, which are returned. Nothing failed, because a
 * field that is always undefined renders as nothing and reads as "this run did not have
 * one".
 */
export type RunRow = {
  run_id: string;
  repo: string;
  issue_number: number;
  status: string;
  tier: number;
  confidence: number;
  ceiling: number;
  scoring: number;
  regression: string;
  pr_url: string | null;
  started_at: string;
  ended_at: string | null;
  last_seq: number;
};

export type Recipe = {
  install?: string;
  migrate?: string;
  seed?: string;
  test?: string;
  services?: { name: string; command: string; port?: number; healthcheck?: string }[];
  env?: Record<string, string>;
  required?: string[];
};

export type RepoDetail = {
  repo: string;
  account: string;
  connectedAt: string;
  onboarded: boolean;
  recipe: Recipe | null;
  approvedAt: string | null;
  proof: unknown;
  draft: unknown;
  secrets: { names: string[]; enabled: boolean };
  runs: RunRow[];
};

export type Issue = { number: number; title: string; html_url: string; created_at?: string; comments?: number };

export type Ground = { points: number; claim: string; evidence: string[] };

export type Evidence = {
  row: RunRow;
  state: {
    runId: string;
    status: string;
    currentAttempt: number;
    reproduced: boolean;
    reproducedAttempt: number | null;
    shownOnBase: boolean;
    regression: string;
    registeredRepro: { command: string; files: Record<string, string>; applied: string[]; attempt: number } | null;
    registrations: { command: string; files: Record<string, string>; applied: string[]; attempt: number }[];
    testRuns: {
      attempt: number;
      phase: string;
      repeat?: number;
      commit_sha: string;
      exit_code: number;
      signal?: string | null;
      symptom_matched?: boolean;
      stdout_hash: string;
      duration_ms?: number;
    }[];
    suiteRuns: {
      attempt: number;
      phase: string;
      command: string;
      exit_code: number;
      signal?: string | null;
      stdout_hash: string;
    }[];
    fixDiff: { changed_files: string[]; diff_hash: string } | null;
    aborts: { attempt: number; phase: string; cause?: string; reason: string }[];
    transcript: { n: number; claimed_type: string | null; raw_hash: string; bytes: number }[];
    environment?: { executor: string; imageRef: string; snapshot: string } | null;
    pr: { repo: string; pr_number: number; head_sha: string } | null;
  };
  score: { scoring: number; tier: number; score: number; ceiling: number; grounds: Ground[]; unmeasured: string[] };
  usage: { phase: string; turns: number; input_tokens: number; output_tokens: number }[];
  compute: {
    sandbox_id: string;
    phase: string;
    active_cpu_ms: number | null;
    duration_ms: number | null;
    egress_bytes: number | null;
  }[];
  forgotten: { requestedBy: string; forgottenAt: string; removed: number } | null;
};

export type Runner = {
  id: string;
  name: string;
  installationId: number | null;
  pairedAt: string;
  lastSeen: string | null;
  revokedAt: string | null;
};
