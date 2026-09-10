/**
 * WHERE YOU ARE, and the one thing to do next (10n).
 *
 * The flow this replaces was rated 5/10 by the person who owns it, and the rating was
 * right. Getting one repository from connected to running took fifteen steps with hard
 * dependencies between them, and the product named none of them. You found out about the
 * model key at step eight, as a button that would not press. You found out about required
 * secrets at step fourteen, from a run that came back blocked. Two of the waits told you
 * to reload the page and guess when.
 *
 * Every step below is derived from data `/api/repos/:repo` already returns — this invents
 * no state and stores nothing. What it adds is the ORDER, which existed only in the code.
 *
 * Three rules it follows:
 *
 *   - EXACTLY ONE step is `now`. A checklist with two next actions is a menu, and a menu
 *     is what the reader already had.
 *   - A step that is waiting on a machine says how long it has been waiting. "Reload in a
 *     minute or two" is what this replaces, and it is an instruction to poll a server by
 *     hand about a job that server can see.
 *   - A step that failed says WHY, in the worker's own words, and what to do about it.
 *     `note` carries that now; before it existed the only honest thing the screen could
 *     say was that the box was empty for one of four reasons.
 */
import type { Me, RepoActivity, RepoDetail } from '../lib/api';
import { missingNames } from '../lib/required';

export type StepState = 'done' | 'now' | 'waiting' | 'failed' | 'later';

export type Step = {
  id: string;
  title: string;
  state: StepState;
  /** What to do, when there is something. Prose; the caller renders the control. */
  detail?: string;
  /** Where the action lives, when it is elsewhere. */
  href?: string;
};

/** The newest drafting or proving job of a kind, or null. Newest first from the API. */
const latest = (activity: RepoActivity[], kind: 'draft' | 'prove'): RepoActivity | null =>
  activity.find((one) => one.kind === kind) ?? null;

const running = (job: RepoActivity | null): boolean => job !== null && job.finishedAt === null;

/**
 * How long, in the words a person uses.
 *
 * Seconds up to two minutes, because that is the length of the wait this is mostly
 * describing — a drafting session is a couple of minutes and a proving run about half
 * one, and a number that ticks every second is the difference between waiting and
 * wondering whether it is stuck. Switching at sixty read "2 min" thirty seconds in.
 *
 * FLOORED, not rounded, once it is minutes: rounding tells a reader their two-minute job
 * has been running for three, which is the direction that makes them reload.
 */
