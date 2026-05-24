# Linux 新手安装指南

本指南用于把 QQ cc-connect 服务部署到 Linux，并与已有 Feishu/OpenClaw cc-connect 服务隔离。

## 准备

- Linux 服务器，推荐 systemd
- Node.js 20 或更高版本
- `cc-connect` 在 `PATH` 中可用
- NapCat 已在服务器或同机容器中登录 QQ
- OneBot v11 WebSocket 监听 `ws://127.0.0.1:3001`
- 可选：ImageMagick 与 Noto CJK 字体，用于把长回复、公式回复渲染成 QQ 图片

安装依赖：

```bash
npm install -g cc-connect
cc-connect --version
# Debian/Ubuntu，可选但推荐
apt-get update
apt-get install -y imagemagick fonts-noto-cjk
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
- 维护定时器 `chatbot-qq-integrity-check.timer` 和 `chatbot-qq-cleanup.timer`

默认新手安装会写入这些云端 Linux 运行参数：

- OneBot 健康检查端口：`127.0.0.1:3010`
- 发送失败重试与超时参数
- 长回复/公式回复的 ImageMagick 渲染路径
- `/dream`、`做梦`、`/画图`、`/生图`、`/img` 命令开关
- 日志、生成图片、群文件归档的保留天数

如果只是刷新配置和服务文件，不想重新安装 npm 依赖：

```bash
bash ./scripts/install-linux.sh --install-services --no-npm
```

如果当前配置已经手动接入双 provider，并且需要启用 provider failover 定时器：

```bash
bash ./scripts/install-linux.sh --install-services --enable-provider-failover --no-npm
```

不要在没有配置 `qq-opentoken` / `qq-mimo-fallback` provider 的情况下启用 failover 定时器。

## 启动

确认 NapCat 已登录并提供 OneBot：

```bash
ss -ltnp | grep 3001
```

启动 QQ 服务：

```bash
systemctl start onebot-group-proxy cc-connect-qq
systemctl status onebot-group-proxy cc-connect-qq --no-pager
systemctl start chatbot-qq-integrity-check.timer chatbot-qq-cleanup.timer
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
systemctl restart chatbot-qq-integrity-check.timer chatbot-qq-cleanup.timer
```

更新后脚本会刷新 systemd 单元、修正代码/配置权限，并重建完整性检查基线。
