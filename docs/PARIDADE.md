# GitSwitch × GitHub Desktop: paridade

Engenharia reversa do código aberto do GitHub Desktop (`desktop/desktop`, commit `bebc062`, out/2026), focada em `app/src/lib/git`, `app/src/lib/trampoline`, `app/src/lib/stores` e `docs/technical`. A meta é o GitSwitch ser **no mínimo igual** em qualidade e melhor no que ele existe para resolver: várias contas do GitHub.

## Como o Desktop fala com o Git

| Tema | GitHub Desktop | GitSwitch |
|---|---|---|
| Binário do Git | Leva o próprio Git embutido (dugite) | ✅ Leva o MinGit 2.56.0.2 e o GitHub CLI 2.102.0 oficiais (com SHA-256 conferido no build); dá para trocar pelos do sistema |
| Ambiente | `TERM=dumb` e `GIT_USER_AGENT`; ganchos (hooks) interceptados para mostrar o progresso | `TERM=dumb`, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GIT_EDITOR=true` |
| Credenciais | Credential helper "trampoline": o Git chama o Desktop, que escolhe a conta **pela origem da URL**. Isso significa **uma conta por servidor (github.com)** | Credential helper com o token da **conta escolhida**: várias contas no mesmo github.com, que é o diferencial |
| Credenciais em filtros (LFS) | Configura o helper por `GIT_CONFIG_PARAMETERS` para o Git LFS herdar | ✅ Mesmo mecanismo (antes era `-c`, que não chega ao LFS). Testado com repositório privado; LFS em si ainda não testado |
| Erros | `parseError` do dugite vira uma mensagem amigável, e a saída do terminal (256 KB) aparece quando falha | ✅ Mensagens amigáveis para os erros comuns, com a saída do Git disponível |
| Status | `--no-optional-locks status --untracked-files=all --branch --porcelain=2 -z` | ✅ Igual |
| Diff da pasta | `diff --no-ext-diff --patch-with-raw -z --no-color [-w] HEAD -- arquivo`; arquivos novos via `--no-index /dev/null`; limites de 70 MB e 5000 caracteres por linha; imagens viram prévia | ✅ `--no-ext-diff`, `-w` opcional, `--no-index` para arquivos novos, limite de 4 MB e prévia de imagem |
| Commit | Esvazia o índice (`reset`), depois `update-index` para arquivos inteiros e `apply --cached --unidiff-zero` para seleção parcial, e por fim `commit -F -` | ✅ Mesmo fluxo, incluindo **seleção por linha** |
| Descartar | Manda os arquivos **novos e modificados** para a Lixeira, depois `reset` e `checkout-index` | ✅ Igual (antes, a versão modificada se perdia) |
| Fetch/Push/Pull | `--progress`; fetch com `--prune --recurse-submodules=on-demand --show-forced-updates`; push com `--set-upstream` e `--force-with-lease` | ✅ Progresso na barra; fetch com as mesmas opções; push forçado seguro |

## Funcionalidades

Legenda: ✅ tem · 🟡 parcial · ⬜ ainda não

| Funcionalidade | Desktop | GitSwitch |
|---|---|---|
| Várias contas no github.com, troca em um clique | ⬜ (uma por servidor) | ✅ |
| Pasta por conta, detecção de repos no disco | ⬜ | ✅ |
| Comando de terminal para agentes de IA (JSON, conta certa no git e no gh) | ⬜ | ✅ `gitswitch` |
| Servidor MCP para apps de IA (Claude, Codex, Cursor, VS Code…) | ⬜ | ✅ `gitswitch mcp`, registrado pelas Configurações |
| Idiomas | ✅ (vários) | ✅ português, inglês e espanhol, pelo idioma do sistema |
| macOS e Linux | ✅ macOS e Linux (comunidade) | ✅ `.dmg`/`.zip` (Intel e Apple Silicon), AppImage e `.deb` |
| Atualização automática no macOS | ✅ (app assinado) | ⬜ precisa de certificado Apple Developer |
| Juntar uma pasta existente com um repo do GitHub | ⬜ | ✅ |
| Mover repositório de pasta | 🟡 ("Locate" após mover por fora) | ✅ |
| Clonar com a lista de repos da conta | ✅ | ✅ |
| Alterações, diff, commit, histórico | ✅ | ✅ |
| Selecionar linhas e trechos para o commit | ✅ | ✅ |
| Descartar alterações (com Lixeira) | ✅ | ✅ |
| Ocultar espaços em branco no diff | ✅ | ✅ |
| Prévia de imagem no diff | ✅ | ✅ |
| Emendar o último commit (amend) | ✅ | ✅ |
| Desfazer o último commit | ✅ | ✅ |
| Reverter um commit | ✅ | ✅ |
| Copiar SHA, criar branch a partir de um commit | ✅ | ✅ |
| Stash (guardar alterações, aplicar, descartar) | ✅ | ✅ |
| Branches: criar, trocar, renomear, apagar | ✅ | ✅ |
| Merge de outra branch na atual | ✅ | ✅ |
| Resolver conflitos (versão local ou do GitHub) | ✅ | ✅ |
| Progresso de fetch/push/pull/clone | ✅ | ✅ |
| Fetch automático em segundo plano | ✅ | ✅ |
| Editor e terminal externos, com escolha do padrão | ✅ | ✅ (mais IAs de terminal e apps próprios) |
| Ignorar arquivo (.gitignore) | ✅ | ✅ |
| Configurações (Git global, confirmações, diff, editor, tema) | ✅ | ✅ |
| Atualização automática | ✅ | ✅ |
| Cherry-pick para outra branch | ✅ | ✅ |
| Juntar (squash) commits locais | ✅ | ✅ |
| Reordenar commits, rebase interativo | ✅ | ⬜ |
| Operação em andamento (merge, cherry-pick, revert, rebase): aviso e cancelar | ✅ | ✅ |
| Pull requests: PR da branch, criar, listar e fazer checkout | ✅ | ✅ |
| Status dos checks (CI) e notificação quando falham ou passam | ✅ | ✅ |
| Tags: criar, apagar (também no GitHub) e enviar junto com o push | ✅ | ✅ |
| Co-autores | ✅ | ✅ |
| Signoff | ✅ | ⬜ |
| Worktrees, submódulos, LFS (instalar filtros) | ✅ | ⬜ próxima fase |
| GitHub Enterprise | ✅ | ⬜ próxima fase |
| Mensagem de commit com IA | ✅ Copilot | ✅ Claude Code ou Ollama local |
| Resolução de conflitos com IA | ✅ | ⬜ |
| Atalhos de teclado e zoom | ✅ | ✅ |

## Como foi verificado (v0.4.0)

- Staging por linha: commit parcial de arquivo modificado, arquivo novo, arquivo sem quebra de linha no final e rename, conferindo o conteúdo do commit com `git show HEAD:arquivo`. Também feito pela interface.
- Descartar: o arquivo modificado vai para a Lixeira antes de voltar à versão do commit.
- Stash, desfazer commit, emendar e reverter: testados com Git real e pela interface.
- Credenciais: repositório privado da `devopsfuturasync` buscado com o token dela (ok), com o da `danilogiles` (recusado: "não encontrado") e com um token inválido (recusado: "acesso recusado"). Isso mostra que só a credencial da conta escolhida é usada.

## Análise do app distribuído com REA (GitHub Desktop 3.6.6 instalado)

Feita com a skill [Reverse Engineer Anything](https://github.com/morluto/rea) (`rea-agents` 6.7.0, `analyze-javascript-application`), em análise estática da pasta `%LOCALAPPDATA%GitHubDesktopapp-3.6.6esourcesapp`. Escopo: `package.json`, `main.js`, `renderer.js`, `cli.js` e os source maps deles. Evidência `ev_8c1a8a407b29…`, artefato `sha256 dda53720…`. Foram recuperados 757 módulos do app pelos source maps. Nada foi executado. Os outros 249 arquivos e o comportamento em execução ficam fora do que foi observado.

| O que o artefato mostra | Tipo | GitSwitch |
|---|---|---|
| Distribui o próprio Git (`git version 2.53.0.windows.4`), apontado por `LOCAL_GIT_DIRECTORY` e `GIT_EXEC_PATH` | observado | ✅ GitSwitch 0.6 também (MinGit 2.56.0.2) |
| Credenciais pelo trampoline (`DESKTOP_TRAMPOLINE_TOKEN`) e tokens no cofre do Windows (`keytar.node`) | observado | ✅ token por conta, vindo do cofre do `gh` |
| Comando `github`: só `open`, `clone [-b]` e o diretório atual; tudo só abre a janela | observado (`cli/main.ts` no source map) | ✅ `gitswitch` executa git/gh, responde em JSON e tem códigos de saída fixos |
| Atalhos do comando em `%LOCALAPPDATA%GitHubDesktopin`, rodando com `ELECTRON_RUN_AS_NODE=1` (sem Node instalado) e com suporte a WSL | observado (`static/github.bat`, `github.sh`) | ✅ a instalação pelo app instalado agora usa o GitSwitch.exe; ⬜ WSL |
| Janelas com `contextIsolation` desligado e `nodeIntegration` ligado | observado (expressões estáticas em `main.js`) | ✅ mais restrito: isolamento ligado, sandbox, sem Node na página |
| Copilot: mensagem de commit gerada, resolução de conflitos, modelo escolhido por conta, provedores próprios (BYOK), modelos locais (`foundry_local_napi.node`) | observado (módulos e addons) | 🟡 mensagem de commit (Claude Code/Ollama); conflitos ⬜ |
| Notificações de PR: checks falhando, reviews e comentários | observado (`lib/notifications/*`) | 🟡 checks (falharam/passaram); reviews e comentários ⬜ |
| Hooks do Git com o ambiente do shell do usuário, e tela de hook que falhou | observado (`lib/hooks/*`) | 🟡 hooks rodam; falha aparece nos detalhes do erro |
| Zoom da interface, `git-trace` e shell dos hooks como configuração | observado (chaves de armazenamento) | 🟡 zoom ✅; `git-trace` e shell dos hooks ⬜ |
| Captura de microfone (`pv_recorder.node`) entre os addons do Copilot | observado: o addon está lá | uso em execução não comprovado |

O Git não foi analisado com o REA: o `git.exe` é nativo e não há Ghidra, Hopper ou IDA instalados. Como o código do Git é aberto, a própria skill indica ler o código-fonte nesse caso.
