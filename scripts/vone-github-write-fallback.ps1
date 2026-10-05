param(
  [Parameter(Mandatory = $true)][string]$RepositoryFullName,
  [Parameter(Mandatory = $true)][string]$CandidateBranch,
  [Parameter(Mandatory = $true)][string]$BaseRef,
  [string]$WorkingDirectory = (Get-Location).Path,
  [switch]$ResumeExisting
)

$ErrorActionPreference = 'Stop'
$ProtectedBranches = @('main','master','production','prod','release')

function Fail([string]$Reason) {
  Write-Error $Reason
  exit 1
}

if ($ProtectedBranches -contains $CandidateBranch.ToLowerInvariant()) {
  Fail "PROTECTED_BRANCH_REFUSED:$CandidateBranch"
}
if (-not ($CandidateBranch -like 'chatgpt/*' -or $CandidateBranch -like 'candidate/*')) {
  Fail "NON_CANDIDATE_BRANCH_REFUSED:$CandidateBranch"
}
if (-not (Test-Path $WorkingDirectory)) {
  Fail "WORKDIR_NOT_FOUND:$WorkingDirectory"
}

Set-Location $WorkingDirectory

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Fail 'GIT_NOT_AVAILABLE'
}
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  Fail 'GH_NOT_AVAILABLE'
}

$dirty = git status --porcelain
if ($LASTEXITCODE -ne 0) { Fail 'NOT_A_GIT_REPOSITORY' }
if ($dirty) { Fail 'WORKTREE_NOT_CLEAN' }

$auth = gh auth status 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { Fail 'GH_AUTH_NOT_READY' }
if ($auth -notmatch 'Logged in to github.com') { Fail 'GH_AUTH_GITHUB_COM_MISSING' }

$origin = (git remote get-url origin).Trim()
$expectedHttps = "https://github.com/$RepositoryFullName.git"
$expectedSsh = "git@github.com:$RepositoryFullName.git"
if ($origin -ne $expectedHttps -and $origin -ne $expectedSsh) {
  Fail "REMOTE_MISMATCH:$origin"
}

git fetch origin --prune
if ($LASTEXITCODE -ne 0) { Fail 'FETCH_FAILED' }

git rev-parse --verify "$BaseRef^{commit}" *> $null
if ($LASTEXITCODE -ne 0) { Fail "BASE_REF_NOT_FOUND:$BaseRef" }

$changedPaths = @(git diff --name-only "$BaseRef..HEAD")
$workflowChanges = @($changedPaths | Where-Object { $_ -like '.github/workflows/*' })
if ($workflowChanges.Count -gt 0 -and $auth -notmatch "(^|[,' ])workflow([,' ]|$)") {
  Fail ('WORKFLOW_SCOPE_REQUIRED:' + ($workflowChanges -join ','))
}

$remoteExisting = git ls-remote --heads origin $CandidateBranch
if ($LASTEXITCODE -ne 0) { Fail 'REMOTE_BRANCH_LOOKUP_FAILED' }
git show-ref --verify --quiet "refs/heads/$CandidateBranch"
$localExisting = ($LASTEXITCODE -eq 0)

if ($remoteExisting -or $localExisting) {
  if (-not $ResumeExisting) {
    Fail "CANDIDATE_BRANCH_ALREADY_EXISTS:$CandidateBranch"
  }
  git switch $CandidateBranch
  if ($LASTEXITCODE -ne 0) { Fail 'LOCAL_BRANCH_SWITCH_FAILED' }
  git merge-base --is-ancestor $BaseRef HEAD
  if ($LASTEXITCODE -ne 0) { Fail 'EXISTING_BRANCH_BASE_MISMATCH' }
} else {
  git switch -c $CandidateBranch $BaseRef
  if ($LASTEXITCODE -ne 0) { Fail 'LOCAL_BRANCH_CREATE_FAILED' }
}

git push --set-upstream origin "HEAD:refs/heads/$CandidateBranch"
if ($LASTEXITCODE -ne 0) { Fail 'PUSH_FAILED' }

$localSha = (git rev-parse HEAD).Trim()
$remoteSha = ((git ls-remote --heads origin $CandidateBranch) -split "\s+")[0]
if (-not $remoteSha) { Fail 'REMOTE_SHA_NOT_FOUND' }
if ($localSha -ne $remoteSha) {
  Fail "REMOTE_SHA_MISMATCH local=$localSha remote=$remoteSha"
}

$result = [ordered]@{
  status = 'PASS'
  route = 'OWNED_GIT_PUSH_FALLBACK'
  repository = $RepositoryFullName
  branch = $CandidateBranch
  base = $BaseRef
  sha = $localSha
  production_mutated = $false
}
$result | ConvertTo-Json -Compress
