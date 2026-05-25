# chatbot-qq 智能升级计划：4 项高优先特性

> 基于与理想群聊助手 / 私聊陪伴的差距分析，聚焦最高优先级的 4 项改进。

---

## 背景

项目是一个 QQ 聊天代理（`scripts/onebot-group-proxy.js`，~2925 行），在 NapCat（OneBot v11）和多个 cc-connect LLM 实例之间路由消息。代理是一个**无状态中继层**——不管理会话（由 cc-connect 管理），但可以通过 `enrichMessageForAgent()`（行 712-739）注入上下文。

### 当前架构的优势

- 多群路由，每群独立工作区、模型分层、触发规则、记忆
- 结构化记忆系统（JSONL + 指纹去重 + 候选→确认生命周期）
- 安全基础设施（敏感脱敏、策略漂移检测、管理员认证）
- 运维成熟度（健康端点、Prometheus 指标、故障转移、备份恢复）

### 要解决的 4 个最大差距

| # | 特性 | 类型 | 优先级 |
|---|------|------|--------|
| 1 | 会话连续性 | 群聊 + 私聊 | HIGH |
| 2 | 情感智能 | 私聊 + 群聊 | HIGH |
| 3 | 反馈回路 | 架构 | HIGH |
| 4 | 主动参与 | 群聊 + 私聊 | HIGH |

---

## 依赖关系

```
conversation-context ──┐
                       ├──> proactive-engager（依赖前两者）
mood-tracker ──────────┘
     │
     └──> feedback-detector（使用情绪上下文增强反馈）
```

**Phase 1**（会话连续性 + 情感追踪）必须先完成。Phase 2（反馈）和 Phase 3（主动参与）在 Phase 1 之后可以并行推进。

---

## Phase 1：基础层（会话连续性 + 情感追踪）

### 1a. 新模块：`scripts/lib/conversation-context.js`

**目的**：在对话间隙后注入滚动上下文；包含引用链上下文。

**核心函数**：

| 函数 | 说明 |
|------|------|
| `trackActivity({ scope, scopeID, userID, timestamp })` | 更新内存中的最后活跃时间表 |
| `detectGap({ scope, scopeID })` | 如果空闲超过阈值，返回 `{ hasGap, gapMinutes }` |
| `buildContinuityContext({ workspace, gapMinutes, messageLimit })` | 从 `chat-YYYY-MM-DD.jsonl` 读取最近 N 条消息，返回摘要字符串 |
| `buildReplyChainContext({ workspace, msg })` | 如果消息包含 QQ `reply` 段，在 chat JSONL 中查找原始消息 |

**内存状态**：`lastActivityByScope` Map（无需持久化——重启后从 chat 日志重建）

**上下文输出格式**：
```
【会话恢复上下文】
距离上次对话已过 45 分钟。最近对话：
[张三] 帮我看看这个代码 (10:32)
[李四] Python 报错了 (10:35)
```

**关键前置条件**：在代理中添加 `recordBotReply()`。当前 bot 回复**不会**记录在 chat JSONL 中——只有用户消息被记录。必须在 `handleBotReplyResponse`（行 2250）之后或出站处理器中添加此功能。

**配置项**：
- `ONEBOT_CONTINUITY_GAP_MINUTES`（默认 30）— 触发上下文注入的最小间隙
- `ONEBOT_CONTINUITY_MESSAGE_LIMIT`（默认 10）— 包含的最近消息数
- `ONEBOT_CONTINUITY_ENABLED`（默认 "1"）— 总开关

---

### 1b. 新模块：`scripts/lib/mood-tracker.js`

**目的**：从消息模式检测用户情绪；追踪群聊能量级别。

**核心函数**：

| 函数 | 说明 |
|------|------|
| `analyzeMessageMood(text, recentMessages)` | 返回 `{ mood, confidence, signals }` |
| `updatePrivateMood({ workspace, userID, text })` | 读取最近 10 条消息，计算情绪，持久化到 `memory/mood-state.json` |
| `updateGroupEnergy({ workspace, groupID })` | 统计 5 分钟窗口内的消息数/参与者数 |
| `formatMoodContext(mood)` / `formatGroupEnergyContext(energy)` | 返回富集字符串 |

