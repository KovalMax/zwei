#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
workflow="$root/.github/workflows/release.yml"

# Resolve the tag once; verification, publish, and deploy must all use that commit.
grep -q '^  release:$' "$workflow"
grep -q '^  resolve-source:$' "$workflow"
grep -Fq 'ref: ${{ github.event.release.tag_name }}' "$workflow"
grep -Fq 'commit=$(git rev-parse HEAD)' "$workflow"
grep -Fq 'source_ref: ${{ needs.resolve-source.outputs.commit }}' "$workflow"
grep -q 'workflow_call:' "$root/.github/workflows/ci.yml"
grep -q 'workflow_call:' "$root/.github/workflows/security.yml"
grep -Fq 'ref: ${{ inputs.source_ref || github.sha }}' "$root/.github/workflows/ci.yml"
grep -Fq 'ref: ${{ inputs.source_ref || github.sha }}' "$root/.github/workflows/security.yml"
grep -Fq 'uses: ./.github/workflows/ci.yml' "$workflow"
grep -Fq 'uses: ./.github/workflows/security.yml' "$workflow"
grep -Fq 'needs: [resolve-source, verify-ci, verify-security]' "$workflow"
grep -Fq 'needs: [resolve-source, publish]' "$workflow"
grep -q '^  publish:$' "$workflow"
grep -q '^  deploy:$' "$workflow"
grep -Fq 'IMAGE_TAG: sha-${{ needs.resolve-source.outputs.commit }}' "$workflow"
grep -Fq 'type=raw,value=sha-${{ needs.resolve-source.outputs.commit }}' "$workflow"
grep -q 'environment: production' "$workflow"
grep -q 'rsync --archive --compress --delete' "$workflow"
grep -q 'StrictHostKeyChecking=yes' "$workflow"
grep -q 'sh ./release-deploy.sh' "$workflow"
grep -Fq 'sh infrastructure/scripts/validate-deploy-path.sh "$DEPLOY_PATH"' "$workflow"
grep -Fq 'realpath -m --' "$workflow"
! grep -Eqi 'curl|public endpoint|security header' "$workflow"
if sed '/^  publish:/,$d' "$workflow" | grep -q 'packages: write'; then
  echo 'package-write permission must be limited to image publishing' >&2
  exit 1
fi
sed -n '/^  publish:/,/^  deploy:/p' "$workflow" | grep -q 'packages: write'
test ! -e "$root/infrastructure/production/deploy-cutover.sh"
test ! -e "$root/infrastructure/production/docker-compose.private.yml"
! grep -Eq '/home/[^ ]+/(zwei|zwei-secrets)' "$root/infrastructure/production/.env.example"
for valid_path in /opt/zwei /opt/zwei/live-1 /opt/zwei/initial_1.0; do
  sh "$root/infrastructure/scripts/validate-deploy-path.sh" "$valid_path"
done
for invalid_path in '' relative / /home/deploy /opt/zwei/.. /opt/zwei/live/../other /opt/zwei/live/ '/opt/zwei/with space'; do
  if sh "$root/infrastructure/scripts/validate-deploy-path.sh" "$invalid_path" >/dev/null 2>&1; then
    echo "unsafe deployment path accepted: $invalid_path" >&2
    exit 1
  fi
done
grep -Fq 'docker run --rm --network none' "$root/infrastructure/production/release-deploy.sh"
! grep -q 'docker compose run .*traefik' "$root/infrastructure/production/release-deploy.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir "$tmp/bin" "$tmp/deploy"
printf 'KYC_BASIC_AUTH_FILE=%s\nSECRET_VALUE=fixture-secret-never-print\n' "$tmp/htpasswd" > "$tmp/deploy/.env"
printf 'fixture\n' > "$tmp/htpasswd"
cat > "$tmp/bin/docker" <<'MOCK'
#!/bin/sh
printf '%s\n' "$*" >> "$CALLS"
if [ -n "$FAIL_POINT" ]; then
  case "$*" in *"$FAIL_POINT"*) exit 1 ;; esac
fi
case "$*" in
  *"ps -q --status running"*) [ "${RUNNING:-no}" = no ] || echo still-running ;;
esac
MOCK
chmod +x "$tmp/bin/docker"
export PATH="$tmp/bin:$PATH" CALLS="$tmp/calls" FAIL_POINT= RUNNING=no
cd "$tmp/deploy"
KYC_BASIC_AUTH_FILE="$tmp/htpasswd"
export KYC_BASIC_AUTH_FILE

sh "$root/infrastructure/production/release-deploy.sh" > "$tmp/output" 2>&1
awk '/--profile migration pull$/ { pull=NR } /run --rm --network none/ { credential=NR } / stop traefik coturn$/ { edge=NR } / stop frontend auth chat realtime$/ { apps=NR } / ps -q --status running/ { stopped=NR } / run --rm --no-deps migrate$/ { migration=NR } / up .* frontend auth chat realtime$/ { start=NR } / up .* coturn traefik$/ { public=NR } END { exit !(pull && pull < credential && credential < edge && edge < apps && apps < stopped && stopped < migration && migration < start && start < public) }' "$CALLS"

for point in 'migration pull' 'run --rm --network none'; do
  : > "$CALLS"
  FAIL_POINT=$point
  export FAIL_POINT
  if sh "$root/infrastructure/production/release-deploy.sh" > "$tmp/output" 2>&1; then
    echo "preflight failure accepted: $point" >&2
    exit 1
  fi
  ! grep -Eq ' stop | run .* migrate' "$CALLS"
done

for point in 'stop frontend auth chat realtime' 'ps -q --status running' 'run --rm --no-deps migrate' 'frontend auth chat realtime' 'coturn traefik'; do
  : > "$CALLS"
  FAIL_POINT=$point
  export FAIL_POINT
  if sh "$root/infrastructure/production/release-deploy.sh" > "$tmp/output" 2>&1; then
    echo "deployment failure accepted: $point" >&2
    exit 1
  fi
  tail -1 "$CALLS" | grep -q ' stop traefik coturn$'
done

FAIL_POINT=
RUNNING=yes
export FAIL_POINT RUNNING
: > "$CALLS"
if sh "$root/infrastructure/production/release-deploy.sh" > "$tmp/output" 2>&1; then
  echo 'running old services accepted' >&2
  exit 1
fi
! grep -q ' run .* migrate' "$CALLS"
tail -1 "$CALLS" | grep -q ' stop traefik coturn$'
! grep -q 'fixture-secret-never-print' "$tmp/output" "$CALLS"
echo 'release deployment checks passed'
