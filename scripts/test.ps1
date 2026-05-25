Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Step($Message) {
  Write-Host "==> $Message"
}

function Get-AuditTypeCounts($Items) {
  $counts = @{}
  foreach ($item in @($Items)) {
    $type = [string]$item.type
    if (-not $counts.ContainsKey($type)) {
      $counts[$type] = 0
    }
    $counts[$type] += 1
  }
  return $counts
}

function Assert-AuditEquivalent($Expected, $Actual, $Label) {
  if ([bool]$Expected.ok -ne [bool]$Actual.ok) {
    throw "$Label ok mismatch: node=$($Expected.ok) powershell=$($Actual.ok)"
  }
  if (@($Expected.blocking).Count -ne @($Actual.blocking).Count) {
    throw "$Label blocking count mismatch: node=$(@($Expected.blocking).Count) powershell=$(@($Actual.blocking).Count)"
  }
  if (@($Expected.warnings).Count -ne @($Actual.warnings).Count) {
    throw "$Label warning count mismatch: node=$(@($Expected.warnings).Count) powershell=$(@($Actual.warnings).Count)"
  }
  Assert-HashtableEqual (Get-AuditTypeCounts $Expected.blocking) (Get-AuditTypeCounts $Actual.blocking) "$Label blocking type counts"
  Assert-HashtableEqual (Get-AuditTypeCounts $Expected.warnings) (Get-AuditTypeCounts $Actual.warnings) "$Label warning type counts"
  Assert-StringListEqual (Get-AuditFindingSignatures $Expected.blocking) (Get-AuditFindingSignatures $Actual.blocking) "$Label blocking findings"
  Assert-StringListEqual (Get-AuditFindingSignatures $Expected.warnings) (Get-AuditFindingSignatures $Actual.warnings) "$Label warning findings"
  Assert-AllowedSummaryEquivalent $Expected.allowed_summary $Actual.allowed_summary "$Label allowed summary"
}

function Get-AuditFindingSignatures($Items) {
  $signatures = New-Object System.Collections.Generic.List[string]
  foreach ($item in @($Items)) {
    $file = ([string]$item.file) -replace '\\', '/'
    $line = [int]$item.line
    $type = [string]$item.type
    $severity = [string]$item.severity
    $allowedRule = ""
    if ($item.PSObject.Properties.Match("allowed_rule").Count -and $null -ne $item.allowed_rule) {
      $allowedRule = [string]$item.allowed_rule
    }
    $signatures.Add("$file|$line|$type|$severity|$allowedRule") | Out-Null
  }
  return @($signatures.ToArray() | Sort-Object)
}

function Assert-StringListEqual($Expected, $Actual, $Label) {
  $expectedItems = @($Expected)
  $actualItems = @($Actual)
  if ($expectedItems.Count -ne $actualItems.Count) {
    throw "$Label count mismatch: expected=$($expectedItems.Count) actual=$($actualItems.Count)"
  }
  for ($i = 0; $i -lt $expectedItems.Count; $i++) {
    if ($expectedItems[$i] -ne $actualItems[$i]) {
      throw "$Label mismatch at $i`: expected=$($expectedItems[$i]) actual=$($actualItems[$i])"
    }
  }
}

function Assert-HashtableEqual($Expected, $Actual, $Label) {
  $expectedKeys = @($Expected.Keys | Sort-Object)
  $actualKeys = @($Actual.Keys | Sort-Object)
  if (($expectedKeys -join "|") -ne ($actualKeys -join "|")) {
    throw "$Label key mismatch: expected=$($expectedKeys -join ',') actual=$($actualKeys -join ',')"
  }
  foreach ($key in $expectedKeys) {
    if ($Expected[$key] -ne $Actual[$key]) {
      throw "$Label mismatch for $key`: expected=$($Expected[$key]) actual=$($Actual[$key])"
    }
  }
}

