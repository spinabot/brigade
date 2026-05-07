# Brigade Primitive #1 — final end-to-end smoke test.
#
# Designed to be the single command you run when you want a yes/no on
# whether the agent loop is healthy. Exercises every layer that has been
# individually proven during development:
#
#   PHASE 1 — Setup
#     1. Build dist/
#     2. Wipe ~/.brigade   (gated by -WipeState)
#     3. brigade onboard   (gated by -SkipOnboard)
#     4. Auth profile drop (env-ref, never persists secret)
#
#   PHASE 2 — Identity / bootstrap
#     5. Turn 1   — first-turn bootstrap nudge fires
#     6. Verify   — bootstrap-delivered marker present in JSONL
#     7. Turn 2   — nudge does NOT re-fire (marker count stays 1)
#
#   PHASE 3 — Persona pin + session continuity
#     8. Turn 3   — name a fact ("call this number ALBATROSS-7")
#     9. Turn 4   — recall the fact across turns
#
#   PHASE 4 — Tool dispatch (the gap that hit us in production)
#    10. Turn 5   — `read` tool: read package.json, return the version
#    11. Turn 6   — `bash` tool: shell echo
#    12. Turn 7   — `grep` tool: search for a known pattern
#
#   PHASE 5 — Slash commands
#    13. /model openrouter/openai/gpt-5.4-mini  (triple-segment route)
#    14. Verify   — sessions.json has the new modelId
#    15. Turn 8   — next turn served on the persisted override
#    16. /thinking low                           (no model call)
#    17. /reset                                  (forgets the session)
#
#   PHASE 6 — Post-reset cleanliness
#    18. Turn 9   — fresh session, no recall of ALBATROSS-7
#
#   PHASE 7 — Final-state inventory
#    19. Counts   — JSONL lines, marker count, log file size, etc.
#
# Usage:
#   $env:OPENROUTER_API_KEY = "sk-or-v1-..."
#   pwsh F:\Brigade\scripts\smoke-test.ps1                 # default flow
#   pwsh F:\Brigade\scripts\smoke-test.ps1 -WipeState      # cold start
#   pwsh F:\Brigade\scripts\smoke-test.ps1 -SkipBuild      # faster reruns
#   pwsh F:\Brigade\scripts\smoke-test.ps1 -SkipOnboard    # already set up
#   pwsh F:\Brigade\scripts\smoke-test.ps1 -Verbose        # echo each CLI call

param(
  [string]$Provider = "openrouter",
  [string]$Model = "openai/gpt-5.4",
  [string]$FallbackModel = "openai/gpt-5.4-mini",
  [string]$AgentId = "main",
  [switch]$WipeState,
  [switch]$SkipBuild,
  [switch]$SkipOnboard,
  [switch]$Verbose
)

$ErrorActionPreference = "Stop"

# ─── Output helpers ─────────────────────────────────────────────────────────
$ansi = $Host.UI.SupportsVirtualTerminal
function Print-Phase   { param([string]$Title) if ($ansi) { Write-Host "`n`e[1;36m─── $Title ───`e[0m" } else { Write-Host "`n--- $Title ---" } }
function Print-Section { param([string]$Title) if ($ansi) { Write-Host "`n`e[36m▸ $Title`e[0m" }       else { Write-Host "`n> $Title" } }
function Print-Pass    { param([string]$Msg)   if ($ansi) { Write-Host "  `e[32mPASS`e[0m  $Msg" }      else { Write-Host "  PASS  $Msg" } }
function Print-Fail    { param([string]$Msg)   if ($ansi) { Write-Host "  `e[31mFAIL`e[0m  $Msg" }      else { Write-Host "  FAIL  $Msg" } }
function Print-Info    { param([string]$Msg)   if ($ansi) { Write-Host "  `e[90m...`e[0m   $Msg" }      else { Write-Host "  ...   $Msg" } }

