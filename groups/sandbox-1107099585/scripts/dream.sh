#!/usr/bin/env bash
set -euo pipefail

workspace="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
prompt_path="$workspace/scripts/dream_prompt.md"
dream_dir="$workspace/memory/dreams"
stamp="$(date +%Y%m%d-%H%M%S)"
last_message_path="$dream_dir/$stamp-last-message.md"
log_path="$dream_dir/$stamp-events.jsonl"

if [[ ! -d "$workspace" ]]; then
  echo "workspace missing: $workspace" >&2
  exit 1
fi
if [[ ! -f "$prompt_path" ]]; then
  echo "prompt missing: $prompt_path" >&2
  exit 1
fi

mkdir -p "$dream_dir"

set +e
codex exec \
  --ephemeral \
  --disable memories \
  -C "$workspace" \
  --skip-git-repo-check \
  --dangerously-bypass-approvals-and-sandbox \
  -m gpt-5.5 \
  -c 'model_reasoning_effort="xhigh"' \
  -o "$last_message_path" \
  - <"$prompt_path" >"$log_path" 2>&1
exit_code=$?
set -e

if [[ "$exit_code" -ne 0 ]]; then
  echo "dream failed: codex exit $exit_code. log: memory/dreams/$stamp-events.jsonl"
  exit "$exit_code"
fi

if [[ -f "$last_message_path" ]]; then
  python3 - "$last_message_path" "$stamp" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
stamp = sys.argv[2]
text = path.read_text(encoding="utf-8", errors="replace").strip()
if len(text) > 1200:
    text = text[:1200] + f"\n...(truncated; see memory/dreams/{stamp}-last-message.md)"
print(text)
PY
else
  echo "dream complete. event log: memory/dreams/$stamp-events.jsonl"
fi
