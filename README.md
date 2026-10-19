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
