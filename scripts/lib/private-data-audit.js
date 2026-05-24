const fs = require("fs");
const path = require("path");

const DEFAULT_RULES_PATH = path.join(__dirname, "..", "..", "configs", "private-data-audit-rules.json");

function scanPrivateData({ root, scope = "Publish", rulesPath } = {}) {
  const normalizedScope = normalizeScope(scope);
  const base = path.resolve(root || path.join(__dirname, "..", ".."));
  const rules = loadRules(rulesPath);
  const files = collectFiles(base, normalizedScope, rules);
  const findings = [];
  const allowedSummary = createAllowedSummary(rules);

  for (const file of files) {
    if (rules.forbidden_file_names.includes(path.basename(file))) {
      const allowed = normalizedScope === "Live";
      findings.push({
        file: relativePath(base, file),
        line: 1,
        type: "forbidden local file",
        allowed_example: allowed,
        severity: allowed ? "warning" : "blocking",
        sample: path.basename(file)
      });
    }
  }

  for (const file of files) {
    const relative = relativePath(base, file);
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (_) {
      continue;
    }
    for (const pattern of rules.patterns) {
      pattern.regex.lastIndex = 0;
      for (const match of text.matchAll(pattern.regex)) {
        const value = match[0];
        const allowed = allowedFindingRule({ relative, name: pattern.name, rules });
        const liveWarning = !allowed && normalizedScope === "Live" && rules.live_warning_types.includes(pattern.name);
        if (allowed) {
          recordAllowedHit(allowedSummary, allowed, relative, pattern.name);
        }
        findings.push({
          file: relative,
          line: lineNumber(text, match.index || 0),
          type: pattern.name,
          allowed_example: Boolean(allowed || liveWarning),
          severity: (allowed || liveWarning) ? "warning" : "blocking",
          allowed_rule: allowed ? allowed.id : null,
          sample: `${value.slice(0, 10)}***`
        });
      }
    }
  }

  for (const item of allowedBudgetFindings(allowedSummary)) {
    findings.push(item);
  }
  const blocking = findings.filter((item) => !item.allowed_example);
  const warnings = findings.filter((item) => item.allowed_example);
  return {
    ok: blocking.length === 0,
    root: base,
    scope: normalizedScope,
    checked_files: files.length,
    findings,
    warnings,
    blocking,
    allowed_summary: Object.values(allowedSummary).map((item) => ({
      id: item.id,
      type: item.type,
      max_matches: item.max_matches,
      matches: item.matches,
      files: Array.from(item.files).sort()
    }))
  };
}

function explainPrivateDataPath({ root, scope = "Publish", rulesPath, relativePath: inputPath, isDirectory } = {}) {
  assertSafeRelativeExplainPath(inputPath);
  const normalizedScope = normalizeScope(scope);
  const base = path.resolve(root || path.join(__dirname, "..", ".."));
  const rules = loadRules(rulesPath);
  const normalizedRelative = normalizeRelativePath(inputPath);
  const full = path.join(base, normalizedRelative);
  const directory = isDirectory === undefined ? inferIsDirectory(normalizedRelative) : Boolean(isDirectory);
  const reason = getExcludeReason(base, full, normalizedScope, directory, rules);
  return {
    root: base,
    scope: normalizedScope,
    path: normalizedRelative,
    is_directory: directory,
    scanned: reason === null,
    excluded: reason !== null,
    reason
  };
}

function formatPrivateDataAudit(report) {
  const result = report || { ok: true, checked_files: 0, warnings: [], blocking: [] };
  const lines = [];
  if (result.ok) {
    lines.push(`OK private-data audit passed. scope=${result.scope || "Publish"} checked_files=${result.checked_files || 0}`);
  } else {
    lines.push(`FAIL private-data audit found blocking findings. scope=${result.scope || "Publish"}`);
    for (const item of result.blocking || []) {
      lines.push(`- ${item.file}:${item.line} ${item.type}`);
    }
  }
  if ((result.warnings || []).length > 0) {
    lines.push("WARN private-data audit non-blocking findings:");
    for (const item of result.warnings || []) {
      lines.push(`- ${item.file}:${item.line} ${item.type}`);
    }
  }
  if ((result.allowed_summary || []).length > 0) {
    lines.push("ALLOW private-data audit allowed findings:");
    for (const item of result.allowed_summary || []) {
      lines.push(`- ${item.id} ${item.type}: ${item.matches}/${item.max_matches} matches in ${(item.files || []).length} files`);
    }
  }
  return lines.join("\n");
}

