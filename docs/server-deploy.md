# Server Deployment Notes

## Verdict

This project can run on the current Linux server. The current production route is NapCat / OneBot through `onebot-group-proxy`, then `cc-connect`.

- NapCat / OneBot: primary route for this bot. Keep this adapter path active unless the user explicitly asks to evaluate another route.
- Official QQ Bot: fallback or historical reference only. Do not steer new work toward it unless explicitly requested.

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

## OpenClaw Shared Index Commands

QQ can reuse the OpenClaw deterministic index command layer for read-only lookup commands. This keeps `/files find`, `/memory search`, and `/status index` out of model reasoning.

Before enabling the bridge, deploy or keep `/opt/openclaw/scripts/openclaw-index.py` and `/opt/openclaw/scripts/openclaw-command.py` available on the same server, then build the QQ index:

```bash
python3 /opt/openclaw/scripts/openclaw-index.py --root /opt/chatbot-qq reindex
```

Add these variables to `/etc/chatbot-qq.env`:

```bash
OPENCLAW_COMMAND_SCRIPT=/opt/openclaw/scripts/openclaw-command.py
OPENCLAW_COMMAND_ROOT=/opt/chatbot-qq
OPENCLAW_COMMAND_PYTHON=python3
OPENCLAW_COMMAND_TIMEOUT_MS=8000
OPENCLAW_COMMAND_MAX_CONCURRENT=1
OPENCLAW_COMMAND_MAX_BUFFER=1048576
```

Then restart:

```bash
systemctl restart onebot-group-proxy
```

This bridge is read-only. It does not share Feishu credentials, QQ credentials, or chat sessions; it only lets the QQ proxy call the same local SQLite/FTS5 index tooling.

For index freshness without a watcher or daemon, run the throttled reindex helper from deploy hooks or a conservative timer:

```bash
/opt/openclaw/scripts/openclaw-reindex.sh /opt/chatbot-qq
```

From Windows, first run the local release gate. This is the preferred entry
point after a batch of local intelligence updates:

```powershell
cd C:\chatbot-qq
npm run deploy:check
```

The readiness gate runs the publish test suite, scans for the known fallback key
prefix and other high-signal publish secrets, performs a deployment package
dry-run, and checks cc-switch balances with `-DryRun`. It does not upload files,
write server config, or restart services. Use it to batch several local
optimizations together; deploy only after the batch is ready to interrupt QQ
services briefly.

After the readiness gate passes, sync the folder to the server without deploying
the bundled Windows NapCat package:

```powershell
.\scripts\deploy-napcat-server.ps1
```

Preview the deployment package without uploading or touching the server:

```powershell
.\scripts\deploy-napcat-server.ps1 -DryRun
```