$repoRoot = Resolve-Path "$PSScriptRoot\.."
Set-Location $repoRoot
$brigadeStateDir = Join-Path $env:USERPROFILE ".brigade"

# Resolve env-var name for the chosen provider.
$envVarName = switch ($Provider) {
  "openrouter"     { "OPENROUTER_API_KEY" }
  "openai"         { "OPENAI_API_KEY" }
  "anthropic"      { "ANTHROPIC_API_KEY" }
  "google"         { "GOOGLE_API_KEY" }
  "groq"           { "GROQ_API_KEY" }
  default          { "$($Provider.ToUpper())_API_KEY" }
}
$envVarValue = [Environment]::GetEnvironmentVariable($envVarName, "Process")

# ─── PHASE 1: Setup ─────────────────────────────────────────────────────────
Print-Phase "PHASE 1 - Setup"
Write-Host "  Repo:      $repoRoot"
Write-Host "  Provider:  $Provider"
Write-Host "  Model:     $Model"
Write-Host "  Fallback:  $FallbackModel  (used by /model slash test)"
Write-Host "  AgentId:   $AgentId"
Write-Host "  EnvVar:    `$env:$envVarName  ($(if ($envVarValue) { 'set' } else { 'MISSING' }))"
Write-Host "  Node:      $((node --version) 2>$null)"

if (-not $envVarValue) {
  Print-Fail "`$env:$envVarName is not set. Set it first:"
  Write-Host "        `$env:$envVarName = `"<your-key>`""
  exit 1
}

if (-not $SkipBuild) {
  Print-Section "Build"
  npm run build
  if ($LASTEXITCODE -ne 0) { Print-Fail "Build failed; aborting."; exit 1 }
  Print-Pass "dist/ rebuilt"
}

if ($WipeState) {
  Print-Section "Wipe state"
  if (Test-Path $brigadeStateDir) {
    Remove-Item $brigadeStateDir -Recurse -Force -ErrorAction SilentlyContinue
    Print-Pass "removed $brigadeStateDir"
  } else { Print-Info "no state to wipe" }
}

if (-not $SkipOnboard) {
  Print-Section "Onboard"
  npm run brigade -- onboard --agent-id $AgentId
  if ($LASTEXITCODE -ne 0) { Print-Fail "onboard failed"; exit 1 }
  Print-Pass "onboard complete"
}

Print-Section "Auth profile"
$authDir = Join-Path $brigadeStateDir "agents\$AgentId\agent"
$authPath = Join-Path $authDir "auth-profiles.json"
New-Item -ItemType Directory -Path $authDir -Force | Out-Null
$authJson = @"
{ "version": 1, "profiles": { "$Provider`:default": { "provider": "$Provider", "alias": "default", "type": "api_key", "key": "`${$envVarName}" } } }
"@
$authJson | Set-Content -Path $authPath -Encoding utf8
Print-Pass "wrote $authPath (key is `${$envVarName}, not literal)"

# ─── Helper: run brigade agent CLI, capture stdout + stderr + exit ─────────
$results = New-Object System.Collections.Generic.List[psobject]
function Run-Scenario { param([string]$Name, [scriptblock]$Block)
  Print-Section $Name
  try {
    $r = & $Block
    if ($r -eq $true) { Print-Pass $Name; $results.Add(@{ name = $Name; ok = $true }) }
    else              { Print-Fail "$Name -- $r"; $results.Add(@{ name = $Name; ok = $false; reason = $r }) }
  } catch {
    Print-Fail "$Name -- exception: $($_.Exception.Message)"
    $results.Add(@{ name = $Name; ok = $false; reason = $_.Exception.Message })
  }
}

