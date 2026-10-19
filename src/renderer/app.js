'use strict';

const $ = (id) => document.getElementById(id);
const call = (name, ...args) => window.api.call(name, ...args);

const S = {
  accounts: [],
  active: null,
  syncGlobal: false,
  repos: [],
  repo: null,
  info: null,
  unchecked: new Set(),
  selectedFile: null,
  tab: 'changes',
  commits: [],
  selectedCommit: null,
  awaitingLogin: false,
};

const KIND_LETTER = { added: 'A', untracked: '+', modified: 'M', deleted: 'D', renamed: 'R', conflict: '!' };
const KIND_LABEL = { added: 'Novo', untracked: 'Novo', modified: 'Modificado', deleted: 'Removido', renamed: 'Renomeado', conflict: 'Conflito' };

// ---------- small DOM helpers ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

function avatar(account) {
  if (account?.avatarUrl) return el('img', { class: 'avatar', src: `${account.avatarUrl}&s=64`, alt: '' });
  return el('span', { class: 'avatar', text: (account?.login || '?').slice(0, 1).toUpperCase() });
}

const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
function ago(ms) {
  const s = Math.round((ms - Date.now()) / 1000);
  const steps = [[60, 'second'], [60, 'minute'], [24, 'hour'], [30, 'day'], [12, 'month'], [Infinity, 'year']];
  let v = s;
  for (const [size, unit] of steps) {
    if (Math.abs(v) < size) return rtf.format(v, unit);
    v = Math.round(v / size);
  }
  return '';
}

let toastTimer;
function toast(message, isError = false) {
  const t = $('toast');
  t.textContent = message;
  t.className = isError ? 'toast error' : 'toast';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 9000 : 3500);
}

async function busy(text, fn) {
  $('busyText').textContent = text;
  $('busy').hidden = false;
  try {
    return await fn();
  } catch (err) {
    toast(err.message, true);
    return undefined;
  } finally {
    $('busy').hidden = true;
  }
}

function activeAccount() {
  return S.accounts.find((a) => a.login === S.active) || null;
}

function repoRecord() {
  return S.repos.find((r) => r.path === S.repo) || null;
}

// ---------- accounts ----------
async function loadAccounts() {
  const res = await call('accounts:list');
  S.accounts = res.accounts;
  S.active = res.active;
  S.syncGlobal = res.syncGlobal;
  renderAccount();
}

function renderAccount() {
  const a = activeAccount();
  $('accountLabel').textContent = a ? a.login : 'Nenhuma';
  $('accountAvatar').replaceWith(Object.assign(avatar(a), { id: 'accountAvatar' }));
  $('commitAs').textContent = a ? `como ${a.identity.name} <${a.identity.email}>` : '';
  renderAccountHint();
  renderScreens();
}

async function selectAccount(login) {
  closePopovers();
  if (login === S.active) return;
  await busy(`Trocando para ${login}…`, async () => {
    await call('accounts:select', login);
    S.active = login;
    renderAccount();
    toast(S.syncGlobal ? `Conta ativa: ${login} (também no terminal)` : `Conta ativa: ${login}`);
  });
}

