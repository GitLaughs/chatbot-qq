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
install_maintenance=1
enable_provider_failover=0
no_npm=0
health_port="3010"
admin_user_id=""
render_font="/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
imagemagick_convert="convert"

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
    --health-port) health_port="$2"; shift 2 ;;
    --admin-user-id) admin_user_id="$2"; shift 2 ;;
    --render-font) render_font="$2"; shift 2 ;;
    --imagemagick-convert) imagemagick_convert="$2"; shift 2 ;;
    --install-services) install_services=1; shift ;;
    --no-maintenance) install_maintenance=0; shift ;;
    --enable-provider-failover) enable_provider_failover=1; shift ;;
    --no-npm) no_npm=1; shift ;;
    -h|--help) sed -n '1,120p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ "$install_services" -eq 1 ]]; then
  if [[ "$remote_dir" != "/opt/chatbot-qq" || "$config_path" != "/root/.cc-connect-qq/config.toml" || "$env_path" != "/etc/chatbot-qq.env" ]]; then
    echo "--install-services uses the bundled systemd units and requires --remote-dir /opt/chatbot-qq, --config-path /root/.cc-connect-qq/config.toml, and --env-path /etc/chatbot-qq.env." >&2
    exit 2
  fi
fi

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
[[ -n "$admin_user_id" ]] || admin_user_id="$private_user_id"
config_dir="$(dirname "$config_path")"

mkdir -p \
  "$config_dir" \
  "$remote_dir/.cc-connect/codex-home" \
  "$remote_dir/groups/sandbox-$group_id/local_files" \
  "$remote_dir/groups/sandbox-$group_id/memory"
if [[ ! -f "$remote_dir/groups/sandbox-$group_id/local_files/INDEX.md" ]]; then
  cat >"$remote_dir/groups/sandbox-$group_id/local_files/INDEX.md" <<'EOF'
# Local File Index

| Date | Name | Path | Type | Notes |
|---|---|---|---|---|
EOF
fi
if [[ "$config_dir" != "/" && "$config_dir" != "/etc" && "$config_dir" != "/root" ]]; then
  chmod 700 "$config_dir"
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
chmod 600 "$config_path"

mkdir -p "$(dirname "$env_path")"
cat >"$env_path" <<EOF
# OneBot / NapCat upstream exposed only on localhost.
ONEBOT_UPSTREAM_URL=ws://127.0.0.1:3001
ONEBOT_PROXY_PORTS=$listen_port,$at_port${private_user_id:+,$private_port}
ONEBOT_LISTEN_PORT=$listen_port
ONEBOT_AT_PORT=$at_port
ONEBOT_HEALTH_HOST=127.0.0.1
ONEBOT_HEALTH_PORT=$health_port
ONEBOT_PROXY_STATE_FILE=$remote_dir/.cc-connect/onebot-proxy-state.json
ONEBOT_OUTGOING_RETRY_MAX=2
ONEBOT_OUTGOING_RESPONSE_TIMEOUT_MS=12000
ONEBOT_OUTGOING_RETRY_BASE_DELAY_MS=1200

# Long answers and formula-heavy replies are rendered to PNG before sending.
ONEBOT_RENDER_IMAGEMAGICK_SCRIPT=$remote_dir/scripts/render-qq-card-imagemagick.js
ONEBOT_IMAGEMAGICK_CONVERT=$imagemagick_convert
ONEBOT_RENDER_FONT=$render_font

# Runtime retention. Cleanup runs through chatbot-qq-cleanup.timer when maintenance is installed.
CHATBOT_QQ_ROOT=$remote_dir
CHATBOT_QQ_LOG_KEEP_DAYS=14
CHATBOT_QQ_GENERATED_KEEP_DAYS=30
CHATBOT_QQ_ARCHIVE_KEEP_DAYS=90

ONEBOT_ALLOWED_GROUPS=$group_id
ONEBOT_ALLOWED_PRIVATE_USERS=$private_user_id
ONEBOT_PRIVATE_ROUTES=${private_user_id:+$private_user_id:$private_port}
ONEBOT_ADMIN_USERS=$admin_user_id
ONEBOT_ADMIN_ROOT_USERS=$admin_user_id
ONEBOT_ACK_EMOJI_ID=76

# Passive listen gating. Known groups stay low-restriction while avoiding random chatter.
ONEBOT_LISTEN_TRIGGER_MODE=selective
ONEBOT_LISTEN_TRIGGER_KEYWORDS=bot,机器人,助手,codex,qqbot,qq bot,帮我,帮忙,能不能,可以帮,求助,看看,看一下,分析,总结,建议,怎么,为什么,咋,如何,是否,是不是,吗,？,?,报错,错误,失败,修一下,改一下,代码,脚本,实验,作业,报告
ONEBOT_PROFILE_REPLY_MARKERS=触发回复,需要回复,关注点,未解决,重要信息

