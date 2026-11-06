#!/bin/sh
# Which agent CLIs to install, shared by scripts/install-local-clis.sh and the
# Dockerfile. Source this file; do not copy the parser. Running it directly
# prints a plan and installs nothing:
#
#   sh scripts/cli-allowlist.sh plan local
#   sh scripts/cli-allowlist.sh plan docker
#
# Selection, in order:
#   1. AM_INSTALL_CLIS, when it is set and not only whitespace. Commas and
#      whitespace both separate ids (`claude,cursor` or `claude cursor`).
#   2. The file passed to am_cli_allowlist_load (the repo's am-install-clis,
#      unless AM_INSTALL_CLIS_FILE points somewhere else). Blank lines and
#      `#` comments are ignored. An empty or missing file is not a list.
#   3. Otherwise the caller's historical default. For the local script that is
#      claude, codex, gemini, opencode and openclaw. For the image it is those
#      five plus cursor, hermes, fx and antigravity.
#
# Ids are the catalog ids from server/src/config.js. `agy` is antigravity and
# `cursor-agent` is cursor. Anything else is an error, so a typo fails the
# run instead of quietly dropping a CLI. Claude and Codex are required when
# they are selected; every other CLI is best-effort. Omitting a required CLI
# skips it. It does not fail the run.
#
# ccusage, uv, hf, gh and Chromium are not agent CLIs and are not on this list.

set -eu

# Catalog order is the install order. am_cli_ids prints it space-separated.
am_cli_ids() {
  printf '%s\n' 'claude codex gemini opencode openclaw cursor hermes fx antigravity'
}

am_cli_canon() {
  case "$1" in
    claude|codex|gemini|opencode|openclaw|cursor|hermes|fx|antigravity)
      printf '%s\n' "$1" ;;
    agy) printf '%s\n' antigravity ;;
    cursor-agent) printf '%s\n' cursor ;;
    *) return 1 ;;
  esac
}

# npm package, including the @latest the image uses so a no-cache rebuild
# picks up a new publish. Empty (and failure) for CLIs that are not npm.
am_cli_npm_spec() {
  case "$1" in
    claude) printf '%s\n' '@anthropic-ai/claude-code@latest' ;;
    codex) printf '%s\n' '@openai/codex@latest' ;;
    gemini) printf '%s\n' '@google/gemini-cli@latest' ;;
    opencode) printf '%s\n' 'opencode-ai@latest' ;;
    openclaw) printf '%s\n' 'openclaw@latest' ;;
    *) return 1 ;;
  esac
}

am_cli_binary() {
  case "$1" in
    claude) printf '%s\n' claude ;;
    codex) printf '%s\n' codex ;;
    gemini) printf '%s\n' gemini ;;
    opencode) printf '%s\n' opencode ;;
    openclaw) printf '%s\n' openclaw ;;
    cursor) printf '%s\n' cursor-agent ;;
    hermes) printf '%s\n' hermes ;;
    fx) printf '%s\n' fx ;;
    antigravity) printf '%s\n' agy ;;
    *) return 1 ;;
  esac
}

# Required when selected: a failed install stops the local run and fails the
# image build. Every other id is best-effort, matching the Dockerfile.
am_cli_is_required() {
  case "$1" in
    claude|codex) return 0 ;;
    *) return 1 ;;
  esac
}

# What `./scripts/install-local-clis.sh` with no args and no allowlist installs.
# Cursor, Hermes, fx and Antigravity are opt-in here: they are not npm packages,
# and the no-argument run stayed the five npm CLIs.
am_cli_local_default() {
  case "$1" in
    claude|codex|gemini|opencode|openclaw) return 0 ;;
    *) return 1 ;;
  esac
}

# Read the allowlist into AM_CLI_ALLOWLIST (space-separated canonical ids) and
# AM_CLI_ALLOWLIST_MODE (`default` or `explicit`). $1 is the optional file.
am_cli_allowlist_load() {
  am_file=${1:-}
  AM_CLI_ALLOWLIST=''
  AM_CLI_ALLOWLIST_MODE=default
  am_text=''
  if [ -n "$(printf '%s' "${AM_INSTALL_CLIS:-}" | tr -d '[:space:]')" ]; then
    am_text=$AM_INSTALL_CLIS
  elif [ -n "$am_file" ] && [ -f "$am_file" ]; then
    # Strip comments before splitting, so an id mentioned in a comment is not
    # an entry and a trailing `# note` does not become part of the id.
    am_text=$(sed 's/#.*//' "$am_file")
  fi
  am_text=$(printf '%s' "$am_text" | tr -d '\r' | tr ',' ' ')
  am_ids=''
  am_set_f=0
  case $- in
    *f*) ;;
    *) set -f; am_set_f=1 ;;
  esac
  for am_tok in $am_text; do
    [ -n "$am_tok" ] || continue
    if ! am_canon=$(am_cli_canon "$am_tok"); then
      if [ "$am_set_f" -eq 1 ]; then set +f; fi
      echo "unknown CLI '$am_tok' (expected: $(am_cli_ids); aliases: agy, cursor-agent)" >&2
      return 2
    fi
    case " $am_ids " in
      *" $am_canon "*) ;;
      *) am_ids="${am_ids:+$am_ids }$am_canon" ;;
    esac
  done
  if [ "$am_set_f" -eq 1 ]; then set +f; fi
  if [ -n "$am_ids" ]; then
    AM_CLI_ALLOWLIST=$am_ids
    AM_CLI_ALLOWLIST_MODE=explicit
  fi
  return 0
}

