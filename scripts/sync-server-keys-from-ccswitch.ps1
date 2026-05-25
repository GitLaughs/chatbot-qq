param(
    [string]$Server = "root@43.108.37.203",
    [string]$CcSwitchDb = "$env:USERPROFILE\.cc-switch\cc-switch.db",
    [double]$MinBalance = 1,
    [int]$MinIntervalHours = 20,
    [switch]$Force,
    [switch]$DryRun,
    [switch]$RestartServices
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$StateDir = Join-Path $Root "runs\key-sync"
$StateFile = Join-Path $StateDir "LATEST.json"

function Step([string]$Message) {
    Write-Host "==> $Message"
}

function Assert-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing command on PATH: $Name"
    }
}

function ConvertTo-Base64Utf8([string]$Value) {
    return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Value))
}

function Read-LastRun {
    if (-not (Test-Path -LiteralPath $StateFile)) {
        return $null
    }
    try {
        return Get-Content -Raw -LiteralPath $StateFile | ConvertFrom-Json
    } catch {
        return $null
    }
}

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

if (-not $Force) {
    $last = Read-LastRun
    if ($null -ne $last -and $last.PSObject.Properties.Match("time").Count) {
        $lastTime = [DateTimeOffset]::Parse([string]$last.time)
        $ageHours = ((Get-Date) - $lastTime.LocalDateTime).TotalHours
        if ($ageHours -lt $MinIntervalHours) {
            Step ("Skip: last successful sync was {0:N1} hours ago. Use -Force to run now." -f $ageHours)
            return
        }
    }
}

Assert-Command python
Assert-Command ssh
if (-not (Test-Path -LiteralPath $CcSwitchDb)) {
    throw "cc-switch database not found: $CcSwitchDb"
}

$extractPython = @'
import json
import pathlib
import re
import sqlite3
import sys
import urllib.error
import urllib.request

db_path = pathlib.Path(sys.argv[1])
min_balance = float(sys.argv[2])

def parse_json(value, default):
    if not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default

def parse_config(text):
    model = ""
    base_url = ""
    provider_name = ""
    in_provider = False
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("["):
            in_provider = line.startswith("[model_providers.")
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key == "model" and not model:
            model = value
        if in_provider and key == "base_url":
            base_url = value
        if in_provider and key == "name":
            provider_name = value
    return provider_name, base_url, model

def auth_key(value):
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key in ("apiKey", "api_key", "key", "token"):
            item = value.get(key)
            if isinstance(item, str) and item.strip():
                return item.strip()
    return ""

def find_number(value, names):
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).lower() in names and isinstance(item, (int, float)):
                return float(item)
            found = find_number(item, names)
            if found is not None:
                return found
    if isinstance(value, list):
        for item in value:
            found = find_number(item, names)
            if found is not None:
                return found
    return None

def usage_balance(base_url, api_key):
    url = base_url.rstrip("/") + "/v1/usage"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": "Bearer " + api_key,
            "Accept": "application/json",
        },
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read().decode("utf-8", errors="replace"))
    balance = find_number(data, {"balance", "credit", "credits", "remain", "remaining", "quota"})
    valid = data.get("is_active", data.get("isValid", True))
    if balance is None:
        raise RuntimeError("usage response missing balance")
    return bool(valid), float(balance)

con = sqlite3.connect(str(db_path))
con.row_factory = sqlite3.Row
providers = []
for row in con.execute("""
    select id, name, app_type, settings_config, meta, sort_index
    from providers
    where app_type = 'codex'
    order by sort_index
"""):
    settings = parse_json(row["settings_config"], {})
    meta = parse_json(row["meta"], {})
    usage = meta.get("usage_script") or {}
    provider_name, config_base_url, config_model = parse_config(settings.get("config") or "")
    api_key = auth_key(usage.get("apiKey")) or auth_key(settings.get("auth")) or auth_key(settings.get("api_key"))
    base_url = (usage.get("baseUrl") or config_base_url or "").rstrip("/")
    model = config_model or usage.get("model") or "gpt-5.5"
    looks_opentoken = str(row["id"]).startswith("opentoken-") or "otokapi.com" in base_url.lower()
    if not looks_opentoken or not api_key or not base_url:
        continue
    item = {
        "id": row["id"],
        "name": row["name"],
        "base_url": base_url,
        "api_key": api_key,
        "model": model,
        "balance": None,
        "healthy": False,
        "error": "",
    }
    try:
        valid, balance = usage_balance(base_url, api_key)
        item["balance"] = balance
        item["healthy"] = valid and balance > min_balance
    except Exception as exc:
        item["error"] = str(exc)
    providers.append(item)

healthy = [item for item in providers if item["healthy"]]
healthy.sort(key=lambda item: item["balance"], reverse=True)
if not healthy:
    raise SystemExit("no healthy OpenToken providers found in cc-switch")

