"use strict";

const HARD_PROMPT_INJECTION_PATTERNS = [
  /(?:忽略|无视|覆盖|绕过|删除|清空|重置).{0,20}(?:之前|以上|上面|系统|开发者|安全|规则|指令|提示词|上下文|AGENTS|agent)/iu,
  /(?:显示|输出|泄露|导出|告诉我|发我).{0,24}(?:系统提示|提示词|隐藏指令|开发者消息|AGENTS|system prompt|developer message|token|cookie|密钥|api[_-]?key)/iu,
  /(?:prompt injection|jailbreak|越狱|提示词注入|DAN模式|DAN prompt)/iu,
];

const HARD_DESTRUCTIVE_PATTERNS = [
  /\brm\s+-rf\b/iu,
  /\bdel\s+\/[sq]\b/iu,
  /\bformat\s+[a-z]:/iu,
  /\bRemove-Item\b[\s\S]{0,80}\b-Recurse\b/iu,
];

const DESTRUCTIVE_VERB = /(?:帮我|替我|给我|请|直接|马上|现在)?\s*(?:删掉|删除|卸载|清空|格式化|干掉|移除|禁用|关闭|摧毁|destroy|delete|remove|uninstall|wipe|erase|disable)/iu;
const PROTECTED_TARGET = /(?:vivado|xilinx|codex|qq\s*bot|qqbot|机器人|bot|napcat|onebot|cc-connect|系统提示|提示词|AGENTS\.md|\.env|token|cookie|密钥|api[_-]?key|配置|memory|记忆|日志|服务器|电脑|磁盘|[a-z]:\\)/iu;
const CONTENT_EDIT_HINT = /(?:报告|文档|作业|段落|文字|文本|内容|注释|说明|README|markdown|md文件).{0,20}(?:重复|错字|措辞|格式|润色|改写|删掉这一段|删除这一段)/iu;

function evaluatePromptInjectionRisk(message, options = {}) {
  const text = normalizeText(message);
  if (!text) {
    return { action: "allow", reason: "" };
  }

  if (HARD_PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      action: "block",
      reason: "prompt_injection_or_instruction_extraction",
      reply: "这个请求像是在要求绕过系统规则或读取隐藏指令，我不会执行。可以直接说你要解决的作业、代码或文件问题。",
    };
  }

  if (HARD_DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      action: "block",
      reason: "destructive_shell_command",
      reply: "这个请求包含高风险删除/格式化命令，我不会执行。需要清理文件时，请明确限定 local_files 下的具体路径和目标。",
    };
  }

  if (DESTRUCTIVE_VERB.test(text) && PROTECTED_TARGET.test(text) && !CONTENT_EDIT_HINT.test(text)) {
    return {
      action: "block",
      reason: "destructive_bot_or_host_target",
      reply: "这个请求像是在要求删除或破坏本机工具、机器人组件或敏感配置，我不会执行。要处理 Vivado 作业，我可以帮你分析报错、跑仿真或整理文件。",
    };
  }

  return { action: "allow", reason: "" };
}

function normalizeText(message) {
  return String(message || "")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = {
  evaluatePromptInjectionRisk,
};
