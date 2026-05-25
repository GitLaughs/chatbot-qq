# JSON 证据包优化计划

## 目标

当前 QQ 机器人会保存较多运行期 JSON/JSONL 数据，例如聊天记录、文件事件、结构化记忆、任务结果和错误记录。优化目标不是把大文件简单拆分后交给模型，也不是把清洗后的 JSON 再交给模型，而是先用确定性脚本完整处理原始 JSON 数据，删除无用字段、去掉重复和噪声，再按固定顺序输出紧凑纯文本证据包。

核心原则：

- 原始 JSON/JSONL 由脚本读取和清洗，模型不直接扫原始大文件。
- 脚本保留完整覆盖能力：按时间窗口、文件列表或全量扫描读取原始记录。
- 模型只读取紧凑纯文本证据包，证据包有稳定顺序、稳定大小和少量必要上下文。
- 给模型的证据包不保留 JSON key、引号、括号、逗号、无意义换行、`message_id` 等路由字段。
- 如需追溯，脚本可另存 debug/source-map 文件；默认不放进模型输入。
- evidence 和 source-map 都按每次运行自动新建文件，避免单个 JSON/JSONL 无限增长；定期清理旧 debug/source-map 文件。
- 日常 JSONL/NDJSON 使用 shard 写入：基准文件超过阈值后写入 `name-001.jsonl`、`name-002.jsonl`，读取时自动合并基准文件和 shard。
- 对聊天记录、画像更新、dream 维护和文件索引使用同一套证据包格式。

## 可行性判断

该计划可实现，且比“让模型直接读取 JSON”更适合本项目。

原因：

- 当前聊天记录已经是 JSONL，每条记录有 `time`、`message_id`、`user_id`、`sender`、`text`、`raw_message` 等字段，适合脚本逐行解析。
- 当前实时回复已经有上下文截断机制，主要风险集中在画像更新和 `/dream` 这类离线维护任务。
- 项目已有确定性处理模式，例如 `/总结今天`、文件索引、候选记忆、错误摘要，可以复用这些分类规则。
- 删除无用 JSON 字段不会损失核心语义，反而能减少模型被 CQ 段、重复字段、路由 ID、原始消息结构干扰。

## 需要优化的入口

### 1. 画像更新

当前入口：

- `scripts/update-user-profiles.sh`
- `scripts/update-user-profiles.ps1`
- `scripts/profile-updater-prompt.md`

当前问题：

- 启动脚本把最近 `chat-*.jsonl` 文件列表交给 Codex。
- prompt 要求模型读取最近聊天记录。
- 如果 72 小时内聊天记录很多，模型可能读取大量无用 JSON 字段。

目标形态：

- 启动脚本先调用证据包生成器。
- 模型只读取 `memory/profile-updates/<stamp>-evidence.md`。
- prompt 明确禁止直接读取 raw `memory/chat-*.jsonl`，除非证据包要求人工追溯。

### 2. `/dream`

当前入口：

- `groups/sandbox-*/scripts/dream.sh`
- `groups/sandbox-*/scripts/dream.ps1`
- `groups/sandbox-*/scripts/dream_prompt.md`

当前问题：

- prompt 允许模型读取 raw group records。
- 虽然已有“large files 不深读”的文字规则，但不是硬限制。

目标形态：

- `/dream` 运行前生成 `memory/dreams/<stamp>-evidence.md`。
- dream prompt 读取证据包、画像文件和索引摘要。
- raw chat 只作为证据源，由脚本清洗，不作为默认模型输入。

### 3. 今日总结和主动维护

当前入口：

- `scripts/lib/proxy-commands.js`
- `scripts/onebot-group-proxy.js`

当前问题：

- `/总结今天` 本地读取当天 JSONL 后自行摘要，模型不直接参与，token 风险低。
- 但它已经包含有用的分类规则，可抽出给证据包生成器复用。

目标形态：

- 抽出通用分类器：请求、待办、错误、文件、决策、偏好候选、最近片段。
- `/总结今天` 和画像更新共用同一套清洗逻辑。

### 4. 文件归档和文件索引

当前入口：

- `scripts/lib/proxy-files.js`
- `scripts/lib/file-index.js`

当前问题：

- 文件索引 JSONL 和 `summary.md` 本身不大，但原始上传文件可能很大。
- 文件相关信息进入模型时应优先用文件元数据和摘要，不直接用全文。

目标形态：

- 证据包只带文件名、路径、大小、解析器、摘要路径、文本预览、相关聊天上下文。
- 不把 `extracted.txt` 全文默认交给模型。

