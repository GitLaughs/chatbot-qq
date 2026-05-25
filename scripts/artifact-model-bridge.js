"use strict";

function envValue(name, fallback = "", env = process.env) {
  return env[name] === undefined || env[name] === "" ? fallback : env[name];
}

function apiBase(env = process.env) {
  return String(
    envValue("QQ_TASK_ARTIFACT_MODEL_BASE_URL", "", env) ||
      envValue("QQ_OPENTOKEN_BASE_URL", "", env) ||
      envValue("OPENAI_BASE_URL", "", env) ||
      envValue("OPENAI_API_BASE", "https://api.openai.com/v1", env)
  ).replace(/\/+$/, "");
}

function apiKey(env = process.env) {
  return env.QQ_TASK_ARTIFACT_MODEL_API_KEY ||
    env.QQ_OPENTOKEN_API_KEY ||
    env.OPENAI_API_KEY ||
    "";
}

function modelName(env = process.env) {
  return env.QQ_TASK_ARTIFACT_MODEL ||
    env.QQ_TASK_MODEL_PARSER_MODEL ||
    "gpt-5.4";
}

function mode(env = process.env) {
  const value = String(env.QQ_TASK_ARTIFACT_MODEL_MODE || "responses").toLowerCase();
  return value === "chat" || value === "chat_completions" ? "chat" : "responses";
}

