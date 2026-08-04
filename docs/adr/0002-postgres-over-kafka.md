---
status: accepted
---

# Event store: a single append-only Postgres table, not Kafka

The event store needs exactly one guarantee: **ordered, durable, append-only
events per run**, written by a single writer (the run's Runner) and read by
projections and an SSE tail.

**Decision.** One Postgres table:

```sql
events (
  run_id  uuid        not null,
  seq     integer     not null,
  type    text        not null,
  payload jsonb       not null,   -- includes "v": schema version
  ts      timestamptz not null default now(),
  unique (run_id, seq)
)
```

Monotonic `seq` per run is enforced at write time; the `unique (run_id, seq)`
constraint makes a violation impossible rather than merely unlikely. Ordering
is per-run only — there is no cross-run ordering requirement, so a global log
buys nothing.

**Why not Kafka.** Kafka solves distributed log *replication*: many producers,
many partitions, cross-machine durability, consumer-group semantics. We have
one writer per run, per-run ordering, and one database. Postgres already gives
transactional ordering and durability with near-zero operational cost. Running
Kafka on a laptop for this workload signals the opposite of judgment.

**Also rejected.** Redis Streams (no transactional coupling with projections;
persistence is an afterthought here), EventStoreDB (right semantics, but a new
operational dependency for guarantees Postgres already provides at this scale).

**Revisit when** there are many concurrent writers per stream, cross-run
ordering requirements, or throughput beyond a single Postgres instance — none
of which v1 has.
