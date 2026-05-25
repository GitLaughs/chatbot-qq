const assert = require("assert");
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { explainPrivateDataPath, scanPrivateData, validateRuleConfig } = require("./lib/private-data-audit");

function testPublishIgnoresLiveOnlyFiles() {
  const root = makeFixtureRoot();
  try {
    writeLiveOnlyFiles(root);
    fs.writeFileSync(path.join(root, "README.md"), "QQ group 123456789 is routing metadata, not a secret.\n", "utf8");
    const report = scanPrivateData({ root, scope: "Publish" });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.blocking.length, 0);
  } finally {
    removeFixtureRoot(root);
  }
}

function testLiveReportsRuntimeWarningsWithoutBlocking() {
  const root = makeFixtureRoot();
  try {
    writeLiveOnlyFiles(root);
    const report = scanPrivateData({ root, scope: "Live" });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.blocking.length, 0);
    assert.ok(report.warnings.some((item) => item.type === "forbidden local file"));
    assert.ok(report.warnings.some((item) => item.type === "runtime memory"));
  } finally {
    removeFixtureRoot(root);
  }
}

function testLowercaseLiveScopeReportsRuntimeWarningsWithoutBlocking() {
  const root = makeFixtureRoot();
  try {
    writeLiveOnlyFiles(root);
    const report = scanPrivateData({ root, scope: "live" });
    assert.strictEqual(report.scope, "Live");
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.blocking.length, 0);
    assert.ok(report.warnings.some((item) => item.type === "runtime memory"));
  } finally {
    removeFixtureRoot(root);
  }
}

function testPublishBlocksSourceTokens() {
  const root = makeFixtureRoot();
  try {
    const tokenName = "access_" + "token";
    const tokenValue = "abcdefghijklmnop";
    fs.writeFileSync(path.join(root, "source.js"), `const ${tokenName} = '${tokenValue}';\n`, "utf8");
    const report = scanPrivateData({ root, scope: "Publish" });
    assert.strictEqual(report.ok, false);
    assert.ok(report.blocking.some((item) => item.type === "secret token"));
  } finally {
    removeFixtureRoot(root);
  }
}

function testRuleFilesDoNotSuppressTokens() {
  const root = makeFixtureRoot();
  try {
    fs.mkdirSync(path.join(root, "configs"), { recursive: true });
    const tokenName = "access_" + "token";
    fs.writeFileSync(path.join(root, "configs", "private-data-audit-rules.json"), [
      '"Nap' + 'Cat.json"',
      `${tokenName} = abcdefghijklmnop`
    ].join("\n"), "utf8");
    const report = scanPrivateData({ root, scope: "Publish" });
    assert.strictEqual(report.ok, false);
    assert.ok(report.warnings.some((item) => item.type === "local config"));
    assert.ok(report.blocking.some((item) => item.type === "secret token"));
  } finally {
    removeFixtureRoot(root);
  }
}

function testAllowedFindingBudgetBlocksOveruse() {
  const root = makeFixtureRoot();
  try {
    fs.mkdirSync(path.join(root, "configs"), { recursive: true });
    fs.writeFileSync(path.join(root, "configs", "one.txt"), "Nap" + "Cat.json\n", "utf8");
    fs.writeFileSync(path.join(root, "configs", "two.txt"), "Nap" + "Cat.json\n", "utf8");
    const rulesPath = path.join(root, "rules.json");
    fs.writeFileSync(rulesPath, JSON.stringify(makeRules({
      allowed_findings: [
        { id: "test-local-config", type: "local config", max_matches: 1, path_patterns: ["^configs/.*\\.txt$"] }
      ]
    })), "utf8");
    const report = scanPrivateData({ root, scope: "Publish", rulesPath });
    assert.strictEqual(report.ok, false);
    const summary = report.allowed_summary.find((item) => item.id === "test-local-config");
    assert.ok(summary);
    assert.strictEqual(summary.matches, 2);
    assert.strictEqual(summary.max_matches, 1);
    assert.deepStrictEqual(summary.files, ["configs/one.txt", "configs/two.txt"]);
    assert.ok(report.blocking.some((item) => item.type === "allowed finding budget"));
  } finally {
    removeFixtureRoot(root);
  }
}

function testRuleMetaRejectsSecretTokenAllowlist() {
  assert.throws(() => validateRuleConfig({
    allowed_findings: [
      { id: "bad-secret-token", type: "secret token", max_matches: 1, path_patterns: ["^configs/private-data-audit-rules\\.json$"] }
    ]
  }), /must not allow secret token/);
}

