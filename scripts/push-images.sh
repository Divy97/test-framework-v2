#!/bin/sh
# Both sandbox images to Vercel Container Registry, pinned by digest (M10, 10e).
#
# The worker names images the PLATFORM pulls, so the local tags `npm run images` builds
# mean nothing to it. This publishes them and prints the two `ENGINE_*` references to set
# on the worker.
#
# Pinned by digest, never by tag. A tag is a name somebody can move, and milestone 9's
# first real delivery died against an image two weeks stale under a name that looked
# current. `--platform linux/amd64` because a Firecracker sandbox is x86 whatever this
# laptop is.
#
# Needs `vercel login` and `vercel link` (the spike's script documents the account-token
# alternative). After a push VCR reports the image as preparing for a while, and
# `Sandbox.create` answers `image_not_ready` until it is.
set -eu
cd "$(dirname "$0")/.."
sha=$(git rev-parse --short HEAD)

if [ -n "$(git status --porcelain -- src prompts Dockerfile Dockerfile.agent)" ]; then
  # The tag is the commit, so an image built from a dirty tree carries a name that lies
  # about what is in it — exactly the staleness the digest pinning exists to prevent.
  echo "refusing: src/, prompts/ or a Dockerfile is dirty, and the image would be tagged $sha regardless" >&2
  exit 1
fi

vercel vcr login docker >/dev/null
for pair in "sandbox:Dockerfile:ENGINE_IMAGE" "agent:Dockerfile.agent:ENGINE_AGENT_IMAGE"; do
  name=${pair%%:*}; rest=${pair#*:}; file=${rest%%:*}; var=${rest#*:}
  start=$(date +%s)
  vercel vcr build docker . "test-framework-v2-$name:$sha" --push --platform linux/amd64 -- -f "$file" >/dev/null
  end=$(date +%s)

  # Colour codes stripped and fields taken by LABEL, not by column. The spike's version
  # matched on leading whitespace and silently produced `unknown` when the CLI's output
  # gained escapes — a push that looked like it worked and yielded no reference.
  info=$(vercel vcr tag inspect "test-framework-v2-$name" "$sha" 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
  image=$(printf '%s\n' "$info" | awk '$1 == "Image" { print $2 }')
  digest=$(printf '%s\n' "$info" | awk '$1 == "Digest" { print $2 }')
  if [ -z "$image" ] || [ -z "$digest" ]; then
    echo "pushed $name in $((end - start))s but could not read its reference back:" >&2
    printf '%s\n' "$info" >&2
    exit 1
  fi
  echo "$name: pushed in $((end - start))s"
  echo "  $var=${image%%:*}@$digest"
done