**情绪检测规则**（确定性，无 LLM）：

| 情绪 | 触发条件 |
|------|----------|
| `frustrated` | 平均长度 < 20 字符 且 匹配 `/不对\|错了\|没用\|不行\|烦\|无语/i` |
| `curious` | 匹配 `/为什么\|怎么\|原理\|是什么\|讲讲/i` 且 平均长度 > 30 |
| `excited` | 匹配 `/！\|哈哈\|太好了\|厉害\|666\|牛/i` 或 平均长度 > 100 |
| `confused` | 匹配 `/不懂\|没明白\|什么意思\|看不懂/i` |
| `urgent` | 匹配 `/急\|快\|马上\|立刻\|赶紧/i` 或 30 秒内重复消息 |
| `neutral` | 以上均不匹配 |

**群聊能量级别**：
- `high`：5 分钟内 >6 条消息 且 >2 个不同参与者
- `medium`：5 分钟内 3-6 条消息 或 >1 个参与者
- `low`：5 分钟内 <3 条消息

**上下文输出**（仅私聊注入，群聊能量高时也注入）：
```
【用户情绪状态：frustrated, 置信度 0.7】
建议：语气温和，先确认问题，给出清晰步骤。
```

**配置项**：
- `ONEBOT_MOOD_ENABLED`（默认 "1"）
- `ONEBOT_MOOD_HISTORY_LIMIT`（默认 10）

---

### 1c. 代理修改（Phase 1）

**`onebot-group-proxy.js` 变更**：

| 位置 | 变更 |
|------|------|
| 行 2250 之后（`handleBotReplyResponse`） | 新增 `recordBotReply`：将 bot 回复文本写入 `chat-YYYY-MM-DD.jsonl`，标记 `user_id: "bot"` |
| 行 2473（`recordGroupMessage`） | 调用 `trackActivity` + `updateGroupEnergy` |
| 行 2490（`recordPrivateMessage`） | 调用 `trackActivity` + `updatePrivateMood` |
| 行 712-739（`enrichMessageForAgent`） | 重写为多源上下文组合（见下方） |

**`enrichMessageForAgent` 重写方案**：
```javascript
function enrichMessageForAgent(msg) {
  if (!msg || msg.post_type !== "message") return msg;
  const normalized = normalizeVisualMessage(msg);

  const contextParts = [];
  // 现有：画像上下文
  const profileCtx = profileContextForMessage(msg);
  if (profileCtx) contextParts.push(profileCtx);

  // 新增：会话连续性上下文
  const continuityCtx = safeCall(() => buildContinuityContextForMessage(msg));
  if (continuityCtx) contextParts.push(continuityCtx);

  // 新增：引用链上下文
  const replyChainCtx = safeCall(() => buildReplyChainContextForMessage(msg));
  if (replyChainCtx) contextParts.push(replyChainCtx);

  // 新增：情绪/能量上下文
  const moodCtx = safeCall(() => buildMoodContextForMessage(msg));
  if (moodCtx) contextParts.push(moodCtx);

  if (contextParts.length === 0) return normalized;

  const context = contextParts.join("\n");
  // ... 现有段构建逻辑
}

function safeCall(fn) {
  try { return fn(); }
  catch (err) { log("enrich context error", err.message); return null; }
}
```

每个 `build*ContextForMessage` 函数是一个薄包装，调用对应模块，优雅捕获异常，返回字符串或 null。

**新命令**：
- `/连续` — 显示会话连续性状态（最后活跃时间、间隙状态）
- `/心情` — 显示情绪状态（私聊）或群聊能量（群聊）

---

## Phase 2：反馈回路

### 新模块：`scripts/lib/feedback-detector.js`

**目的**：从 bot 回复后的用户消息中检测隐式满意度。

**核心函数**：

| 函数 | 说明 |
|------|------|
| `detectFeedbackSignal({ triggerMsg, replyMsgID, feedbackMsg })` | 返回 `{ signalType, confidence, evidence }` |
| `recordFeedbackSignal({ workspace, signal })` | 追加到 `memory/feedback-signals.jsonl`，指纹去重 |
| `feedbackStats({ workspace })` | 汇总 positive/negative/neutral 计数 |
| `formatFeedbackStats(stats)` / `formatFeedbackHistory(signals)` | 用户可读文本 |