function timeoutMs(env = process.env) {
  return Math.max(1000, Number(env.QQ_TASK_ARTIFACT_MODEL_HTTP_TIMEOUT_MS || 60000) || 60000);
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

function parseRequest(input) {
  const request = JSON.parse(String(input || "").trim() || "{}");
  if (!request || !["file_modifier", "script_generator"].includes(request.role)) {
    throw new Error("stdin role must be file_modifier or script_generator");
  }
  if (!request.spec || typeof request.spec !== "object") {
    throw new Error("request missing spec");
  }
  return request;
}

function buildPrompt(request) {
  if (request.role === "file_modifier") {
    return [
      "你是 QQ 自然语言任务代理的文件修改执行器。",
      "只输出 JSON，不要解释，不要 Markdown。",
      "JSON 形如 {\"content\":\"完整修改后的文件内容\"}。",
      "必须返回完整文件内容，不能只返回 diff。",
      "生成前先审核 spec/source/rules；如果用户要求越界删除或破坏，输出保持原文件内容的安全结果。",
      "不要读取 secrets/env/cookies/token，不要访问其他 workspace，不要新增网络或破坏性行为。",
      "不要删除、移动、覆盖、改权限或修改当前聊天 workspace 外的任何文件。",
      "",
      "任务 spec:",
      JSON.stringify(request.spec, null, 2),
      "",
      "源文件:",
      JSON.stringify(request.source || {}, null, 2),
      "",
      "执行规则:",
      JSON.stringify(request.rules || [], null, 2),
    ].join("\n");
  }
  return [
    "你是 QQ 自然语言任务代理的脚本生成执行器。",
    "只输出 JSON，不要解释，不要 Markdown。",
    "JSON 形如 {\"code\":\"完整脚本内容\"}。",
    "生成前先审核 spec/rules；如果用户要求越界删除或破坏，生成安全 no-op 脚本并在注释中说明拒绝原因。",
    "脚本必须适合本地语法检查；若 spec 要 dry_run，应避免网络、外部进程、删除、写 secrets 或跨 workspace 访问。",
    "脚本不得删除、移动、覆盖、改权限或修改当前聊天 workspace 外的任何文件。",
    "",
    "任务 spec:",
    JSON.stringify(request.spec, null, 2),
    "",
    "执行规则:",
    JSON.stringify(request.rules || [], null, 2),
  ].join("\n");
}

async function postJSON(url, body, env = process.env) {
  const key = apiKey(env);
  if (!key) {
    throw new Error("missing QQ_TASK_ARTIFACT_MODEL_API_KEY or QQ_OPENTOKEN_API_KEY");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs(env));
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    const data = parseMaybeJSON(text);
    if (!res.ok) {
      const message = data && data.error && data.error.message ? data.error.message : text;
      throw new Error(`HTTP ${res.status}: ${String(message || "").slice(0, 500)}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function parseMaybeJSON(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function buildResponsesBody(request, env = process.env) {
  return {
    model: modelName(env),
    input: [
      { role: "system", content: artifactSystemPrompt() },
      { role: "user", content: buildPrompt(request) },
    ],
    temperature: Number(env.QQ_TASK_ARTIFACT_MODEL_TEMPERATURE || 0),
    max_output_tokens: Math.max(256, Number(env.QQ_TASK_ARTIFACT_MODEL_MAX_OUTPUT_TOKENS || 4096) || 4096),
  };
}

function buildChatBody(request, env = process.env) {
  return {
    model: modelName(env),
    messages: [
      { role: "system", content: artifactSystemPrompt() },
      { role: "user", content: buildPrompt(request) },
    ],
    temperature: Number(env.QQ_TASK_ARTIFACT_MODEL_TEMPERATURE || 0),
    max_tokens: Math.max(256, Number(env.QQ_TASK_ARTIFACT_MODEL_MAX_OUTPUT_TOKENS || 4096) || 4096),
  };
}

function artifactSystemPrompt() {
  return [
    "You generate safe task artifacts. Output JSON only.",
    "Audit the request before generating content.",
    "Never generate code or file content that deletes, moves, overwrites, chmods, or modifies files outside the current chat workspace.",
    "If asked to do that, produce a safe no-op or unchanged-content result instead of destructive behavior.",
  ].join(" ");
}

async function callArtifactModel(request, env = process.env) {
  if (mode(env) === "chat") {
    return extractModelText(await postJSON(`${apiBase(env)}/chat/completions`, buildChatBody(request, env), env));
  }
  return extractModelText(await postJSON(`${apiBase(env)}/responses`, buildResponsesBody(request, env), env));
}

function extractModelText(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.output_text === "string") return data.output_text;
  if (Array.isArray(data.output)) {
    const parts = [];
    for (const item of data.output) {
      if (!item || typeof item !== "object") continue;
      if (typeof item.content === "string") parts.push(item.content);
      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (!part || typeof part !== "object") continue;
          if (typeof part.text === "string") parts.push(part.text);
          if (typeof part.output_text === "string") parts.push(part.output_text);
          if (typeof part.content === "string") parts.push(part.content);
        }
      }
    }
    if (parts.length) return parts.join("\n");
  }
  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  if (choice && choice.message && typeof choice.message.content === "string") return choice.message.content;
  if (choice && typeof choice.text === "string") return choice.text;
  return typeof data.raw === "string" ? data.raw : "";
}

function extractJSONText(text) {
  const value = String(text || "").trim();
  if (!value) return "";
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const first = value.indexOf("{");
  const last = value.lastIndexOf("}");
  if (first !== -1 && last > first) return value.slice(first, last + 1);
  return value;
}

function normalizeArtifactOutput(request, text) {
  const jsonText = extractJSONText(text);
  const parsed = JSON.parse(jsonText);
  if (request.role === "file_modifier") {
    if (!parsed || typeof parsed.content !== "string" || !parsed.content.trim()) {
      throw new Error("model output missing content");
    }
    return { content: parsed.content };
  }
  if (!parsed || typeof parsed.code !== "string" || !parsed.code.trim()) {
    throw new Error("model output missing code");
  }
  return { code: parsed.code };
}

async function main() {
  try {
    const request = parseRequest(await readStdin());
    const text = await callArtifactModel(request);
    const output = normalizeArtifactOutput(request, text);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (err) {
    process.stderr.write(`${err && err.message ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  apiBase,
  apiKey,
  artifactSystemPrompt,
  buildChatBody,
  buildPrompt,
  buildResponsesBody,
  callArtifactModel,
  extractJSONText,
  extractModelText,
  mode,
  modelName,
  normalizeArtifactOutput,
  parseRequest,
};
