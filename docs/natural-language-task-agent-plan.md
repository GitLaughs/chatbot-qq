# QQ Bot 自然语言任务代理优化计划

## 目标

把 QQ bot 从"命令机器人"升级成"自然语言任务代理"。

用户只需要用正常聊天方式描述目标，例如"做一个每周值日提醒""帮我改这个文件再发回来""每天晚上提醒我检查余额"。bot 应该自己判断要不要新建脚本、写配置、跑测试、部署、重启服务，并把任务做到可用状态，而不是只回复固定用法或给建议。

## 当前问题

现在部分能力已经存在，但入口仍然偏固定命令：

- `/提醒 ...` 会先进入确定性命令解析器。
- @ bot 说值日安排，也会走 `isRotaIntent()` → `parseRotaRequest()`，同样依赖正则。
- 两条路径的解析器都只支持少量固定表达。
- 用户稍微换一种自然语言写法，比如"整体值日顺序：... 本周：..."，解析失败后就返回"用法"或错误提示。
- 这会让用户感觉"功能没生效"，实际是命令解析太窄。

这类能力不应该靠越来越多正则硬补。正确方向是：模型负责理解自然语言和补齐结构化参数，脚本负责验证和执行。

## 产品原则

- 自然语言优先：用户不用记命令格式。
- 固定命令保留：`/提醒 列表`、`/提醒 删除 1` 这类管理动作仍可走确定性命令。
- 模型做理解，不做脆弱执行：模型把用户意图解析成结构化 JSON；执行、校验、持久化、定时触发由脚本完成。
- 能自动完成就自动完成：需要写脚本、改配置、建文件、跑测试、部署、重启时，bot 走当前项目允许的自动化流程。
- 结果要落地：回复用户时说明已创建/已修改/已部署，并给出可验证结果。
- 文件要回传：凡是修改了用户从 QQ 发来的文件，改后文件保存到当前聊天 workspace 的 `local_files/` 下，并由代理自动上传回原私聊或群聊。

## 目标交互

### 值日提醒示例

用户：

```text
/提醒 整体值日顺序：洗手台、拖地、厕所、轮休。本周：100000001 洗手台，100000006 拖地，100000007 厕所，100000008 轮休。每周日晚上7点提醒并@对应人；每周每人顺到下一个值日项
```

期望行为：

1. bot 识别这是"创建群轮值提醒"任务。
2. 模型抽取：
   - 类型：weekly_rota
   - 群：当前群
   - 时间：每周日 19:00
   - 值日顺序：洗手台、拖地、厕所、轮休
   - 本周分配：100000001=洗手台，100000006=拖地，100000007=厕所，100000008=轮休
   - 轮换规则：每周每人顺到下一个值日项
   - 通知方式：群内 @ 对应人
3. 脚本校验结构完整。
4. 写入 `memory/rotas.json`。
5. 回复"已创建"，并展示本周和下周的预览。

如果字段缺失，bot 不应直接回"用法"，而应只问缺的字段。例如："还缺提醒时间，是每周几几点？"

### 文件修改示例

用户：

```text
帮我把这个 ps1 改成只能读取 localhost 和本地文件，改好发回来
```

期望行为：

1. bot 读取 QQ 上传文件归档（workspace 下 `received_files/` 或消息中的 file 段）。
2. 判断需要改代码。
3. 修改或新建脚本。
4. 本地检查脚本语法或关键逻辑。
5. 保存到当前聊天 workspace 的 `local_files/`。
6. 回复保存路径。
7. 代理自动把改后文件传回聊天。

## 架构方案

### 1. 增加"任务意图路由层"

位置：`scripts/onebot-group-proxy.js` 出站或入站前置逻辑。

核心判断：

- 明确固定命令且解析成功：直接走确定性 handler。
- 固定命令解析失败，但语义像任务：转给模型任务代理，而不是返回用法。
- 非命令自然语言但包含明确目标：转给模型任务代理。
- 普通聊天：保持现有群聊触发规则。

**两条路径统一覆盖**：

当前有两条入口都会触发轮值解析：

| 路径 | 入口 | 当前失败行为 |
|------|------|-------------|
| A | `/提醒 ...` → `rotaCommand()` | 返回用法字符串 |
| B | @bot + 自然语言 → `isRotaIntent()` → `parseRotaRequest()` | 返回"缺少必要字段" |

