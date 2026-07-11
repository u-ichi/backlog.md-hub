#!/bin/bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
INSTALLER="$ROOT/bin/install-backlog-launchd.sh"
TEMPLATE="$ROOT/launchd/com.github.u-ichi.backlog-md-hub.plist.template"

fail() {
  printf 'not ok - %s\n' "$*" >&2
  exit 1
}

make_home() {
  local home
  home="$(mktemp -d "${TMPDIR:-/tmp}/backlog-md-hub-installer-test.XXXXXX")"
  mkdir -p "$home/Library/LaunchAgents"
  printf '%s' "$home"
}

write_existing_plist() {
  local home="$1"
  local value="$2"
  sed \
    -e "s|@@HOME@@|$home|g" \
    -e "s|@@REPO_ROOT@@|$ROOT|g" \
    -e 's|@@HUB_HOST@@|127.0.0.1|g' \
    -e "s|@@TAILSCALE_LISTEN@@|$value|g" \
    "$TEMPLATE" > "$home/Library/LaunchAgents/com.github.u-ichi.backlog-md-hub.plist"
}

resolve_value() {
  local home="$1"
  shift
  # shellcheck disable=SC2016
  "$@" HOME="$home" bash -c '
    source "$1"
    resolve_tailscale_listen >/dev/null
    printf "%s" "$HUB_TAILSCALE_LISTEN"
  ' _ "$INSTALLER"
}

bash -c '
  source "$1"
  launchctl() { return 113; }
  state="$(service_state "missing-label")"
  [[ -z "$state" ]]
  printf "continued"
' _ "$INSTALLER" | grep -q '^continued$' || fail "missing launchd service must be an empty successful state under set -e"

bash -c '
  source "$1"
  launchctl() { return 42; }
  if service_state "unexpected-failure" >/dev/null; then
    exit 1
  else
    status=$?
  fi
  [[ "$status" == "42" ]]
' _ "$INSTALLER" || fail "unexpected launchctl failure must not be hidden"

wait_state="$(mktemp "${TMPDIR:-/tmp}/backlog-md-hub-launchd-wait.XXXXXX")"
printf '0\n' > "$wait_state"
bash -c '
  source "$1"
  wait_state="$2"
  LAUNCHD_UNLOAD_WAIT_INTERVAL_SECONDS=0
  launchctl() {
    if [[ "$1" == "bootout" ]]; then return 0; fi
    count="$(cat "$wait_state")"
    count=$((count + 1))
    printf "%s\n" "$count" > "$wait_state"
    if [[ "$count" -lt 3 ]]; then
      printf "state = running\n"
      return 0
    fi
    return 113
  }
  bootout_label "race-label"
' _ "$INSTALLER" "$wait_state" || fail "bootout must wait until launchd reports the label missing"
[[ "$(cat "$wait_state")" == "3" ]] || fail "bootout wait must poll through running state to missing"
rm -f "$wait_state"

bash -c '
  source "$1"
  LAUNCHD_UNLOAD_WAIT_ATTEMPTS=3
  LAUNCHD_UNLOAD_WAIT_INTERVAL_SECONDS=0
  launchctl() {
    if [[ "$1" == "bootout" ]]; then return 0; fi
    printf "state = running\n"
  }
  if bootout_label "stuck-label" >/dev/null 2>&1; then
    exit 1
  else
    status=$?
  fi
  [[ "$status" == "1" ]]
' _ "$INSTALLER" || fail "bootout wait must fail on timeout"

bash -c '
  source "$1"
  launchctl() {
    if [[ "$1" == "bootout" ]]; then return 0; fi
    return 42
  }
  if bootout_label "inspect-failure" >/dev/null 2>&1; then
    exit 1
  else
    status=$?
  fi
  [[ "$status" == "42" ]]
' _ "$INSTALLER" || fail "unexpected launchctl print failure must propagate from unload wait"

enable_marker="$(mktemp "${TMPDIR:-/tmp}/backlog-md-hub-enable-marker.XXXXXX")"
rm -f "$enable_marker"
bash -c '
  source "$1"
  enable_marker="$2"
  launchctl() {
    case "$1" in
      "bootout") return 0 ;;
      "print") return 113 ;;
      "bootstrap") return 5 ;;
      "enable") touch "$enable_marker"; return 0 ;;
    esac
  }
  if bootstrap_label "bootstrap-failure" "/tmp/test.plist"; then
    exit 1
  else
    status=$?
  fi
  [[ "$status" == "5" ]]
  [[ ! -e "$enable_marker" ]]
