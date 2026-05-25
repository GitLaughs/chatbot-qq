# Windows 新手安装指南

本指南面向第一次部署 QQ 群聊 Codex 机器人的用户。当前推荐路径是 NapCat / OneBot v11 接入 cc-connect 原生 `qq` 平台；官方 QQ Bot API 保留为后续正式路径。

## 准备

- Windows 10/11
- Node.js 20 或更高版本
- 已安装 `cc-connect`
- NapCat 已能登录 QQ，并开启 OneBot v11 WebSocket
- 已准备一个可用的 QQ 群号；可选准备一个允许私聊的 QQ 用户 ID

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

## 插件配置

仓库内置 `dream`、`image`、`reminder` 三个插件示例。新功能优先放到 `plugins/<id>/`，并通过插件配置启停。

查看默认插件配置：

```powershell
Get-Content .\configs\plugins.example.json
```

需要提交到团队仓库的非敏感默认值可以放在 `configs\plugins.json`。只属于本机的启停、群号、用户 ID、接口密钥或临时设置放在：

```text
.cc-connect\plugins.local.json
```

创建新插件：

```powershell
npm run create:plugin -- my-plugin
npm run test:plugins
```

发布前检查插件和隐私边界：

```powershell
npm run plugin:check
```

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

如果机器已经配置了统一的 Windows 隐藏启动包装器，只保留那一个包装器负责启动 NapCat/OneBot 代理和 QQ cc-connect 配置，不要再新增单独的 QQ 自启动脚本。

## 验证

在群里 @ 机器人，确认 cc-connect 能收到并回复。需要排查时运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-cc-connect-napcat.ps1
```

再运行一次发布范围隐私检查，确认没有把本地配置、日志、聊天导出、私有记忆或密钥放进仓库：

```powershell
npm test
```

## 常见问题

- 收不到消息：检查 NapCat 是否开启 OneBot v11 WebSocket，端口是否为 `3001`。
- 不回复群消息：检查 `ONEBOT_ALLOWED_GROUPS` 是否包含目标群号。
- 回复串到别的服务：确认没有复用 Feishu 的 `.cc-connect` 配置目录。
- 插件命令无效：先运行 `npm run test:plugins`，再检查 `configs\plugins.json` 和 `.cc-connect\plugins.local.json`。
- npm 依赖缺失：在仓库根目录运行 `npm install`。
