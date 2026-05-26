const assert = require("assert");
const plugin = require("../index");

const calls = [];
const handled = plugin.onMessage({
  text: "/dream",
  settings: { triggers: ["/dream"] },
  msg: { message_type: "group", group_id: 1 },
  api: {
    runCommand: (...args) => calls.push(args),
  },
});

assert.deepStrictEqual(handled, { handled: true });
assert.deepStrictEqual(calls, [["dream.handle", { message_type: "group", group_id: 1 }]]);
assert.deepStrictEqual(plugin.onMessage({
  text: "nope",
  settings: { triggers: ["/dream"] },
  api: { runCommand: () => assert.fail("should not run") },
}), { handled: false });

console.log("dream plugin tests ok");
