#!/usr/bin/env bash
set -euo pipefail

ROOT="${CHATBOT_QQ_ROOT:-/opt/chatbot-qq}"
STATE_DIR="${CHATBOT_QQ_INTEGRITY_DIR:-/var/lib/chatbot-qq-integrity}"
MANIFEST="$STATE_DIR/sha256sums.txt"
STATUS="$STATE_DIR/status.json"
LOG="${CHATBOT_QQ_INTEGRITY_LOG:-/var/log/chatbot-qq-integrity.log}"

mkdir -p "$STATE_DIR"
touch "$LOG"

cd "$ROOT"

write_status() {
  local ok="$1"
  local state="$2"
  local detail="$3"
  local checked_files="0"
  if [ -f "$MANIFEST" ]; then
    checked_files="$(wc -l < "$MANIFEST" | tr -d ' ')"
  fi
  cat > "$STATUS" <<JSON
{
  "time": "$(date -Is)",
  "ok": $ok,
  "state": "$state",
  "detail": "$detail",
  "root": "$ROOT",
  "manifest": "$MANIFEST",
  "checked_files": $checked_files
}
JSON
  chmod 600 "$STATUS"
}

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
  write_status "true" "initialized" "manifest initialized"
  echo "$(date -Is) initialized manifest: $MANIFEST" >> "$LOG"
  exit 0
fi

if ! sha256sum -c "$MANIFEST" >> "$LOG" 2>&1; then
  write_status "false" "drift" "sha256 mismatch detected"
  echo "$(date -Is) integrity drift detected under $ROOT" >> "$LOG"
  exit 1
fi

write_status "true" "ok" "manifest verified"
echo "$(date -Is) integrity ok" >> "$LOG"