# 0 when this id should be installed. $2 is 1 when the caller installs it by
# default (the image installs cursor by default; the local script does not).
am_cli_install() {
  am_id=$1
  am_in_default=$2
  if [ "${AM_CLI_ALLOWLIST_MODE:-default}" = explicit ]; then
    case " $AM_CLI_ALLOWLIST " in
      *" $am_id "*) return 0 ;;
      *) return 1 ;;
    esac
  fi
  [ "$am_in_default" -eq 1 ]
}

# One line per catalog id: `<id> install|skip required|optional`.
# $1 is `local` or `docker`.
am_cli_plan() {
  am_profile=${1:-local}
  case "$am_profile" in
    local|docker) ;;
    *)
      echo "unknown plan profile '$am_profile' (expected: local docker)" >&2
      return 2
      ;;
  esac
  for am_id in $(am_cli_ids); do
    am_def=0
    if [ "$am_profile" = docker ]; then
      am_def=1
    elif am_cli_local_default "$am_id"; then
      am_def=1
    fi
    am_action=skip
    if am_cli_install "$am_id" "$am_def"; then am_action=install; fi
    am_need=optional
    if am_cli_is_required "$am_id"; then am_need=required; fi
    printf '%s %s %s\n' "$am_id" "$am_action" "$am_need"
  done
}

am_cli_docdir() {
  if [ -n "${AM_CLI_DOCDIR:-}" ]; then
    printf '%s\n' "$AM_CLI_DOCDIR"
    return 0
  fi
  am_bindir=${AM_CLI_BINDIR:-/usr/local/bin}
  printf '%s\n' "$(dirname "$am_bindir")/share/doc"
}

