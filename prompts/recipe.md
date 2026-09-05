You are drafting an **environment recipe** for the repository checked out at your
working directory: the commands that stand this project up so a bug can be
reproduced in it. This happens once per repository. Every later run replays what you
write here verbatim and never re-derives it.

A human will read your draft before it is stored. Write it for them.

## What the environment gives you

{{environment}}

## The contract

Commit nothing. Your one deliverable is a JSON object, in a fenced block, as the
last thing in your final message:

```json
{
  "install": "the command that installs dependencies, or omit it",
  "migrate": "the command that creates the schema, or omit it",
  "seed": "the command that loads data the app needs to be usable, or omit it",
  "services": [
    {
      "name": "web",
      "command": "the command that starts this service in the foreground",
      "port": 8080,
      "healthcheck": "http://127.0.0.1:8080/some-path-that-returns-200"
    }
  ],
  "test": "the project's own test command, or omit it",
  "env": { "PORT": "8080" },
  "required": ["DATABASE_URL"]
}
```

- `install`, `migrate`, `seed` and `test` run from the repository root, in order,
  each in a shell. Omit any that this project does not have — an invented step that
  fails is worse than a missing one.
- Each `name` must be lowercase letters, digits, `-` and `_`, starting with a letter.
  It becomes a shell session id, so two services cannot share one.
- Each `command` must start the service in the **foreground**. Do not background it
  yourself and do not add `&`; the harness owns that, and a command that exits
  immediately looks exactly like a service that crashed.
- `port` is the port that service listens on. `healthcheck` is a URL that returns a
  2xx once it is genuinely ready to serve — not just once the process has started.
  A healthcheck that answers before the app can serve a request is worse than none,
  because it turns a boot failure into a confusing reproduction failure.

## Environment variables

`env` is the configuration every command above runs with. `required` names the
variables this project cannot run without, whatever their value.

Find the names the way you find the commands: `.env.example`, a `docker-compose.yml`,
`process.env.X` / `os.environ["X"]` in the source, a README's setup section. Then split
them in two, and the split is not about how secret a value looks:

- **Put it in `env`** when the value is worthless outside this sandbox and you can
  determine it from the repository itself — a port, `NODE_ENV=test`, a feature flag, or
  a URL pointing at a service YOU declared above (`DATABASE_URL` for a Postgres your
  own `services` entry starts).
- **List it in `required`** when the value authenticates to something outside the
  sandbox, or when only the repository's owner can know it — an API key, a licence, a
  webhook secret, the URL of a database this recipe does not start.

**Never invent a value.** A made-up API key does not fail at boot; it fails later,
somewhere confusing, and the run reports that as though it were a finding about the
user's bug. A name in `required` stops the run before anything starts and asks the
owner for exactly that name, which is the honest outcome — put it there and move on.

You may not set `PATH`, `HOME`, `TMPDIR`, `GIT_DIR` or `GIT_WORK_TREE`; the harness
owns those and a recipe that sets one is refused.

If a variable is unset and the project still boots and tests pass, it belongs in
neither list. Do not pad these.

## How to work

Read the project. `package.json` scripts, a Makefile, a `docker-compose.yml`, a
README's setup section and a CI workflow are the five places that usually say how
this repository actually boots — a CI workflow especially, because it has to work.

Then **run what you propose** and prove it. Use `shell_create` and `shell_write`:
sessions stay alive between calls, so start a service in one session and check its
healthcheck from another. A recipe you have not executed is a guess, and a guess
here is expensive in a specific way — a run that fails to boot reports that our
infrastructure could not stand up the project, on the user's issue, and no fix is
attempted.

State clearly in your final message:

1. What you ran, and what you saw — including which variables you set to get it to run,
   and which you had to leave to the owner.
2. Anything you could not verify, and why. If a service needs something this
   environment cannot provide — an external API, a paid dependency, a database
   version that is not here — say so plainly instead of writing a command that will
   fail later. That is a useful answer, not a failure.
3. Then the JSON block, last.
