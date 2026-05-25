const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

let mathRenderer = null;
let mathRendererFailed = false;

if (require.main === module) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const textPath = requiredArg(args, "text");
  const outPath = requiredArg(args, "out");
  const title = args.title || "QQ Bot";
  const width = Math.max(480, Number(args.width || 720));
  const rawText = fs.readFileSync(textPath, "utf8");
  renderCard({ rawText, outPath, title, width });
}

function renderCard({ rawText, outPath, title = "QQ Bot", width = 720 }) {
  const metrics = cardMetrics(width);
  const pages = layoutPages(rawText, metrics);
  const outputPaths = outputPagePaths(outPath, pages.length);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  pages.forEach((page, index) => {
    renderSvgPage({
      page,
      outPath: outputPaths[index],
      title: pages.length > 1 ? `${title} (${index + 1}/${pages.length})` : title,
      metrics
    });
  });
  return outputPaths;
}

function cardMetrics(width = 720) {
  const bodySize = 25;
  const headerSize = 30;
  const outerPad = 24;
  const cardPadX = 28;
  const cardPadTop = 24;
  const cardPadBottom = 32;
  const border = 1;
  const headerHeight = 0;
  const minHeight = 320;
  const maxHeight = Math.max(480, Number(process.env.ONEBOT_RENDER_MAX_HEIGHT || 680));
  const bodyLineHeight = Math.ceil(bodySize * 1.65);
  const bodyOverflowPad = bodyLineHeight;
  const bodyWidth = Math.max(300, width - (outerPad + border + cardPadX) * 2);
  const fixedHeight = outerPad * 2 + border * 2 + cardPadTop + cardPadBottom;
  const maxBodyHeight = Math.max(bodyLineHeight, maxHeight - fixedHeight - 12);
  const minBodyHeight = Math.max(bodyLineHeight, minHeight - fixedHeight);
  return {
    width,
    bodySize,
    headerSize,
    outerPad,
    cardPadX,
    cardPadTop,
    cardPadBottom,
    border,
    headerHeight,
    minHeight,
    maxHeight,
    bodyLineHeight,
    bodyOverflowPad,
    bodyWidth,
    maxUnits: Math.max(20, Math.floor(bodyWidth / 13)),
    maxBodyLines: Math.max(1, Math.floor((maxBodyHeight - bodyOverflowPad) / bodyLineHeight)),
    minBodyHeight
  };
}

function layoutPages(rawText, metrics = cardMetrics()) {
  const blocks = parseBlocks(rawText);
  const pages = [];
  let ops = [];
  let y = pageContentTop(metrics);
  let contentBottom = pageContentBottom(metrics);

  const finishPage = () => {
    const height = Math.min(metrics.maxHeight, Math.max(metrics.minHeight, Math.ceil(y + metrics.cardPadBottom + metrics.outerPad)));
    pages.push({ ops, height });
    ops = [];
    y = pageContentTop(metrics);
    contentBottom = pageContentBottom(metrics);
  };

  const ensureSpace = (height) => {
    if (ops.length > 0 && y + height > contentBottom) {
      finishPage();
    }
  };

  for (const block of blocks) {
    if (block.type === "blank") {
      ensureSpace(block.height);
      y += block.height;
      continue;
    }
    if (block.type === "code") {
      const rows = wrapPlainText(block.text, metrics.bodyWidth, metrics.bodySize, 0.56);
      for (const row of rows.length ? rows : [""]) {
        const height = Math.ceil(metrics.bodyLineHeight * 0.95);
        ensureSpace(height);
        ops.push({ type: "code", text: row, x: contentX(metrics), y, width: metrics.bodyWidth, height });
        y += height;
      }
      y += 6;
      continue;
    }
    if (block.type === "formula") {
      const math = renderMathBlock(block.text, true, metrics);
      const height = Math.ceil(math.height + 24);
      ensureSpace(height);
      ops.push({
        type: "math",
        math,
        x: Math.round(contentX(metrics) + Math.max(0, (metrics.bodyWidth - math.width) / 2)),
        y: Math.round(y + 10)
      });
      y += height;
      continue;
    }
    const style = block.type === "heading" ? "heading" : "body";
    const rows = layoutInlineRows(block.text, metrics, style);
    for (const row of rows) {
      ensureSpace(row.height);
      addInlineRowOps(ops, row, contentX(metrics), y, style, metrics);
      y += row.height;
    }
    if (block.type === "heading") {
      y += 4;
    }
  }

  if (ops.length === 0) {
    ops.push({ type: "text", text: "", x: contentX(metrics), y, size: metrics.bodySize });
  }
  finishPage();
  return pages;
}

