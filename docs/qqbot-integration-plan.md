# QQ Bot Integration Plan

## Goal

Add QQ as a first-class cc-connect bot entrypoint without disturbing the existing Feishu `cc-connect` deployment.

OpenClaw is not a required dependency for this adapter. The core scope is QQ messaging plus cc-connect.

## Recommended Path

1. Use NapCat / OneBot v11 as the primary path because official QQ Bot production gateway setup is blocked.
2. Connect cc-connect native `qq` platform to NapCat WebSocket.
3. Configure an isolated QQ project and workspace under `E:\CHATBOT-QQ`.
4. Keep cc-connect native `qqbot` official path as a fallback for later.
5. Keep the standalone Go adapter as a fallback experiment only.

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

- each sandbox group maps locally to `E:\CHATBOT-QQ\groups\sandbox-<group-id>`
- each later QQ group can map to `E:\CHATBOT-QQ\groups\<name>` or another cc-connect-managed workspace root
- group memories follow the existing `KNOWLEDGE.md`, `local_files/INDEX.md`, `memory/YYYY-MM-DD.md` pattern

## Security

- Keep QQ numbers, group IDs, NapCat tokens, cookies, and official app credentials in local ignored files only.
- Do not mix QQ group workspaces with private Windows control bot workspaces.
- Default to `require_at = true` in groups.
- Start with allowlists before enabling full group listening.

## Milestones

1. NapCat starts and QQ account logs in by QR.
2. OneBot v11 WebSocket is reachable at `ws://127.0.0.1:3001`.
3. `configs/cc-connect.napcat.local.toml` is created locally.
4. cc-connect starts with `platform ready` for `qq`.
5. An allowlisted group message reaches its matching `qq-sandbox-<group-id>` workspace.
6. Text reply works from cc-connect through NapCat.
