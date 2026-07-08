#!/bin/bash
# Backlog.md Hub の LaunchAgent を配置・切替するユーザー実行 installer。

set -euo pipefail

OLD_LABEL_HUB="com.u-kt.backlog-hub"
OLD_LABEL_BROWSERS="com.u-kt.backlog-browsers"
NEW_LABEL_HUB="com.github.u-ichi.backlog-md-hub"
HUB_PORT="${BACKLOG_HUB_PORT:-6419}"
HUB_HOST="${BACKLOG_HUB_HOST:-127.0.0.1}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
TEMPLATE_PATH="$REPO_ROOT/launchd/$NEW_LABEL_HUB.plist.template"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/backlog-md"
NEW_PLIST="$LAUNCH_AGENTS_DIR/$NEW_LABEL_HUB.plist"
OLD_HUB_PLIST="$LAUNCH_AGENTS_DIR/$OLD_LABEL_HUB.plist"
OLD_BROWSERS_PLIST="$LAUNCH_AGENTS_DIR/$OLD_LABEL_BROWSERS.plist"
OLD_HUB_SCRIPT="$HOME/.claude/scripts/backlog-hub-server.js"
OLD_CONFIG_PATH="$HOME/.claude/backlog-hub-config.json"
XDG_CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}"
XDG_CONFIG_PATH="$XDG_CONFIG_ROOT/backlog-md-hub/config.json"

NODE_BIN=""
BACKLOG_CLI_BIN=""

info() {
  printf '[INFO] %s\n' "$*"
}

warn() {
  printf '[WARN] %s\n' "$*" >&2
}

die() {
  printf '[ERROR] %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage:
  bin/install-backlog-launchd.sh
  bin/install-backlog-launchd.sh --preflight-only
  bin/install-backlog-launchd.sh --uninstall
USAGE
}

service_target() {
  local label="$1"
  printf 'gui/%s/%s' "$(id -u)" "$label"
}

resolve_node() {
  if [[ "${BACKLOG_HUB_TEST_NO_NODE:-0}" == "1" ]]; then
    return 1
  fi
  if NODE_BIN="$(command -v node 2>/dev/null)"; then
    return 0
  fi
  if [[ -x "/opt/homebrew/bin/node" ]]; then
    NODE_BIN="/opt/homebrew/bin/node"
    return 0
  fi
  return 1
}

resolve_backlog_cli() {
  if [[ -n "${BACKLOG_HUB_CLI_PATH:-}" ]]; then
    [[ -x "$BACKLOG_HUB_CLI_PATH" ]] || return 1
    BACKLOG_CLI_BIN="$BACKLOG_HUB_CLI_PATH"
    return 0
  fi
  if [[ "${BACKLOG_HUB_TEST_NO_BACKLOG:-0}" == "1" ]]; then
    return 1
  fi
  if BACKLOG_CLI_BIN="$(command -v backlog 2>/dev/null)"; then
    return 0
  fi
  if [[ -x "/opt/homebrew/bin/backlog" ]]; then
    BACKLOG_CLI_BIN="/opt/homebrew/bin/backlog"
    return 0
  fi
  return 1
}

migrate_old_config() {
  if [[ -f "$XDG_CONFIG_PATH" ]]; then
    info "config exists; skip migration: $XDG_CONFIG_PATH"
    return 0
  fi
  if [[ ! -f "$OLD_CONFIG_PATH" ]]; then
    return 0
  fi
  mkdir -p "$(dirname "$XDG_CONFIG_PATH")"
  cp "$OLD_CONFIG_PATH" "$XDG_CONFIG_PATH"
  chmod 644 "$XDG_CONFIG_PATH"
  info "migrated config: $OLD_CONFIG_PATH -> $XDG_CONFIG_PATH"
}