function testRuleMetaRejectsBroadAllowlistPatterns() {
  for (const pattern of [".*", "^.*$", "source\\.js", "^configs/.*"]) {
    assert.throws(() => validateRuleConfig({
      allowed_findings: [
        { id: "bad-broad-pattern", type: "local config", max_matches: 1, path_patterns: [pattern] }
      ]
    }), /path pattern/);
  }
}

function testRuleMetaRejectsDuplicateAllowlistIDs() {
  assert.throws(() => validateRuleConfig({
    allowed_findings: [
      { id: "duplicate", type: "local config", max_matches: 1, path_patterns: ["^configs/private-data-audit-rules\\.json$"] },
      { id: "duplicate", type: "runtime memory", max_matches: 1, path_patterns: ["^configs/.*\\.example\\.toml$"] }
    ]
  }), /id must be unique/);
}

function testRuleMetaRejectsInvalidAllowlistIDs() {
  for (const id of ["", "   ", 1, null, false]) {
    assert.throws(() => validateRuleConfig({
      allowed_findings: [
        { id, type: "local config", max_matches: 1, path_patterns: ["^configs/private-data-audit-rules\\.json$"] }
      ]
    }), /must define an id/);
  }
}

function testRuleMetaRejectsInvalidBudgets() {
  for (const item of [
    { id: "missing-budget", type: "local config", path_patterns: ["^configs/private-data-audit-rules\\.json$"] },
    { id: "null-budget", type: "local config", max_matches: null, path_patterns: ["^configs/private-data-audit-rules\\.json$"] },
    { id: "float-budget", type: "local config", max_matches: 1.5, path_patterns: ["^configs/private-data-audit-rules\\.json$"] },
    { id: "blank-string-budget", type: "local config", max_matches: "", path_patterns: ["^configs/private-data-audit-rules\\.json$"] },
    { id: "space-string-budget", type: "local config", max_matches: "   ", path_patterns: ["^configs/private-data-audit-rules\\.json$"] },
    { id: "numeric-string-budget", type: "local config", max_matches: "1", path_patterns: ["^configs/private-data-audit-rules\\.json$"] },
    { id: "false-budget", type: "local config", max_matches: false, path_patterns: ["^configs/private-data-audit-rules\\.json$"] },
    { id: "true-budget", type: "local config", max_matches: true, path_patterns: ["^configs/private-data-audit-rules\\.json$"] }
  ]) {
    assert.throws(() => validateRuleConfig({ allowed_findings: [item] }), /must define max_matches/);
  }
}

function testGitignoreCoversCriticalPrivateRuntimePaths() {
  const gitignorePath = path.join(__dirname, "..", ".gitignore");
  const gitignore = fs.readFileSync(gitignorePath, "utf8");
  const requiredPatterns = [
    ".env",
    "*.local.toml",
    "*.local.toml.lock",
    "tmp/",
    "users/",
    "groups/*/memory/",
    "groups/*/local_files/",
    "groups/*/files/",
    "chatbot-qq-qrcode.png",
    "configs/cc-connect.napcat.local.toml",
    "Nap" + "Cat.json",
    "configs/Nap" + "Cat.json",
    "onebot11_*.json",
    "configs/onebot11_*.json",
    "*.sqlite",
    "*.sqlite3",
    "*.db",
    "runs/*.jsonl"
  ];
  for (const pattern of requiredPatterns) {
    assert.ok(hasGitignorePattern(gitignore, pattern), `.gitignore must include ${pattern}`);
  }
}

function testGitignoreBehaviorProtectsRuntimeWithoutHidingWorkspaceFiles() {
  const root = makeFixtureRoot();
  try {
    fs.copyFileSync(path.join(__dirname, "..", ".gitignore"), path.join(root, ".gitignore"));
    cp.execFileSync("git", ["init", "-q"], { cwd: root, stdio: "pipe" });
    const ignoredPaths = [
      "tmp/cache.json",
      "users/" + "100000001/" + "memory/dreams/20260524-events.jsonl",
      "groups/sandbox-123456789/" + "memory/" + "cha" + "t-2026-05-24.jsonl",
      "groups/sandbox-123456789/local_files/upload.txt",
      "groups/sandbox-123456789/files/image.png",
      "memory/search/index.sqlite3-wal",
      "runs/20260524-events.jsonl",
      "configs/onebot11_" + "123456.json",
      "chatbot-qq-qrcode.png"
    ];
    const visiblePaths = [
      "groups/sandbox-123456789/AGENTS.md",
      "groups/sandbox-123456789/README.md",
      "groups/sandbox-123456789/scripts/tool.js",
      "configs/cc-connect.napcat.server.example.toml",
      "docs/qqbot-integration-plan.md",
      "scripts/test-private-data-audit.js"
    ];
    const ignored = gitCheckIgnore(root, ignoredPaths);
    for (const item of ignoredPaths) {
      assert.ok(ignored.has(item), `${item} should be ignored`);
    }
    const visible = gitCheckIgnore(root, visiblePaths);
    for (const item of visiblePaths) {
      assert.ok(!visible.has(item), `${item} should not be ignored`);
    }
  } finally {
    removeFixtureRoot(root);
  }
}

