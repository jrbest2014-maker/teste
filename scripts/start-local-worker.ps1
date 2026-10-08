<#
.SYNOPSIS
  Sobe o worker de desktop do V-ONE (linha chatgpt/*) como motor padrão do
  V-ONE Studio.

.DESCRIPTION
  Falha fechado: cada pré-condição que faltar para o script e explica o que
  fazer, em vez de tentar "dar um jeito". Nunca imprime o valor do token -
  só compara o hash SHA-256 contra o documentado em AGENTS.md (seção
  "O Master"), do jeito que o próprio AGENTS.md pede: "compare hashes, não
  valores".

  Rode a partir da raiz do checkout em chatgpt/local-model-protocol-adapter-r1
  (é onde src/server/vone_owned_worker_main.ts existe - ver AGENTS.md,
  "Duas linhas de desenvolvimento").
#>

$ErrorActionPreference = "Stop"

function Fail([string]$msg) {
    Write-Host "[BLOQUEADO] $msg" -ForegroundColor Red
    exit 1
}

function Ok([string]$msg) {
    Write-Host "[OK] $msg" -ForegroundColor Green
}

# 1. Branch certa - o runtime do worker só existe na linha chatgpt/*.
if (-not (Test-Path "src/server/vone_owned_worker_main.ts")) {
    Fail (
        "src/server/vone_owned_worker_main.ts não existe neste checkout.`n" +
        "  git checkout chatgpt/local-model-protocol-adapter-r1`n" +
        "  npm ci`n" +
        "E rode este script de novo."
    )
}
Ok "Checkout tem o runtime do worker (linha chatgpt/*)."

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
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "npx"
$psi.Arguments = "ts-node src/server/vone_owned_worker_main.ts"
$psi.UseShellExecute = $false
$proc = [System.Diagnostics.Process]::Start($psi)
try {
    $proc.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal
    Ok "Prioridade do processo (PID $($proc.Id)) definida como BelowNormal."
} catch {
    Write-Host "[AVISO] Não consegui baixar a prioridade do processo - ele segue rodando em prioridade normal." -ForegroundColor Yellow
}
$proc.WaitForExit()
