# GitSwitch

Cliente Git estilo GitHub Desktop em que você troca de conta do GitHub escolhendo no menu **Conta**, no topo.

## Como funciona

- **Contas**: o app lê as contas em que você entrou com o GitHub CLI (`gh auth login`). Para adicionar outra, use **Conta → Adicionar conta** e termine o login na janela que abrir.
- **Push, pull, fetch e clone** usam o token da conta escolhida no topo, sem depender do que estiver salvo no Windows.
- **Commits** saem com o nome e o e-mail da conta escolhida. O padrão é o perfil do GitHub ou o e-mail noreply; dá pra mudar em **Conta → Nome/e-mail…**.
- **Trocar também no terminal** (opcional, no menu Conta): ao trocar de conta, roda `gh auth switch` e muda o `user.name`/`user.email` global do git e o usuário do Git Credential Manager.
- Cada repositório guarda a última conta usada com ele. Se você abrir o repo com outra conta, aparece uma faixa sugerindo a troca.
- **Pasta de cada conta**: em **Conta → Pastas das contas…** você escolhe onde ficam os repositórios de cada conta. Ao abrir o app, e ao adicionar uma conta, o GitSwitch procura no disco os repositórios de cada conta. Ele define a pasta de quem ainda não tem uma e oferece adicionar à lista os repositórios encontrados. O clone já usa a pasta da conta ativa.
- **Abrir em**: o botão abre o repositório no último app usado, e a setinha ao lado mostra a lista completa. Os editores instalados (VS Code, Cursor, Antigravity, Windsurf, Zed, JetBrains…) e as IAs de terminal (Claude Code, Codex, Gemini CLI, Aider…) aparecem sozinhos. Em **Adicionar app…** você inclui qualquer programa ou comando de terminal.
- **Pasta → Mover**: move o repositório para a pasta da conta ou para qualquer outra pasta.
- **Pasta → Juntar com uma pasta que já existe**: liga uma pasta sua a este repositório do GitHub sem apagar nada. Se a pasta não tem histórico, ela passa a seguir o GitHub e as diferenças aparecem em Alterações. Se tem, os dois históricos são unidos e, em caso de conflito, você escolhe a versão de cada arquivo. Repositórios só locais têm **Conectar ao GitHub…** no mesmo menu.

- **No dia a dia**: escolha linhas ou trechos do diff para o commit, guarde alterações (stash), desfaça ou emende o último commit, reverta commits, junte branches e resolva conflitos. O botão direito abre mais ações em arquivos, commits e branches. A engrenagem no canto abre as **Configurações** (tema, Git global, avisos, fetch automático, atualizações).

## Terminal e agentes de IA

O comando `gitswitch` faz o Git e o GitHub CLI usarem a conta certa no terminal, sem perguntar nada. Ele foi pensado para agentes de IA (Claude Code, Codex, Antigravity…): toda resposta pode sair em JSON e os códigos de saída são fixos.

```bash
gitswitch whoami --json              # que conta vale aqui, e por quê
gitswitch git -- push -u origin HEAD # qualquer comando git com a conta certa
gitswitch gh -- pr create --fill     # GitHub CLI com o token da conta certa
gitswitch help --json                # lista de comandos para máquinas
```

### Segurança do login

No Windows e no macOS, o GitHub CLI guarda os tokens no cofre do sistema, que é criptografado. No Linux sem chaveiro, ele grava em texto puro. O GitSwitch mostra onde está cada token em **Configurações → Segurança do login** e avisa quando algum está em texto puro. Para esses casos existe o **cofre do GitSwitch**, protegido por uma senha sua (scrypt + AES-256-GCM). Com o app aberto, o `gitswitch` e o servidor MCP pedem o token ao app, como o ssh-agent faz. Se o cofre estiver trancado, o app pede a senha. Detalhes e a comparação com o gh, o Git Credential Manager e o VS Code estão em [docs/SEGURANCA.md](docs/SEGURANCA.md).

### Servidor MCP

