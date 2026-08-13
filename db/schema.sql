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
