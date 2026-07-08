#!/bin/bash
# Claude Code integration installer for Backlog.md Hub.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
TARGET_DIR="${CLAUDE_HOME:-$HOME/.claude}"
HOOKS_DIR="$TARGET_DIR/hooks"
SCRIPTS_DIR="$TARGET_DIR/scripts"
LOG_DIR="$HOME/Library/Logs/backlog-md"

info() {
  printf '[INFO] %s\n' "$*"
}

die() {
  printf '[ERROR] %s\n' "$*" >&2
  exit 1
}

copy_script() {
  local src="$1"
  local dest="$2"

  [[ -f "$src" ]] || die "missing source: $src"
  mkdir -p "$(dirname "$dest")"

  if [[ -f "$dest" && ! -L "$dest" ]] && cmp -s "$src" "$dest"; then
    if [[ -x "$src" ]]; then
      chmod 755 "$dest"
    else
      chmod 644 "$dest"
    fi
    info "unchanged $(basename "$dest")"
    return 0
  fi

  if [[ -L "$dest" ]]; then
    rm "$dest"
  fi
  cp "$src" "$dest"
  if [[ -x "$src" ]]; then
    chmod 755 "$dest"
  else
    chmod 644 "$dest"
  fi
  info "installed $(basename "$dest")"
}

main() {
  local stale_port_allocator
  stale_port_allocator="backlog-port""-alloc.sh"

  mkdir -p "$HOOKS_DIR" "$SCRIPTS_DIR" "$LOG_DIR"

  copy_script "$SCRIPT_DIR/sessionstart-backlog-browser.sh" \
    "$HOOKS_DIR/sessionstart-backlog-browser.sh"
  copy_script "$SCRIPT_DIR/backlog-browser-lib.sh" \
    "$SCRIPTS_DIR/backlog-browser-lib.sh"

  # Hub server は repo 直参照に移行したためコピー配布しない。
  for stale in \
    "$SCRIPTS_DIR/sessionstart-backlog-browser.sh" \
    "$SCRIPTS_DIR/backlog-browsers-ensure.sh" \
    "$SCRIPTS_DIR/$stale_port_allocator"; do
    if [[ -e "$stale" ]]; then
      rm -f "$stale"
      info "removed obsolete $(basename "$stale")"
    fi
  done

  info "logs dir: $LOG_DIR"
  info "LaunchAgent 登録は bin/install-backlog-launchd.sh を実行してください"
}

main "$@"
