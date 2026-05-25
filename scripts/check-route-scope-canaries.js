#!/usr/bin/env node

const assert = require("assert");
const path = require("path");
const {
  workspaceForGroup,
  workspaceForPrivateUser,
  executionWorkspaceForPrivateUser,
  explainRouteScope,
  WORKSPACE_ROOT,
  ADMIN_ROOT_USERS
} = require("./onebot-group-proxy");

const ADMIN_USER = 1234500001;
const NORMAL_USER = 1234500002;
const GROUP_ID = 9876500001;

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.json && options.table) {
    throw new Error("--json and --table are mutually exclusive");
  }

  assert.strictEqual(typeof workspaceForGroup, "function", "workspaceForGroup must be exported");
  assert.strictEqual(typeof workspaceForPrivateUser, "function", "workspaceForPrivateUser must be exported");
  assert.strictEqual(typeof executionWorkspaceForPrivateUser, "function", "executionWorkspaceForPrivateUser must be exported");
  assert.strictEqual(typeof explainRouteScope, "function", "explainRouteScope must be exported");
  assert.ok(Array.isArray(ADMIN_ROOT_USERS), "ADMIN_ROOT_USERS must be exported as an array");
  assert.ok(ADMIN_ROOT_USERS.includes(ADMIN_USER), `${ADMIN_USER} must remain a root admin`);

  const workspaceRoot = path.resolve(WORKSPACE_ROOT);
  const projectRoot = path.dirname(workspaceRoot);
  const rows = [
    checkPath({
      name: "group-workspace",
      actual: workspaceForGroup(GROUP_ID),
      expected: path.join(workspaceRoot, `sandbox-${GROUP_ID}`),
      note: "group chat runs in its group sandbox"
    }),
    checkPath({
      name: "admin-memory-workspace",
      actual: workspaceForPrivateUser(ADMIN_USER),
      expected: path.join(projectRoot, "users", String(ADMIN_USER)),
      note: "admin private chat memory stays user-scoped"
    }),
    checkPath({
      name: "admin-execution-workspace",
      actual: executionWorkspaceForPrivateUser(ADMIN_USER),
      expected: projectRoot,
      note: "admin private root commands execute at project root"
    }),
    checkPath({
      name: "normal-private-memory",
      actual: workspaceForPrivateUser(NORMAL_USER),
      expected: path.join(projectRoot, "users", String(NORMAL_USER)),
      note: "normal private chat memory stays user-scoped"
    }),
    checkPath({
      name: "normal-private-execution",
      actual: executionWorkspaceForPrivateUser(NORMAL_USER),
      expected: path.join(projectRoot, "users", String(NORMAL_USER)),
      note: "normal private commands execute in the user workspace"
    }),
    checkExplanation({
      name: "explain-admin-memory",
      explanation: explainRouteScope({ message_type: "private", user_id: ADMIN_USER, operation: "memory" }),
      expected: {
        scope: "private",
        operation: "memory",
        user_id: String(ADMIN_USER),
        group_id: null,
        is_admin_root_user: true,
        memory_workspace_relative: `users/${ADMIN_USER}`,
        execution_workspace_relative: ".",
        active_workspace_relative: `users/${ADMIN_USER}`
      }
    }),
    checkExplanation({
      name: "explain-admin-chat",
      explanation: explainRouteScope({ message_type: "private", user_id: ADMIN_USER, operation: "chat" }),
      expected: {
        scope: "private",
        operation: "chat",
        user_id: String(ADMIN_USER),
        group_id: null,
        is_admin_root_user: true,
        memory_workspace_relative: `users/${ADMIN_USER}`,
        execution_workspace_relative: ".",
        active_workspace_relative: `users/${ADMIN_USER}`
      }
    }),
    checkExplanation({
      name: "explain-admin-execute",
      explanation: explainRouteScope({ message_type: "private", user_id: ADMIN_USER, operation: "execute" }),
      expected: {
        scope: "private",
        operation: "execute",
        user_id: String(ADMIN_USER),
        group_id: null,
        is_admin_root_user: true,
        memory_workspace_relative: `users/${ADMIN_USER}`,
        execution_workspace_relative: ".",
        active_workspace_relative: "."
      }
    }),
    checkExplanation({
      name: "explain-normal-chat",
      explanation: explainRouteScope({ message_type: "private", user_id: NORMAL_USER, operation: "chat" }),
      expected: {
        scope: "private",
        operation: "chat",
        user_id: String(NORMAL_USER),
        group_id: null,
        is_admin_root_user: false,
        memory_workspace_relative: `users/${NORMAL_USER}`,
        execution_workspace_relative: `users/${NORMAL_USER}`,
        active_workspace_relative: `users/${NORMAL_USER}`
      }
    }),
    checkExplanation({
      name: "explain-group-chat",
      explanation: explainRouteScope({ message_type: "group", group_id: GROUP_ID, operation: "chat" }),
      expected: {
        scope: "group",
        operation: "chat",
        user_id: null,
        group_id: String(GROUP_ID),
        is_admin_root_user: false,
        memory_workspace_relative: `groups/sandbox-${GROUP_ID}`,
        execution_workspace_relative: `groups/sandbox-${GROUP_ID}`,
        active_workspace_relative: `groups/sandbox-${GROUP_ID}`
      }
    })
  ];

  assert.notStrictEqual(
    path.resolve(workspaceForPrivateUser(ADMIN_USER)),
    path.resolve(executionWorkspaceForPrivateUser(ADMIN_USER)),
    "admin memory workspace must not collapse into project root"
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, checked: rows.length, rows }, null, 2)}\n`);
    return;
  }
  if (options.table) {
    process.stdout.write(`${formatTable(rows)}\n`);
    return;
  }
  process.stdout.write(`OK route scope canaries passed. checked=${rows.length}\n`);
}

function checkPath({ name, actual, expected, note }) {
  const normalizedActual = path.resolve(actual);
  const normalizedExpected = path.resolve(expected);
  assert.strictEqual(normalizedActual, normalizedExpected, `${name} path mismatch`);
  return {
    name,
    actual: normalizedActual,
    expected: normalizedExpected,
    note
  };
}

function checkExplanation({ name, explanation, expected }) {
  for (const [key, value] of Object.entries(expected)) {
    assert.strictEqual(explanation[key], value, `${name} ${key} mismatch`);
  }
  assert.ok(explanation.reason, `${name} must include reason`);
  return {
    name,
    actual: `${explanation.active_workspace_relative} (${explanation.operation})`,
    expected: explanation.execution_workspace_relative,
    note: explanation.reason
  };
}

function parseArgs(argv) {
  const options = {
    json: false,
    table: false
  };
  for (const arg of argv) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--table") {
      options.table = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function formatTable(rows) {
  const headers = ["name", "actual", "note"];
  const widths = headers.map((header) => Math.max(header.length, ...rows.map((row) => String(row[header]).length)));
  const line = (values) => values.map((value, index) => String(value).padEnd(widths[index])).join("  ");
  return [
    line(headers),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.map((row) => line(headers.map((header) => row[header])))
  ].join("\n");
}

function printHelp() {
  process.stdout.write([
    "Usage: node scripts/check-route-scope-canaries.js [--table|--json]",
    "",
    "Checks QQ route scope invariants without reading private chat data."
  ].join("\n") + "\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`ERROR route scope canaries failed: ${error.message}\n`);
  process.exit(1);
}
