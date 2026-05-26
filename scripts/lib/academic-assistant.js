"use strict";

const fs = require("fs");
const path = require("path");
const { addAcademicArchiveEntry, classifyAcademicWork } = require("./academic-archive");
const { addCapabilityGapProposal } = require("./growth-loop");

const CATEGORY_KIND = {
  problem_analysis: "problem",
  math_verification: "problem",
  report_guidance: "report",
  tuning: "tuning",
  netlist: "netlist",
  simulation: "simulation",
  unknown: "unknown",
};

const CATEGORY_LABEL = {
  problem_analysis: "题目解析",
  math_verification: "代码验算",
  report_guidance: "实验报告指导",
  tuning: "指标调参",
  netlist: "已有 netlist",
  simulation: "仿真分析",
  unknown: "学术任务",
};

function executeAcademicAssist({ workspace, spec = {}, text = "", context = {} }) {
  if (!workspace) {
    return { ok: false, reason: "workspace_missing", reply: "当前聊天 workspace 不可用，无法归档学术任务。" };
  }
  const normalized = normalizeAcademicSpec(spec, text);
  const guide = buildAcademicGuide(normalized, text);
  const verification = normalized.category === "math_verification" ? verifyMathText(text) : null;
  if (verification && !verification.ok) {
    addCapabilityGapProposal({
      workspace,
      scope: context.scope,
      scopeID: context.scopeID,
      userID: context.userID,
      gap: "math_verification_parser",
      evidence: verification.summary,
    });
  }
  if (normalized.category === "report_guidance") {
    addCapabilityGapProposal({
      workspace,
      scope: context.scope,
      scopeID: context.scopeID,
      userID: context.userID,
      gap: "academic_report_extraction",
      evidence: compact(text, 120),
    });
  }
  const artifact = writeAcademicArtifact({ workspace, spec: normalized, text, guide, verification, context });
  const kind = CATEGORY_KIND[normalized.category] || "unknown";
  addAcademicArchiveEntry({
    workspace,
    item: {
      scope: context.scope,
      scope_id: context.scopeID,
      user_id: context.userID,
      task_type: "academic_assist",
      kind,
      course: normalized.course,
      topic: normalized.topic,
      summary: compact([guide.summary, verification && verification.summary].filter(Boolean).join("；"), 220),
      artifacts: [artifact.relative_path],
      query_terms: [normalized.course, normalized.topic, normalized.category, kind].filter(Boolean),
      text,
    },
  });
  return {
    handled: true,
    ok: true,
    task_type: "academic_assist",
    item: { id: artifact.id },
    artifacts: [artifact.relative_path],
    checks: [{ name: "academic_assist", status: "passed" }],
    reply: formatAcademicReply({ spec: normalized, guide, verification, artifact }),
  };
}

function normalizeAcademicSpec(spec = {}, text = "") {
  const classified = classifyAcademicWork({ text: [text, JSON.stringify(spec || {})].join("\n"), taskType: "academic_assist" });
  const category = normalizeCategory(spec.category || categoryFromText(text) || categoryFromKind(classified.kind));
  return {
    task_type: "academic_assist",
    category,
    course: clean(spec.course || classified.course || courseFromText(text)),
    topic: clean(spec.topic || classified.topic || topicFromText(text)),
    request: clean(spec.request || text, 800),
    artifacts: normalizeList(spec.artifacts),
    data: spec.data && typeof spec.data === "object" ? spec.data : {},
    expected_output: clean(spec.expected_output || expectedOutputForCategory(category), 160),
  };
}