validate_xdg_config() {
  [[ -f "$XDG_CONFIG_PATH" ]] || die "config が見つかりません: $XDG_CONFIG_PATH"
  # shellcheck disable=SC2016
  "$NODE_BIN" -e '
const fs = require("fs");
const file = process.argv[1];
let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (error) {
  console.error(`invalid JSON: ${file}: ${error.message}`);
  process.exit(1);
}
if (!parsed || !Array.isArray(parsed.sources)) {
  console.error(`top-level sources must be an array: ${file}`);
  process.exit(1);
}
' "$XDG_CONFIG_PATH" || die "config schema validation failed: $XDG_CONFIG_PATH"
  info "config OK: $XDG_CONFIG_PATH"
}

preflight() {
  resolve_node || die "node が見つかりません (PATH または /opt/homebrew/bin を確認してください)"
  info "node: $NODE_BIN"

  resolve_backlog_cli || die "backlog CLI が見つかりません (BACKLOG_HUB_CLI_PATH または PATH を確認してください)"
  info "backlog CLI: $BACKLOG_CLI_BIN"

  migrate_old_config
  validate_xdg_config

  [[ -f "$TEMPLATE_PATH" ]] || die "launchd template が見つかりません: $TEMPLATE_PATH"
  plutil -lint "$TEMPLATE_PATH" >/dev/null
}

sed_escape() {
  printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

render_plist() {
  local output="$1"
  local home_sed repo_sed host_sed
  home_sed="$(sed_escape "$HOME")"
  repo_sed="$(sed_escape "$REPO_ROOT")"
  host_sed="$(sed_escape "$HUB_HOST")"
  sed \
    -e "s|@@HOME@@|$home_sed|g" \
    -e "s|@@REPO_ROOT@@|$repo_sed|g" \
    -e "s|@@HUB_HOST@@|$host_sed|g" \
    "$TEMPLATE_PATH" > "$output"
}

write_legacy_hub_plist() {
  mkdir -p "$LAUNCH_AGENTS_DIR"
  cat > "$OLD_HUB_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$OLD_LABEL_HUB</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>exec node "$OLD_HUB_SCRIPT"</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>BACKLOG_HUB_MANAGE_BROWSERS</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/backlog-md/hub.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/backlog-md/hub.log</string>
</dict>
</plist>
EOF
  chmod 644 "$OLD_HUB_PLIST"
  info "restored legacy plist: $OLD_HUB_PLIST"
}

bootout_label() {
  local label="$1"
  launchctl bootout "$(service_target "$label")" >/dev/null 2>&1 || true
}

bootstrap_label() {
  local label="$1"
  local plist="$2"
  bootout_label "$label"
  launchctl bootstrap "gui/$(id -u)" "$plist"
  launchctl enable "$(service_target "$label")"
}

service_state() {
  local label="$1"
  launchctl print "$(service_target "$label")" 2>/dev/null | awk '/state =/ {print $3; exit}'
}

print_status() {
  local label="$1"
  info "launchctl print $(service_target "$label")"
  launchctl print "$(service_target "$label")" 2>/dev/null | sed -n '1,80p' || true
}

healthz_ok() {
  [[ "$(curl -fsS "http://127.0.0.1:$HUB_PORT/healthz" 2>/dev/null || true)" == "ok" ]]
}

wait_for_healthz() {
  local url="http://127.0.0.1:$HUB_PORT/healthz"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if healthz_ok; then
      info "hub healthz OK: $url"
      return 0
    fi
    sleep 1
  done
  return 1
}

repo_count() {
  local json
  json="$(curl -fsS "http://127.0.0.1:$HUB_PORT/api/tasks" 2>/dev/null || true)"
  [[ -n "$json" ]] || return 1
  # shellcheck disable=SC2016
  printf '%s' "$json" | "$NODE_BIN" -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(input);
    const count = parsed && Array.isArray(parsed.repos) ? parsed.repos.length : -1;
    if (count < 0) process.exit(1);
    console.log(count);
  } catch (_error) {
    process.exit(1);
  }
});
'
}

