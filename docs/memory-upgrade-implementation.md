# 记忆管理升级 -- 项目修改方案

本文档是 `memory-system-upgrade-plan.md` 的实施级配套文档。
列出每个 Phase 需要改动的具体文件、函数、行号和代码。

> 2026-05-25 审阅修订：本文档已按当前代码结构校正。重点修正：
> - 不能用 `fs.writeFileSync(memoryFile(...))` 重写 `memories.jsonl`，当前记忆日志支持 JSONL 分片。
> - ranked 检索必须过滤无关结果，避免 `/记忆 关键词` 返回零相关记忆。
> - L0 tidy 必须写入候选状态，不能只统计。
> - Phase 4 先做运行时关联扩展，不在 `memories.jsonl` 中持久化单向 `related` 字段。

---

## 目录

- [Phase 1: 三因子检索增强](#phase-1-三因子检索增强)
- [Phase 2: 对话中主动注入长期记忆](#phase-2-对话中主动注入长期记忆)
- [Phase 3: 记忆衰减与访问计数](#phase-3-记忆衰减与访问计数)
- [Phase 4: 轻量关联图谱](#phase-4-轻量关联图谱)
- [Phase 5: 分层自动反思](#phase-5-分层自动反思)
- [Phase 6: 跨群知识共享](#phase-6-跨群知识共享)
- [测试清单](#测试清单)
- [配置项速查](#配置项速查)
- [回滚方案](#回滚方案)

---

## Phase 1: 三因子检索增强

**目标：** 将 `/记忆` 的子串匹配替换为 Recency x Importance x Relevance 综合排序。

### 1.1 修改 `scripts/lib/memory-rules.js`

**新增 2 个函数，不改动现有函数。**

#### 新增 `importanceScore()` -- 在文件末尾 `module.exports` 之前插入

```javascript
/**
 * 确定性重要性评分（1-10），不调用 LLM。
 * 依据：kind 权重 + 置信度 + 来源类型 + 标签修正。
 */
function importanceScore(memory) {
  const kindWeights = {
    boundary: 9,
    preference: 7,
    project: 6,
    todo: 5,
    fact: 4,
    joke: 3,
    note: 2
  };
  let score = kindWeights[memory.kind] || 5;

  if (memory.confidence && memory.confidence < 0.7) score -= 1;
  if (memory.source && memory.source.type === "explicit") score += 1;

  const tags = memory.tags || [];
  if (tags.includes("boundary")) score = Math.max(score, 8);
  if (tags.includes("style")) score = Math.max(score, 6);

  return Math.max(1, Math.min(10, score));
}
```

#### 新增 `relevanceScore()` -- 紧接其后

```javascript
/**
 * 确定性相关性评分（0-20+）。
 * 多维度：精确匹配 > 分词匹配 > 标签匹配 > kind 匹配 > 主体匹配。
 */
function relevanceScore(memory, query) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return 0;
  const haystack = [
    memory.text || "",
    memory.kind || "",
    memory.scope || "",
    memory.subject || "",
    ...(memory.tags || [])
  ].join("\n").toLowerCase();

  let score = 0;

  // 精确子串匹配（最高权重）
  if (haystack.includes(q)) score += 10;

  // 分词匹配：按单字/空格切分，计算覆盖率
  const queryChars = [...new Set(q.replace(/\s/g, ""))];
  if (queryChars.length > 0) {
    const matched = queryChars.filter(c => haystack.includes(c));
    score += (matched.length / queryChars.length) * 5;
  }

  // 标签匹配
  const queryTags = tagMemory(q);
  const commonTags = queryTags.filter(t => (memory.tags || []).includes(t));
  score += commonTags.length * 3;

  // kind 匹配
  const queryKind = classifyMemory(q);
  if (queryKind === memory.kind && queryKind !== "note") score += 2;

  // 主体匹配
  if (memory.subject && q.includes(String(memory.subject).toLowerCase())) score += 4;

  return score;
}
```

#### 更新 `module.exports`

在 `memory-rules.js` 的 `module.exports` 中追加：

```javascript
importanceScore,
relevanceScore,
```

### 1.2 修改 `scripts/lib/memory-store.js`

#### 新增导入 -- 第 4 行区域

```javascript
// 现有导入后追加
const { classifyMemory, memoryFingerprint, normalizeMemoryText, tagMemory, importanceScore, relevanceScore } = require("./memory-rules");
```

注意：原第 4 行已有 `classifyMemory, memoryFingerprint, normalizeMemoryText, tagMemory` 的导入，只需在解构中追加 `importanceScore, relevanceScore`。

#### 新增 `recencyScore()` -- 在 `searchMemories()` 函数之前插入

```javascript
function recencyScore(createdAt, now) {
  const ageHours = (Number(now || Date.now()) - new Date(createdAt).getTime()) / 3600000;
  if (!Number.isFinite(ageHours) || ageHours < 0) return 1;
  const halfLifeHours = Number(process.env.CHATBOT_QQ_MEMORY_RECENCY_HALF_LIFE || 72);
  return Math.pow(0.5, ageHours / Math.max(1, halfLifeHours));
}
```

#### 新增 `searchMemoriesRanked()` -- 在 `searchMemories()` 函数之后插入

```javascript
function searchMemoriesRanked({ workspace, query = "", subject = "", scope = "", limit = 10 }) {
  const now = Date.now();
  const wantedSubject = String(subject || "");
  const wantedScope = String(scope || "");
  const q = String(query || "").trim().toLowerCase();
  const deleted = deletedIDs(workspace);
  const rows = readJSONLines(memoryFile(workspace))
    .filter((item) => item && !item.deleted && !deleted.has(item.id))
    .filter((item) => !wantedSubject || String(item.subject) === wantedSubject)
    .filter((item) => !wantedScope || String(item.scope) === wantedScope);

  return rows
    .map((item) => {
      const recency = recencyScore(item.created_at, now);
      const importance = importanceScore(item);
      const relevance = relevanceScore(item, q);
      return {
        ...item,
        _score: { recency, importance, relevance, total: recency * importance * relevance }
      };
    })
    .filter((item) => !q || item._score.relevance > 0)
    .sort((a, b) => b._score.total - a._score.total)
    .slice(0, Math.max(1, Number(limit) || 10));
}
```

注意：非空 `query` 必须保留 `.filter((item) => !q || item._score.relevance > 0)`。否则 ranked 检索会在无命中时返回全库低分记忆，行为比现有 `searchMemories()` 更差。

#### 新增 `formatRankedMemories()` -- 紧接其后

```javascript
function formatRankedMemories(items) {
  if (!items || items.length === 0) {
    return "没找到结构化记忆。";
  }
  return [
    "结构化记忆（按相关度排序）：",
    ...items.map((item) => {
      const score = item._score ? ` [R:${item._score.recency.toFixed(2)} I:${item._score.importance} Rel:${item._score.relevance.toFixed(1)}]` : "";
      return `- [${item.kind || "note"}] ${item.text} (${item.scope || "?"}:${item.subject || "?"}, ${shortTime(item.created_at)})${score}`;
    })
  ].join("\n").slice(0, 1600);
}
```

#### 更新 `module.exports` -- 第 999 行区域

在 `module.exports` 中追加：

```javascript
searchMemoriesRanked,
formatRankedMemories,
recencyScore,
```

### 1.3 修改 `scripts/lib/proxy-commands.js`

**替换 `searchMemoryCommand()` 中的检索调用。**

#### 修改导入 -- 第 1 行区域

找到 `memory-store.js` 的导入行，追加 `searchMemoriesRanked, formatRankedMemories`。

```javascript
const { ..., searchMemoriesRanked, formatRankedMemories, ... } = require("./memory-store");
```

#### 修改 `searchMemoryCommand()` 函数体

找到 `searchMemoryCommand()` 函数（约第 412 行），将最后的检索分支：

```javascript
// 原代码（约第 445-447 行）
const subject = msg.message_type === "private" ? String(msg.user_id || "") : "";
return formatMemories(searchMemories({ workspace, query, subject, limit: 10 }));
```

替换为：

```javascript
const subject = msg.message_type === "private" ? String(msg.user_id || "") : "";
return deps.maskSensitive(formatRankedMemories(searchMemoriesRanked({ workspace, query, subject, limit: 10 })));
```

### 1.4 新增测试 `scripts/check-memory-ranking-canaries.js`

```javascript
"use strict";

const assert = require("assert");
const { importanceScore, relevanceScore, classifyMemory, tagMemory } = require("./lib/memory-rules");
const { recencyScore, searchMemoriesRanked } = require("./lib/memory-store");

// --- importanceScore ---
assert.strictEqual(importanceScore({ kind: "boundary", source: { type: "explicit" } }), 10);
assert.strictEqual(importanceScore({ kind: "preference", source: { type: "explicit" } }), 8);
assert.strictEqual(importanceScore({ kind: "note", source: { type: "candidate" } }), 2);
assert.strictEqual(importanceScore({ kind: "joke", confidence: 0.5, source: { type: "candidate" } }), 2);

// --- recencyScore ---
const now = Date.now();
assert.ok(recencyScore(new Date(now - 3600000).toISOString(), now) > 0.9);   // 1 小时前
assert.ok(recencyScore(new Date(now - 72 * 3600000).toISOString(), now) > 0.45); // 72 小时（半衰期）
assert.ok(recencyScore(new Date(now - 720 * 3600000).toISOString(), now) < 0.01); // 30 天前

// --- relevanceScore ---
const mem = { text: "我喜欢吃辣", kind: "preference", tags: ["style"] };
assert.ok(relevanceScore(mem, "吃辣") > relevanceScore(mem, "代码"));
assert.ok(relevanceScore(mem, "喜欢") > 0);
assert.strictEqual(relevanceScore(mem, ""), 0);
assert.strictEqual(relevanceScore(mem, "zzzz-no-match"), 0);

// --- 排序验证 ---
const items = [
  { text: "旧备注", kind: "note", created_at: new Date(now - 720 * 3600000).toISOString(), source: { type: "candidate" }, tags: [] },
  { text: "用户喜欢短答", kind: "preference", created_at: new Date(now - 3600000).toISOString(), source: { type: "explicit" }, tags: ["style"] }
];
const scored = items.map(item => ({
  ...item,
  _score: {
    recency: recencyScore(item.created_at, now),
    importance: importanceScore(item),
    relevance: relevanceScore(item, "短答"),
    total: 0
  }
}));
scored.forEach(s => { s._score.total = s._score.recency * s._score.importance * s._score.relevance; });
scored.sort((a, b) => b._score.total - a._score.total);
assert.strictEqual(scored[0].kind, "preference");

// --- ranked search 不返回零相关结果 ---
const fs = require("fs");
const os = require("os");
const path = require("path");
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
```

---

## Phase 2: 对话中主动注入长期记忆

**目标：** 每次 bot 回复前，自动检索与当前消息相关的长期记忆注入上下文。

### 2.1 修改 `scripts/lib/conversation-context.js`

#### 新增导入 -- 第 1-3 行区域

```javascript
const { searchMemoriesRanked } = require("./memory-store");
```

#### 新增 `buildMemoryContextForMessage()` -- 在 `module.exports` 之前插入

```javascript
function buildMemoryContextForMessage({ workspace, messageText, subject, scope, scopeID }) {
  if (!messageText || messageText.length < 4) return "";

  const enabled = String(process.env.CHATBOT_QQ_MEMORY_INJECT_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) return "";

  const threshold = Number(process.env.CHATBOT_QQ_MEMORY_INJECT_THRESHOLD || 20);
  const limit = Math.max(1, Math.min(10, Number(process.env.CHATBOT_QQ_MEMORY_INJECT_LIMIT || 5)));

  const ranked = searchMemoriesRanked({
    workspace,
    query: expandMemoryQuery(messageText),
    subject: subject || "",
    scope: scope || "",
    limit: limit * 2  // 多取一些，后面按阈值过滤
  });

  const relevant = ranked.filter(m => m._score && m._score.total >= threshold).slice(0, limit);
  if (relevant.length === 0) return "";

  const lines = relevant.map(m => `- [${m.kind}] ${m.text.slice(0, 120)}`);
  return ["【相关记忆】", ...lines].join("\n");
}

function expandMemoryQuery(text) {
  const raw = String(text || "");
  const extra = [];
  if (/吃|喝|饭|菜|餐|外卖|夜宵|口味|辣|甜|咸/.test(raw)) {
    extra.push("喜欢 不喜欢 偏好 口味 吃辣");
  }
  if (/怎么回|语气|风格|短答|详细|称呼/.test(raw)) {
    extra.push("风格 语气 短答 详细 称呼");
  }
  return [raw, ...extra].join(" ").trim();
}
```

注意：不能只靠降低阈值解决注入问题。`吃什么` 和 `喜欢吃辣` 没有明显字面重叠，必须加少量确定性 query 扩展，覆盖食物、回复风格等高频偏好场景。

#### 更新 `module.exports`

```javascript
buildMemoryContextForMessage,
```

### 2.2 修改 `scripts/onebot-group-proxy.js`

#### 新增导入 -- 在文件头部的 `require` 区域

```javascript
const { buildMemoryContextForMessage } = require("./lib/conversation-context");
```

#### 新增 `buildMemoryContextForMessageWrapper()` -- 在 `buildReplyChainContextForMessage()` 函数之后（约第 1502 行后）

```javascript
function buildMemoryContextForMessageWrapper(msg) {
  if (msg.message_type !== "group" && msg.message_type !== "private") return "";
  const workspace = msg.message_type === "private" ? workspaceForPrivateUser(msg.user_id) : workspaceForGroup(msg.group_id);
  const messageText = (msg.raw_message || "").replace(/\[CQ:[^\]]*\]/g, "").trim();
  const subject = msg.message_type === "private" ? String(msg.user_id || "") : "";
  const scope = msg.message_type === "private" ? "private" : "group";
  const scopeID = msg.message_type === "private" ? msg.user_id : msg.group_id;
  return buildMemoryContextForMessage({ workspace, messageText, subject, scope, scopeID });
}
```

#### 注入上下文 -- 在 `enrichMessageForAgent()` 函数中（约第 1187 行后）

在 `personaContext` 注入之后、`recentFileContext` 之前，插入：

```javascript
const memoryContext = safeContext(() => buildMemoryContextForMessageWrapper(msg), "memory");
if (memoryContext) {
  contextParts.push({ text: memoryContext, priority: 85, kind: "memory" });
}
```

注意 `priority: 85` -- 介于 persona(95) 和 mood(80) 之间。

### 2.3 新增测试 `scripts/check-memory-inject-canaries.js`

```javascript
"use strict";

const assert = require("assert");
const { buildMemoryContextForMessage } = require("./lib/conversation-context");

// 空消息不注入
assert.strictEqual(buildMemoryContextForMessage({ workspace: "/tmp/nonexist", messageText: "" }), "");
assert.strictEqual(buildMemoryContextForMessage({ workspace: "/tmp/nonexist", messageText: "hi" }), "");

// 禁用时不注入
process.env.CHATBOT_QQ_MEMORY_INJECT_ENABLED = "false";
assert.strictEqual(buildMemoryContextForMessage({ workspace: "/tmp/nonexist", messageText: "测试消息内容" }), "");
delete process.env.CHATBOT_QQ_MEMORY_INJECT_ENABLED;

console.log("check-memory-inject-canaries: ALL PASSED");
```

---

## Phase 3: 记忆衰减与访问计数

**目标：** 被频繁访问的记忆得到强化，长期未访问的记忆逐渐淡出。

**关键约束：** 当前 `memory-store.js` 通过 `readJSONLShards()` 读取 `memories.jsonl` 及其分片。Phase 3 不允许重写 `memories.jsonl` 主文件，否则会和旧分片产生重复读取。访问计数必须使用 append-only 辅助日志。

### 3.1 修改 `scripts/lib/memory-store.js`

#### 扩展 `addMemory()` 的 item 结构 -- 第 41-61 行

在 `item` 对象中追加两个字段（在 `deleted: false` 之前）：

```javascript
access_count: 0,
last_accessed_at: null,
```

这两个字段只作为新记忆的初始快照，不在 Phase 3 中回写 `memories.jsonl`。

#### 新增 `memoryAccessFile()` / `readMemoryAccessStats()` / `recordMemoryAccess()` -- 在 `memoryFile()` 附近和 `searchMemoriesRanked()` 之后

```javascript
function memoryAccessFile(workspace) {
  return path.join(workspace, "memory", "memory-access.jsonl");
}

function recordMemoryAccess(workspace, memoryID) {
  if (!memoryID) return;
  ensureDir(path.dirname(memoryAccessFile(workspace)));
  appendJSONObject(memoryAccessFile(workspace), {
    version: 1,
    time: new Date().toISOString(),
    id: String(memoryID)
  });
}

function readMemoryAccessStats(workspace) {
  const stats = new Map();
  for (const row of readJSONLines(memoryAccessFile(workspace))) {
    const id = String(row && row.id || "");
    if (!id) continue;
    const current = stats.get(id) || { access_count: 0, last_accessed_at: "" };
    current.access_count += 1;
    current.last_accessed_at = String(row.time || current.last_accessed_at || "");
    stats.set(id, current);
  }
  return stats;
}
```

#### 修改 `searchMemoriesRanked()` -- 记录命中

将 Phase 1 中 `return rows.map(...).filter(...).sort(...).slice(...)` 的链式返回改成 `scored` / `result` 两步，便于记录命中：

```javascript
const scored = rows.map((item) => {
  const recency = recencyScore(item.created_at, now);
  const importance = importanceScore(item);
  const relevance = relevanceScore(item, q);
  return {
    ...item,
    _score: { recency, importance, relevance, total: recency * importance * relevance }
  };
});

const result = scored
  .filter((item) => !q || item._score.relevance > 0)
  .sort((a, b) => b._score.total - a._score.total)
  .slice(0, Math.max(1, Number(limit) || 10));

for (const item of result) {
  recordMemoryAccess(workspace, item.id);
}

return result;
```

#### 新增 `effectiveScore()` -- 在 `recencyScore()` 之后

```javascript
function effectiveScore(memory, now, accessStats) {
  const base = importanceScore(memory);
  const recency = recencyScore(memory.created_at, now || Date.now());
  const stat = accessStats && accessStats.get ? accessStats.get(memory.id) : null;
  const accessCount = Number(stat && stat.access_count || memory.access_count || 0);
  const accessBoost = accessCount ? Math.log2(accessCount + 1) * 0.5 : 0;
  return (base + accessBoost) * recency;
}
```

#### 更新 `module.exports`

```javascript
effectiveScore,
recordMemoryAccess,
readMemoryAccessStats,
```

### 3.2 新增测试 `scripts/check-memory-compact-canaries.js`

```javascript
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { effectiveScore, recordMemoryAccess, readMemoryAccessStats } = require("./lib/memory-store");

// 被访问多次的记忆分数更高
const base = { kind: "preference", created_at: new Date().toISOString(), source: { type: "explicit" }, access_count: 0 };
const accessed = { ...base, id: "mem_accessed", access_count: 10 };

assert.ok(effectiveScore(accessed) > effectiveScore(base));

// 极旧记忆分数低
const ancient = { ...base, created_at: new Date(Date.now() - 720 * 3600000).toISOString() };
assert.ok(effectiveScore(ancient) < effectiveScore(base));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chatbot-qq-memory-access-"));
recordMemoryAccess(tmp, "mem_1");
recordMemoryAccess(tmp, "mem_1");
const stats = readMemoryAccessStats(tmp);
assert.strictEqual(stats.get("mem_1").access_count, 2);

console.log("check-memory-compact-canaries: ALL PASSED");
```

---

## Phase 4: 轻量关联图谱

**目标：** 为记忆条目建立确定性关联，检索时自动拉取关联记忆。

### 4.1 修改 `scripts/lib/memory-store.js`

#### 新增 `relationScore()` / `relatedMemoriesFor()` -- 在 `searchMemoriesRanked()` 之后

Phase 4 先不把 `related` 持久化进 `memories.jsonl`。原因：只给新记忆写 `related` 会形成单向关系，检索旧记忆时无法扩展到新记忆。第一版采用运行时关系计算，后续如需持久化，再新增 append-only `memory-relations.jsonl`。

```javascript
function relationScore(a, b) {
  if (!a || !b || a.id === b.id) return 0;
  let score = 0;
  if (a.subject_id && b.subject_id && a.subject_id === b.subject_id) score += 3;
  const commonTags = (a.tags || []).filter(t => (b.tags || []).includes(t));
  score += commonTags.length * 2;
  if (a.kind === b.kind && a.kind !== "note") score += 1;
  if (a.scope === b.scope && a.scope_id === b.scope_id) score += 1;
  const timeDiff = Math.abs(new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  if (Number.isFinite(timeDiff) && timeDiff < 600000) score += 2;
  return score;
}

function relatedMemoriesFor({ workspace, memory, limit = 3 }) {
  return readActiveMemories(workspace)
    .map((item) => ({ item, score: relationScore(memory, item) }))
    .filter((entry) => entry.score >= 4)
    .sort((a, b) => b.score - a.score || importanceScore(b.item) - importanceScore(a.item))
    .slice(0, Math.max(1, Number(limit) || 3))
    .map((entry) => entry.item);
}

function readActiveMemories(workspace) {
  const deleted = deletedIDs(workspace);
  return readJSONLines(memoryFile(workspace))
    .filter(item => item && !item.deleted && !deleted.has(item.id));
}
```

#### 新增 `expandRelatedMemories()` -- 紧接其后

```javascript
function expandRelatedMemories({ workspace, memory, limit = 3 }) {
  return relatedMemoriesFor({ workspace, memory, limit });
}
```

#### 更新 `module.exports`

```javascript
expandRelatedMemories,
relationScore,
```

### 4.2 修改 `scripts/lib/conversation-context.js` 的 `buildMemoryContextForMessage()`

在注入相关记忆后，追加关联记忆：

```javascript
// 在 relevant 循环之后
const { expandRelatedMemories } = require("./memory-store");

// ... existing code ...

// 展开关联记忆
const expanded = [];
const seenIDs = new Set(relevant.map(m => m.id));
for (const mem of relevant) {
  const related = expandRelatedMemories({ workspace, memory: mem, limit: 2 });
  for (const r of related) {
    if (!seenIDs.has(r.id)) {
      seenIDs.add(r.id);
      expanded.push(r);
    }
  }
}

if (expanded.length > 0) {
  lines.push("关联记忆：");
  for (const r of expanded.slice(0, 3)) {
    lines.push(`  - [${r.kind}] ${r.text.slice(0, 80)}`);
  }
}
```

### 4.3 新增测试 `scripts/check-memory-relation-canaries.js`

```javascript
"use strict";

const assert = require("assert");
const { relationScore } = require("./lib/memory-store");

// 验证关联建立逻辑
const mem1 = { id: "a", subject_id: "user1", tags: ["code", "style"], kind: "preference", scope: "group", scope_id: "123", created_at: new Date().toISOString() };
const mem2 = { id: "b", subject_id: "user1", tags: ["code"], kind: "preference", scope: "group", scope_id: "123", created_at: new Date().toISOString() };
const mem3 = { id: "c", subject_id: "user2", tags: ["study"], kind: "fact", scope: "group", scope_id: "456", created_at: new Date(Date.now() - 3600000).toISOString() };

assert.ok(relationScore(mem1, mem2) >= 4);
assert.ok(relationScore(mem1, mem3) < 4);

console.log("check-memory-relation-canaries: ALL PASSED");
```

---

## Phase 5: 分层自动反思

**目标：** 建立 L0(确定性)/L1(轻量LLM)/L2(深度LLM) 三层反思机制。

### 5.1 新增 `scripts/lib/memory-tidy.js`

```javascript
"use strict";

const { readPendingCandidates, processPendingCandidatesBatch } = require("./memory-store");

/**
 * L0 确定性整理 -- 零 LLM 调用，纯代码操作。
 * - 候选记忆去重
 * - 过期待办候选清理（>30 天）
 * - 通过 skipped_at 写入处理状态
 */
function deterministicTidy({ workspace, actedBy = "memory-tidy" }) {
  const results = { deduped: 0, expired: 0, skipped: 0, tidied_at: new Date().toISOString() };

  const candidates = readPendingCandidates({ workspace });
  const seenFingerprints = new Set();
  const seenTexts = new Set();
  const skipIndexes = new Set();

  candidates.forEach((c, index) => {
    const fp = c.fingerprint || "";
    const textKey = `${c.kind}:${(c.text || "").toLowerCase().trim()}`;
    if (fp && seenFingerprints.has(fp)) {
      skipIndexes.add(index + 1);
      results.deduped++;
    } else if (textKey.length > 3 && seenTexts.has(textKey)) {
      skipIndexes.add(index + 1);
      results.deduped++;
    } else {
      if (fp) seenFingerprints.add(fp);
      seenTexts.add(textKey);
    }
  });

  const thirtyDaysAgo = Date.now() - 30 * 24 * 3600000;
  candidates.forEach((c, index) => {
    if (c.kind === "todo" && !c.applied_at && !c.skipped_at) {
      const created = new Date(c.created_at || c.source_time || 0).getTime();
      if (created < thirtyDaysAgo && created > 0) {
        skipIndexes.add(index + 1);
        results.expired++;
      }
    }
  });

  if (skipIndexes.size > 0) {
    const batch = processPendingCandidatesBatch({
      workspace,
      skipSelector: [...skipIndexes].sort((a, b) => a - b).join(","),
      actedBy
    });
    results.skipped = batch.skipped || 0;
  }

  return results;
}

/**
 * 检查是否需要触发反思。
 * 返回 { needsL0, needsL1, needsL2 } 布尔值。
 */
function checkReflectionTriggers({ workspace, messagesSinceLastReflection = 0, hoursSinceLastReflection = 0 }) {
  const tidyInterval = Number(process.env.CHATBOT_QQ_MEMORY_TIDY_INTERVAL_MSGS || 100);
  const l1Interval = Number(process.env.CHATBOT_QQ_MEMORY_REFLECT_INTERVAL_HOURS || 6);
  const l2Interval = Number(process.env.CHATBOT_QQ_MEMORY_DEEP_REFLECT_INTERVAL_HOURS || 24);

  return {
    needsL0: messagesSinceLastReflection >= tidyInterval,
    needsL1: hoursSinceLastReflection >= l1Interval,
    needsL2: hoursSinceLastReflection >= l2Interval
  };
}

module.exports = {
  deterministicTidy,
  checkReflectionTriggers
};
```

### 5.2 修改 `scripts/onebot-group-proxy.js`

#### 新增导入

```javascript
const { deterministicTidy, checkReflectionTriggers } = require("./lib/memory-tidy");
```

#### 新增消息计数器和反思状态

在文件顶部配置区域添加：

```javascript
let messagesSinceLastTidy = 0;
let lastTidyTime = Date.now();
```

#### 在 `recordGroupMessage()` 函数末尾追加

```javascript
messagesSinceLastTidy++;
if (messagesSinceLastTidy >= Number(process.env.CHATBOT_QQ_MEMORY_TIDY_INTERVAL_MSGS || 100)) {
  try {
    const workspace = workspaceForGroup(msg.group_id);
    const result = deterministicTidy({ workspace });
    messagesSinceLastTidy = 0;
    lastTidyTime = Date.now();
    if (result.skipped > 0) {
      console.log(`[memory-tidy] L0 completed: deduped=${result.deduped} expired=${result.expired} skipped=${result.skipped}`);
    }
  } catch (err) {
    console.error("[memory-tidy] L0 error:", err.message);
  }
}
```

### 5.3 更新测试清单

在 `npm test` 中添加 `check-memory-tidy-canaries.js`。

---

## Phase 6: 跨群知识共享（可选）

**目标：** 允许用户显式标记的记忆进入全局知识池，供所有 workspace 补充检索。

### 6.1 新增目录结构

```
groups/_global/
  memory/
    global-knowledge.jsonl    # 全局共享记忆
```

### 6.2 修改 `scripts/lib/memory-store.js`

#### 新增 `addGlobalMemory()`

```javascript
function addGlobalMemory({ text, kind = "note", tags = [], subject = "" }) {
  const globalDir = path.join(process.env.CHATBOT_QQ_WORKSPACE_ROOT || "groups", "_global", "memory");
  ensureDir(globalDir);
  const clean = normalizeMemoryText(text);
  if (!clean) return null;
  const item = {
    version: 1,
    id: memoryID(),
    created_at: new Date().toISOString(),
    scope: "global",
    scope_id: "global",
    subject_type: "global",
    subject_id: String(subject || ""),
    subject: String(subject || ""),
    kind: classifyMemory(clean),
    text: clean,
    source: { type: "explicit", platform: "qq" },
    confidence: 1,
    tags: [...new Set([...(Array.isArray(tags) ? tags : []), ...tagMemory(clean)])],
    fingerprint: memoryFingerprint({ scope: "global", scopeID: "global", subject, text: clean }),
    access_count: 0,
    last_accessed_at: null,
    deleted: false
  };
  appendJSONObject(path.join(globalDir, "global-knowledge.jsonl"), item);
  return item;
}
```

#### 新增 `searchGlobalMemories()`

```javascript
function searchGlobalMemories({ query = "", limit = 3 }) {
  const globalDir = path.join(process.env.CHATBOT_QQ_WORKSPACE_ROOT || "groups", "_global", "memory");
  const file = path.join(globalDir, "global-knowledge.jsonl");
  if (!fs.existsSync(file)) return [];
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  return readJSONLines(file)
    .filter(item => item && !item.deleted)
    .filter(item => memoryHaystack(item).includes(q))
    .slice(0, Math.max(1, Number(limit) || 3));
}
```

#### 更新 `module.exports`

```javascript
addGlobalMemory,
searchGlobalMemories,
```

### 6.3 修改 `scripts/lib/conversation-context.js` 的 `buildMemoryContextForMessage()`

在本地记忆检索之后，追加全局记忆补充：

```javascript
const { searchGlobalMemories } = require("./memory-store");

// ... 在 relevant 检索之后 ...
const globalRelevant = searchGlobalMemories({ query: messageText, limit: 2 });
if (globalRelevant.length > 0) {
  lines.push("全局知识：");
  for (const g of globalRelevant) {
    lines.push(`  - [${g.kind}] ${g.text.slice(0, 80)}`);
  }
}
```

### 6.4 新增 `/全局记住` 命令

在 `scripts/lib/proxy-commands.js` 中添加命令路由：

```javascript
function globalRememberCommand(msg, body) {
  const text = String(body || "").trim();
  if (!text) return "用法：/全局记住 内容（写入全局知识池，所有群可检索）";
  const result = addGlobalMemory({ text, subject: String(msg.user_id || "") });
  if (result) return "已写入全局知识池。";
  return "写入失败，内容可能为空。";
}
```

---

## 测试清单

| 文件 | Phase | 测试内容 | 运行方式 |
|------|-------|---------|---------|
| `check-memory-ranking-canaries.js` | 1 | importanceScore/recencyScore/relevanceScore 正确性 | `npm test` |
| `check-memory-inject-canaries.js` | 2 | 空消息/短消息/禁用时不注入 | `npm test` |
| `check-memory-compact-canaries.js` | 3 | effectiveScore 访问强化正确性 | `npm test` |
| `check-memory-relation-canaries.js` | 4 | 关联建立逻辑 | `npm test` |
| `check-memory-tidy-canaries.js` | 5 | L0 去重/过期清理 | `npm test` |

### 现有测试不受影响

以下测试无需修改，应继续通过：

- `check-memory-rule-canaries.js` -- 分类规则不变
- `check-pending-memory-lifecycle-canaries.js` -- 候选生命周期不变
- `check-pending-memory-classification-matrix.js` -- 分类矩阵不变
- `check-memory-rule-change-guard.js` -- 回归守护不变

---

## 配置项速查

| 环境变量 | Phase | 类型 | 默认值 | 说明 |
|----------|-------|------|--------|------|
| `CHATBOT_QQ_MEMORY_RECENCY_HALF_LIFE` | 1 | number | 72 | 时间衰减半衰期（小时） |
| `CHATBOT_QQ_MEMORY_INJECT_ENABLED` | 2 | bool | true | 是否启用对话中主动注入 |
| `CHATBOT_QQ_MEMORY_INJECT_THRESHOLD` | 2 | number | 20 | 注入的最低综合分数 |
| `CHATBOT_QQ_MEMORY_INJECT_LIMIT` | 2 | number | 5 | 最大注入条数 |
| `CHATBOT_QQ_MEMORY_TIDY_INTERVAL_MSGS` | 5 | number | 100 | L0 整理的消息间隔 |
| `CHATBOT_QQ_MEMORY_REFLECT_INTERVAL_HOURS` | 5 | number | 6 | L1 轻量反思间隔 |
| `CHATBOT_QQ_MEMORY_DEEP_REFLECT_INTERVAL_HOURS` | 5 | number | 24 | L2 深度反思间隔 |
| `CHATBOT_QQ_WORKSPACE_ROOT` | 6 | string | groups | 工作区根目录 |

---

## 回滚方案

每个 Phase 独立，可单独回滚：

### Phase 1 回滚

将 `proxy-commands.js` 中的 `searchMemoriesRanked` 改回 `searchMemories`，`formatRankedMemories` 改回 `formatMemories`。删除新增函数。`recencyScore`/`importanceScore`/`relevanceScore` 无副作用，可保留。

### Phase 2 回滚

在 `onebot-group-proxy.js` 的 `enrichMessageForAgent()` 中删除 `memoryContext` 注入块（3 行）。设置 `CHATBOT_QQ_MEMORY_INJECT_ENABLED=false` 即可不停机禁用。

### Phase 3 回滚

删除 `recordMemoryAccess()` 调用。`access_count` 和 `last_accessed_at` 字段为可选，旧记忆无此字段不影响任何逻辑；`memory-access.jsonl` 是 append-only 辅助日志，可保留或删除。

### Phase 4 回滚

删除 `conversation-context.js` 中的 `expandRelatedMemories()` 调用，或让 `expandRelatedMemories()` 返回空数组。Phase 4 第一版不持久化 `related` 字段。

### Phase 5 回滚

删除 `onebot-group-proxy.js` 中的 `messagesSinceLastTidy` 计数和 L0 调用块。`memory-tidy.js` 可保留不删。

### Phase 6 回滚

删除 `_global/` 目录。删除 `searchGlobalMemories()` 调用。不删除函数定义即可。

---

## 文件改动汇总

| 文件 | Phase | 改动类型 | 改动量 |
|------|-------|---------|--------|
| `scripts/lib/memory-rules.js` | 1 | 新增 2 函数 + 更新 exports | +50 行 |
| `scripts/lib/memory-store.js` | 1,3,4 | 新增 8 函数 + 修改 addMemory + 更新 exports | +150 行 |
| `scripts/lib/proxy-commands.js` | 1,6 | 修改 searchMemoryCommand + 新增 globalRememberCommand | +20 行 |
| `scripts/lib/conversation-context.js` | 2,4,6 | 新增 buildMemoryContextForMessage + 更新 exports | +60 行 |
| `scripts/onebot-group-proxy.js` | 2,5 | 新增 2 函数 + 修改 enrichMessageForAgent + 导入 | +40 行 |
| `scripts/lib/memory-tidy.js` | 5 | **新建文件** | +60 行 |
| `scripts/check-memory-ranking-canaries.js` | 1 | **新建文件** | +40 行 |
| `scripts/check-memory-inject-canaries.js` | 2 | **新建文件** | +15 行 |
| `scripts/check-memory-compact-canaries.js` | 3 | **新建文件** | +15 行 |
| `scripts/check-memory-relation-canaries.js` | 4 | **新建文件** | +20 行 |
| `scripts/check-memory-tidy-canaries.js` | 5 | **新建文件** | +20 行 |

**总计：** 修改 6 个现有文件，新建 6 个文件，新增约 490 行代码。