primary = healthy[0]
qq = healthy[0]
qq_pool = healthy[:4]
payload = {
    "primary": primary,
    "qq": qq,
    "qq_pool": qq_pool,
    "healthy_count": len(healthy),
    "provider_summary": [
        {
            "id": item["id"],
            "name": item["name"],
            "base_url": item["base_url"],
            "model": item["model"],
            "balance": item["balance"],
            "healthy": item["healthy"],
            "error": item["error"][:160],
        }
        for item in providers
    ],
}
print(json.dumps(payload, ensure_ascii=False))
'@

Step "Reading healthy OpenToken providers from cc-switch"
$extractScript = Join-Path $StateDir "extract-opentoken-providers.py"
Set-Content -LiteralPath $extractScript -Value $extractPython -Encoding UTF8
$payloadJson = & python $extractScript $CcSwitchDb $MinBalance
if ($LASTEXITCODE -ne 0) {
    throw "Failed to read cc-switch providers"
}
$payload = $payloadJson | ConvertFrom-Json

Step ("Healthy OpenToken providers: {0}" -f $payload.healthy_count)
foreach ($provider in @($payload.provider_summary)) {
    $balance = if ($null -ne $provider.balance) { "{0:N2}" -f ([double]$provider.balance) } else { "n/a" }
    $state = if ($provider.healthy) { "healthy" } else { "skip" }
    Write-Host ("  - {0}: {1}, balance={2}, base={3}" -f $provider.name, $state, $balance, $provider.base_url)
}
Write-Host ("Selected Feishu/OpenClaw provider: {0}" -f $payload.primary.name)
Write-Host ("Selected QQ provider: {0}" -f $payload.qq.name)

if ($DryRun) {
    Step "Dry run only; no server files changed"
    return
}

$remotePython = @'
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time

payload = json.load(sys.stdin)
stamp = time.strftime("%Y%m%d-%H%M%S")

FILES = {
    "openclaw_env": pathlib.Path("/etc/openclaw.env"),
    "qq_env": pathlib.Path("/etc/chatbot-qq.env"),
    "openclaw_config": pathlib.Path("/root/.cc-connect/config.toml"),
    "qq_config": pathlib.Path("/root/.cc-connect-qq/config.toml"),
}

def backup(path):
    if not path.exists():
        return None
    target = path.with_name(path.name + ".key-sync-" + stamp + ".bak")
    shutil.copy2(path, target)
    os.chmod(target, 0o600)
    return str(target)

def write_secret_file(path, text):
    path.write_text(text, encoding="utf-8")
    os.chmod(path, 0o600)

def set_env(path, updates):
    if path.exists():
        lines = path.read_text(encoding="utf-8").splitlines()
    else:
        lines = []
    seen = set()
    out = []
    for line in lines:
        stripped = line.strip()
        replaced = False
        for key, value in updates.items():
            if re.match(r"^#?\s*" + re.escape(key) + r"\s*=", stripped):
                out.append(f"{key}={value}")
                seen.add(key)
                replaced = True
                break
        if not replaced:
            out.append(line)
    for key, value in updates.items():
        if key not in seen:
            out.append(f"{key}={value}")
    text = "\n".join(out).rstrip() + "\n"
    write_secret_file(path, text)

def toml_quote(value):
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'

def replace_otokapi_keys(path, api_key):
    if not path.exists():
        return 0
    lines = path.read_text(encoding="utf-8").splitlines()
    out = []
    current = []
    changed = 0

    def flush(block):
        nonlocal changed
        if not block:
            return []
        joined = "\n".join(block).lower()
        is_provider = "[[projects.agent" in joined and "providers]]" in joined
        is_otokapi = is_provider and (
            "otokapi.com" in joined
            or "opentoken" in joined
            or "family-opentoken" in joined
            or "qq-opentoken" in joined
        )
        if not is_otokapi:
            return block
        new_block = []
        replaced = False
        for item in block:
            if re.match(r"^\s*api_key\s*=", item):
                indent = item[: len(item) - len(item.lstrip())]
                new_line = indent + "api_key = " + toml_quote(api_key)
                if new_line != item:
                    changed += 1
                new_block.append(new_line)
                replaced = True
            else:
                new_block.append(item)
        if not replaced:
            inserted = []
            done = False
            for item in new_block:
                inserted.append(item)
                if not done and re.match(r"^\s*name\s*=", item):
                    inserted.append("api_key = " + toml_quote(api_key))
                    changed += 1
                    done = True
            new_block = inserted if done else new_block + ["api_key = " + toml_quote(api_key)]
        return new_block

    for line in lines:
        if line.strip().startswith("[[projects.agent") and "providers]]" in line:
            out.extend(flush(current))
            current = [line]
        else:
            current.append(line)
    out.extend(flush(current))
    if changed:
        write_secret_file(path, "\n".join(out).rstrip() + "\n")
    return changed

backups = []
for path in FILES.values():
    item = backup(path)
    if item:
        backups.append(item)

