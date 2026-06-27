#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$ROOT_DIR"

APPROVAL_URL_REGEX='https://www\.npmjs\.com/auth/cli/[A-Za-z0-9._~:/?#\[\]@!$&()*+,;=%-]+'

CHECKS_PASSED=()
LIVE_VERSION=""
LOCAL_VERSION=""
RELEASE_VERSION=""
PUBLISH_SUCCEEDED="no"
TAG_CREATED="no"

log() {
  printf '[release] %s\n' "$*"
}

die() {
  printf '[release] Error: %s\n' "$*" >&2
  exit 1
}

print_clickable_link() {
  local label=$1
  local url=$2

  if [[ -t 1 ]]; then
    printf '[release] %s: \033]8;;%s\a%s\033]8;;\a\n' "$label" "$url" "$label"
    printf '[release] Approval URL: %s\n' "$url"
  else
    printf '[release] %s: %s\n' "$label" "$url"
  fi
}

extract_approval_url() {
  local line=${1//$'\r'/}

  if [[ $line =~ $APPROVAL_URL_REGEX ]]; then
    printf '%s\n' "${BASH_REMATCH[0]}"
    return 0
  fi

  return 1
}

append_check() {
  CHECKS_PASSED+=("$1")
}

join_checks() {
  local joined=""
  local item

  for item in "${CHECKS_PASSED[@]}"; do
    if [[ -n $joined ]]; then
      joined+=", "
    fi
    joined+="$item"
  done

  printf '%s' "$joined"
}

print_summary() {
  local exit_code=$1
  local checks_summary="none"

  set +e

  if ((${#CHECKS_PASSED[@]} > 0)); then
    checks_summary=$(join_checks)
  fi

  printf '\n[release] Summary\n'
  if [[ -n $RELEASE_VERSION ]]; then
    printf '[release] Version: %s\n' "$RELEASE_VERSION"
  else
    printf '[release] Version: not bumped\n'
  fi
  printf '[release] Publish succeeded: %s\n' "$PUBLISH_SUCCEEDED"
  printf '[release] Git tag created: %s\n' "$TAG_CREATED"
  printf '[release] Checks passed: %s\n' "$checks_summary"

  if [[ $exit_code -ne 0 ]]; then
    printf '[release] Exit code: %s\n' "$exit_code" >&2
  fi
}

trap 'print_summary "$?"' EXIT

run_streamed_pty_command() {
  local approval_label=$1
  local command_string=$2
  local command_status

  command -v script >/dev/null 2>&1 || die "The 'script' command is required for interactive npm steps."

  set +e
  script -qefc "$command_string" /dev/null 2>&1 | {
    declare -A seen_urls=()
    line=""
    url=""

    while IFS= read -r line; do
      printf '%s\n' "$line"

      if url=$(extract_approval_url "$line"); then
        if [[ -z ${seen_urls["$url"]+x} ]]; then
          seen_urls["$url"]=1
          print_clickable_link "$approval_label" "$url"
        fi
      fi
    done
  }
  command_status=${PIPESTATUS[0]}
  set -e

  return "$command_status"
}

assert_simple_semver() {
  local version=$1

  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Expected a simple x.y.z version, got '$version'."
}

ensure_npm_auth() {
  local whoami_output=""
  local whoami_status=0

  log "Checking npm auth with npm whoami"

  set +e
  whoami_output=$(npm whoami 2>&1)
  whoami_status=$?
  set -e

  if [[ $whoami_status -eq 0 ]]; then
    printf '%s\n' "$whoami_output"
    return 0
  fi

  printf '%s\n' "$whoami_output" >&2

  if grep -q '401' <<<"$whoami_output"; then
    log "npm auth is missing, starting npm login"
    run_streamed_pty_command "Approve npm login" "env BROWSER=true npm login"
    log "Re-checking npm auth after login"
    npm whoami >/dev/null
    return 0
  fi

  die "npm whoami failed before release verification."
}

load_versions() {
  log "Checking live npm version"
  LIVE_VERSION=$(npm view letmecode version | tr -d '\r\n')
  [[ -n $LIVE_VERSION ]] || die "npm view letmecode version returned an empty result."
  assert_simple_semver "$LIVE_VERSION"

  log "Reading local package version"
  LOCAL_VERSION=$(node -p "require('./package.json').version")
  [[ -n $LOCAL_VERSION ]] || die "package.json version is empty."
  assert_simple_semver "$LOCAL_VERSION"

  log "Live version: $LIVE_VERSION"
  log "Local version: $LOCAL_VERSION"
}

compute_release_version() {
  local highest_version
  local major
  local minor
  local patch

  highest_version=$(printf '%s\n%s\n' "$LIVE_VERSION" "$LOCAL_VERSION" | sort -V | tail -n 1)
  IFS=. read -r major minor patch <<<"$highest_version"
  RELEASE_VERSION="$major.$minor.$((patch + 1))"

  [[ $RELEASE_VERSION != "$LOCAL_VERSION" ]] || die "Refusing to publish the current version unchanged."

  log "Next release version: $RELEASE_VERSION"
}

run_verification_checks() {
  log "Running pnpm test"
  pnpm test
  append_check "pnpm test"

  log "Running npm pack --dry-run"
  npm pack --dry-run
  append_check "npm pack --dry-run"

  log "Running pnpm start smoke test"
  ROOT_DIR_FOR_SMOKE="$ROOT_DIR" python3 - <<'PY'
import errno
import fcntl
import os
import pty
import select
import subprocess
import sys
import termios
import time

root_dir = os.environ["ROOT_DIR_FOR_SMOKE"]
ready_token = "LetMeCode Usage Dashboard"
deadline = time.time() + 180

master_fd, slave_fd = pty.openpty()

if sys.stdout.isatty():
    try:
        winsize = fcntl.ioctl(sys.stdout.fileno(), termios.TIOCGWINSZ, b"\0" * 8)
        fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, winsize)
    except OSError:
        pass

process = subprocess.Popen(
    ["pnpm", "start"],
    cwd=root_dir,
    stdin=slave_fd,
    stdout=slave_fd,
    stderr=slave_fd,
    env=os.environ.copy(),
    close_fds=True,
)
os.close(slave_fd)

seen_output = ""
sent_quit = False

try:
    while True:
        if process.poll() is not None:
            break

        if time.time() > deadline:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            print("\n[release] Smoke test timed out before the dashboard appeared.", file=sys.stderr)
            sys.exit(1)

        ready, _, _ = select.select([master_fd], [], [], 0.1)
        if master_fd not in ready:
            continue

        try:
            chunk = os.read(master_fd, 4096)
        except OSError as exc:
            if exc.errno == errno.EIO:
                break
            raise

        if not chunk:
            break

        os.write(sys.stdout.fileno(), chunk)
        seen_output = (seen_output + chunk.decode("utf-8", "ignore"))[-200000:]

        if not sent_quit and ready_token in seen_output:
            os.write(master_fd, b"q")
            sent_quit = True

    while True:
        try:
            chunk = os.read(master_fd, 4096)
        except OSError as exc:
            if exc.errno == errno.EIO:
                break
            raise

        if not chunk:
            break

        os.write(sys.stdout.fileno(), chunk)
finally:
    os.close(master_fd)

exit_code = process.wait()

if not sent_quit:
    print("\n[release] Smoke test exited before the dashboard was detected.", file=sys.stderr)
    sys.exit(1)

sys.exit(exit_code)
PY
  append_check "pnpm start"
}

bump_package_version() {
  log "Bumping package.json to $RELEASE_VERSION"

  TARGET_VERSION="$RELEASE_VERSION" node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const packageJsonPath = path.join(process.cwd(), "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

if (!packageJson.bin || packageJson.bin.letmecode !== "./bin/letmecode.js") {
  throw new Error('Expected packageJson.bin.letmecode to remain "./bin/letmecode.js".');
}

packageJson.version = process.env.TARGET_VERSION;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
NODE
}

commit_version_bump() {
  log "Committing version bump"
  git commit -am "Bump version to $RELEASE_VERSION"
}

publish_release() {
  log "Publishing letmecode@$RELEASE_VERSION"
  run_streamed_pty_command "Approve npm publish" "env BROWSER=true npm publish"
  PUBLISH_SUCCEEDED="yes"
}

create_release_tag() {
  log "Creating git tag v$RELEASE_VERSION"
  git tag "v$RELEASE_VERSION"
  TAG_CREATED="yes"
}

main() {
  ensure_npm_auth
  load_versions
  compute_release_version
  run_verification_checks
  bump_package_version
  commit_version_bump
  publish_release
  create_release_tag
}

main "$@"
