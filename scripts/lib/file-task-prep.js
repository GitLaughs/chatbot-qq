"use strict";

const path = require("path");
const { recentFiles } = require("./file-index");

function prepareFileModifyTask({ workspace, spec = {}, text = "", limit = 8 }) {
  const source = normalizeRelativePath(spec.source_file || explicitPath(text));
  const candidates = recentFileCandidates(workspace, limit);
  const picked = source ? findCandidateByPath(candidates, source) || pathCandidate(source) : candidates[0] || null;
  const errors = [];
  if (!picked || !picked.relative_path) {
    errors.push({ field: "source_file", message: "missing_source_file" });
  } else if (!isAllowedSource(picked.relative_path)) {
    errors.push({ field: "source_file", message: "source_must_be_current_workspace_file" });
  }
  const output = normalizeOutputPath(spec.output_path, picked && picked.relative_path);
  if (!output) {
    errors.push({ field: "output_path", message: "missing_output_path" });
  }
  const preparedSpec = {
    ...spec,
    task_type: "file_modify_and_return",
    source_file: picked && picked.relative_path || source || null,
    source_name: picked && (picked.name || path.basename(picked.relative_path || "")) || null,
    instructions: spec.instructions || String(text || "").trim(),
    output_path: output || null,
    checks: normalizeChecks(spec.checks, picked && picked.relative_path),
  };
  return {
    ok: errors.length === 0,
    spec: preparedSpec,
    errors,
    candidates,
  };
}

function recentFileCandidates(workspace, limit = 8) {
  try {
    return recentFiles({ workspace, limit })
      .filter((item) => isAllowedSource(item && item.relative_path))
      .map((item) => ({
        name: item.name || path.basename(item.relative_path || ""),
        relative_path: normalizeRelativePath(item.relative_path),
        extracted_path: normalizeRelativePath(item.extracted_path || ""),
        summary_path: normalizeRelativePath(item.summary_path || ""),
        ext: String(item.ext || path.extname(item.name || item.relative_path || "")).toLowerCase(),
        time: item.time || "",
      }));
  } catch {
    return [];
  }
}

function explicitPath(text) {
  const match = String(text || "").match(/(?:^|[\s"'：:，,])((?:local_files|received_files)\/[^\s"'<>，。；;]+)/);
  return match ? match[1] : "";
}

function findCandidateByPath(candidates, relativePath) {
  const wanted = normalizeRelativePath(relativePath);
  return (candidates || []).find((item) => normalizeRelativePath(item.relative_path) === wanted) || null;
}

function pathCandidate(relativePath) {
  const clean = normalizeRelativePath(relativePath);
  return clean ? { name: path.basename(clean), relative_path: clean, ext: path.extname(clean).toLowerCase() } : null;
}

function normalizeOutputPath(value, sourcePath) {
  const clean = normalizeRelativePath(value || "");
  if (clean && clean.startsWith("local_files/modified/") && !hasUnsafePathPart(clean)) {
    return clean;
  }
  const source = normalizeRelativePath(sourcePath || "");
  if (!source) return null;
  const parsed = path.posix.parse(source.replace(/\\/g, "/"));
  const base = safeBaseName(parsed.name || "modified");
  const ext = parsed.ext || "";
  return `local_files/modified/${base}-modified${ext}`;
}

function normalizeChecks(value, sourcePath) {
  const checks = Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  const ext = path.extname(String(sourcePath || "")).toLowerCase();
  if ([".js", ".json", ".ps1", ".py", ".md"].includes(ext) && !checks.includes("syntax")) {
    checks.push("syntax");
  }
  return checks.length ? [...new Set(checks)] : ["syntax"];
}

function isAllowedSource(value) {
  const clean = normalizeRelativePath(value);
  return Boolean(clean)
    && !hasUnsafePathPart(clean)
    && (clean.startsWith("local_files/") || clean.startsWith("received_files/"))
    && !clean.startsWith("local_files/modified/");
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
  return String(value || "modified")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "-")
    .slice(0, 80) || "modified";
}

module.exports = {
  explicitPath,
  isAllowedSource,
  prepareFileModifyTask,
  recentFileCandidates,
};
