#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
writer="$root/infrastructure/scripts/write-release-image-manifest.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
artifacts="$tmp/artifacts"
manifest="$tmp/.deploy.env"
mkdir -p "$artifacts"

for image in auth chat realtime frontend migrator; do
  mkdir "$artifacts/release-image-digest-$image"
  printf 'sha256:%064d\n' "${#image}" > "$artifacts/release-image-digest-$image/digest.txt"
done

REPOSITORY_OWNER=KovalMax sh "$writer" "$artifacts" "$manifest"
for image in auth chat realtime frontend migrator; do
  upper=$(printf '%s' "$image" | tr '[:lower:]' '[:upper:]')
  printf 'IMAGE_%s=ghcr.io/kovalmax/zwei-%s@sha256:%064d\n' "$upper" "$image" "${#image}" |
    grep -Fx -f - "$manifest" >/dev/null
done
test "$(wc -l < "$manifest" | tr -d ' ')" -eq 5

cp "$manifest" "$tmp/expected.env"
rm "$artifacts/release-image-digest-migrator/digest.txt"
if REPOSITORY_OWNER=KovalMax sh "$writer" "$artifacts" "$manifest" >/dev/null 2>&1; then
  echo 'missing image digest was accepted' >&2
  exit 1
fi
cmp "$manifest" "$tmp/expected.env"

printf 'not-a-digest\n' > "$artifacts/release-image-digest-migrator/digest.txt"
if REPOSITORY_OWNER=KovalMax sh "$writer" "$artifacts" "$manifest" >/dev/null 2>&1; then
  echo 'malformed image digest was accepted' >&2
  exit 1
fi
cmp "$manifest" "$tmp/expected.env"

printf 'sha256:%064d\n%s\n' 1 "touch $tmp/injected" > "$artifacts/release-image-digest-migrator/digest.txt"
if REPOSITORY_OWNER=KovalMax sh "$writer" "$artifacts" "$manifest" >/dev/null 2>&1; then
  echo 'digest with a trailing shell command was accepted' >&2
  exit 1
fi
cmp "$manifest" "$tmp/expected.env"
test ! -e "$tmp/injected"

printf 'sha256:%064d\000' 1 > "$artifacts/release-image-digest-migrator/digest.txt"
if REPOSITORY_OWNER=KovalMax sh "$writer" "$artifacts" "$manifest" >/dev/null 2>&1; then
  echo 'digest with a trailing NUL byte was accepted' >&2
  exit 1
fi
cmp "$manifest" "$tmp/expected.env"

printf 'sha256:%064d\n' 1 > "$artifacts/release-image-digest-migrator/digest.txt"
touch "$artifacts/release-image-digest-migrator/.unexpected"
if REPOSITORY_OWNER=KovalMax sh "$writer" "$artifacts" "$manifest" >/dev/null 2>&1; then
  echo 'hidden file inside image digest artifact was accepted' >&2
  exit 1
fi
cmp "$manifest" "$tmp/expected.env"
rm "$artifacts/release-image-digest-migrator/.unexpected"

touch "$artifacts/unexpected"
if REPOSITORY_OWNER=KovalMax sh "$writer" "$artifacts" "$manifest" >/dev/null 2>&1; then
  echo 'unexpected image artifact was accepted' >&2
  exit 1
fi
cmp "$manifest" "$tmp/expected.env"

rm -f "$artifacts/unexpected"
ln -s "$tmp/missing" "$artifacts/unexpected-link"
if REPOSITORY_OWNER=KovalMax sh "$writer" "$artifacts" "$manifest" >/dev/null 2>&1; then
  echo 'dangling unexpected image artifact symlink was accepted' >&2
  exit 1
fi
cmp "$manifest" "$tmp/expected.env"
rm "$artifacts/unexpected-link"

if REPOSITORY_OWNER='bad owner' sh "$writer" "$artifacts" "$manifest" >/dev/null 2>&1; then
  echo 'invalid registry owner was accepted' >&2
  exit 1
fi
cmp "$manifest" "$tmp/expected.env"

echo 'release image manifest checks passed'