function testPublishScanKeepsGroupWorkspaceFilesVisible() {
  const root = makeFixtureRoot();
  try {
    const marker = "PUBLISH_VISIBLE_MARKER";
    const visibleFiles = [
      "groups/sandbox-123456789/AGENTS.md",
      "groups/sandbox-123456789/README.md",
      "groups/sandbox-123456789/scripts/tool.js"
    ];
    const excludedFiles = [
      "users/" + "100000001/README.md",
      "groups/sandbox-123456789/" + "memory/" + "cha" + "t-2026-05-24.jsonl",
      "groups/sandbox-123456789/" + "members/" + "100000001.md",
      "groups/sandbox-123456789/local_files/upload.txt",
      "groups/sandbox-123456789/files/upload.txt"
    ];
    for (const file of visibleFiles.concat(excludedFiles)) {
      writeFixtureFile(root, file, `${marker}\n`);
    }
    const rulesPath = path.join(root, ".rules", "rules.json");
    fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
    fs.writeFileSync(rulesPath, JSON.stringify(makeRules({
      common_exclude_dirs: [".rules"],
      publish_exclude_dirs: ["users"],
      publish_exclude_path_patterns: ["^groups/[^/]+/(memory|members|local_files|files|\\.cc-connect)(/|$)"],
      patterns: [
        { name: "workspace marker", regex: marker }
      ]
    })), "utf8");
    const report = scanPrivateData({ root, scope: "Publish", rulesPath });
    assert.strictEqual(report.ok, false);
    assert.deepStrictEqual(
      report.blocking.filter((item) => item.type === "workspace marker").map((item) => item.file).sort(),
      visibleFiles.sort()
    );
  } finally {
    removeFixtureRoot(root);
  }
}

function testDefaultPublishRulesKeepGroupWorkspaceFilesVisible() {
  const root = makeFixtureRoot();
  try {
    const tokenLine = "access_" + "token = abcdefghijklmnop\n";
    const visibleFiles = [
      "groups/sandbox-123456789/AGENTS.md",
      "groups/sandbox-123456789/README.md",
      "groups/sandbox-123456789/scripts/tool.js"
    ];
    const excludedFiles = [
      "users/" + "100000001/README.md",
      "groups/sandbox-123456789/" + "memory/" + "cha" + "t-2026-05-24.jsonl",
      "groups/sandbox-123456789/" + "members/" + "100000001.md",
      "groups/sandbox-123456789/local_files/upload.txt",
      "groups/sandbox-123456789/files/upload.txt"
    ];
    for (const file of visibleFiles.concat(excludedFiles)) {
      writeFixtureFile(root, file, tokenLine);
    }
    const report = scanPrivateData({ root, scope: "Publish" });
    assert.strictEqual(report.ok, false);
    assert.deepStrictEqual(
      report.blocking.filter((item) => item.type === "secret token").map((item) => item.file).sort(),
      visibleFiles.sort()
    );
  } finally {
    removeFixtureRoot(root);
  }
}

function testExplainPrivateDataPathUsesDefaultRules() {
  const root = makeFixtureRoot();
  try {
    const cases = [
      {
        input: { relativePath: "groups/sandbox-123456789/README.md", scope: "Publish", isDirectory: false },
        expected: { excluded: false, reasonType: null }
      },
      {
        input: { relativePath: "groups/sandbox-123456789/" + "memory/" + "cha" + "t-2026-05-24.jsonl", scope: "Publish", isDirectory: false },
        expected: { excluded: true, reasonType: "publish_exclude_path_pattern" }
      },
      {
        input: { relativePath: "groups/sandbox-123456789/" + "members/" + "100000001.md", scope: "Publish", isDirectory: false },
        expected: { excluded: true, reasonType: "publish_exclude_path_pattern" }
      },
      {
        input: { relativePath: "groups/sandbox-123456789/files/upload.txt", scope: "Publish", isDirectory: false },
        expected: { excluded: true, reasonType: "publish_exclude_path_pattern" }
      },
      {
        input: { relativePath: "users/" + "100000001/README.md", scope: "Publish", isDirectory: false },
        expected: { excluded: true, reasonType: "publish_exclude_dir" }
      },
      {
        input: { relativePath: "configs/cc-connect.napcat.local.toml", scope: "Publish", isDirectory: false },
        expected: { excluded: true, reasonType: "publish_exclude_file_name" }
      },
      {
        input: { relativePath: "configs/.cc-connect.napcat.local.toml.lock", scope: "Publish", isDirectory: false },
        expected: { excluded: true, reasonType: "publish_exclude_file_name_pattern" }
      },
      {
        input: { relativePath: "configs/cc-connect.napcat.server.example.toml", scope: "Publish", isDirectory: false },
        expected: { excluded: false, reasonType: null }
      },
      {
        input: { relativePath: "users/" + "100000001/README.md", scope: "Live", isDirectory: false },
        expected: { excluded: false, reasonType: null }
      }
    ];
    for (const item of cases) {
      const explanation = explainPrivateDataPath({ root, ...item.input });
      assert.strictEqual(explanation.excluded, item.expected.excluded, `${item.input.relativePath} excluded mismatch`);
      assert.strictEqual(explanation.scanned, !item.expected.excluded, `${item.input.relativePath} scanned mismatch`);
      assert.strictEqual(explanation.reason ? explanation.reason.type : null, item.expected.reasonType, `${item.input.relativePath} reason mismatch`);
    }
  } finally {
    removeFixtureRoot(root);
  }
}