## 证据包格式

建议新增统一文件：

- `scripts/lib/evidence-packet.js`
- `scripts/build-profile-update-packet.js`
- `scripts/build-dream-packet.js`

给模型的证据包使用纯文本，不使用 JSON。文件开头声明字段顺序，后续每行按该顺序输出。

```text
字段顺序：类别 | 时间 | 用户 | 内容 | 原因
范围：72小时；扫描1234条；保留80条；用户8人；文件4个
丢弃：空命令300；CQ噪声120；重复40；过短180

偏好 | 05-24 10:20 | 张三 | 以后默认用简短结论，不要长解释 | 明确偏好
待办 | 05-24 11:03 | 李四 | 明天提醒检查部署状态 | 待办请求
决策 | 05-24 12:44 | 张三 | 采用 NapCat / OneBot 路线 | 明确确认
问题 | 05-24 13:15 | 王五 | 图片上传失败 timeout | 报错
文件 | 05-24 14:01 | 李四 | 上传 report.pdf，已提取摘要 | 文件事件
最近 | 05-24 14:20 | 张三 | 继续按刚才方案做画像清洗 | 近上下文
```

不输出这种结构：

```json
{"kind":"preference","message_id":"987654","text":"..."}
```

原因：`kind`、`message_id`、JSON 引号、括号、冒号、逗号和重复 key 都会消耗 token，且会干扰模型阅读。类别直接放在行首即可。

## 字段清洗规则

聊天 JSONL 保留：

- 时间，压缩为 `MM-DD HH:mm`
- 用户显示名，优先 `sender.card`，其次 `sender.nickname`，最后才用短 user id
- 分类后的内容短句
- 分类原因，例如“明确偏好”“待办请求”“报错”“文件事件”
- 必要时保留图片/文件提示，例如“含图片”“上传文件”

聊天 JSONL 删除：

- `kind` 这类 JSON key
- `raw_message`，除非 `text` 为空且需要恢复纯文本
- `message_id`
- `group_id`
- 完整 `user_id`，除非没有昵称且需要区分用户
- 完整 CQ 段结构
- OneBot 路由元数据
- 空消息、纯表情、纯 at、纯系统噪声
- 重复 bot 回复
- 长 base64、URL token、cookie、authorization 类字段
- JSON 引号、括号、逗号、冒号、数组包裹和无意义换行

文件事件保留：

- 文件名
- 相对路径
- 大小
- 解析器
- `summary_path`
- `extracted_chars`
- 上传时间
- 关联用户和消息 ID

文件事件删除：

- 原始 `get_file` 返回体中的临时下载地址
- 消息 ID、echo ID、OneBot 原始响应字段
- token、cookie、authorization
- 大段提取文本

画像文件保留：

- 最近稳定偏好
- 明确边界
- 常见任务类型
- 回复风格
- 文件习惯
- 仍有效的 ongoing task

画像文件删除或降权：

- “待观察”占位行
- 过期最近观察
- 重复事实
- 与新证据冲突但未标注来源的旧条目

## 证据筛选规则

优先保留：

- 用户明确说“记住”“以后”“我喜欢”“我不想”“默认”“不要”“优先”
- 明确任务请求和未完成事项
- 决策、结论、确认、采用的方案
- 报错、失败、卡住、重试
- 文件上传、修改、回传、报告、代码、PDF、表格
- 反复出现的主题和长期偏好
- 最近几条上下文，用于避免画像更新断章取义

默认丢弃：

- 纯闲聊寒暄
- 单字回复
- 纯表情、纯图片提示、纯 at
- `/status`、`/help`、`/画像` 等命令回显
- bot 自己生成的长回复，除非后续用户确认其中结论
- 重复消息和短时间内相同内容

## 模型输入策略

画像更新 prompt 改为：

- 读取 `*-evidence.md`
- 读取当前 `GROUP_PROFILE.md`、`members/*.md` 或 `PROFILE.md`
- 根据 evidence 更新画像
- 不直接读取 `memory/chat-*.jsonl`
- 如果 evidence 不足，写入 run note 说明“证据不足”，不回退到全文读取

dream prompt 改为：

- 读取 `*-evidence.md`
- 读取 `GROUP_PROFILE.md`
- 读取成员画像摘要
- 读取文件索引摘要
- 默认不读取 raw chat；需要追溯时由脚本 debug/source-map 辅助，不把原始 JSON 交给模型

## 实施步骤

### 阶段 1：画像更新证据包