function Invoke-NodeAuditExpectFailure($Arguments, $Reason) {
  $previousErrorActionPreference = $ErrorActionPreference
  $exitCode = $null
  try {
    $ErrorActionPreference = "Continue"
    & node @Arguments 2>$null | Out-Null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -eq 0) { throw "Node audit should reject $Reason" }
}

function Assert-AllowedSummaryEquivalent($Expected, $Actual, $Label) {
  $expectedById = @{}
  foreach ($item in @($Expected)) {
    $expectedById[[string]$item.id] = $item
  }
  $actualById = @{}
  foreach ($item in @($Actual)) {
    $actualById[[string]$item.id] = $item
  }
  Assert-HashtableEqual (Get-KeyPresenceMap $expectedById) (Get-KeyPresenceMap $actualById) "$Label ids"
  foreach ($id in $expectedById.Keys) {
    $expectedItem = $expectedById[$id]
    $actualItem = $actualById[$id]
    if ([string]$expectedItem.type -ne [string]$actualItem.type) {
      throw "$Label type mismatch for $id"
    }
    if ([int]$expectedItem.max_matches -ne [int]$actualItem.max_matches) {
      throw "$Label max_matches mismatch for $id"
    }
    if ([int]$expectedItem.matches -ne [int]$actualItem.matches) {
      throw "$Label matches mismatch for $id"
    }
    Assert-StringListEqual (Get-NormalizedPathList $expectedItem.files) (Get-NormalizedPathList $actualItem.files) "$Label files for $id"
  }
}

function Get-NormalizedPathList($Items) {
  $paths = New-Object System.Collections.Generic.List[string]
  foreach ($item in @($Items)) {
    $normalized = ([string]$item) -replace '\\', '/'
    $paths.Add($normalized) | Out-Null
  }
  return @($paths.ToArray() | Sort-Object)
}

function Get-KeyPresenceMap($Hashtable) {
  $map = @{}
  foreach ($key in $Hashtable.Keys) {
    $map[$key] = 1
  }
  return $map
}

Step "Go tests"
if (Get-Command go -ErrorAction SilentlyContinue) {
  go test ./...
  if ($LASTEXITCODE -ne 0) {
    throw "go test failed"
  }
} else {
  Write-Host "SKIP: go not found on PATH"
}

Step "Node syntax checks"
node --check scripts/onebot-group-proxy.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: onebot-group-proxy.js" }
node --check scripts/generate-image.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: generate-image.js" }
node --check scripts/render-qq-card-imagemagick.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: render-qq-card-imagemagick.js" }
node --check scripts/lib/rota-scheduler.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: rota-scheduler.js" }
node --check scripts/audit-private-data.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: audit-private-data.js" }
node --check scripts/monitor-opentoken-subscriptions.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: monitor-opentoken-subscriptions.js" }
node --check scripts/check-private-data-explain-canaries.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: check-private-data-explain-canaries.js" }
node --check scripts/explain-route-scope.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: explain-route-scope.js" }
node --check scripts/check-route-scope-canaries.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: check-route-scope-canaries.js" }
node --check scripts/check-memory-rule-canaries.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: check-memory-rule-canaries.js" }
node --check scripts/check-pending-memory-lifecycle-canaries.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: check-pending-memory-lifecycle-canaries.js" }
node --check scripts/check-pending-memory-classification-matrix.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: check-pending-memory-classification-matrix.js" }
node --check scripts/check-memory-rule-change-guard.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: check-memory-rule-change-guard.js" }
node --check scripts/check-low-restriction-command-canaries.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: check-low-restriction-command-canaries.js" }
node --check scripts/check-review-packet-canaries.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: check-review-packet-canaries.js" }
node --check scripts/check-review-packet-source-isolation-canaries.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: check-review-packet-source-isolation-canaries.js" }
node --check scripts/check-review-packet-actionable-canaries.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: check-review-packet-actionable-canaries.js" }
node --check scripts/check-review-packet-focus-canaries.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: check-review-packet-focus-canaries.js" }
node --check scripts/check-review-packet-fallback-safety-canaries.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: check-review-packet-fallback-safety-canaries.js" }
node --check scripts/check-review-packet-real-phrase-canaries.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: check-review-packet-real-phrase-canaries.js" }
node --check scripts/check-opentoken-subscription-monitor-canaries.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: check-opentoken-subscription-monitor-canaries.js" }
node --check scripts/test-onebot-proxy-units.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: test-onebot-proxy-units.js" }
node --check scripts/test-private-data-audit.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: test-private-data-audit.js" }

