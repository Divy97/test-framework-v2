# The sandbox. Deliberately small: git, node, and a shell are the entire
# contract the verification engine needs.
#
# There is no docker client here, and that is a decision rather than an
# omission — see docs/milestone-3.md. A repo whose own setup needs Docker is
# refused rather than granted a path back out to the host daemon.
FROM node:22-alpine

RUN apk add --no-cache git

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# The Runner is PID 1 (ADR-0006): it supervises everything and is the only thing
# that speaks on the channel out.
ENTRYPOINT ["npx", "tsx", "src/runner.ts"]