function testExplainPrivateDataPathRejectsUnsafeInputs() {
  const root = makeFixtureRoot();
  try {
    for (const relativePath of [
      "",
      "   ",
      "../outside.txt",
      "groups/../outside.txt",
      "/etc/passwd",
      "\\windows\\system.ini",
      "C:" + "\\temp\\file.txt",
      "C:temp\\file.txt"
    ]) {
      assert.throws(() => explainPrivateDataPath({ root, relativePath }), /explain-path/, `${relativePath} should be rejected`);
    }
  } finally {
    removeFixtureRoot(root);
  }
}

function testExplainPathCliRejectsInvalidInputs() {
  const root = makeFixtureRoot();
  try {
    const script = path.join(__dirname, "audit-private-data.js");
    const cases = [
      { args: ["--root", root, "--explain-path"], pattern: /requires a value/ },
      { args: ["--root", root, "--explain-path="], pattern: /requires a relative path/ },
      { args: ["--root", root, "--explain-path", "--json"], pattern: /requires a value/ },
      { args: ["--root", root, "--explain-path", "../outside.txt", "--json"], pattern: /must not contain/ },
      { args: ["--root", root, "--explain-path", "C:" + "\\temp\\file.txt", "--json"], pattern: /must be relative/ },
      { args: ["--root", root, "--explain-path", "README.md", "--explain-file", "--explain-directory"], pattern: /mutually exclusive/ }
    ];
    for (const item of cases) {
      assertCliFails(script, item.args, item.pattern);
    }
  } finally {
    removeFixtureRoot(root);
  }
}

function testAuditCliRejectsMissingOptionValues() {
  const script = path.join(__dirname, "audit-private-data.js");
  const cases = [];
  for (const option of ["--root", "--scope", "--rules"]) {
    cases.push({ args: [option], pattern: /requires a value/ });
    cases.push({ args: [`${option}=`], pattern: /requires a value/ });
    cases.push({ args: [option, "--json"], pattern: /requires a value/ });
  }
  for (const item of cases) {
    assertCliFails(script, item.args, item.pattern);
  }
}

function testExplainPathCliGoldenOutput() {
  const root = makeFixtureRoot();
  try {
    const script = path.join(__dirname, "audit-private-data.js");
    assert.strictEqual(
      assertCliSucceeds(script, ["--root", root, "--scope", "Publish", "--explain-path", "groups/sandbox-123456789/README.md"]).stdout.trim(),
      "SCANNED groups/sandbox-123456789/README.md scope=Publish"
    );
    assert.match(
      assertCliSucceeds(script, ["--root", root, "--scope", "Publish", "--explain-path", "groups/sandbox-123456789/files/upload.txt"]).stdout.trim(),
      /^EXCLUDED groups\/sandbox-123456789\/files\/upload\.txt scope=Publish reason=publish_exclude_path_pattern:/
    );
  } finally {
    removeFixtureRoot(root);
  }
}

