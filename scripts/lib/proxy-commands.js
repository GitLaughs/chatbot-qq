const fs = require("fs");
const path = require("path");

const COMMAND_NAMES = [
  "/help", "help", "帮助",
  "/status", "状态",
  "/记住", "记住",
  "/忘记", "忘记",
  "/总结今天", "总结今天", "/今日总结", "今日总结",
  "/找文件", "找文件",
  "/安静", "安静",
  "/恢复", "恢复",
  "/队列", "队列",
  "/模式", "模式",
  "/最近错误", "最近错误"
];

function createProxyCommands(deps) {
  function commandBody(msg, names) {
    const text = deps.messageText(msg).trim();
    for (const name of names) {
      if (text === name) {
        return "";
      }
      if (text.startsWith(`${name} `)) {
        return text.slice(name.length).trim();
      }
      if ((name === "记住" || name === "忘记" || name === "找文件" || name === "安静" || name === "模式") && text.startsWith(name) && text.length > name.length) {
        return text.slice(name.length).trim();
      }
    }
    return null;
  }

  function isProxyCommand(msg) {
    return commandBody(msg, COMMAND_NAMES) !== null;
  }

  function handleProxyCommand(msg) {
    const isPrivate = msg.message_type === "private";
    const reply = (text) => {
      if (isPrivate) {
        deps.sendPrivateText(msg.user_id, msg.message_id, text);
      } else {
        deps.sendGroupText(msg.group_id, msg.message_id, text);
      }
    };
    const help = commandBody(msg, ["/help", "help", "帮助"]);
    if (help !== null) return reply(proxyHelpText(isPrivate));
    const status = commandBody(msg, ["/status", "状态"]);
    if (status !== null) return reply(proxyStatusText(msg));
    const remember = commandBody(msg, ["/记住", "记住"]);
    if (remember !== null) return reply(rememberFact(msg, remember));
    const forget = commandBody(msg, ["/忘记", "忘记"]);
    if (forget !== null) return reply(forgetFact(msg, forget));
    const summary = commandBody(msg, ["/总结今天", "总结今天", "/今日总结", "今日总结"]);
    if (summary !== null) return reply(todaySummary(msg));
    const findFile = commandBody(msg, ["/找文件", "找文件"]);
    if (findFile !== null) return reply(findFiles(msg, findFile));
    const quiet = commandBody(msg, ["/安静", "安静"]);
    if (quiet !== null) return reply(setQuiet(msg, quiet));
    const resume = commandBody(msg, ["/恢复", "恢复"]);
    if (resume !== null) return reply(resumeGroup(msg));
    const queue = commandBody(msg, ["/队列", "队列"]);
    if (queue !== null) return reply(queueStatus(msg));
    const mode = commandBody(msg, ["/模式", "模式"]);
    if (mode !== null) return reply(setMode(msg, mode));
    const errors = commandBody(msg, ["/最近错误", "最近错误"]);
    if (errors !== null) return reply(recentErrors());
  }

  function proxyHelpText(isPrivate) {
    const lines = [
      "可用命令：",
      "/help：查看功能",
      "/status：查看连接、队列、触发模式",
      "/记住 内容：写入当前用户/群画像",
      "/忘记 关键词：删除画像中匹配的记录",
      "/总结今天：汇总今天聊天",
      "/找文件 关键词：查本群/私聊文件索引",
      "/安静 30分钟：暂停群内主动回复",
      "/恢复：恢复群内主动回复",
      "/队列：查看等待发送、画图、监听队列",
      "/模式 selective|mention|all|off：切换本群触发模式",
      "/最近错误：查看代理最近错误",
      "/画图 prompt：生成图片"
    ];
    if (!isPrivate) {
      lines.push("/dream 或 做梦：整理群记忆");
    }
    return lines.join("\n");
  }

  function proxyStatusText(msg) {
    const snap = deps.healthSnapshot();
    const key = deps.imageStateKey(msg);
    const img = deps.imageStates.get(key) || { active: 0, queue: [] };
    return [
      `QQ 代理：${snap.ok ? "正常" : "异常"}`,
      `OneBot：${snap.upstream.ready ? "已连接" : "未连接"}`,
      `待发送：${snap.pending.upstream_queue}，待回执：${snap.pending.outbound}`,
      `画图：运行 ${img.active}，排队 ${img.queue.length}`,
      `触发模式：${msg.message_type === "group" ? deps.effectiveListenMode(msg.group_id) : deps.defaultListenMode}`,
      `@-only：${msg.message_type === "group" && deps.atOnlyGroups.includes(Number(msg.group_id)) ? "是" : "否"}`,
      `静默：${msg.message_type === "group" && deps.isGroupQuiet(msg.group_id) ? "开启" : "关闭"}`,
      `管理员白名单：${deps.adminUsers.length ? `${deps.adminUsers.length} 人` : "未启用"}`,
      `允许群：${deps.allowedGroups.length} 个，私聊：${deps.allowedPrivateUsers.length} 个`
    ].join("\n");
  }

  function rememberFact(msg, body) {
    const fact = String(body || "").trim();
    if (!fact) return "用法：/记住 这个群默认短答，先给结论";
    const now = new Date().toISOString();
    if (msg.message_type === "group") {
      const workspace = deps.workspaceForGroup(msg.group_id);
      deps.ensureGroupProfile(workspace, msg.group_id);
      deps.appendLine(path.join(workspace, "GROUP_PROFILE.md"), `- ${now} 群偏好/事实: ${fact}`);
      deps.appendLine(deps.memberProfilePath(msg, workspace), `- ${now} 用户补充: ${fact}`);
      return "已记住，后续会按这个偏好处理。";
    }
    const workspace = deps.workspaceForPrivateUser(msg.user_id);
    deps.ensurePrivateProfile(workspace, msg);
    deps.appendLine(path.join(workspace, "PROFILE.md"), `- ${now} 用户补充: ${fact}`);
    return "已记住。";
  }

  function forgetFact(msg, body) {
    const keyword = String(body || "").trim();
    if (!keyword) return "用法：/忘记 关键词";
    const files = [];
    if (msg.message_type === "group") {
      const workspace = deps.workspaceForGroup(msg.group_id);
      files.push(path.join(workspace, "GROUP_PROFILE.md"));
      files.push(deps.memberProfilePath(msg, workspace));
    } else {
      files.push(path.join(deps.workspaceForPrivateUser(msg.user_id), "PROFILE.md"));
    }
    let removed = 0;
    for (const file of files) {
      removed += deps.removeLinesContaining(file, keyword);
    }
    return removed > 0 ? `已删除 ${removed} 条匹配记录。` : "没找到匹配记录。";
  }

  function todaySummary(msg) {
    const workspace = msg.message_type === "group" ? deps.workspaceForGroup(msg.group_id) : deps.workspaceForPrivateUser(msg.user_id);
    const file = path.join(workspace, "memory", `chat-${deps.todayLocal()}.jsonl`);
    if (!fs.existsSync(file)) return "今天还没有可总结的聊天记录。";
    const rows = readJSONLines(file).slice(-300);
    if (rows.length === 0) return "今天聊天记录为空。";
    const byUser = new Map();
    const samples = [];
    for (const row of rows) {
      const user = String((row.sender && (row.sender.card || row.sender.nickname)) || row.user_id || "unknown");
      byUser.set(user, (byUser.get(user) || 0) + 1);
      const text = String(row.text || "").trim();
      if (text && !text.startsWith("/status") && !text.startsWith("/help")) {
        samples.push({ user, text });
      }
    }
    const active = [...byUser.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([user, count]) => `${user} ${count}`).join("，");
    const keywords = topKeywords(samples.map((item) => item.text).join("\n")).slice(0, 8).join("、") || "暂无";
    const recent = samples.slice(-6).map((item) => `- ${item.user}: ${item.text.slice(0, 80)}`);
    const decisions = pickLines(samples, /(决定|结论|就这样|采用|确认|同意|final|方案)/i, 4);
    const todos = pickLines(samples, /(todo|待办|要做|需要|记得|明天|今晚|deadline|截止|帮我|修|改|查)/i, 5);
    const issues = pickLines(samples, /(报错|错误|失败|问题|卡住|不行|timeout|failed|error|bug)/i, 5);
    const files = pickLines(samples, /(文件|pdf|docx|xlsx|图片|上传|归档|代码|脚本|\.py|\.md|\.pdf)/i, 5);
    return [
      `今日记录 ${rows.length} 条。`,
      `活跃成员：${active || "暂无"}`,
      `高频主题：${keywords}`,
      "待办/请求：",
      ...(todos.length ? todos : ["- 暂无"]),
      "问题/风险：",
      ...(issues.length ? issues : ["- 暂无"]),
      "文件/产物：",
      ...(files.length ? files : ["- 暂无"]),
      "决策/结论：",
      ...(decisions.length ? decisions : ["- 暂无"]),
      "最近片段：",
      ...recent
    ].join("\n").slice(0, 1800);
  }

  function findFiles(msg, query) {
    const keyword = String(query || "").trim().toLowerCase();
    if (!keyword) return "用法：/找文件 关键词";
    const workspace = msg.message_type === "group" ? deps.workspaceForGroup(msg.group_id) : deps.workspaceForPrivateUser(msg.user_id);
    const candidates = [];
    collectFileIndexMatches(workspace, keyword, candidates);
    collectArchiveSummaryMatches(workspace, keyword, candidates);
    if (candidates.length === 0) return "没找到匹配文件。";
    return ["找到这些文件：", ...candidates.slice(0, 8).map((item) => `- ${item}`)].join("\n").slice(0, 1400);
  }

  function setQuiet(msg, body) {
    if (msg.message_type !== "group") return "静默只对群聊生效。";
    if (!canAdmin(msg)) return "没有权限。";
    const minutes = parseDurationMinutes(body || "30分钟");
    const until = Date.now() + minutes * 60 * 1000;
    deps.quietUntilByGroup.set(Number(msg.group_id), until);
    deps.persistProxyState();
    return `已安静 ${minutes} 分钟。期间只响应 @、回复和命令。`;
  }

  function resumeGroup(msg) {
    if (msg.message_type !== "group") return "恢复只对群聊生效。";
    if (!canAdmin(msg)) return "没有权限。";
    deps.quietUntilByGroup.delete(Number(msg.group_id));
    deps.persistProxyState();
    return "已恢复群内主动回复。";
  }

  function queueStatus(msg) {
    const imageKey = deps.imageStateKey(msg);
    const img = deps.imageStates.get(imageKey) || { active: 0, queue: [] };
    let listen = { busy: false, queue: [] };
    if (msg.message_type === "group") {
      listen = deps.listenStates.get(Number(msg.group_id)) || listen;
    }
    return [
      `上游待发：${deps.pending.length}`,
      `待回执：${deps.pendingOutbound.size}`,
      `文件下载：${deps.pendingFileDownloads.size}`,
      `画图：运行 ${img.active}，排队 ${img.queue.length}`,
      `监听：${listen.busy ? "处理中" : "空闲"}，缓冲 ${listen.queue.length}`,
      `回复路由缓存：${deps.botReplyRoutes.size}`
    ].join("\n");
  }

  function setMode(msg, body) {
    if (msg.message_type !== "group") return "模式只对群聊生效。";
    if (!canAdmin(msg)) return "没有权限。";
    const requested = String(body || "").trim().toLowerCase();
    if (!requested) {
      return `当前模式：${deps.effectiveListenMode(msg.group_id)}。可选：selective、mention、all、off。`;
    }
    const aliases = new Map([
      ["选择", "selective"], ["选择性", "selective"], ["selective", "selective"],
      ["mention", "mention"], ["at", "mention"], ["只at", "mention"],
      ["all", "all"], ["全部", "all"], ["off", "off"], ["关闭", "off"]
    ]);
    const mode = aliases.get(requested);
    if (!mode) return "模式无效。可选：selective、mention、all、off。";
    if (deps.atOnlyGroups.includes(Number(msg.group_id)) && mode !== "mention" && mode !== "off") {
      return "这个群已锁定为 @ 触发，只能设为 mention 或 off。";
    }
    const workspace = deps.workspaceForGroup(msg.group_id);
    deps.ensureGroupProfile(workspace, msg.group_id);
    deps.listenModeByGroup.set(Number(msg.group_id), mode);
    deps.appendLine(path.join(workspace, "GROUP_PROFILE.md"), `- ${new Date().toISOString()} 触发模式: ${mode}`);
    deps.persistProxyState();
    return `已切换本群触发模式：${mode}`;
  }

  function canAdmin(msg) {
    return deps.adminUsers.length === 0 || deps.adminUsers.includes(Number(msg.user_id));
  }

  function recentErrors() {
    const file = process.env.ONEBOT_PROXY_LOG || "/var/log/onebot-group-proxy.log";
    const localFallback = path.join(__dirname, "..", "..", "onebot-group-proxy.log");
    const source = fs.existsSync(file) ? file : localFallback;
    if (!fs.existsSync(source)) return "没有找到代理日志。";
    const lines = fs.readFileSync(source, "utf8")
      .split(/\r?\n/)
      .filter((line) => /error|failed|timeout|失败|错误/i.test(line))
      .slice(-8)
      .map((line) => deps.maskSensitive(line));
    return lines.length === 0 ? "最近没有明显错误。" : ["最近错误：", ...lines].join("\n").slice(0, 1400);
  }

  return { isProxyCommand, handleProxyCommand };
}

