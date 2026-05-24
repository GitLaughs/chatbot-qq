const http = require("http");

function createHealthSnapshot(deps) {
  const listenBusy = {};
  for (const [groupID, state] of deps.listenStates.entries()) {
    listenBusy[groupID] = {
      busy: Boolean(state.busy),
      queued: state.queue.length
    };
  }

  const connectedPorts = {};
  for (const port of deps.listenPorts) {
    connectedPorts[port] = deps.clients.has(port);
  }

  const requiredPorts = expectedClientPorts(deps);
  return {
    ok: deps.upstreamReady() && requiredPorts.every((port) => deps.clients.has(port)),
    upstream: {
      url: deps.upstreamUrl,
      ready: deps.upstreamReady(),
      socket_state: deps.upstreamState()
    },
    ports: connectedPorts,
    required_ports: requiredPorts,
    allowed_groups: deps.allowedGroups,
    allowed_private_users: deps.allowedPrivateUsers,
    pending: {
      upstream_queue: deps.pending.length,
      echo_ports: deps.pendingEchoPorts.size,
      outbound: deps.pendingOutbound.size,
      file_downloads: deps.pendingFileDownloads.size,
      bot_reply_routes: deps.botReplyRoutes.size
    },
    files: deps.fileStats || {},
    capabilities: deps.capabilities || null,
    recent_errors: deps.recentErrors || [],
    modes: {
      default: deps.defaultListenMode,
      overrides: Object.fromEntries([...deps.listenModeByGroup.entries()].map(([groupID, mode]) => [deps.maskID(groupID), mode]))
    },
    quiet_groups: Object.fromEntries([...deps.quietUntilByGroup.entries()].map(([groupID, until]) => [deps.maskID(groupID), new Date(until).toISOString()])),
    listen: listenBusy,
    image_jobs: Object.fromEntries([...deps.imageStates.entries()].map(([key, state]) => [
      key,
      { active: state.active, queued: state.queue.length }
    ])),
    time: new Date().toISOString()
  };
}

function expectedClientPorts(deps) {
  const ports = new Set();
  for (const groupID of deps.allowedGroups) {
    const route = deps.routeForGroup(groupID);
    if (!deps.atOnlyGroups.includes(Number(groupID))) {
      ports.add(route.listenPort);
    }
    ports.add(route.atPort);
  }
  for (const route of deps.privateRoutes.values()) {
    ports.add(route.port);
  }
  return [...ports].filter(Boolean).sort((a, b) => a - b);
}

function startHealthServer({ host, port, snapshot, log }) {
  if (!port) {
    return null;
  }
  const server = http.createServer((req, res) => {
    if (req.url === "/metrics") {
      const body = snapshot();
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(createMetricsText(body));
      return;
    }
    if (req.url !== "/healthz" && req.url !== "/readyz") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
      return;
    }
    const body = snapshot();
    const status = body.ok ? 200 : 503;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  server.listen(port, host, () => {
    log("health listening", `${host}:${port}`);
  });
  server.on("error", (err) => log("health server error", err.message));
  return server;
}

function createMetricsText(snapshot) {
  const lines = [];
  const metric = (name, value, labels) => {
    const labelText = labels && Object.keys(labels).length
      ? `{${Object.entries(labels).map(([key, val]) => `${key}="${escapeLabel(val)}"`).join(",")}}`
      : "";
    lines.push(`${name}${labelText} ${Number(value) || 0}`);
  };

  metric("chatbot_qq_up", snapshot.ok ? 1 : 0);
  metric("chatbot_qq_upstream_ready", snapshot.upstream && snapshot.upstream.ready ? 1 : 0);
  for (const [port, connected] of Object.entries(snapshot.ports || {})) {
    metric("chatbot_qq_port_connected", connected ? 1 : 0, { port });
  }
  for (const port of snapshot.required_ports || []) {
    metric("chatbot_qq_required_port", 1, { port });
  }
  for (const [key, value] of Object.entries(snapshot.pending || {})) {
    metric(`chatbot_qq_pending_${sanitizeMetricPart(key)}`, value);
  }
  for (const [key, value] of Object.entries(snapshot.files || {})) {
    metric(`chatbot_qq_files_${sanitizeMetricPart(key)}`, value);
  }
  metric("chatbot_qq_recent_errors", (snapshot.recent_errors || []).length);
  if (snapshot.capabilities && snapshot.capabilities.checks) {
    for (const [key, value] of Object.entries(snapshot.capabilities.checks)) {
      if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "ok")) {
        metric("chatbot_qq_capability_ok", value.ok ? 1 : 0, { capability: key });
      }
    }
  }
  for (const [groupID, state] of Object.entries(snapshot.listen || {})) {
    metric("chatbot_qq_listen_busy", state.busy ? 1 : 0, { group: groupID });
    metric("chatbot_qq_listen_queued", state.queued || 0, { group: groupID });
  }
  for (const [key, state] of Object.entries(snapshot.image_jobs || {})) {
    metric("chatbot_qq_image_active", state.active || 0, { key });
    metric("chatbot_qq_image_queued", state.queued || 0, { key });
  }
  return `${lines.join("\n")}\n`;
}

function sanitizeMetricPart(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

module.exports = {
  createHealthSnapshot,
  startHealthServer,
  createMetricsText
};