function testExplainPathCliJsonGoldenOutput() {
  const root = makeFixtureRoot();
  try {
    const script = path.join(__dirname, "audit-private-data.js");
    const cases = [
      {
        path: "groups/sandbox-123456789/README.md",
        scanned: true,
        reasonType: null,
        reasonValue: null
      },
      {
        path: "groups/sandbox-123456789/" + "memory/" + "cha" + "t-2026-05-24.jsonl",
        scanned: false,
        reasonType: "publish_exclude_path_pattern",
        reasonValue: /memory\|members\|local_files\|files/
      },
      {
        path: "groups/sandbox-123456789/" + "members/" + "100000001.md",
        scanned: false,
        reasonType: "publish_exclude_path_pattern",
        reasonValue: /memory\|members\|local_files\|files/
      },
      {
        path: "groups/sandbox-123456789/local_files/upload.txt",
        scanned: false,
        reasonType: "publish_exclude_path_pattern",
        reasonValue: /memory\|members\|local_files\|files/
      },
      {
        path: "groups/sandbox-123456789/files/upload.txt",
        scanned: false,
        reasonType: "publish_exclude_path_pattern",
        reasonValue: /memory\|members\|local_files\|files/
      },
      {
        path: "users/" + "100000001/README.md",
        scanned: false,
        reasonType: "publish_exclude_dir",
        reasonValue: /^users$/
      },
      {
        path: "configs/.cc-connect.napcat.local.toml.lock",
        scanned: false,
        reasonType: "publish_exclude_file_name_pattern",
        reasonValue: /local.*toml.*lock/
      },
      {
        path: "configs/cc-connect.napcat.server.example.toml",
        scanned: true,
        reasonType: null,
        reasonValue: null
      }
    ];
    for (const item of cases) {
      const output = JSON.parse(assertCliSucceeds(script, [
        "--root", root,
        "--scope", "Publish",
        "--explain-path", item.path,
        "--json"
      ]).stdout);
      assert.strictEqual(output.scope, "Publish");
      assert.strictEqual(output.path, item.path);
      assert.strictEqual(output.is_directory, false);
      assert.strictEqual(output.scanned, item.scanned, `${item.path} scanned mismatch`);
      assert.strictEqual(output.excluded, !item.scanned, `${item.path} excluded mismatch`);
      if (item.reasonType === null) {
        assert.strictEqual(output.reason, null, `${item.path} reason mismatch`);
      } else {
        assert.strictEqual(output.reason.type, item.reasonType, `${item.path} reason type mismatch`);
        assert.match(output.reason.value, item.reasonValue, `${item.path} reason value mismatch`);
      }
    }
  } finally {
    removeFixtureRoot(root);
  }
}

function testExplainPathCliFileDirectoryJsonGoldenOutput() {
  const root = makeFixtureRoot();
  try {
    const script = path.join(__dirname, "audit-private-data.js");
    const cases = [
      {
        args: ["--explain-file"],
        path: "configs/.cc-connect.napcat.local.toml.lock",
        isDirectory: false,
        scanned: false,
        reasonType: "publish_exclude_file_name_pattern",
        reasonValue: "\\.local\\.toml\\.lock$"
      },
      {
        args: ["--explain-file"],
        path: "configs/cc-connect.napcat.server.example.toml",
        isDirectory: false,
        scanned: true,
        reasonType: null
      },
      {
        args: ["--explain-directory"],
        path: "users/" + "100000001",
        isDirectory: true,
        scanned: false,
        reasonType: "publish_exclude_dir",
        reasonValue: "users"
      },
      {
        args: ["--explain-directory"],
        path: "groups/sandbox-123456789/" + "memory",
        isDirectory: true,
        scanned: false,
        reasonType: "publish_exclude_path_pattern",
        reasonValue: "^groups\\/[^/]+\\/(memory|members|local_files|files|\\.cc-connect)(\\/|$)"
      },
      {
        args: ["--explain-directory"],
        path: "groups/sandbox-123456789/members",
        isDirectory: true,
        scanned: false,
        reasonType: "publish_exclude_path_pattern",
        reasonValue: "^groups\\/[^/]+\\/(memory|members|local_files|files|\\.cc-connect)(\\/|$)"
      },
      {
        args: ["--explain-directory"],
        path: "groups/sandbox-123456789",
        isDirectory: true,
        scanned: true,
        reasonType: null
      }
    ];
    for (const item of cases) {
      const output = JSON.parse(assertCliSucceeds(script, [
        "--root", root,
        "--scope", "Publish",
        "--explain-path", item.path,
        ...item.args,
        "--json"
      ]).stdout);
      assert.strictEqual(output.scope, "Publish");
      assert.strictEqual(output.path, item.path);
      assert.strictEqual(output.is_directory, item.isDirectory, `${item.path} is_directory mismatch`);
      assert.strictEqual(output.scanned, item.scanned, `${item.path} scanned mismatch`);
      assert.strictEqual(output.excluded, !item.scanned, `${item.path} excluded mismatch`);
      assert.strictEqual(output.reason ? output.reason.type : null, item.reasonType, `${item.path} reason type mismatch`);
      if (item.reasonValue !== undefined) {
        assert.strictEqual(output.reason ? output.reason.value : null, item.reasonValue, `${item.path} reason value mismatch`);
      }
    }
  } finally {
    removeFixtureRoot(root);
  }
}

