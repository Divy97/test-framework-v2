#!/bin/sh
# Item 13. Both images to Vercel Container Registry: time and size.
#
# From https://vercel.com/docs/container-registry: the host is `vcr.vercel.com`, the Docker
# username is the TEAM ID and the password is a Vercel account token, and a reference is
# `vcr.vercel.com/<team-slug>/<project-name>/<repository>:<tag>`. The tag is the git sha,
# never `latest` — milestone 9's first real delivery died against an image two weeks stale.
# `--platform linux/amd64` because a Firecracker sandbox is x86 whatever this laptop is.
set -eu
: "${VERCEL_TOKEN:?set VERCEL_TOKEN (an account token from vercel.com/account/tokens)}"
: "${VERCEL_TEAM_ID:?set VERCEL_TEAM_ID (the Docker username VCR expects)}"
: "${VERCEL_TEAM_SLUG:?set VERCEL_TEAM_SLUG (the slug in your dashboard URL)}"
: "${VERCEL_PROJECT_NAME:?set VERCEL_PROJECT_NAME (the project the repositories belong to)}"
cd "$(dirname "$0")/../.."
sha=$(git rev-parse --short HEAD)
printf '%s' "$VERCEL_TOKEN" | docker login vcr.vercel.com --username "$VERCEL_TEAM_ID" --password-stdin >/dev/null
for pair in "sandbox:Dockerfile" "agent:Dockerfile.agent"; do
  name=${pair%%:*}; file=${pair#*:}
  ref="vcr.vercel.com/$VERCEL_TEAM_SLUG/$VERCEL_PROJECT_NAME/test-framework-v2-$name:$sha"
  start=$(date +%s)
  # Buildx with zstd is what the docs recommend; it builds and pushes in one step.
  docker buildx build --platform linux/amd64 -f "$file" \
    --output "type=image,name=$ref,push=true,oci-mediatypes=true,compression=zstd,compression-level=3,force-compression=true" \
    . >/dev/null
  end=$(date +%s)
  digest=$(docker buildx imagetools inspect "$ref" --format '{{json .Manifest.Digest}}' 2>/dev/null | tr -d '"')
  echo "INFO  13  $name: $ref  digest ${digest:-unknown}  build+push $((end - start))s"
  echo "INFO  13  ENGINE_VERCEL_$(echo "$name" | tr a-z A-Z | sed 's/SANDBOX//')IMAGE=$ref"
done
echo "PASS  13  pushed both; set ENGINE_VERCEL_IMAGE / ENGINE_VERCEL_AGENT_IMAGE to the refs above (the @sha256 digest form is the honest one)"