`-DryRun -InstallServices` still only validates the local package and does not
install systemd units.

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
ONEBOT_RENDER_IMAGEMAGICK_SCRIPT=/opt/chatbot-qq/scripts/render-qq-card-imagemagick.js
ONEBOT_IMAGEMAGICK_CONVERT=convert
ONEBOT_RENDER_FONT=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc
ONEBOT_LISTEN_PORT=3002
ONEBOT_AT_PORT=3003
ONEBOT_PRIVATE_ROUTES=200000001:3006,200000002:3007,200000003:3008,200000004:3009
ONEBOT_ACK_EMOJI_ID=76
ONEBOT_CONTINUITY_ENABLED=1
ONEBOT_CONTINUITY_GAP_MINUTES=30
ONEBOT_CONTINUITY_MESSAGE_LIMIT=10
ONEBOT_MOOD_ENABLED=1
ONEBOT_MOOD_HISTORY_LIMIT=10
ONEBOT_ENERGY_WINDOW_MS=300000
ONEBOT_FEEDBACK_ENABLED=1
ONEBOT_FEEDBACK_WINDOW_SECONDS=300
ONEBOT_PROACTIVE_ENABLED=1
ONEBOT_PROACTIVE_LEVEL=normal
ONEBOT_PROACTIVE_COOLDOWN_MS=900000
ONEBOT_PROACTIVE_CHECKIN_HOURS=4
ONEBOT_PROACTIVE_CHECKIN_INTERVAL_MS=1800000
ONEBOT_DREAM_COMMAND_ENABLED=1
ONEBOT_DREAM_TRIGGERS=/dream,做梦
ONEBOT_DREAM_TIMEOUT_MS=900000
CHATBOT_QQ_PROFILE_UPDATE_MODEL=gpt-5.5
CHATBOT_QQ_PROFILE_UPDATE_REASONING_EFFORT=medium
CHATBOT_QQ_PROFILE_UPDATE_LOOKBACK_HOURS=72
ONEBOT_IMAGE_COMMAND_ENABLED=1
ONEBOT_IMAGE_TRIGGERS=/画图,/生图,/img,画图,生图
ONEBOT_IMAGE_MODEL=gpt-5.5
ONEBOT_IMAGE_IMAGES_MODEL=gpt-image-1
ONEBOT_IMAGE_KEY_POOL_MAX=4
ONEBOT_IMAGE_MAX_CONCURRENT_PER_GROUP=4
ONEBOT_IMAGE_SIZE=1024x1024
ONEBOT_IMAGE_QUALITY=medium
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=replace-me
# OPENAI_IMAGE_API_KEYS=key1,key2,key3,key4
QQ_OPENTOKEN_MIN_BALANCE=20
```

For cc-switch OpenToken deployments, first inspect balances without changing the
server:

```powershell
.\scripts\sync-server-keys-from-ccswitch.ps1 -Force -DryRun -MinBalance 20
```

Only sync keys after reviewing the dry-run output. By default, leave services
running and avoid `-RestartServices`; apply restarts only when the chat window is
quiet and the key change must take effect immediately. Ordinary QQ code
deployments should only restart `onebot-group-proxy` and `cc-connect-qq` after
the batch is published. Feishu/OpenClaw key rotation is a separate maintenance
action and should not be coupled to QQ deployments.

QQ provider selection uses the highest-balance healthy OpenToken key available
in the QQ pool. It does not reserve that key for Feishu/OpenClaw.

Install or start Linux NapCat separately. The bundled `tools/NapCat.Shell.Windows.OneKey` package is Windows-only.

For formula-heavy or long answers, the proxy renders the answer into a PNG before sending it to QQ.
On Ubuntu/Debian servers install the renderer dependencies:

```bash
apt-get update
apt-get install -y imagemagick librsvg2-bin fonts-noto-cjk
```

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

The installed systemd units use a bounded runtime profile, but it must not be tightened further without testing the bot's actual chat features.

Minimum permission floor for command-capable services:

- `ProtectSystem=strict` with write access to `/opt/chatbot-qq` for command-capable services, because Codex/bubblewrap may initialize repo mount points such as `.git` before running even read-only commands.
- Most helper services keep `NoNewPrivileges=true`, empty `CapabilityBoundingSet`, and `PrivateTmp=true`.
- `cc-connect-qq.service` and `chatbot-qq-profile-update.service` are exceptions: they must keep `NoNewPrivileges=false`, must not set an empty `CapabilityBoundingSet=`, and must include `AF_NETLINK`.
- Reason: Codex/bubblewrap initializes a network loopback inside its command sandbox. If these permissions are reduced, even `pwd`/`ls` can fail before PDF/file inspection starts with errors such as `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`.
- `chatbot-qq-integrity-check.timer` checks code and deploy files against a SHA256 manifest every 30 minutes and writes `/var/lib/chatbot-qq-integrity/status.json`.
- `chatbot-qq-permission-audit.sh --fix` tightens deployed code/config permissions and writes `/var/lib/chatbot-qq-integrity/permissions.json`.
- `chatbot-qq-cleanup.timer` removes old logs and generated runtime artifacts daily with conservative retention defaults.
- `chatbot-qq-profile-update.timer` runs `gpt-5.5` with medium reasoning every 3 hours to silently update local group/member/private profiles from recent chat JSONL records. It skips workspaces when no chat record is newer than the latest successful profile update.

Do not add stricter sandboxing, path denies, capability bounding, or network restrictions just for hardening. Before accepting any security-related tightening, verify all of these on the server:

```bash
systemd-run --wait --collect \
  --property=WorkingDirectory=/opt/chatbot-qq \
  --property=Environment=HOME=/root/.codex-qq-home \
  --property=Environment=USER=root \
  --property=NoNewPrivileges=false \
  --property=PrivateTmp=true \
  --property=ProtectSystem=strict \
  --property=ProtectHome=false \
  --property='ReadWritePaths=/opt/chatbot-qq /root/.cc-connect-qq /root/.codex-qq-home /var/log' \
  --property='ReadOnlyPaths=/opt/chatbot-qq/AGENTS.md /opt/chatbot-qq/docs /opt/chatbot-qq/configs' \
  --property=RestrictAddressFamilies='AF_INET AF_INET6 AF_UNIX AF_NETLINK' \
  /usr/bin/codex sandbox linux -- /bin/sh -lc 'pwd; ls -ld . local_files 2>/dev/null || true'
```

Then verify `/status`, `/画像`, `/记住`, `/总结今天`, file/PDF handling, image generation, OneBot reconnect, and `cc-connect-qq` restart recovery in the real self-use group.

On the first integrity run, the manifest is initialized under `/var/lib/chatbot-qq-integrity/sha256sums.txt`. After intentional deployment, remove that manifest or run the check once after updating it so the next baseline matches the new code.

Cleanup retention defaults:

```bash
CHATBOT_QQ_LOG_KEEP_DAYS=14
CHATBOT_QQ_GENERATED_KEEP_DAYS=30
CHATBOT_QQ_ARCHIVE_KEEP_DAYS=90
```

Local daily backup from Windows:

```powershell
cd C:\chatbot-qq
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

Generate a machine-readable daily operations report:

```powershell
.\scripts\get-chatbot-qq-health-report.ps1
```

Install the daily health report task. It runs after the default daily backup time:

```powershell
.\scripts\get-chatbot-qq-health-report.ps1 -InstallScheduledTask
```

By default this backs up group/user workspaces and cc-connect runtime data, but skips `/etc/chatbot-qq.env` so API keys are not copied casually. Add `-IncludeSecrets` only when making an encrypted/offline key backup.

Restore a backup to the server:

```powershell
.\scripts\restore-chatbot-qq-server.ps1 -Archive C:\chatbot-qq\backup\server-daily\chatbot-qq-server-YYYYMMDD-HHMMSS.tar.gz -RestartServices
```

Secrets are not restored unless `-RestoreSecrets` is also passed.

Dry-run restore test, without touching live `/opt/chatbot-qq`:

```powershell
.\scripts\test-restore-chatbot-qq-backup.ps1 -Archive C:\chatbot-qq\backup\server-daily\chatbot-qq-server-YYYYMMDD-HHMMSS.tar.gz
```

Check that Feishu stayed active and QQ ports are isolated:

```powershell
.\scripts\check-napcat-server.ps1
```

By default this prints a redacted health summary and log file metadata only. Use
`.\scripts\check-napcat-server.ps1 -RawHealth` for the full `/healthz` JSON, or
`.\scripts\check-napcat-server.ps1 -IncludeLogs` when you explicitly need recent
raw logs.

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
