#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)

for compose in \
  "$root/infrastructure/docker-compose.yml" \
  "$root/infrastructure/docker-compose.e2e-turn.yml" \
  "$root/infrastructure/production/docker-compose.yml"; do
  grep -Fxq '      - --no-stun' "$compose"
  grep -Fxq '      - --unauthorized-ratelimit' "$compose"
  grep -Fxq '      - --unauthorized-ratelimit-rps=100' "$compose"
  grep -Fxq '      - --use-auth-secret' "$compose"
  if grep -Eq '^[[:space:]]+- --(no-)?cli([[:space:]]|=|$)' "$compose"; then
    echo "Coturn CLI flags must remain absent for the pinned image: $compose" >&2
    exit 1
  fi
done

production="$root/infrastructure/production/docker-compose.yml"
for image in AUTH CHAT REALTIME FRONTEND MIGRATOR; do
  grep -Fq "image: \${IMAGE_$image:?IMAGE_$image is required}" "$production"
done
if grep -q 'IMAGE_TAG\|IMAGE_REPOSITORY' "$production"; then
  echo 'Production Compose must not deploy mutable image tags.' >&2
  exit 1
fi

echo 'Coturn and production image-reference configuration checks passed'
