-- THE MIGRATION GAP, named because it bit during M6 and will bite again.
--
-- `npm run db:schema` pipes this whole file through psql, and every statement is
-- `create table if not exists` — which is a NO-OP on a table that already exists. So
-- adding a column here changes nothing in a database that already has the table, and the
-- failure surfaces later as an insert complaining about a column nobody can find.
--
-- It happened during this milestone: `run_projection` was created, then `scoring` was
-- added to this file, and the second run of `db:schema` reported success and did nothing.
-- For `run_projection` the escape hatch exists — drop it and `npm run rebuild`, since it
-- holds no truth. For `installations` and `run_usage` it does not: neither is derivable
-- from the log, so a column added to either needs a hand-written `alter table`.

-- The event store. One append-only table, per ADR-0002.
--
-- There is no runs table (ADR-0001): run state exists only as fold(events). That
-- sentence stood alone until M6c added `run_projection` below, and it still holds —
-- because that table holds no truth. Every column in it is recomputed from this one by
-- `src/projection.ts`, and a test drops it, replays, and compares. The distinction the
-- ADR draws is between a source of truth and a cache, not between one table and several.
create table if not exists events (
  run_id  uuid        not null,
  seq     integer     not null,
  type    text        not null,
  payload jsonb       not null,   -- includes "v": schema version
  ts      timestamptz not null default now(),
  unique (run_id, seq)
);

-- Environment recipes, on OUR side, keyed by repository (ADR-0013).
--
-- Deliberately not `.engine/env.json` in the user's codebase. A committed recipe
-- would be visible, reviewable and versioned with the code it describes — genuinely
-- the better engineering artifact — and it is rejected because it makes onboarding a
-- pull request against someone else's repository before we have delivered anything.
--
-- Not append-only, unlike `events`: a recipe is current configuration rather than a
-- fact about a run, and a project that changes its start command needs the row
-- changed. What a run did with the recipe it was given is in the event log, where it
-- cannot be edited.
create table if not exists recipes (
  repo        text        primary key,  -- GitHub's own `full_name`, e.g. "owner/repo"
  recipe      jsonb       not null,
  approved_at timestamptz not null default now()
);

-- What proving this repository found (8f): the environment built, the project's own
-- test command run in a sealed container, and everything that could not be proved.
--
-- In THIS row rather than a table of its own, because a proof is an observation about
-- a specific set of commands: approving a new recipe has to invalidate it, and here
-- that is a fact about where the bytes live rather than an invariant to remember.
-- Nullable, because a recipe approved before its proving run finished — or before this
-- column existed — has no proof, and "not proved yet" is a state the page renders.
alter table recipes add column if not exists proof jsonb;

-- Which repositories we are installed on, and under which installation (M6a).
--
-- Current configuration, like `recipes`, not a fact about a run — so it is mutable and
-- it is NOT the event log. `installation.id` arrives on every delivery and was thrown
-- away, which meant the first thing we ever learned about a repository was an issue. By
-- then a run had already started with `recipe: null`, booted nothing, and produced a
-- Tier 3 about a bug that was never shown: a user's first experience of the product was
-- a wrong answer, and one our own log recorded as a finding about their bug.
--
-- `removed_at` rather than a delete, because "we were installed and then removed" and
-- "we were never installed" are different answers to a delivery arriving, and only one
-- of them is worth a message.
create table if not exists installations (
  repo            text        primary key,
  installation_id bigint      not null,
  account         text        not null,
  connected_at    timestamptz not null default now(),
  removed_at      timestamptz
);

