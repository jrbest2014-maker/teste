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

## Linhas de desenvolvimento unificadas em 2026-10-10

Isso era a coisa mais importante deste documento - até ser resolvido.

Até 2026-10-10 este repositório vivia em duas branches que nunca tinham
sido comparadas de verdade: "núcleo" (`claude/v-one-yellow-ap1-juxog9`,
tinha `src/core` + model router/executor/Workers AI caller, catálogo de
skills, dimensionamento de hardware - **sem** worker de desktop nem
cliente do Master) e `chatgpt/*` (`chatgpt/local-model-protocol-adapter-r1`,
tinha o worker de desktop de verdade, cliente HTTP do Master, snapshot de
capacidade, failover de inferência, Worker Identity R1 - **sem** skills
nem dimensionamento de hardware). O aviso antigo dizia "não foram
comparadas/reconciliadas" como se fosse um problema grande e arriscado.

**Diff real rodado antes de mexer em qualquer coisa** (`git diff` arquivo
por arquivo entre as duas, não suposição): dos 15 arquivos `.ts` em comum
entre as duas linhas, **13 eram byte-idênticos**, incluindo
`vone_executor.ts` (zero diferença). Só dois tinham divergência real, e as
duas eram melhorias legítimas só na linha `chatgpt/*` (vindas de rodar
contra modelo local de verdade, não teórico):
- `vone_model_router.ts`: `SELECTABLE_STATES` inclui `FREE_QUOTA_LOW`
  (núcleo parava de rotear cedo demais, antes da cota se esgotar de
  verdade - ainda dentro do zero-custo, só não desperdiça capacidade
  disponível).
