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
```

Por padrão a UI roda contra `MockVOneApiClient` (`src/api/client.ts`), com
dados fixos em `src/api/mockData.ts` - dá pra navegar tudo (sessões,
tool-calls, codespace) sem precisar do Master respondendo.

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

Falta só um service worker de cache offline se quiser PWA instalável
offline-first - não incluído ainda porque o chat depende de rede de
qualquer forma.

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

`src/api/client.ts` já tem `HttpVOneApiClient`, mas sem implementação -
documentado lá o que falta: o contrato HTTP exato do Master
(`vone-control-plane`) não está neste repositório (ver `AGENTS.md`, seção
"O Master" - é editado por Cloudflare Quick Edit, fora do Git). Pra ligar
de verdade:

1. Confirmar o formato real de `/api/mobile/history` e do job
   `vone_hub_chat` lendo o Worker ao vivo (não advinhar).
2. Implementar os métodos de `HttpVOneApiClient` contra esse contrato.
3. Trocar `new MockVOneApiClient()` por `new HttpVOneApiClient(...)` em
   `src/App.tsx`.
4. Nunca hardcodar token/credencial Cloudflare no código - injetar via
   variável de ambiente do build (`import.meta.env`).

## O que ainda falta (próximos passos sugeridos)

- Streaming de resposta token-a-token (hoje a resposta chega inteira).
- Autenticação real (hoje não há login nenhum).
- Service worker pra PWA offline-first.
- Gerar os ícones corretos do Tauri pra cada plataforma antes de um build
  de release.
- Testes de componente (hoje só há verificação manual via Playwright).
