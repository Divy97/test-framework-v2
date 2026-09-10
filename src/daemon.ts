// The runner daemon: the half of the product that lives on somebody's laptop.
//
// It dials OUT and never listens, which is the entire reason the hosted split exists —
// a process behind a home router cannot receive a webhook, and every tunnel that has
// ever stood in for one has died overnight. So: claim work, run the engine that already
// exists, ship what it observed, ask for nothing.
//
// It holds the model credential and no GitHub key (ADR-0019). Tokens are asked for per
// run, when needed, which preserves the refresh property `installationToken` documents.
//
// `execute` is injected for the same reason `cloneForDraft` and `prove` are in
// `serve.ts`: the loop here — claiming, retrying, uploading, finishing — is worth
// testing on its own, and a test of it should not need Docker, a model, or a GitHub App.

import { readFile } from 'node:fs/promises';
import type { ArtifactRef, RunEvent } from './events.js';
import { blobPath } from './blobs.js';
import type { JobKind } from './plane.js';
import type { Recipe } from './recipe.js';

/** What the plane hands over. `recipe` is read fresh at dispatch, not stored on the job. */
export type DaemonJob = {
  runId: string;
  installationId: number;
  repo: string;
  intake: unknown;
  recipe: Recipe | null;
  /**
   * What kind of work this is (10h). `run` when the plane does not say, which is what every
   * job written before 10h is and what the column defaults to — so an older plane and a
   * newer worker agree without either knowing about the other.
   */
  kind: JobKind;
};

/** What a job execution is given, so it never talks to the plane itself. */
export type DaemonIo = {
  /** Ship one observation. Ordered, retried, and idempotent at the far end. */
  append: (event: RunEvent) => Promise<void>;
  /** A GitHub token for this run, minted by the plane, never held longer than needed. */
  token: () => Promise<string>;
  /**
   * What this run spent — the model, and the machines (M10, 10f).
   *
   * Not `append`: a fact about our spending is not an observation about the user's bug,
   * and putting one in the log is what `readmodel.ts` explains at length that this
   * project does not do.
   *
   * Best-effort, and unlike `append` it is NOT retried. The evidence is already shipped
   * by the time this is called; a bill that could not be written is worth a log line and
   * nothing more, and a runner that retried it would be holding a slot open over
   * bookkeeping.
   */
  cost: (spent: { usage?: unknown[]; compute?: unknown[] }) => Promise<void>;
  /**
   * Say why this job produced nothing (10n).
   *
   * The one member here that is not a request. It records a sentence locally and the
   * daemon sends it with `POST /runner/runs/:id/finished`, so it lands on the job row
   * rather than in a second place that could disagree with it.
   *
   * It exists because a `draft` job that proposes nothing and a `prove` job that cannot
   * build both leave an empty box on somebody's onboarding screen, and the screen could
   * not tell which empty it was: no machine free, a session that declined, an
   * out-of-budget key, or a repository with no commits. All four looked the same, and the
   * difference decides whether the reader waits, writes the recipe themselves, or goes and
   * fixes their key. The answer already existed — in this process's stdout, where they
   * cannot see it.
   *
   * Testimony, not evidence (ADR-0006): prose, no verdict rests on it, and the last call
   * wins.
   */
  note: (text: string) => void;
  /**
   * The stored credentials this run's repository has, or `null` (10l, ADR-0017).
   *
   * `null` and `{}` are DIFFERENT and the difference decides whether a run happens.
   * `{}` is "this repository has none stored"; `null` is "this deployment does not hand
   * them out" — the plane answers 501 until injection is enabled. A worker that read the
   * second as the first would start a run whose recipe declares `required` names, satisfy
   * the gate with an empty set, and produce a Tier 3 about a world that was never booted.
   *
   * The only call in this product that returns a credential to a caller. It is authorized
   * as an append is — a runner gets what the run it holds is entitled to and nothing it
   * can name — and the values are held in memory for one run and offered to sandboxes that
   * `mayInject` accepts.
   */
  secrets: () => Promise<Record<string, string> | null>;
  /**
   * The result of a `prove` or a `draft` job, sent back for the plane to store (10h).
   *
   * The worker cannot write either itself: it has no database, by the same design that
   * keeps the App key off it (ADR-0012, ADR-0019). And neither is an EVENT — a proof is a
   * fact about whether this engine can run somebody's project, and a draft is an agent's
   * proposal that a human has not approved. Putting either in an append-only log about a
   * user's bug is precisely what `readmodel.ts` explains this project does not do
   * (ADR-0006).
   *
   * Opaque here on purpose. `RepoProof` and a recipe draft are `orchestrate.ts`'s shapes
   * and the plane validates what it stores; a second definition in this module would be
   * free to drift from both.
   */
  finding: (of: { proof?: unknown; draft?: unknown }) => Promise<void>;
  /**
   * The key of whoever pressed Start, or `null` for a job with nobody to bill.
   *
   * The plane has answered this since 10k and **nothing asked it until now**, which meant
   * the whole "who pays" design was a check with no consequence: `POST /api/runs` refuses a
   * person with no stored key (412), they store one, and the worker then spent its OWN
   * `OPENROUTER_API_KEY` on their run. A person who stored a key was told it would be used
   * and it was not.
   *
   * `null` is the ordinary answer for a webhook-era job and for the local product, where
   * there is one operator and the key is in the environment — the worker falls back to its
   * own configuration there, which is what every run did before the button existed.
   */
  modelKey: () => Promise<{ provider: string; key: string } | null>;
};