**信号检测规则**（确定性）：

| 信号类型 | 匹配模式 | 置信度 |
|----------|----------|--------|
| `positive` | `/谢谢\|感谢\|thanks\|解决了\|搞定了\|明白了\|懂了\|👍\|🙏\|ok\|收到/i` | 0.9 |
| `negative` | `/不对\|错了\|没用\|不行\|还是不行\|没解决\|不懂\|没明白/i` | 0.9 |
| `repeat_question` | 5 分钟内发送相似文本（>60% bigram 重叠） | 0.8 |
| `topic_shift` | 5 分钟内 <20% 关键词重叠 | 0.6 |

**JSONL 格式**：
```json
{
  "version": 1,
  "id": "fb_<ts>_<random>",
  "scope": "group",
  "scope_id": "123456789",
  "trigger_message_id": "...",
  "reply_message_id": "...",
  "signal_type": "positive",
  "confidence": 0.9,
  "evidence": "谢谢",
  "gap_seconds": 45,
  "fingerprint": "<sha1-16>"
}
```

**代理钩子**：
1. 在 `recordGroupMessage`（行 505）和 `recordPrivateMessage`（行 548）之后：检查消息是否是最近 bot 回复的反馈（使用 `botReplyRoutes` Map + `FEEDBACK_WINDOW_SECONDS`）
2. 在 `enrichMessageForAgent` 中：可选地注入最近正面反馈上下文

**配置项**：
- `ONEBOT_FEEDBACK_WINDOW_SECONDS`（默认 300）— bot 回复后多久内检测反馈
- `ONEBOT_FEEDBACK_ENABLED`（默认 "1"）

**新命令**：
- `/反馈` — 显示反馈统计
- `/反馈 最近` — 显示最近反馈信号

---

## Phase 3：主动参与

### 新模块：`scripts/lib/proactive-engager.js`

**目的**：决定 bot 何时应在无显式触发时发言。

**依赖**：conversation-context（间隙检测）、mood-tracker（群聊能量）、feedback-detector（主题专长）

**核心函数**：

| 函数 | 说明 |
|------|------|
| `evaluateGroupEngagement({ workspace, groupID, msg })` | 返回 `{ shouldEngage, reason, confidence }` |
| `evaluatePrivateCheckin({ workspace, userID, lastActivity })` | 如果空闲 >4h 且有未解决项，返回 `{ shouldCheckin, reason }` |
| `buildProactiveContext({ reason, topic })` | 主动派发的富集字符串 |
| `setProactivityLevel({ groupID, level })` | `off`/`low`/`normal`/`high` |

**知识匹配算法**：
1. 从 `KNOWLEDGE.md` 提取关键词
2. 从最近 `memories.jsonl` 条目提取 kind+text
3. 计算与传入消息的关键词重叠
4. 如果 >2 个关键词匹配，触发参与
5. 速率限制：每群每 15 分钟最多 1 次主动参与

**主动参与级别**：

| 级别 | 行为 |
|------|------|
| `off` | 无主动参与 |
| `low` | 仅知识匹配（置信度 >0.8） |
| `normal` | 知识匹配 + 新成员欢迎 + 私聊签到 |
| `high` | 以上全部 + 更低阈值（0.5）+ 专长领域问题回复 |

**代理钩子**：

1. **行 529-533**：`shouldDispatchListenMessage` 返回 false 后，检查 `evaluateGroupEngagement`。如果 `shouldEngage: true`，派发到 listen 端口并附加主动上下文。
2. **行 495 附近**：添加 `group_increase` 通知处理器用于新成员欢迎。
3. **周期定时器**（每 30 分钟）：检查私聊用户的签到资格。

**与 `/安静` 的集成**：主动参与检查 `quietUntilByGroup`，如果群聊安静则跳过。

**配置项**：
- `ONEBOT_PROACTIVE_ENABLED`（默认 "1"）
- `ONEBOT_PROACTIVE_LEVEL`（默认 "normal"）
- `ONEBOT_PROACTIVE_COOLDOWN_MS`（默认 900000）— 15 分钟冷却
- `ONEBOT_PROACTIVE_CHECKIN_HOURS`（默认 4）— 私聊签到间隔
- `ONEBOT_PROACTIVE_CHECKIN_INTERVAL_MS`（默认 1800000）— 检查频率

