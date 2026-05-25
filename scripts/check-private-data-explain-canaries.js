#!/usr/bin/env node

const { explainPrivateDataPath } = require("./lib/private-data-audit");

const root = process.cwd();

const canaries = [
  {
    scope: "Publish",
    path: "configs/.cc-connect.napcat.local.toml.lock",
    scanned: false,
    reasonType: "publish_exclude_file_name_pattern",
    reasonValue: "\\.local\\.toml\\.lock$"
  },
  {
    scope: "Publish",
    path: "configs/cc-connect.napcat.local.toml",
    scanned: false,
    reasonType: "publish_exclude_file_name",
    reasonValue: "cc-connect.napcat.local.toml"
  },
  {
    scope: "Publish",
    path: "configs/cc-connect.napcat.server.example.toml",
    scanned: true,
    reasonType: null
  },
  {
    scope: "Publish",
    path: "users/" + "1234500001/README.md",
    scanned: false,
    reasonType: "publish_exclude_dir",
    reasonValue: "users"
  },
  {
    scope: "Publish",
    path: "users/" + "1234500001",
    isDirectory: true,
    scanned: false,
    reasonType: "publish_exclude_dir",
    reasonValue: "users"
  },
  {
    scope: "Publish",
    path: "groups/sandbox-9876500001/README.md",
    scanned: true,
    reasonType: null
  },
  {
    scope: "Publish",
    path: "groups/sandbox-9876500001/AGENTS.md",
    scanned: true,
    reasonType: null
  },
  {
    scope: "Publish",
    path: "groups/sandbox-9876500001/scripts/tool.js",
    scanned: true,
    reasonType: null
  },
  {
    scope: "Publish",
    path: "groups/sandbox-9876500001",
    isDirectory: true,
    scanned: true,
    reasonType: null
  },
  {
    scope: "Publish",
    path: "groups/sandbox-9876500001/" + "memory/" + "cha" + "t-2026-05-24.jsonl",
    scanned: false,
    reasonType: "publish_exclude_path_pattern",
    reasonValue: "^groups\\/[^/]+\\/(memory|local_files|files)(\\/|$)"
  },
  {
    scope: "Publish",
    path: "groups/sandbox-9876500001/" + "memory",
    isDirectory: true,
    scanned: false,
    reasonType: "publish_exclude_path_pattern",
    reasonValue: "^groups\\/[^/]+\\/(memory|local_files|files)(\\/|$)"
  },
  {
    scope: "Publish",
    path: "groups/sandbox-9876500001/local_files/upload.txt",
    scanned: false,
    reasonType: "publish_exclude_path_pattern",
    reasonValue: "^groups\\/[^/]+\\/(memory|local_files|files)(\\/|$)"
  },
  {
    scope: "Publish",
    path: "groups/sandbox-9876500001/local_files",
    isDirectory: true,
    scanned: false,
    reasonType: "publish_exclude_path_pattern",
    reasonValue: "^groups\\/[^/]+\\/(memory|local_files|files)(\\/|$)"
  },
  {
    scope: "Publish",
    path: "groups/sandbox-9876500001/files/upload.txt",
    scanned: false,
    reasonType: "publish_exclude_path_pattern",
    reasonValue: "^groups\\/[^/]+\\/(memory|local_files|files)(\\/|$)"
  },
  {
    scope: "Publish",
    path: "groups/sandbox-9876500001/files",
    isDirectory: true,
    scanned: false,
    reasonType: "publish_exclude_path_pattern",
    reasonValue: "^groups\\/[^/]+\\/(memory|local_files|files)(\\/|$)"
  },
  {
    scope: "Live",
    path: "configs/.cc-connect.napcat.local.toml.lock",
    scanned: true,
    reasonType: null
  },
  {
    scope: "Live",
    path: "configs/cc-connect.napcat.local.toml",
    scanned: true,
    reasonType: null
  },
  {
    scope: "Live",
    path: "users/" + "1234500001/README.md",
    scanned: true,
    reasonType: null
  },
  {
    scope: "Live",
    path: "users/" + "1234500001",
    isDirectory: true,
    scanned: true,
    reasonType: null
  },
  {
    scope: "Live",
    path: "groups/sandbox-9876500001/" + "memory/" + "cha" + "t-2026-05-24.jsonl",
    scanned: true,
    reasonType: null
  },
  {
    scope: "Live",
    path: "groups/sandbox-9876500001/" + "memory",
    isDirectory: true,
    scanned: true,
    reasonType: null
  },
  {
    scope: "Live",
    path: "groups/sandbox-9876500001/local_files/upload.txt",
    scanned: true,
    reasonType: null
  },
  {
    scope: "Live",
    path: "groups/sandbox-9876500001/local_files",
    isDirectory: true,
    scanned: true,
    reasonType: null
  },
  {
    scope: "Live",
    path: "groups/sandbox-9876500001/files/upload.txt",
    scanned: true,
    reasonType: null
  },
  {
    scope: "Live",
    path: "groups/sandbox-9876500001/files",
    isDirectory: true,
    scanned: true,
    reasonType: null
  }
];

