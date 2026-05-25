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


def api_request(url, key, timeout=20, method="GET", payload=None):
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
    req = request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method=method,
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


def balance_for_key(env, key, base_url=None):
    balance_url = env_value(env, "QQ_OPENTOKEN_BALANCE_URL")
    base_url = (base_url or env_value(env, "QQ_OPENTOKEN_BASE_URL", "https://otokapi.com")).rstrip("/")
    if balance_url:
        raw = api_request(balance_url, key)
        data = json.loads(raw)
        balance = find_number(data, {"balance", "credit", "credits", "remain", "remaining", "quota"})
        valid = data.get("is_active", data.get("isValid", True))
        if balance is None:
            raise RuntimeError("balance field not found")
        return bool(valid), balance

    return usage_balance(base_url, key)


def generation_probe_enabled(env):
    value = env_value(env, "QQ_OPENTOKEN_GENERATION_HEALTH_ENABLED", "1").lower()
    return value not in {"0", "false", "no", "off"}


def opentoken_generation_ok(env, base_url, key, model=None):
    if not generation_probe_enabled(env):
        return True, "generation_probe=disabled"

    timeout = float(env_value(env, "QQ_OPENTOKEN_GENERATION_HEALTH_TIMEOUT", "40"))
    path = env_value(env, "QQ_OPENTOKEN_RESPONSES_PATH", "/responses")
    model = env_value(env, "QQ_OPENTOKEN_HEALTH_MODEL", model or "gpt-5.4-mini")
    url = f"{base_url.rstrip('/')}/{path.lstrip('/')}"
    payload = {
        "model": model,
        "input": "ping",
        "max_output_tokens": int(env_value(env, "QQ_OPENTOKEN_HEALTH_MAX_OUTPUT_TOKENS", "8")),
    }
    try:
        api_request(url, key, timeout=timeout, method="POST", payload=payload)
        return True, f"generation_probe=ok model={model} path={path}"
    except error.HTTPError as exc:
        return False, f"generation_probe=http_{exc.code} model={model} path={path}"
    except Exception as exc:
        return False, f"generation_probe={type(exc).__name__}: {exc}"


def usage_balance(base_url, key, timeout=20):
    raw = api_request(f"{base_url.rstrip('/')}/v1/usage", key, timeout=timeout)
    data = json.loads(raw)
    balance = find_number(data, {"balance", "credit", "credits", "remain", "remaining", "quota"})
    valid = data.get("is_active", data.get("isValid", True))
    if balance is None:
        raise RuntimeError("usage response missing remaining balance")
    return bool(valid), float(balance)


def choose_cc_switch_highest_balance(env):
    threshold = float(env_value(env, "QQ_OPENTOKEN_MIN_BALANCE", "20"))
    min_healthy = int(env_value(env, "QQ_OPENTOKEN_MIN_HEALTHY_KEYS", "1"))
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

    balance_valid = sorted(providers, key=lambda item: item["balance"], reverse=True)
    response_valid = []
    for provider in balance_valid:
        ok, reason = opentoken_generation_ok(env, provider["base_url"], provider["api_key"], provider["model"])
        if ok:
            provider["probe_reason"] = reason
            response_valid.append(provider)
        else:
            errors.append(f"{provider['name']}: {reason}")

    if len(response_valid) < min_healthy:
        reason = f"healthy_opentoken_keys={len(response_valid)} below {min_healthy}"
        if errors:
            reason += "; " + "; ".join(errors[:2])
        return None, reason
    selected = response_valid[0]
    return selected, (
        f"selected highest balance provider={selected['name']} "
        f"id={selected['id']} balance={selected['balance']} {selected['probe_reason']}"
    )


def choose_cc_switch_second_balance(env):
    return choose_cc_switch_highest_balance(env)


def opentoken_pool_keys(env):
    key = env_value(env, "QQ_OPENTOKEN_API_KEY")
    pool = [p.strip() for p in env_value(env, "QQ_OPENTOKEN_POOL_KEYS", "").split(",") if p.strip()]
    if key and key not in pool:
        pool.append(key)
    return pool


def choose_opentoken_pool_highest(env):
    pool = opentoken_pool_keys(env)
    if not pool:
        return None, "missing QQ_OPENTOKEN_API_KEY"

    base_url = env_value(env, "QQ_OPENTOKEN_BASE_URL", "https://otokapi.com").rstrip("/")
    threshold = float(env_value(env, "QQ_OPENTOKEN_MIN_BALANCE", "20"))
    min_healthy = int(env_value(env, "QQ_OPENTOKEN_MIN_HEALTHY_KEYS", "1"))

    healthy = []
    errors = []
    for item in pool:
        try:
            valid, balance = balance_for_key(env, item, base_url)
            ok, reason = opentoken_generation_ok(env, base_url, item)
            if valid and balance > threshold and ok:
                healthy.append(
                    {
                        "api_key": item,
                        "base_url": base_url,
                        "balance": balance,
                        "probe_reason": reason,
                    }
                )
            elif not valid:
                errors.append("usage response marked key inactive")
            elif balance <= threshold:
                errors.append(f"balance={balance} <= threshold={threshold}")
            elif not ok:
                errors.append(reason)
        except Exception as exc:
            errors.append(str(exc))

    healthy = sorted(healthy, key=lambda item: item["balance"], reverse=True)
    if len(healthy) < min_healthy:
        return None, f"healthy_opentoken_keys={len(healthy)} below {min_healthy}; {'; '.join(errors[:2])}"
    selected = healthy[0]
    return selected, (
        f"healthy_opentoken_keys={len(healthy)} selected=highest_balance "
        f"balance={selected['balance']} {selected['probe_reason']}"
    )


