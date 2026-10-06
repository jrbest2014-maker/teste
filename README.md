# V-ONE

Núcleo de um agente de codificação autônomo: sandbox de arquivos isolado,
model router com gates de custo zero, executor com checkpoint por sessão,
catálogo de "hard skills" (código testado, não markdown solto).

Para arquitetura completa, como rodar, as duas linhas de desenvolvimento
deste projeto e a disciplina de segurança/evidência que ele segue, veja
**[AGENTS.md](./AGENTS.md)** — é o ponto de partida tanto para quem vai
desenvolver aqui quanto para qualquer agente de IA (Claude, Codex/GPT,
Copilot) trabalhando neste repositório.

## Início rápido

```bash
npm ci
npm test
```

## Gates

`PAID_BLOCKED=INVIOLABLE` · `UNKNOWN_COST=HOLD` · `PHYSICAL_OUTPUT=LOCKED` · `NO_EVIDENCE_NO_PASS`