-- What a run COST us. Beside `events`, deliberately never inside it (M6d).
--
-- Inventing an event class to describe our own spending would put a fact about us in a
-- log about the user's bug, which is the line ADR-0006 draws. The log says what happened
-- to their repository; this says what we paid to find out.
-- The cache columns are kept although milestone 6 does not list them. Its own done-when
-- is "a real run's row matches what the provider billed, to the token", and cached input
-- is billed at a different rate — so a row without them cannot be reconciled against a
-- bill, which is the only thing this table is for.
--
-- `integer` throughout, deliberately: node-postgres returns `bigint` as a STRING, so a
-- token count typed that way arrives as text and silently breaks every sum.
create table if not exists run_usage (
  run_id                      uuid    not null,
  phase                       text    not null,
  turns                       integer not null,
  input_tokens                integer not null,
  output_tokens               integer not null,
  cache_read_input_tokens     integer not null default 0,
  cache_creation_input_tokens integer not null default 0,
  provider                    text    not null,
  model                       text    not null,
  primary key (run_id, phase)
);

-- WHICH agent phase, because a run has two and `(run_id, phase)` cannot tell them apart.
--
-- The repro agent and the fix agent both report `phase: 'agent'` (`orchestrate.ts`), so
-- the second row's `on conflict do update` landed on the first and the repro agent's spend
-- was silently replaced. Half the model bill, wrong since M6d, and invisible while the
-- only runs anyone read closely were local ones — 10f is what starts writing this for
-- hosted runs, and what puts it on a page beside two agent SANDBOXES.
--
-- Migrated in three idempotent steps rather than by re-declaring the key: a `create table
-- if not exists` cannot change a table that already exists, and `add primary key` is not
-- re-runnable. A unique index does the same work and says `if not exists`.
alter table run_usage add column if not exists n integer not null default 0;
create unique index if not exists run_usage_key on run_usage (run_id, phase, n);
alter table run_usage drop constraint if exists run_usage_pkey;

-- What the SANDBOXES cost (M10, 10f), beside the log for the same reason `run_usage` is.
--
-- One row per sandbox, not per phase: a run creates five — the environment build, two
-- agents, base and fix — and `agent` appears twice, so `(run_id, phase)` is not unique
-- and would silently keep only the second one.
--
-- Every measure is nullable because the platform does not always report one. The
-- environment build is the clearest case: `snapshot()` stops the sandbox, and the SDK
-- reports a session's cost only from `stop()` — so the longest-lived sandbox in a run
-- reports nothing at all. A zero there would be a measurement; null is the absence of
-- one, and the difference matters when the question is what a run cost.
create table if not exists run_compute (
  run_id        uuid        not null,
  sandbox_id    text        not null,
  phase         text        not null,
  active_cpu_ms bigint,
  duration_ms   bigint,
  ingress_bytes bigint,
  egress_bytes  bigint,
  observed_at   timestamptz not null default now(),
  primary key (run_id, sandbox_id)
);

-- The read model. A DISPOSABLE CACHE, and the README's first architectural claim
-- depends on it staying one (M6c).
--
-- Every column is derived from the event stream by `projectRun` — `repo` and
-- `issue_number` out of `thread_ref`, which is `owner/repo#41` on every RUN_REQUESTED;
-- status, tier and confidence out of the fold and the confidence projection. Nothing is
-- written here that could not be recomputed, which is what makes `rebuild` able to drop
-- the table and replay the log into a byte-identical result.
--
-- There is still no runs table in the ADR-0001 sense: this one holds no truth. Delete it
-- and nothing is lost; delete `events` and everything is.
create table if not exists run_projection (
  run_id       uuid        primary key,
  repo         text        not null,
  issue_number integer     not null,
  status       text        not null,
  tier         integer     not null,
  confidence   integer     not null,
  -- The denominator AND the scale. `Confidence.scoring` went to 2 when the grounds and
  -- the ceiling moved (85 -> 103), and a stored number without its version is a number
  -- nobody can read a year later — which is the whole reason that field exists.
  ceiling      integer     not null,
  scoring      integer     not null,
  regression   text        not null,
  pr_url       text,
  started_at   timestamptz not null,
  ended_at     timestamptz,
  last_seq     integer     not null
);

create index if not exists run_projection_repo on run_projection (repo, started_at desc);

