# V-ONE Hub / Workspace — Evidencias de release (2026-10-10)

## Identificacao
- Producao Cloudflare Workers: `vone-control-plane`.
- Deploy confirmado: `c3006a18-092f-4031-ac3f-3c12e5168ebf`, saida Wrangler 0.
- Repositorio: `jrbest2014-maker/teste`; branch isolada `chatgpt/worker-identity-r1`.
- Commit de codigo: `7384ab1d86657b73f7f90aa179afdb3dd78bac8d`. `main` preservada.

## Entregas implementadas
1. Corrigida referencia de encerramento em `queueTool` (`toolName`).
2. Respostas concluidas de `vone_hub_chat` ganham recibos idempotentes no historico D1, por dispositivo.
3. Endpoint autenticado `GET /api/mobile/hub/jobs` com escopo por dispositivo; `GET /api/mobile/hub/job` recupera resposta final do worker.
4. PWA retoma jobs apos recarregar, voltar do segundo plano ou reconectar; fila offline reconhece recibo assincrono sem reenviar tarefa concluida.
5. Paineis de Historico e Atividades conectados as fontes reais, com estado e worker.
6. CODE_REVIEW exibe acao explicita com confirmacao; resultados longos sao reavaliados e auditados pelo endpoint de auditoria.
7. Melhoria de legibilidade e safe area no mobile; paleta de cores preservada.
8. Service Worker atualizado para `vone-mobile-r6`.
9. Tarefa Windows `V-ONE Owned Executor` habilitada, com gatilho no login. Isso nao torna o desktop independente de energia, internet ou sessao do Windows.

## Verificacoes executadas
- `node --check`: `src/index.js`, `src/mobile-pwa.mjs`, `src/mobile-admin.mjs` — sem erros.
- JS inline gerado localmente e JS recebido do servidor publicado: `node --check` — PASS.
- Teste de broker: `P0_CONTRACT=PASS`, `PAID_BLOCKED_NEVER_ELIGIBLE=PASS`, `HOLD_WHEN_NO_FREE_ROUTE=PASS`.
- Edge Chromium controlado via DevTools, viewport 390x844: chat, ferramentas, historico, atividades, retorno ao chat, sem overflow horizontal, sem excecoes JS — PASS (em ambiente isolado e em producao sem sessao autenticada).
- Producao: `/vone-mobile`, `/vone-admin`, `/vone-mobile/sw.js`, `/api/mobile/status` — HTTP 200.
- Producao sem credencial: `/api/mobile/hub/jobs` e `/api/mobile/execution/audit` — HTTP 401.
- D1: 1 OWNER APPROVED e 2 TEAM APPROVED; permissoes TEAM full por default, revogaveis individualmente pelo OWNER.
- Heartbeat observado do Owned Executor: 1 segundo, `ollama_health=ONLINE`, modelo `v-one-coder:fast`, contrato `VONE_HUB_CHAT_R1` anunciado.
- Planejamento `CODE_REVIEW`: `ROUTE_SELECTED`, rota `local-ollama-vone-fallback` gratuita, sem despacho.
- Jobs reais preexistentes do V-ONE Hub: status `done` no D1, com resultado e worker identificados.

## Escopo nao certificado
- E2E de uma conta real do iPhone apos este deploy, incluindo polling autenticado, recuperacao do recibo e verificacao visual: ainda nao executado pelo testador. O teste de navegador foi anonimo.
- E2E protegido de alteracao de codigo, testes CI, checkpoint e evidence de uma nova revisao: ainda nao certificado nesta release.
- Jobs anteriores ao campo `device_id` (LEGACY_UNBOUND) nao sao vinculados automaticamente a uma conta; isso evita exposicao cruzada de conversas.
- MCPs de escrita gerais e editor VS Code completo continuam fora deste gate.

## Invariantes
- `PAID_BLOCKED` mantido; custo desconhecido = `HOLD`; saida fisica = `LOCKED`.
- Nenhum resultado foi marcado `PASS` sem evidencia do teste correspondente.
