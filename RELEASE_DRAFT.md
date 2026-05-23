# chatbot-qq v0.2.12｜profile visibility commands

This release makes personalization visible in chat by adding commands to inspect the group and user profile memory that drives future replies.

中文关键词：QQ 机器人个性化回复、群聊画像、用户偏好、记忆纠偏、cc-connect QQ。

## Highlights

- Adds `/画像`, `画像`, `/我的偏好`, and `我的偏好`.
- In group chats, the command returns recent group facts plus the current member's personal profile entries.
- In private chats, the command returns the user's personal profile entries.
- The reply includes the existing `/记住` and `/忘记` correction path so users can update stale preferences.
- Adds unit coverage for group profile visibility.

## Verify

```powershell
$env:GOPROXY="https://goproxy.cn,direct"
npm test
git diff --check
```

Expected:

- `node scripts/test-onebot-proxy-units.js` includes the new profile command check.
- `/画像` is recognized as a proxy command.
- The command returns both group-level and member-level remembered facts when available.

## Deployment Notes

- This is a chat UX improvement; deploy by restarting `onebot-group-proxy` after updating `scripts/lib/proxy-commands.js`.
- Real server addresses, QQ IDs, and API keys must stay in ignored local files or operator-provided command arguments.

## Full Changelog

See `CHANGELOG.md`.
