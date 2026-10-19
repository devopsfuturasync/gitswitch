const fs = require('node:fs/promises');
const path = require('node:path');
const { run } = require('./run');

// Credential helper that answers with the chosen account's token. The token
// comes from an env var so it never shows up in the process command line.
const CRED_HELPER = '!f() { if test "$1" = get; then echo username=x-access-token; echo "password=$GITSWITCH_TOKEN"; fi; }; f';

const MAX_DIFF = 2 * 1024 * 1024;

function git(cwd, args, account, opts = {}) {
  const pre = ['-c', 'core.quotepath=false', '-c', 'color.ui=false'];
  const env = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_EDITOR: 'true', ...opts.env };
  if (account) {
    pre.push(
      '-c', 'credential.helper=',
      '-c', 'credential.https://github.com.helper=',
      '-c', `credential.helper=${CRED_HELPER}`,
      '-c', `user.name=${account.name}`,
      '-c', `user.email=${account.email}`,
    );
    env.GITSWITCH_TOKEN = account.token;
  }
  return run('git', [...pre, ...args], { ...opts, cwd, env });
}

async function toplevel(dir) {
  const { stdout } = await git(dir, ['rev-parse', '--show-toplevel']);
  return path.normalize(stdout.trim());
}

function kindOf(xy) {
  if (xy.includes('A')) return 'added';
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('R')) return 'renamed';
  if (xy.includes('C')) return 'added';
  return 'modified';
}

// Parses `git status --porcelain=v2 --branch -z`.
async function status(repo) {
  const { stdout } = await git(repo, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']);
  const parts = stdout.split('\0');
  const res = { branch: null, upstream: null, ahead: 0, behind: 0, initial: false, files: [] };
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) res.initial = line.endsWith('(initial)');
    else if (line.startsWith('# branch.head ')) res.branch = line.slice(14);
    else if (line.startsWith('# branch.upstream ')) res.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) { res.ahead = Number(m[1]); res.behind = Number(m[2]); }
    } else if (line[0] === '1') {
      const f = line.split(' ');
      res.files.push({ path: f.slice(8).join(' '), kind: kindOf(f[1]) });
    } else if (line[0] === '2') {
      const f = line.split(' ');
      res.files.push({ path: f.slice(9).join(' '), orig: parts[++i], kind: 'renamed' });
    } else if (line[0] === 'u') {
      const f = line.split(' ');
      res.files.push({ path: f.slice(10).join(' '), kind: 'conflict' });
    } else if (line[0] === '?') {
      res.files.push({ path: line.slice(2), kind: 'untracked' });
    }
  }
  if (res.branch === '(detached)') res.branch = null;
  return res;
}

// Shows a new file as an all-added diff.
async function fileAsDiff(repo, file) {
  const buf = await fs.readFile(path.join(repo, file));
  if (buf.subarray(0, 8000).includes(0)) return `Binary files /dev/null and b/${file} differ\n`;
  if (buf.length > MAX_DIFF) return '@@ arquivo grande demais para mostrar @@\n';
  const lines = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
}

async function diff(repo, file, initial) {
  if (file.kind === 'untracked' || (initial && file.kind !== 'deleted')) {
    return fileAsDiff(repo, file.path).catch((e) => `@@ não foi possível ler o arquivo: ${e.message} @@\n`);
  }
  const paths = file.orig ? [file.orig, file.path] : [file.path];
  const { stdout } = await git(repo, ['diff', '-M', initial ? '--cached' : 'HEAD', '--', ...paths]);
  return stdout.slice(0, MAX_DIFF);
}

async function isMerging(repo) {
  const { code } = await git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], null, { allowCodes: [0, 1] });
  return code === 0;
}

async function commit(repo, account, files, message, initial, merging) {
  // Commit exactly the checked files: unstage everything, then add those.
  // During a merge nothing is unstaged, since that would drop the merge.
  if (!merging) {
    if (initial) await git(repo, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '.']);
    else await git(repo, ['reset', '-q']);
  }
  const paths = files.flatMap((f) => (f.orig ? [f.orig, f.path] : [f.path]));
  for (let i = 0; i < paths.length; i += 100) {
    await git(repo, ['add', '-A', '--', ...paths.slice(i, i + 100)]);
  }
  await git(repo, ['commit', '-F', '-'], account, { input: message });
}

async function discard(repo, files, initial, trash) {
  for (const f of files) {
    if (f.kind === 'untracked' || f.kind === 'added' || initial) {
      await git(repo, ['rm', '-q', '--cached', '--ignore-unmatch', '--', f.path]);
      await trash(path.join(repo, f.path));
    } else {
      const paths = f.orig ? [f.orig, f.path] : [f.path];
      await git(repo, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...paths]);
      if (f.orig) await trash(path.join(repo, f.path)).catch(() => {});
    }
  }
}

async function log(repo) {
  try {
    const { stdout } = await git(repo, ['log', '-n', '300', '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D%x1e']);
    return stdout.split('\x1e').filter((s) => s.trim()).map((s) => {
      const [sha, short, author, email, at, subject, refs] = s.replace(/^\n/, '').split('\x1f');
      return { sha, short, author, email, date: Number(at) * 1000, subject, refs };
    });
  } catch {
    return [];
  }
}

