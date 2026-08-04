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