# Cursor CLI (`cursor-agent`, also linked as `agent`). A pinned tarball, not
# npm. Cursor publishes no checksum, so CURSOR_SHA256 pins the bytes downloaded
# on 2026-11-03. A mismatch fails the install (and therefore the image build):
# a tarball that is not the one we pinned must not be unpacked. A failed
# download does not: one vendor CDN being down must not fail the build, and a
# missing binary is already reported as unavailable. A tarball that matches
# but does not unpack, link or run `--version` fails too. To upgrade, read the
# version and URL from cursor.com/install (a plain shell script), download the
# tarball once, measure it with sha256sum, and bump the three defaults below.
# Overrides: CURSOR_VERSION, CURSOR_URL, CURSOR_SHA256, AM_CURSOR_DEST,
# AM_CLI_BINDIR, AM_CLI_TMP.
am_install_cursor() {
  version=${CURSOR_VERSION:-2026.10.22-27dcf5f}
  url=${CURSOR_URL:-https://downloads.cursor.com/lab/2026.10.22-27dcf5f/linux/x64/agent-cli-package.tar.gz}
  sha=${CURSOR_SHA256:-85296944e4600a83c4b764f578d1502bf9c416db200d33a593e8f3ecabfdc294}
  dest=${AM_CURSOR_DEST:-/opt/cursor-agent}
  bindir=${AM_CLI_BINDIR:-/usr/local/bin}
  tmp=${AM_CLI_TMP:-${TMPDIR:-/tmp}}
  tarball=$tmp/cursor-agent.tar.gz
  home=$tmp/cursor-home
  mkdir -p "$tmp" "$bindir"
  if ! curl -fsSL "$url" -o "$tarball"; then
    echo "cursor-agent install failed"
    rm -f "$tarball"
    return 0
  fi
  if ! echo "$sha  $tarball" | sha256sum -c -; then
    echo "ERROR: cursor-agent $version does not match the pinned SHA-256; refusing to install it" >&2
    rm -f "$tarball"
    return 1
  fi
  if ! mkdir -p "$dest/$version" "$home" \
    || ! tar -xzf "$tarball" -C "$dest/$version" --strip-components=1 \
    || ! ln -sf "$dest/$version/cursor-agent" "$bindir/cursor-agent" \
    || ! ln -sf "$dest/$version/cursor-agent" "$bindir/agent" \
    || ! HOME="$home" "$bindir/cursor-agent" --version; then
    echo "ERROR: cursor-agent $version matched its SHA-256 but did not install or run; failing the build" >&2
    rm -rf "$tarball" "$home"
    return 1
  fi
  rm -rf "$tarball" "$home"
  return 0
}

# fx (Vercel Labs) is one static binary. The pinned tarball, not the vendor
# setup.sh, so the image does not follow whatever latest.txt says on build
# day. Apache-2.0 notices are installed beside it. Best-effort: a CDN failure
# prints a line and returns 0.
am_install_fx() {
  bindir=${AM_CLI_BINDIR:-/usr/local/bin}
  tmp=${AM_CLI_TMP:-${TMPDIR:-/tmp}}
  url=${FX_URL:-https://releases.fx.sh/v0.0.5/fx-linux-x86_64.tar.gz}
  doc="$(am_cli_docdir)/fx"
  mkdir -p "$tmp" "$bindir"
  if curl -fsSL "$url" -o "$tmp/fx.tar.gz" \
    && tar -xzf "$tmp/fx.tar.gz" -C "$tmp" fx LICENSE THIRD_PARTY_NOTICES.md \
    && install -D -m 0755 "$tmp/fx" "$bindir/fx" \
    && install -D -m 0644 -t "$doc" "$tmp/LICENSE" "$tmp/THIRD_PARTY_NOTICES.md" \
    && "$bindir/fx" --version; then
    rm -f "$tmp/fx.tar.gz" "$tmp/fx" "$tmp/LICENSE" "$tmp/THIRD_PARTY_NOTICES.md"
    return 0
  fi
  echo "fx install failed"
  rm -f "$tmp/fx.tar.gz" "$tmp/fx" "$tmp/LICENSE" "$tmp/THIRD_PARTY_NOTICES.md"
  return 0
}

# Antigravity CLI (`agy`). Pinned build plus the SHA-512 from Google's
# installer manifest, not install.sh (that resolves the newest build and then
# edits shell rc files). A checksum or CDN failure is best-effort, unlike
# Cursor, because this pin is the vendor's own and a bad download should not
# take the Space down. To upgrade, bump AGY_URL and AGY_SHA512 from
# .../manifests/linux_amd64.json.
am_install_agy() {
  bindir=${AM_CLI_BINDIR:-/usr/local/bin}
  tmp=${AM_CLI_TMP:-${TMPDIR:-/tmp}}
  url=${AGY_URL:-https://storage.googleapis.com/antigravity-public/antigravity-cli/1.4.10-5501573669978112/linux-x64/cli_linux_x64.tar.gz}
  sha=${AGY_SHA512:-3a14c21697e86349ce8402e0b1889cbd1d3a5f4e2cb4dc43aae1c48c404240c2ccff9f775eec277e1f759234a33ec026645c63ed22ab6f6ebede561eda7c38b6}
  mkdir -p "$tmp" "$bindir" "$tmp/agy-home"
  if curl -fsSL "$url" -o "$tmp/agy.tar.gz" \
    && echo "$sha  $tmp/agy.tar.gz" | sha512sum -c - \
    && tar -xzf "$tmp/agy.tar.gz" -C "$tmp" antigravity \
    && install -D -m 0755 "$tmp/antigravity" "$bindir/agy" \
    && HOME="$tmp/agy-home" "$bindir/agy" --version; then
    rm -rf "$tmp/agy.tar.gz" "$tmp/antigravity" "$tmp/agy-home"
    return 0
  fi
  echo "agy install failed"
  rm -rf "$tmp/agy.tar.gz" "$tmp/antigravity" "$tmp/agy-home"
  return 0
}

# Hermes (Nous Research). The vendor script installs into the current user's
# ~/.local; am_link_hermes then exposes that shim on the shared bin dir. The
# whole step is best-effort and bounded so a hung installer cannot hold the
# image build. AM_HERMES_BIN overrides the shim path the linker looks for.
am_install_hermes() {
  tmp=${AM_CLI_TMP:-${TMPDIR:-/tmp}}
  url=${HERMES_INSTALL_URL:-https://hermes-agent.nousresearch.com/install.sh}
  mkdir -p "$tmp"
  am_ok=0
  if curl -fsSL "$url" -o "$tmp/h.sh"; then
    if command -v timeout >/dev/null 2>&1; then
      if timeout 180 bash "$tmp/h.sh" </dev/null; then am_ok=1; fi
    else
      if bash "$tmp/h.sh" </dev/null; then am_ok=1; fi
    fi
  fi
  rm -f "$tmp/h.sh"
  if [ "$am_ok" -eq 1 ]; then
    return 0
  fi
  echo "hermes not installed — will show as unavailable"
  return 0
}

am_link_hermes() {
  bindir=${AM_CLI_BINDIR:-/usr/local/bin}
  src=${AM_HERMES_BIN:-${HOME:-/home/node}/.local/bin/hermes}
  dest=$bindir/hermes
  if [ ! -x "$src" ] || [ "$src" = "$dest" ]; then
    return 0
  fi
  mkdir -p "$bindir"
  ln -sf "$src" "$dest"
}

# Executed directly: print a plan. Sourced: the functions above are the API,
# and this return hands control back to the Dockerfile RUN or the installer.
case "${0##*/}" in
  cli-allowlist.sh)
    am_cmd=${1:-}
    if [ "$#" -gt 0 ]; then shift; fi
    case "$am_cmd" in
      plan)
        am_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
        am_file=${AM_INSTALL_CLIS_FILE:-$am_root/am-install-clis}
        am_cli_allowlist_load "$am_file"
        am_cli_plan "${1:-local}"
        ;;
      *)
        echo "usage: cli-allowlist.sh plan local|docker" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    return 0 2>/dev/null || exit 0
    ;;
esac