// Suggests the account a repo belongs to when it differs from the active one.
function renderAccountHint() {
  const bar = $('accountHint');
  const rec = repoRecord();
  bar.hidden = true;
  if (!rec || !S.active) return;
  const owner = S.info?.remoteUrl?.match(/github\.com[:/]([^/]+)\//)?.[1];
  const byOwner = S.accounts.find((a) => a.login.toLowerCase() === owner?.toLowerCase());
  const suggested = rec.account && S.accounts.some((a) => a.login === rec.account) ? rec.account : byOwner?.login;
  if (!suggested || suggested === S.active) return;
  bar.replaceChildren(
    el('span', { class: 'grow', text: `Este repositório costuma usar a conta ${suggested}. Você está como ${S.active}.` }),
    el('button', { class: 'primary', text: `Trocar para ${suggested}`, onclick: () => selectAccount(suggested) }),
    el('button', { class: 'ghost', text: 'Ignorar', onclick: () => { bar.hidden = true; } }),
  );
  bar.hidden = false;
}

function openAccountMenu() {
  const menu = $('accountMenu');
  const items = S.accounts.map((a) => el('button', {
    class: `item${a.login === S.active ? ' current' : ''}`,
    onclick: () => selectAccount(a.login),
  },
  el('span', { class: 'check', text: a.login === S.active ? '✓' : '' }),
  avatar(a),
  el('span', { class: 'grow' },
    el('span', { text: a.name || a.login }),
    el('span', { class: 'muted', text: `@${a.login} · ${a.identity.email}` })),
  a.ghActive ? el('span', { class: 'tag', title: 'Conta ativa no gh do terminal', text: 'terminal' }) : null));

  const sync = el('input', { type: 'checkbox', id: 'syncGlobal' });
  sync.checked = S.syncGlobal;
  sync.addEventListener('change', async () => {
    const on = sync.checked;
    await busy('Salvando…', async () => {
      await call('accounts:setSyncGlobal', on);
      S.syncGlobal = on;
      await loadAccounts();
    });
  });

  menu.replaceChildren(
    el('div', { class: 'pop-title', text: 'Contas do GitHub' }),
    el('div', { class: 'pop-list' }, items),
    el('label', { class: 'toggle' }, sync,
      el('span', { text: 'Trocar também no terminal (gh e nome/e-mail do git global)' })),
    el('div', { class: 'pop-foot' },
      el('button', { text: 'Adicionar conta', onclick: addAccount }),
      el('button', { text: 'Recarregar', onclick: reloadAccounts }),
      el('button', { text: 'Nome/e-mail…', disabled: !S.active, onclick: openIdentityModal })),
  );
  openPopover(menu, $('accountBtn'));
}

async function addAccount() {
  closePopovers();
  await call('accounts:add');
  S.awaitingLogin = true;
  toast('Termine o login na janela que abriu. Quando voltar para cá, as contas são recarregadas.');
}

async function reloadAccounts() {
  closePopovers();
  await busy('Recarregando contas…', async () => {
    await call('accounts:reload');
    await loadAccounts();
  });
}

function openIdentityModal() {
  closePopovers();
  const a = activeAccount();
  const name = el('input', { value: a.identity.name });
  const email = el('input', { value: a.identity.email });
  openModal(`Nome e e-mail dos commits — @${a.login}`,
    [
      el('p', { class: 'muted', text: 'Esses dados vão em cada commit feito com esta conta. Deixe em branco para usar o padrão do perfil (ou o e-mail noreply do GitHub).' }),
      el('label', {}, 'Nome', name),
      el('label', {}, 'E-mail', email),
    ],
    'Salvar',
    async () => {
      await call('accounts:setIdentity', a.login, { name: name.value.trim(), email: email.value.trim() });
      await loadAccounts();
    });
}

// ---------- repositories ----------
async function loadRepos() {
  const res = await call('repos:list');
  S.repos = res.repos;
  S.repo = res.selected && S.repos.some((r) => r.path === res.selected) ? res.selected : null;
}

async function selectRepo(p) {
  closePopovers();
  await call('repos:select', p);
  S.repo = p;
  S.info = null;
  S.unchecked.clear();
  S.selectedFile = null;
  S.selectedCommit = null;
  S.commits = [];
  showEmptyDiff();
  await refresh();
}

function openRepoMenu() {
  const menu = $('repoMenu');
  const filter = el('input', { placeholder: 'Filtrar repositórios', autocomplete: 'off' });
  const list = el('div', { class: 'pop-list' });
  const draw = () => {
    const q = filter.value.toLowerCase();
    const shown = S.repos.filter((r) => r.name.toLowerCase().includes(q));
    list.replaceChildren(...(shown.length ? shown.map((r) => el('button', {
      class: `item${r.path === S.repo ? ' current' : ''}`,
      onclick: () => selectRepo(r.path),
    },
    el('span', { class: 'check', text: r.path === S.repo ? '✓' : '' }),
    el('span', { class: 'grow' }, el('span', { text: r.name }), el('span', { class: 'muted', text: r.path })),
    r.account ? el('span', { class: 'tag', text: r.account }) : null,
    el('span', {
      class: 'remove ghost', title: 'Remover da lista (não apaga a pasta)', text: '✕',
      onclick: async (e) => {
        e.stopPropagation();
        await call('repos:remove', r.path);
        await loadRepos();
        draw();
        if (!S.repo) await refresh();
      },
    }))) : [el('div', { class: 'empty-list', text: 'Nenhum repositório.' })]));
  };
  filter.addEventListener('input', draw);
  draw();
  menu.replaceChildren(
    el('div', { class: 'pop-head' }, filter),
    list,
    el('div', { class: 'pop-foot' },
      el('button', { class: 'primary', text: 'Clonar do GitHub…', onclick: openCloneModal }),
      el('button', { text: 'Adicionar pasta…', onclick: addExisting })),
  );
  openPopover(menu, $('repoBtn'));
  filter.focus();
}

async function addExisting() {
  closePopovers();
  const added = await busy('Abrindo…', () => call('repos:addExisting'));
  if (!added) return;
  await loadRepos();
  await selectRepo(added);
}

async function openCloneModal() {
  closePopovers();
  const a = activeAccount();
  if (!a) { toast('Escolha uma conta primeiro.', true); return; }

  let remote = [];
  let picked = null;
  const search = el('input', { placeholder: 'Buscar nos repositórios da conta', autocomplete: 'off' });
  const list = el('div', { class: 'repo-pick' }, el('div', { class: 'empty-list', text: 'Carregando…' }));
  const url = el('input', { placeholder: 'https://github.com/dono/repo.git' });
  const dir = el('input', { value: await call('repos:cloneDir') });
  const name = el('input', {});

  const draw = () => {
    const q = search.value.toLowerCase();
    const shown = remote.filter((r) => r.fullName.toLowerCase().includes(q)).slice(0, 200);
    list.replaceChildren(...(shown.length ? shown.map((r) => el('button', {
      type: 'button',
      class: `item${picked === r ? ' selected' : ''}`,
      onclick: () => {
        picked = r;
        url.value = r.cloneUrl;
        name.value = r.name;
        draw();
      },
    },
    el('span', { class: 'grow' }, el('span', { text: r.fullName }), el('span', { class: 'muted', text: r.description || '' })),
    r.private ? el('span', { class: 'tag', text: 'privado' }) : null)) : [el('div', { class: 'empty-list', text: 'Nada encontrado.' })]));
  };
  search.addEventListener('input', draw);
  url.addEventListener('input', () => {
    picked = null;
    const m = url.value.trim().match(/([^/]+?)(\.git)?\/?$/);
    if (m) name.value = m[1];
    draw();
  });

  openModal(`Clonar como @${a.login}`,
    [
      search,
      list,
      el('label', {}, 'Ou cole a URL', url),
      el('label', {}, 'Pasta de destino',
        el('div', { class: 'path-row' }, dir, el('button', {
          type: 'button', text: 'Escolher…',
          onclick: async () => { const d = await call('repos:chooseCloneDir'); if (d) dir.value = d; },
        }))),
      el('label', {}, 'Nome da pasta', name),
    ],
    'Clonar',
    async () => {
      if (!url.value.trim() || !name.value.trim() || !dir.value.trim()) throw new Error('Escolha um repositório e a pasta de destino.');
      const added = await busy(`Clonando ${name.value}…`, () => call('repos:clone', url.value.trim(), dir.value.trim(), name.value.trim()));
      if (!added) return false;
      await loadRepos();
      await selectRepo(added);
      return true;
    });
  search.focus();

  try {
    remote = await call('repos:remote');
    draw();
  } catch (err) {
    list.replaceChildren(el('div', { class: 'empty-list', text: err.message }));
  }
}

// ---------- refresh / render ----------
function renderScreens() {
  const noAccounts = S.accounts.length === 0;
  $('noAccounts').hidden = !noAccounts;
  $('welcome').hidden = noAccounts || Boolean(S.repo);
  $('workspace').hidden = noAccounts || !S.repo;
  $('repoActions').hidden = !S.repo;
}

async function refresh({ quiet = false } = {}) {
  renderScreens();
  const rec = repoRecord();
  $('repoLabel').textContent = rec ? rec.name : 'Nenhum';
  if (!S.repo) {
    $('branchBtn').disabled = true;
    $('syncBtn').disabled = true;
    $('branchLabel').textContent = '—';
    renderAccountHint();
    return;
  }
  try {
    S.info = await call('repo:info', S.repo);
  } catch (err) {
    if (!quiet) toast(`Não foi possível ler ${rec?.name}: ${err.message}`, true);
    return;
  }
  renderBranch();
  renderFiles();
  renderAccountHint();
  if (S.tab === 'history') await loadHistory();
}

function renderBranch() {
  const i = S.info;
  $('branchLabel').textContent = i.branch || '(HEAD destacado)';
  $('branchBtn').disabled = false;

  const sync = $('syncBtn');
  let icon = '↻';
  let label = 'Fetch origin';
  let hint = 'Buscar alterações';
  if (!i.remoteUrl) {
    label = 'Sem remote';
    hint = 'Repositório só local';
  } else if (i.branch && !i.upstream) {
    icon = '↑';
    label = 'Publicar branch';
    hint = 'Enviar para o GitHub';
  } else if (i.behind > 0) {
    icon = '↓';
    label = `Pull origin`;
    hint = `${i.behind} commit(s) para baixar${i.ahead ? `, ${i.ahead} para enviar` : ''}`;
  } else if (i.ahead > 0) {
    icon = '↑';
    label = 'Push origin';
    hint = `${i.ahead} commit(s) para enviar`;
  }
  $('syncIcon').textContent = icon;
  $('syncLabel').textContent = label;
  $('syncHint').textContent = hint;
  sync.disabled = !i.remoteUrl || !i.branch;
}

function renderFiles() {
  const files = S.info.files;
  const known = new Set(files.map((f) => f.path));
  for (const p of S.unchecked) if (!known.has(p)) S.unchecked.delete(p);
  if (S.selectedFile && !known.has(S.selectedFile)) {
    S.selectedFile = null;
    if (S.tab === 'changes') showEmptyDiff();
  }

  $('changesCount').textContent = files.length;
  const checkedCount = files.length - S.unchecked.size;
  const all = $('selectAll');
  all.checked = files.length > 0 && S.unchecked.size === 0;
  all.indeterminate = S.unchecked.size > 0 && checkedCount > 0;
  all.disabled = files.length === 0;
  $('selectAllLabel').textContent = files.length === 1 ? '1 arquivo alterado' : `${files.length} arquivos alterados`;

  const list = $('fileList');
  if (!files.length) {
    list.replaceChildren(el('li', { class: 'empty-list', text: 'Nenhuma alteração local.' }));
  } else {
    list.replaceChildren(...files.map((f) => {
      const box = el('input', { type: 'checkbox', title: 'Incluir no commit' });
      box.checked = !S.unchecked.has(f.path);
      box.addEventListener('click', (e) => e.stopPropagation());
      box.addEventListener('change', () => {
        if (box.checked) S.unchecked.delete(f.path); else S.unchecked.add(f.path);
        renderFiles();
      });
      return el('li', {
        class: f.path === S.selectedFile ? 'selected' : null,
        title: f.orig ? `${f.orig} → ${f.path}` : f.path,
        onclick: () => selectFile(f),
      },
      box,
      el('span', { class: 'file-path', text: `‎${f.path}` }),
      el('span', { class: `kind ${f.kind}`, title: KIND_LABEL[f.kind], text: KIND_LETTER[f.kind] }));
    }));
  }
  updateCommitButton();
}

function updateCommitButton() {
  const count = S.info ? S.info.files.length - S.unchecked.size : 0;
  const btn = $('commitBtn');
  btn.textContent = `Commit em ${S.info?.branch || 'HEAD'}${count ? ` (${count})` : ''}`;
  btn.disabled = !count || !$('summary').value.trim() || !S.active;
}

async function selectFile(f) {
  S.selectedFile = f.path;
  renderFiles();
  try {
    const text = await call('repo:diff', S.repo, f, S.info.initial);
    if (S.selectedFile !== f.path) return;
    const header = el('div', { class: 'diff-header' },
      el('span', { class: `kind ${f.kind}`, text: KIND_LETTER[f.kind] }),
      el('span', { class: 'grow', text: f.orig ? `${f.orig} → ${f.path}` : f.path }),
      el('button', { class: 'danger', text: 'Descartar alterações', onclick: () => discard([f]) }));
    $('diff').replaceChildren(header, renderDiff(text));
    $('diff').scrollTop = 0;
  } catch (err) {
    toast(err.message, true);
  }
}

async function discard(files) {
  const done = await busy('Descartando…', () => call('repo:discard', S.repo, files, S.info.initial));
  if (done) {
    showEmptyDiff();
    await refresh();
  }
}

function showEmptyDiff(text = 'Selecione um arquivo para ver as alterações.') {
  $('diff').replaceChildren(el('div', { class: 'empty-diff', text }));
}

// ---------- diff rendering ----------
const MAX_LINES = 15000;

function renderDiff(text) {
  const out = document.createDocumentFragment();
  const preamble = [];
  let block = null;
  let table = null;
  let inHeader = false;
  let oldN = 0;
  let newN = 0;
  let count = 0;

  const startBlock = (title) => {
    block = el('div', { class: 'file-block' });
    if (title) block.append(el('div', { class: 'file-title', text: title }));
    out.append(block);
    table = null;
  };
  const row = (cls, a, b, src) => {
    if (!table) {
      if (!block) startBlock(null);
      table = el('table', { class: 'code' });
      block.append(table);
    }
    table.append(el('tr', { class: cls },
      el('td', { class: 'ln', text: a }), el('td', { class: 'ln', text: b }), el('td', { class: 'src', text: src })));
  };

  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    if (++count > MAX_LINES) {
      out.append(el('div', { class: 'binary', text: 'Diff muito grande — mostrando só o começo.' }));
      break;
    }
    if (line.startsWith('diff --git ')) {
      const m = line.match(/ b\/(.*)$/);
      startBlock(m ? m[1] : line.slice(11));
      inHeader = true;
      continue;
    }
    if (line.startsWith('Binary files')) {
      if (!block) startBlock(null);
      block.append(el('div', { class: 'binary', text: 'Arquivo binário — sem visualização de texto.' }));
      inHeader = false;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldN = Number(m[1]); newN = Number(m[2]); }
      row('hunk', '', '', line);
      inHeader = false;
      continue;
    }
    if (inHeader) continue;
    if (!block) { preamble.push(line); continue; }
    const c = line[0];
    if (c === '+') row('add', '', newN++, line.slice(1));
    else if (c === '-') row('del', oldN++, '', line.slice(1));
    else if (c === '\\') row('hunk', '', '', line);
    else row('', oldN++, newN++, line.slice(1));
  }

  const message = preamble.join('\n').trim();
  if (message) out.prepend(el('div', { class: 'commit-msg', text: message }));
  if (!out.childNodes.length) out.append(el('div', { class: 'binary', text: 'Sem diferenças de conteúdo (pode ser só mudança de permissão).' }));
  return out;
}

