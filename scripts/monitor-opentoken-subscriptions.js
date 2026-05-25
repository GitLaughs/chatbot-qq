"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_BASE_URL = "https://otokapi.com";
const DEFAULT_THRESHOLD = 0.02;
const DEFAULT_FIELDS = [
  "declared_multiplier",
  "computed_multiplier",
  "rate_multiplier",
  "ratio",
  "rate",
  "multiplier",
  "discount",
  "倍率",
  "price_amount",
  "price",
  "amount",
];

function usage() {
  return [
    "Usage: node scripts/monitor-opentoken-subscriptions.js [--once] [--dry-run] [--list-only]",
    "",
    "Environment:",
    "  OTOKAPI_AUTH_TOKEN, OTOKAPI_AUTHORIZATION, OPENTOKEN_AUTHORIZATION, OPENTOKEN_ACCESS_TOKEN, or OPENTOKEN_COOKIE",
    "  OTOKAPI_BROWSER_AUTH=0 disables local Chrome/Edge otokapi.com auth discovery",
    "  OPENTOKEN_SUBSCRIPTION_THRESHOLD=0.02",
    "  LARK_CHAT_ID or LARK_USER_ID, or LARK_WEBHOOK_URL",
    "",
    "Options:",
    "  --fixture <file>          read a saved JSON response instead of calling OpenToken",
    "  --threshold <number>      alert when a plan metric is <= this value",
    "  --alert-mode <mode>       threshold or minimum; minimum sends only the current lowest metric once",
    "  --watch                   run forever and refresh plans every 60 seconds",
    "  --interval-seconds <n>    run forever with this interval",
    "  --until <datetime>        stop after this time, for example 2026-05-25T08:00:00+08:00",
    "  --dry-run                 print result; do not send Feishu message or update state",
    "  --list-only               list plans; do not send Feishu message",
    "  --repeat-alerts           send even if the same plan metric already alerted",
    "  --no-state                do not read or write alert state",
    "  --json                    print machine-readable output",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    fixture: "",
    intervalSeconds: 0,
    json: false,
    listOnly: false,
    noState: false,
    repeatAlerts: false,
    alertMode: process.env.OPENTOKEN_SUBSCRIPTION_ALERT_MODE || "threshold",
    threshold: numberFrom(process.env.OPENTOKEN_SUBSCRIPTION_THRESHOLD, DEFAULT_THRESHOLD),
    until: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--once") {
      options.intervalSeconds = 0;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--list-only") {
      options.listOnly = true;
    } else if (arg === "--alert-mode") {
      options.alertMode = readValue(argv, ++index, arg);
    } else if (arg === "--no-state") {
      options.noState = true;
    } else if (arg === "--repeat-alerts") {
      options.repeatAlerts = true;
    } else if (arg === "--fixture") {
      options.fixture = readValue(argv, ++index, arg);
    } else if (arg === "--threshold") {
      options.threshold = numberFrom(readValue(argv, ++index, arg), DEFAULT_THRESHOLD);
    } else if (arg === "--watch") {
      options.intervalSeconds = 60;
    } else if (arg === "--interval-seconds") {
      options.intervalSeconds = Math.max(0, Number(readValue(argv, ++index, arg)) || 0);
    } else if (arg === "--until") {
      options.until = readValue(argv, ++index, arg);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!["threshold", "minimum"].includes(options.alertMode)) {
    throw new Error("--alert-mode must be threshold or minimum");
  }
  return options;
}

