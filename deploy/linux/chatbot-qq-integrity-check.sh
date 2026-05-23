#!/usr/bin/env bash
set -euo pipefail

ROOT="${CHATBOT_QQ_ROOT:-/opt/chatbot-qq}"
STATE_DIR="${CHATBOT_QQ_INTEGRITY_DIR:-/var/lib/chatbot-qq-integrity}"
MANIFEST="$STATE_DIR/sha256sums.txt"
LOG="${CHATBOT_QQ_INTEGRITY_LOG:-/var/log/chatbot-qq-integrity.log}"

mkdir -p "$STATE_DIR"
touch "$LOG"

cd "$ROOT"

if [ ! -f "$MANIFEST" ]; then
  find AGENTS.md README.md go.mod package.json package-lock.json cmd internal scripts deploy configs docs \
    -type f \
    ! -path 'deploy/linux/napcat-data/*' \
    ! -path '*/__pycache__/*' \
    ! -name '*.local.toml' \
    ! -name '*.log' \
    ! -name '*.pyc' \
    -print0 2>/dev/null | sort -z | xargs -0 sha256sum > "$MANIFEST"
  chmod 600 "$MANIFEST"
  echo "$(date -Is) initialized manifest: $MANIFEST" >> "$LOG"
  exit 0
fi

if ! sha256sum -c "$MANIFEST" >> "$LOG" 2>&1; then
  echo "$(date -Is) integrity drift detected under $ROOT" >> "$LOG"
  exit 1
fi

echo "$(date -Is) integrity ok" >> "$LOG"
