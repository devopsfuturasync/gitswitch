# Segurança do login

Onde o token de cada conta fica guardado, o que os outros programas fazem quando o sistema não tem um cofre de senhas, e como funciona o cofre do GitSwitch.

## O que os outros fazem (engenharia reversa, outubro de 2026)

Analisado com o REA nos binários instalados nesta máquina, sem rodar nada deles. Os IDs são as evidências do REA.

| Programa | Com cofre do sistema | Sem cofre do sistema | Evidência |
|---|---|---|---|
| **GitHub CLI 2.102.0** (Go 1.27.1) | `zalando/go-keyring` v0.2.8: Secret Service por D-Bus no Linux, `danieljoos/wincred` no Windows, Keychain no macOS | Tenta o keyring com tempo limite ("timeout while trying to set secret in keyring") e, se falhar, grava o token em `hosts.yml` e avisa "Authentication credentials saved in plain text". `--insecure-storage` força texto puro; `--secure-storage` em `gh auth token` só lê do cofre | `ev_2c7ef252…` (módulos Go) e strings do binário Windows e Linux |
| **Git Credential Manager 2.5** (`gcmcore.dll`, .NET Framework 4.7.2) | `wincredman`, `dpapi`, `keychain`, `secretservice` | Não escolhe sozinho: sem configuração, falha com "No credential store has been selected" e lista as opções. Oferece `gpg` (compatível com `pass`, exige GPG), `cache` (memória do `git credential-cache`) e `plaintext`, rotulado "(UNSECURE)". `secretservice` recusa rodar sem interface gráfica | `ev_cdbaa5c3…` (83 strings de `CredentialStore`, `PlaintextCredentialStore`, `CredentialCacheStore`, `GpgPassCredentialStore`, `SecretServiceCollection`) |
| **VS Code 1.109.5** (Electron) | `safeStorage` do Electron: DPAPI, Keychain, `gnome_libsecret` / `kwallet5` / `kwallet6` | O backend vira `basic_text`, ou seja, texto puro. Só entra nesse modo com `--password-store=basic` (`setUsePlainTextEncryption`); há também `--use-inmemory-secretstorage`, que guarda só na memória | `ev_fe5d1b00…` (`out/main.js`, `EncryptionMainService`) |

Fora do REA, pelo código-fonte público:

- **aws-vault**: o backend `file` (da biblioteca `99designs/keyring`) cifra cada item com uma senha (JOSE, PBES2 + AES-GCM). A senha é pedida no terminal.
- **ssh-agent**: as chaves só existem na memória do agente. Outros programas pedem por um socket Unix numa pasta só do usuário, e `-t` dá um tempo de vida.

O que se tira disso:

1. Ninguém consegue cifrar de verdade sem um segredo que o usuário forneça. Quem não tem cofre do sistema ou grava em texto puro (gh, VS Code `basic`), ou exige uma senha/chave do usuário (GCM `gpg`, aws-vault), ou guarda só na memória (GCM `cache`, VS Code em memória, ssh-agent).
2. O GCM tem a postura mais segura: não cai para texto puro sozinho.

## O que o GitSwitch faz

**Mostra onde está cada token.** Em **Configurações → Segurança do login** (e em `gitswitch vault status` / `gitswitch accounts --json`), cada conta aparece como:
- cofre do sistema;
- cofre do GitSwitch;
- texto puro (o `tokenSource` do gh apontando para `hosts.yml`);
- variável de ambiente.

Quando alguma está em texto puro, uma faixa vermelha avisa e oferece proteger.

**Cofre do GitSwitch** ([src/vault.js](../src/vault.js)), no modelo do aws-vault e do GCM `gpg`:
- **Cifra:** a chave sai de uma senha sua, com scrypt (N = 2¹⁷, r = 8, p = 1, sal aleatório de 16 bytes). Os tokens são cifrados com AES-256-GCM, com um IV novo a cada gravação.
- **Cabeçalho autenticado:** o cabeçalho (formato, parâmetros do scrypt e lista de logins) entra como dado autenticado. Se alguém mexer nele, o cofre não abre, em vez de confiar no que foi alterado.
- **Arquivo:** `vault.json` na pasta de dados, com permissão 600 no Linux e no macOS. Os logins ficam em claro, porque não são segredo e o app precisa listar as contas com o cofre trancado.
- **Senha:** no mínimo 8 caracteres. Não há recuperação; se esquecer, entre de novo nas contas.

**Mover para o cofre** copia o token do gh para o cofre e roda `gh auth logout` daquela conta. Isso apaga a cópia do gh (o `hosts.yml` ou o keyring), mas o token continua válido no GitHub. **Devolver ao GitHub CLI** faz o caminho inverso com `gh auth login --with-token`.

**Contas novas vão direto para o cofre** quando ele existe. O `gh auth login` roda com um `GH_CONFIG_DIR` temporário e privado: no Linux fica em `/run/user/<uid>`, que é memória e não toca o disco. Assim que o token aparece, ele passa para o cofre e a pasta é apagada.

**Agente**, no modelo do ssh-agent ([src/agent.js](../src/agent.js)). Com o app aberto e o cofre destrancado, o comando `gitswitch` e o servidor MCP pedem o token ao app:
- **Canal:** um socket Unix com permissão 600 (em `/run/user/<uid>` quando existe) ou um named pipe no Windows.
- **Chave por sessão:** cada pedido precisa levar uma chave aleatória de 32 bytes. O app grava essa chave com permissão só do usuário quando abre e apaga ao fechar.
- **Comparação:** a chave é comparada em tempo constante.
- **Onde fica o token:** só na memória do processo principal. A janela recebe a senha para destrancar, nunca os tokens.

**Destrancar quando precisa.** Se um programa (terminal ou IA) pede uma conta com o cofre trancado, o GitSwitch:
- traz a janela para frente e pede a senha, dizendo qual conta foi pedida;
- espera até 2 minutos;
- se ninguém destrancar, o comando falha com `kind: "auth"` (saída 3) e uma frase clara.

Sem o app aberto, num terminal, o próprio `gitswitch` pede a senha (sem eco) e destranca só para aquele comando. Pelo MCP, que não tem terminal, o servidor nunca pede a senha.

**Trancar.** O cofre tranca quando o app fecha, pelo botão **Trancar agora**, por `gitswitch vault lock`, ou sozinho depois de 15 minutos, 1 hora ou 4 horas sem uso.

## O que o cofre não protege

- **Programas rodando com o seu usuário enquanto o cofre está destrancado:** podem pedir um token ao agente. Contra isso, as defesas são trancar e o tempo de vida, como no ssh-agent e no keyring do sistema.
- **Um keylogger:** captura a senha.
- **Tokens já vazados:** sair do gh não revoga o token. Para revogar: GitHub → Settings → Applications → GitHub CLI → Revoke.

Para o caso "roubaram o notebook", use também a criptografia do disco: LUKS, FileVault ou BitLocker.

Recomendação no Linux: se der, instale um chaveiro (GNOME Keyring, KWallet ou KeePassXC com Secret Service). Aí o próprio gh já guarda o token cifrado. O cofre do GitSwitch é para quando não dá.