function parseBlocks(rawText) {
  const lines = String(rawText || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      blocks.push({ type: "blank", height: 20 });
      i += 1;
      continue;
    }
    if (/^\s*代码：\s*$/.test(line) || /^```/.test(line)) {
      const codeLines = [];
      if (/^```/.test(line)) {
        i += 1;
        while (i < lines.length && !/^```/.test(lines[i])) {
          codeLines.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1;
      } else {
        i += 1;
        while (i < lines.length && lines[i].trim()) {
          codeLines.push(lines[i]);
          i += 1;
        }
      }
      blocks.push({ type: "code", text: codeLines.join("\n") });
      continue;
    }
    if (/^【.+】$/.test(line.trim())) {
      blocks.push({ type: "heading", text: line.trim().replace(/^【|】$/g, "") });
      i += 1;
      continue;
    }
    if (isFormulaLine(line)) {
      const formulaLines = [];
      while (i < lines.length && (isFormulaLine(lines[i]) || isFormulaContinuationLine(lines[i], formulaLines))) {
        if (lines[i].trim()) {
          formulaLines.push(lines[i].trim());
        }
        i += 1;
      }
      blocks.push({ type: "formula", text: normalizeFormulaLines(formulaLines) });
      continue;
    }
    blocks.push({ type: "paragraph", text: line.trimEnd() });
    i += 1;
  }
  return blocks;
}

function isFormulaContinuationLine(line, previousLines) {
  if (!previousLines.length) return false;
  const trimmed = String(line || "").trim();
  return trimmed === "=" || trimmed === "+" || trimmed === "-" || trimmed === "\\";
}

function isFormulaLine(line) {
  const s = String(line || "").trim();
  if (!s) return false;
  if (/[\u4e00-\u9fff]/.test(s)) return false;
  if (/^[=+\-*/]+$/.test(s)) return false;
  if (s.length < 2) return false;
  return /(\\[A-Za-z]+|[_^]\{[^}]+\}|\^[A-Za-z0-9]+|_[A-Za-z0-9]+|\\frac\{|\\sqrt\{|\\sum|\\int|\\begin\{)/.test(s);
}

function normalizeFormulaLines(lines) {
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    const current = lines[i];
    if ((lines[i + 1] || "").trim() === "=" && lines[i + 2]) {
      rows.push(`${current} = ${lines[i + 2]}`);
      i += 2;
    } else {
      rows.push(current);
    }
  }
  if (rows.length <= 1) {
    return rows[0] || "";
  }
  return `\\begin{aligned}${rows.join("\\\\")}\\end{aligned}`;
}

function layoutInlineRows(text, metrics, style = "body") {
  const fontSize = style === "heading" ? 30 : metrics.bodySize;
  const lineHeight = style === "heading" ? 46 : metrics.bodyLineHeight;
  const tokens = tokenizeInlineMath(text, fontSize);
  const rows = [];
  let row = { tokens: [], width: 0, height: lineHeight };

  const pushRow = () => {
    if (row.tokens.length) {
      rows.push(row);
    }
    row = { tokens: [], width: 0, height: lineHeight };
  };

  for (const token of tokens) {
    const parts = token.type === "text" ? splitTextForWrap(token.text, fontSize, metrics.bodyWidth) : [token];
    for (const part of parts) {
      const item = part.type ? part : { type: "text", text: part, width: estimateTextWidth(part, fontSize), height: lineHeight };
      if (item.type === "math" && item.width > metrics.bodyWidth) {
        const scale = metrics.bodyWidth / item.width;
        item.width = Math.max(1, item.width * scale);
        item.height = Math.max(1, item.height * scale);
      }
      if (row.tokens.length && row.width + item.width > metrics.bodyWidth) {
        pushRow();
      }
      row.tokens.push(item);
      row.width += item.width;
      row.height = Math.max(row.height, Math.ceil((item.height || lineHeight) + 8));
    }
  }
  pushRow();
  return rows.length ? rows : [{ tokens: [{ type: "text", text: "", width: 0, height: lineHeight }], width: 0, height: lineHeight }];
}

function tokenizeInlineMath(text, fontSize) {
  const source = String(text || "");
  const tokens = [];
  const explicit = /(\\\(([\s\S]*?)\\\)|\$([^$\n]+)\$)/g;
  let last = 0;
  let match;
  while ((match = explicit.exec(source)) !== null) {
    if (match.index > last) {
      tokens.push(...tokenizeImplicitMath(source.slice(last, match.index), fontSize));
    }
    const tex = match[2] || match[3] || "";
    tokens.push(mathToken(tex, false, fontSize));
    last = match.index + match[0].length;
  }
  if (last < source.length) {
    tokens.push(...tokenizeImplicitMath(source.slice(last), fontSize));
  }
  return mergeAdjacentText(tokens);
}

function tokenizeImplicitMath(text, fontSize) {
  const tokens = [];
  const pattern = /(\\frac\{[^}]+\}\{[^}]+\}|\\[A-Za-z]+|[A-Za-z0-9\\{}_^+\-*/=().]+(?:\\[A-Za-z]+|[_^]\{[^}]+\}|[_^][A-Za-z0-9])[A-Za-z0-9\\{}_^+\-*/=().]*)/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const value = match[0];
    if (!looksLikeInlineFormula(value)) {
      continue;
    }
    if (match.index > last) {
      tokens.push(textToken(text.slice(last, match.index), fontSize));
    }
    tokens.push(mathToken(value, false, fontSize));
    last = match.index + value.length;
  }
  if (last < text.length) {
    tokens.push(textToken(text.slice(last), fontSize));
  }
  return tokens;
}

function looksLikeInlineFormula(value) {
  const s = String(value || "");
  if (s.length < 2) return false;
  return /(\\[A-Za-z]+|[_^]\{[^}]+\}|[_^][A-Za-z0-9]|\\frac\{)/.test(s);
}

function mergeAdjacentText(tokens) {
  const merged = [];
  for (const token of tokens) {
    const last = merged[merged.length - 1];
    if (token.type === "text" && last && last.type === "text") {
      last.text += token.text;
      last.width += token.width;
    } else {
      merged.push(token);
    }
  }
  return merged;
}

function textToken(text, fontSize) {
  return { type: "text", text, width: estimateTextWidth(text, fontSize), height: Math.ceil(fontSize * 1.65) };
}

function mathToken(tex, display, fontSize) {
  const math = renderMathBlock(tex, display, { bodySize: fontSize, bodyWidth: 600 });
  return { type: "math", tex, math, width: math.width, height: math.height };
}

function splitTextForWrap(text, fontSize, maxWidth) {
  const parts = [];
  let current = "";
  let width = 0;
  for (const ch of String(text || "")) {
    const w = estimateTextWidth(ch, fontSize);
    if (current && width + w > maxWidth) {
      parts.push(current);
      current = ch;
      width = w;
    } else {
      current += ch;
      width += w;
    }
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

function addInlineRowOps(ops, row, x, y, style, metrics) {
  const fontSize = style === "heading" ? 30 : metrics.bodySize;
  const baseline = y + Math.max(fontSize, Math.round(row.height * 0.72));
  let currentX = x;
  for (const token of row.tokens) {
    if (token.type === "math") {
      const mathY = baseline - Math.round(token.height * 0.78);
      ops.push({ type: "math", math: token.math, x: Math.round(currentX), y: Math.round(mathY) });
      currentX += token.width;
    } else {
      ops.push({ type: "text", text: token.text, x: Math.round(currentX), y: baseline, size: fontSize, style });
      currentX += token.width;
    }
  }
}

function renderMathBlock(tex, display, metrics) {
  const fontSize = Math.max(18, Number(metrics.bodySize || 25));
  const fallbackWidth = Math.min(Number(metrics.bodyWidth || 600), Math.max(80, estimateTextWidth(tex, fontSize)));
  const fallbackHeight = Math.ceil(fontSize * (display ? 1.8 : 1.25));
  try {
    const renderer = getMathRenderer();
    if (!renderer) throw new Error("mathjax unavailable");
    const html = renderer.convert(String(tex || ""), { display: Boolean(display) });
    const math = parseMathSvg(html, fontSize);
    if (!math) throw new Error("mathjax svg parse failed");
    const maxWidth = Math.max(120, Number(metrics.bodyWidth || 600));
    if (math.width > maxWidth) {
      const scale = maxWidth / math.width;
      math.width = Math.max(1, math.width * scale);
      math.height = Math.max(1, math.height * scale);
    }
    return math;
  } catch {
    return {
      fallback: true,
      text: String(tex || ""),
      width: fallbackWidth,
      height: fallbackHeight
    };
  }
}

function getMathRenderer() {
  if (mathRendererFailed) return null;
  if (mathRenderer) return mathRenderer;
  try {
    const { mathjax } = require("mathjax-full/js/mathjax.js");
    const { TeX } = require("mathjax-full/js/input/tex.js");
    const { SVG } = require("mathjax-full/js/output/svg.js");
    const { liteAdaptor } = require("mathjax-full/js/adaptors/liteAdaptor.js");
    const { RegisterHTMLHandler } = require("mathjax-full/js/handlers/html.js");
    const { AllPackages } = require("mathjax-full/js/input/tex/AllPackages.js");
    const adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    const tex = new TeX({ packages: AllPackages });
    const svg = new SVG({ fontCache: "none" });
    const document = mathjax.document("", { InputJax: tex, OutputJax: svg });
    mathRenderer = {
      convert: (source, options) => adaptor.outerHTML(document.convert(source, options))
    };
    return mathRenderer;
  } catch {
    mathRendererFailed = true;
    return null;
  }
}

function parseMathSvg(html, fontSize) {
  const svgMatch = String(html || "").match(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/);
  if (!svgMatch) return null;
  const attrs = svgMatch[1];
  const inner = svgMatch[2];
  const viewBox = attrValue(attrs, "viewBox") || "0 0 1000 1000";
  const widthAttr = attrValue(attrs, "width");
  const heightAttr = attrValue(attrs, "height");
  const view = viewBox.split(/\s+/).map(Number);
  const viewWidth = Number.isFinite(view[2]) ? view[2] : 1000;
  const viewHeight = Number.isFinite(view[3]) ? view[3] : 1000;
  const width = parseSvgLength(widthAttr, fontSize) || Math.max(1, viewWidth / 1000 * fontSize);
  const height = parseSvgLength(heightAttr, fontSize) || Math.max(1, viewHeight / 1000 * fontSize);
  return { svg: inner.replace(/currentColor/g, "#1F2937"), viewBox, width: Math.ceil(width), height: Math.ceil(height) };
}

function attrValue(attrs, name) {
  const match = String(attrs || "").match(new RegExp(`${name}="([^"]+)"`));
  return match ? match[1] : "";
}

