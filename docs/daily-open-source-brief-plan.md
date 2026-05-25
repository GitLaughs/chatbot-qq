# RSS/网页每日电子报实施计划

生成时间：2026-05-25

## 1. 项目定位

本项目用于把 GitHub、RSS、学校公告和个人关注网页整理成每日中文电子报，通过邮件发送给自己，并保留 HTML 归档。

第一版先做“GitHub 高星开源仓库观察日报”。服务器负责根据我的关注点或者自行决定推荐项目抓取、去重、评分、归档和发邮件；LLM 通过先搜索每日大事件负责确定抓取方向、筛选低价值内容、生成中文摘要和组织邮件结构。Codex 作为开发和维护助手，不作为生产常驻进程。

目标效果：

- 每天定时收到一封中文技术日报。
- 优先发现高星、活跃、新近增长明显的开源仓库。
- 每条内容保留来源链接，方便继续阅读。
- 后续可以接入学校公告、普通网页、RSSHub 和个人关键词。

## 2. 服务器可行性

当前服务器约束：

- 2 核 CPU。
- 2 GiB 内存。
- 20 GiB 存储。
- Ubuntu 24.04。
- 有公网 IP。

可行结论：

- 适合运行 Python 定时脚本、SQLite、少量网页抓取和 SMTP 发送。
- 不适合运行本地大模型、重型浏览器爬虫集群、大型全文检索或长期保存大量网页快照。
- HTML 归档和 SQLite 数据应定期清理，避免占满 20 GiB 磁盘。

默认资源策略：

- GitHub/RSS 抓取优先使用 HTTP API 和普通 RSS。
- 普通网页优先使用 `requests + BeautifulSoup`。
- Playwright 只用于少量必须渲染的动态网页。
- LLM 通过外部 API 调用，不在服务器本地跑模型。

## 3. 第一阶段：GitHub 高星开源仓库日报

MVP 只接 GitHub 数据源，先跑通每日邮件闭环。

信息源：

- GitHub Search API。
- GitHub repository metadata。
- GitHub Releases API，可在第二小步加入。
- README 摘要，可在基础流程稳定后加入。

默认筛选规则：

- `stars > 5000`。
- `archived = false`。
- `fork = false`。
- 最近 180 天有 push。
- 优先 topic 命中 `ai`、`self-hosted`、`developer-tools`、`automation`、`cli`、`infra`。

默认 GitHub 查询：

```text
stars:>5000 pushed:>2025-11-25 archived:false fork:false
stars:5000..20000 pushed:>2025-11-25 archived:false fork:false
stars:>20000 pushed:>2025-11-25 archived:false fork:false
topic:ai stars:>3000 pushed:>2025-11-25 archived:false fork:false
topic:self-hosted stars:>1000 pushed:>2025-11-25 archived:false fork:false
```

每日输出控制：

- 今日最值得看：5 条。
- 高星活跃项目：10 条。
- 新近爆火项目：5 条。
- 重要 release：5 条，第二阶段启用。

单条摘要格式：

```text
项目名 / stars / language / license
一句话说明
为什么值得看
最近变化
适合我做什么
链接
```

## 4. 数据源设计

所有来源统一转换为 `item`，后续处理不关心它来自 GitHub、RSS 还是网页。

统一字段：

```text
id
source_type
source_name
title
url
author
published_at
fetched_at
content_snippet
raw_json
hash
tags
score
status
```

来源类型：

- `github_repo`：GitHub 仓库。
- `github_release`：GitHub release。
- `rss_entry`：RSS 条目。
- `webpage_entry`：网页公告或网页列表条目。

去重规则：

- GitHub 仓库按 `owner/repo` 去重。
- release 按 `repo + tag_name` 去重。
- RSS 和网页按 `url` 优先去重。
- URL 不稳定时按 `title + source_name + content_hash` 去重。

## 5. 数据结构

使用 SQLite，数据库文件放在 `data/brief.sqlite`。

建议表：

```text
sources
items
repo_snapshots
digests
mail_logs
```

`sources` 用于保存来源配置快照：

```text
id
name
type
url
enabled
config_json
created_at
updated_at
```

`items` 保存所有抓取条目：

```text
id
source_id
source_type
title
url
content_snippet
raw_json
hash
published_at
fetched_at
score
status
```

`repo_snapshots` 保存 GitHub 仓库每日快照，用于后续计算 star 增长：

```text
id
full_name
stars
forks
open_issues
language
license
pushed_at
snapshot_date
raw_json
```