function readValue(argv, index, flag) {
  if (index >= argv.length || argv[index].startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return argv[index];
}

function numberFrom(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function statePath(env = process.env) {
  return env.OPENTOKEN_SUBSCRIPTION_STATE_FILE || path.join(__dirname, "..", "runs", "opentoken-subscription-monitor", "state.json");
}

function endpoint(env = process.env) {
  const configured = env.OTOKAPI_PAYMENT_PLANS_URL || env.OPENTOKEN_SUBSCRIPTION_PLANS_URL;
  if (configured) return configured;
  return `${(env.OTOKAPI_BASE_URL || env.OPENTOKEN_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "")}/api/v1/payment/plans`;
}

function authHeaders(env = process.env) {
  const headers = {
    Accept: "application/json",
    "User-Agent": "chatbot-qq-opentoken-subscription-monitor/1.0",
  };
  if (env.OPENTOKEN_COOKIE) {
    headers.Cookie = env.OPENTOKEN_COOKIE;
  }
  if (env.OTOKAPI_AUTHORIZATION) {
    headers.Authorization = env.OTOKAPI_AUTHORIZATION;
  } else if (env.OTOKAPI_AUTH_TOKEN) {
    headers.Authorization = env.OTOKAPI_AUTH_TOKEN.startsWith("Bearer ")
      ? env.OTOKAPI_AUTH_TOKEN
      : `Bearer ${env.OTOKAPI_AUTH_TOKEN}`;
  } else if (env.OPENTOKEN_AUTHORIZATION) {
    headers.Authorization = env.OPENTOKEN_AUTHORIZATION;
  } else if (env.OPENTOKEN_ACCESS_TOKEN) {
    headers.Authorization = env.OPENTOKEN_ACCESS_TOKEN.startsWith("Bearer ")
      ? env.OPENTOKEN_ACCESS_TOKEN
      : `Bearer ${env.OPENTOKEN_ACCESS_TOKEN}`;
  }
  return headers;
}

function requestJSON(url, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "http:" ? http : https;
    const req = client.request(
      parsed,
      {
        method: "GET",
        headers,
        timeout: 30000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch (error) {
            reject(new Error(`invalid JSON from ${url}: ${error.message}`));
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const error = new Error(`GET ${url} failed: HTTP ${res.statusCode} ${safeMessage(data)}`);
            error.statusCode = res.statusCode;
            error.url = url;
            error.data = data;
            reject(error);
            return;
          }
          resolve(data);
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`GET ${url} timed out`)));
    req.on("error", reject);
    req.end();
  });
}

function safeMessage(data) {
  if (!data || typeof data !== "object") return "";
  const message = data.message || data.error || "";
  return String(message).slice(0, 240);
}

async function readPlansResponse(options, env = process.env) {
  if (options.fixture) {
    return JSON.parse(fs.readFileSync(options.fixture, "utf8"));
  }
  const url = endpoint(env);
  const headers = authHeaders(env);
  if (!hasAuth(env) && shouldUseBrowserAuth(url, env)) {
    for (const token of discoverBrowserAuthTokenCandidates(env)) {
      try {
        return await requestJSON(url, {
          ...headers,
          Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
        });
      } catch (error) {
        if (error.statusCode !== 401) throw error;
      }
    }
  }
  try {
    return await requestJSON(url, headers);
  } catch (error) {
    if (error.statusCode === 401 && !hasAuth(env)) {
      throw new Error(`${error.message}; set OTOKAPI_AUTH_TOKEN from the logged-in otokapi.com browser session`);
    }
    throw error;
  }
}

function hasAuth(env = process.env) {
  return Boolean(
    env.OTOKAPI_AUTH_TOKEN ||
      env.OTOKAPI_AUTHORIZATION ||
      env.OPENTOKEN_AUTHORIZATION ||
      env.OPENTOKEN_ACCESS_TOKEN ||
      env.OPENTOKEN_COOKIE
  );
}

function shouldUseBrowserAuth(url, env = process.env) {
  if (["0", "false", "no"].includes(String(env.OTOKAPI_BROWSER_AUTH || "1").toLowerCase())) return false;
  try {
    return new URL(url).hostname.endsWith("otokapi.com");
  } catch {
    return false;
  }
}

function browserStorageRoots(env = process.env) {
  if (env.OTOKAPI_BROWSER_AUTH_ROOTS) {
    return env.OTOKAPI_BROWSER_AUTH_ROOTS.split(path.delimiter).filter(Boolean);
  }
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return [
    path.join(localAppData, "Google", "Chrome", "User Data"),
    path.join(localAppData, "Microsoft", "Edge", "User Data"),
  ];
}

function extractBrowserAuthTokensFromText(text) {
  if (!text.includes("auth_token")) return [];
  const tokens = [];
  let position = -1;
  while ((position = text.indexOf("auth_token", position + 1)) >= 0) {
    const chunk = text.slice(Math.max(0, position - 500), Math.min(text.length, position + 2500));
    if (!/tokap/i.test(chunk)) continue;
    const matches = chunk.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) || [];
    for (const token of matches) {
      if (!tokens.includes(token)) tokens.push(token);
    }
  }
  return tokens;
}

