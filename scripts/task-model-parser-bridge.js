"use strict";

function envValue(name, fallback = "", env = process.env) {
  return env[name] === undefined || env[name] === "" ? fallback : env[name];
}

function apiBase(env = process.env) {
  return String(
    envValue("QQ_TASK_MODEL_PARSER_BASE_URL", "", env) ||
      envValue("QQ_OPENTOKEN_BASE_URL", "", env) ||
      envValue("OPENAI_BASE_URL", "", env) ||
      envValue("OPENAI_API_BASE", "https://api.openai.com/v1", env)
  ).replace(/\/+$/, "");
}

function apiKey(env = process.env) {
  return env.QQ_TASK_MODEL_PARSER_API_KEY ||
    env.QQ_OPENTOKEN_API_KEY ||
    env.OPENAI_API_KEY ||
    "";
}

function modelName(env = process.env) {
  return env.QQ_TASK_MODEL_PARSER_MODEL ||
    env.QQ_OPENTOKEN_HEALTH_MODEL ||
    "gpt-5.4";
}

function mode(env = process.env) {
  const value = String(env.QQ_TASK_MODEL_PARSER_MODE || "responses").toLowerCase();
  return value === "chat" || value === "chat_completions" ? "chat" : "responses";
}

function timeoutMs(env = process.env) {
  return Math.max(1000, Number(env.QQ_TASK_MODEL_PARSER_HTTP_TIMEOUT_MS || env.QQ_TASK_MODEL_PARSER_TIMEOUT_MS || 30000) || 30000);
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
  if (!request || request.role !== "task_structure_parser") {
    throw new Error("stdin must be a task_structure_parser request");
  }
  if (!request.task_type || !request.prompt) {
    throw new Error("request missing task_type or prompt");
  }
  return request;
}

async function postJSON(url, body, env = process.env) {
  const key = apiKey(env);
  if (!key) {
    throw new Error("missing QQ_TASK_MODEL_PARSER_API_KEY or QQ_OPENTOKEN_API_KEY");
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
      {
        role: "system",
        content: "You are a strict JSON task parser. Output JSON only.",
      },
      {
        role: "user",
        content: request.prompt,
      },
    ],
    temperature: Number(env.QQ_TASK_MODEL_PARSER_TEMPERATURE || 0),
    max_output_tokens: Math.max(128, Number(env.QQ_TASK_MODEL_PARSER_MAX_OUTPUT_TOKENS || 1200) || 1200),
  };
}

function buildChatBody(request, env = process.env) {
  return {
    model: modelName(env),
    messages: [
      { role: "system", content: "You are a strict JSON task parser. Output JSON only." },
      { role: "user", content: request.prompt },
    ],
    temperature: Number(env.QQ_TASK_MODEL_PARSER_TEMPERATURE || 0),
    max_tokens: Math.max(128, Number(env.QQ_TASK_MODEL_PARSER_MAX_OUTPUT_TOKENS || 1200) || 1200),
  };
}

async function callModelParser(request, env = process.env) {
  if (mode(env) === "chat") {
    const data = await postJSON(`${apiBase(env)}/chat/completions`, buildChatBody(request, env), env);
    return extractModelText(data);
  }
  const data = await postJSON(`${apiBase(env)}/responses`, buildResponsesBody(request, env), env);
  return extractModelText(data);
}

function extractModelText(data) {
  if (!data || typeof data !== "object") {
    return "";
  }
  if (typeof data.output_text === "string") {
    return data.output_text;
  }
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
  if (choice && choice.message && typeof choice.message.content === "string") {
    return choice.message.content;
  }
  if (choice && typeof choice.text === "string") {
    return choice.text;
  }
  return typeof data.raw === "string" ? data.raw : "";
}

function extractJSONText(text) {
  const value = String(text || "").trim();
  if (!value) return "";
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const first = value.indexOf("{");
  const last = value.lastIndexOf("}");
  if (first !== -1 && last > first) {
    return value.slice(first, last + 1);
  }
  return value;
}

async function main() {
  try {
    const request = parseRequest(await readStdin());
    const text = await callModelParser(request);
    const jsonText = extractJSONText(text);
    JSON.parse(jsonText);
    process.stdout.write(`${jsonText}\n`);
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
  buildChatBody,
  buildResponsesBody,
  callModelParser,
  extractJSONText,
  extractModelText,
  mode,
  modelName,
  parseRequest,
};
