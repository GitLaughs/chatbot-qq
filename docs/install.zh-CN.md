# Windows 新手安装指南

本指南面向第一次部署 QQ 群聊 Codex 机器人的用户。当前推荐路径是 NapCat / OneBot v11 接入 cc-connect 原生 `qq` 平台；官方 QQ Bot API 保留为后续正式路径。

## 准备

- Windows 10/11
- Node.js 20 或更高版本
- 已安装 `cc-connect`
- NapCat 已能登录 QQ，并开启 OneBot v11 WebSocket

安装 cc-connect：

```powershell
npm install -g cc-connect
cc-connect --version
```

## 安装

```powershell
git clone https://github.com/GitLaughs/chatbot-qq.git
cd chatbot-qq
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -NoStart
```

脚本会询问：

- 允许接入的 QQ 群号
- 可选的私聊 QQ 用户 ID
- 是否安装 npm 依赖

脚本会生成：

- `configs\cc-connect.napcat.local.toml`
- `groups\sandbox-<group-id>\AGENTS.md`
- `groups\sandbox-<group-id>\KNOWLEDGE.md`
- `groups\sandbox-<group-id>\local_files\INDEX.md`

这些本地文件包含群号、私聊 ID 或运行状态，不要提交到 Git。

## 启动

先启动 NapCat，并确认 OneBot v11 WebSocket 地址是：

```text
ws://127.0.0.1:3001
```

再启动 OneBot 代理：

```powershell
$env:ONEBOT_ALLOWED_GROUPS="你的QQ群号"
$env:ONEBOT_PROXY_PORTS="3002,3003"
node .\scripts\onebot-group-proxy.js
```

另开一个终端启动 cc-connect：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-cc-connect-napcat.ps1
```

## 验证

在群里 @ 机器人，确认 cc-connect 能收到并回复。需要排查时运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-cc-connect-napcat.ps1
```

## 常见问题

- 收不到消息：检查 NapCat 是否开启 OneBot v11 WebSocket，端口是否为 `3001`。
- 不回复群消息：检查 `ONEBOT_ALLOWED_GROUPS` 是否包含目标群号。
- 回复串到别的服务：确认没有复用 Feishu 的 `.cc-connect` 配置目录。
- npm 依赖缺失：在仓库根目录运行 `npm install`。
