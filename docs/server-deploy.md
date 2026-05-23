# Server Deployment Notes

## Verdict

This project can run on the current Linux server, but the two QQ routes have different risk and conflict profiles.

- Official QQ Bot: easiest to deploy on Linux. `cc-connect` already supports `type = "qqbot"` and uses outbound WebSocket, so no public inbound port is needed.
- NapCat / OneBot: possible on Linux only if NapCat runs there, usually through Docker or another Linux NapCat install. The bundled `tools/NapCat.Shell.Windows.OneKey` package is Windows-only and should not be deployed.

The existing OpenClaw Feishu service on the server is `/etc/systemd/system/cc-connect.service` with config `/root/.cc-connect/config.toml`. Do not overwrite it.

## Known Server State

- Existing service: `cc-connect`
- Existing config: `/root/.cc-connect/config.toml`
- Existing work dir: `/opt/openclaw`
- Existing server path to use for QQ: `/opt/chatbot-qq`
- Existing local listen ports seen during review: `22`, `53`, `18081`
- `cc-connect` version supports both `QQ` and `QQ Bot`

## Recommended Deployment

Run QQ as a separate service first:

- repository: `/opt/chatbot-qq`
- config: `/root/.cc-connect-qq/config.toml`
- data dir: `/opt/chatbot-qq/.cc-connect`
- service names: `onebot-group-proxy` and `cc-connect-qq`

This avoids mixing QQ sessions, group files, and credentials into the Feishu/OpenClaw service.

## NapCat / OneBot Path

Use this path for the current deployment.

Protection rules:

- leave `/etc/systemd/system/cc-connect.service` unchanged
- leave `/root/.cc-connect/config.toml` unchanged
- write QQ config only to `/root/.cc-connect-qq/config.toml`
- write QQ workspace only to `/opt/chatbot-qq`

Ports:

- NapCat upstream OneBot WebSocket: `127.0.0.1:3001`
- group `100000001` listen / @ proxy: `127.0.0.1:3002` / `127.0.0.1:3003`
- group `100000002` @ proxy only: `127.0.0.1:3005`; no listen proxy is opened for this group
- private user `200000001` proxy: `127.0.0.1:3006`
- private user `200000002` proxy: `127.0.0.1:3007`
- private user `200000003` proxy: `127.0.0.1:3008`
- private user `200000004` proxy: `127.0.0.1:3009`
- OneBot proxy health check: `127.0.0.1:3010/healthz`

From Windows, sync the folder to the server without deploying the bundled Windows NapCat package:

```powershell
cd E:\CHATBOT-QQ
.\scripts\deploy-napcat-server.ps1
```

Install the isolated systemd service files, but do not start them yet:

```powershell
.\scripts\deploy-napcat-server.ps1 -InstallServices
```

The script refuses to use `/root/.cc-connect` or `/opt/openclaw` as QQ targets.

On the server, edit `/etc/chatbot-qq.env` and keep only the approved QQ group IDs:

```bash
ONEBOT_ALLOWED_GROUPS=100000001,100000002
ONEBOT_ALLOWED_PRIVATE_USERS=200000001,200000002,200000003,200000004
ONEBOT_UPSTREAM_URL=ws://127.0.0.1:3001
ONEBOT_PROXY_PORTS=3002,3003,3005,3006,3007,3008,3009
ONEBOT_HEALTH_HOST=127.0.0.1
ONEBOT_HEALTH_PORT=3010
ONEBOT_OUTGOING_RETRY_MAX=2
ONEBOT_OUTGOING_RESPONSE_TIMEOUT_MS=12000
ONEBOT_OUTGOING_RETRY_BASE_DELAY_MS=1200
ONEBOT_LISTEN_PORT=3002
ONEBOT_AT_PORT=3003
ONEBOT_PRIVATE_ROUTES=200000001:3006,200000002:3007,200000003:3008,200000004:3009
ONEBOT_ACK_EMOJI_ID=76
ONEBOT_DREAM_COMMAND_ENABLED=1
ONEBOT_DREAM_TRIGGERS=/dream,做梦
ONEBOT_DREAM_TIMEOUT_MS=900000
ONEBOT_IMAGE_COMMAND_ENABLED=1
ONEBOT_IMAGE_TRIGGERS=/画图,/生图,/img,画图,生图
ONEBOT_IMAGE_MODEL=gpt-5.5
ONEBOT_IMAGE_IMAGES_MODEL=gpt-image-1
ONEBOT_IMAGE_SIZE=1024x1024
ONEBOT_IMAGE_QUALITY=medium
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=replace-me
```

