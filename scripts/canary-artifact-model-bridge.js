"use strict";

const assert = require("assert");
const bridge = require("./artifact-model-bridge");

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

async function testFileModifierResponsesMode() {
  const env = {
    QQ_TASK_ARTIFACT_MODEL_BASE_URL: "https://artifact.example/v1",
    QQ_TASK_ARTIFACT_MODEL_API_KEY: "artifact-test-key",
    QQ_TASK_ARTIFACT_MODEL: "gpt-5.4",
    QQ_TASK_ARTIFACT_MODEL_MODE: "responses",
    QQ_TASK_ARTIFACT_MODEL_MAX_OUTPUT_TOKENS: "2048",
  };
  const request = {
    role: "file_modifier",
    spec: {
      task_type: "file_modify_and_return",
      source_file: "local_files/archive/demo.py",
      instructions: "把 before 改成 after",
      output_path: "local_files/modified/demo-modified.py",
      checks: ["syntax"],
    },
    source: { path: "local_files/archive/demo.py", content: "print('before')\n" },
    rules: ["Only output JSON with a content field."],
  };
  let seen = null;
  await withMockFetch(async (setFetch) => {
    setFetch(async (url, options) => {
      seen = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        text: async () => JSON.stringify({
          output_text: "```json\n{\"content\":\"print('after')\\n\"}\n```",
        }),
      };
    });
    const text = await bridge.callArtifactModel(request, env);
    assert.deepStrictEqual(bridge.normalizeArtifactOutput(request, text), { content: "print('after')\n" });
  });
  assert.strictEqual(seen.url, "https://artifact.example/v1/responses");
  assert.strictEqual(seen.options.headers.Authorization, "Bearer artifact-test-key");
  assert.strictEqual(seen.body.model, "gpt-5.4");
  assert.strictEqual(seen.body.max_output_tokens, 2048);
  assert.match(seen.body.input[1].content, /完整修改后的文件内容/);
  assert.match(seen.body.input[1].content, /local_files\/archive\/demo\.py/);
}

async function testScriptGeneratorChatMode() {
  const env = {
    QQ_TASK_ARTIFACT_MODEL_BASE_URL: "https://artifact.example/v1",
    QQ_TASK_ARTIFACT_MODEL_API_KEY: "artifact-test-key",
    QQ_TASK_ARTIFACT_MODEL: "gpt-5.4",
    QQ_TASK_ARTIFACT_MODEL_MODE: "chat",
  };
  const request = {
    role: "script_generator",
    spec: {
      task_type: "script_create_and_run",
      title: "统计",
      description: "打印 ok",
      language: "python",
      output_path: "local_files/generated/generated-task.py",
      run_after_create: true,
      checks: ["syntax", "dry_run"],
    },
    rules: ["Only output JSON with a code field."],
  };
  let seen = null;
  await withMockFetch(async (setFetch) => {
    setFetch(async (url, options) => {
      seen = { url, body: JSON.parse(options.body) };
      return {
        ok: true,
        text: async () => JSON.stringify({
          choices: [{ message: { content: "{\"code\":\"print('ok')\\n\"}" } }],
        }),
      };
    });
    const text = await bridge.callArtifactModel(request, env);
    assert.deepStrictEqual(bridge.normalizeArtifactOutput(request, text), { code: "print('ok')\n" });
  });
  assert.strictEqual(seen.url, "https://artifact.example/v1/chat/completions");
  assert.match(seen.body.messages[1].content, /完整脚本内容/);
  assert.match(seen.body.messages[1].content, /dry_run/);
}

async function main() {
  await testFileModifierResponsesMode();
  await testScriptGeneratorChatMode();
  console.log("task artifact model bridge canaries ok");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
