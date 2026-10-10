# V-ONE — guia para agentes (Claude, Codex/GPT, Copilot, ou qualquer outro)

Leia isto inteiro antes de mudar qualquer coisa. Ele existe porque descobrir o
que está aqui, da primeira vez, levou horas de investigação real — não
precisa custar isso de novo pra próxima sessão.

## O que é o V-ONE

Um agente de codificação autônomo com:
- um **núcleo** (este repositório): sandbox de arquivos, interpretador de
  ferramentas, model router, executor, agent loop, catálogo de skills;
- um **worker próprio** (desktop do dono, Ollama local) que executa jobs;
- um **Master** (Cloudflare Worker `vone-control-plane`, **fora** deste
  repositório — ver seção "O Master" abaixo) que coordena tudo.

Regra de custo, inegociável: **`PAID_BLOCKED=INVIOLABLE`** — nenhuma rota
paga é selecionada automaticamente. Quando o custo é desconhecido,
**`UNKNOWN_COST=HOLD`**. Saída física real (qualquer coisa fora do sandbox)
é **`PHYSICAL_OUTPUT=LOCKED`** por padrão. **`NO_EVIDENCE_NO_PASS`**: nunca
declare algo como funcionando sem rodar e ver o resultado.

## Duas linhas de desenvolvimento ainda não unificadas — leia antes de mexer

Isso é a coisa mais importante deste documento.

**Linha "núcleo"** (`claude/v-one-yellow-ap1-juxog9` e o que vem dela, como
`claude/v-one-hard-skills-r1`, já mergeada aqui): `src/core` (agent loop,
hub, VFS sandbox, hydration engine base, patch/gcode/tool interpreters,
redação de segredo, catálogo de skills, dimensionamento de hardware) +
`src/server` (model router, executor, Workers AI caller). **Não tem** worker
de desktop nem cliente HTTP do Master.

**Linha `chatgpt/*`** (começa em `chatgpt/worker-identity-r1`, passa por
vários `chatgpt/*-r1`, chega em `chatgpt/local-model-protocol-adapter-r1`):
tem o worker de desktop de verdade (`vone_owned_worker_main.ts`), o cliente
HTTP do Master (`vone_master_worker_client.ts`), snapshot de capacidade,
failover de inferência, dual worker, Worker Identity R1 (código morto — ver
seção do Master). A PR #12 (`claude/vone-session-checkpoint-fix-r1`, a
correção de dupla execução, **validada contra o Master real** em
2026-10-06) **já está mergeada** em `chatgpt/local-model-protocol-adapter-r1`
(commit `ade9775`, confirmado 2026-10-08 via `git merge-base
--is-ancestor`). Checkout de 2026-10-08 em ambas: 14/14 suítes passando,
`tsc --noEmit` limpo, `npm audit` sem achados em dependências de produção
(as 4 vulnerabilidades altas reportadas são em `sharp`/`undici`,
transitivas via `wrangler`/`miniflare` — toolchain de dev do Cloudflare
Worker, não código deste repositório; corrigir exige upgrade quebrando o
`wrangler`, então não foi feito sem pedir antes).

As duas linhas têm módulos com o mesmo nome e propósito parecido
(`vone_executor.ts`, `vone_model_router.ts`) mas não são o mesmo arquivo e
não foram comparadas/reconciliadas. **Unificar as duas é uma decisão
arquitetural grande - não faça isso sem pedir confirmação explícita ao
dono do projeto primeiro.** Até lá, trate como dois sistemas relacionados,
não um só.

## Como rodar (linha núcleo - este checkout)

```bash
npm ci
npm test            # 10 suítes: core + skills + hardware
npx tsc --noEmit
npm run build
npm run export:skills   # regenera skills/*/SKILL.md a partir de src/core/vone_skill_catalog.ts
```

## Como rodar (linha `chatgpt/*` - worker de desktop)

Isso só funciona no desktop do dono (Ollama local), não aqui:

```powershell
git checkout chatgpt/local-model-protocol-adapter-r1   # ou claude/vone-session-checkpoint-fix-r1 para a correção de checkpoint
npm ci
npm test             # 14 arquivos, incluindo vone_local_control_plane_e2e (simulado, não é o Master real)
$env:VONE_WORKER_TOKEN = (Get-Content <caminho do seu worker.token> -Raw).Trim()   # ver seção "O Master" - não existe emissão self-service
scripts\start-local-worker.ps1   # ou scripts/start-local-worker.sh no Linux/macOS - falha fechado, prioridade BelowNormal/nice -n 19
```
Confirmado rodando de verdade no desktop do dono em 2026-10-10 (não
simulado): autentica, sobe, worker `DESKTOP_445339E_VONE_EXECUTOR_02`
(padrão atual - ver "O Master" abaixo pro porquê de não ser mais `_01`).

