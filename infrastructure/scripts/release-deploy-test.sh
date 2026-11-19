#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
workflow="$root/.github/workflows/release.yml"
ci="$root/.github/workflows/ci.yml"
security="$root/.github/workflows/security.yml"

grep -A2 '^  release:$' "$workflow" | grep -Fq 'types: [published]'
grep -Fq 'ref: ${{ github.event.release.tag_name }}' "$workflow"
grep -Fq 'commit=$(git rev-parse HEAD)' "$workflow"
grep -Fq 'source_ref: ${{ needs.resolve-source.outputs.commit }}' "$workflow"
test "$(grep -Fc 'source_ref: ${{ needs.resolve-source.outputs.commit }}' "$workflow")" -eq 2
grep -Fq 'uses: ./.github/workflows/ci.yml' "$workflow"
grep -Fq 'uses: ./.github/workflows/security.yml' "$workflow"
grep -Fq 'needs: [resolve-source, verify-ci, verify-security]' "$workflow"
grep -Fq 'needs: [resolve-source, publish]' "$workflow"
grep -Fq 'release_validation: true' "$workflow"
grep -Fq 'type=raw,value=${{ github.event.release.tag_name }}' "$workflow"
grep -Fq 'type=raw,value=sha-${{ needs.resolve-source.outputs.commit }}' "$workflow"
grep -q '^  publish:$' "$workflow"
test "$(grep -c '^[[:space:]]*-[[:space:]]*image: ' "$workflow")" -eq 5
grep -Fq 'uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0' "$workflow"
grep -Fq 'id: image' "$workflow"
grep -Fq 'IMAGE_DIGEST: ${{ steps.image.outputs.digest }}' "$workflow"
grep -Fq 'name: release-image-digest-${{ matrix.image }}' "$workflow"
grep -Fq 'uses: actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131 # v7.0.0' "$workflow"
grep -Fq 'sh infrastructure/scripts/write-release-image-manifest.sh' "$workflow"
grep -Fq 'infrastructure/production/ "release-host:$DEPLOY_PATH/"' "$workflow"
! grep -q 'IMAGE_TAG' "$workflow"

grep -q '^  workflow_call:' "$ci"
grep -Fq 'ref: ${{ inputs.source_ref || github.sha }}' "$ci"
grep -Fq 'release_validation: true' "$workflow"
test "$(grep -Fc 'if: inputs.release_validation != true' "$ci")" -eq 3
grep -Fq 'run: go test -race ./services/...' "$ci"
grep -Fq 'run: npm test -- --coverage' "$ci"
grep -Fq 'run: npm run build -- --configuration production' "$ci"
grep -Fq 'name: Release and security contract tests' "$ci"
grep -Fq 'sh infrastructure/scripts/release-deploy-test.sh' "$ci"
grep -Fq 'sh infrastructure/scripts/release-image-manifest-test.sh' "$ci"
grep -Fq 'sh infrastructure/scripts/coturn-config-test.sh' "$ci"

grep -q '^  workflow_call:' "$security"
grep -Fq 'ref: ${{ inputs.source_ref || github.sha }}' "$security"
grep -Fq 'run: GOTOOLCHAIN=go1.27.4 go run golang.org/x/vuln/cmd/govulncheck@v1.10.0 ./services/...' "$security"
grep -Fq 'run: npm audit --audit-level=high' "$security"
grep -Fq 'directory: [frontend-app, e2e, .opencode]' "$security"

