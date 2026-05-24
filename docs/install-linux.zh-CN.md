# Linux 新手安装指南

本指南用于把 QQ cc-connect 服务部署到 Linux，并与已有 Feishu/OpenClaw cc-connect 服务隔离。

## 准备

- Linux 服务器，推荐 systemd
- Node.js 20 或更高版本
- `cc-connect` 在 `PATH` 中可用
- NapCat 已在服务器或同机容器中登录 QQ
- OneBot v11 WebSocket 监听 `ws://127.0.0.1:3001`

安装依赖：

```bash
npm install -g cc-connect
cc-connect --version
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

## 启动

确认 NapCat 已登录并提供 OneBot：

```bash
ss -ltnp | grep 3001
```

启动 QQ 服务：

```bash
systemctl start onebot-group-proxy cc-connect-qq
systemctl status onebot-group-proxy cc-connect-qq --no-pager
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
systemctl restart onebot-group-proxy cc-connect-qq
```
