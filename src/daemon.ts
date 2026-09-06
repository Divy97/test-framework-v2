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
import type { Recipe } from './recipe.js';

/** What the plane hands over. `recipe` is read fresh at dispatch, not stored on the job. */
export type DaemonJob = {
  runId: string;
  installationId: number;
  repo: string;
  intake: unknown;
  recipe: Recipe | null;
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
};

export type Daemon = {
  /** Stop after the current job. Returns when the loop has actually ended. */
  stop: () => Promise<void>;
};

/** How long the plane is asked to hold a poll open. Long enough to be cheap, short enough to notice a stop. */
const WAIT_SECONDS = 25;

/** Attempts per append before a run's stream is declared lost. */
const APPEND_ATTEMPTS = 4;

const backoff = (attempt: number) => new Promise((done) => setTimeout(done, 250 * 2 ** attempt));

/**
 * Every `sha256:` ref a stream mentions.
 *
 * Scanned out of the serialised events rather than folded, deliberately: a run that
 * ended badly still produced artifacts worth having, and `fold()` refuses a stream that
 * does not start at 1. The report builder already reads refs exactly this way.
 */
const refsIn = (events: RunEvent[]): ArtifactRef[] => [
  ...new Set((JSON.stringify(events).match(/sha256:[0-9a-f]{64}/g) ?? []) as ArtifactRef[]),
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
      try {
        const bytes = await readFile(blobPath(options.blobRoot, ref));
        const response = await call(`${base}/runner/runs/${runId}/blobs/${ref}`, {
          method: 'PUT',
          headers: { ...auth, 'content-type': 'application/octet-stream' },
          body: new Uint8Array(bytes),
        });
        if (response.ok) sent += 1;
        else log(`${runId}: ${ref} was refused: HTTP ${response.status}`);
      } catch (error) {
        log(`${runId}: could not upload ${ref} — ${String(error)}`);
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
      try {
        await options.execute(job, {
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
      }

      const sent = await upload(job.runId, refsIn(shipped));
      log(`${job.runId}: ${shipped.length} event(s), ${sent} artifact(s)`);

      // Finished whatever happened. A job left dispatched is a job no other runner will
      // ever take and no operator will ever see complete.
      await call(`${base}/runner/runs/${job.runId}/finished`, { method: 'POST', headers: auth }).catch(
        (error: unknown) => log(`${job!.runId}: could not mark it finished — ${String(error)}`),
      );

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
