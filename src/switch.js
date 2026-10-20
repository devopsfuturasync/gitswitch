// Switching accounts, shared by the app and the gitswitch CLI: each account
// remembers the repository it was last used in, and switching opens it.
const fs = require('node:fs');
const path = require('node:path');

const samePath = (a, b) => Boolean(a && b) && path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();

// Records repoPath as the last repository used with the active account.
function rememberRepoForAccount(store, repoPath) {
  const login = store.get('activeAccount');
  if (!login || !repoPath) return;
  store.set('lastRepoByAccount', { ...store.get('lastRepoByAccount'), [login]: repoPath });
}

// The last repository used with login, else one tagged with it; must still exist.
function lastRepoFor(store, login) {
  const repos = store.get('repos');
  const usable = (p) => repos.some((r) => samePath(r.path, p)) && fs.existsSync(p);
  const last = store.get('lastRepoByAccount')?.[login];
  if (last && usable(last)) return repos.find((r) => samePath(r.path, last)).path;
  return repos.find((r) => r.account === login && fs.existsSync(r.path))?.path || null;
}

// Makes login active. Unless keepRepo, also selects that account's last
// repository. Returns the repository now selected (or null).
function switchAccount(store, login, { keepRepo = false } = {}) {
  store.set('activeAccount', login);
  if (keepRepo) {
    rememberRepoForAccount(store, store.get('selectedRepo'));
    return store.get('selectedRepo');
  }
  const repo = lastRepoFor(store, login);
  if (repo) store.set('selectedRepo', repo);
  return repo;
}

module.exports = { switchAccount, rememberRepoForAccount, lastRepoFor };
