const assert = require("assert");
const plugin = require("../index");

const calls = [];
assert.deepStrictEqual(plugin.onSchedule({
  event: "other",
  api: { schedule: () => assert.fail("should not schedule") },
}), { handled: false });

assert.deepStrictEqual(plugin.onSchedule({
  event: "reminder_due",
  now: new Date("2026-05-25T00:00:00Z"),
  api: {
    schedule: (...args) => calls.push(args),
  },
}), { handled: true });

assert.strictEqual(calls[0][0], "reminder.runDue");
assert.strictEqual(calls[0][1].toISOString(), "2026-05-25T00:00:00.000Z");

console.log("reminder plugin tests ok");
