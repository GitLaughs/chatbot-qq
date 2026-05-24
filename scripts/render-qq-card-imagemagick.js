const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const args = parseArgs(process.argv.slice(2));
const textPath = requiredArg(args, "text");
const outPath = requiredArg(args, "out");
const title = args.title || "QQ Bot";
const width = Math.max(640, Number(args.width || 1200));
const rawText = fs.readFileSync(textPath, "utf8");

const pad = 44;
const bodySize = 24;
const maxUnits = Math.max(20, Math.floor((width - 132) / 13));
const lines = wrapText(rawText, maxUnits);
const maxBodyLines = 145;
const truncated = lines.length > maxBodyLines;
const visibleLines = truncated
  ? lines.slice(0, maxBodyLines).concat(["", "内容过长，已截断；完整文本已保存到本地 rendered/*.txt。"])
  : lines;
const bodyText = `${title}\n${localTimestamp()}\n\n${visibleLines.join("\n")}`;
const bodyPath = path.join(os.tmpdir(), `qq-card-body-${process.pid}-${Date.now()}.png`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
try {
  execFileSync(resolveConvert(), [
    "-background", "white",
    "-fill", "#1a202c",
    "-font", resolveFont(),
    "-pointsize", String(bodySize),
    "-size", `${Math.max(320, width - 132)}x`,
    `caption:${bodyText}`,
    bodyPath
  ], { stdio: "pipe", timeout: 30000 });
  execFileSync(resolveConvert(), [
    bodyPath,
    "-bordercolor", "white",
    "-border", `${pad}x${pad}`,
    "-bordercolor", "#d2dbe6",
    "-border", "2x2",
    "-bordercolor", "#f8fafc",
    "-border", "20x20",
    outPath
  ], { stdio: "pipe", timeout: 30000 });
} finally {
  fs.rmSync(bodyPath, { force: true });
}

function wrapText(input, maxUnits) {
  const lines = [];
  for (const raw of String(input || "").replace(/\r\n/g, "\n").split("\n")) {
    if (!raw.trim()) {
      lines.push("");
      continue;
    }
    let current = "";
    let units = 0;
    for (const ch of raw.trimEnd()) {
      const u = charUnits(ch);
      if (units + u > maxUnits && current) {
        lines.push(current);
        current = ch;
        units = u;
      } else {
        current += ch;
        units += u;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

function charUnits(ch) {
  return /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
}

function resolveConvert() {
  return process.env.ONEBOT_IMAGEMAGICK_CONVERT || "convert";
}

function resolveFont() {
  if (process.env.ONEBOT_RENDER_FONT) {
    return process.env.ONEBOT_RENDER_FONT;
  }
  const candidates = [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "Noto-Sans-CJK-SC",
    "Microsoft-YaHei"
  ];
  return candidates.find((candidate) => candidate.includes("/") ? fs.existsSync(candidate) : true);
}

function localTimestamp() {
  const d = new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === "--text" || key === "-TextPath") {
      result.text = next;
      i += 1;
    } else if (key === "--out" || key === "-OutPath") {
      result.out = next;
      i += 1;
    } else if (key === "--title" || key === "-Title") {
      result.title = next;
      i += 1;
    } else if (key === "--width" || key === "-Width") {
      result.width = next;
      i += 1;
    }
  }
  return result;
}

function requiredArg(args, name) {
  if (!args[name]) {
    throw new Error(`missing required argument: ${name}`);
  }
  return args[name];
}