async function show(repo, sha) {
  const { stdout } = await git(repo, ['show', '-M', '--format=%B', sha]);
  return stdout.slice(0, MAX_DIFF);
}

async function branches(repo) {
  const { stdout } = await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
  const local = [];
  const remote = [];
  for (const ref of stdout.split('\n').filter(Boolean)) {
    if (ref.startsWith('refs/heads/')) local.push(ref.slice(11));
    else if (!ref.endsWith('/HEAD')) remote.push(ref.slice(13));
  }
  // Remote branches that already have a local copy are hidden.
  const remoteOnly = remote.filter((r) => !local.includes(r.split('/').slice(1).join('/')));
  return { local, remote: remoteOnly };
}

async function checkout(repo, name, isRemote) {
  const target = isRemote ? name.split('/').slice(1).join('/') : name;
  await git(repo, ['switch', target]);
}

async function createBranch(repo, name) {
  await git(repo, ['switch', '-c', name]);
}

async function remoteUrl(repo) {
  try {
    const { stdout } = await git(repo, ['remote', 'get-url', 'origin']);
    return stdout.trim();
  } catch {
    return null;
  }
}

function fetchAll(repo, account) {
  return git(repo, ['fetch', '--all', '--prune'], account);
}

function pull(repo, account) {
  return git(repo, ['pull', '--no-rebase', '--no-edit'], account);
}

function push(repo, account, hasUpstream) {
  return git(repo, hasUpstream ? ['push'] : ['push', '-u', 'origin', 'HEAD'], account);
}

function clone(url, dest, account) {
  return git(path.dirname(dest), ['clone', url, dest], account);
}

function init(dir) {
  return git(dir, ['init', '-b', 'main']);
}

// Settles a conflicted file with one side ('ours' = this folder, 'theirs' = GitHub).
async function resolve(repo, file, side) {
  await git(repo, ['checkout', `--${side}`, '--', file]);
  await git(repo, ['add', '--', file]);
}

function abortMerge(repo) {
  return git(repo, ['merge', '--abort']);
}

function sameRemote(a, b) {
  const norm = (u) => u.trim().toLowerCase().replace(/\.git$/, '').replace(/\/$/, '').replace(/^git@github\.com:/, 'https://github.com/');
  return norm(a) === norm(b);
}

// Connects a local folder to a GitHub repository without losing local files.
// - folder without git history: adopts GitHub's history; local files that
//   differ show up as changes, files only on GitHub are brought in.
// - folder with its own history: merges GitHub's history into it.
async function link(dir, url, account) {
  let top = null;
  try { top = await toplevel(dir); } catch { /* not a repository yet */ }
  if (top && path.normalize(top).toLowerCase() !== path.normalize(dir).toLowerCase()) {
    throw new Error(`Essa pasta fica dentro de outro repositório (${top}). Escolha a pasta principal.`);
  }
  if (!top) await init(dir);

  const current = await remoteUrl(dir);
  if (current && !sameRemote(current, url)) throw new Error(`Essa pasta já está ligada a outro repositório:\n${current}`);
  if (!current) await git(dir, ['remote', 'add', 'origin', url]);
  await git(dir, ['fetch', 'origin'], account);

  let def = null;
  try {
    await git(dir, ['remote', 'set-head', 'origin', '--auto'], account);
    const { stdout } = await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    def = stdout.trim().replace(/^origin\//, '');
  } catch { /* GitHub repo has no branches yet */ }
  if (!def) return { result: 'empty' };

  const { code } = await git(dir, ['rev-parse', '-q', '--verify', 'HEAD'], null, { allowCodes: [0, 1] });
  if (code !== 0) {
    await git(dir, ['symbolic-ref', 'HEAD', `refs/heads/${def}`]);
    await git(dir, ['reset', '-q', '--mixed', `origin/${def}`]);
    await git(dir, ['branch', '-u', `origin/${def}`]);
    const { stdout } = await git(dir, ['ls-files', '--deleted', '-z']);
    const missing = stdout.split('\0').filter(Boolean);
    for (let i = 0; i < missing.length; i += 100) {
      await git(dir, ['checkout', '--', ...missing.slice(i, i + 100)]);
    }
    return { result: 'adopted', branch: def };
  }

  const st = await status(dir);
  if (st.files.length) throw new Error('Essa pasta tem alterações sem commit. Faça commit ou descarte antes de juntar.');
  const branch = st.branch;
  try {
    await git(dir, ['merge', '--allow-unrelated-histories', '--no-edit', `origin/${def}`], account);
  } catch (err) {
    if (await isMerging(dir)) return { result: 'conflicts', branch };
    throw err;
  }
  if (branch === def) await git(dir, ['branch', '-u', `origin/${def}`]);
  return { result: 'merged', branch };
}

module.exports = {
  toplevel, status, diff, commit, discard, log, show, branches, checkout,
  createBranch, remoteUrl, fetchAll, pull, push, clone, init, isMerging,
  resolve, abortMerge, link,
};