function testExplainCanaryCliJsonOutput() {
  const script = path.join(__dirname, "check-private-data-explain-canaries.js");
  const output = JSON.parse(assertCliSucceeds(script, ["--json"]).stdout);
  assert.strictEqual(output.ok, true);
  assert.strictEqual(output.checked, 27);
  assert.strictEqual(output.scope, null);
  assert.strictEqual(output.rows.length, 27);
  const publishRows = output.rows.filter((item) => item.scope === "Publish");
  const liveRows = output.rows.filter((item) => item.scope === "Live");
  assert.strictEqual(publishRows.length, 17);
  assert.strictEqual(liveRows.length, 10);
  const expectedRows = [
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
      path: "users/" + "100000001/README.md",
      scanned: false,
      reasonType: "publish_exclude_dir",
      reasonValue: "users"
    },
    {
      scope: "Publish",
      path: "users/" + "100000001",
      isDirectory: true,
      scanned: false,
      reasonType: "publish_exclude_dir",
      reasonValue: "users"
    },
    {
      scope: "Publish",
      path: "groups/sandbox-123456789/README.md",
      scanned: true,
      reasonType: null
    },
    {
      scope: "Publish",
      path: "groups/sandbox-123456789/AGENTS.md",
      scanned: true,
      reasonType: null
    },
    {
      scope: "Publish",
      path: "groups/sandbox-123456789/scripts/tool.js",
      scanned: true,
      reasonType: null
    },
    {
      scope: "Publish",
      path: "groups/sandbox-123456789",
      isDirectory: true,
      scanned: true,
      reasonType: null
    },
    {
      scope: "Publish",
      path: "groups/sandbox-123456789/" + "memory/" + "cha" + "t-2026-05-24.jsonl",
      scanned: false,
      reasonType: "publish_exclude_path_pattern",
      reasonValue: "^groups\\/[^/]+\\/(memory|members|local_files|files|\\.cc-connect)(\\/|$)"
    },
    {
      scope: "Publish",
      path: "groups/sandbox-123456789/" + "memory",
      isDirectory: true,
      scanned: false,
      reasonType: "publish_exclude_path_pattern",
      reasonValue: "^groups\\/[^/]+\\/(memory|members|local_files|files|\\.cc-connect)(\\/|$)"
    },
    {
      scope: "Publish",
      path: "groups/sandbox-123456789/" + "members/" + "100000001.md",
      scanned: false,
      reasonType: "publish_exclude_path_pattern",
      reasonValue: "^groups\\/[^/]+\\/(memory|members|local_files|files|\\.cc-connect)(\\/|$)"
    },
    {
      scope: "Publish",
      path: "groups/sandbox-123456789/members",
      isDirectory: true,
      scanned: false,
      reasonType: "publish_exclude_path_pattern",
      reasonValue: "^groups\\/[^/]+\\/(memory|members|local_files|files|\\.cc-connect)(\\/|$)"
    },
    {
      scope: "Publish",
      path: "groups/sandbox-123456789/local_files/upload.txt",
      scanned: false,
      reasonType: "publish_exclude_path_pattern",
      reasonValue: "^groups\\/[^/]+\\/(memory|members|local_files|files|\\.cc-connect)(\\/|$)"
    },
    {
      scope: "Publish",
      path: "groups/sandbox-123456789/local_files",
      isDirectory: true,
      scanned: false,
      reasonType: "publish_exclude_path_pattern",
      reasonValue: "^groups\\/[^/]+\\/(memory|members|local_files|files|\\.cc-connect)(\\/|$)"
    },
    {
      scope: "Publish",
      path: "groups/sandbox-123456789/files/upload.txt",
      scanned: false,
      reasonType: "publish_exclude_path_pattern",
      reasonValue: "^groups\\/[^/]+\\/(memory|members|local_files|files|\\.cc-connect)(\\/|$)"
    },
    {
      scope: "Publish",
      path: "groups/sandbox-123456789/files",
      isDirectory: true,
      scanned: false,
      reasonType: "publish_exclude_path_pattern",
      reasonValue: "^groups\\/[^/]+\\/(memory|members|local_files|files|\\.cc-connect)(\\/|$)"
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
      path: "users/" + "100000001/README.md",
      scanned: true,
      reasonType: null
    },
    {
      scope: "Live",
      path: "users/" + "100000001",
      isDirectory: true,
      scanned: true,
      reasonType: null
    },
    {
      scope: "Live",
      path: "groups/sandbox-123456789/" + "memory/" + "cha" + "t-2026-05-24.jsonl",
      scanned: true,
      reasonType: null
    },
    {
      scope: "Live",
      path: "groups/sandbox-123456789/" + "memory",
      isDirectory: true,
      scanned: true,
      reasonType: null
    },
    {
      scope: "Live",
      path: "groups/sandbox-123456789/local_files/upload.txt",
      scanned: true,
      reasonType: null
    },
    {
      scope: "Live",
      path: "groups/sandbox-123456789/local_files",
      isDirectory: true,
      scanned: true,
      reasonType: null
    },
    {
      scope: "Live",
      path: "groups/sandbox-123456789/files/upload.txt",
      scanned: true,
      reasonType: null
    },
    {
      scope: "Live",
      path: "groups/sandbox-123456789/files",
      isDirectory: true,
      scanned: true,
      reasonType: null
    }
  ];
  assert.deepStrictEqual(
    output.rows.map((item) => `${item.scope}:${item.path}`),
    expectedRows.map((item) => `${item.scope}:${item.path}`)
  );
  for (const row of expectedRows) {
    assertCanaryRow(output.rows, row);
  }
  assertCliFails(script, ["--json", "--table"], /mutually exclusive/);
}

