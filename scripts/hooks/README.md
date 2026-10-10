# Hooks de desenvolvimento

## `pre-commit`

Bloqueia o commit se qualquer arquivo listado em `.validated.sha256`
(gerado por `scripts/seal-validated.sh`) tiver sido alterado sem passar por
um novo ciclo de validação.

### Instalação (uma vez por clone)

```bash
git config core.hooksPath scripts/hooks
```

### Fluxo ao alterar um arquivo selado

1. Faça a alteração.
2. Rode a validação de sempre (`npm test`, `tsc --noEmit`, revisão).
3. Atualize o selo: `bash scripts/seal-validated.sh`.
4. Comite — `.validated.sha256` atualizado entra no mesmo commit.

Sem o passo 3, o commit é bloqueado pelo hook (e pelo mesmo check no CI).
