# QQ Bot Authorization and Setup

This repo uses cc-connect native `qqbot` platform support first. The custom Go adapter stays as a fallback experiment.

## 1. Create Official QQ Bot

Open the QQ Bot platform:

https://q.qq.com

Log in with QQ. If the site asks for authorization, use the QR code shown by the QQ web console.

Create or select a bot, then copy:

- AppID
- AppSecret

Do not commit these values.

## 2. Create Local Config

```powershell
cd C:\chatbot-qq
Copy-Item configs\cc-connect.qqbot.example.toml configs\cc-connect.qqbot.local.toml
```

Either set environment variables:

```powershell
$env:QQBOT_APP_ID = "your-app-id"
$env:QQBOT_APP_SECRET = "your-app-secret"
```

Or edit `configs\cc-connect.qqbot.local.toml` locally and replace the placeholders. The local file must stay untracked.

Start in sandbox first:

```toml
sandbox = true
```

Switch to production only after the sandbox gateway and replies work:

```toml
sandbox = false
```

## 3. Run

```powershell
.\scripts\start-cc-connect-qq.ps1
```

Health check:

```powershell
.\scripts\check-cc-connect-qq.ps1
```

## 4. Expected Behavior

- QQ group messages reach the bot only when the bot is mentioned.
- Direct user messages use the user's QQ openid as session identity.
- `share_session_in_channel = false` keeps per-user sessions separate inside a group.
- The agent workspace is `C:\chatbot-qq\groups\default`.

## 5. If Native qqbot Fails

Fallback path:

1. Run the custom Go adapter in `cmd/qqbot-adapter`.
2. Forward normalized events into cc-connect bridge or webhook.
3. Keep this path isolated from the native cc-connect `qqbot` platform until needed.