// ---------- history ----------
async function loadHistory() {
  S.commits = await call('repo:log', S.repo);
  const list = $('commitList');
  if (!S.commits.length) {
    list.replaceChildren(el('li', { class: 'empty-list', text: 'Nenhum commit ainda.' }));
    return;
  }
  list.replaceChildren(...S.commits.map((c) => el('li', {
    class: `commit-item${c.sha === S.selectedCommit ? ' selected' : ''}`,
    'data-sha': c.sha,
    onclick: () => selectCommit(c),
  },
  el('span', { class: 'subject', text: c.subject }),
  el('span', { class: 'muted' },
    ...(c.refs || '').split(', ').filter(Boolean).map((r) => el('span', { class: 'ref', text: r.replace('HEAD -> ', '') })),
    `${c.author} · ${ago(c.date)} · ${c.short}`))));
}

async function selectCommit(c) {
  S.selectedCommit = c.sha;
  for (const li of $('commitList').children) li.classList.toggle('selected', li.dataset.sha === c.sha);
  try {
    const text = await call('repo:show', S.repo, c.sha);
    if (S.selectedCommit !== c.sha) return;
    const header = el('div', { class: 'diff-header' },
      el('span', { class: 'grow' },
        el('span', { class: 'title', text: c.subject }),
        el('span', { class: 'muted', text: `${c.author} <${c.email}> · ${new Date(c.date).toLocaleString('pt-BR')} · ${c.short}` })));
    $('diff').replaceChildren(header, renderDiff(text));
    $('diff').scrollTop = 0;
  } catch (err) {
    toast(err.message, true);
  }
}