function buildAcademicGuide(spec, text = "") {
  const category = spec.category;
  if (category === "math_verification") {
    return {
      summary: "已识别为数学/线代验算任务，会优先做可确定的数值或矩阵验算。",
      steps: [
        "把题目中的矩阵、向量、方程或中间结果转成可复算表达。",
        "先用代码验算数值结论，再对照手算步骤找差异。",
        "如果题目还缺原始矩阵或待验算结论，请补充完整表达。",
      ],
    };
  }
  if (category === "report_guidance") {
    return {
      summary: "已识别为实验报告助手任务，会围绕实验要求、波形、数据表和公式参数整理报告指导。",
      steps: [
        "提取实验目的、仪器/软件、关键公式、电路或模块参数。",
        "按“原理、步骤、数据、结果分析、误差/问题”组织报告骨架。",
        "波形或数据表优先转成结论句，不直接堆原始数据。",
      ],
    };
  }
  if (category === "tuning") {
    return {
      summary: "已识别为指标调参任务，会按目标指标、当前现象、可调参数和验证方法推进。",
      steps: [
        "列出目标指标，例如增益、带宽、裕度、延迟、资源或误差。",
        "区分可调参数和不可改约束，逐项记录 before/after。",
        "每次只改少量参数，并保存仿真图、关键日志和结论。",
      ],
    };
  }
  if (category === "netlist") {
    return {
      summary: "已识别为已有 netlist 任务，会优先检查仿真入口、模型依赖和测量语句。",
      steps: [
        "确认 netlist 文件、模型 include、激励源、仿真类型和输出节点。",
        "先做语法/模型路径检查，再跑最小仿真。",
        "最终只回传波形图、测量结果和必要诊断，不乱发源 netlist。",
      ],
    };
  }
  if (category === "simulation") {
    return {
      summary: "已识别为仿真分析任务，会归档波形、关键结果和诊断记录。",
      steps: [
        "定位仿真工程、testbench/top、输入激励和期望输出。",
        "检查日志中的 error、critical warning 和 finish 条件。",
        "只回传波形图和关键结果；源码包仅在明确要求时准备。",
      ],
    };
  }
  return {
    summary: "已识别为题目解析任务，会先抽取题目条件、公式和待求量。",
    steps: [
      "整理已知条件、未知量、公式和单位。",
      "先给可验算的中间结果，再给最终结论。",
      "遇到计算型题目优先补代码验算或数值复核。",
    ],
  };
}

function verifyMathText(text) {
  const matrices = extractJSONMatrices(text);
  if (matrices.length >= 2 && /(相乘|乘积|矩阵乘|multiply|\*)/i.test(text)) {
    const result = multiplyMatrices(matrices[0], matrices[1]);
    if (result.ok) {
      return {
        ok: true,
        summary: `矩阵乘法验算结果：${JSON.stringify(result.value)}`,
        details: [`A=${JSON.stringify(matrices[0])}`, `B=${JSON.stringify(matrices[1])}`, `A*B=${JSON.stringify(result.value)}`],
      };
    }
    return { ok: false, summary: `矩阵乘法无法验算：${result.reason}`, details: [] };
  }
  if (matrices.length >= 1 && /(行列式|det|determinant)/i.test(text)) {
    const result = determinant(matrices[0]);
    if (result.ok) {
      return {
        ok: true,
        summary: `行列式验算结果：${result.value}`,
        details: [`A=${JSON.stringify(matrices[0])}`, `det(A)=${result.value}`],
      };
    }
    return { ok: false, summary: `行列式无法验算：${result.reason}`, details: [] };
  }
  return {
    ok: false,
    summary: "未检测到可直接验算的 JSON 矩阵；可用 [[1,2],[3,4]] 这类格式补充矩阵。",
    details: [],
  };
}

function extractJSONMatrices(text) {
  const value = String(text || "");
  const out = [];
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== "[") continue;
    const candidate = readBalancedArray(value, i);
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (isNumericMatrix(parsed)) {
        out.push(parsed);
        i += candidate.length - 1;
      }
    } catch {
      // Keep scanning.
    }
  }
  return out.slice(0, 4);
}

function readBalancedArray(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "[") depth += 1;
    if (ch === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return "";
}

function isNumericMatrix(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((row) => Array.isArray(row)
      && row.length === value[0].length
      && row.every((cell) => typeof cell === "number" && Number.isFinite(cell)));
}

function multiplyMatrices(a, b) {
  if (!isNumericMatrix(a) || !isNumericMatrix(b)) return { ok: false, reason: "not_matrix" };
  if (a[0].length !== b.length) return { ok: false, reason: "dimension_mismatch" };
  const rows = a.length;
  const cols = b[0].length;
  const inner = b.length;
  const out = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      for (let k = 0; k < inner; k += 1) {
        out[r][c] += a[r][k] * b[k][c];
      }
    }
  }
  return { ok: true, value: out };
}

function determinant(matrix) {
  if (!isNumericMatrix(matrix)) return { ok: false, reason: "not_matrix" };
  if (matrix.length !== matrix[0].length) return { ok: false, reason: "not_square" };
  if (matrix.length > 4) return { ok: false, reason: "matrix_too_large" };
  return { ok: true, value: detRecursive(matrix) };
}

function detRecursive(matrix) {
  if (matrix.length === 1) return matrix[0][0];
  if (matrix.length === 2) return matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0];
  let sum = 0;
  for (let c = 0; c < matrix.length; c += 1) {
    const minor = matrix.slice(1).map((row) => row.filter((_, index) => index !== c));
    sum += (c % 2 === 0 ? 1 : -1) * matrix[0][c] * detRecursive(minor);
  }
  return sum;
}