function discoverBrowserAuthTokenCandidates(env = process.env) {
  const tokens = [];
  for (const root of browserStorageRoots(env)) {
    if (!fs.existsSync(root)) continue;
    let profiles = [];
    try {
      profiles = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const profile of profiles) {
      const leveldb = path.join(root, profile, "Local Storage", "leveldb");
      if (!fs.existsSync(leveldb)) continue;
      let files = [];
      try {
        files = fs.readdirSync(leveldb).filter((file) => /\.(?:ldb|log)$/i.test(file));
      } catch {
        continue;
      }
      for (const file of files) {
        let text = "";
        try {
          text = fs.readFileSync(path.join(leveldb, file)).toString("latin1");
        } catch {
          continue;
        }
        for (const token of extractBrowserAuthTokensFromText(text)) {
          if (!tokens.includes(token)) tokens.push(token);
        }
      }
    }
  }
  return tokens;
}

function extractPlans(response) {
  if (Array.isArray(response)) return response;
  if (!response || typeof response !== "object") return [];
  if (Array.isArray(response.data)) return response.data;
  if (response.data && typeof response.data === "object") {
    for (const key of ["plans", "items", "list", "records", "data"]) {
      if (Array.isArray(response.data[key])) return response.data[key];
    }
  }
  for (const key of ["plans", "items", "list", "records"]) {
    if (Array.isArray(response[key])) return response[key];
  }
  return [];
}

