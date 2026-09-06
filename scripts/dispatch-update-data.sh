#!/bin/bash
# 毎時 :17 / :47 に launchd (com.dtakamiya.fukuoka-dam-watch-dispatch) から実行され、
# GitHub Actions の update-data.yml を workflow_dispatch で起動する。
#
# データ更新の「主トリガー」はこのスクリプト（だいすけの Mac 上の launchd）。
# update-data.yml の on.schedule ("7,37 * * * *") は冗長な保険にすぎない
# ── GitHub ホスト型 schedule は発火が大きく遅れる / 混雑時にドロップするため。
#
# 前提: gh CLI が認証済みであること (gh auth status)。
# launchd の PATH は最小 (/usr/bin:/bin 程度) なので Homebrew のパスを明示する。

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

REPO="dtakamiya/fukuoka-dam-watch"
WORKFLOW="update-data.yml"

ts() { date "+%Y-%m-%dT%H:%M:%S%z"; }

if ! command -v gh >/dev/null 2>&1; then
  echo "[$(ts)] ERROR: gh CLI not found (PATH=$PATH)" >&2
  exit 127
fi

echo "[$(ts)] dispatching $WORKFLOW on $REPO"
gh workflow run "$WORKFLOW" -R "$REPO"
echo "[$(ts)] dispatch OK"
