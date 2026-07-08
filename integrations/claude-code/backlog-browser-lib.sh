#!/bin/bash
# Backlog.md browser の port LISTEN と repo 所有判定を hook / watchdog で共有する。

bbl_listen_pids_for_port() {
  local check_port="$1"
  lsof -i ":$check_port" -sTCP:LISTEN -t 2>/dev/null || true
}

bbl_is_own_backlog_browser_pid() {
  local pid="$1"
  local repo_root="$2"
  local pid_cmd pid_cwd

  pid_cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
  if [[ -n "$pid_cmd" && "$pid_cmd" != *"backlog browser"* ]]; then
    return 1
  fi

  pid_cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/ {sub(/^n/, ""); print; exit}')
  [[ "$pid_cwd" == "$repo_root" ]]
}

bbl_is_own_backlog_browser_port() {
  local check_port="$1"
  local repo_root="$2"
  local listen_pids pid

  listen_pids=$(bbl_listen_pids_for_port "$check_port")
  [[ -n "$listen_pids" ]] || return 1

  for pid in $listen_pids; do
    if bbl_is_own_backlog_browser_pid "$pid" "$repo_root"; then
      return 0
    fi
  done
  return 1
}

bbl_wait_for_own_listener() {
  local check_port="$1"
  local repo_root="$2"
  local tries

  tries=0
  while [[ $tries -lt 15 ]]; do
    if bbl_is_own_backlog_browser_port "$check_port" "$repo_root"; then
      sleep 1
      if bbl_is_own_backlog_browser_port "$check_port" "$repo_root"; then
        return 0
      fi
    fi
    sleep 0.2
    tries=$((tries + 1))
  done
  return 1
}
