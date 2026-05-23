#!/usr/bin/env python3
import json
import os
import pathlib
import re
import sqlite3
import subprocess
import sys
import time
from urllib import error, request


CONFIG = pathlib.Path(os.environ.get("QQ_CC_CONNECT_CONFIG", "/root/.cc-connect-qq/config.toml"))
ENV_FILE = pathlib.Path(os.environ.get("CHATBOT_QQ_ENV", "/etc/chatbot-qq.env"))
PROJECTS = [
    "qq-sandbox-GROUP_ID_A-listen",
    "qq-sandbox-GROUP_ID_A-at",
    "qq-sandbox-GROUP_ID_B-listen",
    "qq-sandbox-GROUP_ID_B-at",
    "qq-private-PRIVATE_USER_ID_A",
]
CC_SWITCH_DB = pathlib.Path(os.environ.get("CC_SWITCH_DB", "/root/.cc-switch/cc-switch.db"))


def load_env(path):
    env = {}
    if not path.exists():
        return env
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def env_value(env, key, default=""):
    return os.environ.get(key) or env.get(key) or default


def api_request(url, key, timeout=20):
    req = request.Request(
        url,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="GET",
    )
    with request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def parse_cc_switch_config(config_text):
    model = None
    base_url = None
    provider_name = None
    in_provider = False
    for raw in config_text.splitlines():
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
        if key == "model" and model is None:
            model = value
        if in_provider and key == "base_url":
            base_url = value
        if in_provider and key == "name":
            provider_name = value
    return provider_name, base_url, model


def cc_switch_providers():
    if not CC_SWITCH_DB.exists():
        return []
    con = sqlite3.connect(str(CC_SWITCH_DB))
    con.row_factory = sqlite3.Row
    rows = con.execute(
        """
        select id, name, settings_config, meta, sort_index
        from providers
        where app_type = 'codex'
        order by sort_index
        """
    ).fetchall()
    providers = []
    for row in rows:
        try:
            settings = json.loads(row["settings_config"] or "{}")
            meta = json.loads(row["meta"] or "{}")
        except json.JSONDecodeError:
            continue
        usage = meta.get("usage_script") or {}
        config_text = settings.get("config") or ""
        provider_name, config_base_url, config_model = parse_cc_switch_config(config_text)
        api_key = usage.get("apiKey") or settings.get("auth") or settings.get("api_key") or ""
        base_url = usage.get("baseUrl") or config_base_url or ""
        model = config_model or usage.get("model") or "gpt-5.5"
        if not str(row["id"]).startswith("opentoken-") and "otokapi.com" not in base_url:
            continue
        if not api_key or not base_url:
            continue
        providers.append(
            {
                "id": row["id"],
                "name": row["name"],
                "api_key": api_key,
                "base_url": base_url.rstrip("/"),
                "model": model,
                "provider_name": provider_name or "opentoken",
                "sort_index": row["sort_index"],
            }
        )
    return providers


def find_number(value, names):
    if isinstance(value, dict):
        for key, item in value.items():
            lower = str(key).lower()
            if lower in names and isinstance(item, (int, float)):
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


def balance_for_key(env, key):
    balance_url = env_value(env, "QQ_OPENTOKEN_BALANCE_URL")
    base_url = env_value(env, "QQ_OPENTOKEN_BASE_URL", "https://otokapi.com").rstrip("/")
    if balance_url:
        raw = api_request(balance_url, key)
        data = json.loads(raw)
        balance = find_number(data, {"balance", "credit", "credits", "remain", "remaining", "quota"})
        if balance is None:
            raise RuntimeError("balance field not found")
        return balance

    health_url = env_value(env, "QQ_OPENTOKEN_HEALTH_URL") or f"{base_url}/v1/models"
    api_request(health_url, key)
    return float("inf")


def usage_balance(base_url, key, timeout=20):
    raw = api_request(f"{base_url.rstrip('/')}/v1/usage", key, timeout=timeout)
    data = json.loads(raw)
    balance = find_number(data, {"balance", "credit", "credits", "remain", "remaining", "quota"})
    valid = data.get("is_active", data.get("isValid", True))
    if balance is None:
        raise RuntimeError("usage response missing remaining balance")
    return bool(valid), float(balance)


def choose_cc_switch_second_balance(env):
    threshold = float(env_value(env, "QQ_OPENTOKEN_MIN_BALANCE", "1"))
    providers = []
    errors = []
    for provider in cc_switch_providers():
        try:
            valid, balance = usage_balance(provider["base_url"], provider["api_key"])
            if valid and balance > threshold:
                provider["balance"] = balance
                providers.append(provider)
        except Exception as exc:
            errors.append(f"{provider['name']}: {exc}")

    providers.sort(key=lambda item: item["balance"], reverse=True)
    if len(providers) < 2:
        reason = f"healthy_opentoken_keys={len(providers)} below 2"
        if errors:
            reason += "; " + "; ".join(errors[:2])
        return None, reason
    selected = providers[1]
    return selected, (
        f"selected second balance provider={selected['name']} "
        f"id={selected['id']} balance={selected['balance']}"
    )


