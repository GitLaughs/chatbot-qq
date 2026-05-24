const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function createCapabilitySnapshot(deps) {
  const now = new Date().toISOString();
  const checks = {
    onebot_upstream: Boolean(deps.upstreamReady && deps.upstreamReady()),
    proxy_clients: connectedClientCount(deps),
    dream: checkDream(deps),
    image_generation: checkImage(deps),
    rendering: checkRender(deps),
    pdf_parse: checkNodeRequire("pdf-parse"),
    curl: checkCommand("curl"),
    node: { ok: true, detail: process.version },
    workspace_root: { ok: Boolean(deps.workspaceRoot), detail: deps.workspaceRoot || "" }
  };
  return {
    version: 1,
    time: now,
    mode: {
      default_listen: deps.defaultListenMode,
      dream_enabled: Boolean(deps.dreamEnabled),
      image_enabled: Boolean(deps.imageEnabled)
    },
    checks
  };
}

function writeCapabilitySnapshot({ file, snapshot, log = () => {} }) {
  if (!file || !snapshot) {
    return;
  }
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), "utf8");
  } catch (err) {
    log("capability snapshot write failed", err.message);
  }
}

function readCapabilitySnapshot(file) {
  if (!file || !fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function formatCapabilitySummary(snapshot) {
  if (!snapshot) {
    return ["能力快照：暂无"];
  }
  const checks = snapshot.checks || {};
  const line = (name, label) => `${label}:${checks[name] && checks[name].ok ? "可用" : "不可用"}`;
  return [
    `能力快照：${String(snapshot.time || "").replace("T", " ").slice(0, 19) || "未知时间"}`,
    [
      line("onebot_upstream", "OneBot"),
      line("dream", "dream"),
      line("image_generation", "画图"),
      line("rendering", "渲染"),
      line("pdf_parse", "PDF")
    ].join("，")
  ];
}

function connectedClientCount(deps) {
  const clients = deps.clients;
  return {
    ok: clients && clients.size > 0,
    detail: clients ? `${clients.size} connected` : "no clients map"
  };
}

function checkDream(deps) {
  if (!deps.dreamEnabled) {
    return { ok: false, detail: "disabled" };
  }
  const groups = deps.allowedGroups || [];
  if (groups.length === 0 || !deps.workspaceForGroup) {
    return { ok: false, detail: "no group workspace" };
  }
  const workspace = deps.workspaceForGroup(groups[0]);
  const script = process.platform === "win32"
    ? path.join(workspace, "scripts", "dream.ps1")
    : path.join(workspace, "scripts", "dream.sh");
  return { ok: fs.existsSync(script), detail: script };
}

function checkImage(deps) {
  if (!deps.imageEnabled) {
    return { ok: false, detail: "disabled" };
  }
  const script = deps.imageScript || "";
  return { ok: Boolean(script && fs.existsSync(script)), detail: script };
}

function checkRender(deps) {
  const script = deps.renderImageMagickScript || deps.renderScript || "";
  return { ok: Boolean(script && fs.existsSync(script)), detail: script };
}

function checkNodeRequire(name) {
  try {
    require.resolve(name);
    return { ok: true, detail: name };
  } catch {
    return { ok: false, detail: `${name} not installed` };
  }
}

function checkCommand(command) {
  try {
    const probe = process.platform === "win32" ? "where.exe" : "command";
    const args = process.platform === "win32" ? [command] : ["-v", command];
    execFileSync(probe, args, { stdio: "ignore", timeout: 3000, shell: process.platform !== "win32" });
    return { ok: true, detail: command };
  } catch {
    return { ok: false, detail: `${command} not found` };
  }
}

module.exports = {
  createCapabilitySnapshot,
  writeCapabilitySnapshot,
  readCapabilitySnapshot,
  formatCapabilitySummary
};