Step "OneBot proxy unit checks"
node scripts/test-onebot-proxy-units.js
if ($LASTEXITCODE -ne 0) { throw "onebot proxy unit checks failed" }

Step "Node private-data audit checks"
node scripts/test-private-data-audit.js
if ($LASTEXITCODE -ne 0) { throw "private-data audit checks failed" }
node scripts/check-private-data-explain-canaries.js
if ($LASTEXITCODE -ne 0) { throw "private-data explain canary checks failed" }
node scripts/check-route-scope-canaries.js
if ($LASTEXITCODE -ne 0) { throw "route scope canary checks failed" }
node scripts/check-memory-rule-canaries.js
if ($LASTEXITCODE -ne 0) { throw "memory rule canary checks failed" }
node scripts/check-pending-memory-lifecycle-canaries.js
if ($LASTEXITCODE -ne 0) { throw "pending memory lifecycle canary checks failed" }
node scripts/check-pending-memory-classification-matrix.js
if ($LASTEXITCODE -ne 0) { throw "pending memory classification matrix checks failed" }
node scripts/check-memory-rule-change-guard.js
if ($LASTEXITCODE -ne 0) { throw "memory rule change guard checks failed" }
node scripts/check-low-restriction-command-canaries.js
if ($LASTEXITCODE -ne 0) { throw "low-restriction command canary checks failed" }
node scripts/check-review-packet-canaries.js
if ($LASTEXITCODE -ne 0) { throw "review packet canary checks failed" }
node scripts/check-review-packet-source-isolation-canaries.js
if ($LASTEXITCODE -ne 0) { throw "review packet source isolation canary checks failed" }
node scripts/check-review-packet-actionable-canaries.js
if ($LASTEXITCODE -ne 0) { throw "review packet actionable canary checks failed" }
node scripts/check-review-packet-focus-canaries.js
if ($LASTEXITCODE -ne 0) { throw "review packet focus canary checks failed" }
node scripts/check-review-packet-fallback-safety-canaries.js
if ($LASTEXITCODE -ne 0) { throw "review packet fallback safety canary checks failed" }
node scripts/check-review-packet-real-phrase-canaries.js
if ($LASTEXITCODE -ne 0) { throw "review packet real phrase canary checks failed" }
node scripts/check-opentoken-subscription-monitor-canaries.js
if ($LASTEXITCODE -ne 0) { throw "opentoken subscription monitor canary checks failed" }
node scripts/audit-private-data.js --scope Publish
if ($LASTEXITCODE -ne 0) { throw "private-data publish audit failed" }

Step "PowerShell parser checks"
$psFiles = Get-ChildItem -Path scripts,deploy -Recurse -Filter *.ps1 -File
foreach ($file in $psFiles) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count -gt 0) {
    $errors | ForEach-Object { Write-Error "$($file.FullName): $($_.Message)" }
    throw "PowerShell parse failed: $($file.FullName)"
  }
}

