---
status: accepted
---

# The database handle is a pool

Every entry point opened one connection at boot and held it for the life of the process:

```ts
export const connect = () => new pg.Client({ connectionString });
```

No `'error'` listener, no reconnect. That is correct for exactly as long as the
connection never drops, which is true of a Postgres in Docker on the same laptop for an
afternoon, and false of every place this is about to run.

It is worth being precise about the failure, because "it reconnects" is not what was
wrong. When a `pg.Client` loses its connection it emits `'error'`. Nothing was
listening. An unhandled `'error'` event in Node is not a logged warning — it is
`process.exit`. So the plane, under `restart: always`, would not have degraded when its
database went quiet: it would have entered a crash loop, starting at whatever hour the
traffic stopped, and recovering every morning in time to look healthy.

The trigger was choosing a host. A managed Postgres suspends idle compute on the free
tier; a load balancer reaps a socket that has been silent; a network blips. All three
are the same event, and this repository had never run long enough to see any of them.

## Decision

**`connect()` returns a `pg.Pool`, exported as the type `Db`.** A pool answers each
query on whichever connection is live and opens another when one is gone, so a dropped
connection costs a query rather than the process. The rename from `pg.Client` to `Db`
is mechanical, but the type name is deliberate: nothing outside `store.ts` should
express an opinion about how many connections there are.

**The pool carries an `'error'` listener, and that listener is the fix.** A pool emits
`'error'` for a connection dying while IDLE in it — no caller is awaiting that one, so
there is no promise to reject and nobody to tell. That is the event that ends the
process, and handling it is one line.

**`ready(db)` proves the database is reachable at boot.** A pool is lazy, so a wrong
`DATABASE_URL` would otherwise be discovered by the first webhook delivery at 3am and
reported to GitHub as a failed delivery. Every entry point calls it, and the failure
lands in the terminal of whoever just started the process.

**No transactions, still.** [ADR-0019](0019-who-writes-when-the-runner-is-not-ours.md)
declined a transaction around the batch append for a domain reason that has not changed:
an append-only log has no un-append. Its *mechanical* reason has changed and is now
stronger — a `begin` and its `commit` issued as separate `pool.query()` calls are not
promised to reach the same connection. A real transaction needs a client checked out and
released in a `finally`. Nothing here needs one: `claimJob`'s `for update skip locked`
is inside a single statement, and there is no `LISTEN`/`NOTIFY` anywhere, which is the
other thing a pool would have quietly broken.

## How it is tested

Against a real database, by killing connections with `pg_terminate_backend` — the same
FATAL the server sends when it reaps a socket itself.

The subtlety worth recording: **the pool recovers with or without the listener.** Remove
it and the connection still dies, the pool still opens another, and a test that merely
queried again still passes. What differs is only that the dead connection's `'error'`
reaches the process as an uncaught exception. So the test asserts on the uncaught
exception, not on the recovery — the recovery was never the part that was broken, and a
test written against it would have been green through the entire bug.

## Consequences

- **A dropped connection is a log line.** `database connection dropped while idle (the
  pool will open another)` — visible, not silent, because a database that is dropping
  connections every few minutes is worth knowing about even though nothing fails.
- **Connection count is now a deployment concern.** Default `max` is 10 per process.
  A free-tier database with a small connection limit and several processes is a limit
  to check before it is a page.
- **`connectionTimeoutMillis` is set to 10s.** The default is no timeout at all, and a
  suspended database that will answer *eventually* is not the same as one that will
  answer, but a request holding a connect that never resolves is indistinguishable from
  a hang.