**新命令**：
- `/主动` — 显示当前群的主动参与配置
- `/主动 off|low|normal|high` — 设置主动参与级别
- `/主动 状态` — 显示主动参与统计

---

## 新命令汇总

| 命令 | 别名 | 范围 | 阶段 | 功能 |
|------|------|------|------|------|
| `/连续` | `/continuity` | 全部 | 1 | 会话连续性状态 |
| `/心情` | `/mood` | 私聊 | 1 | 情绪状态 / 群聊能量 |
| `/反馈` | `/feedback` | 全部 | 2 | 反馈统计 |
| `/反馈 最近` | — | 全部 | 2 | 最近反馈信号 |
| `/主动` | `/proactive` | 群聊 | 3 | 主动参与配置 |
| `/主动 off\|low\|normal\|high` | — | 群聊 | 3 | 设置主动参与级别 |
| `/主动 状态` | — | 群聊 | 3 | 参与统计 |

---

## 配置项汇总

### 会话连续性
```env
ONEBOT_CONTINUITY_ENABLED=1
ONEBOT_CONTINUITY_GAP_MINUTES=30
ONEBOT_CONTINUITY_MESSAGE_LIMIT=10
```

### 情感追踪
```env
ONEBOT_MOOD_ENABLED=1
ONEBOT_MOOD_HISTORY_LIMIT=10
ONEBOT_ENERGY_WINDOW_MS=300000
```

### 反馈回路
```env
ONEBOT_FEEDBACK_ENABLED=1
ONEBOT_FEEDBACK_WINDOW_SECONDS=300
```

### 主动参与
```env
ONEBOT_PROACTIVE_ENABLED=1
ONEBOT_PROACTIVE_LEVEL=normal
ONEBOT_PROACTIVE_COOLDOWN_MS=900000
ONEBOT_PROACTIVE_CHECKIN_HOURS=4
ONEBOT_PROACTIVE_CHECKIN_INTERVAL_MS=1800000
```

---

## 文件清单

### 新建文件

| 文件 | 估计行数 | 功能 |
|------|----------|------|
| `scripts/lib/conversation-context.js` | ~150 | 会话连续性检测与上下文构建 |
| `scripts/lib/mood-tracker.js` | ~200 | 情绪检测与群聊能量追踪 |
| `scripts/lib/feedback-detector.js` | ~200 | 反馈信号检测与记录 |
| `scripts/lib/proactive-engager.js` | ~250 | 主动参与评估与调度 |

### 修改文件

| 文件 | 修改位置 | 变更内容 |
|------|----------|----------|
| `scripts/onebot-group-proxy.js` | 行 505, 529-533, 712-739, 2250, 2473, 2490, 495 | 新增钩子、`recordBotReply`、`group_increase` 处理、`enrichMessageForAgent` 重写 |
| `scripts/lib/proxy-commands.js` | 行 15-43, 45-77, 163 之后 | COMMAND_NAMES、HELP_ENTRIES、新命令处理器 |
| `scripts/test-onebot-proxy-units.js` | 新增测试用例 | 4 个模块的单元测试 + 集成测试 |

### 参考文件（遵循现有模式）

| 文件 | 参考内容 |
|------|----------|
| `scripts/lib/memory-store.js` | JSONL 读写模式、指纹去重 |
| `scripts/lib/memory-rules.js` | 正则分类模式 |
| `scripts/lib/sensitive-redaction.js` | 敏感内容阻断 |
| `scripts/lib/proxy-commands.js` | 命令注册与派发模式 |

---

## 数据流