两条路径都需要加 LLM 回退：当 `parseRotaRequest()` 返回 null 时，转给模型解析而不是报错。

建议新增模块：

```text
scripts/lib/task-intent-router.js
```

职责：

- 判断消息是不是任务。
- 判断是否适合自动执行。
- 为任务选择执行策略。

输出：

```json
{
  "kind": "task",
  "task_type": "weekly_rota",
  "confidence": 0.86,
  "route": "model_parse_then_script_execute"
}
```

### 2. 增加"模型结构化解析层"

新增脚本：

```text
scripts/task-agent.js
```

职责：

- 把自然语言任务解析成结构化 JSON。
- 严格使用 schema 校验。
- 不直接信任模型输出执行危险命令。

**模型调用方式**：

通过 cc-connect 已有 WebSocket 端口发送消息，复用当前代理的消息路由机制。不直接调 OpenAI-compatible API。

模型选择：使用 `gpt-5.4`（当前 @提及用的模型），因为任务解析需要较强的语义理解能力。

**通用解析 prompt 模板**：

```text
你是一个任务结构化解析器。用户的消息是：
---
{user_message}
---

请根据任务类型 {task_type} 的 schema，将用户意图解析为 JSON。

schema：
{schema_json}

规则：
- 只输出 JSON，不要解释。
- 字段缺失时用 null 占位，不要猜测。
- QQ 号必须是纯数字字符串。
- 时间格式统一为 HH:MM。
- 星期用 0-6（0=周日）。
```

各任务类型的 schema 定义见下方。

### 3. 任务类型 Schema 定义

#### weekly_rota - 每周轮值提醒

```json
{
  "task_type": "weekly_rota",
  "title": "值日提醒",
  "day_of_week": 0,
  "time": "19:00",
  "timezone": "Asia/Shanghai",
  "tasks": ["洗手台", "拖地", "厕所", "轮休"],
  "current_assignments": {
    "100000001": "洗手台",
    "100000006": "拖地",
    "100000007": "厕所",
    "100000008": "轮休"
  },
  "rotation": {
    "direction": "next_task",
    "shift_per_run": 1
  },
  "notify": {
    "mention_assignees": true
  }
}
```

#### scheduled_reminder - 定时提醒

```json
{
  "task_type": "scheduled_reminder",
  "title": "检查余额提醒",
  "schedule": {
    "type": "daily",
    "time": "21:00",
    "timezone": "Asia/Shanghai"
  },
  "message": "别忘了检查余额！",
  "notify": {
    "mention_user": "100000001"
  }
}
```

#### file_modify_and_return - 文件修改并回传

```json
{
  "task_type": "file_modify_and_return",
  "source_file": "received_files/xxx.ps1",
  "instructions": "改成只能读取 localhost 和本地文件",
  "output_path": "local_files/xxx-modified.ps1",
  "checks": ["syntax"]
}
```

文件流说明：
- 输入：QQ 上传文件由 NapCat 归档到 workspace 下 `received_files/`，或从消息的 `file` 段提取路径。
- 输出：修改后保存到 `local_files/`，代理自动上传回当前聊天。
- 权限：只能读写当前 workspace 内的文件。

#### script_create_and_run - 脚本创建并运行

```json
{
  "task_type": "script_create_and_run",
  "title": "创建数据统计脚本",
  "description": "统计本周群消息数量并生成图表",
  "language": "python",
  "output_path": "scripts/weekly-stats.py",
  "run_after_create": true,
  "checks": ["syntax", "dry_run"]
}
```

#### deploy_or_restart - 部署或重启服务

```json
{
  "task_type": "deploy_or_restart",
  "action": "restart",
  "target": "qq-bot",
  "reason": "配置更新后需要重启生效",
  "requires_confirmation": true
}
```

### 4. 固定执行器只接收结构化输入

现有 `scripts/lib/rota-scheduler.js` 应从"解析自然语言 + 执行"拆成两层：

- `parseRotaRequest()`：保留作为快速路径和兼容。
- `createRotaFromSpec(spec)`：新建，接收模型解析后的 JSON。
- `validateRotaSpec(spec)`：校验字段、时间、成员、任务、轮换关系。
- `previewRota(spec, dates)`：创建前后预览本周/下周。

这样 `/提醒` 不再依赖正则覆盖所有表达。

### 5. 去重与幂等性