`digests` 保存日报结果：

```text
id
digest_date
title
text_content
html_content
item_ids_json
created_at
```

`mail_logs` 保存邮件发送记录：

```text
id
digest_id
mail_to
subject
status
error_message
sent_at
```

## 6. 摘要与邮件生成流程

每日流程：

```text
06:00 抓 GitHub 仓库
06:10 抓 GitHub release
06:20 去重和评分
06:25 选出候选条目
06:30 调用 LLM 生成中文日报
06:35 渲染 HTML 邮件
06:40 SMTP 发信
06:45 保存 HTML 归档
```

评分第一版先简单实现：

```text
score =
  stars_weight
  + recent_push_weight
  + topic_match_weight
  + language_interest_weight
  + license_bonus
  - stale_penalty
  - duplicate_penalty
```

后续可加入：

- 24 小时 star 增长。
- 7 天 star 增长。
- release 重要性。
- README 关键词匹配。
- 用户点击或收藏反馈。

LLM 输入控制：

- 只传候选条目，不传完整数据库。
- 每次最多传 20-40 条。
- 每条只传必要字段：标题、链接、描述、stars、language、topics、最近更新时间、release 摘要。

LLM 输出要求：

```text
你是我的技术情报助理。
输入是一组 GitHub 仓库和网页公告。
请筛掉低价值重复内容。
输出一份中文日报：
1. 今日最值得看
2. GitHub 高星项目观察
3. 重要 Release
4. 可后续尝试的项目
每条不超过 120 字，保留链接。
```

## 7. 项目目录建议

如果后续把这个计划实现为独立项目，建议目录如下：

```text
daily-open-source-brief/
  config/
    sources.yml
    topics.yml
  data/
    brief.sqlite
  app/
    fetch_github.py
    fetch_rss.py
    fetch_web.py
    rank.py
    summarize.py
    render.py
    mailer.py
    run_daily.py
  templates/
    email.html
  public/
    archive/
  docker-compose.yml
  README.md
```

第一版可以不做 Web UI。只需要命令行、cron、日志和邮件。

## 8. 配置文件设计

环境变量：

```text
GITHUB_TOKEN=
OPENAI_API_KEY=
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASS=
MAIL_TO=
MAIL_FROM=
```

不要把真实 token、邮箱密码、cookie 或私密 URL 提交到仓库。

`config/sources.yml` 示例：

```yaml
github:
  queries:
    - name: high-star-active
      q: "stars:>5000 pushed:>2025-11-25 archived:false fork:false"
      limit: 20
    - name: ai-active
      q: "topic:ai stars:>3000 pushed:>2025-11-25 archived:false fork:false"
      limit: 20
    - name: self-hosted-active
      q: "topic:self-hosted stars:>1000 pushed:>2025-11-25 archived:false fork:false"
      limit: 20

topics:
  include:
    - ai
    - self-hosted
    - developer-tools
    - automation
    - cli
    - infra

rss: []

webpages: []
```

第二阶段加入网页公告：

```yaml
webpages:
  - name: school-notice
    url: "https://example.edu/notice"
    selector: ".notice-list a"
    tags: ["school"]
    enabled: true
```

## 9. 定时任务与部署方式

推荐部署：

- Docker 只封装 Python 运行环境。
- SQLite 和归档目录挂载到宿主机。
- cron 由宿主机或容器内调度均可，第一版优先宿主机 cron，便于排查。

宿主机目录：

```text
/opt/daily-open-source-brief/
  config/
  data/
  public/
  logs/
```

运行命令：

```bash
cd /opt/daily-open-source-brief
docker compose run --rm app python -m app.run_daily
```

cron 示例：

```cron
0 6 * * * cd /opt/daily-open-source-brief && docker compose run --rm app python -m app.run_daily >> logs/cron.log 2>&1
```

归档策略：

- 每天保存一份 HTML 到 `public/archive/YYYY-MM-DD.html`。
- SQLite 长期保留元数据。
- 原始网页全文不默认保存。
- HTML 归档保留 180 天，后续按磁盘情况调整。

## 10. 测试与验收标准

MVP 验收：

- 能用 GitHub token 成功抓取仓库列表。
- 能写入 SQLite，并重复运行不重复插入同一仓库。
- 能生成纯文本日报。
- 能生成 HTML 邮件。
- 能通过 SMTP 发到 `MAIL_TO`。
- 能在无新内容时发出“今日无高价值更新”或跳过发信，行为固定。
- 失败时记录日志，不静默失败。

测试场景：

