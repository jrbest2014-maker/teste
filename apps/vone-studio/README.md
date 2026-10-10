# V-ONE Studio

Interface única - web, PWA mobile e shell desktop (Tauri) - pra operar o
agente V-ONE. Uma base de código, três formas de abrir, seguindo a mesma
ideia de ambientes de cowork como o do Claude Code ou do Codex: chat com
histórico, chamadas de ferramenta visíveis e expansíveis, e um painel de
codespace/arquivos ao lado - não só um chat genérico.

A paleta (fundo quase-preto, acento âmbar `#F2B134`) vem de
`editor/vone-studio-theme`, que já era a identidade visual do projeto - os
tokens em `src/styles/tokens.css` só estendem essa paleta pra um design
system de app completo (tipografia, espaçamento, estados semânticos que
espelham `RouteState`/`RoutingGates` do backend em
`src/server/vone_model_router.ts`).

## Rodando

```bash
npm install
npm run dev        # abre em http://localhost:5173
npm test           # 13 testes de componente (vitest)
```

Sem `.env.local`, a UI roda contra `MockVOneApiClient` (`src/api/client.ts`),
com dados fixos em `src/api/mockData.ts` - dá pra navegar tudo (sessões,
tool-calls, codespace) sem precisar do Master respondendo. Com
`VITE_VONE_MASTER_URL`/`VITE_VONE_CLOUD_WORKER_URL` definidas (ver
`.env.example`), fala com o backend real - detalhes de cada chamada na
seção "Ligando no backend real" abaixo.

## As três formas

### 1. Web
`npm run build && npm run preview` - ou publique `dist/` em qualquer
hosting estático (inclusive um Worker Cloudflare, como o resto do projeto).

### 2. Mobile (PWA)
Já é instalável: `public/manifest.webmanifest` + o ícone em
`public/icon.svg` fazem o navegador mobile oferecer "Adicionar à tela
inicial", abrindo em tela cheia sem chrome de navegador. O layout é
responsivo mobile-first - sidebar e painel de codespace viram overlays que
não ficam abertos ao mesmo tempo em telas estreitas (< 960px /
< 1200px respectivamente).

Service worker offline-first em `public/sw.js` (registrado em
`src/main.tsx`): shell e assets ficam em cache depois da primeira visita,
testado de verdade com Playwright (visita online, depois offline + reload
- app carrega igual, zero erro de console).

### 3. Desktop (Tauri)
Scaffold em `src-tauri/` (Rust + `tauri.conf.json` apontando pra mesma
`dist/`). Pra empacotar de verdade:

```bash
npm install            # já traz @tauri-apps/cli
npm run desktop:dev     # janela nativa, hot reload igual ao `vite dev`
npm run desktop:build   # gera o instalador/binário da plataforma atual
```