function setTab(tab) {
  S.tab = tab;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === tab);
  $('changesPanel').hidden = tab !== 'changes';
  $('historyPanel').hidden = tab !== 'history';
  showEmptyDiff(tab === 'changes' ? 'Selecione um arquivo para ver as alterações.' : 'Selecione um commit para ver o que mudou.');
  S.selectedFile = null;
  S.selectedCommit = null;
  if (tab === 'history') loadHistory().catch((e) => toast(e.message, true));
  else if (S.info) renderFiles();
}

// ---------- branches ----------
async function openBranchMenu() {
  const menu = $('branchMenu');
  let data;
  try {
    data = await call('repo:branches', S.repo);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  const filter = el('input', { placeholder: 'Filtrar branches', autocomplete: 'off' });
  const list = el('div', { class: 'pop-list' });
  const item = (name, isRemote) => el('button', {
    class: `item${name === S.info.branch ? ' current' : ''}`,
    onclick: () => checkout(name, isRemote),
  },
  el('span', { class: 'check', text: name === S.info.branch ? '✓' : '' }),
  el('span', { class: 'grow' }, el('span', { text: name })));
  const draw = () => {
    const q = filter.value.toLowerCase();
    const local = data.local.filter((b) => b.toLowerCase().includes(q));
    const remote = data.remote.filter((b) => b.toLowerCase().includes(q));
    list.replaceChildren(
      el('div', { class: 'pop-title', text: 'Locais' }),
      ...local.map((b) => item(b, false)),
      remote.length ? el('div', { class: 'pop-title', text: 'Remotas' }) : null,
      ...remote.map((b) => item(b, true)),
    );
  };
  filter.addEventListener('input', draw);
  draw();
  menu.replaceChildren(
    el('div', { class: 'pop-head' }, filter),
    list,
    el('div', { class: 'pop-foot' }, el('button', { class: 'primary', text: 'Nova branch…', onclick: openNewBranchModal })),
  );
  openPopover(menu, $('branchBtn'));
  filter.focus();
}

async function checkout(name, isRemote) {
  closePopovers();
  await busy(`Mudando para ${name}…`, () => call('repo:checkout', S.repo, name, isRemote));
  await refresh();
}

function openNewBranchModal() {
  closePopovers();
  const name = el('input', { placeholder: 'minha-feature', autocomplete: 'off' });
  openModal('Nova branch',
    [el('label', {}, `Criada a partir de ${S.info.branch || 'HEAD'}`, name)],
    'Criar branch',
    async () => {
      const n = name.value.trim().replace(/\s+/g, '-');
      if (!n) throw new Error('Dê um nome para a branch.');
      await call('repo:createBranch', S.repo, n);
      await refresh();
    });
  name.focus();
}

// ---------- sync ----------
async function sync() {
  const i = S.info;
  if (!i?.remoteUrl || !i.branch) return;
  const who = S.active;
  let step;
  if (i.branch && !i.upstream) step = ['Publicando', () => call('repo:push', S.repo, false)];
  else if (i.behind > 0) step = ['Pull', () => call('repo:pull', S.repo)];
  else if (i.ahead > 0) step = ['Push', () => call('repo:push', S.repo, true)];
  else step = ['Fetch', () => call('repo:fetch', S.repo)];
  const ok = await busy(`${step[0]} como ${who}…`, async () => { await step[1](); return true; });
  if (ok) toast(`${step[0]} concluído como ${who}.`);
  await loadRepos();
  await refresh();
}

// ---------- commit ----------
async function commit(e) {
  e.preventDefault();
  const files = S.info.files.filter((f) => !S.unchecked.has(f.path));
  const summary = $('summary').value.trim();
  const description = $('description').value.trim();
  if (!files.length || !summary) return;
  const ok = await busy('Fazendo commit…', async () => {
    await call('repo:commit', S.repo, files, description ? `${summary}\n\n${description}` : summary, S.info.initial);
    return true;
  });
  if (!ok) return;
  $('summary').value = '';
  $('description').value = '';
  toast(`Commit feito como ${activeAccount()?.identity.name}.`);
  await loadRepos();
  showEmptyDiff();
  await refresh();
}

// ---------- popovers & modal ----------
function closePopovers() {
  for (const p of document.querySelectorAll('.popover')) p.hidden = true;
  for (const b of document.querySelectorAll('.tb.open')) b.classList.remove('open');
}

function openPopover(menu, anchor) {
  const wasOpen = !menu.hidden;
  closePopovers();
  if (wasOpen) return;
  menu.style.left = `${anchor.getBoundingClientRect().left}px`;
  menu.hidden = false;
  anchor.classList.add('open');
}

function openModal(title, body, okLabel, onOk) {
  const err = el('p', { class: 'error-text' });
  err.hidden = true;
  const ok = el('button', { type: 'submit', class: 'primary', text: okLabel });
  const form = el('form', {},
    el('h2', { text: title }),
    el('div', { class: 'modal-body' }, body, err),
    el('div', { class: 'modal-foot' },
      el('button', { type: 'button', text: 'Cancelar', onclick: closeModal }),
      ok));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    ok.disabled = true;
    try {
      const result = await onOk();
      if (result !== false) closeModal();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      ok.disabled = false;
    }
  });
  $('modalBody').replaceChildren(form);
  $('modal').hidden = false;
}