function normalizeScope(scope) {
  const value = String(scope || "Publish").toLowerCase();
  if (value === "publish") return "Publish";
  if (value === "live") return "Live";
  throw new Error(`invalid audit scope: ${scope}`);
}

function loadRules(rulesPath) {
  const file = path.resolve(rulesPath || DEFAULT_RULES_PATH);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  validateRuleConfig(raw);
  return {
    max_file_bytes: Number(raw.max_file_bytes) || 2 * 1024 * 1024,
    common_exclude_dirs: raw.common_exclude_dirs || [],
    publish_exclude_dirs: raw.publish_exclude_dirs || [],
    publish_exclude_file_names: raw.publish_exclude_file_names || [],
    publish_exclude_extensions: (raw.publish_exclude_extensions || []).map((item) => String(item).toLowerCase()),
    publish_exclude_path_patterns: compilePatterns(raw.publish_exclude_path_patterns || []),
    publish_exclude_file_name_patterns: compilePatterns(raw.publish_exclude_file_name_patterns || []),
    forbidden_file_names: raw.forbidden_file_names || [],
    patterns: (raw.patterns || []).map((item) => ({ name: item.name, regex: new RegExp(item.regex, "gi") })),
    allowed_findings: (raw.allowed_findings || []).map((item) => ({
      id: item.id,
      type: item.type,
      max_matches: item.max_matches,
      path_patterns: compilePatterns(item.path_patterns || [])
    })),
    live_warning_types: raw.live_warning_types || []
  };
}

function validateRuleConfig(raw) {
  const allowedFindings = raw.allowed_findings || [];
  const ids = new Set();
  for (const item of allowedFindings) {
    if (typeof item.id !== "string" || item.id.trim() === "") {
      throw new Error("allowed finding rules must define an id");
    }
    if (ids.has(item.id)) {
      throw new Error(`allowed finding rule id must be unique: ${item.id}`);
    }
    ids.add(item.id);
    if (!Object.prototype.hasOwnProperty.call(item, "max_matches") || !Number.isInteger(item.max_matches) || item.max_matches < 0 || item.max_matches > 100) {
      throw new Error(`allowed finding rule ${item.id} must define max_matches between 0 and 100`);
    }
    if (String(item.type || "").toLowerCase() === "secret token") {
      throw new Error("private-data audit rules must not allow secret token findings");
    }
    for (const pattern of item.path_patterns || []) {
      validateAllowedPathPattern(pattern);
    }
  }
}

function validateAllowedPathPattern(pattern) {
  const text = String(pattern || "");
  if (!text || !text.startsWith("^")) {
    throw new Error(`allowed finding path pattern must be anchored: ${text}`);
  }
  if (/^\^?\.?\*\.?\*?\$?$/.test(text) || text === "^" || text === "^.*" || text === "^.*$") {
    throw new Error(`allowed finding path pattern is too broad: ${text}`);
  }
  const compiled = new RegExp(text, "i");
  const broadSentinels = [
    "source.js",
    "configs/cc-connect.napcat.local.toml",
    "groups/sandbox/AGENTS.md",
    "scripts/run-local.cmd"
  ];
  if (broadSentinels.some((sample) => compiled.test(sample))) {
    throw new Error(`allowed finding path pattern matches broad sentinel paths: ${text}`);
  }
}

function compilePatterns(patterns) {
  return patterns.map((pattern) => new RegExp(pattern, "i"));
}

function collectFiles(root, scope, rules) {
  const out = [];
  visit(root, out, root, scope, rules);
  return out;
}

