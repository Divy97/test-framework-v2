// The surface a runner dials out to, and the only way into the log from outside.
//
// Everything here is one bearer token away from writing somebody's evidence, so the
// module is deliberately thin: authenticate, authorize, hand to `plane.ts`, and turn a
// refusal into the status code that says which refusal it was. No business logic, no
// second definition of who may write.
//
// It is a `Route` — the same contract the dashboard uses — so the plane serves both
// from one port and one process. That is not just convenience: the runner API and the
// human UI have to agree about who owns an installation, and two servers is how they
// start disagreeing.

import type { Db } from './store.js';
import { digest, put } from './blobs.js';
import { loadRecipe, parseRecipe, saveProof } from './recipe.js';
import { saveDraft } from './drafts.js';
import { projectOne } from './readmodel.js';
import type { ArtifactRef, RunEvent } from './events.js';
import {
  appendFromRunner,
  claimJob,
  JOB_KINDS,
  type JobKind,
  finishJob,
  jobFacts,
  sawRunner,
  verifyRunner,
  type Runner,
} from './plane.js';
import { saveCompute, saveUsage, type ComputeRow, type UsageRow } from './readmodel.js';
import { modelKey, repoSecrets, secretsEnabled } from './secrets.js';
import type { Route } from './sse.js';

/** The longest a runner may hold a poll open. Long enough to be cheap, short enough to notice a deploy. */
const MAX_WAIT_MS = 30_000;

/** A batch bigger than this is a client that has stopped streaming and started dumping. */
const MAX_BATCH = 500;

/**
 * The largest blob this accepts in one request.
 *
 * ponytail: buffered in memory, so the ceiling is a memory decision rather than a
 * storage one. It covers every blob this engine actually produces — an 8KB stdout tail,
 * a diff, a screenshot — and refuses the pathological case loudly instead of quietly
 * inventing a swap file. Stream to a temp file and rename if a real repository ever
 * produces a 64MB test log worth keeping.
 */
const MAX_BLOB_BYTES = 16 * 1024 * 1024;

const json = (body: unknown, status = 200) => ({
  status,
  type: 'application/json',
  body: JSON.stringify(body),
});

/** `Bearer <token>`, and nothing else. */
const bearer = (headers: Record<string, string | string[] | undefined>): string | undefined => {
  const raw = headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : undefined;
};

/**
 * Is this a stream of events, or is it something else wearing the shape?
 *
 * The runner is trusted for its own installation (ADR-0019) and not trusted to be
 * correct: a bug there must produce a refusal, never an exception in the plane or a row
 * that `fold()` throws on later. Every field the append path touches is checked here.
 */
const asEvents = (value: unknown): RunEvent[] | null => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BATCH) return null;
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const event = item as Partial<RunEvent>;
    if (typeof event.run_id !== 'string' || typeof event.type !== 'string') return null;
    if (typeof event.seq !== 'number' || !Number.isInteger(event.seq) || event.seq < 1) return null;
    if (typeof event.ts !== 'string') return null;
    if (typeof event.payload !== 'object' || event.payload === null) return null;
  }
  return value as RunEvent[];
};

/**
 * The routes a paired machine may call.
 *
 * `null` for anything else, so this composes with the dashboard's routes and neither
 * has to know about the other.
 */