function testExplainCanaryCliTableOutput() {
  const script = path.join(__dirname, "check-private-data-explain-canaries.js");
  const output = assertCliSucceeds(script, ["--table"]).stdout;
  assert.match(output, /^scope\s+\|\spath\s+\|\sstatus\s+\|\sreason/m);
  assert.match(output, /Publish\s+\|\sgroups\/sandbox-123456789\/AGENTS\.md\s+\|\sscanned\s+\|\s-/);
  assert.match(output, /Publish\s+\|\sgroups\/sandbox-123456789\/memory\s+\|\sexcluded\s+\|\spublish_exclude_path_pattern:/);
  assert.match(output, /Live\s+\|\sgroups\/sandbox-123456789\/memory\s+\|\sscanned\s+\|\s-/);
  assert.match(output, /Publish\s+\|\susers\/100000001\s+\|\sexcluded\s+\|\spublish_exclude_dir:users/);
}

function testExplainCanaryCliScopeFilter() {
  const script = path.join(__dirname, "check-private-data-explain-canaries.js");
  const publish = JSON.parse(assertCliSucceeds(script, ["--json", "--scope", "Publish"]).stdout);
  assert.strictEqual(publish.ok, true);
  assert.strictEqual(publish.scope, "Publish");
  assert.strictEqual(publish.checked, 17);
  assert.strictEqual(publish.rows.length, 17);
  assert.ok(publish.rows.every((item) => item.scope === "Publish"));

  const live = JSON.parse(assertCliSucceeds(script, ["--json", "--scope=Live"]).stdout);
  assert.strictEqual(live.ok, true);
  assert.strictEqual(live.scope, "Live");
  assert.strictEqual(live.checked, 10);
  assert.strictEqual(live.rows.length, 10);
  assert.ok(live.rows.every((item) => item.scope === "Live"));

  const publishTable = assertCliSucceeds(script, ["--table", "--scope", "Publish"]).stdout;
  assert.match(publishTable, /Publish\s+\|\sgroups\/sandbox-123456789\/AGENTS\.md\s+\|\sscanned\s+\|\s-/);
  assert.doesNotMatch(publishTable, /Live\s+\|/);

  const liveTable = assertCliSucceeds(script, ["--table", "--scope=Live"]).stdout;
  assert.match(liveTable, /Live\s+\|\sgroups\/sandbox-123456789\/memory\s+\|\sscanned\s+\|\s-/);
  assert.doesNotMatch(liveTable, /Publish\s+\|/);

  assertCliFails(script, ["--scope"], /must be Publish or Live/);
  assertCliFails(script, ["--scope", "bad"], /must be Publish or Live/);
}

function writeLiveOnlyFiles(root) {
  fs.mkdirSync(path.join(root, "configs"), { recursive: true });
  fs.mkdirSync(path.join(root, "groups", "sandbox", "memory", "dreams"), { recursive: true });
  const napcatName = "Nap" + "Cat.json";
  const userPath = "users" + "/123456789";
  fs.writeFileSync(path.join(root, "configs", "cc-connect.napcat.local.toml"), `${napcatName}\n${userPath}\n`, "utf8");
  const memoryPath = "memory" + "/chat-2026-05-23.jsonl";
  const memberPath = "members" + "/123456789.md";
  fs.writeFileSync(path.join(root, "groups", "sandbox", "memory", "dreams", "chat-2026-05-23.jsonl"), `${memoryPath} ${memberPath}\n`, "utf8");
}

function makeFixtureRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "private-data-audit-"));
}

