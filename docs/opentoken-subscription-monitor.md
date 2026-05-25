# OpenToken Subscription Monitor

This monitor checks otokapi.com purchase plans with a read-only `GET` request and sends a Feishu alert when any configured price or ratio field is less than or equal to the threshold.

It does not call payment, purchase, or subscription creation APIs.

## Configuration

By default, when no token is configured, the script tries to reuse the local Chrome/Edge `otokapi.com` login token from browser localStorage. It uses the token only in memory for the read-only plans request and does not print or save it.

Disable browser token discovery:

```powershell
$env:OTOKAPI_BROWSER_AUTH = "0"
```

Or set one auth source explicitly:

```powershell
$env:OTOKAPI_AUTH_TOKEN = "..."
```

`OTOKAPI_AUTHORIZATION`, `OPENTOKEN_AUTHORIZATION`, `OPENTOKEN_ACCESS_TOKEN`, and `OPENTOKEN_COOKIE` are also accepted for compatibility.

Set one Feishu target:

```powershell
$env:LARK_CHAT_ID = "oc_xxx"
```

or:

```powershell
$env:LARK_USER_ID = "ou_xxx"
```

or use a custom bot webhook:

```powershell
$env:LARK_WEBHOOK_URL = "https://open.feishu.cn/open-apis/bot/v2/hook/..."
$env:LARK_WEBHOOK_SECRET = "optional-signing-secret"
```

Default threshold is `0.02`:

```powershell
$env:OPENTOKEN_SUBSCRIPTION_THRESHOLD = "0.02"
```

Default endpoint is:

```text
https://otokapi.com/api/v1/payment/plans
```

Override it if the upstream endpoint changes:

```powershell
$env:OTOKAPI_PAYMENT_PLANS_URL = "https://otokapi.com/api/v1/payment/plans"
```

Default checked field names are:

```text
rate_multiplier,price_amount,price,amount,ratio,rate,multiplier,discount,倍率
```

Override them if the upstream plan payload changes:

```powershell
$env:OPENTOKEN_SUBSCRIPTION_PRICE_FIELDS = "price_amount,ratio"
```

## Run

List plans without sending:

```powershell
npm run monitor:opentoken-subscriptions -- --list-only
```

Dry-run threshold detection:

```powershell
npm run monitor:opentoken-subscriptions -- --dry-run --threshold 10
```

Run once and send Feishu alert on new hits:

```powershell
npm run monitor:opentoken-subscriptions -- --once --threshold 0.02
```

Run as a foreground loop:

```powershell
npm run monitor:opentoken-subscriptions -- --watch --threshold 0.05
```

`--watch` refreshes the plans endpoint every 60 seconds. Use `--interval-seconds <n>` to override the refresh interval.

The script records sent alert keys in `runs/opentoken-subscription-monitor/state.json` so the same plan metric is not repeatedly sent. Use `--repeat-alerts` for testing repeated sends.

## Windows Scheduled Task

After testing the command manually, register a task with your configured environment in the task action or in a wrapper script. Example action:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "cd C:\chatbot-qq; npm run monitor:opentoken-subscriptions -- --once --threshold 0.02"
```

Keep cookies, tokens, and webhook URLs out of git.
