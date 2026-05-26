# 记忆管理升级计划

基于学术论文和现有架构的渐进式升级方案

生成时间：2026-05-25

---

## 一、现状分析

### 当前架构

```
用户消息 -> onebot-group-proxy.js
  |-> recordGroupMessage() -> memory/chat-YYYY-MM-DD.jsonl  (全量记录)
  |-> /记住 -> memories.jsonl + GROUP_PROFILE.md + members/*.md  (显式记忆)
  |-> /总结今天 -> pending-memory-candidates.jsonl  (候选提取)
  |-> /dream -> evidence packet -> LLM -> KNOWLEDGE.md / bot-style.md  (反思)
  |
  v
消息处理时读取：
  |-> bot-style.md          (风格注入)
  |-> chat-*.jsonl          (会话连续性)
  |-> mood/energy state     (情绪/活跃度)
```

### 当前记忆系统的核心特点

| 维度 | 当前实现 | 对标论文 |
|------|---------|---------|
| 存储 | JSONL + Markdown 文件 | RAG 的非参数记忆 |
| 分层 | 快速上下文(聊天) / 慢速上下文(memory/*.jsonl) | MemGPT 主/归档记忆 |
| 检索 | 全文子串匹配 | -- (无语义检索) |
| 写入 | 确定性正则分类 + 手动确认 | Generative Agents 观察阶段 |
| 反思 | /dream + 画像更新 (手动/定时) | Generative Agents 反思阶段 |
| 衰减 | 无 | MemoryBank 遗忘曲线 |
| 重要性 | 无评分机制 | Generative Agents 重要性评分 |
| 关联 | 独立记忆条目，无关联 | A-MEM 知识图谱 |

### 已识别的 6 个核心差距

1. **检索无语义能力** -- 子串匹配无法处理同义词、近义表达、隐含关联
2. **无时间衰减** -- 1 年前的记忆和 1 分钟前的记忆权重相同
3. **无重要性评分** -- 无法区分"用户喜欢吃辣"和"用户昨天说了句闲话"
4. **记忆无关联** -- 每条记忆独立存在，无法建立关系图
5. **对话中不主动检索长期记忆** -- 只注入 bot-style，不注入相关记忆
6. **反思依赖手动触发** -- /dream 需要手动，画像更新间隔 3 小时

---

## 二、升级原则

**不违背现有设计哲学：**

1. 确定性代码优先，LLM 仅用于高价值任务
2. 无外部依赖（不引入向量数据库、embedding 模型、知识图谱服务）
3. 本地文件系统存储，JSONL + Markdown
4. 渐进式升级，每步可独立部署和回滚
5. 测试先行，每步都有 canary 守护

---

## 三、升级路线图

### Phase 1：记忆检索增强（不引入向量库）

**论文依据：** Generative Agents 的三因子检索 (Recency x Importance x Relevance)

#### 1.1 时间衰减因子 (Recency)

**来源：** Generative Agents (arXiv:2304.03442) 的指数衰减函数 + MemoryBank 的遗忘曲线

**实现方案：**

```javascript
// memory-store.js 新增
function recencyScore(createdAt, now = Date.now()) {
  const ageHours = (now - new Date(createdAt).getTime()) / 3600000;
  // 指数衰减：半衰期 72 小时（可配置）
  const halfLifeHours = Number(process.env.CHATBOT_QQ_MEMORY_RECENCY_HALF_LIFE || 72);
  return Math.pow(0.5, ageHours / halfLifeHours);
}
```

**数据格式扩展：** `memories.jsonl` 不变，衰减在检索时实时计算。

**配置项：**
- `CHATBOT_QQ_MEMORY_RECENCY_HALF_LIFE` -- 衰减半衰期（小时），默认 72

#### 1.2 重要性评分因子 (Importance)

**来源：** Generative Agents 的 LLM 评分（1-10）

**实现方案：** 确定性规则评分，不调用 LLM

```javascript
// memory-rules.js 新增
function importanceScore(memory) {
  let score = 5; // 基线

  // kind 权重
  const kindWeights = {
    boundary: 9,      // 边界最重要
    preference: 7,    // 偏好次之
    project: 6,       // 项目相关
    todo: 5,          // 待办
    fact: 4,          // 事实
    joke: 3,          // 梗
    note: 2           // 备注最低
  };
  score = kindWeights[memory.kind] || 5;

  // 置信度修正
  if (memory.confidence && memory.confidence < 0.7) score -= 1;

  // 来源修正：显式 /记住 比候选更可靠
  if (memory.source?.type === "explicit") score += 1;

  // 标签修正
  if (memory.tags?.includes("boundary")) score = Math.max(score, 8);
  if (memory.tags?.includes("style")) score = Math.max(score, 6);

  return Math.max(1, Math.min(10, score));
}
```

#### 1.3 相关性因子 (Relevance) -- 无向量库方案

**来源：** Generative Agents 的语义相似度，但用确定性方法替代 embedding

**实现方案：** 多维度相关性评分

```javascript
function relevanceScore(memory, query) {
  const q = query.toLowerCase();
  const text = memoryHaystack(memory);
  let score = 0;

  // 1. 精确匹配（最高权重）
  if (text.includes(q)) score += 10;

  // 2. 分词匹配（中文按字/词切分）
  const queryChars = [...new Set(q.replace(/\s/g, ""))];
  const matchedChars = queryChars.filter(c => text.includes(c));
  score += (matchedChars.length / Math.max(1, queryChars.length)) * 5;

  // 3. 标签匹配
  const queryTags = tagMemory(query);
  const commonTags = queryTags.filter(t => memory.tags?.includes(t));
  score += commonTags.length * 3;

  // 4. kind 匹配（查询中含关键词时）
  const queryKind = classifyMemory(query);
  if (queryKind === memory.kind && queryKind !== "note") score += 2;

  // 5. 主体匹配
  if (memory.subject && q.includes(String(memory.subject).toLowerCase())) score += 4;

  return score;
}
```

#### 1.4 三因子综合检索

```javascript
function searchMemoriesRanked({ workspace, query, subject, scope, limit = 10 }) {
  const now = Date.now();
  const matches = searchMemoriesRaw({ workspace, query, subject, scope });

  return matches
    .map(item => ({
      ...item,
      _score: {
        recency: recencyScore(item.created_at, now),
        importance: importanceScore(item),
        relevance: relevanceScore(item, query),
        total: recencyScore(item.created_at, now)
              * importanceScore(item)
              * relevanceScore(item, query)
      }
    }))
    .sort((a, b) => b._score.total - a._score.total)
    .slice(0, limit);
}
```

**影响的文件：**
- `scripts/lib/memory-store.js` -- 新增 `searchMemoriesRanked()`, `recencyScore()`
- `scripts/lib/memory-rules.js` -- 新增 `importanceScore()`, `relevanceScore()`
- `scripts/lib/proxy-commands.js` -- `/记忆` 命令使用 ranked 检索

**测试：**
- `scripts/check-memory-ranking-canaries.js` -- 验证排序正确性

---

### Phase 2：对话中主动检索长期记忆

**论文依据：** MemGPT 的 page fault 机制 + Generative Agents 的检索阶段

#### 2.1 上下文注入点

在每次 bot 回复前，自动检索与当前消息相关的长期记忆，注入上下文。

**当前流程：**
```
用户消息 -> botPersonaContextForMessage() -> 注入 bot-style.md
          -> buildContinuityContextForMessage() -> 注入会话连续性
          -> 构建 prompt -> LLM 生成回复
```

**升级后流程：**
```
用户消息 -> botPersonaContextForMessage() -> 注入 bot-style.md
          -> buildContinuityContextForMessage() -> 注入会话连续性
          -> buildMemoryContextForMessage() -> 注入相关长期记忆  [新增]
          -> 构建 prompt -> LLM 生成回复
```

#### 2.2 实现方案

```javascript
// conversation-context.js 新增
function buildMemoryContextForMessage({ workspace, messageText, subject, scope, scopeID }) {
  if (!messageText || messageText.length < 4) return "";

  const ranked = searchMemoriesRanked({
    workspace,
    query: messageText,
    subject,
    scope,
    limit: 5
  });

  if (ranked.length === 0) return "";

  // 只注入分数足够高的记忆（过滤噪声）
  const threshold = Number(process.env.CHATBOT_QQ_MEMORY_INJECT_THRESHOLD || 20);
  const relevant = ranked.filter(m => m._score.total >= threshold);

  if (relevant.length === 0) return "";

  const lines = relevant.map(m =>
    `- [${m.kind}] ${m.text.slice(0, 120)}`
  );

  return ["【相关记忆】", ...lines].join("\n");
}
```

**配置项：**
- `CHATBOT_QQ_MEMORY_INJECT_THRESHOLD` -- 注入阈值，默认 20
- `CHATBOT_QQ_MEMORY_INJECT_LIMIT` -- 最大注入条数，默认 5
- `CHATBOT_QQ_MEMORY_INJECT_ENABLED` -- 是否启用，默认 true

**影响的文件：**
- `scripts/lib/conversation-context.js` -- 新增 `buildMemoryContextForMessage()`
- `scripts/onebot-group-proxy.js` -- 在构建 prompt 时调用

**测试：**
- 手动验证：在群里说"我喜欢吃辣"，然后问"我应该吃什么"，检查是否注入相关记忆

---

### Phase 3：记忆衰减与自动压缩

**论文依据：** MemoryBank 的遗忘曲线 + Generative Agents 的反思机制

#### 3.1 记忆衰减机制

不是物理删除，而是在检索时衰减权重。旧记忆如果从未被访问，逐渐淡出。

```javascript
// memory-store.js 新增
function effectiveScore(memory, now = Date.now(), accessStats = new Map()) {
  const base = importanceScore(memory);
  const recency = recencyScore(memory.created_at, now);
  const stat = accessStats.get(memory.id) || {};
  const accessCount = Number(stat.access_count || memory.access_count || 0);
  const accessBoost = accessCount ? Math.log2(accessCount + 1) * 0.5 : 0;

  return (base + accessBoost) * recency;
}
```

#### 3.2 记忆访问计数

每次记忆被检索命中时，增加访问计数（类似 MemoryBank 的强化机制）。

**数据格式扩展：** `memories.jsonl` 新增可选初始字段；实际访问记录写入 append-only 辅助日志 `memory-access.jsonl`，避免破坏 JSONL 分片。

```javascript
{
  // ... 现有字段 ...
  access_count: 0,           // 被检索命中次数
  last_accessed_at: null     // 最后被访问时间
}
```

**实现：** 在 `searchMemoriesRanked()` 命中时，向 `memory-access.jsonl` 追加访问事件；检索或压缩时聚合访问次数。不要重写 `memories.jsonl` 主文件。

#### 3.3 自动压缩（低优先级）

当 `memories.jsonl` 条目超过阈值时，自动触发压缩：

1. 按 `effectiveScore()` 排序
2. 低分记忆合并为摘要（调用 LLM）
3. 摘要替代原始条目

**配置项：**
- `CHATBOT_QQ_MEMORY_COMPACT_THRESHOLD` -- 触发压缩的条目数，默认 200
- `CHATBOT_QQ_MEMORY_COMPACT_KEEP` -- 压缩后保留的高分条目数，默认 100

---

### Phase 4：记忆关联图谱（轻量级）

**论文依据：** A-MEM 的原子记忆单元 + 知识图谱结构

#### 4.1 关联数据格式

第一版不在 `memories.jsonl` 中持久化 `related` 字段，改为运行时计算关联。原因：只给新记忆写 `related` 会形成单向关系，检索旧记忆时无法扩展到新记忆。后续如需持久化，使用 append-only `memory-relations.jsonl`。

#### 4.2 关联建立方式（确定性）

不依赖 LLM，通过规则自动建立关联：

1. **同主体关联** -- 同一 `subject_id` 的记忆互相关联
2. **同标签关联** -- 共享 2+ 个 tags 的记忆关联
3. **同时间窗口** -- 10 分钟内产生的记忆关联（同一对话上下文）
4. **同 kind 关联** -- 同一 kind 且同一 scope 的记忆关联

#### 4.3 关联检索

当检索到一条记忆时，自动拉取其关联记忆作为扩展上下文。

```javascript
function expandRelatedMemories(memory, allMemories, limit = 3) {
  return allMemories
    .map(m => ({ memory: m, score: relationScore(memory, m) }))
    .filter(item => item.score >= 4)
    .sort((a, b) => b.score - a.score || importanceScore(b.memory) - importanceScore(a.memory))
    .slice(0, limit)
    .map(item => item.memory);
}
```

---

### Phase 5：反思自动化

**论文依据：** Generative Agents 的 Reflection + Reflexion 的反馈循环

#### 5.1 自动触发反思

当前 `/dream` 和画像更新都是手动/定时触发。升级为事件驱动：

**触发条件（满足任一即触发轻量反思）：**
- 聊天日志新增条目 > 100 条（自上次反思后）
- 新增候选记忆 > 10 条
- 距上次反思 > 6 小时
- 用户显式请求 `/dream`

#### 5.2 反思层级

| 层级 | 触发 | 代价 | 产出 |
|------|------|------|------|
| L0: 确定性整理 | 每 100 条消息 | 零 LLM 调用 | 去重、合并相似候选、清理过期待办 |
| L1: 轻量反思 | 每 6 小时 | 低（compact prompt） | 更新 bot-style.md、合并事实 |
| L2: 深度反思 | 每 24 小时或 /dream | 中（full prompt） | 更新 KNOWLEDGE.md、GROUP_PROFILE.md、成员画像 |

#### 5.3 L0 确定性整理（零成本）

```javascript
function deterministicTidy({ workspace }) {
  const results = { deduped: 0, merged: 0, expired: 0 };

  // 1. 候选记忆去重
  const candidates = readPendingCandidates({ workspace });
  const seen = new Set();
  for (const c of candidates) {
    const key = `${c.kind}:${c.text.toLowerCase()}`;
    if (seen.has(key)) {
      // 标记为重复
      results.deduped++;
    }
    seen.add(key);
  }

  // 2. 过期待办清理（超过 30 天的 todo 候选）
  // 3. 相似记忆合并（fingerprint 相近的记忆）
  // 4. 记忆关联自动建立

  return results;
}
```

---

### Phase 6：跨群知识共享（可选，低优先级）

**论文依据：** MemGPT 的归档记忆分层

当前每个 workspace 完全隔离。对于自用群，可以建立全局知识池。

#### 6.1 全局记忆目录

```
groups/_global/
  memory/
    global-knowledge.jsonl    # 跨群共享知识
    user-index.jsonl          # 用户跨群画像索引
```

#### 6.2 共享规则

- 只有用户显式标记为"全局"的记忆才进入全局池
- 全局记忆在检索时作为补充来源（优先级低于本地记忆）
- 不自动共享，避免隐私泄露

---

## 四、实施优先级和依赖关系

```
Phase 1: 检索增强 (基础，无依赖)
  |
  +-> Phase 2: 主动注入 (依赖 Phase 1 的 ranked 检索)
  |
  +-> Phase 3: 衰减压缩 (依赖 Phase 1 的评分体系)
  |
  +-> Phase 4: 关联图谱 (独立，但与 Phase 1 配合更好)
  |
  v
Phase 5: 反思自动化 (依赖 Phase 3 的压缩机制)
  |
  v
Phase 6: 跨群共享 (依赖以上所有，最低优先级)
```

**建议实施顺序：**

1. **Phase 1** -- 最高优先级，投入产出比最高，2-3 天可完成
2. **Phase 2** -- 高优先级，用户体验提升明显，1-2 天可完成
3. **Phase 5 中的 L0** -- 零成本，可以和 Phase 1 并行
4. **Phase 3** -- 中优先级，需要设计访问计数的写入时机
5. **Phase 4** -- 中低优先级，关联建立的规则需要迭代调优
6. **Phase 6** -- 低优先级，需要仔细考虑隐私边界

---

## 五、配置项汇总

| 环境变量 | Phase | 默认值 | 说明 |
|----------|-------|--------|------|
| `CHATBOT_QQ_MEMORY_RECENCY_HALF_LIFE` | 1 | 72 | 时间衰减半衰期（小时） |
| `CHATBOT_QQ_MEMORY_INJECT_ENABLED` | 2 | true | 是否启用对话中主动注入 |
| `CHATBOT_QQ_MEMORY_INJECT_THRESHOLD` | 2 | 20 | 注入的最低分数阈值 |
| `CHATBOT_QQ_MEMORY_INJECT_LIMIT` | 2 | 5 | 最大注入条数 |
| `CHATBOT_QQ_MEMORY_COMPACT_THRESHOLD` | 3 | 200 | 触发压缩的条目数 |
| `CHATBOT_QQ_MEMORY_COMPACT_KEEP` | 3 | 100 | 压缩后保留条目数 |
| `CHATBOT_QQ_MEMORY_TIDY_INTERVAL_MSGS` | 5 | 100 | L0 整理的消息间隔 |
| `CHATBOT_QQ_MEMORY_REFLECT_INTERVAL_HOURS` | 5 | 6 | L1 轻量反思间隔 |

---

## 六、测试策略

每个 Phase 都需要对应的 canary 测试：

| 测试文件 | Phase | 覆盖内容 |
|----------|-------|---------|
| `check-memory-ranking-canaries.js` | 1 | 三因子排序正确性、衰减曲线、边界值 |
| `check-memory-inject-canaries.js` | 2 | 注入阈值、上下文格式、空结果处理 |
| `check-memory-compact-canaries.js` | 3 | 压缩触发、保留高分记忆、访问计数 |
| `check-memory-relation-canaries.js` | 4 | 关联建立规则、关联检索、循环引用 |
| `check-memory-tidy-canaries.js` | 5 | L0 去重、过期清理、确定性整理 |

---

## 七、风险和缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 检索性能下降 | 响应变慢 | 限制候选集大小，惰性计算，缓存热门查询 |
| 记忆注入噪声 | 回复质量下降 | 严格的阈值过滤，A/B 测试对比 |
| 访问计数写入频繁 | 磁盘 I/O 增加 | 内存缓存 + 定期批量写入 |
| 关联规则误判 | 拉取无关记忆 | 保守规则 + 可配置开关 |
| 自动反思质量 | LLM 输出不稳定 | 保留人工审核路径，渐进式信任 |

---

## 八、与论文的映射总结

| 论文/框架 | 核心思想 | 本计划采纳的部分 | 不采纳的部分及原因 |
|-----------|---------|-----------------|-------------------|
| Generative Agents | 三因子检索 + 反思 | Phase 1 全部 + Phase 5 反思 | LLM 评分重要性（用规则替代） |
| MemGPT | 分层记忆 + 自主管理 | Phase 2 主动注入 + 现有分层 | function call 自主管理（过于复杂） |
| MemoryBank | 遗忘曲线 | Phase 3 衰减 | 物理删除（保留软删除） |
| A-MEM | 知识图谱 + 原子记忆 | Phase 4 轻量关联 | LLM 自主组织（违背确定性原则） |
| Reflexion | 语言反思 | Phase 5 反思层级 | 自动代码修改（保留人工审核） |
| TiM | 思考级抽象 | Phase 5 L1 轻量反思中的事实合并 | 独立的思考提取步骤（用现有证据包替代） |
| GraphRAG | 图结构 RAG | Phase 4 关联图谱 | 全局图遍历（资源开销过大） |
| Mem0 | 开源记忆层 | 不直接引入 | 与现有架构不兼容，依赖外部服务 |

---

## 九、不做什么（明确边界）

1. **不引入向量数据库** -- ChromaDB/FAISS 需要额外进程和 embedding 模型，违背"无外部依赖"原则
2. **不为每条消息调用 LLM** -- 违背"确定性代码优先"原则
3. **不自动跨群共享** -- 隐私风险
4. **不做自动代码修改** -- Reflexion 的自动改代码能力过于危险
5. **不引入外部记忆服务** -- Mem0/Zep 需要额外基础设施
6. **不存储原始 embedding 向量** -- 文件膨胀，不可读，调试困难
