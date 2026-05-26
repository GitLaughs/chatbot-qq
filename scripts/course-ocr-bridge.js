"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const PROVIDER_ENV = "QQ_COURSE_OCR_PROVIDER_COMMAND";

function main() {
  if (process.argv.includes("--self-test")) {
    const provider = normalizeCommand(process.env[PROVIDER_ENV] || "");
    writeJSON({
      ok: Boolean(provider),
      role: "course_schedule_ocr",
      provider_configured: Boolean(provider),
      reason: provider ? "" : "ocr_unconfigured",
      detail: provider ? `${PROVIDER_ENV} configured` : `set ${PROVIDER_ENV} to a JSON command array`,
    });
    return;
  }

  const input = fs.readFileSync(0, "utf8");
  let request;
  try {
    request = JSON.parse(input);
  } catch {
    writeJSON({ ok: false, reason: "bad_request", detail: "stdin must be JSON" });
    return;
  }

  const checked = sanitizeRequest(request);
  if (!checked.ok) {
    writeJSON(checked);
    return;
  }

  const provider = normalizeCommand(process.env[PROVIDER_ENV] || "");
  if (!provider) {
    writeJSON({
      ok: false,
      reason: "ocr_unconfigured",
      detail: `set ${PROVIDER_ENV} to a JSON command array, for example [\"python\",\"scripts/local-course-ocr.py\"]`,
    });
    return;
  }

  const result = spawnSync(provider.file, provider.args, {
    input: `${JSON.stringify(checked.request)}\n`,
    encoding: "utf8",
    cwd: checked.workspace,
    timeout: Math.max(1000, Number(process.env.QQ_COURSE_OCR_PROVIDER_TIMEOUT_MS || 15000) || 15000),
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });

  if (result.error) {
    writeJSON({
      ok: false,
      reason: result.error.code === "ETIMEDOUT" ? "ocr_timeout" : "ocr_provider_failed",
      detail: result.error.message || "",
    });
    return;
  }
  if (result.status !== 0) {
    writeJSON({
      ok: false,
      reason: "ocr_provider_failed",
      detail: compact(result.stderr || result.stdout || `exit ${result.status}`),
    });
    return;
  }

  const stdout = String(result.stdout || "").trim();
  if (!stdout) {
    writeJSON({ ok: true, text: "" });
    return;
  }
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === "object") {
      writeJSON(parsed);
      return;
    }
  } catch {
    // Plain provider stdout is valid OCR text.
  }
  writeJSON({ ok: true, text: stdout });
}

function sanitizeRequest(request) {
  if (!request || request.role !== "course_schedule_ocr") {
    return { ok: false, reason: "bad_role", detail: "expected role course_schedule_ocr" };
  }
  const workspace = path.resolve(request.context && request.context.workspace || process.cwd());
  const sourceImages = Array.isArray(request.source_images) ? request.source_images.map(String).slice(0, 8) : [];
  for (const source of sourceImages) {
    const checked = checkSourceImage(source, workspace);
    if (!checked.ok) {
      return checked;
    }
  }
  return {
    ok: true,
    workspace,
    request: {
      version: 1,
      role: "course_schedule_ocr",
      message: String(request.message || "").slice(0, 4000),
      source_images: sourceImages,
      context: {
        scope: request.context && request.context.scope || "",
        scopeID: request.context && request.context.scopeID || "",
        userID: request.context && request.context.userID || "",
        groupID: request.context && request.context.groupID || "",
        workspace,
      },
      rules: [
        "Extract timetable text or a course_schedule JSON spec only.",
        "Use only provided source_images and the current workspace.",
        "Do not read secrets, tokens, cookies, .env files, chat exports, or other workspaces.",
        "Do not create reminders or write files; return data only.",
      ],
    },
  };
}

function checkSourceImage(source, workspace) {
  const text = String(source || "").trim();
  if (!text || text === "[图片]") return { ok: true };
  if (/^https?:\/\//i.test(text)) return { ok: true };
  if (/^(file|data):/i.test(text)) {
    return { ok: false, reason: "source_image_blocked", detail: "file/data URI is not allowed" };
  }
  if (!/[\\/]|\.(png|jpe?g|webp|bmp|gif)$/i.test(text)) {
    return { ok: true };
  }
  const resolved = path.resolve(workspace, text);
  if (!isPathInside(resolved, workspace)) {
    return { ok: false, reason: "source_image_outside_workspace", detail: text };
  }
  return { ok: true };
}

function normalizeCommand(value) {
  if (Array.isArray(value) && value.length > 0) {
    return { file: String(value[0]), args: value.slice(1).map(String) };
  }
  if (value && typeof value === "object" && value.file) {
    return { file: String(value.file), args: Array.isArray(value.args) ? value.args.map(String) : [] };
  }
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    return normalizeCommand(JSON.parse(text));
  } catch {
    return { file: text, args: [] };
  }
}

function isPathInside(targetPath, rootPath) {
  const rel = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function writeJSON(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

main();