export type Daemon = {
  /** Stop after the current job. Returns when the loop has actually ended. */
  stop: () => Promise<void>;
};

/** How long the plane is asked to hold a poll open. Long enough to be cheap, short enough to notice a stop. */
const WAIT_SECONDS = 25;

/** Attempts per append before a run's stream is declared lost. */
const APPEND_ATTEMPTS = 4;

/** And per blob. A lost artifact is a ref in the log that nothing can open. */
const UPLOAD_ATTEMPTS = 4;

const backoff = (attempt: number) => new Promise((done) => setTimeout(done, 250 * 2 ** attempt));

/**
 * Every `sha256:` ref a stream mentions that names a BLOB of ours.
 *
 * Scanned out of the serialised events rather than folded, deliberately: a run that
 * ended badly still produced artifacts worth having, and `fold()` refuses a stream that
 * does not start at 1. The report builder already reads refs exactly this way.
 *
 * `@sha256:` is excluded, and that is not a nicety. 10d's `ENV_BUILT` records the image a
 * phase was created from, and a pinned image reference ends
 * `…/test-framework-v2-sandbox@sha256:abc0053b…` — the same 64 hex digits, naming a
 * container image in somebody else's registry rather than a file in our evidence store.
 * Every hosted run therefore tried to upload its own image digest and logged
 * `could not upload … ENOENT` for it, once per run, forever. Seen in the first one.
 *
 * Matched on the DELIMITER rather than by parsing the event: a `put()` ref is always
 * preceded by a quote or a slash and never by `@`, and an image reference always has the
 * `@`. That holds for any event class either format appears in, including ones not
 * written yet.
 */
const refsIn = (events: RunEvent[]): ArtifactRef[] => [
  ...new Set((JSON.stringify(events).match(/(?<!@)\bsha256:[0-9a-f]{64}/g) ?? []) as ArtifactRef[]),
];

