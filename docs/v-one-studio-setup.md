# V-ONE Studio — VS Code rebatizado, worker local como motor padrão

Este documento cobre a parte visual/operacional do "V-ONE Studio": o mesmo
VS Code, com cara própria, operando os agentes do projeto (Claude Code +
worker local) como motor principal. Copilot/Codex continuam instalados como
ferramentas auxiliares, com seus próprios limites reais - **nada aqui
sobrescreve, gera ou falsifica token/crédito de nenhum serviço de
terceiro**. O limite de uso do Codex/Copilot vive na conta OpenAI/GitHub,
não numa pasta local; não existe arquivo neste repositório que o altere.

O que faz o worker local ser "sem limite" de verdade, sem forjar nada: ele
roda no seu hardware (Ollama local), então não há medidor de terceiro pra
estourar. Ver `AGENTS.md` para os gates do próprio V-ONE
(`PAID_BLOCKED=INVIOLABLE`, `UNKNOWN_COST=HOLD`) que já fazem "local
primeiro, pago nunca automático" no nível do model router
(`src/server/vone_model_router.ts`, `createDefaultGates()`).

## 1. Visual imediato (já ativo, zero instalação)

`.vscode/settings.json` já tem `window.title` e `workbench.colorCustomizations`
com o acento âmbar do V-ONE. Basta abrir esta pasta no VS Code - não precisa
instalar extensão nenhuma pra ver o efeito.

## 2. Tema completo instalável (opcional, pra usar fora deste workspace)

Fonte em `editor/vone-studio-theme/` (tema `vs-dark`, mesmo acento âmbar
`#F2B134`, sem telemetria, sem dependências). `.vscode/settings.json` já
aponta `workbench.colorTheme: "V-ONE Studio"`; até instalar, o VS Code
simplesmente ignora e mantém o tema atual - o item 1 acima já cobre o
efeito visual imediato de qualquer forma.

Duas formas de instalar, no seu desktop (precisa de Node/npm):

**a) Empacotado (.vsix) - forma "normal":**
```bash
cd editor/vone-studio-theme
npx @vscode/vsce package
code --install-extension vone-studio-theme-1.0.0.vsix
```

**b) Cópia direta - sem empacotar nada:**
- Windows: copie a pasta `editor\vone-studio-theme` para
  `%USERPROFILE%\.vscode\extensions\vone-studio-theme`
- Reabra o VS Code. Se `workbench.colorTheme` já não aplicar sozinho, use
  `Ctrl+K Ctrl+T` ("Preferences: Color Theme") e escolha "V-ONE Studio".

## 3. Ícone

`editor/vone-studio-theme/icon.svg` (fonte vetorial, mesma paleta âmbar) e
`icon.png` (128x128, gerado a partir do SVG) já estão referenciados no
`package.json` da extensão (`"icon": "icon.png"`) - aparece sozinho na
view de Extensions do VS Code quando a extensão é instalada (seção 2).

**Limite honesto:** isso é o ícone *da extensão*, não o ícone *da janela do
VS Code* (o que aparece na barra de tarefas/alt-tab do Windows). Esse
segundo é compilado dentro do executável do VS Code
(`resources/win32/code.ico` no código-fonte do VS Code OSS) - trocá-lo de
verdade exigiria buildar o VS Code inteiro a partir do fonte, não só
instalar uma extensão. É um projeto bem maior (toolchain de build completo,
sem atalho via workspace/extensão) - não comecei isso sem seu aval
explícito, porque é um escopo bem diferente do resto deste doc.

## 4. Worker local como motor padrão

Estado real deste checkout (ver `AGENTS.md`, seção "Duas linhas de
desenvolvimento"): esta branch (`claude/v-one-yellow-ap1-juxog9`, linha
"núcleo") tem o model router e os gates, mas **não tem** o runtime do
worker de desktop. O runtime real (`vone_owned_worker_main.ts`) está na
linha `chatgpt/*` - confirmado 2026-10-08, 14/14 suítes passando,
`tsc --noEmit` limpo nessa linha e na correção de checkpoint (PR #12,
já mergeada nela).

**Pelo script** (`scripts/start-local-worker.ps1`, PowerShell, falha
fechado em cada pré-condição em vez de tentar "dar um jeito" - nunca pede
nem imprime o valor do token, só compara hash):

```powershell
git checkout chatgpt/local-model-protocol-adapter-r1
npm ci
$env:VONE_WORKER_TOKEN = (Get-Content <caminho do seu worker.token local> -Raw).Trim()
scripts\start-local-worker.ps1
```

