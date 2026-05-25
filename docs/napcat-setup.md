# NapCat / OneBot QQ Setup

Official QQ Bot is blocked for now. Use NapCat as the primary route:

QQ account -> NapCat -> OneBot v11 WebSocket -> cc-connect `type = "qq"` -> Codex.

## 1. Install NapCat

Use the current NapCat project:

https://github.com/NapNeko/NapCatQQ

Docs:

https://napneko.github.io/

Windows easiest path:

1. Download the latest Windows shell / one-key package from NapCat releases.
2. Start NapCat.
3. Log in with your QQ account by scanning the QR code shown by NapCat.
4. Open NapCat WebUI. Common local address is `http://127.0.0.1:6099`.

Docker path, if Docker Desktop works:

```powershell
docker run -d --name napcat `
  -p 3001:3001 `
  -p 6099:6099 `
  mlikiowa/napcat-docker:latest
```

## 2. Enable OneBot v11 WebSocket

In NapCat WebUI:

1. Open network / OneBot settings.
2. Add or enable Forward WebSocket / WebSocket server for OneBot v11.
3. Use:

```text
ws://127.0.0.1:3001
```

If you set an access token in NapCat, put the same value in `configs\cc-connect.napcat.local.toml`.

## 3. Start cc-connect

```powershell
cd C:\chatbot-qq
Copy-Item configs\cc-connect.napcat.example.toml configs\cc-connect.napcat.local.toml
.\scripts\start-cc-connect-napcat.ps1
```

Health check:

```powershell
.\scripts\check-cc-connect-napcat.ps1
```

## 4. Security

- Current cc-connect config is limited to QQ group `123456789`.
- QQ numbers and group IDs are routing metadata, but generated configs that contain them stay local.
- Do not commit cookies, tokens, private logs, chat exports, memory files, or NapCat local config.
- Keep this route separate from the official QQ Bot fallback.