primary = payload["primary"]
qq = payload["qq"]
openclaw_key = primary["api_key"]
qq_key = qq["api_key"]
openclaw_base = primary["base_url"].rstrip("/")
qq_base = qq["base_url"].rstrip("/")
qq_pool = payload.get("qq_pool") or [qq]
qq_pool = qq_pool[:4]
qq_pool_keys = []
qq_pool_bases = []
for item in qq_pool:
    key = item.get("api_key", "")
    base = item.get("base_url", "").rstrip("/")
    if not key or key in qq_pool_keys:
        continue
    qq_pool_keys.append(key)
    qq_pool_bases.append(base + "/v1" if not base.endswith("/v1") else base)
if not qq_pool_keys:
    qq_pool_keys = [qq_key]
    qq_pool_bases = [qq_base + "/v1" if not qq_base.endswith("/v1") else qq_base]

set_env(FILES["openclaw_env"], {
    "OPENAI_API_KEY": openclaw_key,
    "FEISHU_IMAGE_BASE_URL": openclaw_base + "/v1",
    "FEISHU_IMAGE_API_KEY": openclaw_key,
})
set_env(FILES["qq_env"], {
    "QQ_OPENTOKEN_BASE_URL": qq_base,
    "QQ_OPENTOKEN_API_KEY": qq_key,
    "QQ_OPENTOKEN_POOL_KEYS": ",".join(qq_pool_keys),
    "QQ_PROVIDER_SOURCE": "local-ccswitch-sync",
    "QQ_OPENTOKEN_MIN_HEALTHY_KEYS": "1",
    "OPENAI_BASE_URL": qq_pool_bases[0],
    "OPENAI_IMAGE_API_KEY": qq_pool_keys[0],
    "OPENAI_IMAGE_API_KEYS": ",".join(qq_pool_keys),
    "OPENAI_IMAGE_BASE_URLS": ",".join(qq_pool_bases),
    "ONEBOT_IMAGE_KEY_POOL_MAX": str(len(qq_pool_keys)),
    "ONEBOT_IMAGE_MAX_CONCURRENT_PER_GROUP": str(len(qq_pool_keys)),
})

openclaw_changed = replace_otokapi_keys(FILES["openclaw_config"], openclaw_key)
qq_changed = replace_otokapi_keys(FILES["qq_config"], qq_key)

for pattern in (
    "/etc/*.key-sync-*.bak",
    "/root/.cc-connect/*.key-sync-*.bak",
    "/root/.cc-connect-qq/*.key-sync-*.bak",
):
    pass

if "--restart" in sys.argv:
    for service in ("cc-connect.service", "onebot-group-proxy.service", "cc-connect-qq.service"):
        subprocess.run(["systemctl", "restart", service], check=False)

print(json.dumps({
    "time": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    "backups": backups,
    "openclaw_provider": primary["name"],
    "qq_provider": qq["name"],
    "openclaw_config_key_updates": openclaw_changed,
    "qq_config_key_updates": qq_changed,
    "qq_image_key_pool_size": len(qq_pool_keys),
    "restarted": "--restart" in sys.argv,
}, ensure_ascii=False))
'@

$encodedRemotePython = ConvertTo-Base64Utf8 $remotePython
Step "Uploading remote key-sync helper"
$installRemote = "python3 - <<'PY'`nimport base64, pathlib, os`npath=pathlib.Path('/tmp/chatbot-qq-key-sync.py')`npath.write_text(base64.b64decode('$encodedRemotePython').decode('utf-8'), encoding='utf-8')`nos.chmod(path, 0o700)`nPY"
ssh $Server $installRemote
if ($LASTEXITCODE -ne 0) {
    throw "Failed to upload remote helper"
}

$remoteArgs = if ($RestartServices) { "--restart" } else { "" }
Step "Syncing server keys"
$remoteOutput = $payloadJson | ssh $Server "python3 /tmp/chatbot-qq-key-sync.py $remoteArgs"
if ($LASTEXITCODE -ne 0) {
    throw "Remote key sync failed"
}
$remoteResult = ($remoteOutput -join "`n") | ConvertFrom-Json

$status = [ordered]@{
    time = (Get-Date).ToString("o")
    server = $Server
    cc_switch_db = $CcSwitchDb
    healthy_count = [int]$payload.healthy_count
    openclaw_provider = [string]$remoteResult.openclaw_provider
    qq_provider = [string]$remoteResult.qq_provider
    qq_image_key_pool_size = [int]$remoteResult.qq_image_key_pool_size
    openclaw_config_key_updates = [int]$remoteResult.openclaw_config_key_updates
    qq_config_key_updates = [int]$remoteResult.qq_config_key_updates
    restarted = [bool]$remoteResult.restarted
}
$status | ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding UTF8

Step "Server keys synced"
Write-Host ("Backups created: {0}" -f @($remoteResult.backups).Count)
Write-Host ("OpenClaw config key lines updated: {0}" -f $remoteResult.openclaw_config_key_updates)
Write-Host ("QQ config key lines updated: {0}" -f $remoteResult.qq_config_key_updates)
Write-Host ("QQ image key pool size: {0}" -f $remoteResult.qq_image_key_pool_size)
if ($RestartServices) {
    Write-Host "Services restarted: cc-connect, onebot-group-proxy, cc-connect-qq"
} else {
    Write-Host "Services not restarted. Re-run with -RestartServices to apply immediately."
}