Step "Private-data audit scope checks"
$auditScript = Join-Path $Root "scripts\audit-private-data.ps1"
$nodeAuditScript = Join-Path $Root "scripts\audit-private-data.js"
$auditTestRoot = Join-Path $Root ("tmp\audit-private-data-test-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $auditTestRoot | Out-Null
try {
  function Assert-BadRulesRejectedByBoth($Name, $Json, $Reason) {
    $rulesFile = Join-Path $auditTestRoot "$Name-rules.json"
    Set-Content -LiteralPath $rulesFile -Value $Json -Encoding UTF8
    Invoke-NodeAuditExpectFailure @($nodeAuditScript, "--root", $auditTestRoot, "--rules", $rulesFile, "--scope", "Publish", "--json") $Reason
    $psRejected = $false
    try {
      & $auditScript -Root $auditTestRoot -RulesPath $rulesFile -Scope Publish -Json | Out-Null
    } catch {
      $psRejected = $true
    }
    if (-not $psRejected) { throw "PowerShell audit should reject $Reason" }
  }

  New-Item -ItemType Directory -Force -Path (Join-Path $auditTestRoot "configs") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $auditTestRoot "groups\sandbox\memory\dreams") | Out-Null
  Set-Content -LiteralPath (Join-Path $auditTestRoot "README.md") -Value "QQ group 123456789 is routing metadata, not a secret." -Encoding UTF8
  $napcatName = ("Nap" + "Cat.json")
  $userPath = ("users" + "/123456789")
  Set-Content -LiteralPath (Join-Path $auditTestRoot "configs\cc-connect.napcat.local.toml") -Value "$napcatName`n$userPath" -Encoding UTF8
  $memoryPath = ("memory" + "/chat-2026-05-23.jsonl")
  $memberPath = ("members" + "/123456789.md")
  $dreamDir = Join-Path (Join-Path (Join-Path (Join-Path $auditTestRoot "groups") "sandbox") "memory") "dreams"
  Set-Content -LiteralPath (Join-Path $dreamDir "chat-2026-05-23.jsonl") -Value "$memoryPath $memberPath" -Encoding UTF8

  $publishJson = & $auditScript -Root $auditTestRoot -Scope Publish -Json
  if ($LASTEXITCODE -ne 0) { throw "Publish audit should ignore live-only files" }
  $publish = ($publishJson -join "`n") | ConvertFrom-Json
  if (-not $publish.ok) { throw "Publish audit returned ok=false for live-only files" }

  $liveJson = & $auditScript -Root $auditTestRoot -Scope Live -Json
  if ($LASTEXITCODE -ne 0) { throw "Live audit should report live-only files without blocking" }
  $live = ($liveJson -join "`n") | ConvertFrom-Json
  if (-not $live.ok) { throw "Live audit returned ok=false for live-only files" }
  if (@($live.warnings).Count -lt 2) { throw "Live audit did not report expected warnings" }

  $nodePublishJson = node $nodeAuditScript --root $auditTestRoot --scope Publish --json
  if ($LASTEXITCODE -ne 0) { throw "Node Publish audit should ignore live-only files" }
  $nodePublish = ($nodePublishJson -join "`n") | ConvertFrom-Json
  Assert-AuditEquivalent $nodePublish $publish "clean Publish audit"

  $nodeLiveJson = node $nodeAuditScript --root $auditTestRoot --scope Live --json
  if ($LASTEXITCODE -ne 0) { throw "Node Live audit should report live-only files without blocking" }
  $nodeLive = ($nodeLiveJson -join "`n") | ConvertFrom-Json
  Assert-AuditEquivalent $nodeLive $live "clean Live audit"

  $nodeLowercaseLiveJson = node $nodeAuditScript --root $auditTestRoot --scope live --json
  if ($LASTEXITCODE -ne 0) { throw "Node lowercase live audit should report live-only files without blocking" }
  $nodeLowercaseLive = ($nodeLowercaseLiveJson -join "`n") | ConvertFrom-Json
  if ([string]$nodeLowercaseLive.scope -ne "Live") { throw "Node lowercase live audit did not normalize scope" }
  if (-not $nodeLowercaseLive.ok) { throw "Node lowercase live audit returned ok=false for live-only files" }
  if (@($nodeLowercaseLive.blocking).Count -ne 0) { throw "Node lowercase live audit returned blocking findings" }
  if (-not @($nodeLowercaseLive.warnings | Where-Object { $_.type -eq "runtime memory" })) {
    throw "Node lowercase live audit did not report runtime memory as warning"
  }
  Assert-AuditEquivalent $nodeLive $nodeLowercaseLive "clean lowercase Live audit"

  $defaultRulesRoot = Join-Path $Root ("tmp\audit-private-data-default-rules-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $defaultRulesRoot | Out-Null
  try {
    $defaultVisibleFiles = @(
      "groups/sandbox-9876500001/AGENTS.md",
      "groups/sandbox-9876500001/README.md",
      "groups/sandbox-9876500001/scripts/tool.js"
    )
    $defaultExcludedFiles = @(
      ("users/" + "1234500001/README.md"),
      ("groups/sandbox-9876500001/" + "memory/" + "cha" + "t-2026-05-24.jsonl"),
      "groups/sandbox-9876500001/local_files/upload.txt",
      "groups/sandbox-9876500001/files/upload.txt"
    )
    $defaultTokenLine = ("access_" + "token = abcdefghijklmnop")
    foreach ($relative in @($defaultVisibleFiles + $defaultExcludedFiles)) {
      $full = Join-Path $defaultRulesRoot (($relative -replace '/', '\'))
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $full) | Out-Null
      Set-Content -LiteralPath $full -Value $defaultTokenLine -Encoding UTF8
    }
    $nodeDefaultJson = node $nodeAuditScript --root $defaultRulesRoot --scope Publish --json
    $nodeDefaultExit = $LASTEXITCODE
    if ($nodeDefaultExit -eq 0) { throw "Node default Publish audit should block visible group workspace tokens" }
    $nodeDefault = ($nodeDefaultJson -join "`n") | ConvertFrom-Json
    $psDefaultJson = & $auditScript -Root $defaultRulesRoot -Scope Publish -Json
    $psDefaultExit = $LASTEXITCODE
    if ($psDefaultExit -eq 0) { throw "PowerShell default Publish audit should block visible group workspace tokens" }
    $psDefault = ($psDefaultJson -join "`n") | ConvertFrom-Json
    Assert-AuditEquivalent $nodeDefault $psDefault "default Publish visible workspace audit"
    $expectedDefaultFiles = @($defaultVisibleFiles | Sort-Object)
    $nodeDefaultFiles = @($nodeDefault.blocking | Where-Object { $_.type -eq "secret token" } | ForEach-Object { ([string]$_.file) -replace '\\', '/' } | Sort-Object)
    Assert-StringListEqual $expectedDefaultFiles $nodeDefaultFiles "default Publish visible group files"
  } finally {
    $resolvedDefaultRulesRoot = [System.IO.Path]::GetFullPath($defaultRulesRoot)
    $resolvedTmpRoot = [System.IO.Path]::GetFullPath((Join-Path $Root "tmp"))
    if ($resolvedDefaultRulesRoot.StartsWith($resolvedTmpRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $defaultRulesRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  $tokenName = ("access_" + "token")
  $tokenValue = "abcdefghijklmnop"
  Set-Content -LiteralPath (Join-Path $auditTestRoot "source.js") -Value "const $tokenName = '$tokenValue';" -Encoding UTF8
  $nodeBlockedPublishJson = node $nodeAuditScript --root $auditTestRoot --scope Publish --json
  $nodeBlockedExit = $LASTEXITCODE
  if ($nodeBlockedExit -eq 0) { throw "Node Publish audit should block source tokens" }
  $nodeBlockedPublish = ($nodeBlockedPublishJson -join "`n") | ConvertFrom-Json
  $blockedPublishJson = & $auditScript -Root $auditTestRoot -Scope Publish -Json
  $blockedPublishExit = $LASTEXITCODE
  if ($blockedPublishExit -eq 0) { throw "Publish audit should block source tokens" }
  $blockedPublish = ($blockedPublishJson -join "`n") | ConvertFrom-Json
  Assert-AuditEquivalent $nodeBlockedPublish $blockedPublish "blocked Publish audit"
  Remove-Item -LiteralPath (Join-Path $auditTestRoot "source.js") -Force

  $selfRulesDir = Join-Path $auditTestRoot "configs"
  $selfRulesFile = Join-Path $selfRulesDir "private-data-audit-rules.json"
  $selfTokenName = ("access_" + "token")
  Set-Content -LiteralPath $selfRulesFile -Value @(
    ('"Nap' + 'Cat.json"'),
    "$selfTokenName = abcdefghijklmnop"
  ) -Encoding UTF8
  $nodeSelfJson = node $nodeAuditScript --root $auditTestRoot --scope Publish --json
  $nodeSelfExit = $LASTEXITCODE
  if ($nodeSelfExit -eq 0) { throw "Node Publish audit should block tokens in rule files" }
  $nodeSelf = ($nodeSelfJson -join "`n") | ConvertFrom-Json
  $selfJson = & $auditScript -Root $auditTestRoot -Scope Publish -Json
  $selfExit = $LASTEXITCODE
  if ($selfExit -eq 0) { throw "Publish audit should block tokens in rule files" }
  $self = ($selfJson -join "`n") | ConvertFrom-Json
  Assert-AuditEquivalent $nodeSelf $self "self rule token audit"
  if (-not @($self.blocking | Where-Object { $_.file -eq "configs\private-data-audit-rules.json" -and $_.type -eq "secret token" })) {
    throw "PowerShell audit did not prove rule-file token blocking"
  }

  $badRulesSecret = Join-Path $auditTestRoot "bad-secret-rules.json"
  Set-Content -LiteralPath $badRulesSecret -Value '{"allowed_findings":[{"id":"bad-secret-token","type":"secret token","max_matches":1,"path_patterns":["^configs/private-data-audit-rules\\.json$"]}]}' -Encoding UTF8
  Invoke-NodeAuditExpectFailure @($nodeAuditScript, "--root", $auditTestRoot, "--rules", $badRulesSecret, "--scope", "Publish", "--json") "secret token allowed_findings"
  $badSecretRejected = $false
  try {
    & $auditScript -Root $auditTestRoot -RulesPath $badRulesSecret -Scope Publish -Json | Out-Null
  } catch {
    $badSecretRejected = $true
  }
  if (-not $badSecretRejected) { throw "PowerShell audit should reject secret token allowed_findings" }

  $badRulesBroad = Join-Path $auditTestRoot "bad-broad-rules.json"
  Set-Content -LiteralPath $badRulesBroad -Value '{"allowed_findings":[{"id":"bad-broad-pattern","type":"local config","max_matches":1,"path_patterns":["^.*$"]}]}' -Encoding UTF8
  Invoke-NodeAuditExpectFailure @($nodeAuditScript, "--root", $auditTestRoot, "--rules", $badRulesBroad, "--scope", "Publish", "--json") "broad allowed_findings path patterns"
  $badBroadRejected = $false
  try {
    & $auditScript -Root $auditTestRoot -RulesPath $badRulesBroad -Scope Publish -Json | Out-Null
  } catch {
    $badBroadRejected = $true
  }
  if (-not $badBroadRejected) { throw "PowerShell audit should reject broad allowed_findings path patterns" }

  $badRulesDuplicate = Join-Path $auditTestRoot "bad-duplicate-rules.json"
  Set-Content -LiteralPath $badRulesDuplicate -Value '{"allowed_findings":[{"id":"duplicate","type":"local config","max_matches":1,"path_patterns":["^configs/private-data-audit-rules\\.json$"]},{"id":"duplicate","type":"runtime memory","max_matches":1,"path_patterns":["^configs/.*\\.example\\.toml$"]}]}' -Encoding UTF8
  Invoke-NodeAuditExpectFailure @($nodeAuditScript, "--root", $auditTestRoot, "--rules", $badRulesDuplicate, "--scope", "Publish", "--json") "duplicate allowed_findings ids"
  $badDuplicateRejected = $false
  try {
    & $auditScript -Root $auditTestRoot -RulesPath $badRulesDuplicate -Scope Publish -Json | Out-Null
  } catch {
    $badDuplicateRejected = $true
  }
  if (-not $badDuplicateRejected) { throw "PowerShell audit should reject duplicate allowed_findings ids" }

  $badRulesNullBudget = Join-Path $auditTestRoot "bad-null-budget-rules.json"
  Set-Content -LiteralPath $badRulesNullBudget -Value '{"allowed_findings":[{"id":"null-budget","type":"local config","max_matches":null,"path_patterns":["^configs/private-data-audit-rules\\.json$"]}]}' -Encoding UTF8
  Invoke-NodeAuditExpectFailure @($nodeAuditScript, "--root", $auditTestRoot, "--rules", $badRulesNullBudget, "--scope", "Publish", "--json") "null max_matches"
  $badNullBudgetRejected = $false
  try {
    & $auditScript -Root $auditTestRoot -RulesPath $badRulesNullBudget -Scope Publish -Json | Out-Null
  } catch {
    $badNullBudgetRejected = $true
  }
  if (-not $badNullBudgetRejected) { throw "PowerShell audit should reject null max_matches" }

  $badRuleCases = @(
    @{
      Name = "bad-blank-id"
      Reason = "blank allowed_findings id"
      Json = '{"allowed_findings":[{"id":"   ","type":"local config","max_matches":1,"path_patterns":["^configs/private-data-audit-rules\\.json$"]}]}'
    },
    @{
      Name = "bad-numeric-id"
      Reason = "numeric allowed_findings id"
      Json = '{"allowed_findings":[{"id":1,"type":"local config","max_matches":1,"path_patterns":["^configs/private-data-audit-rules\\.json$"]}]}'
    },
    @{
      Name = "bad-missing-budget"
      Reason = "missing max_matches"
      Json = '{"allowed_findings":[{"id":"missing-budget","type":"local config","path_patterns":["^configs/private-data-audit-rules\\.json$"]}]}'
    },
    @{
      Name = "bad-float-budget"
      Reason = "float max_matches"
      Json = '{"allowed_findings":[{"id":"float-budget","type":"local config","max_matches":1.5,"path_patterns":["^configs/private-data-audit-rules\\.json$"]}]}'
    },
    @{
      Name = "bad-blank-budget"
      Reason = "blank string max_matches"
      Json = '{"allowed_findings":[{"id":"blank-budget","type":"local config","max_matches":"","path_patterns":["^configs/private-data-audit-rules\\.json$"]}]}'
    },
    @{
      Name = "bad-boolean-budget"
      Reason = "boolean max_matches"
      Json = '{"allowed_findings":[{"id":"boolean-budget","type":"local config","max_matches":true,"path_patterns":["^configs/private-data-audit-rules\\.json$"]}]}'
    },
    @{
      Name = "bad-numeric-string-budget"
      Reason = "numeric string max_matches"
      Json = '{"allowed_findings":[{"id":"numeric-string-budget","type":"local config","max_matches":"1","path_patterns":["^configs/private-data-audit-rules\\.json$"]}]}'
    }
  )
  foreach ($case in $badRuleCases) {
    Assert-BadRulesRejectedByBoth $case.Name $case.Json $case.Reason
  }

  $budgetRoot = Join-Path $Root ("tmp\audit-private-data-budget-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path (Join-Path $budgetRoot "configs") | Out-Null
  Set-Content -LiteralPath (Join-Path $budgetRoot "configs\one.txt") -Value ("Nap" + "Cat.json") -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $budgetRoot "configs\two.txt") -Value ("Nap" + "Cat.json") -Encoding UTF8
  $budgetRules = Join-Path $budgetRoot "rules.json"
  Set-Content -LiteralPath $budgetRules -Value @'
{
  "max_file_bytes": 2097152,
  "common_exclude_dirs": [],
  "publish_exclude_dirs": [],
  "publish_exclude_file_names": [],
  "publish_exclude_extensions": [],
  "publish_exclude_path_patterns": [],
  "publish_exclude_file_name_patterns": [],
  "forbidden_file_names": [],
  "patterns": [
    { "name": "local config", "regex": "NapCat\\.json" }
  ],
  "allowed_findings": [
    { "id": "budget-local-config", "type": "local config", "max_matches": 1, "path_patterns": ["^configs/.*\\.txt$"] }
  ],
  "live_warning_types": []
}
'@ -Encoding UTF8
  try {
    $nodeBudgetJson = node $nodeAuditScript --root $budgetRoot --rules $budgetRules --scope Publish --json
    $nodeBudgetExit = $LASTEXITCODE
    if ($nodeBudgetExit -eq 0) { throw "Node audit should block allowed finding budget overuse" }
    $nodeBudget = ($nodeBudgetJson -join "`n") | ConvertFrom-Json
    $budgetJson = & $auditScript -Root $budgetRoot -RulesPath $budgetRules -Scope Publish -Json
    $budgetExit = $LASTEXITCODE
    if ($budgetExit -eq 0) { throw "PowerShell audit should block allowed finding budget overuse" }
    $budget = ($budgetJson -join "`n") | ConvertFrom-Json
    Assert-AuditEquivalent $nodeBudget $budget "allowed budget audit"
  } finally {
    $resolvedBudgetRoot = [System.IO.Path]::GetFullPath($budgetRoot)
    $resolvedTmpRoot = [System.IO.Path]::GetFullPath((Join-Path $Root "tmp"))
    if ($resolvedBudgetRoot.StartsWith($resolvedTmpRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $budgetRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
} finally {
  $resolvedAuditTestRoot = [System.IO.Path]::GetFullPath($auditTestRoot)
  $resolvedTmpRoot = [System.IO.Path]::GetFullPath((Join-Path $Root "tmp"))
  if ($resolvedAuditTestRoot.StartsWith($resolvedTmpRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $auditTestRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Step "Shell syntax checks"
$bashCommand = Get-Command bash -ErrorAction SilentlyContinue
if ($bashCommand -and $bashCommand.Source -notmatch "\\Windows\\system32\\bash\.exe$") {
  $shellFiles = Get-ChildItem -Path deploy -Recurse -Include *.sh -File
  foreach ($file in $shellFiles) {
    bash -n $file.FullName
    if ($LASTEXITCODE -ne 0) {
      throw "Shell syntax check failed: $($file.FullName)"
    }
  }
} else {
  Write-Host "SKIP: usable bash not found on PATH"
}

Step "Sensitive local-data scan"
$forbidden = @(
  ("sk-" + "qq-low"),
  ("sk-" + "feishu-high"),
  ("OPENAI_API_KEY=" + "sk-")
)
$scanFiles = Get-ChildItem -Recurse -File |
  Where-Object {
    $_.FullName -notmatch "\\\.git\\" -and
    $_.FullName -notmatch "\\\.cc-connect\\" -and
    $_.FullName -notmatch "\\node_modules\\" -and
    $_.FullName -notmatch "\\tools\\" -and
    $_.FullName -notmatch "\\backup\\" -and
    $_.FullName -notmatch "\\groups\\sandbox-" -and
    $_.FullName -notmatch "\\scripts\\run-.*\.cmd$" -and
    $_.Name -notmatch "\.local\.toml$" -and
    $_.Name -notmatch "\.log$" -and
    $_.Name -ne "chatbot-qq-qrcode.png"
  }
foreach ($needle in $forbidden) {
  $matches = $scanFiles | Select-String -SimpleMatch $needle
  if ($matches) {
    $matches | ForEach-Object { Write-Error "$($_.Path):$($_.LineNumber): contains forbidden local value '$needle'" }
    throw "Sensitive local-data scan failed"
  }
}

Step "Done"
