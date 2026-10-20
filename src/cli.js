#!/usr/bin/env node
// gitswitch: GitSwitch from the terminal, built for people and coding agents.
// Every command can answer in JSON (--json or GITSWITCH_JSON=1), never
// prompts, and exits with a fixed code per kind of failure.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Store } = require('./store');
const accounts = require('./accounts');
const git = require('./git');
const scanner = require('./scanner');
const apps = require('./apps');
const install = require('./install');
const tools = require('./tools');
const { switchAccount } = require('./switch');

const EXIT = { ok: 0, failed: 1, usage: 2, auth: 3, notfound: 4 };
const KIND_EXIT = { usage: EXIT.usage, auth: EXIT.auth, notfound: EXIT.notfound, notrepo: EXIT.notfound, 'missing-ref': EXIT.notfound };

const COMMANDS = {
  accounts: { usage: 'gitswitch accounts', summary: 'Contas do GitHub logadas no gh, com identidade de commit e pasta' },
  whoami: { usage: 'gitswitch whoami [caminho] [--as login]', summary: 'Qual conta será usada neste repositório e por quê' },
  status: { usage: 'gitswitch status [caminho]', summary: 'Branch, upstream, ahead/behind, arquivos alterados, stashes e merge' },
  git: { usage: 'gitswitch git [--as login] [-C caminho] -- <argumentos do git>', summary: 'Roda qualquer comando git autenticado com a conta certa' },
  gh: { usage: 'gitswitch gh [--as login] [-C caminho] -- <argumentos do gh>', summary: 'Roda o GitHub CLI com o token da conta certa' },
  fetch: { usage: 'gitswitch fetch [caminho] [--as login]', summary: 'Busca as alterações do GitHub' },
  pull: { usage: 'gitswitch pull [caminho] [--as login]', summary: 'Traz e junta os commits do GitHub' },
  push: { usage: 'gitswitch push [caminho] [--as login] [--force]', summary: 'Envia a branch (publica se ainda não existe; --force usa --force-with-lease)' },
  commit: { usage: 'gitswitch commit -m "mensagem" [--all | arquivos…] [--amend] [-C caminho] [--as login]', summary: 'Commit com o nome e e-mail da conta' },
  clone: { usage: 'gitswitch clone <dono/repo | url> [--as login] [--dir pasta]', summary: 'Clona na pasta da conta e adiciona ao GitSwitch' },
  repos: { usage: 'gitswitch repos [--account login]', summary: 'Repositórios que o GitSwitch conhece' },
  use: { usage: 'gitswitch use <login> [--keep-repo]', summary: 'Troca a conta ativa do app e abre o último repositório usado com ela (devolve o caminho em "repo")' },
  folder: { usage: 'gitswitch folder <login> [caminho]', summary: 'Mostra ou define a pasta de uma conta' },
  detect: { usage: 'gitswitch detect [--add]', summary: 'Procura repositórios no disco por conta; --add adiciona os que faltam' },
  open: { usage: 'gitswitch open [caminho] [--app id]', summary: 'Abre o repositório no app padrão (ou em --app)' },
  install: { usage: 'gitswitch install [--no-skill]', summary: 'Coloca o gitswitch no PATH e instala a skill para agentes de IA' },
  help: { usage: 'gitswitch help [comando]', summary: 'Esta ajuda (com --json, a lista de comandos para máquinas)' },
};

class CliError extends Error {
  constructor(message, kind = 'usage', detail) {
    super(message);
    this.kind = kind;
    this.detail = detail;
  }
}

// ---------- arguments ----------
const VALUE_FLAGS = new Set(['as', 'account', 'dir', 'app', 'message']);