O GitSwitch também é um servidor MCP: os apps de IA ganham as ferramentas `gitswitch_*` (contas, trocar de conta, status, git e gh com a conta certa, commit, push, pull request e checks) sem precisar de terminal. Para ligar, use **Configurações → Terminal e IA → Adicionar em todos**, ou rode `gitswitch mcp add`. Ele aparece no Claude Code, Claude Desktop, Codex, Cursor, VS Code, Windsurf, Gemini CLI e Antigravity que estiverem instalados. Antes de mudar a configuração de um app, o GitSwitch guarda uma cópia em `mcp-backups`, na pasta de dados dele, e só mexe na entrada `gitswitch`. O Claude Desktop precisa estar fechado, porque ele reescreve a configuração ao fechar. `gitswitch mcp status` mostra onde está ligado e `gitswitch mcp remove` tira.

A conta é escolhida assim: `--as <login>` se você passar; senão, a última conta usada com o repositório; senão, a dona do `origin` (ou a conta da organização); senão, a conta ativa do app. Para instalar, use **Configurações → Terminal e IA**, ou rode `node src/cli.js install`. Isso põe o comando no PATH e instala a skill [src/ai-skill.md](src/ai-skill.md) em `~/.claude/skills` e `~/.agents/skills`.

## Idiomas e sistemas (0.7)

- **Idiomas**: português, inglês e espanhol. O app segue o idioma do sistema e cai para inglês quando o sistema usa outro idioma. Dá para escolher em **Configurações → Aparência → Idioma**. O `gitswitch` responde no idioma do sistema quando roda num terminal; em `--json` ou quando a saída vai para outro programa (scripts, agentes de IA), responde em inglês. A variável `GITSWITCH_LANG` (`pt`, `en`, `es`) força um idioma.
- **Windows, macOS e Linux**: instalador `.exe` no Windows; `.dmg` e `.zip` (Intel e Apple Silicon) no macOS; AppImage e `.deb` no Linux. O GitHub CLI vem embutido nos três. O Git vem embutido no Windows e é o do sistema no macOS e no Linux.
- **macOS**: o app tem só assinatura ad-hoc, sem certificado da Apple. Na primeira vez, abra com botão direito → **Abrir**. Sem assinatura com certificado, o macOS também não deixa o app se atualizar sozinho: baixe a versão nova na página de releases.
- Os textos ficam em [src/locales](src/locales). A chave é o texto em português usado no código.

## Novidades da 0.6

- **Sem dependências**: o Git (MinGit) e o GitHub CLI vêm junto, então não precisa instalar nada. Em **Configurações → Git e GitHub CLI** dá para usar os do sistema.
- **Pull requests**: o botão na barra mostra o PR da branch e o status dos checks. Por ali você cria PR, vê os outros PRs abertos e faz checkout deles. O app avisa quando os checks falham ou passam.
- **IA**: o botão ✨ escreve a mensagem do commit com o Claude Code ou com um modelo local do Ollama.
- **Mais Git**: tags, cherry-pick para outra branch, juntar (squash) commits locais e co-autores, tudo pelo botão direito no Histórico ou no formulário de commit.
- **Atalhos de teclado e zoom**: a lista está em Configurações.

A comparação detalhada com o GitHub Desktop está em [docs/PARIDADE.md](docs/PARIDADE.md).

## Rodar

```bash
npm install
npm start
```

Precisa de Git e do GitHub CLI (`gh`) instalados.

## Instalador

```bash
npm run dist
```

Gera `dist/GitSwitch-Setup-<versão>.exe`. Ele instala só para o seu usuário e cria atalhos no menu Iniciar e na área de trabalho. O instalador não é assinado, então o Windows SmartScreen pode avisar na primeira vez: clique em "Mais informações" e depois em "Executar assim mesmo". O ícone sai de `build/icon.png`, gerado por `npm run icon`.

## Atualizações

As cópias instaladas procuram versões novas nas [releases deste repositório](https://github.com/devopsfuturasync/gitswitch/releases): 5 segundos depois de abrir e depois a cada 4 horas. Quando acham uma, baixam em segundo plano e mostram **Reiniciar e atualizar**. Se você só fechar o app, a versão nova é instalada do mesmo jeito.

Para publicar uma versão nova, aumente `version` no `package.json`, faça commit e push, e rode:

```bash
npm run release
```

O script cria a tag `v<versão>` e a envia com a conta dona do repositório (`devopsfuturasync`). O GitHub Actions ([.github/workflows/release.yml](.github/workflows/release.yml)) monta Windows, macOS e Linux e publica tudo numa release só. Para testar o build sem publicar, rode o workflow "Release" pela aba Actions com "publish" desligado: os instaladores ficam como artefatos. `npm run release:local` continua publicando só o Windows a partir desta máquina.