-- A recipe an agent PROPOSED, before any human has approved it (M6b, ADR-0013).
--
-- Current configuration, like `recipes` and `installations`: mutable, keyed by
-- repository, and not a fact about a run. Unlike `recipes`, this row is advisory
-- testimony from an agent and is NEVER read by anything that executes a command — only
-- `recipes`, populated by a human approving one at `/repos/<repo>/onboard`, is ever
-- replayed. Losing this table costs nothing but a re-draft: the agent can always be asked
-- again, which is why it gets no more durability than an upsert and a delete.
create table if not exists recipe_drafts (
  repo       text        primary key,
  draft      jsonb       not null,
  drafted_at timestamptz not null default now()
);

-- ── The control plane (milestone 9) ───────────────────────────────────────────
--
-- Both tables are CONFIGURATION AND DISPATCH, not the log — the same class as
-- `installations` and `recipes`, and for the same reason: they describe the current
-- state of an arrangement between a person and this service, not a fact about a run.
-- What a run did stays in `events`, where nothing can edit it.
--
-- The split matters for one specific invariant. ADR-0009 says the orchestrator is the
-- trusted writer and there is exactly one of it; hosted, that orchestrator is a runner
-- on somebody's laptop. Keeping dispatch OUT of the log is what lets the plane decide
-- who may write without becoming a second writer itself: it mints the `run_id` here,
-- and every event under that id still comes from one runner.

-- A machine that has been paired to an installation, and may write its events.
--
-- `token_hash`, never the token: it is shown once at pairing and is not recoverable
-- afterwards. A stolen database therefore yields no runner credential — the same
-- reasoning ADR-0012 applies to the App key, one layer down.
create table if not exists runners (
  id              uuid        primary key,
  installation_id bigint      not null,
  name            text        not null,
  token_hash      text        not null unique,
  paired_at       timestamptz not null default now(),
  -- Presence. A long-poll that returns empty still stamps this, so "no runner is
  -- online" and "no runner was ever paired" are different answers to a queued job.
  last_seen       timestamptz,
  -- Revocation is a timestamp rather than a delete, because a revoked runner\'s
  -- events are still in the log and a reader asking "who wrote this" deserves a row.
  revoked_at      timestamptz
);

create index if not exists runners_installation on runners (installation_id);

-- A runner that belongs to no installation is one WE operate (M10, 10e).
--
-- Until M10 every runner was somebody's laptop and belonged to exactly one installation;
-- the filter in `claimJob` was the whole of the boundary between one person's work and
-- another's. A hosted worker cannot be per-installation — it is one process serving
-- everyone who installs the App — so `null` is added to the domain to mean "any".
--
-- Nullable rather than a sentinel id like 0: a sentinel is a number that compares equal
-- to something, and the day an installation id collides with it the boundary is gone
-- silently. `null` compares equal to nothing, so the widening has to be written out in
-- SQL (`$1 is null or installation_id = $1`) where a reader can see it.
--
-- Only the operator script writes it. `pairRunner` is reachable from the dashboard with
-- an installation the caller can see; nothing a user can reach passes null.
alter table runners alter column installation_id drop not null;

-- One unit of work: a delivery the plane accepted and a runner has to execute.
--
-- The `run_id` is minted HERE, before any runner sees it, and that is what makes
-- authorization possible at all: appending to a run means proving this job was
-- dispatched to you. A runner that invents a `run_id` matches no row and is refused.
create table if not exists jobs (
  run_id          uuid        primary key,
  installation_id bigint      not null,
  repo            text        not null,
  -- The delivery as it arrived, so a re-dispatch replays the same input rather than
  -- a reconstruction of it.
  intake          jsonb       not null,
  queued_at       timestamptz not null default now(),
  runner_id       uuid        references runners (id),
  dispatched_at   timestamptz,
  finished_at     timestamptz
);

-- Partial, because the queue is only ever read for jobs nobody has taken.
create index if not exists jobs_queued on jobs (installation_id, queued_at) where runner_id is null;