unpinned_actions=$(
  grep -hE '^[[:space:]]*uses: [A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@' "$root"/.github/workflows/*.yml |
    grep -Ev '^[[:space:]]*uses: [A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[0-9a-f]{40} # v[0-9]' || true
)
if [ -n "$unpinned_actions" ]; then
  echo "External Actions must use reviewed full-SHA pins with version comments:" >&2
  echo "$unpinned_actions" >&2
  exit 1
fi

deploy_section=$(sed -n '/^  deploy:/,$p' "$workflow")
test "$(printf '%s\n' "$deploy_section" | grep -Fc 'DEPLOY_SSH_PRIVATE_KEY: ${{ secrets.DEPLOY_SSH_PRIVATE_KEY }}')" -eq 1
! printf '%s\n' "$deploy_section" | sed -n '/^    steps:/,/^      - name: Deploy verified image digests/p' | grep -q 'secrets\.'
printf '%s\n' "$deploy_section" | grep -Fq 'persist-credentials: false'
printf '%s\n' "$deploy_section" | grep -Fq 'StrictHostKeyChecking yes'
printf '%s\n' "$deploy_section" | grep -Fq 'trap cleanup EXIT'
printf '%s\n' "$deploy_section" | grep -Fq 'trap on_signal HUP INT TERM'
printf '%s\n' "$deploy_section" | grep -Fq 'rm -rf "$ssh_dir"'
printf '%s\n' "$deploy_section" | grep -Fq 'if ! ssh -F "$ssh_dir/config" release-host'
grep -Fq 'environment: production' "$workflow"
grep -Fq 'group: production-deploy' "$workflow"
grep -Fq 'rsync --archive --compress --delete' "$workflow"
grep -Fq 'sh infrastructure/scripts/validate-deploy-path.sh "$DEPLOY_PATH"' "$workflow"
grep -Fq 'realpath -m --' "$workflow"
! grep -Eqi 'curl|public endpoint|security header' "$workflow"
if sed '/^  publish:/,/^  deploy:/d' "$workflow" | grep -q 'packages: write'; then
  echo 'package-write permission must be limited to image publishing' >&2
  exit 1
fi
sed -n '/^  publish:/,/^  deploy:/p' "$workflow" | grep -q 'packages: write'
test ! -e "$root/infrastructure/production/deploy-cutover.sh"
test ! -e "$root/infrastructure/production/docker-compose.private.yml"
! grep -Eq '/home/[^ ]+/(zwei|zwei-secrets)' "$root/infrastructure/production/.env.example"

for valid_path in /opt/zwei /opt/zwei/live-1 /opt/zwei/initial_1.0 /srv/apps/zwei /var/lib/zwei/releases/release_1.0; do
  sh "$root/infrastructure/scripts/validate-deploy-path.sh" "$valid_path"
done
for invalid_path in '' relative / /home/deploy/../other /srv/apps/zwei/.. /srv/apps/zwei/releases/../other /srv/apps/zwei/ '/srv/apps/zwei/with space' '/srv/apps/zwei/$unsafe'; do
  if sh "$root/infrastructure/scripts/validate-deploy-path.sh" "$invalid_path" >/dev/null 2>&1; then
    echo "unsafe deployment path accepted: $invalid_path" >&2
    exit 1
  fi
done

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir "$tmp/bin" "$tmp/deploy"
printf 'SECRET_VALUE=fixture-secret-never-print\n' > "$tmp/deploy/.env"
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

sh "$root/infrastructure/production/release-deploy.sh" > "$tmp/output" 2>&1
awk '/--profile migration pull$/ { pull=NR } / stop frontend auth chat realtime$/ { stop=NR } /ps -q --status running/ { running=NR } / up .* database redis$/ { database=NR } / run --rm --no-deps migrate$/ { migration=NR } / up .* frontend auth chat realtime$/ { start=NR } / up .* coturn$/ { turn=NR } END { exit !(pull && pull < stop && stop < running && running < database && database < migration && migration < start && start < turn) }' "$CALLS"

: > "$CALLS"
FAIL_POINT='migration pull'
export FAIL_POINT
if sh "$root/infrastructure/production/release-deploy.sh" > "$tmp/output" 2>&1; then
  echo 'image-pull failure was accepted' >&2
  exit 1
fi
! grep -q ' stop frontend auth chat realtime$' "$CALLS"

for point in \
  'stop frontend auth chat realtime' \
  'ps -q --status running' \
  'up -d --wait --wait-timeout 120 database redis' \
  'run --rm --no-deps migrate' \
  'up -d --no-deps --force-recreate --wait --wait-timeout 120 frontend auth chat realtime' \
  'up -d --no-deps --wait --wait-timeout 120 coturn'; do
  : > "$CALLS"
  FAIL_POINT=$point
  export FAIL_POINT
  if sh "$root/infrastructure/production/release-deploy.sh" > "$tmp/output" 2>&1; then
    echo "deployment failure accepted: $point" >&2
    exit 1
  fi
  tail -1 "$CALLS" | grep -q ' stop frontend auth chat realtime$'
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
tail -1 "$CALLS" | grep -q ' stop frontend auth chat realtime$'
! grep -q 'fixture-secret-never-print' "$tmp/output" "$CALLS"
echo 'release deployment checks passed'
