# Linux 新手安装指南

本指南用于把 QQ cc-connect 服务部署到 Linux，并与已有 Feishu/OpenClaw cc-connect 服务隔离。

## 准备

- Linux 服务器，推荐 systemd
- Node.js 20 或更高版本
- `cc-connect` 在 `PATH` 中可用
- NapCat 已在服务器或同机容器中登录 QQ
- OneBot v11 WebSocket 监听 `ws://127.0.0.1:3001`
- 可选：ImageMagick、librsvg2-bin 与 Noto CJK 字体，用于把长回复、公式回复渲染成 QQ 图片

安装依赖：

```bash
npm install -g cc-connect
cc-connect --version
# Debian/Ubuntu，可选但推荐
apt-get update
apt-get install -y imagemagick librsvg2-bin fonts-noto-cjk
```

## 安装

```bash
git clone https://github.com/GitLaughs/chatbot-qq.git /opt/chatbot-qq
cd /opt/chatbot-qq
bash ./scripts/install-linux.sh --install-services
```

脚本会询问：

- 允许接入的 QQ 群号
- 可选的私聊 QQ 用户 ID

脚本会生成：

- `/root/.cc-connect-qq/config.toml`
- `/etc/chatbot-qq.env`
- `/opt/chatbot-qq/groups/sandbox-<group-id>`
- systemd 服务 `onebot-group-proxy.service` 和 `cc-connect-qq.service`
- 画像定时器 `chatbot-qq-profile-update.timer`，每 3 小时用 `gpt-5.5` medium 根据最近群聊/私聊静默更新本地画像；如果没有新聊天早于上次画像更新，会直接跳过以节省资源
- 维护定时器 `chatbot-qq-integrity-check.timer` 和 `chatbot-qq-cleanup.timer`

默认新手安装会写入这些云端 Linux 运行参数：

- OneBot 健康检查端口：`127.0.0.1:13110`
- 发送失败重试与超时参数
- 长回复/公式回复的 ImageMagick 渲染路径
- `/dream`、`做梦`、`/画图`、`/生图`、`/img` 命令开关
- `/help` 分组帮助、命令关键词搜索、`/任务` 自然语言任务状态入口
- 自然语言任务代理默认配置：提醒、轮值、文件修改、脚本生成、部署/重启确认、任务回执和文件回传 outbox
- 记忆管理入口：`/记住`、`/记忆`、`/证据`、`/画像`、`/忘记`、`/候选记忆` 和候选应用/跳过
- 会话连续性、群聊能量/心情、反馈统计和主动参与配置
- 画像更新模型：`gpt-5.5` + medium reasoning，默认读取最近 72 小时聊天记录
- 紧凑证据包和 JSONL 分片阈值，避免画像更新和 dream 直接扫大型原始聊天流水
- 日志、生成图片、群文件归档的保留天数

默认安装不会把任何 key、token、cookie、NapCat 本地配置、私聊导出、群文件或私有记忆写进仓库。安装脚本只生成服务器本机的 `/etc/chatbot-qq.env` 和 `/root/.cc-connect-qq/config.toml`；这些文件应保持 `600` 权限并留在服务器本地。

如果只是刷新配置和服务文件，不想重新安装 npm 依赖：

```bash
bash ./scripts/install-linux.sh --install-services --no-npm
```

如果当前配置已经手动接入双 provider，并且需要启用 provider failover 定时器：

```bash
bash ./scripts/install-linux.sh --install-services --enable-provider-failover --no-npm
```

不要在没有配置 `qq-opentoken` / `qq-mimo-fallback` provider 的情况下启用 failover 定时器。

如果使用 OpenToken key 池，QQ 会选择池子里余额最高且生成探测通过的 key，不再为了 Feishu/OpenClaw 预留最高余额 key。

可选任务执行器只在你明确需要模型解析、自动改文件、生成脚本或确认后部署时配置。留空时会使用确定性回退或交给 cc-connect 处理，不影响基础聊天、记忆、文件和帮助命令。

```bash
# 可选：模型解析自然语言任务
# QQ_TASK_MODEL_PARSER_COMMAND="node /opt/chatbot-qq/scripts/task-model-parser-bridge.js"

# 可选：自动修改/生成 local_files 下的文件产物
# QQ_TASK_FILE_MODIFIER_COMMAND="node /opt/chatbot-qq/scripts/artifact-model-bridge.js"
# QQ_TASK_SCRIPT_GENERATOR_COMMAND="node /opt/chatbot-qq/scripts/artifact-model-bridge.js"

# 可选：管理员确认后才运行的部署/重启命令
# QQ_TASK_DEPLOY_COMMAND="bash /opt/chatbot-qq/scripts/confirmed-qq-task-deploy.sh"
# QQ_TASK_DEPLOY_HEALTH_COMMAND="bash /opt/chatbot-qq/scripts/confirmed-qq-task-health.sh"
```

## 启动

确认 NapCat 已登录并提供 OneBot：

```bash
ss -ltnp | grep 3001
```

启动 QQ 服务：

```bash
systemctl start onebot-group-proxy cc-connect-qq
systemctl status onebot-group-proxy cc-connect-qq --no-pager
systemctl start chatbot-qq-profile-update.timer chatbot-qq-integrity-check.timer chatbot-qq-cleanup.timer
systemctl list-timers 'chatbot-qq-*' --no-pager
```

查看日志：

```bash
journalctl -u onebot-group-proxy -u cc-connect-qq -n 100 --no-pager
tail -n 100 /var/log/onebot-group-proxy.log /var/log/cc-connect-qq.log
```

## 与 Feishu 服务隔离

不要复用以下 Feishu 路径：

- `/root/.cc-connect/config.toml`
- `/opt/openclaw`
- `cc-connect.service`

QQ 默认使用：

- `/root/.cc-connect-qq/config.toml`
- `/opt/chatbot-qq`
- `onebot-group-proxy.service`
- `cc-connect-qq.service`

## 更新

```bash
cd /opt/chatbot-qq
git pull
npm install --omit=dev
bash ./scripts/install-linux.sh --install-services --no-npm
systemctl restart onebot-group-proxy cc-connect-qq
systemctl restart chatbot-qq-profile-update.timer chatbot-qq-integrity-check.timer chatbot-qq-cleanup.timer
```

更新后脚本会刷新 systemd 单元、修正代码/配置权限，并重建完整性检查基线。

## systemd 权限下限

不要为了“安全加固”随意收缩 `cc-connect-qq.service` 和 `chatbot-qq-profile-update.service` 的本地命令执行权限。QQ Bot 需要在这些服务里运行 Codex/bubblewrap 沙箱来读取文件、解析 PDF、生成索引和执行本地辅助脚本。

这两个服务必须保留：

- `NoNewPrivileges=false`
- 不设置空的 `CapabilityBoundingSet=`
- `RestrictAddressFamilies` 包含 `AF_NETLINK`
- `ReadWritePaths` 包含 `/opt/chatbot-qq`、`/root/.codex-qq-home`，`cc-connect-qq.service` 还要包含 `/root/.cc-connect-qq`

如果收缩这些权限，可能出现 `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`，导致 `pwd`、`ls`、PDF 解析前的本地命令都无法启动。

任何安全相关改动上线前，至少验证：

```bash
systemctl restart onebot-group-proxy cc-connect-qq
systemctl is-active onebot-group-proxy cc-connect-qq
curl -fsS http://127.0.0.1:13110/healthz
```

还要在真实 QQ 私聊或群聊里验证文件/PDF、图片渲染、`/status`、`/画像`、`/记住` 和服务重启恢复。
