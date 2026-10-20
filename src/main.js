const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, nativeTheme } = require('electron');
const { Store } = require('./store');
const accounts = require('./accounts');
const github = require('./github');
const git = require('./git');
const scanner = require('./scanner');
const apps = require('./apps');
const updater = require('./updater');

let win;
let store;

// Streams git progress ("Push: Enviando objetos 40%") to the window.
const progress = (p) => win?.webContents.send('progress', p);

const DEFAULT_SETTINGS = {
  theme: 'system',          // 'system' | 'light' | 'dark'
  hideWhitespace: false,
  tabSize: 4,
  confirmDiscard: true,
  confirmForcePush: true,
  confirmRemoveRepo: false,
  autoFetchMinutes: 5,      // 0 = off
  autoUpdate: true,
};
const settings = () => ({ ...DEFAULT_SETTINGS, ...store.get('settings') });

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
    if (settings().confirmRemoveRepo) {
      const choice = await ask('question', `Tirar ${path.basename(repoPath)} da lista?`, 'A pasta continua no computador.', ['Tirar da lista', 'Cancelar']);
      if (choice !== 0) return false;
    }
    removeRepo(repoPath);
    return true;
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
    await git.clone(url, dest, c, progress);
    store.set('cloneDir', parentDir);
    if (makeDefault) setAccountDir(c.login, parentDir);
    return addRepo(dest, c.login);
  },

  // --- working with a repository
  async 'repo:info'(repo) {
    const [status, remoteUrl, merging, stashes, head] = await Promise.all([
      git.status(repo), git.remoteUrl(repo), git.isMerging(repo), git.stashList(repo), git.headCommit(repo),
    ]);
    return { ...status, remoteUrl, merging, stashes, head };
  },
  async 'repo:diff'(repo, file, initial) {
    return git.diff(repo, file, { initial, hideWhitespace: settings().hideWhitespace });
  },
  async 'repo:commit'(repo, files, message, opts) {
    const c = await activeCredentials();
    await git.commit(repo, c, files, message, opts);
    rememberAccount(repo, c.login);
  },
  async 'repo:discard'(repo, files, initial) {
    if (settings().confirmDiscard) {
      const names = files.map((f) => f.path);
      const choice = await ask('warning',
        names.length === 1 ? `Descartar as alterações em ${names[0]}?` : `Descartar as alterações em ${names.length} arquivos?`,
        'A versão atual dos arquivos vai para a Lixeira, de onde dá para recuperar.',
        ['Descartar', 'Cancelar']);
      if (choice !== 0) return false;
    }
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
    return git.show(repo, sha, settings().hideWhitespace);
  },
  async 'repo:lastMessage'(repo) {
    return git.lastMessage(repo);
  },
  async 'repo:undo'(repo) {
    return git.undoLastCommit(repo);
  },
  async 'repo:revert'(repo, sha, parents) {
    const c = await activeCredentials();
    await git.revert(repo, c, sha, parents);
  },
  async 'repo:branches'(repo) {
    return git.branches(repo);
  },
  async 'repo:checkout'(repo, name, isRemote) {
    await git.checkout(repo, name, isRemote);
  },
  async 'repo:checkoutCommit'(repo, sha) {
    await git.checkoutCommit(repo, sha);
  },
  async 'repo:createBranch'(repo, name, from) {
    await git.createBranch(repo, name, from);
  },
  async 'repo:renameBranch'(repo, from, to) {
    await git.renameBranch(repo, from, to);
  },
  async 'repo:deleteBranch'(repo, name) {
    try {
      await git.deleteBranch(repo, name, false);
    } catch (err) {
      if (err.kind !== 'not-merged') throw err;
      const choice = await ask('warning', `A branch ${name} tem commits que não estão em nenhuma outra.`,
        'Apagar mesmo assim? Esses commits deixam de aparecer.', ['Apagar mesmo assim', 'Cancelar']);
      if (choice !== 0) return false;
      await git.deleteBranch(repo, name, true);
    }
    return true;
  },
  async 'repo:merge'(repo, branch) {
    const c = await activeCredentials();
    return git.merge(repo, c, branch);
  },
  async 'repo:fetch'(repo, background) {
    const c = await activeCredentials();
    await git.fetchAll(repo, c, background ? undefined : progress);
  },
  async 'repo:pull'(repo) {
    const c = await activeCredentials();
    await git.pull(repo, c, progress);
    rememberAccount(repo, c.login);
  },
  async 'repo:push'(repo, hasUpstream, force) {
    const c = await activeCredentials();
    if (force && settings().confirmForcePush) {
      const choice = await ask('warning', 'Forçar o envio?',
        'A branch no GitHub vai ficar igual à sua, e os commits que só existem lá serão substituídos. O envio é cancelado se alguém mandou algo novo desde o seu último Fetch.',
        ['Forçar envio', 'Cancelar']);
      if (choice !== 0) return false;
    }
    await git.push(repo, c, { upstream: hasUpstream, force }, progress);
    rememberAccount(repo, c.login);
    return true;
  },
  async 'repo:stashPush'(repo, branch) {
    const c = await activeCredentials();
    await git.stashPush(repo, c, `GitSwitch: ${branch || 'alterações'}`);
  },
  async 'repo:stashPop'(repo, ref) {
    await git.stashPop(repo, ref);
  },
  async 'repo:stashDrop'(repo, ref) {
    const choice = await ask('warning', 'Descartar estas alterações guardadas?', 'Elas não vão para a Lixeira.', ['Descartar', 'Cancelar']);
    if (choice !== 0) return false;
    await git.stashDrop(repo, ref);
    return true;
  },
  async 'repo:stashShow'(repo, ref) {
    return git.stashShow(repo, ref);
  },
  async 'repo:ignore'(repo, pattern) {
    await git.ignore(repo, pattern);
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
  async 'apps:setDefault'(id) {
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

  // --- updates
  async 'update:status'() {
    return updater.status();
  },
  async 'update:check'() {
    return updater.check();
  },
  async 'update:download'() {
    updater.download();
  },
  async 'update:install'() {
    updater.install();
  },

  // --- settings
  async 'settings:get'() {
    return { ...settings(), globalIdentity: await git.globalIdentity(), dataDir: app.getPath('userData'), version: app.getVersion() };
  },
  async 'settings:set'(patch) {
    store.set('settings', { ...settings(), ...patch });
    applySettings();
    return settings();
  },
  async 'settings:setGlobalIdentity'(identity) {
    await git.setGlobalIdentity(identity);
  },

  // --- native bits
  // items: [{ id, label, enabled?, type? }] -> the clicked id, or null.
  async 'menu:popup'(items) {
    return new Promise((resolve) => {
      let picked = null;
      const menu = Menu.buildFromTemplate(items.map((it) => (it.type === 'separator'
        ? { type: 'separator' }
        : { label: it.label, enabled: it.enabled !== false, click: () => { picked = it.id; } })));
      menu.popup({ window: win, callback: () => setTimeout(() => resolve(picked), 0) });
    });
  },
  async 'clipboard:write'(text) {
    clipboard.writeText(String(text));
  },
  async 'shell:showItem'(p) {
    shell.showItemInFolder(p);
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
      return { ok: false, error: err.message, detail: err.detail, kind: err.kind };
    }
  });
}

function applySettings() {
  const s = settings();
  nativeTheme.themeSource = s.theme;
  updater.setAutoDownload(s.autoUpdate);
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
  applySettings();
  updater.setup((s) => win?.webContents.send('update:state', s));
  apps.detect().catch(() => {});
});

app.on('window-all-closed', () => app.quit());
