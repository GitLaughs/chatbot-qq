# AGENTS.md - cc-connect QQ

This project is the QQ adapter workspace for cc-connect bots.

Rules:

- Keep the current NapCat / OneBot + onebot-group-proxy + cc-connect architecture as the primary route.
- Treat official QQ Bot code/docs as fallback or historical reference only; do not steer new work toward official QQ Bot unless explicitly asked.
- QQ numbers and group IDs are routing metadata in this self-use bot, not secrets by themselves.
- Do not commit app secrets, access tokens, cookies, provider keys, NapCat local config, private logs, chat exports, or private memory files.
- Prefer low-restriction, full-feature behavior for known groups and users; avoid over-protection that blocks normal bot functions.
- When modifying a file that came from QQ chat, save the revised file under that chat workspace's `local_files/` tree and mention the saved path in the reply; the proxy will upload that file back to the same private chat or group.
- Keep Feishu-specific rules out of this repo unless documenting cc-connect cross-platform behavior.
- Treat `docs/qqbot-integration-plan.md` as the current implementation plan.
- New bot features should be added as plugins under `plugins/<id>/` and managed by `scripts/lib/plugin-manager.js` whenever practical. Follow `docs/plugin-platform.md`. Include `plugin.json`, `index.js`, config schema/defaults, and plugin-scoped tests. Prefer plugin-level enable/disable switches and settings over more top-level `ONEBOT_*` globals; keep old env vars only as compatibility defaults during migration.
- Local Windows autostart is centralized in `<external-startup-wrapper>\\cc-connect-startup-hidden.vbs`; that single wrapper starts the Windows bot cc-connect, this repo's onebot-group-proxy, and this repo's QQ cc-connect config. Do not add a second QQ-only startup wrapper unless explicitly requested.