- 创建轮值前，检查 `memory/rotas.json` 中是否已存在相同 `(day_of_week, time, tasks)` 组合的活跃 rota。
- 如果已存在，回复"已有相同提醒：[预览]，是否仍要创建？"
- 文件修改任务用 `(source_file_hash, instructions_hash)` 做去重键。
- 定时提醒用 `(schedule, message)` 做去重键。

### 6. 自动执行流程

任务代理执行顺序：

1. `classifyTask(message)` — 路由层判断是否为任务
2. `parseTaskWithModel(message, schema)` — 模型结构化解析
3. `validateSpec(spec)` — schema 校验 + 业务校验
4. `checkDuplicate(spec, workspace)` — 去重检查
5. `executeSpec(spec)` — 执行
6. `runFocusedChecks(task_type)` — 针对性检查（语法、格式等）
7. `replyWithResult(result)` — 返回结果

如果执行需要修改 repo 代码：

1. 读取相关文件。
2. 改代码。
3. 补测试。
4. 运行本地测试。
5. 通过后部署。
6. 重启 QQ 服务。
7. 汇报结果。

### 7. 失败策略

不要默认回固定用法。

失败分三类：

- 信息缺失：问一个短问题补字段。
- 解析不确定：给出 bot 理解到的结构，让用户确认。
- 执行失败：说明失败阶段、错误摘要、下一步是否已回滚或保留。

示例：

```text
我已经识别到这是"每周值日提醒"，但还缺提醒时间。你要每周几几点发？
```

```text
我理解的是：每周日 19:00 提醒，轮换顺序为洗手台→拖地→厕所→轮休。本周 100000001 洗手台。确认后我创建。
```

模型解析失败时（返回非法 JSON、超时、schema 校验不通过），回退到原始行为：
- 路径 A（`/提醒`）：返回用法字符串。
- 路径 B（@提及）：返回"无法解析，请按格式描述"。

这样不会因为 LLM 故障导致功能完全不可用。

## 阶段计划

### Phase 1a：parseRotaRequest 失败后加 LLM 回退

两条路径统一处理：

- 路径 A：`rotaCommand()` 中，`parseRotaRequest()` 返回 null 时，调 `task-agent.js` 解析。
- 路径 B：`isRotaIntent()` 中，`parseRotaRequest()` 返回 null 时，同样调 `task-agent.js` 解析。
- 两条路径共用同一个回退逻辑，建议抽成 `tryParseRotaWithFallback(text, context)` 函数。

验收：

- "整体值日顺序：洗手台、拖地、厕所、轮休。本周：100000001 洗手台..." 能创建成功。
- @ bot 说同样的话也能创建成功。
- `/提醒 列表` 能看到提醒。
- 到点能 @ 对应人。
- 同一句话不再返回固定用法。

### Phase 1b：新增 spec 执行函数

在 `rota-scheduler.js` 中新增：

- `createRotaFromSpec(spec)` — 接收模型解析后的 JSON，创建 rota。
- `validateRotaSpec(spec)` — 校验字段完整性、时间格式、QQ 号格式、成员数 ≥ 2、任务数 ≥ 2。
- `previewRota(spec, dates)` — 生成本周和下周的分配预览文本。

验收：

- spec 校验失败时返回具体哪个字段有问题。
- 创建成功后返回预览："本周：洗手台→100000001，拖地→100000006... 下周轮换为..."

### Phase 1c：缺失字段追问对话流

当模型解析结果有 null 字段时，不直接失败，而是追问：

- 只问一个字段，不一次问多个。
- 追问后等用户回复，再补全 spec。
- 追问上下文保持在当前会话内（利用 conversation-context.js）。

验收：

- 用户只说"每周日提醒值日"但没给具体人，bot 问"要提醒哪些人？给我 QQ 号"。
- 用户回复后 bot 补全并创建。

### Phase 2a：通用任务意图路由

新增 `scripts/lib/task-intent-router.js`：

- 对非 `/提醒` 的自然语言消息做任务分类。
- 输出 `{ kind, task_type, confidence, route }`。
- confidence < 0.6 时不自动执行，转为普通聊天。

验收：

- "帮我把这个文件改成只读" 被分类为 `file_modify_and_return`。
- "每天晚上 9 点提醒我检查余额" 被分类为 `scheduled_reminder`。
- 普通聊天不被误分类为任务。

### Phase 2b：task-agent.js + schema 注册机制

