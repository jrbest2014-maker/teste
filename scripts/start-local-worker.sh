#!/usr/bin/env bash
# Equivalente POSIX de scripts/start-local-worker.ps1 (Windows/PowerShell).
# Mesma disciplina: falha fechada em cada pré-condição, nunca pede nem
# imprime o valor do token (só compara hash contra o documentado em
# AGENTS.md, seção "O Master" - "compare hashes, não valores").
#
# Prioridade de CPU: "nice -n 19" invoca a chamada nativa do kernel POSIX
# (nice(2)/setpriority(2)) - o agendador do SO passa a tratar este processo
# como o último a receber ciclo de CPU quando há disputa, cedendo
# automaticamente pra qualquer outro app ativo (Codex incluso). Custo zero,
# sem rota paga, sem reabrir o problema de limite que motivou o worker
# local em primeiro lugar (PAID_BLOCKED=INVIOLABLE).
#
# Rode a partir da raiz do checkout em chatgpt/local-model-protocol-adapter-r1
# (é onde src/server/vone_owned_worker_main.ts existe - ver AGENTS.md,
# "Duas linhas de desenvolvimento").

set -euo pipefail

fail() {
    echo "[BLOQUEADO] $1" >&2
    exit 1
}

ok() {
    echo "[OK] $1"
}

# 1. Branch certa - o runtime do worker só existe na linha chatgpt/*.
if [[ ! -f "src/server/vone_owned_worker_main.ts" ]]; then
    fail "src/server/vone_owned_worker_main.ts não existe neste checkout.
  git checkout chatgpt/local-model-protocol-adapter-r1
  npm ci
E rode este script de novo."
fi
ok "Checkout tem o runtime do worker (linha chatgpt/*)."

# 2. Ollama de pé + modelo padrão instalado.
if ! models=$(ollama list 2>/dev/null); then
    fail "Ollama não respondeu. Confirme que está instalado e rodando (ollama serve)."
fi
if ! grep -q "v-one-coder:fast" <<<"$models"; then
    fail "Modelo 'v-one-coder:fast' não aparece em 'ollama list'.
Rode 'ollama list' e confirme o nome exato antes de prosseguir -
ver src/core/vone_hardware_sizing.ts (INSTALLED_OLLAMA_MODELS) para o inventário esperado."
fi
ok "Ollama de pé, v-one-coder:fast presente."

# 3. Token do worker - NUNCA cole o valor no chat. Confirme só por hash.
if [[ -z "${VONE_WORKER_TOKEN:-}" ]]; then
    fail 'VONE_WORKER_TOKEN não está definido neste shell.
Leia o valor do seu arquivo local de segredo e rode:
  export VONE_WORKER_TOKEN="$(cat <caminho> | tr -d "[:space:]")"
Nunca cole o valor do token aqui nem em chat nenhum - este script só
compara o hash contra o que está documentado em AGENTS.md.'
fi

if command -v sha256sum >/dev/null 2>&1; then
    hash=$(printf '%s' "$VONE_WORKER_TOKEN" | sha256sum | cut -d' ' -f1)
elif command -v shasum >/dev/null 2>&1; then
    hash=$(printf '%s' "$VONE_WORKER_TOKEN" | shasum -a 256 | cut -d' ' -f1)
else
    fail "Nem sha256sum nem shasum disponíveis neste sistema - não dá pra verificar o token com segurança."
fi

expected="f9b5f821c81e3d7c2058d04099b5f83968e101bbd0d1de42c732e72b7ea1219c"
if [[ "$hash" != "$expected" ]]; then
    fail "SHA-256 do VONE_WORKER_TOKEN atual não bate com WORKER_TOKEN_SHA256
documentado em AGENTS.md.
  calculado: $hash
  esperado:  $expected
Confira se pegou o token de worker certo (não o de client) antes de prosseguir."
fi
ok "Hash de VONE_WORKER_TOKEN confere com o documentado em AGENTS.md."

# 4. Sobe o worker com prioridade de CPU reduzida (nice -n 19 = mínima).
echo "[START] Subindo worker local (nice -n 19) como motor padrão do V-ONE Studio..."
exec nice -n 19 npx ts-node src/server/vone_owned_worker_main.ts