export function runnerRoutes(options: {
  client: Db;
  blobRoot: string;
  /**
   * Mint a GitHub installation token, for a runner that holds no App key (ADR-0019).
   *
   * Injected rather than built here: this module knows about authorization and nothing
   * about credentials, and a test of the boundary should not need an App private key.
   * Absent, the token route answers 501 — a plane that cannot mint should say so rather
   * than hand back something that fails later inside a git clone.
   */
  mintToken?: (installationId: number) => Promise<string>;
  /**
   * Where a row this plane could not store goes.
   *
   * Only the bill uses it, and only because that path swallows on purpose: an unwritable
   * cost must not fail a run whose evidence is already shipped, but it must not be
   * invisible either. Absent, the swallow is silent — which is the shape a review found.
   */
  log?: (line: string) => void;
}): Route {
  const { client, blobRoot } = options;

  return async ({ method, path, query, headers, body, raw }) => {
    if (!path.startsWith('/runner/')) return null;

    // One authentication, before any routing below it, so a route added later cannot
    // forget it — the same reason the dashboard checks its origin above its own table.
    const runner: Runner | null = await verifyRunner(client, bearer(headers));
    if (!runner) {
      return json({ error: 'unpaired: send a runner token as `Authorization: Bearer tfr_…`' }, 401);
    }
    await sawRunner(client, runner.id);

    // Take work, or wait for it. 204 means "nothing for you", which is the ordinary
    // answer and must not read as an error in a runner's logs.
    if (method === 'GET' && path === '/runner/jobs') {
      const asked = Number(query.get('wait') ?? '0') * 1000;
      const waitMs = Number.isFinite(asked) ? Math.min(Math.max(asked, 0), MAX_WAIT_MS) : 0;
      // WHICH KINDS THIS RUNNER WILL SERVE (10h), from the query string, and all three when
      // it does not ask — which is what every runner built before 10h does, and what it
      // means: a `run` job is the only kind that existed for it to take.
      //
      // Filtered to the known set rather than passed through, because this reaches
      // `kind = any($5)` and a caller-supplied array is a caller-supplied predicate. An
      // unknown name matches nothing, so a typo would silently mean "take nothing forever"
      // — a runner that looks healthy and never works. Dropping it and honouring the rest
      // is the answer a person can debug; naming none is refused below.
      const wanted = (query.get('kinds') ?? '').split(',').filter((one): one is JobKind =>
        (JOB_KINDS as readonly string[]).includes(one),
      );
      if (query.get('kinds') !== null && wanted.length === 0) {
        return json({ error: `kinds must name at least one of ${JOB_KINDS.join(', ')}` }, 400);
      }
      const job = await claimJob(client, runner, {
        waitMs,
        ...(wanted.length > 0 ? { kinds: wanted } : {}),
      });
      if (!job) return { status: 204, type: 'application/json', body: '' };
      // The recipe travels with the dispatch, read FRESH rather than stored on the job.
      // It is current configuration (ADR-0013) — a human may have corrected it since
      // this delivery was queued, and the run that is about to start should replay what
      // is approved now, not what was approved when the issue was filed.
      //
      // A `draft` job is the one kind that expects NO recipe: it exists to propose one.
      // Reading it anyway costs one indexed lookup and keeps the answer's shape identical
      // for all three, which is worth more than the query — a worker that had to branch on
      // kind to know whether a field would be present is a worker with two contracts.
      const recipe = await loadRecipe(client, job.repo);
      return json({ ...job, recipe });
    }

    const events = /^\/runner\/runs\/([^/]+)\/events$/.exec(path);
    if (method === 'POST' && events) {
      const runId = decodeURIComponent(events[1]!);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await body()) as unknown;
      } catch {
        return json({ error: 'body is not JSON' }, 400);
      }
      const batch = asEvents((parsed as { events?: unknown } | null)?.events);
      if (!batch) return json({ error: `expected {"events": [...]}, at most ${MAX_BATCH}` }, 400);

      const result = await appendFromRunner(client, runner, runId, batch);
      if (!('refused' in result) && result.appended > 0) {
        // The read model, rebuilt from the log this batch just extended.
        //
        // Without it the plane stores every event and its dashboard shows none of them:
        // `/runs/<id>` reads the projection for the row and 404s when there is none, so
        // a run that completed perfectly is invisible on the screen that IS the product.
        // Found by running a runner against a plane — 124 events landed and
        // `run_projection` had nothing.
        //
        // Never at the cost of the append. The log is the truth and the projection is a
        // disposable cache that `npm run rebuild` reconstructs; failing a runner's write
        // because a cache would not update is the evidence-loss trade this codebase
        // refuses everywhere else.
        //
        // ponytail: a full fold per batch, which is O(events²) across a run because the
        // daemon ships one event at a time. Fine at a run's scale (~130 events) and the
        // upgrade path is to debounce or fold incrementally, not to skip it.
        await projectOne(client, runId).catch(() => {});
      }
      if ('refused' in result) {
        // The refusals are distinguishable on purpose. A runner operator has to be able
        // to tell a client bug from a stale process from an attack, and run ids are
        // uuids, so "this run exists but is not yours" leaks nothing worth having.
        const status = result.refused.includes('no such run')
          ? 404
          : result.refused.includes('another runner')
            ? 403
            : result.refused.includes('already recorded')
              ? 409
              : 400;
        return json({ error: result.refused, appended: result.appended ?? 0 }, status);
      }
      return json(result);
    }

    // Blobs (9b). Under the RUN they belong to, not a bare content-addressed endpoint:
    // the store dedups by hash anyway, and routing the upload through the run makes it
    // the same authorization question as an append rather than a second, weaker one.
    const blob = /^\/runner\/runs\/([^/]+)\/blobs\/(sha256:[0-9a-f]{64})$/.exec(path);
    if (method === 'PUT' && blob) {
      const runId = decodeURIComponent(blob[1]!);
      const claimed = blob[2] as ArtifactRef;
      const authorized = await appendFromRunner(client, runner, runId, []);
      if ('refused' in authorized) {
        return json({ error: authorized.refused }, authorized.refused.includes('no such run') ? 404 : 403);
      }

      const bytes = await raw(MAX_BLOB_BYTES);
      if (bytes === null) return json({ error: `a blob may not exceed ${MAX_BLOB_BYTES} bytes` }, 413);

      // Named BEFORE stored, and the order is the point. `digest` says what these bytes
      // are; if that is not what the runner claimed, nothing is written at all. Storing
      // first and refusing afterwards would be a check that reports rather than one that
      // holds — the bytes would already be on our disk, under a name nobody asked for.
      const actual = digest(bytes);
      if (actual !== claimed) {
        return json({ error: `these bytes are ${actual}, not ${claimed}` }, 400);
      }
      const stored = await put(blobRoot, bytes);
      return json({ ref: stored, bytes: bytes.length }, 201);
    }

    // A GitHub token for this run, minted on demand and never stored.
    //
    // Per request rather than handed over once at dispatch, because `installationToken`
    // is documented as "called when needed, never captured at run start: a run that
    // exceeds an hour needs a refresh mid-flight, and a value held in a variable cannot
    // refresh itself." Shipping one at dispatch would have traded that away silently.
    const minting = /^\/runner\/runs\/([^/]+)\/token$/.exec(path);
    if (method === 'POST' && minting) {
      const runId = decodeURIComponent(minting[1]!);
      const authorized = await appendFromRunner(client, runner, runId, []);
      if ('refused' in authorized) {
        return json({ error: authorized.refused }, authorized.refused.includes('no such run') ? 404 : 403);
      }
      if (!options.mintToken) return json({ error: 'this plane cannot mint installation tokens' }, 501);
      // THE JOB'S installation, never the runner's and never one it names (M10, 10e).
      //
      // It used to be the runner's, on the reasoning that "a run it is authorized for
      // belongs to its installation by construction" — true while every runner named an
      // installation, and false the moment a global worker exists, whose own field is
      // null. Reading the `jobs` row is correct for both: for a confined runner the two
      // are the same value by construction, so nothing changes for it, and for a global
      // one it is the only answer that is not "mint for nobody".
      //
      // The authorization is unchanged and is above this line: `appendFromRunner` admits
      // exactly the runner the job was dispatched to. This decides WHICH token, not
      // whether one is owed.
      const facts = await jobFacts(client, runId);
      if (!facts) return json({ error: 'no such run' }, 404);
      const token = await options.mintToken(facts.installationId);
      return json({ token });
    }

    // ── WHAT A RUN IS PAID FOR AND BOOTED WITH (M10, ADR-0017) ──────────────────
    //
    // Two routes, authorized through the same door as an append — a runner gets what the
    // run it holds is entitled to, and nothing it can name. That is not a formality: a
    // route that took a `repo` parameter would let any paired runner ask for any
    // repository's credentials, and every runner on this plane belongs to somebody else.
    //
    // Values leave here. That is the only place in this service where they do, and both
    // ends of it are constrained: the caller has to hold a run, and the plane refuses
    // `/secrets` outright until this deployment has enabled injection, because 10l is
    // what proves the sandbox they land in has no route out.
    // ── WHAT A prove OR draft JOB PRODUCED (10h) ────────────────────────────────
    //
    // The one route on this surface that stores something which is not an event, and it is
    // deliberately not one: a proof is a fact about whether this engine can run somebody's
    // project, and a draft is an agent's proposal that no human has approved. Neither is an
    // observation about a user's bug, so neither belongs in an append-only log about one
    // (ADR-0006). They go to `recipes.proof` and `recipe_drafts`, which is where the local
    // product has always put them.
    //
    // Authorized through `appendFromRunner` like every other run-scoped route: a runner
    // gets to write for the run it holds and nothing it can name. The repository comes from
    // the JOB rather than the body — a runner that could name one would be able to overwrite
    // any repository's recipe draft on this plane, which is somebody else's onboarding.
    const finding = /^\/runner\/runs\/([^/]+)\/finding$/.exec(path);
    if (method === 'POST' && finding) {
      const runId = decodeURIComponent(finding[1]!);
      const authorized = await appendFromRunner(client, runner, runId, []);
      if ('refused' in authorized) {
        return json({ error: authorized.refused }, authorized.refused.includes('no such run') ? 404 : 403);
      }
      const facts = await jobFacts(client, runId);
      if (!facts) return json({ error: 'no such run' }, 404);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await body());
      } catch {
        return json({ error: 'the body is not JSON' }, 400);
      }
      const of = (parsed ?? {}) as { proof?: unknown; draft?: unknown };
      if (of.proof === undefined && of.draft === undefined) {
        return json({ error: 'send { "proof": … } or { "draft": … }' }, 400);
      }
      // A PROOF is stored as it arrives: `loadStored` reads it back defensively and
      // `Environment.tsx` renders whatever shape it finds, because a proof written by an
      // older engine has to render as what it is rather than throw.
      if (of.proof !== undefined) await saveProof(client, facts.repo, of.proof);
      // A DRAFT goes through `parseRecipe` FIRST, and this is the one validation on this
      // route that is not optional. It is an agent's output — the agent is untrusted by
      // construction and its prompt contains text a stranger wrote (ADR-0013) — and a draft
      // that cannot parse is a box a human is asked to approve and cannot even read. Stored
      // as a draft either way, never as a recipe: the human is still the control.
      if (of.draft !== undefined) {
        try {
          parseRecipe(of.draft);
        } catch (error) {
          return json({ error: `that draft is not a recipe: ${String((error as Error).message ?? error)}` }, 400);
        }
        await saveDraft(client, facts.repo, of.draft);
      }
      return json({ stored: [of.proof !== undefined ? 'proof' : null, of.draft !== undefined ? 'draft' : null].filter(Boolean) });
    }

    const wants = /^\/runner\/runs\/([^/]+)\/(secrets|model-key)$/.exec(path);
    if (method === 'POST' && wants) {
      const runId = decodeURIComponent(wants[1]!);
      const authorized = await appendFromRunner(client, runner, runId, []);
      if ('refused' in authorized) {
        return json({ error: authorized.refused }, authorized.refused.includes('no such run') ? 404 : 403);
      }
      const facts = await jobFacts(client, runId);
      if (!facts) return json({ error: 'no such run' }, 404);

      if (wants[2] === 'secrets') {
        // 501 rather than an empty object, and the difference matters to the worker: it
        // has to be able to tell "this repository has no secrets" from "this deployment
        // does not hand them out yet". An empty object would read as the first and start
        // a run that quietly lacks what its recipe requires.
        if (!secretsEnabled()) {
          return json({ error: 'this deployment does not inject stored secrets yet (ADR-0017)' }, 501);
        }
        try {
          return json({ secrets: await repoSecrets(client, facts.repo) });
        } catch (error) {
          // A row that will not open is a row that was moved, corrupted, or sealed under
          // a key this deployment no longer has. It is ours, not the runner's, and it
          // must not arrive as a bare cipher error: the worker's only useful response is
          // to stop, and the operator's is to look at `key_id`.
          return json(
            {
              error:
                'a stored secret for this repository could not be decrypted; ' +
                'PLANE_SECRETS_KEY may have changed, or the row was written elsewhere',
              detail: String((error as Error).message ?? error),
            },
            500,
          );
        }
      }
      // The key of whoever pressed Start. A webhook-era job has nobody to bill, so it
      // gets a null and the worker falls back to its own configuration — which is what
      // every run did before the button existed.
      if (facts.requestedBy === null) return json(null);
      return json(await modelKey(client, facts.requestedBy));
    }

    // WHAT THE RUN COST, which is ours and not the repository's.
    //
    // A route rather than events, because a fact about our spending does not belong in a
    // log about somebody's bug (ADR-0006) — `readmodel.ts` says so at the top and this is
    // the hosted half of it. Before this, `saveUsage` had exactly one caller, `serve.ts`,
    // so every run driven by a worker lost what it spent: the tokens on the floor and the
    // sandboxes never recorded at all.
    //
    // Best-effort by design. A bill that cannot be written must not fail a run that has
    // already produced its evidence, so this answers 204 for a body it partly rejected
    // and the runner does not retry.
    const costing = /^\/runner\/runs\/([^/]+)\/cost$/.exec(path);
    if (method === 'POST' && costing) {
      const runId = decodeURIComponent(costing[1]!);
      // The same door as an append: writing somebody else's bill is not a lesser thing to
      // be allowed to do than writing to their log.
      const check = await appendFromRunner(client, runner, runId, []);
      if ('refused' in check) return json({ error: check.refused }, 403);
      let sent: { usage?: unknown; compute?: unknown };
      try {
        sent = JSON.parse(await body()) as typeof sent;
      } catch {
        return json({ error: 'the body is not JSON' }, 400);
      }
      // REFUSED rather than truncated, like the two routes above it. A real run posts
      // about five compute rows and four usage rows; anything near the ceiling is a
      // runner with a bug, and silently keeping the first 500 would hide it.
      const rows = (value: unknown) => (Array.isArray(value) ? value : []);
      if (rows(sent.usage).length > MAX_BATCH || rows(sent.compute).length > MAX_BATCH) {
        return json({ error: `at most ${MAX_BATCH} rows of each kind` }, 400);
      }
      // `run_id` comes from the PATH, never from the body — a runner authorized for this
      // run must not be able to write a row against another one.
      //
      // SAID OUT LOUD when a row is refused. Swallowing is right — a bill that cannot be
      // written must not fail a run whose evidence is already shipped — but swallowing
      // silently is not: a mis-shaped row hits a NOT NULL or a type error, the runner
      // does not retry, and the page is empty forever with nothing anywhere to say why.
      // `serve.ts` already logs its own `saveUsage` failure for exactly this reason.
      const refused = (kind: string) => (error: unknown) =>
        options.log?.(`${runId}: could not record ${kind} — ${String((error as Error).message ?? error)}`);
      for (const row of rows(sent.usage)) {
        await saveUsage(client, { ...(row as UsageRow), run_id: runId }).catch(refused('usage'));
      }
      for (const row of rows(sent.compute)) {
        await saveCompute(client, { ...(row as ComputeRow), run_id: runId }).catch(refused('compute'));
      }
      return { status: 204, type: 'application/json', body: '' };
    }

    const finished = /^\/runner\/runs\/([^/]+)\/finished$/.exec(path);
    if (method === 'POST' && finished) {
      const runId = decodeURIComponent(finished[1]!);
      // Authorized through the same door as an append: finishing somebody else's job is
      // not a lesser thing to be allowed to do than writing to it.
      const check = await appendFromRunner(client, runner, runId, []);
      if ('refused' in check) return json({ error: check.refused }, 403);
      await finishJob(client, runId);
      return { status: 204, type: 'application/json', body: '' };
    }

    return json({ error: 'no such runner route' }, 404);
  };
}
