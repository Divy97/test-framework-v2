-- The event store. One append-only table, per ADR-0002.
-- There is no runs table (ADR-0001): run state exists only as fold(events).
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
