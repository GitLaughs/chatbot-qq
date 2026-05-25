"use strict";

const assert = require("assert");
const bridge = require("./task-model-parser-bridge");
const { buildTaskParseRequest } = require("./task-agent");

async function withMockFetch(fn) {
  const previousFetch = global.fetch;
  try {
    return await fn((mock) => {
      global.fetch = mock;
    });
  } finally {
    global.fetch = previousFetch;
  }
}

async function testResponsesMode() {
  const env = {
    QQ_TASK_MODEL_PARSER_BASE_URL: "https://parser.example/v1",
    QQ_TASK_MODEL_PARSER_API_KEY: "parser-test-key",
    QQ_TASK_MODEL_PARSER_MODEL: "gpt-5.4",
    QQ_TASK_MODEL_PARSER_MODE: "responses",
    QQ_TASK_MODEL_PARSER_MAX_OUTPUT_TOKENS: "512",
  };
  let seen = null;
  await withMockFetch(async (setFetch) => {
    setFetch(async (url, options) => {
      seen = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        text: async () => JSON.stringify({
          output_text: "```json\n{\"task_type\":\"scheduled_reminder\",\"schedule\":{\"type\":\"daily\",\"time\":\"21:00\"},\"message\":\"检查余额\"}\n```",
        }),
      };
    });
    const request = buildTaskParseRequest("每天晚上 9 点提醒我检查余额", "scheduled_reminder", {
      userID: 100000001,
      timezone: "Asia/Shanghai",
      today: "2026-05-25",
    });
    const text = await bridge.callModelParser(request, env);
    assert.strictEqual(JSON.parse(bridge.extractJSONText(text)).schedule.time, "21:00");
  });
  assert.strictEqual(seen.url, "https://parser.example/v1/responses");
  assert.strictEqual(seen.options.headers.Authorization, "Bearer parser-test-key");
  assert.strictEqual(seen.body.model, "gpt-5.4");
  assert.strictEqual(seen.body.max_output_tokens, 512);
  assert.match(seen.body.input[0].content, /outside the current chat workspace/);
  assert.match(seen.body.input[1].content, /schedule\.time/);
  assert.match(seen.body.input[1].content, /不要把任何请求解析成删除、移动、覆盖、改权限或修改当前聊天 workspace 外文件的任务/);
}

async function testChatMode() {
  const env = {
    QQ_TASK_MODEL_PARSER_BASE_URL: "https://parser.example/v1",
    QQ_TASK_MODEL_PARSER_API_KEY: "parser-test-key",
    QQ_TASK_MODEL_PARSER_MODEL: "gpt-5.4",
    QQ_TASK_MODEL_PARSER_MODE: "chat",
  };
  let seen = null;
  await withMockFetch(async (setFetch) => {
    setFetch(async (url, options) => {
      seen = { url, body: JSON.parse(options.body) };
      return {
        ok: true,
        text: async () => JSON.stringify({
          choices: [{ message: { content: "{\"task_type\":\"deploy_or_restart\",\"action\":\"restart\",\"target\":\"qq-bot\",\"reason\":\"配置变更\",\"requires_confirmation\":true}" } }],
        }),
      };
    });
    const request = buildTaskParseRequest("重启 qq bot 服务", "deploy_or_restart", {
      userID: 100000001,
    });
    const text = await bridge.callModelParser(request, env);
    assert.strictEqual(JSON.parse(bridge.extractJSONText(text)).requires_confirmation, true);
    assert.strictEqual(seen.body.messages[1].content, request.prompt);
    assert.match(seen.body.messages[0].content, /Never turn any request into deleting/);
  });
  assert.strictEqual(seen.url, "https://parser.example/v1/chat/completions");
}

async function main() {
  await testResponsesMode();
  await testChatMode();
  console.log("task model parser bridge canaries ok");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