function fieldMatchers(env = process.env) {
  return String(env.OPENTOKEN_SUBSCRIPTION_PRICE_FIELDS || DEFAULT_FIELDS.join(","))
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function isMetricPath(metricPath, matchers) {
  const lower = metricPath.toLowerCase();
  const segments = lower.split(".");
  return matchers.some((matcher) => lower === matcher || lower.endsWith(`.${matcher}`) || segments.includes(matcher));
}

function parseNumeric(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  if (!Number.isFinite(parsed)) return null;
  return trimmed.includes("%") ? parsed / 100 : parsed;
}

function textFromPlan(plan) {
  const parts = [];
  for (const key of ["features", "description", "title", "name", "label", "plan_name"]) {
    const value = plan[key];
    if (Array.isArray(value)) {
      parts.push(value.join("\n"));
    } else if (value !== undefined && value !== null) {
      parts.push(String(value));
    }
  }
  return parts.join("\n");
}

function declaredMultiplierFromText(text) {
  const patterns = [
    /倍率\s*(?:约|=|:|：)?\s*([0-9]+(?:\.[0-9]+)?)(?:\s*x)?/i,
    /¥\s*1\s*(?:≈|~=|=|约)\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const number = Number(match[1]);
    if (!Number.isFinite(number) || number <= 0) continue;
    return pattern.source.includes("¥") ? 1 / number : number;
  }
  return null;
}

function quotaFromText(text, plan) {
  const directFields = [
    ["weekly_limit_usd", 1],
    ["monthly_limit_usd", 1],
    ["daily_limit_usd", Number(plan.validity_days) || 1],
  ];
  for (const [key, multiplier] of directFields) {
    const value = Number(plan[key]);
    if (Number.isFinite(value) && value > 0) return value * multiplier;
  }

  const daily = text.match(/(?:每日|日限)\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/);
  if (daily) {
    const amount = Number(daily[1]);
    const days = Number(plan.validity_days) || 1;
    if (Number.isFinite(amount) && amount > 0) return amount * days;
  }

  const weekly = text.match(/(?:每周|周限|周限额)\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/);
  if (weekly) {
    const amount = Number(weekly[1]);
    if (Number.isFinite(amount) && amount > 0) return amount;
  }

  return null;
}

function derivedPlanMetrics(plan) {
  const metrics = [];
  const text = textFromPlan(plan);
  const declared = declaredMultiplierFromText(text);
  if (declared !== null) {
    metrics.push({ path: "declared_multiplier", value: declared, raw: "features/description" });
  }

  const price = parseNumeric(plan.price);
  const quota = quotaFromText(text, plan);
  if (price !== null && quota !== null && quota > 0) {
    metrics.push({ path: "computed_multiplier", value: price / quota, raw: `${price}/${quota}` });
  }
  return metrics;
}

function collectPlanMetrics(plan, env = process.env) {
  const matchers = fieldMatchers(env);
  const metrics = [];
  const seen = new Set();

  function pushMetric(metric) {
    if (!isMetricPath(metric.path, matchers)) return;
    if (metric.value === null || !Number.isFinite(metric.value)) return;
    const key = `${metric.path}:${metric.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    metrics.push(metric);
  }

  for (const metric of derivedPlanMetrics(plan)) {
    pushMetric(metric);
  }

  function visit(value, parts) {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, parts.concat(String(index))));
      return;
    }
    if (typeof value === "object") {
      Object.keys(value).forEach((key) => visit(value[key], parts.concat(key)));
      return;
    }

    const metricPath = parts.join(".");
    if (!isMetricPath(metricPath, matchers)) return;
    const number = parseNumeric(value);
    if (number === null || !Number.isFinite(number)) return;
    pushMetric({ path: metricPath, value: number, raw: value });
  }

  visit(plan, []);
  return metrics;
}

function planTitle(plan) {
  return String(plan.title || plan.name || plan.label || plan.plan_name || plan.id || "unknown-plan");
}

function planID(plan) {
  return plan.id === undefined || plan.id === null ? planTitle(plan) : String(plan.id);
}

function planSummary(plan) {
  const keys = [
    "id",
    "title",
    "name",
    "price_amount",
    "price",
    "original_price",
    "amount",
    "rate_multiplier",
    "multiplier",
    "ratio",
    "validity_days",
    "validity_unit",
    "duration",
    "currency",
    "status",
  ];
  const pairs = [];
  for (const metric of derivedPlanMetrics(plan)) {
    pairs.push(`${metric.path}=${Number(metric.value.toPrecision(10))}`);
  }
  for (const key of keys) {
    if (plan[key] !== undefined && plan[key] !== null && plan[key] !== "") {
      pairs.push(`${key}=${plan[key]}`);
    }
  }
  return pairs.length ? pairs.join(", ") : JSON.stringify(plan).slice(0, 180);
}

function formatPlanList(plans) {
  if (!plans.length) return "套餐列表为空。";
  return plans.map((plan, index) => `${index + 1}. ${planSummary(plan)}`).join("\n");
}

function alertKey(alert) {
  return `${alert.planID}|${alert.metric.path}`;
}

function alertFromMinimum(minimum, threshold) {
  if (!minimum) return null;
  return {
    plan: minimum.plan,
    planID: minimum.planID,
    title: minimum.title,
    metric: minimum.metric,
    threshold,
    key: alertKey(minimum),
  };
}

function findAlerts(plans, threshold, env = process.env) {
  const includeZero = !["0", "false", "no"].includes(String(env.OPENTOKEN_SUBSCRIPTION_INCLUDE_ZERO || "1").toLowerCase());
  const alerts = [];
  for (const plan of plans) {
    for (const metric of collectPlanMetrics(plan, env)) {
      if (metric.value <= threshold && (includeZero || metric.value > 0)) {
        const alert = {
          plan,
          planID: planID(plan),
          title: planTitle(plan),
          metric,
          threshold,
        };
        alert.key = alertKey(alert);
        alerts.push(alert);
      }
    }
  }
  return alerts;
}

function findMinimumMetric(plans, env = process.env) {
  let minimum = null;
  for (const plan of plans) {
    for (const metric of collectPlanMetrics(plan, env)) {
      if (!minimum || metric.value < minimum.metric.value) {
        minimum = {
          plan,
          planID: planID(plan),
          title: planTitle(plan),
          metric,
        };
      }
    }
  }
  if (!minimum) return null;
  return {
    plan: minimum.plan,
    title: minimum.title,
    planID: minimum.planID,
    plan_id: minimum.planID,
    metric: minimum.metric,
    metric_path: minimum.metric.path,
    metric_value: minimum.metric.value,
  };
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { alerted: {} };
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function filterNewAlerts(alerts, options, env = process.env) {
  if (options.noState || options.repeatAlerts) return { alertsToSend: alerts, state: null };
  const file = statePath(env);
  const state = readState(file);
  state.alerted = state.alerted || {};
  if (options.alertMode === "minimum") {
    state.minimum_alerted = state.minimum_alerted || {};
    const alertsToSend = alerts.filter((alert) => !state.minimum_alerted[alert.key]);
    return { alertsToSend, state, file };
  }
  const alertsToSend = alerts.filter((alert) => !state.alerted[alert.key]);
  return { alertsToSend, state, file };
}

function markAlertsSent(alerts, state, options = {}) {
  const now = new Date().toISOString();
  state.alerted = state.alerted || {};
  if (options.alertMode === "minimum") {
    state.minimum_alerted = state.minimum_alerted || {};
  }
  for (const alert of alerts) {
    const payload = {
      time: now,
      plan_id: alert.planID,
      title: alert.title,
      metric_path: alert.metric.path,
      metric_value: alert.metric.value,
      threshold: alert.threshold,
    };
    if (options.alertMode === "minimum") {
      state.minimum_alerted[alert.key] = payload;
      state.last_minimum = payload;
    } else {
      state.alerted[alert.key] = payload;
    }
  }
}

function buildAlertMessage(alerts, plans, options, env = process.env) {
  if (options.alertMode === "minimum") {
    const alert = alerts[0];
    return [
      "OpenToken 最低套餐提醒",
      `检测时间：${new Date().toISOString()}`,
      `接口：${endpoint(env)}`,
      `当前最低：${alert.title} (#${alert.planID})`,
      `最低倍率：${alert.metric.path}=${alert.metric.value}`,
      `阈值：<= ${options.threshold}`,
      "说明：只读检测，未调用支付或下单接口；同一个最低项只提醒一次。",
      "",
      "当前套餐：",
      formatPlanList(plans).slice(0, 3000),
    ].join("\n");
  }
  const lines = [
    "OpenToken 订阅套餐低价提醒",
    `阈值：<= ${options.threshold}`,
    `检测时间：${new Date().toISOString()}`,
    `接口：${endpoint(env)}`,
    `命中：${alerts.length} / 套餐总数：${plans.length}`,
    "说明：只读检测，未调用支付或下单接口。",
    "",
    "命中套餐：",
  ];
  alerts.slice(0, 20).forEach((alert, index) => {
    lines.push(
      `${index + 1}. ${alert.title} (#${alert.planID}) ${alert.metric.path}=${alert.metric.value}`
    );
  });
  if (alerts.length > 20) {
    lines.push(`... 还有 ${alerts.length - 20} 条`);
  }
  lines.push("", "当前套餐：");
  lines.push(formatPlanList(plans).slice(0, 3000));
  return lines.join("\n");
}

function sendFeishu(message, options, env = process.env) {
  if (options.dryRun || options.listOnly) {
    return { sent: false, reason: options.dryRun ? "dry-run" : "list-only" };
  }
  if (env.LARK_WEBHOOK_URL) {
    return sendWebhook(message, env);
  }
  if (env.LARK_CHAT_ID || env.LARK_USER_ID) {
    return sendLarkCli(message, env);
  }
  return { sent: false, reason: "missing LARK_CHAT_ID/LARK_USER_ID/LARK_WEBHOOK_URL" };
}

function sendWebhook(message, env = process.env) {
  const payload = {
    msg_type: "text",
    content: { text: message },
  };
  if (env.LARK_WEBHOOK_SECRET) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    payload.timestamp = timestamp;
    payload.sign = crypto
      .createHmac("sha256", `${timestamp}\n${env.LARK_WEBHOOK_SECRET}`)
      .update("")
      .digest("base64");
  }
  return postWebhook(env.LARK_WEBHOOK_URL, payload);
}

