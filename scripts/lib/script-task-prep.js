"use strict";

const path = require("path");

const LANGUAGE_EXT = {
  python: ".py",
  powershell: ".ps1",
  javascript: ".js",
  bash: ".sh",
};

function prepareScriptCreateTask({ spec = {}, text = "" }) {
  const language = normalizeLanguage(spec.language || inferLanguage(text));
  const errors = [];
  if (!language) {
    errors.push({ field: "language", message: "unsupported_or_missing_language" });
  }
  const output = normalizeOutputPath(spec.output_path, language, spec.title || spec.description || text);
  if (!output) {
    errors.push({ field: "output_path", message: "output_must_be_local_files_generated" });
  }
  const runAfterCreate = Boolean(spec.run_after_create);
  const preparedSpec = {
    ...spec,
    task_type: "script_create_and_run",
    title: spec.title || titleFromText(text),
    description: spec.description || String(text || "").trim(),
    language,
    output_path: output,
    run_after_create: runAfterCreate,
    checks: normalizeChecks(spec.checks, language, runAfterCreate),
  };
  return {
    ok: errors.length === 0,
    spec: preparedSpec,
    errors,
  };
}

function normalizeLanguage(value) {
  const text = String(value || "").trim().toLowerCase();
  const aliases = {
    py: "python",
    python3: "python",
    ps1: "powershell",
    pwsh: "powershell",
    js: "javascript",
    node: "javascript",
    nodejs: "javascript",
    shell: "bash",
    sh: "bash",
  };
  const normalized = aliases[text] || text;
  return LANGUAGE_EXT[normalized] ? normalized : null;
}

function inferLanguage(text) {
  const value = String(text || "");
  if (/powershell|ps1|pwsh/i.test(value)) return "powershell";
  if (/python|\.py|脚本.*统计|统计.*脚本/i.test(value)) return "python";
  if (/javascript|node(?:\.js)?|\.js/i.test(value)) return "javascript";
  if (/bash|shell|\.sh/i.test(value)) return "bash";
  return null;
}

function normalizeOutputPath(value, language, title) {
  const clean = normalizeRelativePath(value || "");
  if (clean && clean.startsWith("local_files/generated/") && !hasUnsafePathPart(clean)) {
    return clean;
  }
  if (!language) return null;
  const ext = LANGUAGE_EXT[language];
  const base = safeBaseName(titleFromText(title) || "generated-task");
  return `local_files/generated/${base}${ext}`;
}

function normalizeChecks(value, language, runAfterCreate) {
  const checks = Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  if (language && !checks.includes("syntax")) checks.push("syntax");
  if (runAfterCreate && !checks.includes("dry_run")) checks.push("dry_run");
  return checks.length ? [...new Set(checks)] : ["syntax"];
}

function titleFromText(text) {
  return String(text || "")
    .replace(/^(?:帮我|请|麻烦)?(?:写|新建|创建|生成)\s*/u, "")
    .replace(/[，。；;].*$/u, "")
    .trim()
    .slice(0, 40) || "generated-task";
}

function normalizeRelativePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .trim();
}

function hasUnsafePathPart(value) {
  return normalizeRelativePath(value).split("/").some((part) => part === ".." || part === "" || /^[A-Za-z]:$/.test(part));
}

function safeBaseName(value) {
  const ascii = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return ascii || "generated-task";
}

module.exports = {
  inferLanguage,
  prepareScriptCreateTask,
};
