"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { deterministicTidy } = require("./lib/memory-tidy");
const { readPendingCandidates } = require("./lib/memory-store");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chatbot-qq-memory-tidy-"));
const memoryDir = path.join(tmp, "memory");
fs.mkdirSync(memoryDir, { recursive: true });
const oldTime = new Date(Date.now() - 31 * 24 * 3600000).toISOString();
const rows = [
  { id: "cand_1", created_at: new Date().toISOString(), scope: "group", scope_id: "1", subject_id: "u1", user: "u1", kind: "preference", tags: ["style"], text: "用户喜欢短答", fingerprint: "same", applied_at: "", applied_by: "" },
  { id: "cand_2", created_at: new Date().toISOString(), scope: "group", scope_id: "1", subject_id: "u1", user: "u1", kind: "preference", tags: ["style"], text: "用户喜欢短答", fingerprint: "same", applied_at: "", applied_by: "" },
  { id: "cand_3", created_at: oldTime, scope: "group", scope_id: "1", subject_id: "u1", user: "u1", kind: "todo", tags: ["todo"], text: "记得处理旧待办", fingerprint: "old", applied_at: "", applied_by: "" }
];
fs.writeFileSync(path.join(memoryDir, "pending-memory-candidates.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

const result = deterministicTidy({ workspace: tmp });
assert.strictEqual(result.deduped, 1);
assert.strictEqual(result.expired, 1);
assert.strictEqual(result.skipped, 2);
assert.strictEqual(readPendingCandidates({ workspace: tmp }).length, 1);

console.log("check-memory-tidy-canaries: ALL PASSED");