function postWebhook(url, payload) {
  const parsed = new URL(url);
  const client = parsed.protocol === "http:" ? http : https;
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return new Promise((resolve, reject) => {
    const req = client.request(
      parsed,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length,
        },
        timeout: 30000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Feishu webhook failed: HTTP ${res.statusCode}`));
            return;
          }
          resolve({ sent: true, method: "webhook", response: text.slice(0, 200) });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Feishu webhook timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

function sendLarkCli(message, env = process.env) {
  const args = ["im", "+messages-send", "--as", env.LARK_CLI_AS || "bot", "--text", message];
  if (env.LARK_CLI_PROFILE) args.unshift("--profile", env.LARK_CLI_PROFILE);
  if (env.LARK_CHAT_ID) {
    args.push("--chat-id", env.LARK_CHAT_ID);
  } else {
    args.push("--user-id", env.LARK_USER_ID);
  }
  let bin = "lark-cli";
  let spawnArgs = args;
  let spawnEnv = env;
  if (process.platform === "win32") {
    bin = "powershell.exe";
    const command = [
      "$targetFlag = if ($env:LARK_CLI_TARGET_KIND -eq 'chat') { '--chat-id' } else { '--user-id' }",
      "$profileArgs = @()",
      "if ($env:LARK_CLI_PROFILE_EFFECTIVE) { $profileArgs = @('--profile', $env:LARK_CLI_PROFILE_EFFECTIVE) }",
      "& lark-cli @profileArgs im +messages-send --as $env:LARK_CLI_AS_EFFECTIVE $targetFlag $env:LARK_CLI_TARGET_ID --text $env:LARK_CLI_MESSAGE",
      "exit $LASTEXITCODE",
    ].join("; ");
    spawnArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command];
    spawnEnv = {
      ...env,
      LARK_CLI_AS_EFFECTIVE: env.LARK_CLI_AS || "bot",
      LARK_CLI_PROFILE_EFFECTIVE: env.LARK_CLI_PROFILE || "",
      LARK_CLI_TARGET_KIND: env.LARK_CHAT_ID ? "chat" : "user",
      LARK_CLI_TARGET_ID: env.LARK_CHAT_ID || env.LARK_USER_ID || "",
      LARK_CLI_MESSAGE: message,
    };
  }
  const result = spawnSync(bin, spawnArgs, { encoding: "utf8", env: spawnEnv, windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`lark-cli send failed: ${String(result.error ? result.error.message : result.stderr || result.stdout).slice(0, 500)}`);
  }
  return { sent: true, method: "lark-cli" };
}

async function runOnce(options, env = process.env) {
  const response = await readPlansResponse(options, env);
  const plans = extractPlans(response);
  const minimumMetric = findMinimumMetric(plans, env);
  const minimumAlert = alertFromMinimum(minimumMetric, options.threshold);
  const alerts = options.alertMode === "minimum"
    ? minimumAlert && minimumAlert.metric.value <= options.threshold
      ? [minimumAlert]
      : []
    : findAlerts(plans, options.threshold, env);
  const { alertsToSend, state, file } = filterNewAlerts(alerts, options, env);
  let notify = { sent: false, reason: options.listOnly ? "list-only" : "no alerts" };
  if (alertsToSend.length && !options.listOnly) {
    const message = buildAlertMessage(alertsToSend, plans, options, env);
    notify = await sendFeishu(message, options, env);
    if (!options.dryRun && state) {
      markAlertsSent(alertsToSend, state, options);
      writeState(file, state);
    }
  }
  return {
    ok: true,
    endpoint: endpoint(env),
    threshold: options.threshold,
    alert_mode: options.alertMode,
    plan_count: plans.length,
    plans: plans.map(planSummary),
    minimum_metric: minimumMetric,
    alert_count: alerts.length,
    new_alert_count: alertsToSend.length,
    alerts: alertsToSend.map((alert) => ({
      key: alert.key,
      title: alert.title,
      plan_id: alert.planID,
      metric_path: alert.metric.path,
      metric_value: alert.metric.value,
    })),
    notify,
  };
}

function printResult(result, options) {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`OpenToken 套餐：${result.plan_count}`);
  result.plans.forEach((line, index) => console.log(`${index + 1}. ${line}`));
  if (result.minimum_metric) {
    console.log(
      `最小指标：${result.minimum_metric.title} (#${result.minimum_metric.plan_id}) ${result.minimum_metric.metric_path}=${result.minimum_metric.metric_value}`
    );
  }
  console.log(`命中阈值 <= ${result.threshold}：${result.alert_count}`);
  console.log(`本次需提醒：${result.new_alert_count}`);
  for (const alert of result.alerts) {
    console.log(`- ${alert.title} (#${alert.plan_id}) ${alert.metric_path}=${alert.metric_value}`);
  }
  console.log(`飞书通知：${result.notify.sent ? "已发送" : `未发送 (${result.notify.reason || result.notify.method || "none"})`}`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }

  async function tick() {
    if (options.until && Date.now() >= Date.parse(options.until)) {
      console.log(`监控结束：已到 ${options.until}`);
      process.exit(0);
    }
    const result = await runOnce(options);
    printResult(result, options);
  }

  try {
    await tick();
    if (options.intervalSeconds > 0) {
      if (options.until) {
        const untilMs = Date.parse(options.until);
        if (!Number.isFinite(untilMs)) {
          throw new Error(`invalid --until value: ${options.until}`);
        }
        const delay = untilMs - Date.now();
        if (delay <= 0) {
          console.log(`监控结束：已到 ${options.until}`);
          return;
        }
        setTimeout(() => {
          console.log(`监控结束：已到 ${options.until}`);
          process.exit(0);
        }, delay).unref();
      }
      setInterval(() => {
        tick().catch((error) => {
          console.error(error.message);
          process.exitCode = 1;
        });
      }, options.intervalSeconds * 1000);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildAlertMessage,
  collectPlanMetrics,
  extractPlans,
  extractBrowserAuthTokensFromText,
  fieldMatchers,
  findAlerts,
  findMinimumMetric,
  formatPlanList,
  hasAuth,
  parseArgs,
  parseNumeric,
  planSummary,
  runOnce,
};
