# The demo repository

A deliberately small storefront with deliberate bugs. Two jobs, and
[SHARED-UNDERSTANDING](../SHARED-UNDERSTANDING.md) (Q8, as amended by v1.5) is
careful about which is which:

1. **The demo target.** One `node server.mjs`, no dependencies, never flakes.
2. **The only repository with an environment recipe**, so 5b, 5c and 5f are all
   tested against it. This is what stopped it being a demo-only artifact.

It is explicitly **not** the verification engine's adversarial fixture. Those stay
tiny generated git repos in `test/fixtures/repo.ts`, because seeding deliberate
gaming attempts into a demo makes the demo worse and a demo app is too slow and
too coarse to test a judge with.

## Running it by hand

```sh
node db.mjs migrate && node db.mjs seed
node server.mjs           # http://127.0.0.1:8080
node --test               # the project's own suite, which passes
```

`page.mjs` and `orders.mjs` hold the page and the orders query as functions, separate
from `server.mjs`. That is not tidiness: it is what makes a reproduction of each bug
runnable in a sealed phase container with no browser and no service in it. A test that
had to fetch a URL would need the app up; a test that grepped the source would be an
oracle over the tree rather than over the behaviour. SQLite is a file, so a
reproduction can migrate, seed and query with nothing running.

**Each expected outcome below has a run behind it** — `test/run.test.ts` and
`test/sandbox.test.ts` drive all four through the engine. A claimed tier with no test
is the kind of claim this project exists to refuse.

No `npm install` is needed — `node:sqlite` and `node:http` are the entire
dependency list. The recipe still has an install step, because a recipe with no
install step would not exercise the thing [ADR-0013](../docs/adr/0013-the-environment-recipe.md)
is about.

## The seeded bugs

Each is written as the issue text a user would actually open, because that text is
the agent's input and a bug report nobody would write is not a test of intake.
The tier each one should reach is the assertion, not a hope.

### 1. `orders-heading` — a wrong string, only visible by looking

> The orders page title is misspelled. It says "Ordres" instead of "Orders".

The canonical v1.5 bug: reachable by rendering the page, not by reading a test.
Expected outcome: **Tier 2**, browser-driven, agent-authored.

### 2. `shipped-filter` — an API bug that needs the database

> /api/orders?status=shipped returns every order, including pending ones.

Needs the backend booted and the seed data present, which is the whole reason the
recipe exists. Expected outcome: **Tier 2** — and this is the run that drives a recipe
through the entire issue-to-pull-request path: the agent queries the live endpoint and
sees four orders where two were asked for, then commits a reproduction that needs
neither the service nor the network.

### 3. `export-button` — irreproducible by design

> Sometimes when I click Export on the orders page nothing happens. It worked
> last week.

There is no Export button and there never was. Expected outcome: **Tier 3** — a
structured info-request, no fix attempted, the gate holding in public. Asserted down
to the comment's wording: it names what would help, in order, and it does not
apologise.

### 4. `total-rounding` — the obvious fix is a no-op

> The order total shown on the orders page is wrong for order 3.

It is not wrong; order 3 genuinely totals what it says. The tempting fix is a
rounding change that alters nothing, which is the control shape: a run that
credits it has learned nothing about the bug. Expected outcome: **Tier 3**. The run
asserts the sharper thing: an honest reproduction is registered, the base container
runs it, it passes — and **no fix agent is ever spawned**, proved by the absence of a
fix container and of a `fix` handover in the log.