function main() {
  const options = parseArgs(process.argv.slice(2));
  const rows = [];
  for (const item of canaries) {
    if (options.scope && item.scope !== options.scope) {
      continue;
    }
    const actual = explainPrivateDataPath({
      root,
      scope: item.scope,
      relativePath: item.path,
      isDirectory: Boolean(item.isDirectory)
    });
    assertEqual(actual.scanned, item.scanned, `${item.path} scanned`);
    assertEqual(actual.excluded, !item.scanned, `${item.path} excluded`);
    const reasonType = actual.reason ? actual.reason.type : null;
    assertEqual(reasonType, item.reasonType, `${item.path} reason.type`);
    if (item.reasonValue !== undefined) {
      assertEqual(actual.reason ? actual.reason.value : null, item.reasonValue, `${item.path} reason.value`);
    }
    rows.push(formatRecord(actual));
  }
  if (options.json && options.table) {
    throw new Error("--json and --table are mutually exclusive");
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, checked: rows.length, scope: options.scope || null, rows }, null, 2)}\n`);
    return;
  }
  if (options.table) {
    process.stdout.write(`${formatTable(rows.map(formatTableRow))}\n`);
    return;
  }
  process.stdout.write(`OK private-data explain canaries passed. checked=${rows.length}\n`);
}

function parseArgs(argv) {
  const options = {
    json: false,
    table: false,
    scope: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--table") {
      options.table = true;
    } else if (arg === "--scope") {
      i += 1;
      options.scope = normalizeScopeArg(argv[i]);
    } else if (arg.startsWith("--scope=")) {
      options.scope = normalizeScopeArg(arg.slice("--scope=".length));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function normalizeScopeArg(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "publish") return "Publish";
  if (text === "live") return "Live";
  throw new Error("--scope must be Publish or Live");
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected=${expected} actual=${actual}`);
  }
}

function formatRecord(actual) {
  return {
    scope: actual.scope,
    path: actual.path,
    is_directory: actual.is_directory,
    scanned: actual.scanned,
    excluded: actual.excluded,
    reason: actual.reason
  };
}

function formatTableRow(actual) {
  return {
    scope: actual.scope,
    path: actual.path,
    status: actual.scanned ? "scanned" : "excluded",
    reason: actual.reason ? `${actual.reason.type}:${actual.reason.value}` : "-"
  };
}

function formatTable(rows) {
  const headers = ["scope", "path", "status", "reason"];
  const widths = headers.map((header) => Math.max(header.length, ...rows.map((row) => String(row[header]).length)));
  const lines = [
    headers.map((header, index) => pad(header, widths[index])).join(" | "),
    widths.map((width) => "-".repeat(width)).join("-|-")
  ];
  for (const row of rows) {
    lines.push(headers.map((header, index) => pad(String(row[header]), widths[index])).join(" | "));
  }
  return lines.join("\n");
}

function pad(value, width) {
  return value + " ".repeat(Math.max(0, width - value.length));
}

try {
  main();
} catch (err) {
  console.error(err.message || err);
  process.exitCode = 1;
}