## O Master (`vone-control-plane`) - fora deste repositório

O Master é um Cloudflare Worker separado. **O código-fonte dele não está em
nenhum repositório Git acessível** - só existe como snapshots em
`.zip`/pastas de backup no desktop do dono (`VONE-SECURE-BACKUPS`,
`VONE-BACKUPS`), nunca versionado em Git de verdade.

**Autenticação real - ATUALIZADO 2026-10-10, confirmado contra o Master ao
vivo em produção, versão `2.4.7-worker-identity-r1-compat`.** A nota
anterior (06/10, versão `2.4.6`) dizia que o segredo compartilhado era o
único mecanismo e que `vone_worker_identity.ts` era código morto - **isso
mudou e foi diretamente verificado como incorreto agora.** O Master hoje
tem os dois modos coexistindo:

```js
const WORKER_TOKEN_SHA256 = 'f9b5f821c81e3d7c2058d04099b5f83968e101bbd0d1de42c732e72b7ea1219c';
const CLIENT_TOKEN_SHA256 = '74172c4ba4bc827ce26af5789ea234e32c74bec7cd97685fbb58677bb44969b7';
```
Esse par de hashes continua igual em todos os snapshots de backup
encontrados (`VONE-FCB-P0` até `VONE-MCP-NATIVE-R1`, 22-26/09) e segue
sendo aceito pelo Master ao vivo - **mas só pra `workerId` sem registro de
identidade**. Confirmado: `authorizeWorkerRequest()` (`vone_worker_identity.ts`)
procura um registro por `workerId` primeiro; se existe, exige o token
por-worker e **nega direto, sem cair pro segredo compartilhado** - não é
mais código morto, está ativo em produção. `DESKTOP_445339E_VONE_EXECUTOR_01`
tem um registro assim, `IDENTITY_R1`, **geração 2** (confirmado via
`npx wrangler d1 execute vone-control-plane --remote --command "SELECT
status_json FROM worker_status WHERE worker_id = '...'"` - esse é o jeito
real de inspecionar isso, direto do terminal, sem abrir o painel web). Por
design, o token de uma identidade só aparece uma vez, na emissão/rotação -
nunca fica recuperável depois (nem no D1: a tabela `worker_status` só tem
`worker_id, updated_at, version, status_json`, sem coluna de hash de
token - o que quer que guarde o hash da identidade não está nessa tabela;
não investigado onde). Por isso `_01` foi aposentado -
`vone_owned_worker_main.ts` usa `DESKTOP_445339E_VONE_EXECUTOR_02` como
padrão agora, que não tem registro de identidade e autentica pelo segredo
compartilhado normalmente. **Nunca peça pra alguém colar o valor desse
token no chat; compare hashes, não valores.**

**Nunca peça, gere nem manuseie credencial Cloudflare (API token, account
ID) nesta sessão.** Nunca cole token (worker ou Cloudflare) de volta no
chat - compare hashes locamente quando precisar verificar um valor.

## Gates e disciplina de evidência

- `PAID_BLOCKED=INVIOLABLE`, `UNKNOWN_COST=HOLD`, `PHYSICAL_OUTPUT=LOCKED`
  (ver `createDefaultGates()` em `src/server/vone_model_router.ts`).
- `NO_EVIDENCE_NO_PASS`: todo PASS citado em PR precisa de comando rodado +
  saída real, não "parece correto".
- Mudança estrutural (merge entre as duas linhas, deploy, redesenho de
  arquitetura, infraestrutura Cloudflare) pede confirmação explícita do
  dono antes de executar. Manutenção, correção de bug, teste e evidência
  não precisam dessa pausa.

## Skills (`skills/`)

Gerado, não editado à mão - edita `src/core/vone_skill_catalog.ts` e roda
`npm run export:skills`. Ver `skills/README.md`.

## Hardware do worker (desktop do dono)

Sem GPU dedicada (Intel UHD 620, inferência 100% CPU), Intel Core
i7-8650U (4C/8T), ~32GB RAM. Modelo padrão `v-one-coder:fast`
(~1,5B, medido: 15,88 tok/s geração). Ver
`src/core/vone_hardware_sizing.ts` (`describeOwnedDesktop()`,
`MEASURED_BENCHMARKS`).