function closeModal() {
  $('modal').hidden = true;
  $('modalBody').replaceChildren();
}

// ---------- wiring ----------
function wire() {
  $('accountBtn').addEventListener('click', (e) => { e.stopPropagation(); openAccountMenu(); });
  $('repoBtn').addEventListener('click', (e) => { e.stopPropagation(); openRepoMenu(); });
  $('branchBtn').addEventListener('click', (e) => { e.stopPropagation(); if ($('branchMenu').hidden) openBranchMenu(); else closePopovers(); });
  $('syncBtn').addEventListener('click', sync);
  $('openFolder').addEventListener('click', () => call('shell:folder', S.repo));
  $('openCode').addEventListener('click', () => call('shell:code', S.repo));
  $('openGithub').addEventListener('click', () => {
    const m = S.info?.remoteUrl?.match(/github\.com[:/](.+?)(\.git)?$/);
    if (m) call('shell:url', `https://github.com/${m[1]}`);
    else toast('Esse repositório não tem um remote no GitHub.', true);
  });

  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => setTab(t.dataset.tab));
  $('selectAll').addEventListener('change', (e) => {
    S.unchecked.clear();
    if (!e.target.checked) for (const f of S.info.files) S.unchecked.add(f.path);
    renderFiles();
  });
  $('summary').addEventListener('input', updateCommitButton);
  $('commitForm').addEventListener('submit', commit);

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.popover')) closePopovers();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closePopovers();
    closeModal();
  });
  $('modal').addEventListener('mousedown', (e) => { if (e.target === $('modal')) closeModal(); });

  document.body.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'clone') openCloneModal();
    else if (action === 'addExisting') addExisting();
    else if (action === 'addAccount') addAccount();
    else if (action === 'reloadAccounts') reloadAccounts();
  });

  window.api.onFocus(async () => {
    if (S.awaitingLogin) {
      S.awaitingLogin = false;
      await call('accounts:reload');
      await loadAccounts().catch(() => {});
    }
    if (S.repo && $('modal').hidden) refresh({ quiet: true });
  });
}

async function start() {
  wire();
  await busy('Carregando contas…', loadAccounts);
  await loadRepos();
  await refresh();
}

start();