' _ "$INSTALLER" "$enable_marker" || fail "bootstrap failure must propagate without calling enable"
[[ ! -e "$enable_marker" ]] || fail "enable must not run after bootstrap failure"

home="$(make_home)"
[[ "$(resolve_value "$home" env -u BACKLOG_HUB_TAILSCALE_LISTEN)" == "false" ]] || fail "default must be false"
rm -rf "$home"

home="$(make_home)"
write_existing_plist "$home" "true"
[[ "$(resolve_value "$home" env -u BACKLOG_HUB_TAILSCALE_LISTEN)" == "true" ]] || fail "existing plist value must be inherited"
[[ "$(resolve_value "$home" env BACKLOG_HUB_TAILSCALE_LISTEN=false)" == "false" ]] || fail "explicit environment must override existing plist"
rm -rf "$home"

home="$(make_home)"
if resolve_value "$home" env BACKLOG_HUB_TAILSCALE_LISTEN=yes >/dev/null 2>&1; then
  fail "invalid boolean must be rejected"
fi
rm -rf "$home"

home="$(make_home)"
rendered="$(mktemp "${TMPDIR:-/tmp}/backlog-md-hub-rendered.XXXXXX")"
HOME="$home" BACKLOG_HUB_TAILSCALE_LISTEN=true bash -c '
  source "$1"
  resolve_tailscale_listen >/dev/null
  render_plist "$2"
' _ "$INSTALLER" "$rendered"
plutil -lint "$rendered" >/dev/null
[[ "$(plutil -extract EnvironmentVariables.BACKLOG_HUB_TAILSCALE_LISTEN raw -o - "$rendered")" == "true" ]] || fail "rendered plist must contain the flag"
rm -rf "$home" "$rendered"

home="$(make_home)"
write_existing_plist "$home" "false"
HOME="$home" bash -c '
  source "$1"
  service_state() { printf "running"; }
  snapshot_previous_service
  printf "replacement\n" > "$NEW_PLIST"
  bootout_label() { :; }
  bootstrap_label() { [[ "$1" == "$NEW_LABEL_HUB" && "$2" == "$NEW_PLIST" ]]; }
  wait_for_healthz() { return 0; }
  print_status() { :; }
  die() { return 0; }
  rollback_and_fail "test rollback" >/dev/null 2>&1
  plutil -lint "$NEW_PLIST" >/dev/null
  [[ "$(plutil -extract EnvironmentVariables.BACKLOG_HUB_TAILSCALE_LISTEN raw -o - "$NEW_PLIST")" == "false" ]]
' _ "$INSTALLER" || fail "rollback must restore the previous new-label plist and loaded state"
rm -rf "$home"

home="$(make_home)"
write_existing_plist "$home" "false"
rollback_output="$(mktemp "${TMPDIR:-/tmp}/backlog-md-hub-rollback-output.XXXXXX")"
die_marker="$(mktemp "${TMPDIR:-/tmp}/backlog-md-hub-rollback-die.XXXXXX")"
rm -f "$die_marker"
HOME="$home" bash -c '
  source "$1"
  rollback_output="$2"
  die_marker="$3"
  service_state() { return 0; }
  snapshot_previous_service
  backup_path="$PREVIOUS_NEW_PLIST_BACKUP"
  printf "replacement\n" > "$NEW_PLIST"
  bootout_label() { return 42; }
  die() { touch "$die_marker"; return 0; }
  rollback_and_fail "test bootout failure" > "$rollback_output" 2>&1
  plutil -lint "$NEW_PLIST" >/dev/null
  [[ "$(plutil -extract EnvironmentVariables.BACKLOG_HUB_TAILSCALE_LISTEN raw -o - "$NEW_PLIST")" == "false" ]]
  [[ -z "$PREVIOUS_NEW_PLIST_BACKUP" ]]
  [[ ! -e "$backup_path" ]]
' _ "$INSTALLER" "$rollback_output" "$die_marker" || fail "rollback must continue restoring and cleaning up after bootout failure"
grep -q "continuing recovery.*status=42" "$rollback_output" || fail "rollback bootout failure must be logged with status"
[[ -e "$die_marker" ]] || fail "rollback must reach final error reporting after bootout failure"
rm -rf "$home" "$rollback_output" "$die_marker"