- GitHub token 缺失：命令失败并提示缺少配置。
- GitHub API 限流：记录错误，邮件中说明抓取失败或跳过当日。
- SMTP 认证失败：保存日报，但记录邮件失败。
- LLM API 失败：降级为模板日报，不阻塞整天输出。
- 重复运行：同一天不会重复发送多封，除非显式加 `--force-send`。

安全检查：

- 日志不打印 `GITHUB_TOKEN`、`OPENAI_API_KEY`、`SMTP_PASS`。
- 配置示例只保留占位符。
- 数据库和归档不保存密钥。

## 11. 推荐落地路线

最合理路线：以轻量自研为主，复用成熟项目的设计，不直接 fork 重型全能项目。

选择原因：

- 服务器只有 2 GiB 内存和 20 GiB 存储，优先稳定、透明、低依赖。
- 目标源包含 GitHub Search、学校网页、普通 RSS 和个人网页，不是单纯 RSS 邮件。
- 需要可控的 SQLite 去重、评分、HTML 归档和 SMTP 发送，现成项目通常要么太重，要么覆盖不完整。
- 后续需要 Codex 维护抓取规则，自研小项目更容易按你的源逐步扩展。

参考项目分工：

```text
Daily Drop     参考轻量 RSS -> HTML 邮件管线、sources.yml 和 SMTP 发送。
Horizon        参考多源抓取、AI 评分、日报结构和 Docker 部署，但不直接照搬全量功能。
RSS-Master     参考 RSS include/exclude 过滤、AI 摘要和打分规则。
agents-radar   参考 GitHub/AI 技术日报的分类、报告口径和 GitHub Actions 发布方式。
github-trend   参考 GitHub Trending/高星项目报告格式。
```

实施顺序：

1. 先新建独立项目 `daily-open-source-brief`，不要直接改造成 QQ bot 或 Feishu bot 子功能。
2. 按 Daily Drop 的简单形态搭出命令行管线：配置读取、候选 item、HTML 模板、SMTP 发信。
3. 加 GitHub Search API 抓取模块，把高星活跃仓库写入 SQLite。
4. 加评分和去重，先不用复杂 AI 过滤，保证每天有稳定候选集。
5. 接入 LLM 摘要，把候选条目整理成中文日报。
6. 加 HTML 归档和 cron，每天自动运行。
7. 稳定后再接学校公告网页 selector。
8. 最后再接 RSSHub、普通 RSS、release radar 和个人网页兴趣源。

不推荐路线：

- 不直接 fork Horizon 作为第一版。它功能完整但范围大，裁剪成本高于 MVP 自研。
- 不直接用 rss2email。它稳定但偏传统 RSS 转邮件，缺少 GitHub 高星发现、AI 摘要、评分和网页公告能力。
- 不先上 n8n/Huginn。它们适合自动化编排，但这个项目核心是可维护的数据管线和日报质量。
- 不先做 Web UI。第一版用配置文件、SQLite、邮件和 HTML 归档即可。

第一版完成标准：

- `python -m app.run_daily` 能一次跑完整链路。
- 同一天重复运行不会重复插入和重复发信。
- 邮件里有 5-20 条高价值 GitHub 项目。
- LLM 失败时仍能用模板生成基础日报。
- 配置新 GitHub query 不需要改代码。

## 12. 后续扩展方向

GitHub Release Radar：

- 关注指定仓库的 release。
- 按 breaking change、安全修复、新功能分类。
- 每天只推重要 release。

学校公告雷达：

- 针对学校官网、学院官网、教务页面写 selector。
- 对标题和正文做关键词匹配。
- 按课程、考试、竞赛、通知分类。

网页兴趣源：

- 普通静态页面用 selector 抽取列表。
- 无 RSS 的站点优先尝试 RSSHub。
- 动态页面只在必要时用 Playwright。

个人晨报：

- 加天气。
- 加日程。
- 加 GitHub release。
- 加网页公告。
- 加自定义关键词。

全文搜索和回看：

- 前期只保留 HTML 归档。
- 数据量变大后再考虑 Meilisearch 或 Typesense。

## 13. 默认取舍

- 先做 GitHub 高星开源仓库，不先做学校公告。
- 先做邮件，不做 Web UI。
- 先用 SQLite，不上 PostgreSQL。
- 先用 cron，不上复杂任务队列。
- 先使用外部 LLM API，不跑本地模型。
- 先保存摘要和链接，不默认保存完整网页快照。
- 先保证每天稳定产出，再优化评分和个性化。
