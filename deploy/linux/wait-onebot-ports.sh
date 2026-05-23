#!/usr/bin/env bash
set -euo pipefail

ports_csv="${ONEBOT_PROXY_PORTS:-3002,3003,3005,3006,3007,3008,3009}"
timeout_seconds="${ONEBOT_PROXY_PORT_WAIT_SECONDS:-30}"

IFS=',' read -r -a ports <<< "$ports_csv"

for raw_port in "${ports[@]}"; do
  port="${raw_port//[[:space:]]/}"
  if [[ -z "$port" ]]; then
    continue
  fi
  if [[ ! "$port" =~ ^[0-9]+$ ]]; then
    echo "invalid onebot proxy port: $port" >&2
    exit 2
  fi
  for ((i = 1; i <= timeout_seconds; i += 1)); do
    if timeout 1 bash -c "</dev/tcp/127.0.0.1/$port" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  timeout 1 bash -c "</dev/tcp/127.0.0.1/$port" >/dev/null 2>&1
done
