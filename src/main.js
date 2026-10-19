const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { Store } = require('./store');
const accounts = require('./accounts');
const github = require('./github');
const git = require('./git');

let win;
let store;

function overrides() {
  return store.get('identities');
}

async function activeCredentials() {
  const login = store.get('activeAccount');
  if (!login) throw new Error('Escolha uma conta do GitHub primeiro.');
  return accounts.credentials(login, overrides());
}

function rememberAccount(repoPath, login) {
  const repos = store.get('repos').map((r) => (r.path === repoPath ? { ...r, account: login } : r));
  store.set('repos', repos);
}

function addRepo(repoPath, account) {
  const repos = store.get('repos').filter((r) => r.path !== repoPath);
  repos.push({ path: repoPath, name: path.basename(repoPath), account: account ?? null });
  repos.sort((a, b) => a.name.localeCompare(b.name));
  store.set('repos', repos);
  store.set('selectedRepo', repoPath);
  return repoPath;
}

// Opens a separate console so the user can finish the browser login there.
function openLoginConsole() {
  spawn('cmd.exe', ['/k', `gh auth login --hostname ${accounts.HOST} --web --git-protocol https`], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

const handlers = {
  // --- accounts
  async 'accounts:list'() {
    const list = await accounts.list(overrides());
    let active = store.get('activeAccount');
    if (!list.some((a) => a.login === active)) {
      active = (list.find((a) => a.ghActive) || list[0])?.login ?? null;
      store.set('activeAccount', active);
    }
    return { accounts: list, active, syncGlobal: store.get('syncGlobal') };
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

  // --- local repositories
  async 'repos:list'() {
    return { repos: store.get('repos'), selected: store.get('selectedRepo') };
  },
  async 'repos:select'(repoPath) {
    store.set('selectedRepo', repoPath);
  },
  async 'repos:remove'(repoPath) {
    store.set('repos', store.get('repos').filter((r) => r.path !== repoPath));
    if (store.get('selectedRepo') === repoPath) store.set('selectedRepo', store.get('repos')[0]?.path ?? null);
  },
  async 'repos:addExisting'() {
    const pick = await dialog.showOpenDialog(win, { title: 'Adicionar repositório local', properties: ['openDirectory'] });
    if (pick.canceled || !pick.filePaths[0]) return null;
    const dir = pick.filePaths[0];
    try {
      return addRepo(await git.toplevel(dir), null);
    } catch {
      const answer = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Criar repositório', 'Cancelar'],
        defaultId: 0,
        cancelId: 1,
        message: 'Essa pasta não é um repositório Git.',
        detail: `Quer criar um repositório novo em:\n${dir}`,
      });
      if (answer.response !== 0) return null;
      await git.init(dir);
      return addRepo(path.normalize(dir), null);
    }
  },
  async 'repos:remote'() {
    const c = await activeCredentials();
    return github.repos(c.token);
  },
  async 'repos:chooseCloneDir'() {
    const pick = await dialog.showOpenDialog(win, {
      title: 'Pasta onde clonar',
      defaultPath: store.get('cloneDir') || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (pick.canceled || !pick.filePaths[0]) return null;
    store.set('cloneDir', pick.filePaths[0]);
    return pick.filePaths[0];
  },
  async 'repos:cloneDir'() {
    return store.get('cloneDir') || path.join(app.getPath('home'), 'GitHub');
  },
  async 'repos:clone'(url, parentDir, name) {
    const c = await activeCredentials();
    const dest = path.join(parentDir, name);
    await require('node:fs/promises').mkdir(parentDir, { recursive: true });
    await git.clone(url, dest, c);
    store.set('cloneDir', parentDir);
    return addRepo(dest, c.login);
  },

  // --- working with a repository
  async 'repo:info'(repo) {
    const [status, remoteUrl] = await Promise.all([git.status(repo), git.remoteUrl(repo)]);
    return { ...status, remoteUrl };
  },
  async 'repo:diff'(repo, file, initial) {
    return git.diff(repo, file, initial);
  },
  async 'repo:commit'(repo, files, message, initial) {
    const c = await activeCredentials();
    await git.commit(repo, c, files, message, initial);
    rememberAccount(repo, c.login);
  },
  async 'repo:discard'(repo, files, initial) {
    const names = files.map((f) => f.path);
    const answer = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Descartar', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      message: names.length === 1 ? `Descartar as alterações em ${names[0]}?` : `Descartar as alterações em ${names.length} arquivos?`,
      detail: 'Arquivos novos vão para a Lixeira. Alterações em arquivos existentes são perdidas.',
    });
    if (answer.response !== 0) return false;
    await git.discard(repo, files, initial, (p) => shell.trashItem(p));
    return true;
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

  // --- shell
  async 'shell:folder'(p) {
    await shell.openPath(p);
  },
  async 'shell:code'(p) {
    spawn('cmd.exe', ['/c', 'code', p], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
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

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  createWindow();
});

app.on('window-all-closed', () => app.quit());
