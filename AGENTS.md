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
