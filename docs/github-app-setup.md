---
status: living
---

# Registering the GitHub App, and pointing it at a running service

The last unverified done-when in v1.5. Everything below the App is built and tested;
nothing here has been accepted by GitHub, because registering an App needs an account
and this repository does not have one.

Every value in this document was read out of the code rather than out of GitHub's docs,
and two of them contradict [architecture-v1.5](architecture-v1.5.md) as it was written —
see the notes there.

## Permissions, and the one that fails silently

| Permission | Why | Where |
|---|---|---|
| **Contents** — read and write | clone at base; push the fix branch | `cloneRepository`, `run.ts` |
| **Pull requests** — read and write | `POST /repos/:repo/pulls` | `github.ts:264` |
| **Issues** — read and write | `POST /repos/:repo/issues/:n/comments` | `github.ts:385` |

Nothing else. Every additional permission is one the party under judgement could
theoretically benefit from, and the whole architecture rests on it having none.

**Issues: write is not optional, and omitting it is invisible.** A run comments on the
issue on every outcome, and for **Tier 3 the comment is the entire deliverable** — no
pull request exists. `run.ts` swallows a failed comment on purpose, because there is no
event class for "we could not reach GitHub to say what happened" and inventing one would
put a fact about us in a log about the user's bug. So with only `contents` and
`pull_requests`, a Tier 3 run reproduces nothing, correctly declines to fix, posts
nothing, and records no error. It is indistinguishable from a webhook that never fired.

## Events

**Issues only.** `intake()` accepts exactly two triggers — `opened` and `labeled` — and
returns `null` for everything else, which the receiver answers `202 not a trigger`. A
`push` subscription would deliver traffic that provably does nothing.

## The form

<https://github.com/settings/apps/new>

| Field | Value |
|---|---|
| Name | anything unique |
| Homepage URL | anything |
| **Webhook** | ✅ Active |
| **Webhook URL** | your tunnel URL. **The path does not matter** — `startWebhookReceiver` checks `method === 'POST'` and nothing else |
| **Webhook secret** | `openssl rand -hex 32`, and keep it |
| Request user authorization (OAuth) | **unchecked** — no user token is ever requested (ADR-0012) |
| **Setup URL** | **blank.** There is no setup flow: `installation.id` arrives in every delivery and is read per delivery, never stored |
| Where can this be installed | Only on this account |

Then: note the **App ID**, and **Generate a private key** — a `.pem` downloads.

Finally **Install App**, and select only the repository you are testing.

## The prerequisite that stops you first

`demo/` is eight files tracked *inside this repository*. There is no `owner/repo` to
install onto, so the demo application needs to be its own repository:

```sh
gh repo create test-framework-v2-demo --private
cd /tmp && git clone https://github.com/<you>/test-framework-v2-demo && cd test-framework-v2-demo
cp -r <this-repo>/demo/. .
git add -A && git commit -m "the demo storefront, with its seeded bugs" && git push
```

## Configuration

```sh
# .env, alongside DATABASE_URL and the model provider
GITHUB_APP_ID=123456
GITHUB_WEBHOOK_SECRET=<the openssl value>
GITHUB_PRIVATE_KEY_PATH=/absolute/path/to/your-app.private-key.pem
ENGINE_IMAGE=test-framework-v2-sandbox:latest
ENGINE_AGENT_IMAGE=test-framework-v2-agent:latest
ENGINE_BLOB_ROOT=/absolute/path/to/.blobs
```

`npm run serve` refuses to start if any of the first three is missing, and names what
its absence costs. A service that starts without a secret 401s every real delivery,
which looks exactly like GitHub sending nothing.

## The recipe, or nothing boots

A repository with no recipe boots nothing, the agent is told so, and the likely outcome
is a Tier 3 about a bug that was never shown — which reads as a model failure and is a
configuration one (ADR-0013).

```sh
cat > /tmp/demo-recipe.json <<'JSON'
{
  "install": "npm install --no-audit --no-fund",
  "migrate": "node db.mjs migrate",
  "seed": "node db.mjs seed",
  "services": [{ "name": "web", "command": "PORT=8080 node server.mjs", "port": 8080,
                 "healthcheck": "http://127.0.0.1:8080/healthz" }],
  "test": "node --test"
}
JSON
npx tsx --env-file=.env src/cli.ts recipe approve /tmp/demo-recipe.json <you>/test-framework-v2-demo
```

## Running it

```sh
docker build -t test-framework-v2-sandbox:latest .
docker build -t test-framework-v2-agent:latest -f Dockerfile.agent .
npm run db:schema                                   # once
cloudflared tunnel --url http://localhost:8787      # paste the URL into the App
npm run serve
```

Open an issue on the demo repository:

> **The shipped filter returns everything**
>
> `/api/orders?status=shipped` returns every order, including pending ones.

That is the entire interaction. The next thing you should see is a pull request.

Watch it while it happens:

```sh
curl -N http://localhost:8788/runs/<run-id>/events
```

## Two things that will waste your time

**The free tunnel URL changes on every restart**, so the App's webhook URL needs editing
each time. The App's **Advanced → Recent Deliveries** page shows the exact payload and
lets you **Redeliver** — that is a far faster loop than opening new issues, and it is the
only way to retry a delivery without creating one.

**One run at a time.** A recipe pins a fixed host port, so `serve.ts` serialises runs
deliberately: two concurrent runs against the same repository would fight over that port
and the loser's healthcheck would fail, which the engine would honestly record as
`errored`. Label three issues at once and they queue.

## What this still does not prove

That GitHub accepts any of it. Until an App is registered, `test/github.test.ts`'s live
test stays skipped and says so in its skip message, and `test/run.test.ts` drives the
whole path against a bare repository on disk with a recording `fetch`. The code is
asserted; the integration is not.
