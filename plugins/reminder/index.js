function onSchedule(ctx) {
  if (ctx.event !== "reminder_due") {
    return { handled: false };
  }
  ctx.api.schedule("reminder.runDue", ctx.now || new Date());
  return { handled: true };
}

function health() {
  return { ok: true, detail: "scheduled reminder hook registered" };
}

function capabilities(ctx) {
  return {
    interval_ms: ctx.settings.interval_ms,
  };
}

module.exports = {
  onSchedule,
  health,
  capabilities,
};
