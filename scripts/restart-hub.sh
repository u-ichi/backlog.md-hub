#!/usr/bin/env bash
# Backlog.md Hub (launchd 管理) を再起動する。
#
# launchctl kickstart -k gui/<uid>/com.github.u-ichi.backlog-md-hub を発行し、
# 6419 での HTTP 200 応答を最大 <timeout> 秒 (default 15) 待つ。
# HTTP 200 が返ったら PID / port を出して exit 0。時間内に返らなかったら
# hub.log の末尾 20 行を出して exit 1。
#
# Usage: scripts/restart-hub.sh [timeout_seconds]

set -euo pipefail

LABEL="com.github.u-ichi.backlog-md-hub"
USER_UID="$(id -u)"
DOMAIN="gui/${USER_UID}/${LABEL}"
PORT="${BACKLOG_HUB_PORT:-6419}"
URL="http://127.0.0.1:${PORT}/"
TIMEOUT="${1:-15}"

echo "[restart-hub] kickstart -k ${DOMAIN}"
launchctl kickstart -k "${DOMAIN}"

echo "[restart-hub] waiting HTTP 200 on ${URL} (up to ${TIMEOUT}s)"
deadline=$((SECONDS + TIMEOUT))
while (( SECONDS < deadline )); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "${URL}" || true)"
  if [[ "${code}" == "200" ]]; then
    pid="$(lsof -iTCP:"${PORT}" -sTCP:LISTEN -n -P 2>/dev/null | awk 'NR==2 {print $2}')"
    echo "[restart-hub] ready pid=${pid} port=${PORT}"
    exit 0
  fi
  sleep 0.5
done

echo "[restart-hub] TIMEOUT: no HTTP 200 after ${TIMEOUT}s" >&2
tail -20 "$HOME/Library/Logs/backlog-md/hub.log" 2>/dev/null >&2 || true
exit 1
