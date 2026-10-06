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
2026-10-06) está empilhada em cima dessa linha.

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

```bash
git checkout chatgpt/local-model-protocol-adapter-r1   # ou claude/vone-session-checkpoint-fix-r1 para a correção de checkpoint
npm ci
npm test             # 13 arquivos, incluindo vone_local_control_plane_e2e (simulado, não é o Master real)
$env:VONE_WORKER_TOKEN = "..."   # ver seção "O Master" - não existe emissão self-service
npx ts-node src/server/vone_owned_worker_main.ts
```

## O Master (`vone-control-plane`) - fora deste repositório

O Master é um Cloudflare Worker separado. **O código-fonte dele não está em
nenhum repositório Git acessível** - só existe como snapshots em
`.zip`/pastas de backup no desktop do dono (`VONE-SECURE-BACKUPS`,
`VONE-BACKUPS`), nunca versionado em Git de verdade.

**Autenticação real (confirmada 2026-10-06 contra o Master ao vivo,
versão `2.4.6-native-validation-r1`):** um único segredo compartilhado,
comparado por hash, **não** um sistema de identidade por worker.
```js
const WORKER_TOKEN_SHA256 = 'f9b5f821c81e3d7c2058d04099b5f83968e101bbd0d1de42c732e72b7ea1219c';
const CLIENT_TOKEN_SHA256 = '74172c4ba4bc827ce26af5789ea234e32c74bec7cd97685fbb58677bb44969b7';
```
Esse par de hashes é idêntico em **todos** os snapshots de backup encontrados
(de `VONE-FCB-P0` até `VONE-MCP-NATIVE-R1`, 2026-09-22 a 2026-09-26) -
nunca rotacionou nessa linhagem, e bateu com o Master ao vivo quando
testado. O `WORKER_TOKEN_SHA256` bateu com o hash SHA-256 (conteúdo
trimado) do arquivo local
`VONE-SECURE-BACKUPS\VONE-FCB-P5-CLOSED-20260924-205830\.secrets\worker.token`
no desktop do dono - **nunca** peça pra alguém colar o valor desse token no
chat; compare hashes, não valores.

**`src/server/vone_worker_identity.ts`** (linha `chatgpt/*`,
`issueWorkerIdentity`/per-worker token hasheado em D1) é **código morto**:
nada no Master real o usa (o schema D1 real só tem `worker_status` e
`jobs`, sem tabela de identidade). Não gere tokens com ele esperando que o
Master os reconheça.

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
