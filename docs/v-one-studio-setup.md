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

## 3. Worker local como motor padrão

Estado real deste checkout (ver `AGENTS.md`, seção "Duas linhas de
desenvolvimento"): esta branch (`claude/v-one-yellow-ap1-juxog9`, linha
"núcleo") tem o model router e os gates, mas **não tem** o runtime do
worker de desktop. O runtime real (`vone_owned_worker_main.ts`) está na
linha `chatgpt/*`. Pra rodar o worker local no seu desktop:

```bash
git checkout chatgpt/local-model-protocol-adapter-r1   # ou claude/vone-session-checkpoint-fix-r1 (correção de checkpoint já validada contra o Master)
npm ci
ollama list   # confirme que v-one-coder:fast aparece - medido: 15,88 tok/s geração / 59,3 tok/s prompt eval
              # nesse hardware (i7-8650U, CPU-only) - ver src/core/vone_hardware_sizing.ts
$env:VONE_WORKER_TOKEN = "..."   # token real - AGENTS.md: não existe emissão self-service,
                                  # nunca cole o valor no chat, compare hash se precisar verificar
npx ts-node src/server/vone_owned_worker_main.ts
```

Dentro do V-ONE Studio, esse worker é o motor padrão: é ele que fica de pé
o tempo todo, sem hora, sem crédito contado, porque é computação sua, local.

## 4. Fronteira com Codex/Copilot (deliberada, não é limitação técnica)

A extensão Copilot/Codex continua exatamente como está - mesma
autenticação, mesmo medidor, mesmo plano da sua conta OpenAI/GitHub.
"V-ONE Studio" não intercepta, não substitui e não gera credencial para
esses serviços; só torna o worker local a primeira opção no seu fluxo de
trabalho diário. Quando o Codex bate no limite dele, ele continua
voltando sozinho no horário de reset dele - isso nunca vai mudar por nada
que esteja neste repositório, e não deveria: forjar isso seria quebra de
ToS contra um serviço de terceiro, não uma melhoria do V-ONE.
