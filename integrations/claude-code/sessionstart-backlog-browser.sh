#!/bin/bash
# SessionStart hook: Backlog.md 検出 repo でセッション起動時に backlog browser を bg 起動
#
# 動作:
# 1. 入力 JSON から cwd を取得
# 2. cwd から walk-up (.git 境界で停止) して backlog/config.yml を検出
# 3. 通常セッションでは role 未設定でも発火し、worker role では skip
#    (worker は spawn 時点で role が確定しているため、browser 二重起動を避ける)
# 4. lockfile helper を第一参照にし、失敗時は config.yml の default_port へ fallback
# 5. その port が自 repo の browser なら再利用、空きなら bg 起動、他プロセス占有なら skip
# 6. Tailscale IPv4 を取得 (無ければ 127.0.0.1)
# 7. tmux pane option @ai_backlog_url に URL を書き込む (sidepane 描画用)
# 8. agent additionalContext に URL を渡す
#
# fail-open: エラー時は静かに exit 0 (セッション起動を止めない)

set -o pipefail

# 発火経路の実測用 log。何処で exit したか、tmux run-shell 起動戻り値、
# wait_for_own_listener の結果を残す。fail-open で silent skip する分岐が多い
# 構造上、log がないと何が起きたか実測できない。
bbh_log_dir="$HOME/.claude/logs"
mkdir -p "$bbh_log_dir" 2>/dev/null || true
bbh_log_file="$bbh_log_dir/backlog-browser-hook-$(date +%Y-%m-%d).log"
bbh_start_ts=$(date +%s)
bbh_session_id="unknown"
bbh_pane="${TMUX_PANE:-none}"
bbh_log() {
  # $1: tag, $2..: 補足情報
  local tag="$1"; shift
  local elapsed=$(( $(date +%s) - bbh_start_ts ))
  printf '%s pid=%s pane=%s session=%s elapsed=%ss tag=%s %s\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$$" "$bbh_pane" "$bbh_session_id" \
    "$elapsed" "$tag" "$*" >> "$bbh_log_file" 2>/dev/null || true
}
bbh_log start "hook invoked"

browser_lib="$HOME/.claude/scripts/backlog-browser-lib.sh"
if [[ ! -r "$browser_lib" ]]; then
  bbh_log skip "browser_lib not readable: $browser_lib"
  exit 0
fi
# shellcheck source=/dev/null
source "$browser_lib" || { bbh_log skip "browser_lib source failed"; exit 0; }

is_numeric_port() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
}

input=$(cat 2>/dev/null || true)
if [[ -z "$input" ]]; then
  bbh_log skip "stdin empty"
  exit 0
fi
bbh_session_id=$(printf '%s' "$input" | jq -r '.session_id // "unknown"' 2>/dev/null || echo unknown)

command -v jq >/dev/null 2>&1 || { bbh_log skip "jq not in PATH"; exit 0; }
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)
if [[ -z "$cwd" || ! -d "$cwd" ]]; then
  bbh_log skip "cwd empty or not dir: '$cwd'"
  exit 0
fi
bbh_log input "cwd=$cwd"

# 通常セッションの SessionStart 時点では role がまだ空なので、空 role は発火対象にする。
# worker は spawn 直後に role が確定してから SessionStart が走るため、非 lead の worker role
# (verifier / implementor / critic 等) では browser 二重起動を避けるため skip する。
# TMUX_PANE が無い環境 (非 tmux) では判定できないので skip する (browser を勝手に
# 起動しない)。
if [[ -z "${TMUX_PANE:-}" ]]; then
  bbh_log skip "TMUX_PANE unset (non-tmux env)"
  exit 0
fi
role=$(tmux show-option -pqv -t "$TMUX_PANE" @tmux_bridge_role 2>/dev/null)
bbh_log role "role='$role'"
if [[ -n "$role" && "$role" != "lead" ]]; then
  bbh_log skip "worker role: '$role'"
  exit 0
fi

# walk-up して backlog config を検出 (.git 境界で停止)
scan_dir="$cwd"
config=""
repo_root=""
while [[ -n "$scan_dir" && "$scan_dir" != "/" ]]; do
  for candidate in "$scan_dir/backlog/config.yml" "$scan_dir/backlog.config.yml" "$scan_dir/.backlog/config.yml"; do
    if [[ -f "$candidate" ]]; then
      config="$candidate"
      repo_root="$scan_dir"
      break 2
    fi
  done
  if [[ -e "$scan_dir/.git" ]]; then
    break
  fi
  scan_dir="$(dirname "$scan_dir")"
done
if [[ -z "$config" ]]; then
  bbh_log skip "no backlog config found in walk-up from $cwd"
  exit 0
fi
bbh_log config "repo_root=$repo_root config=$config"

port=""
if [[ -z "$port" ]]; then
  port=$(grep -E "^default_port:" "$config" 2>/dev/null | awk '{print $2}' | tr -d '"')
fi
if ! is_numeric_port "$port"; then
  port=6420
fi

bbh_log port "chosen port=$port"
if bbl_is_own_backlog_browser_port "$port" "$repo_root"; then
  port_state="own"
  bbh_log port_state "own (self browser already listening)"
elif [[ -n "$(bbl_listen_pids_for_port "$port")" ]]; then
  bbh_log skip "port $port occupied by non-own listener"
  exit 0
else
  port_state="new"
  bbh_log port_state "new (port empty, will launch)"
fi

if [[ "$port_state" == "new" ]]; then
  log_dir="$repo_root/tmp"
  log_file="$log_dir/backlog-browser-$port.log"
  if ! mkdir -p "$log_dir" 2>/dev/null; then
    bbh_log skip "mkdir $log_dir failed"
    exit 0
  fi
  printf -v repo_root_q '%q' "$repo_root"
  printf -v log_file_q '%q' "$log_file"
  launch_cmd="cd $repo_root_q && sleep 2147483647 | backlog browser --port $port --no-open >$log_file_q 2>&1"
  bbh_log launch "tmux run-shell -b: $launch_cmd"
  if tmux run-shell -b "$launch_cmd" 2>/dev/null; then
    bbh_log launch_rc "tmux run-shell -b exit=0"
  else
    bbh_log launch_rc "tmux run-shell -b exit=$? (may still have spawned)"
  fi
  if ! bbl_wait_for_own_listener "$port" "$repo_root"; then
    bbh_log skip "wait_for_own_listener failed (launch not visible on port $port)"
    exit 0
  fi
  bbh_log launched "wait_for_own_listener success"
fi

# Tailscale IPv4 を取得 (fallback: 127.0.0.1)
tailscale_ip=$(tailscale ip -4 2>/dev/null | head -1 | tr -d '[:space:]')
if [[ -z "$tailscale_ip" || ! "$tailscale_ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  tailscale_ip="127.0.0.1"
fi
url="http://${tailscale_ip}:${port}/"

# tmux pane option に書き込み (sidepane が描画時に読み取る)
if tmux set-option -pt "$TMUX_PANE" @ai_backlog_url "$url" 2>/dev/null; then
  bbh_log url_set "url=$url"
else
  bbh_log url_set_fail "tmux set-option failed for @ai_backlog_url"
fi

# agent additionalContext に URL を流す
project_name=$(basename "$repo_root")
context="Backlog.md browser: ${url} (project: ${project_name}, port ${port})"
bbh_log "done" "context=$context"
jq -cn --arg context "$context" \
  '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":$context}}'

exit 0
