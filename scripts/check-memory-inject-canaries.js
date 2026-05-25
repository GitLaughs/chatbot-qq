"use strict";

const assert = require("assert");
const { buildMemoryContextForMessage } = require("./lib/conversation-context");

assert.strictEqual(buildMemoryContextForMessage({ workspace: "/tmp/nonexist", messageText: "" }), "");
assert.strictEqual(buildMemoryContextForMessage({ workspace: "/tmp/nonexist", messageText: "hi" }), "");

process.env.CHATBOT_QQ_MEMORY_INJECT_ENABLED = "false";
assert.strictEqual(buildMemoryContextForMessage({ workspace: "/tmp/nonexist", messageText: "测试消息内容" }), "");
delete process.env.CHATBOT_QQ_MEMORY_INJECT_ENABLED;

console.log("check-memory-inject-canaries: ALL PASSED");