1. 新增 `scripts/lib/evidence-packet.js`。
2. 新增 `scripts/build-profile-update-packet.js`。
3. 支持输入参数：
   - `--workspace`
   - `--lookback-hours`
   - `--output`
   - `--max-items-per-kind`
   - `--max-text-chars`
   - `--format compact-md`
4. 修改 `scripts/update-user-profiles.sh`，先生成 evidence packet，再调用 Codex。
5. 修改 `scripts/update-user-profiles.ps1`，保持 Windows 路径等价。
6. 修改 `scripts/profile-updater-prompt.md`，禁止默认读取 raw chat。
7. 增加单测覆盖大 JSONL、字段清洗、证据包大小上限和 compact-md 输出。

### 阶段 2：dream 证据包

1. 新增 `scripts/build-dream-packet.js`。
2. 修改三个群 workspace 的 `dream.sh` / `dream.ps1`。
3. 修改三个 `dream_prompt.md`。
4. dream packet 加入：
   - 最近上下文
   - 候选记忆
   - 可能过期画像
   - 文件活动
   - 错误和运维提示
5. 验证 `/dream` 不再直接要求模型扫 raw chat。

### 阶段 3：抽取通用分类规则

1. 从 `/总结今天` 抽出分类函数。
2. 统一用于：
   - `/总结今天`
   - profile packet
   - dream packet
   - pending memory candidates
3. 保持现有命令输出兼容。

### 阶段 4：安全和预算

1. 增加默认配置：
   - `CHATBOT_QQ_EVIDENCE_MAX_CHARS=12000`
   - `CHATBOT_QQ_EVIDENCE_MAX_ITEMS_PER_KIND=8`
   - `CHATBOT_QQ_EVIDENCE_MAX_TEXT_CHARS=220`
   - `CHATBOT_QQ_ALLOW_RAW_CHAT_READ=0`
   - `CHATBOT_QQ_EVIDENCE_FORMAT=compact-md`
   - `CHATBOT_QQ_EVIDENCE_KEEP_DAYS=30`
   - `CHATBOT_QQ_JSONL_SHARD_MAX_BYTES=2097152`
2. 证据包生成时记录 dropped 统计。
3. 每次运行生成独立 `*-evidence.md` 和 `*-source-map.jsonl`，不追加到同一个长期 JSON。
4. cleanup 定时器删除超过保留期的 evidence/source-map 文件。
5. 对敏感字段统一调用 redaction。
6. CI 增加 canary：profile updater prompt 不包含直接读取 raw chat 的要求。

## 验收标准

- 画像更新不再把 raw `chat-*.jsonl` 文件列表作为模型主要输入。
- 画像更新模型输入包含 evidence packet 路径和现有 profile 文件路径。
- evidence packet 能从完整 JSONL 中提取关键证据，同时删除无用字段和 JSON 语法噪声。
- evidence packet 开头声明字段顺序，后续记录按固定顺序输出。
- evidence packet 不包含 `message_id`、`kind`、JSON 引号、括号和数组包装。
- 50MB 聊天 JSONL 下，生成的 evidence packet 仍在预算内。
- `/dream` 默认读取 evidence packet，不默认扫描 raw chat。
- 现有 `/总结今天`、`/画像`、文件索引、实时回复行为不回退。
- 单测覆盖：
  - 字段删除
  - CQ 噪声清洗
  - 重复消息去重
  - 待办/偏好/决策/错误/文件分类
  - source 文件和行号保留
  - compact-md 不输出无用 JSON key
  - 预算上限生效

## 风险和处理

- 风险：脚本规则漏掉模型可能理解的重要语境。
  处理：证据包保留“最近”类上下文；source 映射放 debug 文件，不进入默认模型输入。

- 风险：过度过滤导致画像更新太保守。
  处理：把低置信候选放入 `candidates`，模型可以选择忽略，不直接写入画像。

- 风险：不同入口各写一套规则导致漂移。
  处理：统一放入 `scripts/lib/evidence-packet.js`，命令和定时任务共用。

- 风险：私密字段进入证据包。
  处理：字段白名单加敏感值 redaction，默认不保留 raw JSON，也不保留路由 ID。

## 推荐优先级

先做阶段 1。画像更新是当前最明确的模型大输入风险点，也是收益最高的优化。

然后做阶段 2。`/dream` 属于低频维护任务，但它现在也依赖模型自行读取 raw records，应该统一改成证据包。

阶段 3 和阶段 4 用来收敛工程质量，避免后续新增功能继续把 raw JSON 直接交给模型。