- `vone_agent_loop.ts`: tolera modelos locais que embrulham JSON em cerca
  de markdown (` ```json ` ) e que usam `filePath` em vez de `path` - só
  normaliza nomes já na allow-list, não abre superfície nova nem contorna
  o sandbox (comentário original no código explica isso).

**O que foi unificado, na prática:** a linha `chatgpt/*` virou a base (já
tinha tudo do núcleo quase igual, mais a parte de worker/Master de
verdade); os arquivos exclusivos do núcleo (skills, hardware sizing,
V-ONE Studio - tema/scripts/doc, CI, `AGENTS.md`/`CLAUDE.md`/`README.md`)
foram trazidos por cima. `package.json` ganhou a união das duas listas de
teste (19 arquivos) mais os scripts `cf:*`/`export:skills`. Autorizado
explicitamente pelo dono em 2026-10-10 ("Sim unifica as duas linhas eu te
autorizo"), depois do diff real acima confirmar que o risco era muito
menor do que o aviso antigo sugeria. 19/19 testes passando, `tsc --noEmit`
limpo, `npm run build` limpo.

## Como rodar

```bash
npm ci
npm test            # 19 suítes: core + skills + hardware + worker/Master (vone_local_control_plane_e2e é simulado, não é o Master real)
npx tsc --noEmit
npm run build
npm run export:skills   # regenera skills/*/SKILL.md a partir de src/core/vone_skill_catalog.ts
```

Worker de desktop (Ollama local) - só funciona no desktop do dono, não
num checkout comum:

```powershell
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

## Bug real corrigido em 2026-10-10: `/vone-mobile` sem histórico de conversa

O chat do `/vone-mobile` às vezes respondia com saudação genérica
("Claro! Como posso ajudar você hoje?") ignorando completamente o que o
usuário tinha acabado de escrever - sobretudo em mensagens de continuação
("vamos nos aprofundar nesse assunto"). Causa raiz confirmada com dado
real, não suposição: em `handleMobileChat` (`src/index.js` do Worker
`vone-control-plane` - **não versionado em nenhum Git**, só existe no
editor ao vivo da Cloudflare), o job `vone_hub_chat` era montado só com a
última mensagem isolada (`prompt`), sem puxar nada de
`mobile_chat_messages`. Confirmado lendo `jobs.args` reais via
`npx wrangler d1 execute vone-control-plane --remote --command "SELECT id,
args FROM jobs WHERE tool_name='vone_hub_chat' ORDER BY created_at DESC
LIMIT 1;"` antes da correção - o `prompt` chegava pelado no modelo, por
isso respostas que dependiam de contexto anterior saíam genéricas.

Corrigido direto no Quick Edit da Cloudflare (não passa por este
repositório, porque o código do Master não está aqui): antes de montar o
job, busca as últimas 12 linhas de `mobile_chat_messages` daquele
`device_id`, remove a duplicata da mensagem recém-salva (comparando
conteúdo, já que `saveMobileMessage` já rodou antes nesse mesmo request) e
monta um prompt tipo `"Usuario: ...\nAssistente: ...\nUsuario: <mensagem
nova>"`. Confirmado funcionando com a mesma consulta D1 depois do deploy -
o `prompt` do job mais recente veio com o histórico inteiro formatado,
terminando na mensagem nova, sem duplicação. **Esse fix só existe no
Worker deployado agora - não tem commit em lugar nenhum, porque não existe
onde versionar o código do Master.**

Achados de bônus da mesma investigação, 2026-10-10:
- A etiqueta "Cloudflare D1" que aparece em toda mensagem no app mobile
  não indica rota nem falha - é só um rótulo fixo que o cliente cola em
  qualquer mensagem carregada via `syncCloudHistory()`/`/api/mobile/history`,
  sempre, nova ou antiga. Não é diagnóstico de nada, é inofensivo.
- `DESKTOP_445339E_VONE_EXECUTOR_01` (documentado acima como aposentado,
  token irrecuperável) segue processando jobs reais em produção agora -
  contradiz a narrativa de "aposentado" acima. Não investigado por quê; o
  worker configurado nesta sessão usa `_02`, então deve haver outra
  instância rodando em algum lugar com token válido pro `_01`. Em aberto.
- V-ONE e o "NEXUS" (arquivos de um projeto separado mencionados em sessão
  anterior) são do mesmo dono: a conta GitHub `juniorconectfy-max`
  (diferente de `jrbest2014-maker`, sem acesso desta sessão) tem o repo
  `refresh-fy-studio-5d` (provável fonte real do V-ONE Studio/IDE, com
  `.nexus-tools/vone-edge` - um Worker Cloudflare separado,
  `vone-control-plane-edge`, quase vazio, não é o Master) e `NEXUS-LIFE-OS`
  (produto totalmente diferente, gestão de frota/lavanderia, sem relação
  com o chat do V-ONE).

## Bug real confirmado em 2026-10-10 (não corrigido ainda): tokens OAuth não são vinculados a `/mcp` vs `/mcp-secure`

Um bug de resource-binding entre `/mcp-secure` e `/mcp` tinha sido
relatado por outro AI numa sessão anterior; nunca foi investigado por
falta de acesso ao código real do Master. Agora, com `src/index.js`
completo em mãos (visto nesta sessão via Cloudflare Quick Edit), confirmado:
é real, mas sem impacto prático hoje porque os dois endpoints fazem
exatamente a mesma coisa.

`handleOAuthToken` sempre devolve `resource: MCP_RESOURCE` (fixo,
`.../mcp`) na resposta do token, mesmo quando o fluxo de autorização foi
pro metadata de `/mcp-secure` (que corretamente anuncia
`MCP_SECURE_RESOURCE` em `/.well-known/oauth-protected-resource/mcp-secure`).
Pior: a tabela `oauth_tokens` nem tem coluna de `resource` -
`oauthBearerAuthorized()` só confere hash, revogação e expiração, nunca
qual recurso o token foi emitido pra acessar. Resultado: um token emitido
em qualquer fluxo funciona igual nos dois endpoints, sem checagem de
audience - o indicador de recurso (RFC 8707) é só decorativo.

Sem impacto de segurança **hoje** porque `/mcp` e `/mcp-secure` chamam o
mesmo `handleMcp()` com o mesmo `clientAuthorized()` - são idênticos em
comportamento, só diferem no `oauth_resource_metadata` reportado. Importa
se um dia os dois forem divergir (ex.: `/mcp-secure` com escopo mais
restrito) ou se algum cliente MCP depender de audience-binding real pra
segurança. Conserto ficaria em: adicionar coluna `resource` em
`oauth_tokens`, gravar o recurso pedido no `/oauth/authorize`, e checar
match em `oauthBearerAuthorized()` por endpoint - **não implementado**,
precisa confirmação explícita antes de mexer em código de autenticação em
produção (é mudança estrutural em segurança, não correção de bug comum).

## Gates e disciplina de evidência

- `PAID_BLOCKED=INVIOLABLE`, `UNKNOWN_COST=HOLD`, `PHYSICAL_OUTPUT=LOCKED`
  (ver `createDefaultGates()` em `src/server/vone_model_router.ts`).
- `NO_EVIDENCE_NO_PASS`: todo PASS citado em PR precisa de comando rodado +
  saída real, não "parece correto".
- Mudança estrutural (deploy, redesenho de arquitetura, infraestrutura
  Cloudflare) pede confirmação explícita do dono antes de executar -
  exemplo real: a unificação das duas linhas (seção acima) só aconteceu
  depois do dono autorizar explicitamente em 2026-10-10. Manutenção,
  correção de bug, teste e evidência não precisam dessa pausa.

## Skills (`skills/`)

Gerado, não editado à mão - edita `src/core/vone_skill_catalog.ts` e roda
`npm run export:skills`. Ver `skills/README.md`.

## Hardware do worker (desktop do dono)

Sem GPU dedicada (Intel UHD 620, inferência 100% CPU), Intel Core
i7-8650U (4C/8T), ~32GB RAM. Modelo padrão `v-one-coder:fast`
(~1,5B, medido: 15,88 tok/s geração). Ver
`src/core/vone_hardware_sizing.ts` (`describeOwnedDesktop()`,
`MEASURED_BENCHMARKS`).

## Decisão de roteamento em 2026-10-10: Cloudflare é o motor grande, desktop é só PRIVATE

Esse hardware não roda modelo grande (300B) de jeito nenhum - não é
configuração, é teto físico: só os pesos em 4-bit já passam de 150GB, a
máquina tem ~32GB de RAM total, sem GPU. Por isso `recommendDefaultModel()`
em `vone_hardware_sizing.ts` escolhe de propósito o **menor** modelo
instalado, não o maior.

Decisão explícita do dono: não precisa resolver isso no desktop. A rota
`cloudflare-workers-ai-primary` já serve `@cf/nvidia/nemotron-3-120b-a12b`
(perfil SMART/MAX) de graça, sempre ligada, sem depender do desktop estar
ligado (ver `yellow_status` no Master). O desktop/Ollama fica **só** para
tarefa `privacy_class: PRIVATE`, que o Cloudflare é bloqueado de receber de
propósito (`PRIVACY_MISMATCH` em `vone_capacity_snapshot.ts` quando a rota
não lista a classe de privacidade pedida em `allowed_privacy_classes`).
Quando o desktop está desligado, tarefa PRIVATE fica em `HOLD` (fila), não
falha nem vaza pra nuvem - é o comportamento correto sob
`PAID_BLOCKED=INVIOLABLE` (não dá pra "resolver" disponibilidade botando
servidor pago sempre ligado), não um bug.

**Causa raiz do `CAPABILITY_MISMATCH` na rota `client-desktop-vone-primary`
- CORRIGIDO EM 2026-10-10, a nota anterior (mesmo dia) estava errada.** A
nota anterior dizia que bastava reiniciar o worker a partir de um checkout
atualizado de `main` pra "re-registrar com o schema novo". **Testado ao
vivo: reiniciar não resolve.** Rodou `scripts/start-local-worker.ps1` a
partir de um checkout fresco de `main`, revalidado logo depois com
`vone_capacity_plan`/`yellow_status` reais - `CAPABILITY_MISMATCH` e
`auth_mode=LEGACY_COMPAT` continuaram idênticos a antes.

Causa raiz real, confirmada lendo código: `vone_dual_worker.ts:38` manda no
heartbeat `capabilities:['vone_executor_execute','vone_inference_execute']`
- mas o `yellow_status` ao vivo reporta de volta
`capabilities:['ask_yellow','yellow_route_preview','yellow_status']`,
**um valor completamente diferente do que o worker de fato envia.** Isso só
é possível se o Master substituir o `capabilities` reportado por um valor
próprio e fixo para workers autenticados via `auth_mode=LEGACY_COMPAT`, em
vez de refletir o heartbeat real - lógica que não está em nenhum
repositório Git, só existe no Quick Edit da Cloudflare (ver "O Master"
acima). Não é bug de código deste repositório, e não é "operacional" no
sentido de reiniciar processo - é comportamento do Master ao vivo que
precisa ser lido e corrigido lá (Quick Edit), não aqui. `vone_worker_identity.ts`
e o fluxo de identidade em `vone_owned_worker_main.ts` seguem corretos e
mais evoluídos que os branches `chatgpt/worker-identity-r1`/
`chatgpt/local-model-protocol-adapter-r1` (comparação real feita nesta
sessão, PR #15 fechada sem merge por isso - ver abaixo) - isso não mudou,
só a causa do `CAPABILITY_MISMATCH` em si, que não é esse código.

**PR #8** (branch `copilot/cloudflare-control-direct-r2`) também foi
resgatada: `src/cloudflare/vone_cloud_worker.ts` (o Worker que expõe
`cf:deploy`, `/health`, `/status`, `/delegate`, `/infer`, `/recovery`,
protocolo `VONE_DELEGATE_AUTHORITY_R2`) passa a verificar orçamento de
nêutrons e heartbeat fresco do worker próprio contra o `GET /api/status`
real do Master antes de liberar qualquer execução - nunca assume custo
zero sem confirmação (`MASTER_UNAVAILABLE`/`CLOUD_ZERO_COST_NOT_VERIFIED`/
`MASTER_STATUS_STALE` sempre caem em `HOLD`). `wrangler.jsonc` ganhou cron
de 5 em 5 minutos pra log de snapshot de recovery. **Ressalva**: o contrato
exato de campos do `/api/status` ao vivo (`cloudAiExecution`,
`cloudBudget.{remaining_neurons,hard_cap_neurons}`, `ownedHeartbeat`/
`owned_workers` etc.) não pôde ser reconferido nesta sessão - o host
`vone-control-plane.vone-technology.workers.dev` não é alcançável daqui
(proxy bloqueia CONNECT, DNS não resolve). O código já é defensivo (vários
nomes de campo alternativos, qualquer ambiguidade cai em `HOLD`), mas o
primeiro smoke test pós-deploy (`npm run cf:deploy` + bater em `/status`)
precisa confirmar que o Master real responde no formato esperado.

**PR #15** ("Implement V-ONE core agent loop, routing, and execution
framework", branch `chatgpt/worker-identity-r1`) foi analisada arquivo por
arquivo contra `main` pós-unificação: dos 58 arquivos de código, 52 (~89%)
já estavam redundantes (idênticos ou `main` à frente); fechada sem merge.
Resgatados por cherry-pick (únicos 2 módulos genuinamente novos, baixo
risco, sem integração pendente): `src/server/vone_power_ladder.ts`
(`PowerLadder`/`selectMonotonicPowerRoute` - seleção monotônica de rota por
perfil FAST/SMART/MAX) e `src/server/vone_external_inference_backends.ts`
(`OpenRouterFreeInferenceBackend`, `GroqFreeInferenceBackend`). Não
resgatado: `cloudflare-control-plane/*` (snapshot do código do Master que
contradiz a política acima de "Master não versionado", importa 2 arquivos
que não existem no branch, e está desatualizado frente à versão
`2.4.7-worker-identity-r1-compat` que já roda em produção).

## Bug real encontrado em 2026-10-10 (conserto pronto, não aplicado - falta acesso ao Master ao vivo): código de pareamento regenerado a cada reconexão, trava aprovação

Usuário relatou sintoma real: no painel `/vone-admin`, fica pedindo
re-autenticação repetidamente mesmo com o dispositivo já tendo
autenticado antes, e às vezes trava na tela de código de verificação sem
ir pra frente nem pra trás.

**Achado, com evidência em código, não suposição:** o snapshot do Master
em `cloudflare-control-plane/*` (branch `origin/chatgpt/worker-identity-r1`,
não mergeado - ver nota acima sobre por que não foi resgatado) reporta a
mesma string de versão (`2.4.7-worker-identity-r1-compat`) que já está
confirmada rodando em produção hoje, o que sugere parentesco real com o
código ao vivo, mesmo o snapshot sendo incompleto/desatualizado em outros
pontos. Lendo `cloudflare-control-plane/src/mobile-pwa.mjs` função por
função:

`startMobileEnrollment()` (linha 67) só reaproveita o estado existente
quando o dispositivo já está `APPROVED` (linha 85-92). Pra qualquer outro
caso - inclusive um dispositivo que já está `PENDING` com o **mesmo**
`secret_hash`, só esperando aprovação - ela cai no `INSERT ... ON
CONFLICT(device_id) DO UPDATE SET ... pairing_code=excluded.pairing_code`
(linha 96-115), que **sempre** gera um código de 6 dígitos novo
(`sixDigitCode()`, linha 94) e sobrescreve o anterior.

No cliente, `enroll()` (linha 487) é chamado toda vez que `who()` falha
no boot (linha 503) - e o boot roda de novo sempre que o PWA é
relançado (iOS evicta app em background com frequência) ou que o listener
de `focus` (linha 505) detecta mismatch de conta e faz
`location.reload()`. Cada relançamento chama `/api/mobile/enroll/start`
de novo pro mesmo dispositivo ainda `PENDING` - gerando um código novo e
invalidando o que o administrador estava vendo na tela de aprovação
(`mobile-admin.mjs`), que compara `typed.trim()!==d.pairing_code` contra
o código antigo e falha com "Código não confere". Isso explica
diretamente os dois sintomas relatados: pede de novo mesmo "já
autenticado" (o dispositivo nunca chegou a ser aprovado porque o código
muda debaixo do pé) e trava sem avançar (todo "aprovar" com o código
antigo falha).

**Conserto (não aplicado - precisa ser colado no equivalente real dentro
do Worker `vone-control-plane` via Cloudflare Quick Edit, depois de
localizar a função lá e confirmar que a lógica bate com este snapshot):**

Substituir o bloco entre a checagem de `APPROVED` (linha 85-92) e a
geração do código (linha 94) por uma checagem adicional que reaproveita o
código existente quando o dispositivo já está `PENDING` com o mesmo
segredo e ainda dentro da janela de expiração:

```js
if (
  existing &&
  existing.secret_hash === secretHash &&
  existing.status === 'APPROVED' &&
  Number(existing.access_expires_at || 0) > now
) {
  return json({ ok: true, status: 'APPROVED', device_id: deviceId });
}

// NOVO: mesmo dispositivo, mesmo segredo, ainda pendente e dentro da
// janela - devolve o código já emitido em vez de gerar outro e invalidar
// o que o admin está vendo.
if (
  existing &&
  existing.secret_hash === secretHash &&
  existing.status === 'PENDING' &&
  Number(existing.enroll_expires_at || 0) > now
) {
  return json({
    ok: true,
    status: 'PENDING',
    device_id: deviceId,
    pairing_code: existing.pairing_code,
    expires_at: existing.enroll_expires_at,
  });
}

const pairingCode = sixDigitCode();
// ... resto igual (INSERT/ON CONFLICT só roda quando é dispositivo
// genuinamente novo, segredo mudou, ou o pareamento anterior expirou)
```

A query de `SELECT` que busca `existing` (linha 77-79) precisa passar a
trazer `pairing_code,enroll_expires_at` também (hoje só traz
`device_id,secret_hash,status,access_expires_at,user_id`).

**Atualização 2026-10-10 (mesmo dia): este conserto agora tem
implementação real e testada**, não é mais só um diff em texto.
`src/server/vone_mobile_enrollment.ts` reimplementa `startMobileEnrollment`
de forma isolada (framework-agnostic, sem D1, interface
`MobileDeviceStore` pra trocar por D1 de verdade na hora de portar) já
com o conserto aplicado. `src/server/vone_mobile_enrollment.test.ts`
reproduz o cenário exato do bug (reconexão do mesmo device_id/secret_hash
enquanto ainda `PENDING`) e prova que o código devolvido é o mesmo, que a
aprovação sobrevive à reconexão, e que os outros casos (expirado,
revogado, segredo trocado, conta cruzada, input inválido) continuam
corretos - 7 cenários, todos passando (`npm test`). Portar pro Worker ao
vivo agora é: copiar a lógica de dentro de `startMobileEnrollment()`
(já na forma certa, só adaptar o acesso a dado pra `env.DB.prepare(...)`
em vez de `MobileDeviceStore`) via Quick Edit, não mais escrever do zero.

**Por que não apliquei direto (continua valendo, só a confiança no
conserto que mudou):** esse código não está neste repositório -
só existe no Worker ao vivo, editável via Cloudflare Quick Edit, sem
acesso nesta sessão (ver pendência de `CLOUDFLARE_API_TOKEN`/
`CLOUDFLARE_ACCOUNT_ID` em configuração). Aplicar um patch às cegas, sem
ler a função real primeiro, arrisca piorar algo que hoje funciona.
**Não é o segundo achado (perda de `device_id` no cliente quando o
`localStorage` é evictado pelo iOS) que também contribui pro sintoma** -
esse é mais estrutural (limite de armazenamento do Safari, não um bug de
lógica simples) e precisa de decisão de produto (ex.: permitir conta
`OWNER`/já aprovada pular aprovação manual pra um dispositivo novo, com
outro tipo de verificação) antes de qualquer código - não implementado,
nem desenhado em detalhe.
