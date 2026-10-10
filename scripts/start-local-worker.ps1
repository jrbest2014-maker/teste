<#
.SYNOPSIS
  Sobe o worker de desktop do V-ONE (main, unificado em 2026-10-10) como
  motor padrão do V-ONE Studio.

.DESCRIPTION
  Falha fechado: cada pré-condição que faltar para o script e explica o que
  fazer, em vez de tentar "dar um jeito". Nunca imprime o valor do token -
  só compara o hash SHA-256 contra o documentado em AGENTS.md (seção
  "O Master"), do jeito que o próprio AGENTS.md pede: "compare hashes, não
  valores".

  Rode a partir da raiz do checkout em main. As linhas chatgpt/* e núcleo
  foram unificadas em 2026-10-10 (ver AGENTS.md, "Linhas de desenvolvimento
  unificadas em 2026-10-10") - main tem src/server/vone_owned_worker_main.ts
  e está à frente dos branches chatgpt/* antigos (ex.: identidade/rotação de
  token de worker mais evoluída). Rodar a partir de um checkout antigo em
  chatgpt/local-model-protocol-adapter-r1 ou chatgpt/worker-identity-r1 sobe
  o worker com registro de identidade/capabilities desatualizado.
#>

$ErrorActionPreference = "Stop"

function Fail([string]$msg) {
    Write-Host "[BLOQUEADO] $msg" -ForegroundColor Red
    exit 1
}

function Ok([string]$msg) {
    Write-Host "[OK] $msg" -ForegroundColor Green
}

# 1. Branch certa - o runtime do worker está em main (unificado em 2026-10-10).
if (-not (Test-Path "src/server/vone_owned_worker_main.ts")) {
    Fail (
        "src/server/vone_owned_worker_main.ts não existe neste checkout.`n" +
        "  git checkout main`n" +
        "  git pull`n" +
        "  npm ci`n" +
        "E rode este script de novo."
    )
}
Ok "Checkout tem o runtime do worker (main, unificado)."

# 2. Ollama de pé + modelo padrão instalado.
try {
    $models = ollama list 2>$null
} catch {
    Fail "Ollama não respondeu. Confirme que está instalado e rodando (ollama serve)."
}
if (-not ($models -match "v-one-coder:fast")) {
    Fail (
        "Modelo 'v-one-coder:fast' não aparece em 'ollama list'.`n" +
        "Rode 'ollama list' e confirme o nome exato antes de prosseguir -`n" +
        "ver src/core/vone_hardware_sizing.ts (INSTALLED_OLLAMA_MODELS) para o inventário esperado."
    )
}
Ok "Ollama de pé, v-one-coder:fast presente."

# 3. Token do worker - NUNCA cole o valor no chat. Confirme só por hash.
if (-not $env:VONE_WORKER_TOKEN) {
    Fail (
        "`$env:VONE_WORKER_TOKEN não está definido nesta sessão do PowerShell.`n" +
        "Leia o valor do seu arquivo local de segredo (ex.: o caminho documentado`n" +
        "em AGENTS.md, VONE-SECURE-BACKUPS\...\.secrets\worker.token) e rode:`n" +
        "  `$env:VONE_WORKER_TOKEN = (Get-Content <caminho> -Raw).Trim()`n" +
        "Nunca cole o valor do token aqui nem em chat nenhum - este script só`n" +
        "compara o hash contra o que está documentado em AGENTS.md."
    )
}
$sha256 = [System.Security.Cryptography.SHA256]::Create()
$bytes = [System.Text.Encoding]::UTF8.GetBytes($env:VONE_WORKER_TOKEN)
$hash = ([System.BitConverter]::ToString($sha256.ComputeHash($bytes)) -replace '-', '').ToLower()
$expected = "f9b5f821c81e3d7c2058d04099b5f83968e101bbd0d1de42c732e72b7ea1219c"
if ($hash -ne $expected) {
    Fail (
        "SHA-256 do `$env:VONE_WORKER_TOKEN atual não bate com WORKER_TOKEN_SHA256`n" +
        "documentado em AGENTS.md.`n" +
        "  calculado: $hash`n" +
        "  esperado:  $expected`n" +
        "Confira se pegou o token de worker certo (não o de client) antes de prosseguir."
    )
}
Ok "Hash de `$env:VONE_WORKER_TOKEN confere com o documentado em AGENTS.md."

# 4. Sobe o worker com prioridade de CPU reduzida.
# Por quê: o worker não abre porta nenhuma (só chama 127.0.0.1:11434 e o
# Master por HTTPS - ver docs/v-one-studio-setup.md), então não disputa
# "porta" com nada. O que ele disputa é CPU, no seu hardware CPU-only
# (i7-8650U, 4C/8T). Em vez de mandar processamento pra nuvem paga pra
# "resolver" isso - o que violaria PAID_BLOCKED=INVIOLABLE e reabriria o
# problema de limite/custo que motivou o worker local em primeiro lugar -
# a correção real e de custo zero é baixar a prioridade do processo: o
# worker cede CPU de bom grado pra qualquer outro app ativo (Codex
# incluso), sem travar nada, sem gastar nada.
Write-Host "[START] Subindo worker local (prioridade BelowNormal) como motor padrão do V-ONE Studio..." -ForegroundColor Yellow
# Chama node.exe direto no bin.js do ts-node em vez de "npx" - no Windows,
# npx é npx.cmd, e Process.Start com UseShellExecute=$false só resolve
# .exe automaticamente (nunca .cmd/.bat), então "FileName=npx" sempre
# falha aqui com "O sistema não pode encontrar o arquivo especificado".
# node.exe é sempre um .exe de verdade - sem essa ambiguidade - e isso
# também evita uma camada extra de processo (cmd.exe -> node), então a
# prioridade abaixo cai direto no processo certo, sem corrida de condição.
if (-not (Test-Path "node_modules/ts-node/dist/bin.js")) {
    Fail "node_modules/ts-node/dist/bin.js não existe - rode 'npm ci' antes de subir o worker."
}
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "node"
$psi.Arguments = '"node_modules/ts-node/dist/bin.js" "src/server/vone_owned_worker_main.ts"'
$psi.WorkingDirectory = (Get-Location).Path
$psi.UseShellExecute = $false
$proc = [System.Diagnostics.Process]::Start($psi)
try {
    $proc.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal
    Ok "Prioridade do processo (PID $($proc.Id)) definida como BelowNormal."
} catch {
    Write-Host "[AVISO] Não consegui baixar a prioridade do processo - ele segue rodando em prioridade normal." -ForegroundColor Yellow
}
$proc.WaitForExit()
