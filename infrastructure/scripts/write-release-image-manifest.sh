#!/bin/sh
set -eu
LC_ALL=C
export LC_ALL

if [ "$#" -ne 2 ]; then
  echo 'Usage: write-release-image-manifest.sh <downloaded-artifacts> <output-file>' >&2
  exit 2
fi

artifact_root=$1
output_file=$2
: "${REPOSITORY_OWNER:?REPOSITORY_OWNER is required}"

owner=$(printf '%s' "$REPOSITORY_OWNER" | tr '[:upper:]' '[:lower:]')
case "$owner" in
  ''|[!a-z0-9]*|*[!a-z0-9._-]*)
    echo 'Invalid GitHub registry owner.' >&2
    exit 1
    ;;
esac

if [ ! -d "$artifact_root" ] || [ -L "$artifact_root" ]; then
  echo 'Release image digest artifacts are missing.' >&2
  exit 1
fi

images='auth chat realtime frontend migrator'
expected_count=0
for entry in "$artifact_root"/*; do
  if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then
    continue
  fi
  case "$(basename "$entry")" in
    release-image-digest-auth|release-image-digest-chat|release-image-digest-realtime|release-image-digest-frontend|release-image-digest-migrator)
      [ -d "$entry" ] && [ ! -L "$entry" ] || {
        echo 'Unexpected release image digest artifact layout.' >&2
        exit 1
      }
      expected_count=$((expected_count + 1))
      ;;
    *)
      echo 'Unexpected release image digest artifact.' >&2
      exit 1
      ;;
  esac
done
for entry in "$artifact_root"/.[!.]* "$artifact_root"/..?*; do
  if [ -e "$entry" ] || [ -L "$entry" ]; then
    echo 'Unexpected hidden release image digest artifact.' >&2
    exit 1
  fi
done
if [ "$expected_count" -ne 5 ]; then
  echo 'Release image digest set is incomplete.' >&2
  exit 1
fi

output_dir=$(dirname "$output_file")
if [ ! -d "$output_dir" ]; then
  echo 'Release image manifest output directory is missing.' >&2
  exit 1
fi
umask 077
temporary_file=$(mktemp "$output_dir/.release-image-manifest.XXXXXX")
trap 'rm -f "$temporary_file"' EXIT HUP INT TERM

for image in $images; do
  artifact="$artifact_root/release-image-digest-$image"
  for hidden_entry in "$artifact"/.[!.]* "$artifact"/..?*; do
    if [ -e "$hidden_entry" ] || [ -L "$hidden_entry" ]; then
      echo 'Release image digest artifact has an invalid file set.' >&2
      exit 1
    fi
  done
  set -- "$artifact"/*
  if [ "$#" -ne 1 ] || [ "$1" != "$artifact/digest.txt" ] || [ ! -f "$1" ] || [ -L "$1" ]; then
    echo 'Release image digest artifact has an invalid file set.' >&2
    exit 1
  fi
  digest_size=$(wc -c < "$1" | tr -d '[:space:]')
  digest=$(cat "$1")
  if { [ "$digest_size" -ne 71 ] && [ "$digest_size" -ne 72 ]; } ||
    [ "${#digest}" -ne 71 ] ||
    ! printf '%s\n' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
    echo "Release image digest is malformed for $image." >&2
    exit 1
  fi
  artifact_digest_hex=$(od -An -v -tx1 "$1" | tr -d '[:space:]')
  expected_digest_hex=$(printf '%s' "$digest" | od -An -v -tx1 | tr -d '[:space:]')
  if [ "$digest_size" -eq 72 ]; then
    expected_digest_hex="${expected_digest_hex}0a"
  fi
  if [ "$artifact_digest_hex" != "$expected_digest_hex" ]; then
    echo "Release image digest contains unexpected bytes for $image." >&2
    exit 1
  fi
  upper=$(printf '%s' "$image" | tr '[:lower:]' '[:upper:]')
  printf 'IMAGE_%s=ghcr.io/%s/zwei-%s@%s\n' "$upper" "$owner" "$image" "$digest" >> "$temporary_file"
done

mv -f "$temporary_file" "$output_file"
trap - EXIT HUP INT TERM
echo 'Validated all five release image digests.'