def provider_names_in_block(block):
    names = set()
    in_provider = False
    for line in block:
        stripped = line.strip()
        if stripped == "[[projects.agent.providers]]":
            in_provider = True
            continue
        if stripped.startswith("[") and stripped != "[[projects.agent.providers]]":
            in_provider = False
        if in_provider and stripped.startswith("name ="):
            match = re.match(r'name\s*=\s*"([^"]+)"', stripped)
            if match:
                names.add(match.group(1))
    return names


def split_project_blocks(lines):
    preamble = []
    blocks = []
    current = None
    for line in lines:
        if line.strip() == "[[projects]]":
            if current is None:
                current = [line]
            else:
                blocks.append(current)
                current = [line]
            continue
        if current is None:
            preamble.append(line)
        else:
            current.append(line)
    if current is not None:
        blocks.append(current)
    return preamble, blocks


def update_project_block(block, provider, primary, fallback, selected=None):
    names = provider_names_in_block(block)
    if primary not in names and fallback not in names:
        return block, False

    out = []
    in_agent_options = False
    in_named_provider = None
    options_provider_seen = False
    changed = False

    def maybe_insert_provider_before_section(next_line):
        nonlocal changed, options_provider_seen, in_agent_options
        if in_agent_options and not options_provider_seen and next_line.strip().startswith("["):
            out.append(f'provider = "{provider}"')
            changed = True
            options_provider_seen = True
            in_agent_options = False

    for line in block:
        stripped = line.strip()
        maybe_insert_provider_before_section(line)

        if stripped == "[projects.agent.options]":
            in_agent_options = True
            options_provider_seen = False
            out.append(line)
            continue

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
            options_provider_seen = True
            out.append(new_line)
            continue

        if selected and in_named_provider == primary:
            indent = line[: len(line) - len(line.lstrip())]
            if "api_key" in selected and stripped.startswith("api_key ="):
                new_line = f'{indent}api_key = "{selected["api_key"]}"'
                changed = changed or new_line != line
                out.append(new_line)
                continue
            if "base_url" in selected and stripped.startswith("base_url ="):
                new_line = f'{indent}base_url = "{selected["base_url"]}"'
                changed = changed or new_line != line
                out.append(new_line)
                continue
            if "model" in selected and selected["model"] and stripped.startswith("model ="):
                new_line = f'{indent}model = "{selected["model"]}"'
                changed = changed or new_line != line
                out.append(new_line)
                continue

        out.append(line)

    if in_agent_options and not options_provider_seen:
        out.append(f'provider = "{provider}"')
        changed = True
    return out, changed


def set_provider(text, provider, primary="qq-opentoken", fallback="qq-mimo-fallback", selected=None):
    lines = text.splitlines()
    preamble, blocks = split_project_blocks(lines)
    out = list(preamble)
    changed = False
    for block in blocks:
        updated, block_changed = update_project_block(block, provider, primary, fallback, selected=selected)
        out.extend(updated)
        changed = changed or block_changed
    return "\n".join(out) + "\n", changed


def restart_service():
    subprocess.run(["systemctl", "restart", "cc-connect-qq.service"], check=False)


def main():
    env = load_env(ENV_FILE)
    primary = env_value(env, "QQ_PROVIDER_PRIMARY_NAME", "qq-opentoken")
    fallback = env_value(env, "QQ_PROVIDER_FALLBACK_NAME", "qq-mimo-fallback")
    target, reason = (primary, "")
    selected = None
    source = env_value(env, "QQ_PROVIDER_SOURCE", "")
    if source in {"cc-switch-second-balance", "cc-switch-highest-balance"}:
        selected, reason = choose_cc_switch_highest_balance(env)
        ok = selected is not None
    else:
        selected, reason = choose_opentoken_pool_highest(env)
        ok = selected is not None
    if not ok:
        target = fallback
        selected = None

    if not CONFIG.exists():
        print(f"missing config: {CONFIG}", file=sys.stderr)
        return 2

    text = CONFIG.read_text(encoding="utf-8")
    updated, changed = set_provider(text, target, primary=primary, fallback=fallback, selected=selected)
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} target={target} reason={reason}")
    if changed:
        backup = CONFIG.with_suffix(CONFIG.suffix + f".provider-{int(time.time())}.bak")
        backup.write_text(text, encoding="utf-8")
        CONFIG.write_text(updated, encoding="utf-8")
        restart_service()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
