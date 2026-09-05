#!/bin/sh
# Item 13. Both images to Vercel Container Registry: time and size.
#
# Two ways in, and the first needs nothing in `.env`: with the Vercel CLI logged in and this
# directory linked (`vercel login`, `vercel link`), `vercel vcr login docker` mints a
# short-lived OIDC credential and `vercel vcr build docker . <repo>:<tag> --push` fills in
# the registry host, team slug and project. Without the CLI, an account token: the host is
# `vcr.vercel.com`, the Docker username is the TEAM ID, the password the token, and the
# reference is `vcr.vercel.com/<team-slug>/<project-name>/<repository>:<tag>`
# (https://vercel.com/docs/container-registry).
#
# The tag is the git sha, never `latest` — milestone 9's first real delivery died against
# an image two weeks stale. `--platform linux/amd64` because a Firecracker sandbox is x86
# whatever this laptop is. After a push VCR reports the image as preparing for a while, and
# `Sandbox.create` answers `image_not_ready` until it is — so item 6 waits.
set -eu
cd "$(dirname "$0")/../.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
sha=$(git rev-parse --short HEAD)

if command -v vercel >/dev/null 2>&1 && [ -f .vercel/project.json ]; then
  echo "INFO  13  using the Vercel CLI session and the linked project"
  vercel vcr login docker >/dev/null
  for pair in "sandbox:Dockerfile:ENGINE_VERCEL_IMAGE" "agent:Dockerfile.agent:ENGINE_VERCEL_AGENT_IMAGE"; do
    name=$(echo "$pair" | cut -d: -f1); file=$(echo "$pair" | cut -d: -f2); var=$(echo "$pair" | cut -d: -f3)
    start=$(date +%s)
    # The CLI names the image for the linked project; `-- -f` hands the Dockerfile to docker.
    vercel vcr build docker . "test-framework-v2-$name:$sha" --push --platform linux/amd64 -- -f "$file" >/dev/null
    end=$(date +%s)
    ref=$(vercel vcr tag inspect "test-framework-v2-$name" "$sha" 2>/dev/null | grep -o 'vcr.vercel.com/[^[:space:]]*' | head -1)
    echo "INFO  13  $name: ${ref:-vcr.vercel.com/<team-slug>/<project>/test-framework-v2-$name:$sha}  build+push $((end - start))s"
    echo "INFO  13  $var=${ref:-<see vercel vcr tag inspect test-framework-v2-$name $sha>}"
  done
else
  : "${VERCEL_TOKEN:?no CLI session: set VERCEL_TOKEN (vercel.com/account/tokens), or install the CLI and run vercel login && vercel link}"
  : "${VERCEL_TEAM_ID:?set VERCEL_TEAM_ID (the Docker username VCR expects)}"
  : "${VERCEL_TEAM_SLUG:?set VERCEL_TEAM_SLUG (the slug in your dashboard URL)}"
  : "${VERCEL_PROJECT_NAME:?set VERCEL_PROJECT_NAME (the project the repositories belong to)}"
  printf '%s' "$VERCEL_TOKEN" | docker login vcr.vercel.com --username "$VERCEL_TEAM_ID" --password-stdin >/dev/null
  for pair in "sandbox:Dockerfile:ENGINE_VERCEL_IMAGE" "agent:Dockerfile.agent:ENGINE_VERCEL_AGENT_IMAGE"; do
    name=$(echo "$pair" | cut -d: -f1); file=$(echo "$pair" | cut -d: -f2); var=$(echo "$pair" | cut -d: -f3)
    ref="vcr.vercel.com/$VERCEL_TEAM_SLUG/$VERCEL_PROJECT_NAME/test-framework-v2-$name:$sha"
    start=$(date +%s)
    docker buildx build --platform linux/amd64 -f "$file" \
      --output "type=image,name=$ref,push=true,oci-mediatypes=true,compression=zstd,compression-level=3,force-compression=true" \
      . >/dev/null
    end=$(date +%s)
    digest=$(docker buildx imagetools inspect "$ref" --format '{{json .Manifest.Digest}}' 2>/dev/null | tr -d '"')
    echo "INFO  13  $name: $ref  digest ${digest:-unknown}  build+push $((end - start))s"
    echo "INFO  13  $var=$ref"
  done
fi
echo "PASS  13  pushed both; set the two variables above in .env (the @sha256 digest form is the honest one), wait for VCR to finish preparing, then run item 6"
