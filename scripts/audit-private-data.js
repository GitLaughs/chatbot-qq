#!/usr/bin/env node

const { explainPrivateDataPath, formatPrivateDataAudit, scanPrivateData } = require("./lib/private-data-audit");

function main(argv) {
  const options = parseArgs(argv);
  if (options.explainPath !== undefined) {
    const explanation = explainPrivateDataPath({
      root: options.root,
      scope: options.scope,
      rulesPath: options.rulesPath,
      relativePath: options.explainPath,
      isDirectory: options.explainDirectory
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(explanation, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatPathExplanation(explanation)}\n`);
    }
    return;
  }
  const report = scanPrivateData({ root: options.root, scope: options.scope, rulesPath: options.rulesPath });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatPrivateDataAudit(report)}\n`);
  }
  if (!report.ok) {
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    scope: "Publish",
    rulesPath: undefined,
    explainPath: undefined,
    explainDirectory: undefined,
    json: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--root") {
      i += 1;
      options.root = requiredOptionValue(argv[i], "--root");
    } else if (arg.startsWith("--root=")) {
      options.root = requiredOptionValue(arg.slice("--root=".length), "--root");
    } else if (arg === "--scope") {
      i += 1;
      options.scope = requiredOptionValue(argv[i], "--scope");
    } else if (arg.startsWith("--scope=")) {
      options.scope = requiredOptionValue(arg.slice("--scope=".length), "--scope");
    } else if (arg === "--rules") {
      i += 1;
      options.rulesPath = requiredOptionValue(argv[i], "--rules");
    } else if (arg.startsWith("--rules=")) {
      options.rulesPath = requiredOptionValue(arg.slice("--rules=".length), "--rules");
    } else if (arg === "--explain-path") {
      i += 1;
      options.explainPath = requiredOptionValue(argv[i], "--explain-path");
    } else if (arg.startsWith("--explain-path=")) {
      options.explainPath = arg.slice("--explain-path=".length);
    } else if (arg === "--explain-directory") {
      if (options.explainDirectory === false) {
        throw new Error("--explain-file and --explain-directory are mutually exclusive");
      }
      options.explainDirectory = true;
    } else if (arg === "--explain-file") {
      if (options.explainDirectory === true) {
        throw new Error("--explain-file and --explain-directory are mutually exclusive");
      }
      options.explainDirectory = false;
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function requiredOptionValue(value, option) {
  if (value === undefined || String(value).trim() === "" || String(value).startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function printHelp() {
  process.stdout.write("Usage: node scripts/audit-private-data.js [--scope Publish|Live] [--root PATH] [--rules PATH] [--json] [--explain-path PATH] [--explain-directory|--explain-file]\n");
}

function formatPathExplanation(explanation) {
  if (explanation.excluded) {
    return `EXCLUDED ${explanation.path} scope=${explanation.scope} reason=${explanation.reason.type}:${explanation.reason.value}`;
  }
  return `SCANNED ${explanation.path} scope=${explanation.scope}`;
}

try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(err.message || err);
  process.exitCode = 2;
}
