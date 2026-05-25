"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const TIMEOUT_MS = 5000;

function runScriptTaskChecks({ workspace, filePath, checks = [] }) {
  const resolved = path.resolve(filePath || "");
  const wanted = normalizeChecks(checks);
  const results = [];
  const language = languageFromPath(resolved);
  if (!language) {
    return {
      ok: false,
      checks: [{ name: "language", status: "failed", detail: "unsupported_script_type" }],
      reason: "unsupported_script_type",
    };
  }
  if (wanted.includes("syntax")) {
    results.push(runSyntaxCheck({ workspace, filePath: resolved, language }));
  }
  if (wanted.includes("dry_run")) {
    results.push(runDryRun({ workspace, filePath: resolved, language }));
  }
  const failed = results.find((item) => item.status === "failed");
  return {
    ok: !failed,
    checks: results,
    reason: failed && failed.detail || "",
  };
}

function runSyntaxCheck({ workspace, filePath, language }) {
  const command = syntaxCommand(language, filePath);
  if (!command) {
    return { name: "syntax", status: "failed", detail: "unsupported_syntax_check" };
  }
  return runCommandCheck("syntax", command, workspace);
}

function runDryRun({ workspace, filePath, language }) {
  const safety = scriptSafety(filePath);
  if (!safety.ok) {
    return { name: "dry_run", status: "failed", detail: safety.reason };
  }
  const command = dryRunCommand(language, filePath);
  if (!command) {
    return { name: "dry_run", status: "failed", detail: "unsupported_dry_run" };
  }
  return runCommandCheck("dry_run", command, workspace);
}

function runCommandCheck(name, command, workspace) {
  try {
    execFileSync(command.file, command.args, {
      cwd: workspace,
      timeout: TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        QQ_TASK_DRY_RUN: "1",
        NO_COLOR: "1",
      },
    });
    return { name, status: "passed" };
  } catch (err) {
    return { name, status: "failed", detail: compactError(err) };
  }
}

function syntaxCommand(language, filePath) {
  if (language === "python") return { file: "python", args: ["-m", "py_compile", filePath] };
  if (language === "javascript") return { file: process.execPath, args: ["--check", filePath] };
  if (language === "powershell") {
    return {
      file: "powershell",
      args: [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-Command",
        "$errors=$null; [System.Management.Automation.PSParser]::Tokenize((Get-Content -Raw -LiteralPath $args[0]), [ref]$errors) | Out-Null; if ($errors -and $errors.Count -gt 0) { Write-Error ($errors | Out-String); exit 1 }",
        filePath,
      ],
    };
  }
  if (language === "bash") return { file: "bash", args: ["-n", filePath] };
  return null;
}

function dryRunCommand(language, filePath) {
  if (language === "python") return { file: "python", args: [filePath] };
  if (language === "javascript") return { file: process.execPath, args: [filePath] };
  if (language === "powershell") return { file: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", filePath] };
  if (language === "bash") return { file: "bash", args: [filePath] };
  return null;
}

function scriptSafety(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const blockers = [
    /\b(rm\s+-rf|del\s+\/[sq]|Remove-Item\b.*\b-Recurse\b|format\s+[A-Z]:)/i,
    /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|fetch\s*\(|requests\.)/i,
    /\b(child_process|subprocess|Start-Process|ProcessStartInfo|exec\s*\(|spawn\s*\()/i,
    /\b(\.env|token|cookie|secret|authorization|api[_-]?key)\b/i,
  ];
  const hit = blockers.find((pattern) => pattern.test(text));
  return hit ? { ok: false, reason: "dry_run_safety_blocked" } : { ok: true };
}

function normalizeChecks(checks) {
  const list = Array.isArray(checks) ? checks.map(String).filter(Boolean) : [];
  return [...new Set(list.length ? list : ["syntax"])];
}

function languageFromPath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".py") return "python";
  if (ext === ".js") return "javascript";
  if (ext === ".ps1") return "powershell";
  if (ext === ".sh") return "bash";
  return null;
}

function compactError(err) {
  return String((err && (err.stderr || err.stdout || err.message)) || "check_failed")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

module.exports = {
  runScriptTaskChecks,
  scriptSafety,
};