```
入站消息
  │
  ▼
recordGroupMessage / recordPrivateMessage
  ├── 写入 chat-YYYY-MM-DD.jsonl
  ├── touchMemberProfile / touchPrivateProfile
  ├── 新增：trackActivity (conversation-context)
  ├── 新增：updateGroupEnergy / updatePrivateMood (mood-tracker)
  └── 新增：detectFeedbackSignal (feedback-detector)
  │
  ▼
shouldDispatchListenMessage（现有）
  ├── 是：handleListenMessage → dispatchToPort
  └── 否：新增 evaluateGroupEngagement (proactive-engager)
           ├── 应该参与：派发并附加主动上下文
           └── 不参与：跳过（现有行为）
  │
  ▼
dispatchToPort → enrichMessageForAgent
  ├── profileContextForMessage（现有）
  ├── 新增：buildContinuityContext（检测到间隙时）
  ├── 新增：buildReplyChainContext（发现引用段时）
  ├── 新增：buildMoodContext（私聊）/ buildGroupEnergyContext（群聊，高能量时）
  └── 新增：buildFeedbackContext（最近正面模式）
  │
  ▼
转发到 cc-connect WS

出站 Bot 回复
  │
  ▼
prepareOutgoing → sendUpstream → NapCat
  │
  ▼
handleBotReplyResponse
  ├── rememberBotReply（现有）
  ├── 新增：recordBotReply（写入 chat JSONL）
  └── 新增：recordFeedbackTarget（供 feedback-detector 使用）
```

---

## 优雅降级策略

每个模块遵循相同模式：
1. 模块延迟加载（类似行 238 的 `proxyCommands`）
2. 每个钩子调用用 try/catch 包裹
3. 如果模块数据文件损坏，返回默认值（空上下文、中性情绪、无反馈）
4. 每个特性有 `*_ENABLED` 环境变量，设为 "0" 时跳过所有处理
5. `enrichMessageForAgent` 过滤掉 null/空上下文部分后再拼接

---

## 测试策略

### 单元测试

**feedback-detector.js**：
- `testFeedbackPositiveDetection`："谢谢" → positive, 置信度 0.9
- `testFeedbackNegativeDetection`："不对" → negative, 置信度 0.9
- `testFeedbackRepeatQuestion`：5 分钟内相似问题 → repeat_question
- `testFeedbackDedup`：相同指纹 → 跳过

**conversation-context.js**：
- `testGapDetection`：31 分钟前最后活跃 → hasGap=true
- `testNoGap`：5 分钟前最后活跃 → hasGap=false
- `testReplyChainContext`：带 reply 段的消息 → 包含原始文本

**mood-tracker.js**：
- `testMoodFrustrated`：短消息 → frustrated
- `testMoodCurious`：问题密集 → curious
- `testGroupEnergyHigh`：5 分钟 8 条消息 → high
- `testMoodPersistence`：保存/加载往返

**proactive-engager.js**：
- `testKnowledgeMatch`：匹配 KNOWLEDGE.md 关键词 → shouldEngage
- `testProactivityLevelOff`：level=off → 不参与
- `testCooldownWithinWindow`：冷却期内 → 跳过

### 集成测试

- `testEnrichmentComposesMultipleSources`：验证 `enrichMessageForAgent` 包含所有活跃模块的上下文
- `testEnrichmentGracefulDegradation`：一个模块抛异常 → 其他模块仍正常贡献
- `testFeedbackLoopEndToEnd`：bot 回复 → 用户说"谢谢" → 反馈记录 → 下次富集包含反馈上下文

### 手动验证

1. 启动代理，发送测试消息，验证：
   - 30 分钟空闲后，下一条消息的富集日志中包含连续性上下文
   - 发送"谢谢"后，`memory/feedback-signals.jsonl` 中记录了 positive 信号
   - 私聊消息触发 `memory/mood-state.json` 更新
   - 消息匹配 KNOWLEDGE.md 关键词时触发主动参与
2. 临时重命名模块文件 → 验证代理继续正常工作
3. 从 QQ 测试 `/连续`、`/心情`、`/反馈`、`/主动` 命令

---

## 实施建议

1. **从 Phase 1 开始**，因为它为后续特性提供基础
2. **先添加 `recordBotReply`**——这是 Phase 1 的关键前置条件，当前 bot 回复不记录在 chat 日志中
3. **每完成一个模块就写测试**，而不是最后补测试
4. **每个模块独立可用**——即使其他模块未完成，单个模块也能提供价值
5. **保守配置默认值**——主动参与默认 `normal`，反馈窗口 5 分钟，这些都是可以调优的