function parse(argv) {
  const out = { pos: [], opts: {}, rest: null };
  const cmd = argv[0];
  // git/gh: only leading gitswitch options are ours, the rest goes to the tool.
  const passthrough = cmd === 'git' || cmd === 'gh';
  for (let i = passthrough ? 1 : 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.rest = argv.slice(i + 1); break; }
    if (a === '-C') { out.opts.C = argv[++i]; continue; }
    if (a === '-m') { out.opts.message = argv[++i]; continue; }
    if (a === '-h') { out.opts.help = true; continue; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) out.opts[k] = v;
      else if (VALUE_FLAGS.has(k)) out.opts[k] = argv[++i];
      else out.opts[k] = true;
      continue;
    }
    if (passthrough) { out.rest = argv.slice(i); break; }
    out.pos.push(a);
  }
  if (passthrough) out.cmd = cmd;
  else out.cmd = out.pos.shift();
  return out;
}

// ---------- output ----------
let JSON_MODE = false;

function print(data, human) {
  if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: true, ...data }, null, 2)}\n`);
  else if (human) process.stdout.write(`${typeof human === 'function' ? human(data) : human}\n`);
}

function fail(err) {
  const kind = err.kind || 'failed';
  if (JSON_MODE) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: err.message, kind, detail: err.detail || undefined }, null, 2)}\n`);
  } else {
    process.stderr.write(`gitswitch: ${err.message}\n`);
    if (err.detail && process.env.GITSWITCH_VERBOSE) process.stderr.write(`${err.detail}\n`);
  }
  process.exitCode = KIND_EXIT[kind] ?? EXIT.failed;
}

const progress = (p) => { if (!JSON_MODE && process.stderr.isTTY) process.stderr.write(`\r${p.text}\x1b[K`); };
const endProgress = () => { if (!JSON_MODE && process.stderr.isTTY) process.stderr.write('\r\x1b[K'); };

// ---------- state ----------
const store = new Store();
tools.setPreference(store.get('settings')?.tools);
const overrides = () => store.get('identities');
const samePath = (a, b) => Boolean(a && b) && path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();

async function allAccounts() {
  const list = await accounts.list(overrides());
  if (!list.length) throw new CliError('Nenhuma conta do GitHub logada. Rode: gh auth login', 'auth');
  const active = list.some((a) => a.login === store.get('activeAccount'))
    ? store.get('activeAccount')
    : (list.find((a) => a.ghActive) || list[0]).login;
  return list.map((a) => ({ ...a, active: a.login === active, folder: store.get('accountDirs')[a.login] || null }));
}

async function repoRoot(dir) {
  try {
    return await git.toplevel(dir);
  } catch {
    return null;
  }
}

// --as > the repo's remembered account > the remote's owner (or its org) > active.
async function resolve(dir, asLogin) {
  const list = await allAccounts();
  const find = (login) => list.find((a) => a.login.toLowerCase() === String(login).toLowerCase());
  const root = await repoRoot(dir);
  const remote = root ? await git.remoteUrl(root) : null;
  const pick = (a, reason) => ({ account: a, reason, root, remote });
  if (asLogin) {
    const a = find(asLogin);
    if (!a) throw new CliError(`A conta ${asLogin} não está logada. Contas: ${list.map((x) => x.login).join(', ')}`, 'notfound');
    return pick(a, 'flag');
  }
  const rec = root && store.get('repos').find((r) => samePath(r.path, root));
  if (rec?.account && find(rec.account)) return pick(find(rec.account), 'repo');
  const owner = scanner.parseGithub(remote)?.owner?.toLowerCase();
  if (owner) {
    const byLogin = list.find((a) => a.login.toLowerCase() === owner);
    if (byLogin) return pick(byLogin, 'owner');
    const byOrg = list.find((a) => (a.orgs || []).some((o) => o.toLowerCase() === owner));
    if (byOrg) return pick(byOrg, 'owner');
  }
  return pick(list.find((a) => a.active), 'active');
}

async function needRepo(dir) {
  const root = await repoRoot(dir);
  if (!root) throw new CliError(`${dir} não é um repositório Git.`, 'notrepo');
  return root;
}

function rememberRepo(root, login) {
  const repos = store.get('repos');
  const rec = repos.find((r) => samePath(r.path, root));
  if (rec) store.set('repos', repos.map((r) => (r === rec ? { ...r, account: login } : r)));
}