def opentoken_ok(env):
    if env_value(env, "QQ_PROVIDER_SOURCE", "") == "cc-switch-second-balance":
        selected, reason = choose_cc_switch_second_balance(env)
        return bool(selected), reason

    key = env_value(env, "QQ_OPENTOKEN_API_KEY")
    if not key:
        return False, "missing QQ_OPENTOKEN_API_KEY"

    threshold = float(env_value(env, "QQ_OPENTOKEN_MIN_BALANCE", "1"))
    min_healthy = int(env_value(env, "QQ_OPENTOKEN_MIN_HEALTHY_KEYS", "1"))
    pool = [p.strip() for p in env_value(env, "QQ_OPENTOKEN_POOL_KEYS", key).split(",") if p.strip()]

    healthy = 0
    errors = []
    for item in pool:
        try:
            balance = balance_for_key(env, item)
            if balance > threshold:
                healthy += 1
        except Exception as exc:
            errors.append(str(exc))

    if healthy < min_healthy:
        return False, f"healthy_opentoken_keys={healthy} below {min_healthy}; {'; '.join(errors[:2])}"
    return True, f"healthy_opentoken_keys={healthy}"


def set_provider(text, provider, selected=None):
    lines = text.splitlines()
    out = []
    current_project = None
    in_named_provider = None
    in_agent_options = False
    changed = False
    for line in lines:
        stripped = line.strip()
        project_match = re.match(r'name\s*=\s*"([^"]+)"', stripped)
        if project_match and not in_agent_options:
            current_project = project_match.group(1)

        if stripped == "[projects.agent.options]":
            in_agent_options = current_project in PROJECTS
            out.append(line)
            continue

        if in_agent_options and stripped.startswith("["):
            in_agent_options = False
        if stripped == "[[projects.agent.providers]]":
            in_named_provider = None
        elif stripped.startswith("[") and stripped != "[[projects.agent.providers]]":
            in_named_provider = None
        elif stripped.startswith("name ="):
            match = re.match(r'name\s*=\s*"([^"]+)"', stripped)
            if match:
                in_named_provider = match.group(1)

        if in_agent_options and stripped.startswith("provider ="):
            indent = line[: len(line) - len(line.lstrip())]
            new_line = f'{indent}provider = "{provider}"'
            changed = changed or new_line != line
            out.append(new_line)
            continue

        if selected and in_named_provider == "qq-opentoken":
            indent = line[: len(line) - len(line.lstrip())]
            if stripped.startswith("api_key ="):
                new_line = f'{indent}api_key = "{selected["api_key"]}"'
                changed = changed or new_line != line
                out.append(new_line)
                continue
            if stripped.startswith("base_url ="):
                new_line = f'{indent}base_url = "{selected["base_url"]}"'
                changed = changed or new_line != line
                out.append(new_line)
                continue
            if stripped.startswith("model ="):
                new_line = f'{indent}model = "{selected["model"]}"'
                changed = changed or new_line != line
                out.append(new_line)
                continue

        out.append(line)
    return "\n".join(out) + "\n", changed


def restart_service():
    subprocess.run(["systemctl", "restart", "cc-connect-qq.service"], check=False)


def main():
    env = load_env(ENV_FILE)
    primary = env_value(env, "QQ_PROVIDER_PRIMARY_NAME", "qq-opentoken")
    fallback = env_value(env, "QQ_PROVIDER_FALLBACK_NAME", "qq-mimo-fallback")
    target, reason = (primary, "")
    selected = None
    if env_value(env, "QQ_PROVIDER_SOURCE", "") == "cc-switch-second-balance":
        selected, reason = choose_cc_switch_second_balance(env)
        ok = selected is not None
    else:
        ok, reason = opentoken_ok(env)
    if not ok:
        target = fallback

    if not CONFIG.exists():
        print(f"missing config: {CONFIG}", file=sys.stderr)
        return 2

    text = CONFIG.read_text(encoding="utf-8")
    updated, changed = set_provider(text, target, selected=selected)
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} target={target} reason={reason}")
    if changed:
        backup = CONFIG.with_suffix(CONFIG.suffix + f".provider-{int(time.time())}.bak")
        backup.write_text(text, encoding="utf-8")
        CONFIG.write_text(updated, encoding="utf-8")
        restart_service()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