export const since = (iso: string, now = Date.now()): string => {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 120) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h`;
};

/**
 * The whole journey, as state rather than as prose.
 *
 * `now` is assigned to the FIRST step that is not done, and every step after it is
 * `later` — so the reader is never offered two next actions, and never offered one that
 * depends on something they have not done.
 */
export function steps(repo: string, detail: RepoDetail, me: Me | null, now = Date.now()): Step[] {
  const draft = latest(detail.activity, 'draft');
  const prove = latest(detail.activity, 'prove');
  const missing = missingNames(detail.recipe, detail.secrets.names);

  const out: Step[] = [];

  // 1 — A KEY TO BILL. First because everything after it spends one, and last-discovered
  // in the flow this replaces: it turned up at step eight as a disabled button.
  out.push(
    me?.accounts === false
      ? { id: 'key', title: 'A model key is configured', state: 'done', detail: 'This deployment uses the operator’s key.' }
      : me?.modelKey
        ? { id: 'key', title: 'You have stored a model key', state: 'done' }
        : {
            id: 'key',
            title: 'Store a model key',
            state: 'now',
            detail: 'Drafting and runs spend the key of whoever asks for them. Nothing here can start without one.',
            href: '/settings',
          },
  );

  // 2 — A PROPOSAL. Three outcomes and they used to look identical: nothing asked for
  // yet, a session in flight, and a session that finished having proposed nothing.
  if (detail.recipe) {
    out.push({ id: 'draft', title: 'A recipe was proposed', state: 'done' });
  } else if (detail.draft) {
    out.push({ id: 'draft', title: 'A recipe has been proposed for you to review', state: 'done' });
  } else if (running(draft)) {
    out.push({
      id: 'draft',
      title: 'Drafting a recipe',
      state: 'waiting',
      detail:
        draft!.dispatchedAt === null
          ? `Queued ${since(draft!.queuedAt, now)} ago, waiting for a machine.`
          : `Running for ${since(draft!.dispatchedAt, now)} — it explores your project, which takes a couple of minutes.`,
    });
  } else if (draft?.note) {
    out.push({ id: 'draft', title: 'Drafting produced nothing', state: 'failed', detail: draft.note });
  } else {
    out.push({
      id: 'draft',
      title: 'Get a recipe proposed',
      state: 'now',
      detail: 'An agent explores your project and proposes the commands a run should use. You review them before anything uses them.',
    });
  }

  // 3 — APPROVAL, which is the human control this whole product is built around
  // (ADR-0013) and the only step here nothing can do on your behalf.
  out.push(
    detail.recipe
      ? { id: 'approve', title: 'You approved the recipe', state: 'done' }
      : {
          id: 'approve',
          title: 'Approve the recipe',
          state: 'later',
          detail: 'These are commands the engine will execute verbatim. Nothing runs until you say so.',
        },
  );

  // 4 — PROOF. Answers "will a run here be able to say anything", which is the question
  // a person actually has after approving, and which used to have a permanent "reload in
  // a minute" in front of it.
  if (!detail.recipe) {
    out.push({ id: 'prove', title: 'Check the environment builds', state: 'later' });
  } else if (running(prove)) {
    out.push({
      id: 'prove',
      title: 'Checking the environment builds',
      state: 'waiting',
      detail:
        prove!.dispatchedAt === null
          ? `Queued ${since(prove!.queuedAt, now)} ago, waiting for a machine.`
          : `Running for ${since(prove!.dispatchedAt, now)} — it builds your project and runs its own tests once.`,
    });
  } else if (detail.proof) {
    out.push({ id: 'prove', title: 'The environment builds and your suite ran', state: 'done' });
  } else if (prove?.note) {
    out.push({ id: 'prove', title: 'The environment check produced nothing', state: 'failed', detail: prove.note });
  } else {
    out.push({
      id: 'prove',
      title: 'The environment has not been checked',
      state: 'done',
      detail: 'Not required. A run will find out either way; checking first is how you find out sooner.',
    });
  }

  // 5 — SECRETS, and this is the step the flow had no representation of at all. The
  // recipe NAMES what it needs; nothing compared that list to what was stored until a
  // run was already going, and then the run came back blocked.
  if (detail.recipe?.required?.length) {
    out.push(
      missing.length === 0
        ? { id: 'secrets', title: 'Every value the recipe requires is stored', state: 'done' }
        : {
            id: 'secrets',
            title: `Store ${missing.length} value${missing.length === 1 ? '' : 's'} the recipe requires`,
            state: 'now',
            detail: `${missing.join(', ')} — a run cannot boot your project without ${missing.length === 1 ? 'it' : 'them'}, and will stop before it tries.`,
          },
    );
  }

  // 6 — THE RUN.
  out.push(
    detail.runs.length > 0
      ? { id: 'run', title: `${detail.runs.length} run${detail.runs.length === 1 ? '' : 's'} started`, state: 'done' }
      : { id: 'run', title: 'Start a run on an issue', state: 'later' },
  );

  // EXACTLY ONE `now`, and it is the first thing not already done. Everything computed
  // above answers "what is true of this step"; this decides which one the reader is
  // being asked to act on, which is a different question and the one the old screen
  // never answered.
  let claimed = false;
  return out.map((step) => {
    if (step.state === 'done') return step;
    if (step.state === 'waiting' || step.state === 'failed') {
      claimed = true;
      return step;
    }
    if (!claimed) {
      claimed = true;
      return { ...step, state: 'now' as StepState };
    }
    return { ...step, state: 'later' as StepState };
  });
}

/** Whether anything here is waiting on a machine — which is when the page should poll. */
export const isWaiting = (list: Step[]): boolean => list.some((step) => step.state === 'waiting');

const MARK: Record<StepState, string> = {
  done: '✓',
  now: '→',
  waiting: '·',
  failed: '✗',
  later: '',
};

const WORD: Record<StepState, string> = {
  done: 'done',
  now: 'do this next',
  waiting: 'waiting',
  failed: 'failed',
  later: 'later',
};

export function Checklist({
  repo,
  detail,
  me,
  now,
  onGo,
}: {
  repo: string;
  detail: RepoDetail;
  me: Me | null;
  now?: number;
  /** Where a step's action lives inside this page — a tab, usually. */
  onGo?: (id: string) => void;
}) {
  const list = steps(repo, detail, me, now);
  const current = list.find((step) => step.state === 'now' || step.state === 'waiting' || step.state === 'failed');

  return (
    <section className="checklist" aria-label={`Getting ${repo} ready`}>
      <ol>
        {list.map((step) => (
          <li key={step.id} className={`step-${step.state}`} aria-current={step.state === 'now' ? 'step' : undefined}>
            {/* The glyph is decorative; `WORD` is what a screen reader and a printed page
                get, because colour and a tick are not a signal on their own. */}
            <span className="mark" aria-hidden="true">
              {MARK[step.state]}
            </span>
            <span className="what">
              <b>{step.title}</b>
              <span className="sr">{` — ${WORD[step.state]}`}</span>
              {step.detail && step.state !== 'later' ? <span className="why">{step.detail}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      {current?.href ? (
        <p className="calls">
          <a className="cta" href={current.href}>
            {current.title}
          </a>
        </p>
      ) : current && current.state === 'now' && onGo ? (
        <p className="calls">
          <button type="button" onClick={() => onGo(current.id)}>
            {current.title}
          </button>
        </p>
      ) : null}
    </section>
  );
}
