const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { Store } = require('./store');
const accounts = require('./accounts');
const github = require('./github');
const git = require('./git');
const scanner = require('./scanner');
const apps = require('./apps');

let win;
let store;

const samePath = (a, b) => Boolean(a && b) && path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();

function overrides() {
  return store.get('identities');
}

async function activeCredentials() {
  const login = store.get('activeAccount');
  if (!login) throw new Error('Escolha uma conta do GitHub primeiro.');
  return accounts.credentials(login, overrides());
}

function accountDir(login) {
  return store.get('accountDirs')[login] || null;
}

function setAccountDir(login, dir) {
  const dirs = { ...store.get('accountDirs') };
  if (dir) dirs[login] = path.normalize(dir);
  else delete dirs[login];
  store.set('accountDirs', dirs);
}

function rememberAccount(repoPath, login) {
  store.set('repos', store.get('repos').map((r) => (samePath(r.path, repoPath) ? { ...r, account: login } : r)));
}

function addRepo(repoPath, account, { select = true } = {}) {
  const p = path.normalize(repoPath);
  const old = store.get('repos').find((r) => samePath(r.path, p));
  const repos = store.get('repos').filter((r) => !samePath(r.path, p));
  repos.push({ path: p, name: path.basename(p), account: account ?? old?.account ?? null });
  repos.sort((a, b) => a.name.localeCompare(b.name));
  store.set('repos', repos);
  if (select) store.set('selectedRepo', p);
  return p;
}

function removeRepo(repoPath) {
  store.set('repos', store.get('repos').filter((r) => !samePath(r.path, repoPath)));
  if (samePath(store.get('selectedRepo'), repoPath)) store.set('selectedRepo', store.get('repos')[0]?.path ?? null);
}