Install or start Linux NapCat separately. The bundled `tools/NapCat.Shell.Windows.OneKey` package is Windows-only.

If using Docker, start from:

```bash
cd /opt/chatbot-qq/deploy/linux
cp napcat-compose.example.yml docker-compose.yml
docker compose up -d
```

After NapCat is logged in and exposes `ws://127.0.0.1:3001`, start the isolated QQ services:

```bash
systemctl start onebot-group-proxy
systemctl start cc-connect-qq
```

The installed systemd units use a tighter sandbox than the first prototype:

- `ProtectSystem=strict` with write access only to QQ runtime data.
- `NoNewPrivileges=true`, empty `CapabilityBoundingSet`, `PrivateTmp=true`.
- `chatbot-qq-integrity-check.timer` checks code and deploy files against a SHA256 manifest every 30 minutes.
- `chatbot-qq-cleanup.timer` removes old logs and generated runtime artifacts daily with conservative retention defaults.

On the first integrity run, the manifest is initialized under `/var/lib/chatbot-qq-integrity/sha256sums.txt`. After intentional deployment, remove that manifest or run the check once after updating it so the next baseline matches the new code.

Cleanup retention defaults:

```bash
CHATBOT_QQ_LOG_KEEP_DAYS=14
CHATBOT_QQ_GENERATED_KEEP_DAYS=30
CHATBOT_QQ_ARCHIVE_KEEP_DAYS=90
```

Local daily backup from Windows:

```powershell
cd E:\CHATBOT-QQ
.\scripts\backup-chatbot-qq-server.ps1 -InstallScheduledTask
```

Manual backup:

```powershell
.\scripts\backup-chatbot-qq-server.ps1
```

Check backup freshness, archive existence, byte count, SHA256, and the Windows scheduled task:

```powershell
.\scripts\check-backup-status.ps1
```

By default this backs up group/user workspaces and cc-connect runtime data, but skips `/etc/chatbot-qq.env` so API keys are not copied casually. Add `-IncludeSecrets` only when making an encrypted/offline key backup.

Restore a backup to the server:

```powershell
.\scripts\restore-chatbot-qq-server.ps1 -Archive E:\CHATBOT-QQ\backup\server-daily\chatbot-qq-server-YYYYMMDD-HHMMSS.tar.gz -RestartServices
```

Secrets are not restored unless `-RestoreSecrets` is also passed.

Dry-run restore test, without touching live `/opt/chatbot-qq`:

```powershell
.\scripts\test-restore-chatbot-qq-backup.ps1 -Archive E:\CHATBOT-QQ\backup\server-daily\chatbot-qq-server-YYYYMMDD-HHMMSS.tar.gz
```

Check that Feishu stayed active and QQ ports are isolated:

```powershell
.\scripts\check-napcat-server.ps1
```

## Official QQ Bot Fallback

Use this only if the QQ platform app can receive sandbox or production events.

```bash
mkdir -p /opt/chatbot-qq /root/.cc-connect-qq
cp /opt/chatbot-qq/configs/cc-connect.qqbot.server.example.toml /root/.cc-connect-qq/config.toml
chmod 700 /root/.cc-connect-qq
```

Set secrets in `/etc/chatbot-qq.env`:

```bash
QQBOT_APP_ID=replace-me
QQBOT_APP_SECRET=replace-me
```

Then use `cc-connect-qq.service`.

## Conflict Checklist

- Do not reuse `/root/.cc-connect/config.toml` unless intentionally merging with OpenClaw.
- Do not set `data_dir = "/root/.cc-connect"` for QQ.
- Do not deploy `tools/NapCat.Shell.Windows.OneKey` to Linux.
- Keep OneBot ports `3001` through `3009` unique.
- Keep health port `3010` local-only.
- Keep QQ group workspaces under `/opt/chatbot-qq/groups`, not `/opt/openclaw`.
- Keep QQ private workspaces under `/opt/chatbot-qq/users`, not in group folders.
- Keep secrets in `/etc/chatbot-qq.env` or ignored local config files.
- Before and after deployment, `systemctl is-active cc-connect` should stay `active`.
