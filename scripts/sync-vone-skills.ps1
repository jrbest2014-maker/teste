$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SourceRoot = Join-Path $RepoRoot 'skills'
$ClaudeRoot = Join-Path $env:USERPROFILE '.claude\skills'
$CodexRoot = Join-Path $env:USERPROFILE '.codex\skills'
$BridgeSource = Join-Path $RepoRoot 'integrations\vone-master-credential-bridge.mjs'
$BridgeTarget = Join-Path $env:USERPROFILE 'NEXUS-WORK-NODE\vone-master-credential-bridge.mjs'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupRoot = Join-Path $env:USERPROFILE ".vone\skill-backups\$Stamp"
$Names = @(
  'vone-operator',
  'vone-engineering',
  'vone-continuity',
  'vone-capacity-zero-cost',
  'vone-release-gate',
  'vone-learning'
)

New-Item -ItemType Directory -Force -Path $ClaudeRoot,$CodexRoot,$BackupRoot | Out-Null

function Backup-IfExists([string]$Path,[string]$Runtime,[string]$Name) {
  if (Test-Path $Path) {
    $dst = Join-Path $BackupRoot (Join-Path $Runtime $Name)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Copy-Item $Path $dst -Recurse -Force
  }
}

function Copy-Skill([string]$Name,[string]$TargetRoot,[string]$Runtime) {
  $src = Join-Path $SourceRoot $Name
  if (!(Test-Path (Join-Path $src 'SKILL.md'))) { throw "Missing canonical skill: $Name" }
  $dst = Join-Path $TargetRoot $Name
  Backup-IfExists $dst $Runtime $Name
  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $dst | Out-Null

  if ($Runtime -eq 'claude') {
    Get-ChildItem $src -Force | Where-Object { $_.Name -ne 'agents' } | ForEach-Object {
      Copy-Item $_.FullName (Join-Path $dst $_.Name) -Recurse -Force
    }
  } else {
    Copy-Item (Join-Path $src '*') $dst -Recurse -Force
  }
}

if (!(Test-Path $BridgeSource)) { throw 'Missing canonical V-ONE credential bridge' }
Backup-IfExists $BridgeTarget 'bridge' 'vone-master-credential-bridge.mjs'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $BridgeTarget) | Out-Null
Copy-Item $BridgeSource $BridgeTarget -Force
$BridgeSourceHash = (Get-FileHash $BridgeSource -Algorithm SHA256).Hash
$BridgeTargetHash = (Get-FileHash $BridgeTarget -Algorithm SHA256).Hash
$BridgeMatch = ($BridgeSourceHash -eq $BridgeTargetHash)

$results = @()
foreach ($name in $Names) {
  Copy-Skill $name $ClaudeRoot 'claude'
  Copy-Skill $name $CodexRoot 'codex'

  $srcHash = (Get-FileHash (Join-Path $SourceRoot "$name\SKILL.md") -Algorithm SHA256).Hash
  $claudeHash = (Get-FileHash (Join-Path $ClaudeRoot "$name\SKILL.md") -Algorithm SHA256).Hash
  $codexHash = (Get-FileHash (Join-Path $CodexRoot "$name\SKILL.md") -Algorithm SHA256).Hash
  $results += [pscustomobject]@{
    skill = $name
    source_sha256 = $srcHash
    claude_match = ($srcHash -eq $claudeHash)
    codex_match = ($srcHash -eq $codexHash)
  }
}

$report = [ordered]@{
  registry = 'VONE_SKILL_REGISTRY_R1'
  synced_at = (Get-Date).ToUniversalTime().ToString('o')
  backup_root = $BackupRoot
  bridge = [ordered]@{ source_sha256 = $BridgeSourceHash; target_sha256 = $BridgeTargetHash; match = $BridgeMatch }
  skills = $results
  all_match = $BridgeMatch -and -not ($results | Where-Object { -not $_.claude_match -or -not $_.codex_match })
}
$ReportPath = Join-Path $env:USERPROFILE '.vone\company-release\vone-skill-sync-report.json'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ReportPath) | Out-Null
$report | ConvertTo-Json -Depth 6 | Set-Content $ReportPath -Encoding UTF8
$report | ConvertTo-Json -Depth 6 -Compress