function collectFileIndexMatches(workspace, keyword, out) {
  const index = path.join(workspace, "local_files", "INDEX.md");
  if (!fs.existsSync(index)) return;
  for (const line of fs.readFileSync(index, "utf8").split(/\r?\n/)) {
    if (line.toLowerCase().includes(keyword)) {
      out.push(line.replace(/^\s*[-*]\s*/, "").trim());
    }
  }
}

function collectArchiveSummaryMatches(workspace, keyword, out) {
  const root = path.join(workspace, "local_files");
  if (!fs.existsSync(root)) return;
  const stack = [root];
  while (stack.length > 0 && out.length < 20) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name === "summary.md") {
        const text = fs.readFileSync(full, "utf8");
        if (text.toLowerCase().includes(keyword)) {
          out.push(path.relative(workspace, full).replace(/\\/g, "/"));
        }
      }
    }
  }
}

function readJSONLines(file) {
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function topKeywords(text) {
  const stop = new Set(["这个", "那个", "就是", "一下", "可以", "什么", "怎么", "一个", "我们", "你们", "他们", "今天", "然后", "因为", "所以"]);
  const counts = new Map();
  for (const token of String(text || "").toLowerCase().match(/[\u4e00-\u9fa5]{2,}|[a-z0-9_+-]{3,}/g) || []) {
    if (stop.has(token) || /^\d+$/.test(token)) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([word]) => word);
}

function pickLines(samples, pattern, max) {
  const seen = new Set();
  const picked = [];
  for (const item of samples.slice().reverse()) {
    const text = String(item.text || "").replace(/\s+/g, " ").trim();
    if (!text || !pattern.test(text)) continue;
    const line = `- ${item.user}: ${text.slice(0, 90)}`;
    if (!seen.has(line)) {
      seen.add(line);
      picked.push(line);
    }
    if (picked.length >= max) break;
  }
  return picked.reverse();
}

function parseDurationMinutes(text) {
  const s = String(text || "").trim();
  const match = s.match(/(\d+)\s*(分钟|分|小时|时|h|m)?/i);
  if (!match) return 30;
  const n = Math.max(1, Math.min(24 * 60, Number(match[1]) || 30));
  const unit = match[2] || "分钟";
  return /小时|时|h/i.test(unit) ? n * 60 : n;
}

module.exports = { createProxyCommands };
