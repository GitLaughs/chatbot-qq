#!/usr/bin/env bash
set -euo pipefail

ROOT="${CHATBOT_QQ_ROOT:-/opt/chatbot-qq}"
LOG_KEEP_DAYS="${CHATBOT_QQ_LOG_KEEP_DAYS:-14}"
GENERATED_KEEP_DAYS="${CHATBOT_QQ_GENERATED_KEEP_DAYS:-30}"
ARCHIVE_KEEP_DAYS="${CHATBOT_QQ_ARCHIVE_KEEP_DAYS:-90}"
EVIDENCE_KEEP_DAYS="${CHATBOT_QQ_EVIDENCE_KEEP_DAYS:-30}"
LOG="/var/log/chatbot-qq-cleanup.log"

touch "$LOG"
echo "$(date -Is) cleanup start root=$ROOT" >> "$LOG"

find /var/log -maxdepth 1 \
  \( -name 'onebot-group-proxy.log*' -o -name 'cc-connect-qq.log*' -o -name 'chatbot-qq-*.log*' \) \
  -type f -mtime +"$LOG_KEEP_DAYS" -print -delete >> "$LOG" 2>&1 || true

if [ -d "$ROOT/groups" ]; then
  find "$ROOT/groups" "$ROOT/users" \
    \( -path '*/local_files/generated/*' -o -path '*/local_files/rendered/*' \) \
    -type f -mtime +"$GENERATED_KEEP_DAYS" -print -delete >> "$LOG" 2>&1 || true

  find "$ROOT/groups" "$ROOT/users" \
    -path '*/local_files/archive/*' \
    -type f -mtime +"$ARCHIVE_KEEP_DAYS" -print -delete >> "$LOG" 2>&1 || true

  find "$ROOT/groups" "$ROOT/users" \
    \( -path '*/memory/profile-updates/*-evidence.md' -o -path '*/memory/profile-updates/*-source-map.jsonl' -o -path '*/memory/dreams/*-evidence.md' -o -path '*/memory/dreams/*-source-map.jsonl' \) \
    -type f -mtime +"$EVIDENCE_KEEP_DAYS" -print -delete >> "$LOG" 2>&1 || true

  find "$ROOT/groups" "$ROOT/users" -type d -empty -print -delete >> "$LOG" 2>&1 || true
fi

echo "$(date -Is) cleanup done" >> "$LOG"
