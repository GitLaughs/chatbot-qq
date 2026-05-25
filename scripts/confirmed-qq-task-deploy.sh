#!/usr/bin/env bash
set -euo pipefail

payload="$(cat)"

field() {
  node -e "
const input = JSON.parse(process.env.TASK_PAYLOAD || '{}');
const path = process.argv[1].split('.');
let value = input;
for (const part of path) value = value && value[part];
process.stdout.write(String(value || ''));
" "$1"
}

export TASK_PAYLOAD="$payload"
role="$(field role)"
action="$(field spec.action)"
target="$(field spec.target)"
task_id="$(field task_id)"

if [ "$role" != "deploy_or_restart_executor" ]; then
  echo "invalid role: $role" >&2
  exit 2
fi

case "$action" in
  deploy|restart|reload) ;;
  *) echo "unsupported action: $action" >&2; exit 3 ;;
esac

case "$target" in
  qq-bot|qq|bot|onebot|onebot-group-proxy|cc-connect-qq) ;;
  *) echo "unsupported target: $target" >&2; exit 4 ;;
esac

cd /opt/chatbot-qq

if [ "$action" = "deploy" ]; then
  npm install --omit=dev
fi

restart_cc=0
restart_proxy=0
case "$target" in
  cc-connect-qq) restart_cc=1 ;;
  onebot|onebot-group-proxy) restart_proxy=1 ;;
  qq-bot|qq|bot) restart_cc=1; restart_proxy=1 ;;
esac

if [ "$action" = "reload" ]; then
  restart_cc=1
fi

if [ "$restart_cc" = "1" ]; then
  systemctl restart cc-connect-qq.service
fi

if [ "$restart_proxy" = "1" ]; then
  if command -v systemd-run >/dev/null 2>&1; then
    systemd-run --unit "chatbot-qq-confirmed-restart-${task_id:-manual}" --on-active=3s /bin/systemctl restart onebot-group-proxy.service >/dev/null
  else
    nohup sh -c "sleep 3; systemctl restart onebot-group-proxy.service" >/tmp/chatbot-qq-confirmed-restart.log 2>&1 &
  fi
fi

echo "action=$action target=$target cc_connect_restart=$restart_cc proxy_restart_scheduled=$restart_proxy"