-- Who pressed Start, and on which issue (M10).
--
-- `requested_by` is a GitHub user id, null for a job that arrived by webhook — which no
-- longer starts a run on the plane — so absence reads as "before the button existed"
-- rather than as unknown. `issue_number` is copied out of `intake` so that "is a run for
-- this issue already under way" is one indexed query and not a jsonb scan.
alter table jobs add column if not exists requested_by bigint;
alter table jobs add column if not exists issue_number integer;
create index if not exists jobs_open_issue on jobs (repo, issue_number) where finished_at is null;

-- Who is logged in (9c). GitHub OAuth is the only human authentication there is.
--
-- The row holds a user-to-server token, and that is a real secret worth naming: it is
-- what answers "which installations may this person see", asked of GitHub at the moment
-- of every authorization decision rather than cached into a permission model of our own.
-- It is narrower than a personal access token by construction — a user-to-server token
-- can only reach repositories this App is installed on — which is the same reasoning
-- ADR-0012 uses to reject PATs, applied to the human half.
--
-- Deleted on logout and expired by `created_at`, so the window is bounded in both
-- directions. No refresh: a session that has aged out is a login, not a renewal.
create table if not exists sessions (
  id         text        primary key,   -- 32 random bytes, base64url; never a JWT
  github_id  bigint      not null,
  login      text        not null,
  avatar_url text        not null default '',
  token      text        not null,
  created_at timestamptz not null default now(),
  seen_at    timestamptz not null default now()
);

create index if not exists sessions_github on sessions (github_id);

-- A run whose artifacts were destroyed on request (9e).
--
-- NOT an event, and the reason is the whole design. The log has one writer per run and
-- it is the runner (ADR-0009, ADR-0019); a row appended here by the plane would make it
-- a second producer of facts about somebody\'s bug. Forgetting is not a fact about the
-- bug at all — it is an administrative act on OUR storage, which is the same class as
-- `jobs`, `installations` and `recipes`.
--
-- So the log is untouched, and that is the strongest available answer to "did you edit
-- my history": no. We deleted bytes we were holding, the events still say exactly what
-- they always said, and this row is why the hashes in them no longer resolve.
create table if not exists forgotten (
  run_id       uuid        primary key,
  requested_by text        not null,
  forgotten_at timestamptz not null default now(),
  -- What was actually removed, which is not the same as what the run cited: a blob
  -- another run also cites is kept, because content addressing means those are the same
  -- bytes and deleting them would break a run nobody asked to forget.
  removed      integer     not null default 0
);

-- Values a run needs and nobody may read back (M10, ADR-0017).
--
-- `bytea`, not `text`, and encrypted before it gets here: `src/secrets.ts` seals with
-- AES-256-GCM under `PLANE_SECRETS_KEY` and binds each ciphertext to the row it belongs
-- to, so a value moved between rows fails to open rather than opening somewhere it was
-- never meant to be. The database therefore holds nothing a `select *` can read, which
-- is the property a backup, a restored snapshot and a support session all depend on.
--
-- `key_id` records which key sealed each row. There is one today, named `k1`. Rotation
-- is not implemented and this column is what makes implementing it possible without a
-- migration that has to guess.
--
-- No `value` column anywhere, and no route that returns one. What comes back from this
-- table is names.
create table if not exists repo_secrets (
  repo       text        not null,
  name       text        not null,
  ciphertext bytea       not null,
  key_id     text        not null,
  created_by text        not null,
  updated_at timestamptz not null default now(),
  primary key (repo, name)
);

-- What pays for a person's runs (M10).
--
-- One per human, not per repository: the key is the person's, the cost is the person's,
-- and a run started from the button spends the key of whoever pressed it. Same sealing,
-- bound to the GitHub user id instead of a repository.
create table if not exists user_model_keys (
  github_id  bigint      primary key,
  provider   text        not null,
  ciphertext bytea       not null,
  key_id     text        not null,
  updated_at timestamptz not null default now()
);