verify_new_gate() {
  local state count
  state="$(service_state "$NEW_LABEL_HUB")"
  [[ "$state" == "running" ]] || {
    warn "new label state is not running: ${state:-missing}"
    return 1
  }
  wait_for_healthz || {
    warn "new label healthz failed"
    return 1
  }
  count="$(repo_count || true)"
  if [[ ! "$count" =~ ^[0-9]+$ || "$count" -lt 1 ]]; then
    warn "new label /api/tasks repo count is invalid: ${count:-empty}"
    return 1
  fi
  info "hub repo count: $count"
  return 0
}

rollback_and_fail() {
  local reason="$1"
  warn "rollback start: $reason"
  bootout_label "$NEW_LABEL_HUB"
  rm -f "$NEW_PLIST"

  if [[ ! -f "$OLD_HUB_PLIST" ]]; then
    write_legacy_hub_plist
  fi
  if [[ ! -f "$OLD_HUB_SCRIPT" ]]; then
    warn "legacy hub script is missing; rollback bootstrap may fail: $OLD_HUB_SCRIPT"
  fi
  if [[ -f "$OLD_HUB_PLIST" && -f "$OLD_HUB_SCRIPT" ]]; then
    if bootstrap_label "$OLD_LABEL_HUB" "$OLD_HUB_PLIST"; then
      if wait_for_healthz; then
        info "rollback healthz OK"
      else
        warn "rollback healthz failed"
      fi
      print_status "$OLD_LABEL_HUB"
    else
      warn "legacy label bootstrap failed"
    fi
  fi
  die "$reason"
}

install_new_plist() {
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/backlog-md-hub.XXXXXX.plist")"
  render_plist "$tmp"
  plutil -lint "$tmp" >/dev/null
  mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR"
  if [[ ! -f "$NEW_PLIST" ]] || ! cmp -s "$tmp" "$NEW_PLIST"; then
    cp "$tmp" "$NEW_PLIST"
    chmod 644 "$NEW_PLIST"
    info "installed $(basename "$NEW_PLIST")"
  else
    info "unchanged $(basename "$NEW_PLIST")"
  fi
  rm -f "$tmp"
}

cleanup_legacy_after_gate() {
  bootout_label "$OLD_LABEL_HUB"
  bootout_label "$OLD_LABEL_BROWSERS"
  rm -f "$OLD_HUB_PLIST" "$OLD_BROWSERS_PLIST" "$OLD_HUB_SCRIPT"
  info "removed legacy launchd files and hub script"
}

install_agents() {
  local old_state
  preflight
  old_state="$(service_state "$OLD_LABEL_HUB")"
  if [[ -n "$old_state" ]]; then
    info "legacy label state before switch: $old_state"
  else
    info "legacy label is not loaded before switch"
  fi

  if [[ "$old_state" == "running" ]]; then
    bootout_label "$OLD_LABEL_HUB"
    info "booted out legacy label: $OLD_LABEL_HUB"
  fi

  install_new_plist
  if ! bootstrap_label "$NEW_LABEL_HUB" "$NEW_PLIST"; then
    rollback_and_fail "new label bootstrap failed"
  fi

  if ! verify_new_gate; then
    rollback_and_fail "new label verification gate failed"
  fi

  cleanup_legacy_after_gate
  print_status "$NEW_LABEL_HUB"
}

uninstall_agents() {
  bootout_label "$NEW_LABEL_HUB"
  rm -f "$NEW_PLIST"
  info "backlog.md hub launchd agent uninstalled: $NEW_LABEL_HUB"
}

main() {
  case "${1:-}" in
    "")
      install_agents
      ;;
    "--preflight-only")
      preflight
      ;;
    "--uninstall")
      uninstall_agents
      ;;
    "-h"|"--help")
      usage
      ;;
    *)
      usage
      exit 2
      ;;
  esac
}

main "$@"
