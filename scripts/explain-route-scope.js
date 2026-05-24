#!/usr/bin/env node

const { explainRouteScope } = require("./onebot-group-proxy");

function main() {
  const options = parseArgs(process.argv.slice(2));
  const explanation = explainRouteScope({
    message_type: options.messageType,
    user_id: options.userID,
    group_id: options.groupID,
    operation: options.operation
  });
  if (options.table) {
    process.stdout.write(`${formatTable(explanation)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(explanation, null, 2)}\n`);
}

function parseArgs(argv) {
  const options = {
    messageType: null,
    userID: null,
    groupID: null,
    operation: "chat",
    table: false
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--message-type") {
      options.messageType = readValue(argv, ++index, arg);
    } else if (arg === "--user-id") {
      options.userID = readValue(argv, ++index, arg);
    } else if (arg === "--group-id") {
      options.groupID = readValue(argv, ++index, arg);
    } else if (arg === "--operation") {
      options.operation = readValue(argv, ++index, arg);
    } else if (arg === "--table") {
      options.table = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!options.messageType) {
    throw new Error("--message-type is required");
  }
  return options;
}

function readValue(argv, index, name) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function formatTable(explanation) {
  return [
    `scope: ${explanation.scope}`,
    `operation: ${explanation.operation}`,
    `user_id: ${explanation.user_id || ""}`,
    `group_id: ${explanation.group_id || ""}`,
    `is_admin_root_user: ${explanation.is_admin_root_user}`,
    `memory_workspace: ${explanation.memory_workspace_relative}`,
    `execution_workspace: ${explanation.execution_workspace_relative}`,
    `active_workspace: ${explanation.active_workspace_relative}`,
    `reason: ${explanation.reason}`
  ].join("\n");
}

function printHelp() {
  process.stdout.write([
    "Usage: node scripts/explain-route-scope.js --message-type private --user-id 1602858215 [--operation chat|execute|memory] [--table]",
    "       node scripts/explain-route-scope.js --message-type group --group-id 1107099585 [--operation chat|execute|memory] [--table]",
    "",
    "Explains QQ route scope without reading message content or private data."
  ].join("\n") + "\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`ERROR route scope explain failed: ${error.message}\n`);
  process.exit(1);
}
