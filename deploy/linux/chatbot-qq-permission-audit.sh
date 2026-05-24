#!/usr/bin/env bash
set -euo pipefail

ROOT="${CHATBOT_QQ_ROOT:-/opt/chatbot-qq}"
STATE_DIR="${CHATBOT_QQ_INTEGRITY_DIR:-/var/lib/chatbot-qq-integrity}"
STATUS="$STATE_DIR/permissions.json"
FIX="${1:-}"

mkdir -p "$STATE_DIR"

critical_paths=(
  "$ROOT/AGENTS.md"
  "$ROOT/README.md"
  "$ROOT/go.mod"
  "$ROOT/package.json"
  "$ROOT/package-lock.json"
  "$ROOT/cmd"
  "$ROOT/internal"
  "$ROOT/scripts"
  "$ROOT/deploy"
  "$ROOT/configs"
  "$ROOT/docs"
)

if [ "$FIX" = "--fix" ]; then
  find "${critical_paths[@]}" -xdev -type d -exec chmod 755 {} + 2>/dev/null || true
  find "${critical_paths[@]}" -xdev -type f -exec chmod 644 {} + 2>/dev/null || true
  find "$ROOT/deploy/linux" -maxdepth 1 -type f -name '*.sh' -exec chmod 755 {} + 2>/dev/null || true
  find "$ROOT/groups" -path '*/scripts/dream.sh' -type f -exec chmod 755 {} + 2>/dev/null || true
  [ -f /etc/chatbot-qq.env ] && chmod 600 /etc/chatbot-qq.env
  [ -d /root/.cc-connect-qq ] && chmod 700 /root/.cc-connect-qq
  [ -f /root/.cc-connect-qq/config.toml ] && chmod 600 /root/.cc-connect-qq/config.toml
fi

violations_file="$(mktemp)"
trap 'rm -f "$violations_file"' EXIT

find "${critical_paths[@]}" -xdev -type f -perm /022 -printf '%m %u:%g %p\n' 2>/dev/null | sort > "$violations_file" || true
find "${critical_paths[@]}" -xdev -type d -perm /022 -printf '%m %u:%g %p\n' 2>/dev/null | sort >> "$violations_file" || true

check_mode() {
  local path="$1"
  local wanted="$2"
  if [ -e "$path" ]; then
    local mode
    mode="$(stat -c '%a' "$path")"
    if [ "$mode" != "$wanted" ]; then
      echo "$mode $(stat -c '%U:%G' "$path") $path expected=$wanted" >> "$violations_file"
    fi
  fi
}

check_mode /etc/chatbot-qq.env 600
check_mode /root/.cc-connect-qq 700
check_mode /root/.cc-connect-qq/config.toml 600

violation_count="$(wc -l < "$violations_file" | tr -d ' ')"
if [ "$violation_count" = "0" ]; then
  ok=true
  state="ok"
else
  ok=false
  state="writable"
fi

{
  echo "{"
  echo "  \"time\": \"$(date -Is)\","
  echo "  \"ok\": $ok,"
  echo "  \"state\": \"$state\","
  echo "  \"root\": \"$ROOT\","
  echo "  \"violation_count\": $violation_count,"
  echo "  \"violations\": ["
  awk 'BEGIN { first=1 } {
    gsub(/\\/,"\\\\");
    gsub(/"/,"\\\"");
    if (!first) printf ",\n";
    printf "    \"%s\"", $0;
    first=0;
  } END { printf "\n" }' "$violations_file"
  echo "  ]"
  echo "}"
} > "$STATUS"
chmod 600 "$STATUS"

if [ "$ok" != "true" ]; then
  exit 1
fi
