const fs = require("fs");
const path = require("path");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadProxyState({ file, listenModes, quietUntil, atOnlyGroups, log }) {
  try {
    if (!fs.existsSync(file)) {
      return;
    }
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [groupID, mode] of Object.entries(state.listen_modes || {})) {
      if (!["selective", "mention", "all", "off"].includes(mode)) {
        continue;
      }
      if (atOnlyGroups.includes(Number(groupID)) && mode !== "mention" && mode !== "off") {
        continue;
      }
      listenModes.set(Number(groupID), mode);
    }
    const now = Date.now();
    for (const [groupID, until] of Object.entries(state.quiet_until || {})) {
      const ts = Number(until);
      if (Number.isFinite(ts) && ts > now) {
        quietUntil.set(Number(groupID), ts);
      }
    }
    log("proxy state loaded", file);
  } catch (err) {
    log("proxy state load failed", err.message);
    quarantineInvalidState(file, log);
  }
}

function quarantineInvalidState(file, log) {
  try {
    if (!fs.existsSync(file)) {
      return;
    }
    const backup = `${file}.invalid-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
    fs.renameSync(file, backup);
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      updated_at: new Date().toISOString(),
      listen_modes: {},
      quiet_until: {}
    }, null, 2), "utf8");
    log("proxy state reset invalid file", backup);
  } catch (resetErr) {
    log("proxy state reset failed", resetErr.message);
  }
}

function saveProxyState({ file, listenModes, quietUntil, log }) {
  try {
    ensureDir(path.dirname(file));
    const state = {
      version: 1,
      updated_at: new Date().toISOString(),
      listen_modes: Object.fromEntries([...listenModes.entries()].map(([groupID, mode]) => [String(groupID), mode])),
      quiet_until: Object.fromEntries([...quietUntil.entries()].map(([groupID, until]) => [String(groupID), until]))
    };
    fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    log("proxy state save failed", err.message);
  }
}

module.exports = {
  loadProxyState,
  saveProxyState
};