function visit(dir, out, root, scope, rules) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isExcludedPath(root, full, scope, true, rules)) continue;
      visit(full, out, root, scope, rules);
    } else if (entry.isFile()) {
      if (isExcludedPath(root, full, scope, false, rules)) continue;
      const stat = fs.statSync(full);
      if (stat.size < rules.max_file_bytes) out.push(full);
    }
  }
}

function isExcludedPath(root, full, scope, isDirectory, rules) {
  return getExcludeReason(root, full, scope, isDirectory, rules) !== null;
}

function getExcludeReason(root, full, scope, isDirectory, rules) {
  const relative = relativePath(root, full);
  const name = path.basename(full);
  for (const dir of rules.common_exclude_dirs) {
    if (relative === dir || relative.startsWith(`${dir}/`)) return { type: "common_exclude_dir", value: dir };
  }
  if (scope !== "Publish") return null;
  for (const dir of rules.publish_exclude_dirs) {
    if (relative === dir || relative.startsWith(`${dir}/`)) return { type: "publish_exclude_dir", value: dir };
  }
  const pathPattern = rules.publish_exclude_path_patterns.find((pattern) => pattern.test(relative));
  if (pathPattern) return { type: "publish_exclude_path_pattern", value: pathPattern.source };
  if (!isDirectory) {
    if (rules.publish_exclude_file_names.includes(name)) return { type: "publish_exclude_file_name", value: name };
    const extension = path.extname(full).toLowerCase();
    if (rules.publish_exclude_extensions.includes(extension)) return { type: "publish_exclude_extension", value: extension };
    const filePattern = rules.publish_exclude_file_name_patterns.find((pattern) => pattern.test(name));
    if (filePattern) return { type: "publish_exclude_file_name_pattern", value: filePattern.source };
  }
  return null;
}

function allowedFindingRule({ relative, name, rules }) {
  const normalized = relative.replace(/\\/g, "/");
  for (const item of rules.allowed_findings) {
    if (item.type === name && item.path_patterns.some((pattern) => pattern.test(normalized))) {
      return item;
    }
  }
  return null;
}

function createAllowedSummary(rules) {
  const summary = {};
  for (const item of rules.allowed_findings) {
    summary[item.id] = {
      id: item.id,
      type: item.type,
      max_matches: item.max_matches,
      matches: 0,
      files: new Set()
    };
  }
  return summary;
}

function recordAllowedHit(summary, rule, relative, type) {
  if (!summary[rule.id]) {
    summary[rule.id] = { id: rule.id, type, max_matches: rule.max_matches, matches: 0, files: new Set() };
  }
  summary[rule.id].matches += 1;
  summary[rule.id].files.add(relative);
}

function allowedBudgetFindings(summary) {
  const findings = [];
  for (const item of Object.values(summary)) {
    if (item.matches > item.max_matches) {
      findings.push({
        file: "configs/private-data-audit-rules.json",
        line: 1,
        type: "allowed finding budget",
        allowed_example: false,
        severity: "blocking",
        allowed_rule: item.id,
        sample: `${item.id}: ${item.matches}/${item.max_matches}`
      });
    }
  }
  return findings;
}

function lineNumber(text, offset) {
  return text.slice(0, offset).split(/\n/).length;
}

function relativePath(root, file) {
  return path.relative(root, file).replace(/\\/g, "/");
}

function normalizeRelativePath(inputPath) {
  return String(inputPath).replace(/\\/g, "/").replace(/^\/+/, "");
}

function assertSafeRelativeExplainPath(inputPath) {
  const text = String(inputPath || "");
  if (!text.trim()) {
    throw new Error("--explain-path requires a relative path");
  }
  if (path.isAbsolute(text) || /^[A-Za-z]:/.test(text) || /^[\\/]/.test(text)) {
    throw new Error("--explain-path must be relative to --root");
  }
  const parts = text.replace(/\\/g, "/").split("/");
  if (parts.some((part) => part === "..")) {
    throw new Error("--explain-path must not contain .. segments");
  }
}

function inferIsDirectory(relative) {
  return relative.endsWith("/");
}

module.exports = {
  scanPrivateData,
  formatPrivateDataAudit,
  explainPrivateDataPath,
  loadRules,
  validateRuleConfig
};
