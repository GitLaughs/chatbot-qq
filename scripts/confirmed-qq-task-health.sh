#!/usr/bin/env bash
set -euo pipefail

systemctl is-active --quiet cc-connect-qq.service
curl -fsS http://127.0.0.1:13110/healthz >/tmp/chatbot-qq-task-health.json
node - <<'NODE'
const fs = require("fs");
const health = JSON.parse(fs.readFileSync("/tmp/chatbot-qq-task-health.json", "utf8"));
if (!health.ok) {
  console.error("proxy healthz not ok");
  process.exit(2);
}
if (!health.upstream || !health.upstream.ready) {
  console.error("onebot upstream not ready");
  process.exit(3);
}
const checks = health.capabilities && health.capabilities.checks ? health.capabilities.checks : {};
if (checks.task_agent && checks.task_agent.ok === false) {
  console.error("task_agent capability not ok");
  process.exit(4);
}
console.log(`health ok upstream=${Boolean(health.upstream && health.upstream.ready)} pending=${JSON.stringify(health.pending || {})}`);
NODE
