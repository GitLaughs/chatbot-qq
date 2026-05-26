# CHATBOT-QQ 自用优化简报 2026-05-23

## 已确认现状

- 本地项目目录：`C:\chatbot-qq`。
- GitHub 发布目录：`C:\chatbot-qq-publish`。
- 服务器存在 QQ bridge 进程：`cc-connect --config /root/.cc-connect-qq/config.toml`。
- OneBot proxy 已有 `/healthz`、`/metrics`、选择性监听、画图、文件保存、PDF 解析、成员画像。

## 本轮已落地

- 新增 `docs/daily-group-product-plan.md`：面向朋友日常群聊的自用优化方案。
- 明确 QQ bot 和 codex-feishu 的不同定位：QQ 更人性化、更强画像和个性化，codex-feishu 偏项目生产力。
- 保留发布仓库边界：不发布真实群号、QQ 号、日志、token、NapCat 二进制和本地记忆。

## 下一步执行顺序

1. 给 QQ 发布仓库补 secret audit，发布脱敏源码和模板，不发布私人画像。
2. 继续强化 `/记住`、`/画像`、`/总结今天`、`/dream`，让朋友画像能长期收敛。
3. 把 `get-chatbot-qq-health-report.ps1` 接入每日任务和简短告警。
4. 给每个自用群补 `GROUP_PROFILE.md` 和触发词清单。
5. GitHub 只作为工程备份/脱敏发布，不按公开产品宣传。

## 安全配置边界

- 不继续收紧 QQ 服务的 systemd sandbox、文件权限或网络限制。
- 任何安全配置变更都要先测试 `/status`、`/画像`、`/记住`、`/总结今天`、文件/PDF、画图、OneBot 重连和服务重启恢复。
- 当前优先级是个性化记忆、健康报告、备份恢复和脱敏发布，而不是牺牲功能的强隔离。
