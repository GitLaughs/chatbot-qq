# QQ Bot Integration Plan

## Goal

Add QQ as a first-class cc-connect bot entrypoint without disturbing the existing Feishu `cc-connect` deployment.

OpenClaw is not a required dependency for this adapter. The core scope is QQ messaging plus cc-connect.

This project is a self-use QQ bot for known groups and private users. The product direction is low restriction and full features, with deterministic code handling repeatable work and models reserved for explicit high-value commands and review.

## Recommended Path

1. Use NapCat / OneBot v11 as the primary path.
2. Connect cc-connect native `qq` platform to NapCat WebSocket.
3. Configure an isolated QQ project and workspace under `C:\chatbot-qq`.
4. Keep `onebot-group-proxy` as the adapter/control layer for group/private routing, admin commands, memory, files, proposals, and self-iteration commands.
5. Treat official QQ Bot and the standalone Go adapter as fallback or historical experiments only. Do not steer new implementation work toward official QQ Bot unless explicitly requested.

## MVP Scope

Incoming:

- group message events
- direct user message events
- @ mention filtering

Outgoing:

- plain text reply
- plain text reply through OneBot `send_msg`

Session keys:

- cc-connect `qq` platform session keys from QQ user/group IDs

Workspace layout:

- sandbox group `123456789` maps to `C:\chatbot-qq\groups\sandbox-123456789`
- each later QQ group can map to `C:\chatbot-qq\groups\<name>` or another cc-connect-managed workspace root
- group memories follow the existing `KNOWLEDGE.md`, `local_files/INDEX.md`, `memory/YYYY-MM-DD.md` pattern

## Security

- QQ numbers and group IDs are routing metadata for this self-use bot. They are not secrets by themselves.
- Keep NapCat tokens, cookies, official app credentials, provider keys, private logs, chat exports, and private memory files in local ignored files only.
- Do not mix QQ group workspaces with private Windows control bot workspaces.
- Use allowlists for known groups and private users, but avoid over-protective rules that block normal features.
- Group trigger mode can be `selective`, `mention`, `all`, or `off` per route. Do not force `require_at = true` as a global default.

## Self-Iteration Rules

- Prefer deterministic commands and JSONL/Markdown state over per-message model work.
- Every meaningful upgrade should stay current-workspace scoped unless explicitly requested otherwise.
- Use sub-agent review for ideas and risks, but do not let review agents change the architecture toward official QQ Bot, vector databases, always-on local LLMs, per-message summaries, recursive self-deploy, or broad cross-group search.
- Admin `100000001` can control the bot through private admin routes, while ordinary chat and memory behavior stays scoped like normal users.

## Milestones

1. NapCat starts and QQ account logs in by QR.
2. OneBot v11 WebSocket is reachable at `ws://127.0.0.1:3001`.
3. `configs/cc-connect.napcat.local.toml` is created locally.
4. cc-connect starts with `platform ready` for `qq`.
5. Group `123456789` message reaches `qq-sandbox-123456789`.
6. Text reply works from cc-connect through NapCat.