home="$(make_home)"
write_existing_plist "$home" "false"
snapshot_tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/backlog-md-hub-snapshot-test.XXXXXX")"
touch "$snapshot_tmpdir/backlog-md-hub.previous.XXXXXX.plist"
HOME="$home" TMPDIR="$snapshot_tmpdir" bash -c '
  source "$1"
  service_state() { printf "running"; }
  snapshot_previous_service
  [[ -f "$PREVIOUS_NEW_PLIST_BACKUP" ]]
  [[ "$PREVIOUS_NEW_PLIST_BACKUP" != "$TMPDIR/backlog-md-hub.previous.XXXXXX.plist" ]]
  cleanup_previous_snapshot
' _ "$INSTALLER" || fail "snapshot must not collide with a legacy literal mktemp path"
rm -rf "$home" "$snapshot_tmpdir"

home="$(make_home)"
HOME="$home" bash -c '
  source "$1"
  PREVIOUS_OLD_LOADED=1
  bootout_label() { :; }
  bootstrap_label() { return 99; }
  die() { return 0; }
  rollback_and_fail "test missing legacy" >/dev/null 2>&1
  [[ ! -e "$OLD_HUB_PLIST" ]]
' _ "$INSTALLER" || fail "rollback must not synthesize an unusable legacy plist"
rm -rf "$home"

calls="$(mktemp "${TMPDIR:-/tmp}/backlog-md-hub-health-calls.XXXXXX")"
bash -c '
  source "$1"
  calls_file="$2"
  HUB_TAILSCALE_LISTEN=true
  service_state() { printf "running"; }
  wait_for_healthz() { printf "%s\n" "${1:-127.0.0.1}" >> "$calls_file"; }
  repo_count() { printf "1"; }
  resolve_runtime_tailscale_ipv4() { printf "100.92.198.57"; }
  verify_new_gate >/dev/null
' _ "$INSTALLER" "$calls" || fail "flag=true with Tailscale IP must pass when both health checks pass"
[[ "$(sed -n '1p' "$calls")" == "127.0.0.1" ]] || fail "primary health check must run first"
[[ "$(sed -n '2p' "$calls")" == "100.92.198.57" ]] || fail "Tailscale health check must run when IP is available"
[[ "$(wc -l < "$calls" | tr -d ' ')" == "2" ]] || fail "flag=true must run exactly two health checks"
rm -f "$calls"

calls="$(mktemp "${TMPDIR:-/tmp}/backlog-md-hub-health-calls.XXXXXX")"
bash -c '
  source "$1"
  calls_file="$2"
  HUB_TAILSCALE_LISTEN=false
  service_state() { printf "running"; }
  wait_for_healthz() { printf "%s\n" "${1:-127.0.0.1}" >> "$calls_file"; }
  repo_count() { printf "1"; }
  resolve_runtime_tailscale_ipv4() { return 99; }
  verify_new_gate >/dev/null
' _ "$INSTALLER" "$calls" || fail "flag=false verification must not require Tailscale"
[[ "$(cat "$calls")" == "127.0.0.1" ]] || fail "flag=false must only check primary health"
rm -f "$calls"

calls="$(mktemp "${TMPDIR:-/tmp}/backlog-md-hub-health-calls.XXXXXX")"
output="$(mktemp "${TMPDIR:-/tmp}/backlog-md-hub-health-output.XXXXXX")"
bash -c '
  source "$1"
  calls_file="$2"
  HUB_TAILSCALE_LISTEN=true
  service_state() { printf "running"; }
  wait_for_healthz() { printf "%s\n" "${1:-127.0.0.1}" >> "$calls_file"; }
  repo_count() { printf "1"; }
  resolve_runtime_tailscale_ipv4() { return 0; }
  verify_new_gate
' _ "$INSTALLER" "$calls" > "$output" 2>&1 || fail "missing Tailscale IP must keep a healthy primary"
[[ "$(cat "$calls")" == "127.0.0.1" ]] || fail "missing Tailscale IP must not add a secondary health check"
grep -q "Tailscale IPv4 is not ready" "$output" || fail "missing Tailscale IP must emit a warning"
rm -f "$calls" "$output"

printf 'ok - installer flag inheritance, rendering, rollback, and health verification\n'