function Invoke-Brigade {
  param([string]$Message, [string]$ProviderOverride, [string]$ModelOverride)
  $stderrPath = New-TemporaryFile
  try {
    $p = if ($ProviderOverride) { $ProviderOverride } else { $Provider }
    $cmd = "npm run --silent brigade -- agent --agent-id $AgentId --provider $p"
    if ($ModelOverride -ne "") { $cmd += " --model `"$ModelOverride`"" }
    elseif ($null -eq $ModelOverride) { $cmd += " --model `"$Model`"" }
    # ($ModelOverride === "" → omit --model so persisted override applies)
    $cmd += " --message `"$($Message -replace '"', '\"')`""
    if ($Verbose) { Write-Host "  $cmd" -ForegroundColor DarkGray }
    $stdout = Invoke-Expression "$cmd 2> `"$stderrPath`""
    $exit = $LASTEXITCODE
    $stderrText = (Get-Content $stderrPath -Raw -ErrorAction SilentlyContinue) ?? ""
    return @{ stdout = ($stdout -join "`n"); stderr = $stderrText; exit = $exit }
  } finally {
    Remove-Item $stderrPath -Force -ErrorAction SilentlyContinue
  }
}

function Find-BootstrapMarker {
  $sessionsDir = Join-Path $brigadeStateDir "agents\$AgentId\sessions"
  if (-not (Test-Path $sessionsDir)) { return @() }
  Get-ChildItem $sessionsDir -Filter "*.jsonl" -ErrorAction SilentlyContinue |
    ForEach-Object { Get-Content $_.FullName -ErrorAction SilentlyContinue } |
    Select-String "brigade:bootstrap-context:delivered" -SimpleMatch
}

function Read-SessionStore {
  $p = Join-Path $brigadeStateDir "agents\$AgentId\sessions\sessions.json"
  if (-not (Test-Path $p)) { return $null }
  return (Get-Content $p -Raw | ConvertFrom-Json)
}

# ─── PHASE 2: Identity / bootstrap ──────────────────────────────────────────
Print-Phase "PHASE 2 - Identity / bootstrap"

$markerBefore = (Find-BootstrapMarker).Count
Run-Scenario "5. Turn 1 — first-turn bootstrap nudge fires" {
  $r = Invoke-Brigade -Message "hi"
  if ($r.exit -ne 0)                     { return "exit $($r.exit). stderr: $($r.stderr.Substring(0, [Math]::Min(200, $r.stderr.Length)))" }
  if ($r.stdout.Trim().Length -eq 0)     { return "empty reply" }
  if ($r.stderr -notmatch "first-turn")  { return "stderr did not show bootstrapPhase=first-turn" }
  Print-Info "reply: $($r.stdout.Trim().Substring(0, [Math]::Min(120, $r.stdout.Trim().Length)))..."
  return $true
}

Run-Scenario "6. Bootstrap-delivery marker present in JSONL" {
  $markers = Find-BootstrapMarker
  if (-not $markers -or $markers.Count -eq 0) { return "no bootstrap marker found" }
  if ($markers.Count -ne $markerBefore + 1)   { return "expected exactly 1 new marker, found $($markers.Count - $markerBefore)" }
  Print-Info "marker count: $($markers.Count)"
  return $true
}

Run-Scenario "7. Turn 2 — bootstrap nudge does NOT re-fire" {
  $r = Invoke-Brigade -Message "what should I call you?"
  if ($r.exit -ne 0)                          { return "exit $($r.exit)" }
  if ($r.stderr -notmatch "in-progress")      { return "stderr did not show bootstrapPhase=in-progress" }
  $count = (Find-BootstrapMarker).Count
  if ($count -ne 1)                            { return "expected 1 marker after turn 2, found $count" }
  Print-Info "reply: $($r.stdout.Trim().Substring(0, [Math]::Min(120, $r.stdout.Trim().Length)))..."
  return $true
}

# ─── PHASE 3: Persona pin + session continuity ──────────────────────────────
Print-Phase "PHASE 3 - Persona + continuity"

Run-Scenario "8. Turn 3 — name a fact" {
  $r = Invoke-Brigade -Message "Remember the codename: ALBATROSS-7. Reply only 'ok'."
  if ($r.exit -ne 0) { return "exit $($r.exit)" }
  Print-Info "ack: $($r.stdout.Trim())"
  return $true
}

Run-Scenario "9. Turn 4 — recall the fact (continuity proof)" {
  $r = Invoke-Brigade -Message "What was the codename I just gave you? Reply with only the codename."
  if ($r.exit -ne 0) { return "exit $($r.exit)" }
  Print-Info "recall: $($r.stdout.Trim())"
  if (-not $r.stdout.ToUpper().Contains("ALBATROSS-7")) {
    return "model did not recall ALBATROSS-7 — session continuity broken"
  }
  return $true
}

# ─── PHASE 4: Tool dispatch ─────────────────────────────────────────────────
Print-Phase "PHASE 4 - Tool dispatch"

Run-Scenario "10. Turn 5 — read tool: package.json version" {
  $r = Invoke-Brigade -Message "Read F:\Brigade\package.json and reply with ONLY the version field value, nothing else."
  if ($r.exit -ne 0) { return "exit $($r.exit)" }
  Print-Info "reply: $($r.stdout.Trim())"
  if (-not ($r.stdout -match "0\.\d+\.\d+")) {
    return "model did not return a semver — read tool may not have fired"
  }
  return $true
}

Run-Scenario "11. Turn 6 — bash tool: echo" {
  $r = Invoke-Brigade -Message "Use the bash tool to run: echo BRIGADE-SMOKE-OK. Reply with the exact output."
  if ($r.exit -ne 0) { return "exit $($r.exit)" }
  Print-Info "reply: $($r.stdout.Trim().Substring(0, [Math]::Min(120, $r.stdout.Trim().Length)))"
  if (-not $r.stdout.Contains("BRIGADE-SMOKE-OK")) {
    return "echo output not in reply — bash tool may not have fired"
  }
  return $true
}

Run-Scenario "12. Turn 7 — grep tool: search for a known pattern" {
  $r = Invoke-Brigade -Message "Use grep to search F:\Brigade\package.json for the pattern 'version'. Reply with the line you found, or 'NOT FOUND'."
  if ($r.exit -ne 0) { return "exit $($r.exit)" }
  Print-Info "reply: $($r.stdout.Trim().Substring(0, [Math]::Min(160, $r.stdout.Trim().Length)))"
  if (-not $r.stdout.Contains("version")) {
    return "no version line in reply — grep may not have fired"
  }
  return $true
}

# ─── PHASE 5: Slash commands ────────────────────────────────────────────────
Print-Phase "PHASE 5 - Slash commands"

Run-Scenario "13. /model openrouter/$FallbackModel (triple-segment)" {
  $r = Invoke-Brigade -Message "/model openrouter/$FallbackModel"
  if ($r.exit -ne 0)                             { return "exit $($r.exit): $($r.stderr)" }
  if ($r.stdout.Trim().Length -gt 0)             { return "slash command should NOT call the model, got stdout: $($r.stdout)" }
  if ($r.stderr -notmatch "switched to")         { return "no switch confirmation in stderr: $($r.stderr)" }
  return $true
}

Run-Scenario "14. sessions.json reflects the new modelId" {
  $store = Read-SessionStore
  if (-not $store) { return "sessions.json missing" }
  $entry = $store.sessions."agent:${AgentId}:main"
  if (-not $entry) { return "session entry missing" }
  if ($entry.modelId -ne $FallbackModel) {
    return "expected modelId=$FallbackModel, got $($entry.modelId)"
  }
  Print-Info "persisted modelId: $($entry.modelId)"
  return $true
}

Run-Scenario "15. Turn 8 — next turn uses the persisted override" {
  # Don't pass --model; runSingleTurn should pick it up from sessions.json.
  $r = Invoke-Brigade -Message "Reply with only the digit answer to 2+2." -ModelOverride ""
  if ($r.exit -ne 0)               { return "exit $($r.exit)" }
  if ($r.stderr -notmatch "model=$([regex]::Escape($FallbackModel))") {
    return "stderr did not show model=$FallbackModel — override didn't apply"
  }
  Print-Info "reply: $($r.stdout.Trim())"
  if (-not $r.stdout.Contains("4")) {
    return "model didn't answer 4 to 2+2 — turn may have failed"
  }
  return $true
}

Run-Scenario "16. /thinking low" {
  $r = Invoke-Brigade -Message "/thinking low"
  if ($r.exit -ne 0) { return "exit $($r.exit)" }
  if ($r.stderr -notmatch "level set to 'low'") {
    return "no thinking-level confirmation in stderr"
  }
  return $true
}

Run-Scenario "17. /reset" {
  $r = Invoke-Brigade -Message "/reset"
  if ($r.exit -ne 0) { return "exit $($r.exit)" }
  if ($r.stderr -notmatch "forgetting session") {
    return "no reset confirmation in stderr"
  }
  return $true
}

# ─── PHASE 6: Post-reset cleanliness ────────────────────────────────────────
Print-Phase "PHASE 6 - Post-reset"

Run-Scenario "18. Turn 9 — fresh session does NOT recall ALBATROSS-7" {
  $r = Invoke-Brigade -Message "Did I tell you a codename in this conversation? Reply only YES or NO."
  if ($r.exit -ne 0) { return "exit $($r.exit)" }
  Print-Info "reply: $($r.stdout.Trim())"
  if ($r.stdout.ToUpper().Contains("YES")) {
    return "model claims to remember ALBATROSS-7 — /reset did not clear the session"
  }
  return $true
}

# ─── PHASE 7: Final-state inventory ─────────────────────────────────────────
Print-Phase "PHASE 7 - Final-state inventory"

$sessionsDir = Join-Path $brigadeStateDir "agents\$AgentId\sessions"
$logsDir = Join-Path $brigadeStateDir "logs"

$jsonlFiles = Get-ChildItem $sessionsDir -Filter "*.jsonl" -ErrorAction SilentlyContinue
$totalJsonlLines = ($jsonlFiles | ForEach-Object { Get-Content $_.FullName | Measure-Object | Select-Object -ExpandProperty Count } | Measure-Object -Sum).Sum
$markerCount = (Find-BootstrapMarker).Count
$logFile = Get-ChildItem $logsDir -Filter "brigade-*.log" -ErrorAction SilentlyContinue | Select-Object -First 1
$logLines = if ($logFile) { (Get-Content $logFile.FullName | Measure-Object).Count } else { 0 }

Write-Host "  JSONL files            $($jsonlFiles.Count)"
Write-Host "  JSONL total lines      $totalJsonlLines"
Write-Host "  Bootstrap markers      $markerCount  (post-/reset there will be 1 from the original session)"
Write-Host "  Log file               $(if ($logFile) { $logFile.Name } else { '(none)' })"
Write-Host "  Log lines              $logLines"

# ─── Summary ────────────────────────────────────────────────────────────────
Print-Phase "Summary"
$pass = ($results | Where-Object { $_.ok }).Count
$total = $results.Count
Write-Host "  $pass / $total scenarios passed`n"
if ($pass -lt $total) {
  foreach ($r in $results | Where-Object { -not $_.ok }) {
    if ($ansi) { Write-Host "  `e[31mFAIL`e[0m  $($r.name): $($r.reason)" }
    else       { Write-Host "  FAIL  $($r.name): $($r.reason)" }
  }
  exit 1
}

if ($ansi) { Write-Host "`e[1;32mAll smoke checks passed. Primitive #1 is healthy end-to-end.`e[0m" }
else       { Write-Host "All smoke checks passed. Primitive #1 is healthy end-to-end." }
exit 0