function addRepo(p, login) {
  const norm = path.normalize(p);
  const repos = store.get('repos').filter((r) => !samePath(r.path, norm));
  repos.push({ path: norm, name: path.basename(norm), account: login ?? null });
  repos.sort((a, b) => a.name.localeCompare(b.name));
  store.set('repos', repos);
}

const REASONS = {
  flag: 'escolhida com --as',
  repo: 'última conta usada com este repositório',
  owner: 'dona do repositório no GitHub',
  active: 'conta ativa do app',
};

// ---------- commands ----------
const run = {
  async accounts() {
    const list = await allAccounts();
    print({
      accounts: list.map((a) => ({
        login: a.login, name: a.name, active: a.active, ghActive: a.ghActive, orgs: a.orgs || [],
        identity: a.identity, folder: a.folder,
      })),
    }, (d) => d.accounts.map((a) => `${a.active ? '*' : ' '} ${a.login.padEnd(20)} ${a.identity.name} <${a.identity.email}>${a.folder ? `  ${a.folder}` : ''}`).join('\n'));
  },

  async whoami({ pos, opts }) {
    const r = await resolve(opts.C || pos[0] || process.cwd(), opts.as);
    print({
      account: r.account.login, reason: r.reason, identity: r.account.identity, repo: r.root, remote: r.remote,
    }, (d) => `${d.account} (${REASONS[d.reason]})\ncommits como ${d.identity.name} <${d.identity.email}>${d.repo ? `\nrepositório: ${d.repo}` : ''}`);
  },

  async status({ pos, opts }) {
    const root = await needRepo(opts.C || pos[0] || process.cwd());
    const [st, remote, merging, stashes, head, who] = await Promise.all([
      git.status(root), git.remoteUrl(root), git.isMerging(root), git.stashList(root), git.headCommit(root),
      resolve(root, opts.as),
    ]);
    print({
      repo: root, account: who.account.login, accountReason: who.reason, remote,
      branch: st.branch, upstream: st.upstream, ahead: st.ahead, behind: st.behind,
      merging, initial: st.initial, head, files: st.files, stashes,
    }, (d) => [
      `${d.repo}  [${d.account}]`,
      `branch ${d.branch || '(detached)'}${d.upstream ? ` → ${d.upstream}` : ' (não publicada)'}  ↑${d.ahead} ↓${d.behind}${d.merging ? '  JUNTANDO' : ''}`,
      d.files.length ? d.files.map((f) => `  ${f.kind.padEnd(9)} ${f.orig ? `${f.orig} → ` : ''}${f.path}`).join('\n') : '  sem alterações',
      d.stashes.length ? `${d.stashes.length} stash(es)` : '',
    ].filter(Boolean).join('\n'));
  },

  // Passthrough: the account's credentials and identity, everything else as typed.
  async git({ opts, rest }) {
    await passthrough('git', rest, opts, (a) => ({ args: [...git.identityArgs(a), ...rest], env: git.accountEnv(a) }));
  },

  async gh({ opts, rest }) {
    await passthrough('gh', rest, opts, (a) => ({
      args: rest,
      env: { GH_TOKEN: a.token, GH_HOST: 'github.com', ...(process.stdin.isTTY ? {} : { GH_PROMPT_DISABLED: '1' }) },
    }));
  },

  async fetch({ pos, opts }) {
    const root = await needRepo(opts.C || pos[0] || process.cwd());
    const who = await resolve(root, opts.as);
    const creds = await accounts.credentials(who.account.login, overrides());
    await git.fetchAll(root, creds, progress).finally(endProgress);
    const st = await git.status(root);
    print({ action: 'fetch', account: creds.login, branch: st.branch, ahead: st.ahead, behind: st.behind },
      (d) => `fetch ok como ${d.account}: ↑${d.ahead} ↓${d.behind}`);
  },

  async pull({ pos, opts }) {
    const root = await needRepo(opts.C || pos[0] || process.cwd());
    const who = await resolve(root, opts.as);
    const creds = await accounts.credentials(who.account.login, overrides());
    await git.pull(root, creds, progress).finally(endProgress);
    rememberRepo(root, creds.login);
    print({ action: 'pull', account: creds.login }, (d) => `pull ok como ${d.account}`);
  },

  async push({ pos, opts }) {
    const root = await needRepo(opts.C || pos[0] || process.cwd());
    const who = await resolve(root, opts.as);
    const creds = await accounts.credentials(who.account.login, overrides());
    const st = await git.status(root);
    if (!st.branch) throw new CliError('Você está fora de uma branch (HEAD destacado). Crie uma branch antes de enviar.', 'usage');
    await git.push(root, creds, { upstream: Boolean(st.upstream), force: Boolean(opts.force) }, progress).finally(endProgress);
    rememberRepo(root, creds.login);
    print({ action: st.upstream ? 'push' : 'publish', account: creds.login, branch: st.branch, forced: Boolean(opts.force) },
      (d) => `${d.action === 'publish' ? 'branch publicada' : 'push ok'} como ${d.account} (${d.branch})`);
  },

  async commit({ pos, opts }) {
    if (!opts.message) throw new CliError('Falta a mensagem: use -m "mensagem".');
    const root = await needRepo(opts.C || process.cwd());
    const who = await resolve(root, opts.as);
    const creds = await accounts.credentials(who.account.login, overrides());
    const st = await git.status(root);
    let files;
    if (opts.all) files = st.files;
    else {
      const wanted = pos.map((p) => path.relative(root, path.resolve(opts.C || process.cwd(), p)).replaceAll('\\', '/'));
      files = st.files.filter((f) => wanted.some((w) => f.path === w || f.path.startsWith(`${w}/`) || f.orig === w));
      const missing = wanted.filter((w) => !files.some((f) => f.path === w || f.path.startsWith(`${w}/`) || f.orig === w));
      if (missing.length) throw new CliError(`Sem alterações em: ${missing.join(', ')}`, 'notfound');
    }
    if (!files.length && !opts.amend) throw new CliError('Nada para commitar. Diga os arquivos ou use --all.');
    if (st.merging) files = st.files;
    await git.commit(root, creds, files, opts.message, { initial: st.initial, merging: st.merging, amend: Boolean(opts.amend) });
    rememberRepo(root, creds.login);
    const head = await git.headCommit(root);
    print({ action: opts.amend ? 'amend' : 'commit', account: creds.login, identity: { name: creds.name, email: creds.email }, sha: head?.sha, files: files.map((f) => f.path) },
      (d) => `${d.action === 'amend' ? 'emendado' : 'commit'} ${d.sha?.slice(0, 7)} como ${d.identity.name} <${d.identity.email}> (${d.files.length} arquivo(s))`);
  },

  async clone({ pos, opts }) {
    const spec = pos[0];
    if (!spec) throw new CliError('Diga o repositório: gitswitch clone dono/repo');
    const url = /^(https?:|git@)/.test(spec) ? spec : `https://github.com/${spec.replace(/\.git$/, '')}.git`;
    const parsed = scanner.parseGithub(url);
    const list = await allAccounts();
    let account;
    if (opts.as) {
      account = list.find((a) => a.login.toLowerCase() === opts.as.toLowerCase());
      if (!account) throw new CliError(`A conta ${opts.as} não está logada.`, 'notfound');
    } else {
      const owner = parsed?.owner?.toLowerCase();
      account = list.find((a) => a.login.toLowerCase() === owner)
        || list.find((a) => (a.orgs || []).some((o) => o.toLowerCase() === owner))
        || list.find((a) => a.active);
    }
    const parent = opts.dir || account.folder || store.get('cloneDir') || path.join(os.homedir(), 'GitHub');
    const dest = path.join(parent, parsed?.repo || path.basename(url, '.git'));
    if (fs.existsSync(dest)) throw new CliError(`Já existe ${dest}.`, 'usage');
    fs.mkdirSync(parent, { recursive: true });
    const creds = await accounts.credentials(account.login, overrides());
    await git.clone(url, dest, creds, progress).finally(endProgress);
    addRepo(dest, account.login);
    print({ action: 'clone', account: account.login, path: dest, url }, (d) => `clonado em ${d.path} como ${d.account}`);
  },

  async repos({ opts }) {
    const repos = store.get('repos').filter((r) => !opts.account || r.account === opts.account);
    print({ repos, active: store.get('activeAccount'), lastRepoByAccount: store.get('lastRepoByAccount') }, (d) => (d.repos.length ? d.repos.map((r) => `${(r.account || '-').padEnd(20)} ${r.path}`).join('\n') : 'nenhum repositório'));
  },

  async use({ pos, opts }) {
    const login = pos[0];
    if (!login) throw new CliError('Diga a conta: gitswitch use <login>');
    const list = await allAccounts();
    const a = list.find((x) => x.login.toLowerCase() === login.toLowerCase());
    if (!a) throw new CliError(`A conta ${login} não está logada. Contas: ${list.map((x) => x.login).join(', ')}`, 'notfound');
    const repo = switchAccount(store, a.login, { keepRepo: Boolean(opts['keep-repo']) });
    if (store.get('syncGlobal')) await accounts.syncGlobal(a.login, overrides());
    print({
      active: a.login, repo, folder: store.get('accountDirs')[a.login] || null,
      identity: a.identity, syncedTerminal: Boolean(store.get('syncGlobal')),
    }, (d) => [`conta ativa: ${d.active}`, d.repo ? `repositório: ${d.repo}` : 'nenhum repositório usado com essa conta ainda'].join('\n'));
  },

  async folder({ pos }) {
    const [login, dir] = pos;
    if (!login) throw new CliError('Diga a conta: gitswitch folder <login> [caminho]');
    if (dir) {
      const abs = path.resolve(dir);
      if (!fs.existsSync(abs)) throw new CliError(`A pasta ${abs} não existe.`, 'notfound');
      store.set('accountDirs', { ...store.get('accountDirs'), [login]: abs });
    }
    const folder = store.get('accountDirs')[login] || null;
    print({ account: login, folder }, (d) => d.folder || 'sem pasta definida');
  },

  async detect({ opts }) {
    const list = await allAccounts();
    const found = await scanner.detect(list);
    const known = store.get('repos');
    const missing = [];
    const folders = {};
    for (const a of list) {
      folders[a.login] = found[a.login]?.folder || null;
      for (const r of found[a.login]?.repos || []) {
        if (!known.some((k) => samePath(k.path, r.path)) && !missing.some((m) => samePath(m.path, r.path))) {
          missing.push({ path: r.path, fullName: `${r.owner}/${r.repo}`, account: a.login });
        }
      }
    }
    if (opts.add) {
      for (const m of missing) addRepo(m.path, m.account);
      const dirs = { ...store.get('accountDirs') };
      for (const [login, f] of Object.entries(folders)) if (f && !dirs[login]) dirs[login] = f;
      store.set('accountDirs', dirs);
    }
    print({ folders, missing, added: Boolean(opts.add) }, (d) => [
      ...Object.entries(d.folders).map(([l, f]) => `${l.padEnd(20)} ${f || '(nenhuma pasta encontrada)'}`),
      d.missing.length ? `${d.missing.length} repositório(s) fora do GitSwitch${d.added ? ' (adicionados)' : ' — use --add'}:` : 'todos os repositórios já estão no GitSwitch',
      ...d.missing.map((m) => `  ${m.account.padEnd(18)} ${m.path}`),
    ].join('\n'));
  },

  async open({ pos, opts }) {
    const root = await needRepo(pos[0] || process.cwd());
    const { editors, clis } = await apps.detect();
    const all = [...editors, ...clis, ...store.get('customApps')];
    const id = opts.app || store.get('openWith');
    const target = all.find((a) => a.id === id) || editors[0];
    if (!target) throw new CliError(`App não encontrado. Disponíveis: ${all.map((a) => a.id).join(', ')}`, 'notfound');
    await apps.launch(target, root);
    print({ opened: root, app: target.id }, (d) => `abrindo ${d.opened} em ${target.name}`);
  },

  async install({ opts }) {
    const cli = await install.installCli();
    const skill = opts['no-skill'] ? null : install.installSkill();
    print({ cli, skill }, (d) => [
      `comando instalado em ${d.cli.bin} (${d.cli.path === 'added' ? 'adicionado ao PATH: abra um terminal novo' : 'já estava no PATH'})`,
      d.skill ? `skill para IA instalada em: ${d.skill.installed.join(', ')}` : '',
    ].filter(Boolean).join('\n'));
  },

  async help({ pos }) {
    const name = pos[0];
    if (name && !COMMANDS[name]) throw new CliError(`Comando desconhecido: ${name}`);
    const list = name ? { [name]: COMMANDS[name] } : COMMANDS;
    print({
      commands: list,
      json: 'Acrescente --json (ou GITSWITCH_JSON=1) para respostas em JSON com "ok".',
      exitCodes: { 0: 'ok', 1: 'git/gh falhou', 2: 'uso errado', 3: 'autenticação ou permissão', 4: 'não encontrado' },
      accountResolution: ['--as <login>', 'conta lembrada do repositório', 'dona do remote origin (ou da organização)', 'conta ativa do app'],
    }, () => [
      'gitswitch: o Git com a conta certa do GitHub, para você e para agentes de IA.',
      '',
      ...Object.values(list).map((c) => `  ${c.usage}\n      ${c.summary}`),
      '',
      'Acrescente --json para respostas em JSON. Códigos de saída: 0 ok, 1 falhou, 2 uso, 3 autenticação, 4 não encontrado.',
    ].join('\n'));
  },
};

