const { t: _t } = require('./i18n');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { run } = require('./run');
const tools = require('./tools');

// Credential helper that answers with the chosen account's token. The token
// comes from an env var so it never shows up in the process command line.
const CRED_HELPER = '!f() { if test "$1" = get; then echo username=x-access-token; echo "password=$GITSWITCH_TOKEN"; fi; }; f';

const MAX_DIFF = 4 * 1024 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;
const IMAGE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif', '.svg': 'image/svg+xml',
};

// Git's English messages mapped to what the user should do about them.
const FRIENDLY = [
  ['auth', /Repository not found|repository '.*' not found/i, 'O GitHub não encontrou este repositório com essa conta. Se ele é de outra conta, troque de conta (no app: menu Conta; no terminal: --as <login>).'],
  ['auth', /Authentication failed|could not read Username|Invalid username or password|returned error: 40[13]|Permission to .* denied/i, 'O GitHub recusou o acesso dessa conta. Confira se ela tem permissão neste repositório (no app: menu Conta; no terminal: --as <login>).'],
  ['rules', /GH0\d\d|push declined due to repository rule|push protection|secret/i, 'O GitHub bloqueou o envio por uma regra do repositório (por exemplo, um segredo no código).'],
  ['size', /exceeds GitHub's file size limit|large files detected/i, 'Há um arquivo maior que o limite do GitHub (100 MB). Remova-o do commit ou use Git LFS.'],
  ['stale', /stale info/i, 'O GitHub mudou desde o seu último Fetch. Faça Fetch e tente de novo.'],
  ['rejected', /\[rejected\]|non-fast-forward|Updates were rejected/i, 'O GitHub tem commits que você ainda não tem nesta branch.'],
  ['dirty', /would be overwritten by|Please commit your changes or stash them|Your local changes to the following files/i, 'Você tem alterações que seriam sobrescritas. Faça commit, guarde (stash) ou descarte antes.'],
  ['network', /Could not resolve host|Failed to connect|Connection timed out|Couldn't connect|Connection reset|unable to access/i, 'Sem conexão com o GitHub. Confira sua internet e tente de novo.'],
  ['lock', /index\.lock'?: File exists|Unable to create .*\.lock/i, 'Outro programa está usando este repositório (arquivo .lock). Feche-o e tente de novo.'],
  ['conflict', /CONFLICT|Automatic merge failed|fix conflicts/i, 'A junção parou com conflitos. Resolva os arquivos marcados com ! e faça commit.'],
  ['unrelated', /refusing to merge unrelated histories/i, 'As histórias não têm nada em comum. Use Pasta → Juntar com uma pasta que já existe.'],
  ['upstream', /has no upstream branch|no upstream configured/i, 'Essa branch ainda não existe no GitHub. Use Publicar branch.'],
  ['empty', /nothing to commit|nothing added to commit|no changes added to commit/i, 'Não há nada para commitar.'],
  ['hook', /hook.*(failed|declined)|pre-commit|commit-msg/i, 'Um hook do repositório recusou a operação. Veja os detalhes.'],
  ['notrepo', /not a git repository/i, 'Essa pasta não é um repositório Git (ou foi movida ou apagada).'],
  ['identity', /Please tell me who you are|empty ident/i, 'Falta o nome e o e-mail do autor. Configure em Configurações → Git.'],
  ['branch-exists', /a branch named .* already exists|already exists/i, 'Já existe uma branch com esse nome.'],
  ['missing-ref', /invalid reference|did not match any|unknown revision|not a valid (object|ref)/i, 'Essa branch ou commit não existe (talvez tenha sido apagado no GitHub). Faça Fetch e tente de novo.'],
  ['not-merged', /is not fully merged/i, 'Essa branch tem commits que não estão em nenhuma outra.'],
];

function friendly(err) {
  const raw = err.output || err.message || '';
  const hit = FRIENDLY.find(([, re]) => re.test(raw));
  const out = new Error(hit ? _t(hit[2]) : raw.split('\n').filter(Boolean).slice(-3).join('\n') || err.message);
  out.kind = hit?.[0] || 'git';
  out.detail = raw;
  out.exitCode = err.exitCode;
  return out;
}

const PROGRESS_LABELS = [
  [/^Counting objects/, 'Contando objetos'], [/^Compressing objects/, 'Comprimindo objetos'],
  [/^Enumerating objects/, 'Listando objetos'], [/^Receiving objects/, 'Recebendo objetos'],
  [/^Resolving deltas/, 'Resolvendo deltas'], [/^Writing objects/, 'Enviando objetos'],
  [/^Updating files/, 'Atualizando arquivos'], [/^Checking out files/, 'Preparando arquivos'],
  [/^Filtering content/, 'Baixando arquivos LFS'],
];

// Turns git's "\r"-rewritten progress lines into { text, percent }.
function progressParser(label, onProgress) {
  let buffer = '';
  return (chunk) => {
    buffer = (buffer + chunk).slice(-2000);
    const lines = buffer.split(/[\r\n]+/).map((l) => l.replace(/^remote:\s*/, '').trim()).filter(Boolean);
    const last = lines.at(-1);
    if (!last) return;
    const m = last.match(/^(.*?):\s+(\d+)%/);
    if (!m) return;
    const known = PROGRESS_LABELS.find(([re]) => re.test(m[1]))?.[1];
    const step = known ? _t(known) : m[1];
    onProgress({ text: `${label}: ${step} ${m[2]}%`, percent: Number(m[2]) });
  };
}

// Environment that makes git authenticate as `account` (and nothing else):
// through GIT_CONFIG_PARAMETERS rather than -c so filters that git starts
// (Git LFS) use the same credentials. Shared with the CLI's passthrough.
function accountEnv(account) {
  if (!account) return {};
  const prior = process.env.GIT_CONFIG_PARAMETERS ? `${process.env.GIT_CONFIG_PARAMETERS} ` : '';
  return {
    GIT_CONFIG_PARAMETERS: `${prior}'credential.helper=' 'credential.https://github.com.helper=' 'credential.helper=${CRED_HELPER}'`,
    GITSWITCH_TOKEN: account.token,
  };
}

// Commits made by git carry the account's name and e-mail.
function identityArgs(account) {
  return account ? ['-c', `user.name=${account.name}`, '-c', `user.email=${account.email}`] : [];
}

function git(cwd, args, account, opts = {}) {
  const pre = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...identityArgs(account)];
  const env = {
    TERM: 'dumb',
    LANGUAGE: 'C', // English messages, so FRIENDLY can recognise them
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_EDITOR: 'true',
    ...opts.env,
    ...accountEnv(account),
  };
  const onStderr = opts.onProgress ? progressParser(opts.progressLabel || 'Git', opts.onProgress) : undefined;
  return run(tools.bin('git'), [...pre, ...args], { ...opts, cwd, env, onStderr }).catch((err) => {
    throw friendly(err);
  });
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
  const { stdout } = await git(repo, ['--no-optional-locks', 'status', '--untracked-files=all', '--branch', '--porcelain=2', '-z']);
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

const isNewFile = (file, initial) => file.kind === 'untracked' || (initial && file.kind !== 'deleted');

// Raw unified diff of one working-directory file against HEAD (new files
// against /dev/null), the same text partial commits are built from.
async function rawDiff(repo, file, initial, hideWhitespace = false) {
  const ws = hideWhitespace ? ['-w'] : [];
  if (isNewFile(file, initial)) {
    const { stdout } = await git(repo, ['diff', '--no-ext-diff', ...ws, '--no-index', '--', '/dev/null', file.path], null, { allowCodes: [0, 1] });
    return stdout;
  }
  const paths = file.orig ? [file.orig, file.path] : [file.path];
  const { stdout } = await git(repo, ['diff', '--no-ext-diff', ...ws, '-M', initial ? '--cached' : 'HEAD', '--', ...paths]);
  return stdout;
}

async function blobDataUri(repo, spec, type) {
  try {
    const { stdout } = await git(repo, ['show', spec], null, { buffer: true });
    return stdout.length <= MAX_IMAGE ? `data:${type};base64,${stdout.toString('base64')}` : null;
  } catch {
    return null;
  }
}

async function fileDataUri(repo, rel, type) {
  try {
    const buf = await fs.readFile(path.join(repo, rel));
    return buf.length <= MAX_IMAGE ? `data:${type};base64,${buf.toString('base64')}` : null;
  } catch {
    return null;
  }
}

async function imageDiff(repo, base, file, newSide, oldSpec) {
  const type = IMAGE_TYPES[path.extname(file.path).toLowerCase()];
  return {
    kind: 'image',
    before: oldSpec ? await blobDataUri(repo, oldSpec, type) : null,
    after: newSide ? await newSide(type) : null,
    base,
  };
}

async function diff(repo, file, { initial = false, hideWhitespace = false } = {}) {
  const text = await rawDiff(repo, file, initial, hideWhitespace);
  const isImage = Boolean(IMAGE_TYPES[path.extname(file.path).toLowerCase()]);
  if (isImage && /^Binary files|GIT binary patch/m.test(text)) {
    const oldSpec = isNewFile(file, initial) ? null : `HEAD:${file.orig || file.path}`;
    const newSide = file.kind === 'deleted' ? null : (type) => fileDataUri(repo, file.path, type);
    return imageDiff(repo, 'HEAD', file, newSide, oldSpec);
  }
  if (text.length > MAX_DIFF) return { kind: 'large', size: text.length };
  return { kind: 'text', text };
}

// Builds a patch with only the selected +/- lines (indices into the raw diff
// text), the way GitHub Desktop does: unselected deletions become context,
// unselected additions are dropped, hunks without changes are skipped.
function partialPatch(text, selected, file, isNew) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let out = isNew ? `--- /dev/null\n+++ b/${file.path}\n` : `--- a/${file.path}\n+++ b/${file.path}\n`;
  let any = false;
  let i = lines.findIndex((l) => l.startsWith('@@'));
  if (i < 0) return null;
  while (i < lines.length) {
    const m = lines[i].match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    i++;
    if (!m) continue;
    let body = '';
    let oldCount = 0;
    let newCount = 0;
    let changed = false;
    let lastKept = false;
    for (; i < lines.length && !lines[i].startsWith('@@'); i++) {
      const l = lines[i];
      const c = l[0];
      if (c === ' ') {
        body += `${l}\n`; oldCount++; newCount++; lastKept = true;
      } else if (c === '+' || c === '-') {
        if (selected.has(i)) {
          body += `${l}\n`;
          if (c === '+') newCount++; else oldCount++;
          changed = true; lastKept = true;
        } else if (c === '-' && !isNew) {
          body += ` ${l.slice(1)}\n`; oldCount++; newCount++; lastKept = true;
        } else {
          lastKept = false;
        }
      } else if (c === '\\') {
        if (lastKept) body += `${l}\n`;
      }
    }
    if (changed) {
      out += `@@ -${m[1]},${oldCount} +${m[2]},${newCount} @@\n${body}`;
      any = true;
    }
  }
  return any ? out : null;
}

// Cheap fingerprint of a diff, so a partial commit can tell the file changed
// after the user picked lines (the renderer computes the same one).
function diffHash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${text.length}:${h}`;
}

async function stagePartial(repo, file, initial) {
  const isNew = isNewFile(file, initial);
  if (file.kind === 'renamed' && file.orig) {
    // Recreate the rename in the index (what `git mv` would have done).
    await git(repo, ['add', '--update', '--', file.orig]);
    const { stdout } = await git(repo, ['ls-tree', 'HEAD', '--', file.orig]);
    const [mode, , oid] = stdout.split('\t')[0].split(' ');
    await git(repo, ['update-index', '--add', '--cacheinfo', `${mode},${oid},${file.path}`]);
  }
  const text = await rawDiff(repo, file, initial, false);
  if (file.hash && diffHash(text) !== file.hash) {
    throw new Error(_t('{0} mudou depois que você escolheu as linhas. Abra o arquivo de novo e confira a seleção.', file.path));
  }
  const patch = partialPatch(text, new Set(file.lines), file, isNew);
  if (!patch) return;
  await git(repo, ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn', '-'], null, { input: patch });
}

async function isMerging(repo) {
  const { code } = await git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], null, { allowCodes: [0, 1] });
  return code === 0;
}

// files: [{ path, orig?, kind, lines? }]; `lines` marks a partial selection.
async function commit(repo, account, files, message, { initial = false, merging = false, amend = false } = {}) {
  // Commit exactly what was selected: empty the index, then stage that.
  // During a merge nothing is unstaged, since that would drop the merge.
  if (!merging) {
    if (initial) await git(repo, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '.']);
    else await git(repo, ['reset', '-q']);
  }
  const whole = files.filter((f) => !f.lines);
  const paths = whole.flatMap((f) => (f.orig ? [f.orig, f.path] : [f.path]));
  for (let i = 0; i < paths.length; i += 100) {
    await git(repo, ['add', '-A', '--', ...paths.slice(i, i + 100)]);
  }
  for (const f of files.filter((x) => x.lines)) await stagePartial(repo, f, initial);
  await git(repo, ['commit', '-F', '-', ...(amend ? ['--amend'] : [])], account, { input: message });
}

// New and modified files go to the Recycle Bin before being reset, so a
// discard can always be undone from there (GitHub Desktop does the same).
async function discard(repo, files, initial, trash) {
  for (const f of files) {
    const abs = path.join(repo, f.path);
    if (isNewFile(f, initial) || f.kind === 'added') {
      await git(repo, ['rm', '-q', '--cached', '--ignore-unmatch', '--', f.path]);
      await trash(abs).catch(() => {});
    } else if (f.kind === 'renamed' && f.orig) {
      await git(repo, ['rm', '-q', '--cached', '--ignore-unmatch', '--', f.path]);
      await trash(abs).catch(() => {});
      await git(repo, ['restore', '--source=HEAD', '--staged', '--worktree', '--', f.orig]);
    } else {
      if (f.kind !== 'deleted') await trash(abs).catch(() => {});
      await git(repo, ['restore', '--source=HEAD', '--staged', '--worktree', '--', f.path]);
    }
  }
}

async function log(repo) {
  try {
    const { stdout } = await git(repo, ['log', '-n', '300', '--no-show-signature', '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D%x1f%P%x1e']);
    return stdout.split('\x1e').filter((s) => s.trim()).map((s) => {
      const [sha, short, author, email, at, subject, refs, parents] = s.replace(/^\n/, '').split('\x1f');
      return { sha, short, author, email, date: Number(at) * 1000, subject, refs, parents: parents ? parents.split(' ') : [] };
    });
  } catch {
    return [];
  }
}

async function show(repo, sha, hideWhitespace = false) {
  const { stdout } = await git(repo, ['show', '--no-ext-diff', '-M', ...(hideWhitespace ? ['-w'] : []), '--format=%B', sha]);
  return stdout.length > MAX_DIFF ? `${stdout.slice(0, MAX_DIFF)}\n` : stdout;
}

async function headCommit(repo) {
  try {
    const { stdout } = await git(repo, ['log', '-1', '--format=%H%x1f%s%x1f%ct']);
    const [sha, subject, at] = stdout.trim().split('');
    return sha ? { sha, subject, date: Number(at) * 1000 } : null;
  } catch {
    return null;
  }
}

async function lastMessage(repo) {
  const { stdout } = await git(repo, ['log', '-1', '--format=%B']);
  return stdout.trim();
}

// Moves HEAD back one commit and keeps its changes in the working directory.
async function undoLastCommit(repo) {
  const message = await lastMessage(repo);
  const { code } = await git(repo, ['rev-parse', '-q', '--verify', 'HEAD~1'], null, { allowCodes: [0, 1] });
  if (code === 0) await git(repo, ['reset', '--soft', 'HEAD~1']);
  else await git(repo, ['update-ref', '-d', 'HEAD']);
  await git(repo, ['reset', '-q']).catch(() => {});
  return message;
}

async function revert(repo, account, sha, parents) {
  await git(repo, ['revert', '--no-edit', ...(parents > 1 ? ['-m', '1'] : []), sha], account);
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

async function checkoutCommit(repo, sha) {
  await git(repo, ['switch', '--detach', sha]);
}

async function createBranch(repo, name, from) {
  await git(repo, ['switch', '-c', name, ...(from ? [from] : [])]);
}

async function renameBranch(repo, from, to) {
  await git(repo, ['branch', '-m', from, to]);
}

async function deleteBranch(repo, name, force) {
  await git(repo, ['branch', force ? '-D' : '-d', name]);
}

async function merge(repo, account, branch) {
  try {
    await git(repo, ['merge', '--no-edit', branch], account);
    return 'merged';
  } catch (err) {
    if (await isMerging(repo)) return 'conflicts';
    throw err;
  }
}

async function remoteUrl(repo) {
  try {
    const { stdout } = await git(repo, ['remote', 'get-url', 'origin']);
    return stdout.trim();
  } catch {
    return null;
  }
}

// Fetches one refspec, e.g. pull/12/head:pr/12 for a pull request from a fork.
function fetchRef(repo, account, refspec) {
  return git(repo, ['fetch', 'origin', refspec], account);
}

function fetchAll(repo, account, onProgress) {
  return git(repo, ['fetch', '--all', '--prune', '--progress', '--recurse-submodules=on-demand', '--show-forced-updates'], account,
    { onProgress, progressLabel: 'Fetch' });
}

function pull(repo, account, onProgress) {
  return git(repo, ['pull', '--no-rebase', '--no-edit', '--progress', '--recurse-submodules'], account, { onProgress, progressLabel: 'Pull' });
}

function push(repo, account, { upstream = true, force = false } = {}, onProgress) {
  const args = ['push', '--progress', '--follow-tags'];
  if (force) args.push('--force-with-lease');
  if (!upstream) args.push('--set-upstream', 'origin', 'HEAD');
  return git(repo, args, account, { onProgress, progressLabel: 'Push' });
}

function clone(url, dest, account, onProgress) {
  return git(path.dirname(dest), ['clone', '--progress', '--recursive', url, dest], account, { onProgress, progressLabel: 'Clonando' });
}

function init(dir) {
  return git(dir, ['init', '-b', 'main']);
}

// --- stash
async function stashList(repo) {
  try {
    const { stdout } = await git(repo, ['stash', 'list', '--format=%gd%x1f%s%x1f%ct']);
    return stdout.split('\n').filter(Boolean).map((l) => {
      const [ref, message, at] = l.split('\x1f');
      return { ref, message, date: Number(at) * 1000 };
    });
  } catch {
    return [];
  }
}

function stashPush(repo, account, message) {
  return git(repo, ['stash', 'push', '--include-untracked', '-m', message], account);
}

function stashPop(repo, ref) {
  return git(repo, ['stash', 'pop', ref]);
}

function stashDrop(repo, ref) {
  return git(repo, ['stash', 'drop', ref]);
}

async function stashShow(repo, ref) {
  const { stdout } = await git(repo, ['stash', 'show', '-p', '--include-untracked', '--no-ext-diff', ref]).catch(() => git(repo, ['stash', 'show', '-p', ref]));
  return stdout.length > MAX_DIFF ? `${stdout.slice(0, MAX_DIFF)}\n` : stdout;
}

// --- .gitignore
async function ignore(repo, pattern) {
  const file = path.join(repo, '.gitignore');
  let current = '';
  try { current = await fs.readFile(file, 'utf8'); } catch { /* new file */ }
  if (current.split(/\r?\n/).includes(pattern)) return;
  const sep = current && !current.endsWith('\n') ? '\n' : '';
  await fs.writeFile(file, `${current}${sep}${pattern}\n`);
  // Already-tracked files keep being tracked unless removed from the index.
  await git(repo, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', pattern]).catch(() => {});
}

// --- global identity
async function globalIdentity() {
  const get = async (key) => (await git(process.cwd(), ['config', '--global', '--get', key], null, { allowCodes: [0, 1] })).stdout.trim();
  return { name: await get('user.name'), email: await get('user.email') };
}

async function setGlobalIdentity({ name, email }) {
  if (name) await git(process.cwd(), ['config', '--global', 'user.name', name]);
  if (email) await git(process.cwd(), ['config', '--global', 'user.email', email]);
}

// Settles a conflicted file with one side ('ours' = this folder, 'theirs' = the other).
async function resolve(repo, file, side) {
  await git(repo, ['checkout', `--${side}`, '--', file]);
  await git(repo, ['add', '--', file]);
}

function abortMerge(repo) {
  return git(repo, ['merge', '--abort']);
}

// The multi-step operation waiting on the user, if any.
async function operation(repo) {
  const names = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];
  const { stdout } = await git(repo, ['rev-parse', ...names.flatMap((n) => ['--git-path', n])]);
  const found = stdout.split(/\r?\n/).filter(Boolean).map((p) => (path.isAbsolute(p) ? p : path.join(repo, p)));
  const has = (i) => Boolean(found[i]) && fsSync.existsSync(found[i]);
  if (has(3) || has(4)) return 'rebase';
  if (has(1)) return 'cherry-pick';
  if (has(2)) return 'revert';
  if (has(0)) return 'merge';
  return null;
}

function abortOperation(repo, op) {
  return git(repo, [op, '--abort']);
}

// --- tags
function createTag(repo, account, name, sha, message) {
  return git(repo, ['tag', '-a', name, '-m', message || name, sha], account);
}

async function deleteTag(repo, account, name, remoteToo) {
  await git(repo, ['tag', '-d', name]);
  if (remoteToo) await git(repo, ['push', 'origin', `:refs/tags/${name}`], account);
}

// --- cherry-pick: switches to the target branch and applies the commit there.
async function cherryPick(repo, account, sha, branch, parents) {
  await git(repo, ['switch', branch]);
  try {
    await git(repo, ['cherry-pick', ...(parents > 1 ? ['-m', '1'] : []), sha], account);
    return 'applied';
  } catch (err) {
    if (await operation(repo) === 'cherry-pick') return 'conflicts';
    throw err;
  }
}

// --- squash: folds the newest commits down to (and including) sha into one.
async function squash(repo, account, sha, message) {
  const st = await status(repo);
  if (st.files.length) throw new Error(_t('Faça commit, guarde (stash) ou descarte as alterações antes de juntar commits.'));
  const { code } = await git(repo, ['rev-parse', '-q', '--verify', `${sha}^`], null, { allowCodes: [0, 1] });
  if (code === 0) await git(repo, ['reset', '--soft', `${sha}^`]);
  else await git(repo, ['update-ref', '-d', 'HEAD']);
  await git(repo, ['commit', '-F', '-'], account, { input: message });
}

// Messages of the commits from sha up to HEAD, oldest first.
async function messagesSince(repo, sha) {
  const { code } = await git(repo, ['rev-parse', '-q', '--verify', `${sha}^`], null, { allowCodes: [0, 1] });
  const range = code === 0 ? [`${sha}^..HEAD`] : ['HEAD'];
  const { stdout } = await git(repo, ['log', '--reverse', '--format=%B%x1e', ...range]);
  return stdout.split('\x1e').map((m) => m.trim()).filter(Boolean);
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
    throw new Error(_t('Essa pasta fica dentro de outro repositório ({0}). Escolha a pasta principal.', top));
  }
  if (!top) await init(dir);

  const current = await remoteUrl(dir);
  if (current && !sameRemote(current, url)) throw new Error(_t('Essa pasta já está ligada a outro repositório:\n{0}', current));
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
  if (st.files.length) throw new Error(_t('Essa pasta tem alterações sem commit. Faça commit ou descarte antes de juntar.'));
  const branch = st.branch;
  // Track GitHub's branch up front, so Push works after conflicts are settled too.
  if (branch === def) await git(dir, ['branch', '-u', `origin/${def}`]);
  try {
    await git(dir, ['merge', '--allow-unrelated-histories', '--no-edit', `origin/${def}`], account);
  } catch (err) {
    if (await isMerging(dir)) return { result: 'conflicts', branch };
    throw err;
  }
  return { result: 'merged', branch };
}

module.exports = {
  toplevel, status, diff, commit, discard, log, show, branches, checkout, checkoutCommit,
  createBranch, renameBranch, deleteBranch, merge, remoteUrl, fetchAll, pull, push, clone, init,
  isMerging, resolve, abortMerge, link, lastMessage, headCommit, diffHash, undoLastCommit, revert,
  stashList, stashPush, stashPop, stashDrop, stashShow, ignore, globalIdentity, setGlobalIdentity,
  partialPatch, accountEnv, identityArgs, friendly, operation, abortOperation, createTag, deleteTag,
  cherryPick, squash, messagesSince, fetchRef,
};