function parseSvgLength(value, fontSize) {
  const match = String(value || "").match(/^([0-9.]+)(ex|em|px)?$/);
  if (!match) return 0;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = match[2] || "px";
  if (unit === "em") return n * fontSize;
  if (unit === "ex") return n * fontSize * 0.52;
  return n;
}

function renderSvgPage({ page, outPath, title, metrics }) {
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const svgPath = path.join(os.tmpdir(), `qq-card-${stamp}.svg`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const svg = buildPageSvg(page, title, metrics);
  try {
    fs.writeFileSync(svgPath, svg, "utf8");
    if (commandExists("rsvg-convert")) {
      execFileSync("rsvg-convert", ["-f", "png", "-o", outPath, svgPath], { stdio: "pipe", timeout: 30000 });
    } else {
      execFileSync(resolveConvert(), [svgPath, outPath], { stdio: "pipe", timeout: 30000 });
    }
  } finally {
    if (!process.env.ONEBOT_RENDER_KEEP_TMP) {
      fs.rmSync(svgPath, { force: true });
    }
  }
}

function buildPageSvg(page, title, metrics) {
  const height = Math.max(metrics.minHeight, page.height);
  const cardX = metrics.outerPad;
  const cardY = metrics.outerPad;
  const cardW = metrics.width - metrics.outerPad * 2;
  const cardH = height - metrics.outerPad * 2;
  const items = [];
  items.push(`<rect width="${metrics.width}" height="${height}" fill="#F6F7F9"/>`);
  items.push(`<rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" fill="#FFFFFF" stroke="#E5E7EB" stroke-width="${metrics.border}"/>`);
  for (const op of page.ops) {
    if (op.type === "text") {
      const fill = op.style === "heading" ? "#111827" : "#1F2937";
      const weight = op.style === "heading" ? "700" : "400";
      items.push(`<text x="${op.x}" y="${op.y}" fill="${fill}" font-family="Noto Sans CJK SC, Microsoft YaHei, Arial, sans-serif" font-weight="${weight}" font-size="${op.size || metrics.bodySize}">${escapeXml(op.text)}</text>`);
    } else if (op.type === "code") {
      items.push(`<rect x="${op.x - 8}" y="${op.y - 2}" width="${op.width + 16}" height="${op.height - 4}" rx="4" fill="#F1F5F9"/>`);
      items.push(`<text x="${op.x}" y="${op.y + Math.round(op.height * 0.67)}" fill="#1F2937" font-family="Consolas, DejaVu Sans Mono, monospace" font-size="${Math.max(18, metrics.bodySize - 3)}">${escapeXml(op.text)}</text>`);
    } else if (op.type === "math") {
      items.push(mathSvgElement(op.math, op.x, op.y, metrics));
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${metrics.width}" height="${height}" viewBox="0 0 ${metrics.width} ${height}">
<style>
.body{font-family:"Noto Sans CJK SC","Microsoft YaHei","Arial",sans-serif;fill:#1F2937;font-weight:400}
.heading{font-family:"Noto Sans CJK SC","Microsoft YaHei","Arial",sans-serif;fill:#111827;font-weight:700}
.code{font-family:"Consolas","DejaVu Sans Mono",monospace;fill:#1F2937;font-weight:400}
svg { overflow: visible; }
</style>
${items.join("\n")}
</svg>`;
}

function mathSvgElement(math, x, y, metrics) {
  if (!math || math.fallback) {
    const text = math && math.text ? math.text : "";
    return `<text x="${x}" y="${y + Math.round(metrics.bodyLineHeight * 0.75)}" fill="#1F2937" font-family="Consolas, DejaVu Sans Mono, monospace" font-size="${Math.max(18, metrics.bodySize - 2)}">${escapeXml(text)}</text>`;
  }
  return `<svg x="${x}" y="${y}" width="${Math.ceil(math.width)}" height="${Math.ceil(math.height)}" viewBox="${escapeXml(math.viewBox)}" preserveAspectRatio="xMinYMid meet">${math.svg}</svg>`;
}

function pageContentTop(metrics) {
  return metrics.outerPad + metrics.border + metrics.cardPadTop;
}

function pageContentBottom(metrics) {
  return metrics.maxHeight - metrics.outerPad - metrics.border - metrics.cardPadBottom;
}

function contentX(metrics) {
  return metrics.outerPad + metrics.border + metrics.cardPadX;
}

function estimateTextWidth(text, fontSize) {
  let units = 0;
  for (const ch of String(text || "")) {
    if (ch === "\t") {
      units += 2;
    } else if (/[\u4e00-\u9fff\uff00-\uffef]/.test(ch)) {
      units += 1.05;
    } else if (/\s/.test(ch)) {
      units += 0.33;
    } else if (/[ilI.,:;|!]/.test(ch)) {
      units += 0.32;
    } else if (/[A-Z0-9]/.test(ch)) {
      units += 0.66;
    } else {
      units += 0.56;
    }
  }
  return units * fontSize;
}

function wrapPlainText(input, maxWidth, fontSize, asciiFactor = 0.56) {
  const rows = [];
  for (const raw of String(input || "").replace(/\r\n/g, "\n").split("\n")) {
    if (!raw) {
      rows.push("");
      continue;
    }
    let current = "";
    let width = 0;
    for (const ch of raw) {
      const w = /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? fontSize : fontSize * asciiFactor;
      if (current && width + w > maxWidth) {
        rows.push(current);
        current = ch;
        width = w;
      } else {
        current += ch;
        width += w;
      }
    }
    if (current) rows.push(current);
  }
  return rows;
}

function paginateBodyText(rawText, metrics = cardMetrics()) {
  const lines = wrapText(rawText, metrics.maxUnits);
  const sourceLines = lines.length > 0 ? lines : [""];
  const pages = [];
  for (let i = 0; i < sourceLines.length; i += metrics.maxBodyLines) {
    pages.push(sourceLines.slice(i, i + metrics.maxBodyLines));
  }
  return pages.length > 0 ? pages : [[""]];
}

function outputPagePaths(outPath, count) {
  if (count <= 1) {
    return [outPath];
  }
  const parsed = path.parse(outPath);
  return Array.from({ length: count }, (_, index) => (
    index === 0
      ? outPath
      : joinOutputPath(parsed.dir, `${parsed.name}-${index + 1}${parsed.ext || ".png"}`)
  ));
}

function joinOutputPath(dir, name) {
  if (!dir) {
    return name;
  }
  if (dir.includes("/") && !dir.includes("\\")) {
    return `${dir.replace(/\/+$/, "")}/${name}`;
  }
  return path.join(dir, name);
}

function buildVisibleBodyText(rawText, bodyWidth) {
  const metrics = cardMetrics(Number(bodyWidth || 720));
  return paginateBodyText(rawText, metrics)[0].join("\n");
}

function captionArgForFile(filePath) {
  return `caption:@${filePath}`;
}

function captionArgForText(text) {
  return `caption:${String(text || "").replace(/\0/g, "")}`;
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

function commandExists(command) {
  try {
    execFileSync("which", [command], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
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

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = {
  buildVisibleBodyText,
  cardMetrics,
  captionArgForFile,
  captionArgForText,
  charUnits,
  outputPagePaths,
  paginateBodyText,
  parseArgs,
  renderCard,
  requiredArg,
  wrapText
};
