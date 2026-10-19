const { run } = require('./run');
const github = require('./github');

const HOST = 'github.com';

// login -> { token, profile }. Tokens stay in the main process only.
const cache = new Map();

// Every github.com account the user has logged into with `gh auth login`.
async function listLogins() {
  let data = {};
  try {
    const { stdout } = await run('gh', ['auth', 'status', '--hostname', HOST, '--json', 'hosts'], { allowCodes: [0, 1] });
    data = JSON.parse(stdout || '{}');
  } catch {
    return [];
  }
  return (data.hosts?.[HOST] || [])
    .filter((a) => a.state === 'success')
    .map((a) => ({ login: a.login, ghActive: Boolean(a.active) }));
}

async function token(login) {
  const hit = cache.get(login);
  if (hit?.token) return hit.token;
  const { stdout } = await run('gh', ['auth', 'token', '--hostname', HOST, '--user', login]);
  const value = stdout.trim();
  cache.set(login, { ...hit, token: value });
  return value;
}

async function profile(login) {
  const hit = cache.get(login);
  if (hit?.profile) return hit.profile;
  const t = await token(login);
  let p;
  try {
    const u = await github.api(t, '/user');
    p = { login: u.login, id: u.id, name: u.name, email: u.email, avatarUrl: u.avatar_url };
  } catch {
    p = { login, id: null, name: null, email: null, avatarUrl: null };
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
  return Promise.all(logins.map(async ({ login, ghActive }) => {
    const p = await profile(login);
    return { ...p, ghActive, identity: identity(p, overrides[login]) };
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
  await run('gh', ['auth', 'switch', '--hostname', HOST, '--user', login]);
  await run('git', ['config', '--global', 'user.name', c.name]);
  await run('git', ['config', '--global', 'user.email', c.email]);
  await run('git', ['config', '--global', `credential.https://${HOST}.username`, login]);
}

module.exports = { list, credentials, clearCache, syncGlobal, HOST };
