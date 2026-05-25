"use strict";

const assert = require("assert");
const { relationScore } = require("./lib/memory-store");

const mem1 = { id: "a", subject_id: "user1", tags: ["code", "style"], kind: "preference", scope: "group", scope_id: "123", created_at: new Date().toISOString() };
const mem2 = { id: "b", subject_id: "user1", tags: ["code"], kind: "preference", scope: "group", scope_id: "123", created_at: new Date().toISOString() };
const mem3 = { id: "c", subject_id: "user2", tags: ["study"], kind: "fact", scope: "group", scope_id: "456", created_at: new Date(Date.now() - 3600000).toISOString() };

assert.ok(relationScore(mem1, mem2) >= 4);
assert.ok(relationScore(mem1, mem3) < 4);

console.log("check-memory-relation-canaries: ALL PASSED");