export async function runDaemon(options: {
  planeUrl: string;
  /** The pairing token. The only credential this process has for the plane. */
  token: string;
  /** Where the engine writes artifacts locally, before they are uploaded. */
  blobRoot: string;
  waitSeconds?: number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** Stop after one job. For a one-shot runner, and for tests. */
  once?: boolean;
  /** Run one job. Defaults to the engine; injected in tests. */
  execute: (job: DaemonJob, io: DaemonIo) => Promise<void>;
}): Promise<Daemon> {
  const call = options.fetch ?? fetch;
  const log = options.log ?? (() => {});
  const base = options.planeUrl.replace(/\/$/, '');
  const wait = options.waitSeconds ?? WAIT_SECONDS;
  const auth = { authorization: `Bearer ${options.token}` };

  let stopped = false;
  let ended: () => void = () => {};
  const done = new Promise<void>((resolve) => (ended = resolve));

  /**
   * Ship one event, retrying.
   *
   * Retried because the far end is across somebody's home connection and the far end is
   * idempotent on `(run_id, seq)` — so a retry costs a request and nothing else. NOT
   * retried on a refusal: 4xx means the plane has decided this runner may not write
   * this, and hammering it would turn a clear answer into an outage.
   */
  const append = async (runId: string, event: RunEvent): Promise<void> => {
    for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt += 1) {
      // The three outcomes are kept apart on purpose, and the first draft did not: a
      // `throw` for the 4xx case sat INSIDE the try that implements the retry, so its
      // own catch swallowed it and a refusal was hammered four times. The test that
      // asserts a refusal costs one request is what found it.
      let response: Response;
      try {
        response = await call(`${base}/runner/runs/${runId}/events`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ events: [event] }),
        });
      } catch (error) {
        // No answer at all — a home connection, a sleeping laptop, a plane mid-deploy.
        if (attempt === APPEND_ATTEMPTS - 1) throw error;
        await backoff(attempt);
        continue;
      }
      if (response.ok) return;
      // A 4xx is an ANSWER. The plane has decided this runner may not write this, and
      // retrying turns a clear refusal into an outage of our own making.
      if (response.status < 500) {
        throw new Error(`the plane refused seq ${event.seq}: HTTP ${response.status}`);
      }
      if (attempt === APPEND_ATTEMPTS - 1) {
        throw new Error(`could not ship seq ${event.seq}: HTTP ${response.status} after ${APPEND_ATTEMPTS} attempts`);
      }
      await backoff(attempt);
    }
  };

  /**
   * Upload the bytes a run produced, best effort, one at a time.
   *
   * Best effort because the events are the record: a run whose blobs failed to upload is
   * a run with an incomplete evidence page, and a run whose EVENTS failed to ship is not
   * a run at all. Losing the first to protect the second is the right trade, and it is
   * the same one `runContainer` makes about artifact collection.
   */
  const upload = async (runId: string, refs: ArtifactRef[]): Promise<number> => {
    let sent = 0;
    for (const ref of refs) {
      // RETRIED, like an append, and for the same reason. This had one attempt while the
      // event path had four, and the first hosted run lost a blob to a single
      // `TypeError: fetch failed` — leaving the log citing a ref the evidence store does
      // not hold, which is an ENOENT for whoever opens the report. `collect()`'s own
      // comment says that shape is the one thing it exists to prevent; losing it one
      // layer further out is the same loss.
      //
      // A 4xx is an ANSWER and is not retried (M9's lesson, on the append path): a blob
      // the plane refuses will be refused again, and a ref already stored answers 409.
      let attempt = 0;
      for (;;) {
        try {
          const bytes = await readFile(blobPath(options.blobRoot, ref));
          const response = await call(`${base}/runner/runs/${runId}/blobs/${ref}`, {
            method: 'PUT',
            headers: { ...auth, 'content-type': 'application/octet-stream' },
            body: new Uint8Array(bytes),
          });
          if (response.ok) {
            sent += 1;
            break;
          }
          if (response.status < 500 || ++attempt >= UPLOAD_ATTEMPTS) {
            log(`${runId}: ${ref} was refused: HTTP ${response.status}`);
            break;
          }
        } catch (error) {
          // A missing FILE will be missing on the next attempt too, so it is not one of
          // the things waiting fixes — and it is the shape a bad ref produces.
          if ((error as { code?: string }).code === 'ENOENT' || ++attempt >= UPLOAD_ATTEMPTS) {
            log(`${runId}: could not upload ${ref} — ${String(error)}`);
            break;
          }
        }
        await backoff(attempt);
      }
    }
    return sent;
  };

  /**
   * Thrown when the plane has answered, and the answer is about this runner's credential.
   *
   * Distinguished from every other failure because it is not a failure to communicate —
   * it IS communication, and waiting cannot change it.
   */
  class NotPaired extends Error {}

  const claim = async (): Promise<DaemonJob | null> => {
    const response = await call(`${base}/runner/jobs?wait=${wait}`, { headers: auth });
    if (response.status === 204) return null;
    // 401 and 403 are the plane saying WHO you are, not that it is having a bad day. A
    // token that is wrong, revoked, or for another installation will never start working,
    // and re-pairing issues a new one that this process could not pick up anyway.
    if (response.status === 401 || response.status === 403) {
      throw new NotPaired(
        `the plane will not take this runner's token (HTTP ${response.status}). ` +
          'Pair this machine again and start it with the new token.',
      );
    }
    if (!response.ok) throw new Error(`the plane answered HTTP ${response.status} to a poll`);
    return (await response.json()) as DaemonJob;
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      let job: DaemonJob | null = null;
      try {
        job = await claim();
      } catch (error) {
        // A credential the plane refuses is the one error waiting cannot fix. Said once
        // and stopped, because the alternative is what this actually did: a wrong token
        // printing the same line every few seconds forever, which reads as a network
        // problem and is not one. Same lesson the append path learned in M9 — a 4xx is an
        // ANSWER — arriving late on the poll path.
        if (error instanceof NotPaired) {
          log(String(error.message));
          stopped = true;
          break;
        }
        // Everything else: the plane being unreachable is the ordinary state of a laptop,
        // not an emergency. Say so and wait — exiting would need somebody to notice and
        // restart a process whose whole job is to be there when the plane comes back.
        log(`waiting for the plane: ${String(error)}`);
        await backoff(2);
        continue;
      }
      if (!job) continue;

      log(`${job.repo}: took ${job.runId}`);
      const shipped: RunEvent[] = [];
      // WHY THIS JOB PRODUCED NOTHING, if it produces nothing (10n). Recorded locally and
      // sent with the finish below, so it reaches the row whose empty result it explains —
      // and therefore the screen. It used to exist only in this process's stdout, which is
      // not somewhere the person who pressed the button can look.
      let note: string | null = null;
      try {
        await options.execute(job, {
          note: (text) => {
            note = text;
          },
          append: async (event) => {
            await append(job!.runId, event);
            shipped.push(event);
          },
          token: async () => {
            const response = await call(`${base}/runner/runs/${job!.runId}/token`, {
              method: 'POST',
              headers: auth,
            });
            if (!response.ok) throw new Error(`the plane would not mint a token: HTTP ${response.status}`);
            return ((await response.json()) as { token: string }).token;
          },
          secrets: async () => {
            const response = await call(`${base}/runner/runs/${job!.runId}/secrets`, {
              method: 'POST',
              headers: auth,
            });
            // 501 is an ANSWER, not a failure: this deployment does not inject yet, and the
            // caller has to be able to tell that from "this repository has none".
            if (response.status === 501) return null;
            if (!response.ok) {
              // Not `null`, because `null` means a deliberate refusal and this is a fault.
              // A run that cannot learn whether it has credentials must not proceed as
              // though it has none — `missingRequired` would then pass an empty set and a
              // recipe declaring `required` would boot a world it has no values for.
              throw new Error(`the plane would not hand over stored values: HTTP ${response.status}`);
            }
            const body = (await response.json()) as { secrets?: Record<string, string> };
            return body.secrets ?? {};
          },
          modelKey: async () => {
            const response = await call(`${base}/runner/runs/${job!.runId}/model-key`, {
              method: 'POST',
              headers: auth,
            });
            // THROWN rather than treated as absent. Falling back to the worker's own key on
            // a transport error is the failure that spends the wrong account silently, which
            // is the bug this method exists to fix — so an unreadable answer stops the run
            // rather than quietly billing somebody else.
            if (!response.ok) {
              throw new Error(`the plane would not hand over the model key: HTTP ${response.status}`);
            }
            const body = (await response.json()) as { provider: string; key: string } | null;
            return body ?? null;
          },
          finding: async (of) => {
            const response = await call(`${base}/runner/runs/${job!.runId}/finding`, {
              method: 'POST',
              headers: { ...auth, 'content-type': 'application/json' },
              body: JSON.stringify(of),
            });
            // THROWN, unlike `cost`. A bill that could not be written is worth a log line;
            // a proof or a draft that could not be written is the entire product of the job
            // — the worker spent containers and a model credential and produced nothing
            // anybody can see. The daemon logs it and moves on, and the job stays open for
            // a re-dispatch.
            if (!response.ok) {
              throw new Error(`the plane would not store what this job found: HTTP ${response.status}`);
            }
          },
          cost: async (spent) => {
            if ((spent.usage?.length ?? 0) === 0 && (spent.compute?.length ?? 0) === 0) return;
            const response = await call(`${base}/runner/runs/${job!.runId}/cost`, {
              method: 'POST',
              headers: { ...auth, 'content-type': 'application/json' },
              body: JSON.stringify(spent),
            }).catch((error: unknown) => {
              log(`${job!.runId}: could not report what it spent — ${String(error)}`);
              return null;
            });
            if (response && !response.ok) {
              log(`${job!.runId}: the plane answered HTTP ${response.status} to the bill`);
            }
          },
        });
      } catch (error) {
        // Logged, never rethrown. One job that failed must not end the daemon: the next
        // delivery is somebody else's bug report, and a runner that exits on the first
        // bad run is a runner nobody can leave running.
        log(`${job.runId}: ended badly — ${String(error)}`);
        // Only if nothing more specific was said. A job that explained itself and THEN
        // threw is better described by its own words than by the exception.
        note ??= `the run ended badly — ${String((error as Error).message ?? error)}`;
      }

      const sent = await upload(job.runId, refsIn(shipped));
      log(`${job.runId}: ${shipped.length} event(s), ${sent} artifact(s)`);

      // Finished whatever happened. A job left dispatched is a job no other runner will
      // ever take and no operator will ever see complete.
      await call(`${base}/runner/runs/${job.runId}/finished`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        // No body when there is nothing to say, which is most jobs — and what every worker
        // before this sent, so the route still accepts one that posts none.
        ...(note === null ? {} : { body: JSON.stringify({ note }) }),
      }).catch((error: unknown) => log(`${job!.runId}: could not mark it finished — ${String(error)}`));

      if (options.once) break;
    }
    ended();
  };

  void loop();

  return {
    stop: async () => {
      stopped = true;
      await done;
    },
  };
}