function writeAcademicArtifact({ workspace, spec, text, guide, verification, context }) {
  const date = new Date().toISOString().slice(0, 10);
  const id = `academic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(workspace, "local_files", "academic", date);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${safeName([spec.category, spec.topic || spec.course || "task"].filter(Boolean).join("-"))}-${id}.md`;
  const file = path.join(dir, filename);
  const relative = path.relative(workspace, file).replace(/\\/g, "/");
  const lines = [
    `# ${CATEGORY_LABEL[spec.category] || "学术任务"}${spec.topic ? ` - ${spec.topic}` : ""}`,
    "",
    `- time: ${new Date().toISOString()}`,
    `- scope: ${context.scope || ""}:${context.scopeID || ""}`,
    `- user_id: ${context.userID || ""}`,
    `- course: ${spec.course || ""}`,
    `- category: ${spec.category}`,
    `- artifact: ${relative}`,
    "",
    "## 用户请求",
    "",
    String(text || spec.request || "").trim(),
    "",
    "## 识别结果",
    "",
    `- 类型：${CATEGORY_LABEL[spec.category] || spec.category}`,
    `- 课程：${spec.course || "未识别"}`,
    `- 主题：${spec.topic || "未识别"}`,
    `- 期望输出：${spec.expected_output || ""}`,
    "",
    "## 处理建议",
    "",
    guide.summary,
    "",
    ...guide.steps.map((item) => `- ${item}`),
  ];
  if (verification) {
    lines.push("", "## 代码验算", "", verification.summary);
    for (const detail of verification.details || []) {
      lines.push(`- ${detail}`);
    }
  }
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return { id, path: file, relative_path: relative };
}

function formatAcademicReply({ spec, guide, verification, artifact }) {
  const lines = [
    `已识别：${CATEGORY_LABEL[spec.category] || "学术任务"}${spec.course ? ` / ${spec.course}` : ""}${spec.topic ? ` / ${spec.topic}` : ""}`,
    `关键处理：${guide.summary}`,
  ];
  if (verification) {
    lines.push(`验算：${verification.summary}`);
  }
  lines.push(`已归档：${artifact.relative_path}`);
  return lines.join("\n").slice(0, 1200);
}

function categoryFromText(text) {
  const value = String(text || "");
  if (/(已有\s*netlist|netlist|\.cir\b|\.sp\b|\.asc\b)/i.test(value)) return "netlist";
  if (/(实验报告|报告助手|实验要求|数据表|误差分析|报告)/i.test(value) && /(实验|波形|数据|公式|参数|报告)/i.test(value)) return "report_guidance";
  if (/(指标|调参|参数|优化|增益|带宽|相位裕度|裕量|tuning)/i.test(value)) return "tuning";
  if (/(验算|代码验证|代码验算|矩阵|行列式|线代|线性代数|高数|det|determinant)/i.test(value)) return "math_verification";
  if (/(仿真|波形|simulation|vivado|hspice|ltspice)/i.test(value)) return "simulation";
  if (/(题目|解析|证明|计算|公式)/i.test(value)) return "problem_analysis";
  return "unknown";
}

function categoryFromKind(kind) {
  if (kind === "report") return "report_guidance";
  if (kind === "problem") return "problem_analysis";
  if (kind === "tuning") return "tuning";
  if (kind === "netlist") return "netlist";
  if (kind === "simulation") return "simulation";
  return "unknown";
}

function normalizeCategory(value) {
  const text = String(value || "").trim();
  return Object.prototype.hasOwnProperty.call(CATEGORY_LABEL, text) ? text : "unknown";
}

function courseFromText(text) {
  return classifyAcademicWork({ text }).course || "";
}

function topicFromText(text) {
  return classifyAcademicWork({ text }).topic || "";
}

function expectedOutputForCategory(category) {
  if (category === "math_verification") return "代码验算结论";
  if (category === "report_guidance") return "实验报告指导";
  if (category === "tuning") return "调参步骤和验证指标";
  if (category === "netlist") return "netlist 仿真检查清单";
  if (category === "simulation") return "波形图和关键结果";
  return "题目解析和可验算结果";
}

function normalizeList(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 12) : [];
}

function safeName(value) {
  return String(value || "academic")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

function clean(value, limit = 240) {
  return compact(value, limit);
}

function compact(value, limit = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, Math.max(20, Number(limit) || 240));
}

module.exports = {
  executeAcademicAssist,
  extractJSONMatrices,
  normalizeAcademicSpec,
  verifyMathText,
};
