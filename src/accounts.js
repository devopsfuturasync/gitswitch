const { run } = require('./run');
const tools = require('./tools');
const github = require('./github');
const vault = require('./vault');

const HOST = 'github.com';

// login -> { token, profile }. Tokens stay in the main process only.
const cache = new Map();

// gh's tokenSource -> where the token sits: the system keyring (encrypted),
// gh's hosts.yml (plain text), or an environment variable.
function storageOf(tokenSource) {
  if (tokenSource === 'keyring') return 'keyring';
  if (/^(GH|GITHUB)_(ENTERPRISE_)?TOKEN$/.test(tokenSource || '')) return 'env';
  if (/hosts\.ya?ml$/i.test(tokenSource || '')) return 'plaintext';
  return 'unknown';
}

// gh without our own GH_TOKEN, so it reports what is stored, not what we pass.
const ghEnv = (extra = {}) => ({ GH_TOKEN: '', GITHUB_TOKEN: '', GH_PROMPT_DISABLED: '1', ...extra });

async function ghAccounts(configDir) {
  try {
    const { stdout } = await run(tools.bin('gh'), ['auth', 'status', '--hostname', HOST, '--json', 'hosts'], {
      allowCodes: [0, 1], env: ghEnv(configDir ? { GH_CONFIG_DIR: configDir } : {}),
    });
    return (JSON.parse(stdout || '{}').hosts?.[HOST] || []).filter((a) => a.state === 'success');
  } catch {
    return [];
  }
}

// Every github.com account: the ones logged in with `gh auth login` and the
// ones kept in GitSwitch's vault.
async function listLogins() {
  const inVault = new Set(vault.logins());
  const gh = await ghAccounts();
  const out = gh.map((a) => ({
    login: a.login, ghActive: Boolean(a.active),
    storage: inVault.has(a.login) ? 'vault' : storageOf(a.tokenSource),
    ...(inVault.has(a.login) ? { ghStorage: storageOf(a.tokenSource) } : {}),
  }));
  for (const login of inVault) if (!out.some((a) => a.login === login)) out.push({ login, ghActive: false, storage: 'vault' });
  return out;
}

// Where vault tokens come from: this process's unlocked vault by default; the
// app adds "ask the user to unlock", the CLI adds "ask the running app".
let vaultSource = async (login) => (vault.isUnlocked() ? vault.get(login) : null);
function setVaultSource(fn) { vaultSource = fn; }

function lockedError(login) {
  const err = new Error(`GitSwitch's vault is locked. Open GitSwitch and unlock it to use ${login}.`);
  err.kind = 'auth';
  err.code = 'locked';
  return err;
}

// interactive: false never prompts (used while just listing accounts).
async function token(login, { interactive = true } = {}) {
  const hit = cache.get(login);
  if (hit?.token) return hit.token;
  let value;
  if (vault.logins().includes(login)) {
    value = await vaultSource(login, { interactive });
    if (!value) throw lockedError(login);
  } else {
    const { stdout } = await run(tools.bin('gh'), ['auth', 'token', '--hostname', HOST, '--user', login], { env: ghEnv() });
    value = stdout.trim();
  }
  cache.set(login, { ...hit, token: value });
  return value;
}

async function profile(login) {
  const hit = cache.get(login);
  if (hit?.profile) return hit.profile;
  let t;
  try {
    t = await token(login, { interactive: false });
  } catch (err) {
    if (err.code !== 'locked') throw err;
    return { login, id: null, name: null, email: null, avatarUrl: null, orgs: [], locked: true }; // not cached
  }
  let p;
  try {
    const [u, orgs] = await Promise.all([github.api(t, '/user'), github.api(t, '/user/orgs').catch(() => [])]);
    p = { login: u.login, id: u.id, name: u.name, email: u.email, avatarUrl: u.avatar_url, orgs: orgs.map((o) => o.login) };
  } catch {
    p = { login, id: null, name: null, email: null, avatarUrl: null, orgs: [] };
  }
  cache.set(login, { ...cache.get(login), profile: p });
  return p;
}

// Name and e-mail that commits made with this account carry.
function identity(p, override = {}) {
  const noreply = p.id ? `${p.id}+${p.login}@users.noreply.github.com` : `${p.login}@users.noreply.github.com`;
  return {
    name: override.name || p.name || p.login,
    email: override.email || p.email || noreply,
  };
}

async function list(overrides = {}) {
  const logins = await listLogins();
  return Promise.all(logins.map(async ({ login, ghActive, storage, ghStorage }) => {
    const p = await profile(login);
    return { ...p, ghActive, storage, ...(ghStorage ? { ghStorage } : {}), identity: identity(p, overrides[login]) };
  }));
}

// Everything git needs to act as this account.
async function credentials(login, overrides = {}) {
  const [t, p] = await Promise.all([token(login), profile(login)]);
  return { login, token: t, ...identity(p, overrides[login]) };
}

function clearCache() {
  cache.clear();
}

// Optional: make the terminal (gh + global git) use the same account.
async function syncGlobal(login, overrides = {}) {
  const c = await credentials(login, overrides);
  if (!vault.logins().includes(login)) await run(tools.bin('gh'), ['auth', 'switch', '--hostname', HOST, '--user', login], { env: ghEnv() });
  await run(tools.bin('git'), ['config', '--global', 'user.name', c.name]);
  await run(tools.bin('git'), ['config', '--global', 'user.email', c.email]);
  await run(tools.bin('git'), ['config', '--global', `credential.https://${HOST}.username`, login]);
}

// ---------- moving tokens between gh and the vault ----------

// gh -> vault: copy the token in, then log gh out so its copy (plain text or
// keyring) is deleted. The token itself stays valid on GitHub.
async function moveToVault(login) {
  const { stdout } = await run(tools.bin('gh'), ['auth', 'token', '--hostname', HOST, '--user', login], { env: ghEnv() });
  vault.set(login, stdout.trim());
  await run(tools.bin('gh'), ['auth', 'logout', '--hostname', HOST, '--user', login], { env: ghEnv(), allowCodes: [0, 1] });
  cache.delete(login);
}

// vault -> gh: gh stores it in the system keyring when there is one.
async function moveToGh(login) {
  const t = vault.get(login);
  if (!t) throw new Error(`${login} is not in the vault.`);
  await run(tools.bin('gh'), ['auth', 'login', '--hostname', HOST, '--git-protocol', 'https', '--with-token'], { env: ghEnv(), input: `${t}\n` });
  vault.remove(login);
  cache.delete(login);
}

// Accounts logged in under a separate GH_CONFIG_DIR (new logins that go
// straight to the vault): move each into the vault and return their logins.
async function importFrom(configDir) {
  const found = await ghAccounts(configDir);
  const added = [];
  for (const a of found) {
    const { stdout } = await run(tools.bin('gh'), ['auth', 'token', '--hostname', HOST, '--user', a.login], { env: ghEnv({ GH_CONFIG_DIR: configDir }) });
    vault.set(a.login, stdout.trim());
    cache.delete(a.login);
    added.push(a.login);
  }
  return added;
}

module.exports = { list, credentials, clearCache, syncGlobal, setVaultSource, moveToVault, moveToGh, importFrom, storageOf, HOST };