async function passthrough(tool, rest, opts, build) {
  if (!rest || !rest.length) throw new CliError(`Diga o comando: gitswitch ${tool} -- <argumentos>`);
  const cwd = opts.C ? path.resolve(opts.C) : process.cwd();
  const who = await resolve(cwd, opts.as);
  const creds = await accounts.credentials(who.account.login, overrides());
  const { args, env } = build(creds);
  const child = spawn(tools.bin(tool), args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...env },
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; if (!JSON_MODE) process.stdout.write(d); });
  child.stderr.on('data', (d) => { stderr += d; if (!JSON_MODE) process.stderr.write(d); });
  const code = await new Promise((res, rej) => { child.on('error', rej); child.on('close', res); });
  if (code === 0 && who.root && tool === 'git' && /^(push|commit|pull)$/.test(rest[0])) rememberRepo(who.root, creds.login);
  const hint = code === 0 ? null : git.friendly({ output: stderr || stdout });
  if (JSON_MODE) {
    process.stdout.write(`${JSON.stringify({
      ok: code === 0, code, account: creds.login, accountReason: who.reason, stdout, stderr,
      ...(hint ? { error: hint.message, kind: hint.kind } : {}),
    }, null, 2)}\n`);
  } else if (hint && hint.kind !== 'git') {
    process.stderr.write(`gitswitch [${creds.login}]: ${hint.message}\n`);
  }
  process.exitCode = code === 0 ? 0 : (KIND_EXIT[hint?.kind] ?? EXIT.failed);
}

async function main() {
  const argv = process.argv.slice(2);
  const p = parse(argv);
  JSON_MODE = Boolean(p.opts.json) || process.env.GITSWITCH_JSON === '1';
  if (!p.cmd || p.opts.help || p.cmd === '--help') return run.help({ pos: p.cmd && p.cmd !== '--help' ? [p.cmd] : [] });
  if (p.cmd === 'version' || p.opts.version) {
    let version = 'dev';
    try { version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version; } catch { /* packaged */ }
    return print({ version }, (d) => d.version);
  }
  const fn = run[p.cmd];
  if (!fn) throw new CliError(`Comando desconhecido: ${p.cmd}. Veja: gitswitch help`);
  return fn(p);
}

main().catch(fail);