// Opens a separate console so the user can finish the browser login there.
function openLoginConsole() {
  spawn('cmd.exe', ['/k', `gh auth login --hostname ${accounts.HOST} --web --git-protocol https`], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

async function pickFolder(title, defaultPath) {
  const pick = await dialog.showOpenDialog(win, {
    title,
    defaultPath: defaultPath || undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  return pick.canceled ? null : pick.filePaths[0] || null;
}

async function ask(type, message, detail, buttons, cancelId = buttons.length - 1) {
  const answer = await dialog.showMessageBox(win, { type, message, detail, buttons, defaultId: 0, cancelId, noLink: true });
  return answer.response;
}

// Moves a folder; across drives it copies, then sends the original to the Recycle Bin.
async function moveFolder(src, destParent) {
  const dest = path.join(destParent, path.basename(src));
  if (samePath(src, dest)) throw new Error('O repositório já está nessa pasta.');
  if (path.normalize(dest).toLowerCase().startsWith(`${path.normalize(src).toLowerCase()}${path.sep}`)) {
    throw new Error('Não dá pra mover uma pasta para dentro dela mesma.');
  }
  if (await scanner.exists(dest)) throw new Error(`Já existe uma pasta em ${dest}.`);
  await fs.mkdir(destParent, { recursive: true });
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if (err.code === 'EXDEV') {
      await fs.cp(src, dest, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
      await shell.trashItem(src);
    } else if (['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
      throw new Error('Algum programa está usando essa pasta (VS Code, terminal, Explorer…). Feche e tente de novo.');
    } else {
      throw err;
    }
  }
  return dest;
}

const LINK_MESSAGES = {
  adopted: 'Pasta ligada ao GitHub. O que for diferente do GitHub aparece em Alterações.',
  merged: 'Histórias unidas. Use Push para enviar ao GitHub.',
  conflicts: 'Há arquivos em conflito (marcados com !). Escolha uma versão de cada um e faça commit.',
  empty: 'O repositório no GitHub está vazio. Use Publicar branch para enviar esta pasta.',
};

const handlers = {
  // --- accounts
  async 'accounts:list'() {
    const list = await accounts.list(overrides());
    let active = store.get('activeAccount');
    if (!list.some((a) => a.login === active)) {
      active = (list.find((a) => a.ghActive) || list[0])?.login ?? null;
      store.set('activeAccount', active);
    }
    return {
      accounts: list.map((a) => ({ ...a, folder: accountDir(a.login) })),
      active,
      syncGlobal: store.get('syncGlobal'),
    };
  },
  async 'accounts:select'(login) {
    store.set('activeAccount', login);
    if (store.get('syncGlobal')) await accounts.syncGlobal(login, overrides());
    return login;
  },
  async 'accounts:add'() {
    openLoginConsole();
  },
  async 'accounts:reload'() {
    accounts.clearCache();
  },
  async 'accounts:setIdentity'(login, identity) {
    store.set('identities', { ...overrides(), [login]: identity });
    if (store.get('syncGlobal') && store.get('activeAccount') === login) {
      await accounts.syncGlobal(login, overrides());
    }
  },
  async 'accounts:setSyncGlobal'(on) {
    store.set('syncGlobal', Boolean(on));
    const login = store.get('activeAccount');
    if (on && login) await accounts.syncGlobal(login, overrides());
  },
  async 'accounts:setFolder'(login, dir) {
    setAccountDir(login, dir);
  },
  async 'accounts:chooseFolder'(login) {
    const dir = await pickFolder(`Pasta dos repositórios de @${login}`, accountDir(login));
    if (dir) setAccountDir(login, dir);
    return dir;
  },
  // Scans the disk for repos of each account. Accounts without a folder get
  // the one holding most of their repos; repos not in the list are returned.
  async 'accounts:detect'() {
    const list = await accounts.list(overrides());
    const found = await scanner.detect(list);
    const autoSet = [];
    const suggested = {};
    for (const a of list) {
      const folder = found[a.login]?.folder;
      suggested[a.login] = folder;
      if (folder && !accountDir(a.login)) {
        setAccountDir(a.login, folder);
        autoSet.push({ login: a.login, folder });
      }
    }
    const known = store.get('repos');
    const missing = new Map();
    for (const a of list) {
      for (const r of found[a.login]?.repos || []) {
        if (known.some((k) => samePath(k.path, r.path))) continue;
        const prev = missing.get(r.path);
        // A repo owned by the account itself wins over a shared org repo.
        if (!prev || r.owner.toLowerCase() === a.login.toLowerCase()) {
          missing.set(r.path, { path: r.path, name: r.name, fullName: `${r.owner}/${r.repo}`, account: a.login });
        }
      }
    }
    return { autoSet, suggested, missing: [...missing.values()].sort((x, y) => x.name.localeCompare(y.name)) };
  },

  // --- local repositories
  async 'repos:list'() {
    return { repos: store.get('repos'), selected: store.get('selectedRepo') };
  },
  async 'repos:select'(repoPath) {
    store.set('selectedRepo', repoPath);
  },
  async 'repos:remove'(repoPath) {
    removeRepo(repoPath);
  },
  async 'repos:addMany'(list) {
    for (const r of list) addRepo(r.path, r.account, { select: false });
  },
  async 'repos:addExisting'() {
    const dir = await pickFolder('Adicionar repositório local', accountDir(store.get('activeAccount')));
    if (!dir) return null;
    try {
      return addRepo(await git.toplevel(dir), null);
    } catch {
      const choice = await ask('question', 'Essa pasta não é um repositório Git.',
        `Quer criar um repositório novo em:\n${dir}`, ['Criar repositório', 'Cancelar']);
      if (choice !== 0) return null;
      await git.init(dir);
      return addRepo(dir, null);
    }
  },
  async 'repos:remote'() {
    const c = await activeCredentials();
    return github.repos(c.token);
  },
  async 'repos:chooseCloneDir'(current) {
    return pickFolder('Pasta onde clonar', current);
  },
  async 'repos:cloneDir'() {
    const login = store.get('activeAccount');
    return {
      dir: accountDir(login) || store.get('cloneDir') || path.join(app.getPath('home'), 'GitHub'),
      isAccountDir: Boolean(accountDir(login)),
    };
  },
  async 'repos:clone'(url, parentDir, name, makeDefault) {
    const c = await activeCredentials();
    const dest = path.join(parentDir, name);
    await fs.mkdir(parentDir, { recursive: true });
    await git.clone(url, dest, c);
    store.set('cloneDir', parentDir);
    if (makeDefault) setAccountDir(c.login, parentDir);
    return addRepo(dest, c.login);
  },

  // --- working with a repository
  async 'repo:info'(repo) {
    const [status, remoteUrl, merging] = await Promise.all([git.status(repo), git.remoteUrl(repo), git.isMerging(repo)]);
    return { ...status, remoteUrl, merging };
  },
  async 'repo:diff'(repo, file, initial) {
    return git.diff(repo, file, initial);
  },
  async 'repo:commit'(repo, files, message, initial, merging) {
    const c = await activeCredentials();
    await git.commit(repo, c, files, message, initial, merging);
    rememberAccount(repo, c.login);
  },
  async 'repo:discard'(repo, files, initial) {
    const names = files.map((f) => f.path);
    const choice = await ask('warning',
      names.length === 1 ? `Descartar as alterações em ${names[0]}?` : `Descartar as alterações em ${names.length} arquivos?`,
      'Arquivos novos vão para a Lixeira. Alterações em arquivos existentes são perdidas.',
      ['Descartar', 'Cancelar']);
    if (choice !== 0) return false;
    await git.discard(repo, files, initial, (p) => shell.trashItem(p));
    return true;
  },
  async 'repo:resolve'(repo, file, side) {
    await git.resolve(repo, file, side);
  },
  async 'repo:abortMerge'(repo) {
    await git.abortMerge(repo);
  },
  async 'repo:log'(repo) {
    return git.log(repo);
  },
  async 'repo:show'(repo, sha) {
    return git.show(repo, sha);
  },
  async 'repo:branches'(repo) {
    return git.branches(repo);
  },
  async 'repo:checkout'(repo, name, isRemote) {
    await git.checkout(repo, name, isRemote);
  },
  async 'repo:createBranch'(repo, name) {
    await git.createBranch(repo, name);
  },
  async 'repo:fetch'(repo) {
    const c = await activeCredentials();
    await git.fetchAll(repo, c);
  },
  async 'repo:pull'(repo) {
    const c = await activeCredentials();
    await git.pull(repo, c);
    rememberAccount(repo, c.login);
  },
  async 'repo:push'(repo, hasUpstream) {
    const c = await activeCredentials();
    await git.push(repo, c, hasUpstream);
    rememberAccount(repo, c.login);
  },

  // --- moving and linking folders
  async 'repo:move'(repo, destParent) {
    const rec = store.get('repos').find((r) => samePath(r.path, repo));
    const parent = destParent || await pickFolder(`Mover ${path.basename(repo)} para…`, accountDir(rec?.account || store.get('activeAccount')));
    if (!parent) return null;
    const dest = await moveFolder(repo, parent);
    removeRepo(repo);
    return addRepo(dest, rec?.account);
  },
  // This repo (cloned from GitHub) gets joined into a folder the user already has.
  async 'repo:linkFolder'(repo) {
    const url = await git.remoteUrl(repo);
    if (!url) throw new Error('Esse repositório não está ligado ao GitHub.');
    const c = await activeCredentials();
    const target = await pickFolder('Pasta existente para juntar com o GitHub', path.dirname(repo));
    if (!target) return null;
    if (samePath(target, repo)) throw new Error('Escolha uma pasta diferente desta.');
    const { result } = await git.link(target, url, c);
    const linked = addRepo(target, c.login);

    const old = await git.status(repo);
    const clean = !old.files.length && !old.ahead;
    const buttons = clean
      ? ['Mandar a cópia antiga para a Lixeira', 'Só tirar da lista', 'Manter as duas']
      : ['Só tirar da lista', 'Manter as duas'];
    const choice = await ask('question', 'E a cópia antiga?',
      clean
        ? `${repo}\n\nTudo dela já está no GitHub, então não é mais necessária.`
        : `${repo}\n\nEla ainda tem alterações ou commits que não foram para o GitHub, então não vou apagar.`,
      buttons);
    const picked = buttons[choice];
    if (picked === 'Mandar a cópia antiga para a Lixeira') {
      await shell.trashItem(repo);
      removeRepo(repo);
    } else if (picked === 'Só tirar da lista') {
      removeRepo(repo);
    }
    store.set('selectedRepo', linked);
    return { path: linked, message: LINK_MESSAGES[result] };
  },
  // A local-only repo gets connected to a GitHub repository.
  async 'repo:connect'(repo, url) {
    const c = await activeCredentials();
    const { result } = await git.link(repo, url, c);
    rememberAccount(repo, c.login);
    return { path: repo, message: LINK_MESSAGES[result] };
  },

  // --- open in
  async 'apps:list'() {
    const { editors, clis } = await apps.detect();
    return { editors, clis, custom: store.get('customApps'), openWith: store.get('openWith') };
  },
  async 'apps:open'(id, dir) {
    const { editors, clis } = await apps.detect();
    const target = [...editors, ...clis, ...store.get('customApps')].find((a) => a.id === id);
    if (!target) throw new Error('Esse app não foi encontrado.');
    await apps.launch(target, dir);
    store.set('openWith', id);
  },
  async 'apps:addCustom'(entry) {
    const item = { ...entry, id: `custom-${Date.now()}` };
    store.set('customApps', [...store.get('customApps'), item]);
    return item;
  },
  async 'apps:removeCustom'(id) {
    store.set('customApps', store.get('customApps').filter((a) => a.id !== id));
  },
  async 'apps:pickExe'() {
    const pick = await dialog.showOpenDialog(win, {
      title: 'Escolha o programa',
      defaultPath: process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : undefined,
      filters: [{ name: 'Programas', extensions: ['exe', 'cmd', 'bat'] }],
      properties: ['openFile'],
    });
    return pick.canceled ? null : pick.filePaths[0] || null;
  },

  // --- shell
  async 'shell:folder'(p) {
    await shell.openPath(p);
  },
  async 'shell:url'(url) {
    if (/^https:\/\/github\.com\//.test(url)) await shell.openExternal(url);
  },
};

for (const [name, fn] of Object.entries(handlers)) {
  ipcMain.handle(name, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    title: 'GitSwitch',
    backgroundColor: '#14161a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('focus', () => win.webContents.send('window:focus'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

// Matches build.appId so the Start menu shortcut and the taskbar group agree.
app.setAppUserModelId('com.danilogiles.gitswitch');

// Lets a dev copy run next to the installed app without sharing its settings.
if (process.env.GITSWITCH_DATA) app.setPath('userData', process.env.GITSWITCH_DATA);

app.whenReady().then(() => {
  let warned = false;
  store = new Store(app.getPath('userData'), (err) => {
    if (warned || !win) return;
    warned = true;
    win.webContents.send('store:error', `Não consegui salvar as configurações em ${store.file}: ${err.message}`);
  });
  createWindow();
  apps.detect().catch(() => {});
});

app.on('window-all-closed', () => app.quit());
