#!/usr/bin/env bash
set -euo pipefail

install_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_path="/root/.cc-connect-qq/config.toml"
remote_dir="/opt/chatbot-qq"
env_path="/etc/chatbot-qq.env"
group_id=""
private_user_id=""
listen_port="3002"
at_port="3003"
private_port="3006"
install_services=0
no_npm=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-root) install_root="$2"; shift 2 ;;
    --config-path) config_path="$2"; shift 2 ;;
    --remote-dir) remote_dir="$2"; shift 2 ;;
    --env-path) env_path="$2"; shift 2 ;;
    --group-id) group_id="$2"; shift 2 ;;
    --private-user-id) private_user_id="$2"; shift 2 ;;
    --listen-port) listen_port="$2"; shift 2 ;;
    --at-port) at_port="$2"; shift 2 ;;
    --private-port) private_port="$2"; shift 2 ;;
    --install-services) install_services=1; shift ;;
    --no-npm) no_npm=1; shift ;;
    -h|--help) sed -n '1,120p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

read_value() {
  local prompt="$1"
  local default="${2:-}"
  local required="${3:-0}"
  local value=""
  while true; do
    if [[ -n "$default" ]]; then
      read -r -p "${prompt} [${default}]: " value
    else
      read -r -p "${prompt}: " value
    fi
    [[ -n "$value" ]] || value="$default"
    if [[ "$required" != "1" || -n "$value" ]]; then
      printf '%s' "$value"
      return
    fi
    echo "Value is required." >&2
  done
}

toml_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

[[ -n "$group_id" ]] || group_id="$(read_value "QQ group ID to allow" "" 1)"
[[ -n "$private_user_id" ]] || private_user_id="$(read_value "Private QQ user ID to allow (optional)" "" 0)"

mkdir -p "$(dirname "$config_path")" "$remote_dir/groups/sandbox-$group_id/local_files" "$remote_dir/groups/sandbox-$group_id/memory"
if [[ ! -f "$remote_dir/groups/sandbox-$group_id/local_files/INDEX.md" ]]; then
  cat >"$remote_dir/groups/sandbox-$group_id/local_files/INDEX.md" <<'EOF'
# Local File Index

| Date | Name | Path | Type | Notes |
|---|---|---|---|---|
EOF
fi
[[ -f "$remote_dir/groups/sandbox-$group_id/KNOWLEDGE.md" ]] || printf '# Knowledge\n' >"$remote_dir/groups/sandbox-$group_id/KNOWLEDGE.md"
[[ -f "$remote_dir/groups/sandbox-$group_id/AGENTS.md" ]] || cp "$install_root/groups/default/AGENTS.md" "$remote_dir/groups/sandbox-$group_id/AGENTS.md"

workspace="$(toml_escape "$remote_dir/groups/sandbox-$group_id")"
cat >"$config_path" <<EOF
language = "zh"
data_dir = "$remote_dir/.cc-connect"

[log]
level = "info"

[display]
mode = "compact"
thinking_messages = false
tool_messages = false
show_context_indicator = false
reply_footer = false

[stream_preview]
enabled = false

[instant_reply]
enabled = false
content = ""

[rate_limit]
max_messages = 20
window_secs = 60

[[projects]]
name = "qq-sandbox-$group_id-listen"
reset_on_idle_mins = 30

[projects.agent]
type = "codex"

[projects.agent.options]
work_dir = "$workspace"
mode = "full-auto"
model = "gpt-5.4-mini"
reasoning_effort = "medium"

[[projects.platforms]]
type = "qq"

[projects.platforms.options]
ws_url = "ws://127.0.0.1:$listen_port"
token = ""
allow_from = "*"
share_session_in_channel = true

[[projects]]
name = "qq-sandbox-$group_id-at"
reset_on_idle_mins = 30

[projects.agent]
type = "codex"

[projects.agent.options]
work_dir = "$workspace"
mode = "full-auto"
model = "gpt-5.5"
reasoning_effort = "high"

[[projects.platforms]]
type = "qq"

[projects.platforms.options]
ws_url = "ws://127.0.0.1:$at_port"
token = ""
allow_from = "*"
share_session_in_channel = false
EOF

if [[ -n "$private_user_id" ]]; then
  mkdir -p "$remote_dir/users/$private_user_id"
  private_workspace="$(toml_escape "$remote_dir/users/$private_user_id")"
  cat >>"$config_path" <<EOF

[[projects]]
name = "qq-private-$private_user_id"
reset_on_idle_mins = 30

[projects.agent]
type = "codex"

[projects.agent.options]
work_dir = "$private_workspace"
mode = "full-auto"
model = "gpt-5.5"
reasoning_effort = "high"

[[projects.platforms]]
type = "qq"

[projects.platforms.options]
ws_url = "ws://127.0.0.1:$private_port"
token = ""
allow_from = "$private_user_id"
share_session_in_channel = false
EOF
fi

mkdir -p "$(dirname "$env_path")"
cat >"$env_path" <<EOF
ONEBOT_UPSTREAM_URL=ws://127.0.0.1:3001
ONEBOT_PROXY_PORTS=$listen_port,$at_port${private_user_id:+,$private_port}
ONEBOT_LISTEN_PORT=$listen_port
ONEBOT_AT_PORT=$at_port
ONEBOT_ALLOWED_GROUPS=$group_id
ONEBOT_ALLOWED_PRIVATE_USERS=$private_user_id
ONEBOT_PRIVATE_ROUTES=${private_user_id:+$private_user_id:$private_port}
EOF
chmod 600 "$env_path"

if [[ "$no_npm" -ne 1 ]]; then
  cd "$install_root"
  npm install --omit=dev
fi

if [[ "$install_services" -eq 1 ]]; then
  cp "$install_root/deploy/linux/onebot-group-proxy.service" /etc/systemd/system/onebot-group-proxy.service
  cp "$install_root/deploy/linux/cc-connect-qq.service" /etc/systemd/system/cc-connect-qq.service
  systemctl daemon-reload
  systemctl enable onebot-group-proxy.service cc-connect-qq.service
fi

echo "Wrote config: $config_path"
echo "Wrote env:    $env_path"
echo "Start NapCat first, then run:"
echo "  systemctl start onebot-group-proxy cc-connect-qq"
