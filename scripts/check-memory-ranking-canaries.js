"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { importanceScore, relevanceScore } = require("./lib/memory-rules");
const { recencyScore, searchMemoriesRanked } = require("./lib/memory-store");

assert.strictEqual(importanceScore({ kind: "boundary", source: { type: "explicit" } }), 10);
assert.strictEqual(importanceScore({ kind: "preference", source: { type: "explicit" } }), 8);
assert.strictEqual(importanceScore({ kind: "note", source: { type: "candidate" } }), 2);
assert.strictEqual(importanceScore({ kind: "joke", confidence: 0.5, source: { type: "candidate" } }), 2);

const now = Date.now();
assert.ok(recencyScore(new Date(now - 3600000).toISOString(), now) > 0.9);
assert.ok(recencyScore(new Date(now - 72 * 3600000).toISOString(), now) > 0.45);
assert.ok(recencyScore(new Date(now - 720 * 3600000).toISOString(), now) < 0.01);

const mem = { text: "我喜欢吃辣", kind: "preference", tags: ["style"] };
assert.ok(relevanceScore(mem, "吃辣") > relevanceScore(mem, "代码"));
assert.ok(relevanceScore(mem, "喜欢") > 0);
assert.strictEqual(relevanceScore(mem, ""), 0);
assert.strictEqual(relevanceScore(mem, "zzzz-no-match"), 0);

const items = [
  { text: "旧备注", kind: "note", created_at: new Date(now - 720 * 3600000).toISOString(), source: { type: "candidate" }, tags: [] },
  { text: "用户喜欢短答", kind: "preference", created_at: new Date(now - 3600000).toISOString(), source: { type: "explicit" }, tags: ["style"] }
];
const scored = items.map((item) => ({
  ...item,
  _score: {
    recency: recencyScore(item.created_at, now),
    importance: importanceScore(item),
    relevance: relevanceScore(item, "短答"),
    total: 0
  }
}));
scored.forEach((item) => {
  item._score.total = item._score.recency * item._score.importance * item._score.relevance;
});
scored.sort((a, b) => b._score.total - a._score.total);
assert.strictEqual(scored[0].kind, "preference");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chatbot-qq-memory-ranking-"));
fs.mkdirSync(path.join(tmp, "memory"), { recursive: true });
fs.writeFileSync(path.join(tmp, "memory", "memories.jsonl"), `${JSON.stringify({
  version: 1,
  id: "mem_1",
  created_at: new Date().toISOString(),
  scope: "group",
  subject: "",
  kind: "preference",
  text: "用户喜欢吃辣",
  source: { type: "explicit" },
  tags: [],
  deleted: false
})}\n`, "utf8");
assert.strictEqual(searchMemoriesRanked({ workspace: tmp, query: "zzzz-no-match" }).length, 0);

console.log("check-memory-ranking-canaries: ALL PASSED");
