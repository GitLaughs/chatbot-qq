function onMessage(ctx) {
  const text = String(ctx.text || "").trim();
  const triggers = ctx.settings.triggers || [];
  if (!triggers.some((trigger) => text === String(trigger || "").trim())) {
    return { handled: false };
  }
  ctx.api.runCommand("dream.handle", ctx.msg);
  return { handled: true };
}

function health(ctx) {
  return ctx.api.health("dream", ctx);
}

function capabilities(ctx) {
  return {
    commands: ctx.settings.triggers || [],
  };
}

module.exports = {
  onMessage,
  health,
  capabilities,
};
