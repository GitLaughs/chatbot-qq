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

module.exports = {
  createHealthSnapshot,
  startHealthServer
};
