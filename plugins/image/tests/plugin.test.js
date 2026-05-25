const assert = require("assert");
const plugin = require("../index");

assert.strictEqual(plugin.commandPrompt("/img cat", ["/img"]), "cat");
assert.strictEqual(plugin.commandPrompt("画图cat", ["画图"]), "cat");
assert.strictEqual(plugin.commandPrompt("hello", ["/img"]), null);

const calls = [];
const handled = plugin.onMessage({
  text: "/img cat",
  settings: { triggers: ["/img"] },
  msg: { message_type: "private", user_id: 1 },
  api: {
    runCommand: (...args) => calls.push(args),
  },
});

assert.deepStrictEqual(handled, { handled: true });
assert.deepStrictEqual(calls, [["image.handle", { message_type: "private", user_id: 1 }, "cat"]]);

console.log("image plugin tests ok");