# Optional group commands.
ONEBOT_DREAM_COMMAND_ENABLED=1
ONEBOT_DREAM_TRIGGERS=/dream,做梦
ONEBOT_DREAM_TIMEOUT_MS=900000
ONEBOT_IMAGE_COMMAND_ENABLED=1
ONEBOT_IMAGE_TRIGGERS=/画图,/生图,/img,画图,生图
ONEBOT_IMAGE_TIMEOUT_MS=600000
ONEBOT_IMAGE_API_MODE=auto
ONEBOT_IMAGE_MAX_CONCURRENT_PER_GROUP=2
ONEBOT_IMAGE_QUEUE_MAX_PER_GROUP=20
ONEBOT_IMAGE_MODEL=gpt-5.5
ONEBOT_IMAGE_IMAGES_MODEL=gpt-image-1
ONEBOT_IMAGE_SIZE=1024x1024
ONEBOT_IMAGE_QUALITY=medium
ONEBOT_IMAGE_OUTPUT_FORMAT=png
# OPENAI_BASE_URL=https://api.openai.com/v1
# OPENAI_API_KEY=replace-me

# Advanced provider failover. Only enable the timer after matching providers exist in config.toml.
# QQ_PROVIDER_PRIMARY_NAME=qq-opentoken
# QQ_PROVIDER_FALLBACK_NAME=qq-mimo-fallback
# QQ_PROVIDER_SOURCE=cc-switch-second-balance
# QQ_OPENTOKEN_BASE_URL=https://otokapi.com
# QQ_OPENTOKEN_API_KEY=replace-me
# QQ_MIMO_PROXY_BASE_URL=http://127.0.0.1:18081/v1
# QQ_MIMO_PROXY_API_KEY=qq-local-mimo
EOF
chmod 600 "$env_path"

if [[ "$no_npm" -ne 1 ]]; then
  cd "$install_root"
  npm install --omit=dev
fi

if [[ "$install_services" -eq 1 ]]; then
  cp "$install_root/deploy/linux/onebot-group-proxy.service" /etc/systemd/system/onebot-group-proxy.service
  cp "$install_root/deploy/linux/cc-connect-qq.service" /etc/systemd/system/cc-connect-qq.service
  if [[ "$install_maintenance" -eq 1 ]]; then
    cp "$install_root/deploy/linux/chatbot-qq-integrity-check.service" /etc/systemd/system/chatbot-qq-integrity-check.service
    cp "$install_root/deploy/linux/chatbot-qq-integrity-check.timer" /etc/systemd/system/chatbot-qq-integrity-check.timer
    cp "$install_root/deploy/linux/chatbot-qq-cleanup.service" /etc/systemd/system/chatbot-qq-cleanup.service
    cp "$install_root/deploy/linux/chatbot-qq-cleanup.timer" /etc/systemd/system/chatbot-qq-cleanup.timer
    rm -f /var/lib/chatbot-qq-integrity/sha256sums.txt
  fi
  if [[ "$enable_provider_failover" -eq 1 ]]; then
    cp "$install_root/deploy/linux/cc-connect-qq-provider-failover.service" /etc/systemd/system/cc-connect-qq-provider-failover.service
    cp "$install_root/deploy/linux/cc-connect-qq-provider-failover.timer" /etc/systemd/system/cc-connect-qq-provider-failover.timer
  fi
  CHATBOT_QQ_ROOT="$remote_dir" bash "$install_root/deploy/linux/chatbot-qq-permission-audit.sh" --fix || true
  systemctl daemon-reload
  systemctl enable onebot-group-proxy.service cc-connect-qq.service
  if [[ "$install_maintenance" -eq 1 ]]; then
    systemctl enable chatbot-qq-integrity-check.timer chatbot-qq-cleanup.timer
  fi
  if [[ "$enable_provider_failover" -eq 1 ]]; then
    systemctl enable cc-connect-qq-provider-failover.timer
  fi
fi

echo "Wrote config: $config_path"
echo "Wrote env:    $env_path"
echo "Start NapCat first, then run:"
echo "  systemctl start onebot-group-proxy cc-connect-qq"
if [[ "$install_services" -eq 1 && "$install_maintenance" -eq 1 ]]; then
  echo "Maintenance timers installed:"
  echo "  systemctl start chatbot-qq-integrity-check.timer chatbot-qq-cleanup.timer"
fi
