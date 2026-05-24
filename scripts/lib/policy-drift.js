const fs = require("fs");
const path = require("path");

const MAX_FILE_BYTES = 512 * 1024;

const RULES = [
  {
    id: "official-primary",
    label: "官方 QQ Bot 主线漂移",
    pattern: /(official\s+qq\s+bot|官方\s*QQ\s*Bot|qqbot).{0,60}(first|primary|prefer|preferred|easiest|优先|主线|首选|最容易)/i,
    ignore: /(fallback|historical|reference|blocked|not the active|only if|不要|不切|不再|非主线|备用|历史|实验|除非)/i
  },
  {
    id: "qq-id-secret",
    label: "QQ号/群号隐私口径漂移",
    pattern: /(QQ\s*(numbers?|号)|group\s+IDs?|user\s+IDs?|群号|QQ号|用户\s*ID).{0,80}(sensitive|secret|private|do not commit|禁止|不包含|不发布|隐藏|隐私|敏感)/i,
    ignore: /(not secrets?|not sensitive|routing metadata|不是\s*(secret|敏感|隐私)|不按\s*(隐私|敏感)|路由元数据)/i
  },
  {
    id: "require-at-global",
    label: "全局 require_at 漂移",
    pattern: /(default|force|global|默认|强制).{0,40}require_at\s*=\s*true/i,
    ignore: /(do not|don't|不要|不强制|not force)/i
  },
  {
    id: "heavy-self-iteration",
    label: "重型自迭代漂移",
    pattern: /(建议|启用|使用|add|enable|use|run).{0,80}(vector database|向量库|embedding daemon|embedding rebuild|local LLM daemon|本地大模型|每消息|per-message|自动部署|auto-deploy|recursive self)/i,
    ignore: /(do not|don't|avoid|不要|禁止|不建议|不能|must not|无|without)/i
  },
  {
    id: "numeric-qq-id-blocker",
    label: "审计工具仍阻断数字QQ/群号",
    pattern: /numeric qq id/i,
    ignore: null
  }
];

function scanPolicyDrift({ root, limit = 20 }) {
  const base = path.resolve(root || path.join(__dirname, "..", ".."));
  const findings = [];
  for (const file of policyFiles(base)) {
    if (!fs.existsSync(file)) continue;
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const rule of RULES) {
        if (!rule.pattern.test(line)) continue;
        if (shouldIgnoreLine(rule, lines, index)) continue;
        findings.push({
          file: relativePath(base, file),
          line: index + 1,
          rule: rule.id,
          label: rule.label,
          text: line.trim().slice(0, 160)
        });
        break;
      }
    });
  }
  const max = Math.max(1, Math.min(50, Number(limit) || 20));
  return {
    ok: findings.length === 0,
    checked_files: policyFiles(base).filter((file) => fs.existsSync(file)).length,
    findings: findings.slice(0, max),
    total_findings: findings.length
  };
}

function formatPolicyDrift(report) {
  const result = report || { ok: true, checked_files: 0, findings: [], total_findings: 0 };
  const lines = [
    "口径巡检：",
    `结果：${result.ok ? "未发现漂移" : "发现漂移"}`,
    `检查文件：${result.checked_files}`,
    `命中：${result.total_findings}`
  ];
  if (!result.ok) {
    for (const item of result.findings || []) {
      lines.push(`- ${item.file}:${item.line} [${item.label}] ${item.text}`);
    }
  }
  lines.push("规则：官方QQBot主线、QQ号/群号隐私化、全局require_at、重型自迭代、numeric qq id 阻断。");
  return lines.join("\n").slice(0, 1800);
}

function shouldIgnoreLine(rule, lines, index) {
  const line = lines[index] || "";
  if (rule.ignore && rule.ignore.test(line)) return true;
  const context = previousContext(lines, index, 8);
  if (rule.id === "heavy-self-iteration") {
    return /(must not|mustn't|do not|don't|avoid|禁止|不要|不得|不应|不能|不可)/i.test(context);
  }
  return false;
}

function previousContext(lines, index, windowSize) {
  const start = Math.max(0, index - windowSize);
  return lines.slice(start, index + 1).join("\n");
}

function policyFiles(root) {
  const files = [
    "AGENTS.md",
    "README.md",
    "scripts/audit-private-data.ps1"
  ].map((name) => path.join(root, name));
  for (const dir of ["docs", "groups"]) {
    const full = path.join(root, dir);
    collectPolicyFiles(full, files);
  }
  return [...new Set(files)];
}

function collectPolicyFiles(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "memory" || entry.name === "local_files" || entry.name === "node_modules") continue;
      collectPolicyFiles(full, out);
    } else if (entry.name === "AGENTS.md" || (full.includes(`${path.sep}docs${path.sep}`) && entry.name.endsWith(".md"))) {
      out.push(full);
    }
  }
}

function relativePath(root, file) {
  return path.relative(root, file).replace(/\\/g, "/");
}

module.exports = {
  scanPolicyDrift,
  formatPolicyDrift
};
