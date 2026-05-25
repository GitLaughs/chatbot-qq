#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workspace=""
all=0
groups=0
users=0
lookback_hours="${CHATBOT_QQ_PROFILE_UPDATE_LOOKBACK_HOURS:-72}"
model="${CHATBOT_QQ_PROFILE_UPDATE_MODEL:-gpt-5.5}"
reasoning_effort="${CHATBOT_QQ_PROFILE_UPDATE_REASONING_EFFORT:-medium}"
dry_run=0
force=0

if [[ -z "${OPENAI_API_KEY:-}" && -n "${QQ_OPENTOKEN_API_KEY:-}" ]]; then
  export OPENAI_API_KEY="$QQ_OPENTOKEN_API_KEY"
fi
if [[ -z "${OPENAI_BASE_URL:-}" && -n "${QQ_OPENTOKEN_BASE_URL:-}" ]]; then
  export OPENAI_BASE_URL="$QQ_OPENTOKEN_BASE_URL"
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      root="$2"
      shift 2
      ;;
    --workspace)
      workspace="$2"
      shift 2
      ;;
    --all)
      all=1
      shift
      ;;
    --groups)
      groups=1
      shift
      ;;
    --users)
      users=1
      shift
      ;;
    --lookback-hours)
      lookback_hours="$2"
      shift 2
      ;;
    --model)
      model="$2"
      shift 2
      ;;
    --reasoning-effort)
      reasoning_effort="$2"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --force)
      force=1
      shift
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

prompt_path="$root/scripts/profile-updater-prompt.md"
if [[ ! -f "$prompt_path" ]]; then
  echo "prompt missing: $prompt_path" >&2
  exit 1
fi

workspace_list=()
if [[ -n "$workspace" ]]; then
  workspace_list+=("$(cd "$workspace" && pwd)")
elif [[ "$all" -eq 1 || "$groups" -eq 1 || "$users" -eq 1 ]]; then
  bases=()
  if [[ "$all" -eq 1 || "$groups" -eq 1 ]]; then
    bases+=("$root/groups")
  fi
  if [[ "$all" -eq 1 || "$users" -eq 1 ]]; then
    bases+=("$root/users")
  fi
  for base in "${bases[@]}"; do
    [[ -d "$base" ]] || continue
    while IFS= read -r -d '' item; do
      workspace_list+=("$item")
    done < <(find "$base" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z)
  done
else
  echo "Use --workspace <path>, --groups, --users, or --all." >&2
  exit 2
fi

updated=0
skipped=0
lookback_minutes=$(( lookback_hours * 60 ))

for item in "${workspace_list[@]}"; do
  memory_dir="$item/memory"
  mapfile -d '' chat_files < <(
    if [[ -d "$memory_dir" ]]; then
      find "$memory_dir" -maxdepth 1 -type f -name 'chat-*.jsonl' -mmin "-$lookback_minutes" -print0 | sort -z
    fi
  )

  if [[ "${#chat_files[@]}" -eq 0 ]]; then
    echo "skip: no recent chat files in $item"
    skipped=$((skipped + 1))
    continue
  fi

  latest_update=""
  profile_update_dir="$item/memory/profile-updates"
  if [[ -d "$profile_update_dir" ]]; then
    latest_update="$(find "$profile_update_dir" -maxdepth 1 -type f -name '*.md' ! -name '*-last-message.md' -printf '%T@ %p\n' | sort -n | tail -n 1 | cut -d' ' -f2-)"
  fi
  if [[ "$force" -ne 1 && -n "$latest_update" ]]; then
    has_new_chat=0
    for file in "${chat_files[@]}"; do
      if [[ "$file" -nt "$latest_update" ]]; then
        has_new_chat=1
        break
      fi
    done
    if [[ "$has_new_chat" -eq 0 ]]; then
      echo "skip: no new chat since last profile update in $item"
      skipped=$((skipped + 1))
      continue
    fi
  fi

  profile_dir="$item/memory/profile-updates"
  mkdir -p "$profile_dir"
  stamp="$(date +%Y%m%d-%H%M%S)"
  evidence_rel="memory/profile-updates/$stamp-evidence.md"
  evidence_path="$item/$evidence_rel"
  source_map_rel="memory/profile-updates/$stamp-source-map.jsonl"
  source_map_path="$item/$source_map_rel"
  last_message_path="$profile_dir/$stamp-last-message.md"
  event_log_path="$profile_dir/$stamp-events.log"
  run_note="memory/profile-updates/$stamp.md"

  chat_list=""
  for file in "${chat_files[@]}"; do
    rel="${file#$item/}"
    chat_list+="- $rel"$'\n'
  done

  if [[ "$dry_run" -eq 1 ]]; then
    echo "dry-run: would update $item from ${#chat_files[@]} chat file(s)"
    continue
  fi

  node "$root/scripts/build-profile-update-packet.js" \
    --workspace "$item" \
    --lookback-hours "$lookback_hours" \
    --output "$evidence_path" \
    --source-map-output "$source_map_path" >/dev/null

  {
    cat "$prompt_path"
    cat <<PROMPT

Run context:

- Workspace: $item
- Lookback hours: $lookback_hours
- Evidence packet: $evidence_rel
- Source map for manual debugging only: $source_map_rel
- Run note target: $run_note

Use the evidence packet as the only chat evidence for this run. Do not read raw memory/chat-*.jsonl files unless the user explicitly asks for forensic debugging.
PROMPT
  } | codex exec \
    --ephemeral \
    --disable memories \
    -C "$item" \
    --skip-git-repo-check \
    --dangerously-bypass-approvals-and-sandbox \
    -m "$model" \
    -c "model_reasoning_effort=\"$reasoning_effort\"" \
    -o "$last_message_path" \
    - >"$event_log_path" 2>&1

  if [[ -f "$last_message_path" ]]; then
    cat "$last_message_path"
    printf '\n'
  else
    echo "profile update complete: $item"
  fi
  updated=$((updated + 1))
done

echo "profile updater done: updated=$updated skipped=$skipped model=$model reasoning=$reasoning_effort lookback_hours=$lookback_hours"