O script confere, nessa ordem, e para com uma mensagem clara em qualquer
falha: (1) o checkout tem o runtime do worker, (2) o Ollama está de pé e
`v-one-coder:fast` está instalado, (3) o SHA-256 de `$env:VONE_WORKER_TOKEN`
bate com `WORKER_TOKEN_SHA256` documentado em `AGENTS.md` - só então sobe o
worker. **Este script não foi executado por mim** (esta sessão é headless,
sem Ollama/PowerShell/Windows reais) - rode no seu desktop e me diga o que
aconteceu, inclusive se algum passo falhar.

Passo a passo equivalente, manual, se preferir não usar o script:

```bash
git checkout chatgpt/local-model-protocol-adapter-r1   # ou claude/vone-session-checkpoint-fix-r1 (já mergeada na linha acima)
npm ci
ollama list   # confirme que v-one-coder:fast aparece - medido: 15,88 tok/s geração / 59,3 tok/s prompt eval
              # nesse hardware (i7-8650U, CPU-only) - ver src/core/vone_hardware_sizing.ts
$env:VONE_WORKER_TOKEN = "..."   # token real - AGENTS.md: não existe emissão self-service,
                                  # nunca cole o valor no chat, compare hash se precisar verificar
npx ts-node src/server/vone_owned_worker_main.ts
```

Dentro do V-ONE Studio, esse worker é o motor padrão: é ele que fica de pé
o tempo todo, sem hora, sem crédito contado, porque é computação sua, local.

## 5. Fronteira com Codex/Copilot (deliberada, não é limitação técnica)

A extensão Copilot/Codex continua exatamente como está - mesma
autenticação, mesmo medidor, mesmo plano da sua conta OpenAI/GitHub.
"V-ONE Studio" não intercepta, não substitui e não gera credencial para
esses serviços; só torna o worker local a primeira opção no seu fluxo de
trabalho diário. Quando o Codex bate no limite dele, ele continua
voltando sozinho no horário de reset dele - isso nunca vai mudar por nada
que esteja neste repositório, e não deveria: forjar isso seria quebra de
ToS contra um serviço de terceiro, não uma melhoria do V-ONE.

## 6. App standalone "V-ONE Studio.exe" - roteiro real (em andamento)

Autorizado explicitamente pelo dono em 2026-10-08, sabendo do custo real em
minutos de GitHub Actions (runner Windows conta em dobro). Diferente das
seções 1-5 (tema + worker, já prontos), isto é um projeto grande, do
tamanho de manter uma distribuição própria do VS Code (o precedente real é
o VSCodium) - não cabe inteiro numa sessão. Avançando em marcos, cada um
só começa depois do anterior dar evidência real.

**Marco 1 (`.github/workflows/vone-studio-build-probe.yml`, disparo manual
via `workflow_dispatch` - nunca automático, pra manter o gasto sob
controle):** só prova que o `microsoft/vscode` upstream, sem nenhum patch
nosso, compila (`npm run compile-client`) num runner `windows-latest`.
Nenhuma marca, nenhum Copilot envolvido ainda - isola a variável antes de
somar complexidade.

**Achado real da pesquisa (2026-10-08, via `package.json` do
`microsoft/vscode` upstream):** o Copilot hoje está embutido no build
principal do VS Code (`compile-copilot`, `copilotRuntimeVersion`,
`copilot:setup`, `copilot:get_token` no `package.json`) - não é mais só
uma extensão instalável separada como presumido antes. Isso eleva o risco
de licenciamento de "Copilot pode recusar rodar no fork" pra "o próprio
build pode embutir código do Copilot sob os termos da Microsoft" - avaliado
com cuidado depois que o Marco 1 confirmar que o build básico funciona.
`innosetup` aparece nas `devDependencies` do upstream, então existe
caminho real pra gerar instalador Windows - ainda não testado.

**Próximos marcos (ainda não iniciados):** patch de marca (`product.json`:
nome, ícone - usando `editor/vone-studio-theme/icon.svg|png` já prontos
neste repo -, identidade do app); decisão sobre `extensionsGallery` (não
copiar a galeria privada da Microsoft pra um fork redistribuído - usar
Open VSX, como o VSCodium faz, documentando que o Copilot pode não estar
disponível lá); packaging via `innosetup` pra gerar o `.exe` instalável de
verdade.
