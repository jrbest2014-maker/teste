#!/usr/bin/env bash
# Gera/atualiza o selo criptográfico (.validated.sha256) dos caminhos que já
# passaram por validação estática + testes com evidência de mutação.
#
# Uso:
#   scripts/seal-validated.sh          # gera/atualiza o selo
#   scripts/seal-validated.sh --check  # verifica sem alterar (usado no hook e no CI)
#
# Qualquer alteração em um arquivo selado precisa de um novo ciclo de
# validação e de rodar este script de novo antes do commit.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

SEAL_FILE=".validated.sha256"

# Caminhos cobertos pelo selo. Mantenha em sincronia com
# .vscode/settings.json -> files.readonlyInclude.
PATTERNS=(
  'src/core/*.ts'
  'src/server/vone_executor.ts'
  'src/server/vone_model_router.ts'
)

mode="${1:-}"

tmpfile="$(mktemp)"
trap 'rm -f "$tmpfile"' EXIT

for pattern in "${PATTERNS[@]}"; do
  # shellcheck disable=SC2086
  git ls-files -z -- $pattern
done | sort -zu | xargs -0 -r sha256sum >> "$tmpfile"

sort -o "$tmpfile" "$tmpfile"

if [[ "$mode" == "--check" ]]; then
  if [[ ! -f "$SEAL_FILE" ]]; then
    echo "seal-validated: $SEAL_FILE não existe; rode sem --check para gerar" >&2
    exit 1
  fi
  if ! diff -u "$SEAL_FILE" "$tmpfile"; then
    echo "seal-validated: arquivo validado foi alterado sem revalidação" >&2
    exit 1
  fi
  echo "seal-validated: OK, selo íntegro"
else
  cp "$tmpfile" "$SEAL_FILE"
  echo "seal-validated: $SEAL_FILE atualizado ($(wc -l < "$SEAL_FILE") arquivo(s))"
fi