新增 `scripts/task-agent.js`：

- 统一的模型调用入口（通过 cc-connect WebSocket）。
- schema 注册表：每种 task_type 注册对应的 JSON schema 和 prompt 片段。
- 模型输出校验：JSON parse + schema validate。
- 失败回退：模型返回非法 JSON 时返回 `{ error: "parse_failed" }`。

验收：

- 输入自然语言 + task_type，输出合法的结构化 JSON。
- 模型返回非法 JSON 时不崩溃，返回错误标识。

### Phase 2c：逐个扩展任务类型

按优先级依次实现：

1. `file_modify_and_return` — 文件读取 → 模型改代码 → 语法检查 → 保存到 local_files → 回传
2. `scheduled_reminder` — 解析 cron 或时间 → 写入提醒配置 → 到点触发
3. `script_create_and_run` — 模型生成脚本 → 语法检查 → 试运行 → 保存
4. `deploy_or_restart` — 需要管理员确认 → 执行部署/重启 → 健康检查

每种类型独立验收，不互相阻塞。

### Phase 3：自适配和自部署（需人工确认门控）

**前置条件**：Phase 1 和 Phase 2 全部验收通过。

- 当现有执行器不支持任务时，bot 可在 repo 内新增脚本或扩展模块。
- 自动运行相关测试。
- 通过后按发布流程部署并重启 QQ 服务。
- 保留变更日志和健康检查结果。

**安全门控**：

- 所有涉及代码修改 + 部署的任务，必须先发预览消息给管理员群或私聊确认。
- 管理员回复"确认"后才执行部署。
- 管理员回复"取消"则回滚代码变更。
- 模型生成的代码不允许：写入 .env 文件、读取其他 workspace 文件、执行 rm -rf / 格式命令、修改代理核心路由逻辑。
- 部署失败自动回滚到部署前的 git commit。

验收：

- "做一个值日提醒"这类新功能需求能被 bot 自己实现、测试、上线。
- 部署前管理员收到确认请求。
- 部署后 `check-napcat-server.ps1` 通过。
- Feishu/OpenClaw 服务不受影响。

## 测试要求

### 模型解析 mock 策略

- 使用固定 JSON fixture 文件（`tests/fixtures/task-specs/`），不录制真实 LLM 响应。
- fixture 覆盖：正常解析、字段缺失、非法 JSON、超时。
- 模型调用函数注入 mock，测试不依赖网络。

### 新增测试

- `testRotaFallbackToModelParseWhenRegexFails` — parseRotaRequest 返回 null → 调模型 → 成功创建
- `testRotaModelSpecCreatesExpectedAssignments` — spec JSON → 创建 rota → 成员分配正确
- `testRotaCommandAndAtMentionBothUseFallback` — 两条路径都走 LLM 回退
- `testMissingRotaFieldsAskOneQuestion` — spec 有 null 字段 → 追问一个字段
- `testDuplicateRotaIsDetected` — 相同 rota 不重复创建
- `testTaskIntentRouterClassifiesNaturalLanguage` — 自然语言 → 正确分类
- `testFileModifyTaskReturnsSavedFilePath` — 文件修改 → 保存到 local_files
- `testModelParseFailureFallsBackGracefully` — 模型返回垃圾 → 回退到原始行为
- `testSpecValidationRejectsInvalidData` — 无效 spec → 返回具体错误字段

### 保留现有

- `node scripts/test-onebot-proxy-units.js`
- `npm run deploy:check`
- `scripts/check-napcat-server.ps1`

## 风险边界

- 模型只能生成结构化建议，真正写入和执行必须经过本地校验。
- 不让模型直接写 secret、读私密跨 workspace 文件、重启非 QQ 服务。
- 群聊任务只写当前群 workspace。
- 私聊任务只写当前用户 workspace。
- 文件回传只允许 `local_files/` 下文件。
- Phase 3 的代码修改 + 部署操作必须经过管理员确认，不能静默执行。

## 最终形态

用户不用学习"正确命令格式"。固定命令只是快捷入口，不是能力边界。

bot 应该像这样工作：

```text
用户自然语言目标
-> bot 理解任务
-> 模型抽取结构
-> 脚本校验执行
-> 必要时写代码/测试/部署
-> 结果回到 QQ
```

值日提醒、文件修改、定时任务、脚本生成都走同一套思路。