Exige toolchain Rust (`cargo`/`rustc`) e as dependências de sistema do
Tauri pra cada SO (ver https://v2.tauri.app/start/prerequisites/). Os
ícones em `src-tauri/icons/` hoje são só o PNG 128×128 existente
duplicado - rode `npx tauri icon public/icon.svg` depois de instalar a CLI
pra gerar o conjunto completo (ico/icns/vários tamanhos) antes de um build
de release de verdade.

## Ligando no backend real

Duas opções, nessa ordem de prioridade em `App.tsx` (local vence se as
duas estiverem configuradas):

### Opção 1 (recomendada): worker local, sem depender da nuvem

`LocalVOneApiClient` fala direto com `VOneLocalChatServer`
(`src/server/vone_local_chat_server.ts`), que roda junto com o worker
próprio (`vone_owned_worker_main.ts`) na máquina do dono e chama
`VOneInferenceFailoverExecutor` **em processo**, sem passar pela fila de
jobs do Master (Cloudflare D1).

Existe porque, na prática, o Master caiu (ver bloqueios reais na Opção 2
abaixo) e o
app mobile oficial (`/vone-mobile`, fora deste repositório) só sabe falar
com a rota `CLOUD_ONLY` do Master - sem esse Master de pé, cai inteiro pra
`OFFLINE`, mesmo com Ollama local saudável. Esse caminho local não tem
esse problema: fica de pé enquanto o processo do worker próprio estiver
rodando, Master saudável ou não.

Pra ativar: suba o worker (`ts-node src/server/vone_owned_worker_main.ts`
na raiz do repo, com `VONE_WORKER_TOKEN` configurado), copie
`host`/`port`/`auth_token` do bloco `local_chat_server` que ele imprime ao
subir pra `VITE_VONE_LOCAL_URL`/`VITE_VONE_LOCAL_TOKEN` em `.env.local`
deste app, rode `npm run dev`. Contrato 100% confirmado - servidor e
cliente escritos e testados juntos nesta sessão
(`vone_local_chat_server.test.ts`), testado de ponta a ponta com
Playwright contra servidor real + browser real (mensagem enviada,
resposta renderizada, zero erro de console, zero banner de erro).

### Opção 2: Master na nuvem

`HttpVOneApiClient` implementado (não é mais stub). Pra ativar: preencha
`VITE_VONE_MASTER_URL`/`VITE_VONE_CLOUD_WORKER_URL` em `.env.local`.

Estado real de cada método, por confiança:

- **`getGateStatus()` - confirmado.** Fala com
  `src/cloudflare/vone_cloud_worker.ts` (este repositório, com teste). Zero
  inferência.
- **`listSessions()` - caminho confirmado, formato da resposta inferido.**
  `GET /api/mobile/history?device_id=...` é real (AGENTS.md documenta o bug
  corrigido nele). O parser aceita vários formatos plausíveis de linha
  (`role`/`sender`/`author`, `content`/`text`/`message`) porque o JSON
  exato nunca foi visto ao vivo nesta sessão.
- **`sendMessage()` - caminho NÃO confirmado**, é um palpite
  (`/api/mobile/chat`, convenção do endpoint irmão) guardado num campo
  configurável (`chatEndpointPath`) fácil de corrigir numa linha.

Tentei verificar os três ao vivo nesta sessão (2026-10-10) e bati em dois
bloqueios reais e concretos, não hipotéticos:

1. **Rede do ambiente bloqueia o Master.** `curl` direto pra
   `vone-control-plane.vone-technology.workers.dev` voltou `CONNECT 403` -
   confirmado no log do proxy (`$HTTPS_PROXY/__agentproxy/status`). Resolve
   em Configurações do ambiente → Network access → liberar esse host.
2. **A ponte MCP pro Master também falhou, com causa raiz real:** a
   ferramenta `vone_status` do servidor `v-one-master-cloudflare` devolveu
   `D1_ERROR: Your account has exceeded D1's free tier daily row write
   limit`. O Master inteiro (D1) está sem cota de escrita hoje - reseta à
   meia-noite UTC. Virar pra tier pago é decisão de custo do dono, nunca
   automática (`PAID_BLOCKED=INVIOLABLE`).

Testado com o Playwright contra o dev server real com as duas URLs
configuradas: o app tenta a chamada de verdade, ela falha com
`net::ERR_TUNNEL_CONNECTION_FAILED` (o bloqueio de rede acima), e a UI
mostra isso num banner vermelho em vez de cair pro mock silenciosamente ou
quebrar a tela - `App.tsx`, estado `backendError`.

Assim que (1) ou (2) abrir, uma sessão com acesso confirma o shape real do
histórico e do envio contra o Worker ao vivo e corrige qualquer campo que
estiver errado - o código já está pronto pra rodar, só falta a rede.

## O que ainda falta (próximos passos sugeridos)

- Streaming de resposta token-a-token (hoje a resposta chega inteira).
- Autenticação real (hoje não há login nenhum).
- Gerar os ícones corretos do Tauri pra cada plataforma antes de um build
  de release.
