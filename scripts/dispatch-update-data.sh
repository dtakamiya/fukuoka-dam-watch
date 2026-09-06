#!/bin/bash
# update-data.yml を workflow_dispatch でトリガーする。
#
# なぜこれが要るか:
#   GitHub のホスト型 cron（on.schedule）は新規 workflow だと発火開始が半日〜1日遅れ、
#   混雑時にドロップされる。そこで だいすけ の Mac 上の launchd を「主トリガー」にして
#   毎時 :17 / :47 にこのスクリプトを走らせ、workflow_dispatch を叩く。
#   workflow 側の on.schedule はそのまま冗長として残す（concurrency: update-data で二重起動は安全）。
#
# 認証:
#   通常は gh が macOS keyring からトークンを取得する（launchd の GUI セッション実行なら通る）。
#   keyring に触れない環境では ~/.config/gh-dispatch-token（0600, workflow scope 必須）から
#   GH_TOKEN を読むフォールバックに切り替わる。
set -euo pipefail

REPO="dtakamiya/fukuoka-dam-watch"
WORKFLOW="update-data.yml"
GH_BIN="/opt/homebrew/bin/gh"
REPO_DIR="/Users/dtakamiya/work/fukuoka-dam-watch"
LOG_DIR="${REPO_DIR}/tmp"
LOG_FILE="${LOG_DIR}/dispatch.log"
TOKEN_FILE="${HOME}/.config/gh-dispatch-token"
LOG_KEEP_LINES=500

mkdir -p "${LOG_DIR}"

log() {
  printf '%s\n' "$*" >>"${LOG_FILE}"
}

# --- ログの自己ローテート（末尾 LOG_KEEP_LINES 行だけ残す） ---
rotate_log() {
  [ -f "${LOG_FILE}" ] || return 0
  local lines
  lines=$(wc -l <"${LOG_FILE}" | tr -d ' ')
  if [ "${lines}" -gt "${LOG_KEEP_LINES}" ]; then
    tail -n "${LOG_KEEP_LINES}" "${LOG_FILE}" >"${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "${LOG_FILE}"
  fi
}

TS="$(date '+%Y-%m-%dT%H:%M:%S%z')"

# --- 認証: keyring がダメならトークンファイルにフォールバック ---
AUTH_MODE="keyring"
if ! "${GH_BIN}" auth token >/dev/null 2>&1; then
  if [ -r "${TOKEN_FILE}" ]; then
    GH_TOKEN="$(cat "${TOKEN_FILE}")"
    export GH_TOKEN
    AUTH_MODE="token-file"
  else
    AUTH_MODE="none"
  fi
fi

set +e
OUTPUT="$("${GH_BIN}" workflow run "${WORKFLOW}" -R "${REPO}" 2>&1)"
CODE=$?
set -e

log "[${TS}] auth=${AUTH_MODE} exit=${CODE} :: ${OUTPUT//$'\n'/ }"
rotate_log

exit "${CODE}"
