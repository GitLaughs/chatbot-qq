"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { effectiveScore, readMemoryAccessStats, recordMemoryAccess } = require("./lib/memory-store");

const base = { kind: "preference", created_at: new Date().toISOString(), source: { type: "explicit" }, access_count: 0 };
const accessed = { ...base, id: "mem_accessed", access_count: 10 };

assert.ok(effectiveScore(accessed) > effectiveScore(base));

const ancient = { ...base, created_at: new Date(Date.now() - 720 * 3600000).toISOString() };
assert.ok(effectiveScore(ancient) < effectiveScore(base));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chatbot-qq-memory-access-"));
recordMemoryAccess(tmp, "mem_1");
recordMemoryAccess(tmp, "mem_1");
const stats = readMemoryAccessStats(tmp);
assert.strictEqual(stats.get("mem_1").access_count, 2);

console.log("check-memory-compact-canaries: ALL PASSED");
