function onMessage(ctx) {
  const prompt = commandPrompt(ctx.text, ctx.settings.triggers || []);
  if (prompt === null) {
    return { handled: false };
  }
  ctx.api.runCommand("image.handle", ctx.msg, prompt);
  return { handled: true };
}

function health(ctx) {
  return ctx.api.health("image", ctx);
}

function capabilities(ctx) {
  return {
    commands: ctx.settings.triggers || [],
    queue_max_per_group: ctx.settings.queue_max_per_group,
    max_concurrent_per_group: ctx.settings.max_concurrent_per_group,
  };
}

function commandPrompt(text, triggers) {
  const body = String(text || "").trim();
  for (const trigger of triggers || []) {
    const key = String(trigger || "").trim();
    if (!key) {
      continue;
    }
    if (body === key) {
      return "";
    }
    if (body.startsWith(`${key} `)) {
      return body.slice(key.length).trim();
    }
    if (!key.startsWith("/") && body.startsWith(key) && body.length > key.length) {
      return body.slice(key.length).trim();
    }
  }
  return null;
}

module.exports = {
  onMessage,
  health,
  capabilities,
  commandPrompt,
};
