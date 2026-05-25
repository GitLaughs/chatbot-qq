const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");

const CONTAINER_PREFIX = "/app/.config/QQ/NapCat";
const DEFAULT_HOST_ROOTS = [
  "/opt/chatbot-qq/deploy/linux/napcat-data/NapCat"
];

function napcatHostRoots(env = process.env) {
  const configured = String(env.ONEBOT_NAPCAT_DATA_DIR || "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...configured, ...DEFAULT_HOST_ROOTS];
}

function resolveReadableFilePath(source, env = process.env) {
  if (!source || typeof source !== "string") {
    return null;
  }
  if (fs.existsSync(source)) {
    return source;
  }
  if (/^file:\/\//i.test(source)) {
    try {
      const local = fileURLToPath(source);
      if (fs.existsSync(local)) {
        return local;
      }
      return resolveNapCatContainerPath(local, env);
    } catch {
      return null;
    }
  }
  return resolveNapCatContainerPath(source, env);
}

function resolveNapCatContainerPath(source, env = process.env) {
  if (!source || typeof source !== "string") {
    return null;
  }
  const normalized = source.replace(/\\/g, "/");
  if (!normalized.startsWith(`${CONTAINER_PREFIX}/`)) {
    return null;
  }
  const relative = normalized.slice(CONTAINER_PREFIX.length + 1);
  for (const root of napcatHostRoots(env)) {
    const candidate = path.join(root, ...relative.split("/"));
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

module.exports = {
  CONTAINER_PREFIX,
  napcatHostRoots,
  resolveNapCatContainerPath,
  resolveReadableFilePath
};