function makeRules(overrides = {}) {
  return {
    max_file_bytes: 2097152,
    common_exclude_dirs: [],
    publish_exclude_dirs: [],
    publish_exclude_file_names: [],
    publish_exclude_extensions: [],
    publish_exclude_path_patterns: [],
    publish_exclude_file_name_patterns: [],
    forbidden_file_names: [],
    patterns: [
      { name: "secret token", regex: "access[_-]?token\\s*[:=]\\s*[\"']?[A-Za-z0-9_.-]{16,}" },
      { name: "local config", regex: "NapCat\\.json" },
      { name: "runtime memory", regex: "memory[\\\\/].*chat-\\d{4}-\\d{2}-\\d{2}\\.jsonl" }
    ],
    allowed_findings: [],
    live_warning_types: [],
    ...overrides
  };
}

function removeFixtureRoot(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function writeFixtureFile(root, relative, content) {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

function hasGitignorePattern(gitignore, pattern) {
  return gitignore.split(/\r?\n/u).some((line) => line.trim() === pattern);
}

function gitCheckIgnore(root, paths) {
  try {
    return parseGitCheckIgnoreOutput(cp.execFileSync("git", ["check-ignore", "--no-index", "--stdin"], {
      cwd: root,
      input: `${paths.join("\n")}\n`,
      encoding: "utf8"
    }));
  } catch (err) {
    if (err.status === 1) {
      return parseGitCheckIgnoreOutput(err.stdout || "");
    }
    throw err;
  }
}

function parseGitCheckIgnoreOutput(output) {
  return new Set(String(output || "").split(/\r?\n/u).filter(Boolean));
}

function assertCliFails(script, args, pattern) {
  const result = cp.spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  assert.notStrictEqual(result.status, 0, `${args.join(" ")} should fail`);
  assert.match(`${result.stdout || ""}${result.stderr || ""}`, pattern);
}

function assertCliSucceeds(script, args) {
  const result = cp.spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  assert.strictEqual(result.status, 0, `${args.join(" ")} should succeed: ${result.stderr || result.stdout}`);
  return result;
}

function assertCanaryRow(rows, expected) {
  const row = rows.find((item) => item.scope === expected.scope && item.path === expected.path);
  assert.ok(row, `${expected.scope} ${expected.path} canary row missing`);
  assert.ok(Object.prototype.hasOwnProperty.call(row, "is_directory"), `${expected.scope} ${expected.path} is_directory field missing`);
  assert.strictEqual(Boolean(row.is_directory), Boolean(expected.isDirectory), `${expected.scope} ${expected.path} is_directory mismatch`);
  assert.strictEqual(row.scanned, expected.scanned, `${expected.scope} ${expected.path} scanned mismatch`);
  assert.strictEqual(row.excluded, !expected.scanned, `${expected.scope} ${expected.path} excluded mismatch`);
  if (expected.reasonType === null) {
    assert.strictEqual(row.reason, null, `${expected.scope} ${expected.path} reason mismatch`);
  } else {
    assert.strictEqual(row.reason.type, expected.reasonType, `${expected.scope} ${expected.path} reason type mismatch`);
    assert.strictEqual(row.reason.value, expected.reasonValue, `${expected.scope} ${expected.path} reason value mismatch`);
  }
}

testPublishIgnoresLiveOnlyFiles();
testLiveReportsRuntimeWarningsWithoutBlocking();
testLowercaseLiveScopeReportsRuntimeWarningsWithoutBlocking();
testPublishBlocksSourceTokens();
testRuleFilesDoNotSuppressTokens();
testAllowedFindingBudgetBlocksOveruse();
testRuleMetaRejectsSecretTokenAllowlist();
testRuleMetaRejectsBroadAllowlistPatterns();
testRuleMetaRejectsDuplicateAllowlistIDs();
testRuleMetaRejectsInvalidAllowlistIDs();
testRuleMetaRejectsInvalidBudgets();
testGitignoreCoversCriticalPrivateRuntimePaths();
testGitignoreBehaviorProtectsRuntimeWithoutHidingWorkspaceFiles();
testPublishScanKeepsGroupWorkspaceFilesVisible();
testDefaultPublishRulesKeepGroupWorkspaceFilesVisible();
testExplainPrivateDataPathUsesDefaultRules();
testExplainPrivateDataPathRejectsUnsafeInputs();
testExplainPathCliRejectsInvalidInputs();
testAuditCliRejectsMissingOptionValues();
testExplainPathCliGoldenOutput();
testExplainPathCliJsonGoldenOutput();
testExplainPathCliFileDirectoryJsonGoldenOutput();
testExplainCanaryCliJsonOutput();
testExplainCanaryCliTableOutput();
testExplainCanaryCliScopeFilter();

console.log("private-data audit checks ok");
