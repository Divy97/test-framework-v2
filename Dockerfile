# The sandbox. Deliberately small: git, node, and a shell are the entire
# contract the verification engine needs.
#
# There is no docker client here, and that is a decision rather than an
# omission — see docs/milestone-3.md. A repo whose own setup needs Docker is
# refused rather than granted a path back out to the host daemon.
FROM node:22-alpine

RUN apk add --no-cache git

# The repro executes as uid 1000 — the `node` user this image already ships. The
# Runner stays root so it can still clone and scrub; only the untrusted command
# drops privileges, which is what puts /proc/1/fd out of its reach.

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# node itself is PID 1, not a wrapper. `npx tsx` would fork node as a child, and
# then /proc/1/fd/1 — the container's real stdout — belongs to npx, so the
# Runner closing its own fd 1 would leave the event channel wide open to
# anything the repro cares to write. Being PID 1 is load-bearing here, not
# ceremony (ADR-0006).
ENTRYPOINT ["node", "--import", "tsx", "src/runner.ts"]
