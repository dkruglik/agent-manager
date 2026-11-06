#!/bin/sh
set -eu

# Provision agent CLIs for a non-Docker Agent Manager.
#
# Selection, first match (see scripts/cli-allowlist.sh):
#   1. Ids on the command line, which replace the allowlist for this run
#      (`./scripts/install-local-clis.sh claude cursor`).
#   2. AM_INSTALL_CLIS, when set and not empty (`claude,cursor`).
#   3. am-install-clis at the repo root, when it lists any ids. Override the
#      path with AM_INSTALL_CLIS_FILE.
#   4. Otherwise claude, codex, gemini, opencode and openclaw.
#
# Claude and Codex are required when selected: a failed install stops the run.
# Every other CLI is best-effort, as in the image. An allowlist that omits
# Claude or Codex skips them instead of failing. Cursor, Hermes, fx and
# Antigravity (`agy`) are the same installs the Dockerfile runs; they are not
# in the historical default, so name them to opt in. Their prebuilt binaries
# are linux/x64. Cursor takes the newest build cursor.com/install names. A
# failed lookup or download does not fail this run; a tarball that does not
# unpack or run does.
#
# `./scripts/install-local-clis.sh --plan` prints the selection and installs
# nothing. The image's selection is `sh scripts/cli-allowlist.sh plan docker`.

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
# shellcheck source=cli-allowlist.sh
. "$root/scripts/cli-allowlist.sh"

plan=0
if [ "${1:-}" = "--plan" ]; then
  plan=1
  shift
fi

# Command-line ids are a one-off allowlist. They win over the env and the file.
if [ "$#" -gt 0 ]; then
  AM_INSTALL_CLIS="$*"
fi

am_cli_allowlist_load "${AM_INSTALL_CLIS_FILE:-$root/am-install-clis}"

if [ "$plan" -eq 1 ]; then
  am_cli_plan local
  exit 0
fi

prefix="${NPM_CONFIG_PREFIX:-$HOME/.local}"
export NPM_CONFIG_PREFIX="$prefix"
export PATH="$prefix/bin:$PATH"
export AM_CLI_BINDIR="$prefix/bin"
export AM_CURSOR_DEST="$prefix/cursor-agent"
export AM_CLI_DOCDIR="$prefix/share/doc"
mkdir -p "$prefix/bin"

linux_x64() {
  am_os=$(uname -s)
  am_arch=$(uname -m)
  [ "$am_os" = Linux ] && { [ "$am_arch" = x86_64 ] || [ "$am_arch" = amd64 ]; }
}

skipped=''
omitted=''

install_one() {
  cli=$1
  echo "Installing $cli ..."
  case "$cli" in
    claude|codex|gemini|opencode|openclaw)
      package=$(am_cli_npm_spec "$cli")
      binary=$(am_cli_binary "$cli")
      if npm install -g --no-audit --no-fund "$package" && command -v "$binary" >/dev/null 2>&1; then
        echo "Installed $binary: $($binary --version 2>/dev/null | head -n 1)"
        return 0
      fi
      if am_cli_is_required "$cli"; then
        echo "$cli did not install, and Agent Manager needs it" >&2
        return 1
      fi
      echo "$cli did not install — Agent Manager will show it as unavailable" >&2
      skipped="$skipped $cli"
      return 0
      ;;
    cursor|fx|antigravity)
      if ! linux_x64; then
        echo "$cli did not install — its prebuilt binary is linux/x64 only ($(uname -s)/$(uname -m))" >&2
        skipped="$skipped $cli"
        return 0
      fi
      am_rc=0
      case "$cli" in
        cursor) am_install_cursor || am_rc=$? ;;
        fx) am_install_fx || am_rc=$? ;;
        antigravity) am_install_agy || am_rc=$? ;;
      esac
      if [ "$am_rc" -ne 0 ]; then
        return "$am_rc"
      fi
      binary=$(am_cli_binary "$cli")
      if command -v "$binary" >/dev/null 2>&1; then
        echo "Installed $binary: $($binary --version 2>/dev/null | head -n 1)"
        return 0
      fi
      echo "$cli did not install — Agent Manager will show it as unavailable" >&2
      skipped="$skipped $cli"
      return 0
      ;;
    hermes)
      am_install_hermes
      am_link_hermes
      if command -v hermes >/dev/null 2>&1; then
        echo "Installed hermes: $(hermes --version 2>/dev/null | head -n 1)"
        return 0
      fi
      echo "hermes did not install — Agent Manager will show it as unavailable" >&2
      skipped="$skipped hermes"
      return 0
      ;;
  esac
}

for cli in $(am_cli_ids); do
  in_default=0
  if am_cli_local_default "$cli"; then in_default=1; fi
  if am_cli_install "$cli" "$in_default"; then
    install_one "$cli" || exit $?
  elif [ "$AM_CLI_ALLOWLIST_MODE" = explicit ]; then
    omitted="$omitted $cli"
  fi
done

echo "Agent CLIs are installed in $prefix/bin."
if [ -n "$omitted" ]; then
  echo "Skipped (not on the install allowlist):$omitted"
fi
if [ -n "$skipped" ]; then
  echo "Not installed:$skipped. Re-run with that name to see the failure in full."
fi
