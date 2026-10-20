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
  knownLogins: null,
  missing: [],
  apps: null,
  sel: new Map(),      // path -> { hash, all, picked } for files with picked lines
  settings: {},
  lastFetch: 0,
  pr: null,             // { pr, checks, defaultBranch, … } for the current branch
  prAt: 0,
  lastChecks: new Map(), // repo|branch -> checks state, for notifications
  update: null,
  manualCheck: false,
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
  for (const c of children.flat(Infinity)) if (c != null && c !== false) node.append(c);
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
function toast(message, isError = false, detail = null) {
  const t = $('toast');
  t.className = isError ? 'toast error' : 'toast';
  t.replaceChildren(el('span', { class: 'toast-text', text: message }));
  if (detail && detail !== message) {
    t.append(el('button', { class: 'toast-more', text: 'Detalhes', onclick: () => showDetail(message, detail) }));
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 12000 : 3500);
}

function showDetail(title, detail) {
  $('toast').hidden = true;
  openModal(title, [el('pre', { class: 'detail', text: detail })], 'Fechar', async () => {}, { cancel: false });
}

// Runs fn with the progress pill up. Errors become a toast, unless rethrow
// is set and the caller handles them.
async function busy(text, fn, { rethrow = false } = {}) {
  $('busyText').textContent = text;
  $('busy').hidden = false;
  try {
    return await fn();
  } catch (err) {
    if (rethrow) throw err;
    toast(err.message, true, err.detail);
    return undefined;
  } finally {
    $('busy').hidden = true;
  }
}

// A small dialog with several answers; resolves to the picked id.
function choose(title, text, buttons) {
  return new Promise((resolve) => {
    const done = (id) => { S.onModalClose = null; closeModal(); resolve(id); };
    const form = el('form', {},
      el('h2', { text: title }),
      el('div', { class: 'modal-body' }, el('p', { class: 'hint', text })),
      el('div', { class: 'modal-foot' }, buttons.map(([id, label, primary]) => el('button', {
        type: 'button', class: primary ? 'primary' : null, text: label, onclick: () => done(id),
      }))));
    $('modalBody').replaceChildren(form);
    $('modal').hidden = false;
    S.onModalClose = () => resolve('cancel');
  });
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
  fillCoauthorSuggestions();
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
    el('span', { class: 'muted', text: `@${a.login} · ${a.identity.email}` }),
    el('span', { class: 'folder-line', text: a.folder ? `📁 ${a.folder}` : '📁 sem pasta definida' })),
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
    el('div', { class: 'toggle' },
      el('span', { class: 'grow', text: updateLine() }),
      S.update?.state === 'dev' ? null : el('button', { text: 'Procurar atualização', onclick: checkForUpdate })),
    el('div', { class: 'pop-foot' },
      el('button', { text: 'Adicionar conta', onclick: addAccount }),
      el('button', { text: 'Pastas das contas…', onclick: () => openFoldersModal() }),
      el('button', { text: 'Nome/e-mail…', disabled: !S.active, onclick: openIdentityModal }),
      el('button', { text: 'Recarregar', onclick: reloadAccounts })),
  );
  openPopover(menu, $('accountBtn'));
}

// One row per account: its folder, a picker and, after a scan, a suggestion.
function openFoldersModal(suggested = null) {
  closePopovers();
  const rows = el('div', { class: 'folder-rows' });
  const draw = (sugg) => {
    rows.replaceChildren(...S.accounts.map((a) => {
      const input = el('input', { value: a.folder || '', placeholder: 'Nenhuma pasta definida', readonly: true });
      const s = sugg?.[a.login];
      return el('div', { class: 'folder-row' },
        avatar(a),
        el('strong', { text: `@${a.login}` }),
        el('div', { class: 'path-row' }, input,
          el('button', {
            type: 'button', text: 'Escolher…',
            onclick: async () => {
              const dir = await call('accounts:chooseFolder', a.login);
              if (dir) { await loadAccounts(); draw(sugg); }
            },
          }),
          a.folder ? el('button', { type: 'button', text: 'Abrir', onclick: () => call('shell:folder', a.folder) }) : null),
        s && s !== a.folder ? el('div', { class: 'suggest' },
          `Encontrei os repositórios dessa conta em ${s}`,
          el('button', {
            type: 'button', text: 'Usar',
            onclick: async () => { await call('accounts:setFolder', a.login, s); await loadAccounts(); draw(sugg); },
          })) : null);
    }));
  };
  draw(suggested);
  const detectBtn = el('button', {
    type: 'button', text: 'Detectar automaticamente',
    onclick: async () => {
      detectBtn.disabled = true;
      detectBtn.textContent = 'Procurando…';
      const res = await runDetect({ quiet: true });
      detectBtn.disabled = false;
      detectBtn.textContent = 'Detectar automaticamente';
      if (res) draw(res.suggested);
    },
  });
  openModal('Pastas das contas',
    [
      el('p', { class: 'hint', text: 'Cada conta tem uma pasta onde ficam os repositórios dela. É lá que o GitSwitch clona e para onde ele move os repositórios.' }),
      rows,
      el('div', {}, detectBtn),
    ],
    'Fechar',
    async () => {},
    { cancel: false });
}

// Looks on disk for each account's repos: sets missing account folders and
// remembers repos that aren't in the list yet.
async function runDetect({ quiet = false, openFor = null } = {}) {
  let res;
  try {
    res = await call('accounts:detect');
  } catch (err) {
    if (!quiet) toast(err.message, true);
    return null;
  }
  await loadAccounts();
  if (res.autoSet.length) {
    toast(res.autoSet.map((x) => `Pasta de @${x.login}: ${x.folder}`).join('\n'));
  }
  S.missing = res.missing;
  renderRepoHint();
  if (openFor && res.missing.some((m) => m.account === openFor)) openImportModal(openFor);
  return res;
}

function renderRepoHint() {
  const bar = $('repoHint');
  const n = S.missing.length;
  bar.hidden = !n;
  if (!n) return;
  bar.replaceChildren(
    el('span', { class: 'grow', text: n === 1 ? 'Encontrei 1 repositório das suas contas que ainda não está no GitSwitch.' : `Encontrei ${n} repositórios das suas contas que ainda não estão no GitSwitch.` }),
    el('button', { class: 'primary', text: 'Ver e adicionar', onclick: () => openImportModal() }),
    el('button', { class: 'ghost', text: 'Agora não', onclick: () => { bar.hidden = true; } }),
  );
}

function openImportModal(focusLogin = null) {
  closePopovers();
  const boxes = [];
  const groups = new Map();
  for (const m of S.missing) {
    if (!groups.has(m.account)) groups.set(m.account, []);
    groups.get(m.account).push(m);
  }
  const order = [...groups.keys()].sort((a, b) => (a === focusLogin ? -1 : b === focusLogin ? 1 : a.localeCompare(b)));
  const list = el('div', { class: 'check-list' }, order.map((login) => [
    el('div', { class: 'group', text: `@${login}` }),
    groups.get(login).map((m) => {
      const box = el('input', { type: 'checkbox' });
      box.checked = true;
      boxes.push([box, m]);
      return el('label', {}, box,
        el('span', { class: 'grow' }, el('span', { text: m.name }), el('span', { class: 'muted', text: `${m.fullName} · ${m.path}` })));
    }),
  ]));
  openModal('Repositórios encontrados no computador',
    [el('p', { class: 'hint', text: 'Cada repositório entra na lista já ligado à conta dona dele no GitHub.' }), list],
    'Adicionar selecionados',
    async () => {
      const chosen = boxes.filter(([b]) => b.checked).map(([, m]) => m);
      if (!chosen.length) return;
      await call('repos:addMany', chosen);
      const added = new Set(chosen.map((m) => m.path));
      S.missing = S.missing.filter((m) => !added.has(m.path));
      renderRepoHint();
      await loadRepos();
      if (!S.repo) await selectRepo(chosen[0].path);
      else await refresh();
      toast(chosen.length === 1 ? '1 repositório adicionado.' : `${chosen.length} repositórios adicionados.`);
    });
}

async function addAccount() {
  closePopovers();
  await call('accounts:add');
  S.awaitingLogin = true;
  S.knownLogins = S.accounts.map((a) => a.login);
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
  S.sel.clear();
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
  const item = (r) => el('button', {
      class: `item${r.path === S.repo ? ' current' : ''}`,
      onclick: () => selectRepo(r.path),
    },
    el('span', { class: 'check', text: r.path === S.repo ? '✓' : '' }),
    el('span', { class: 'grow' }, el('span', { text: r.name }), el('span', { class: 'muted', text: r.path })),
    el('span', {
      class: 'remove ghost', title: 'Remover da lista (não apaga a pasta)', text: '✕',
      onclick: async (e) => {
        e.stopPropagation();
        await call('repos:remove', r.path);
        await loadRepos();
        draw();
        if (!S.repo) await refresh();
      },
    }));
  // Grouped by account, the active account first.
  const draw = () => {
    const q = filter.value.toLowerCase();
    const shown = S.repos.filter((r) => r.name.toLowerCase().includes(q));
    if (!shown.length) {
      list.replaceChildren(el('div', { class: 'empty-list', text: 'Nenhum repositório.' }));
      return;
    }
    const groups = new Map();
    for (const r of shown) {
      const key = r.account || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const keys = [...groups.keys()].sort((a, b) => {
      if (a === S.active) return -1;
      if (b === S.active) return 1;
      if (!a) return 1;
      if (!b) return -1;
      return a.localeCompare(b);
    });
    list.replaceChildren(...keys.flatMap((k) => {
      const acc = S.accounts.find((a) => a.login === k);
      return [
        el('div', { class: 'pop-title group-title' }, k ? avatar(acc || { login: k }) : null, k ? `@${k}` : 'Sem conta'),
        ...groups.get(k).map(item),
      ];
    }));
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

// Searchable list of the active account's GitHub repos plus a URL box.
function remotePicker(onPick) {
  let remote = [];
  let picked = null;
  const search = el('input', { placeholder: 'Buscar nos repositórios da conta', autocomplete: 'off' });
  const list = el('div', { class: 'repo-pick' }, el('div', { class: 'empty-list', text: 'Carregando…' }));
  const url = el('input', { placeholder: 'https://github.com/dono/repo.git' });
  const draw = () => {
    const q = search.value.toLowerCase();
    const shown = remote.filter((r) => r.fullName.toLowerCase().includes(q)).slice(0, 200);
    list.replaceChildren(...(shown.length ? shown.map((r) => el('button', {
      type: 'button',
      class: `item${picked === r ? ' selected' : ''}`,
      onclick: () => {
        picked = r;
        url.value = r.cloneUrl;
        onPick(r.cloneUrl, r.name);
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
    onPick(url.value.trim(), m ? m[1] : '');
    draw();
  });
  call('repos:remote')
    .then((r) => { remote = r; draw(); })
    .catch((err) => list.replaceChildren(el('div', { class: 'empty-list', text: err.message })));
  return { nodes: [search, list, el('label', {}, 'Ou cole a URL', url)], url, focus: () => search.focus() };
}

async function openCloneModal() {
  closePopovers();
  const a = activeAccount();
  if (!a) { toast('Escolha uma conta primeiro.', true); return; }

  const name = el('input', {});
  const picker = remotePicker((_url, repoName) => { name.value = repoName; });
  const def = await call('repos:cloneDir');
  const dir = el('input', { value: def.dir });
  const makeDefault = el('input', { type: 'checkbox' });
  makeDefault.checked = !def.isAccountDir;
  const defaultRow = el('label', { class: 'inline-check' }, makeDefault, `Usar esta pasta como padrão de @${a.login}`);
  const syncDefaultRow = () => { defaultRow.hidden = def.isAccountDir && dir.value === def.dir; };
  syncDefaultRow();

  openModal(`Clonar como @${a.login}`,
    [
      ...picker.nodes,
      el('label', {}, def.isAccountDir ? `Pasta de destino (pasta de @${a.login})` : 'Pasta de destino',
        el('div', { class: 'path-row' }, dir, el('button', {
          type: 'button', text: 'Escolher…',
          onclick: async () => {
            const d = await call('repos:chooseCloneDir', dir.value);
            if (d) { dir.value = d; makeDefault.checked = !def.isAccountDir; syncDefaultRow(); }
          },
        }))),
      defaultRow,
      el('label', {}, 'Nome da pasta', name),
    ],
    'Clonar',
    async () => {
      const url = picker.url.value.trim();
      if (!url || !name.value.trim() || !dir.value.trim()) throw new Error('Escolha um repositório e a pasta de destino.');
      const added = await busy(`Clonando ${name.value}…`, () => call('repos:clone', url, dir.value.trim(), name.value.trim(), !defaultRow.hidden && makeDefault.checked));
      if (!added) return false;
      await loadAccounts();
      await loadRepos();
      await selectRepo(added);
      return true;
    });
  picker.focus();
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
    S.info = null;
    $('prBtn').hidden = true;
    renderAccountHint();
    renderMergeHint();
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
  renderMergeHint();
  loadPr().catch(() => {});
  if (S.tab === 'history') await loadHistory();
}

// While a merge is open everything has to go into the commit.
const OPERATION_LABEL = { merge: 'Juntando branches', 'cherry-pick': 'Aplicando commit (cherry-pick)', revert: 'Revertendo commit', rebase: 'Rebase em andamento' };

function renderMergeHint() {
  const bar = $('mergeHint');
  const i = S.info;
  const op = i?.operation;
  bar.hidden = !op;
  if (!op) return;
  const conflicts = i.files.filter((f) => f.kind === 'conflict').length;
  const text = op === 'rebase'
    ? 'Rebase em andamento (começou fora do GitSwitch). Continue pelo terminal ou cancele aqui.'
    : conflicts
      ? `${OPERATION_LABEL[op]}: ${conflicts} arquivo(s) em conflito. Abra cada um e escolha uma versão, depois faça commit.`
      : `${OPERATION_LABEL[op]}: sem conflitos pendentes. Faça commit para concluir.`;
  bar.replaceChildren(
    el('span', { class: 'grow', text }),
    el('button', {
      text: 'Cancelar',
      onclick: async () => {
        await busy('Cancelando…', () => call('repo:abortOperation', S.repo, op));
        showEmptyDiff();
        await refresh();
      },
    }),
  );
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
  } else if (i.behind > 0 && i.ahead > 0) {
    icon = '⇅';
    label = 'Pull ou forçar push';
    hint = `${i.behind} para baixar, ${i.ahead} para enviar`;
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

// ---------- line selection ----------
// Same fingerprint as git.js diffHash, so the main process can tell when a
// file changed after its lines were picked.
function diffHash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${text.length}:${h}`;
}

// 'all' | 'none' | 'partial' for a changed file.
function selState(p) {
  if (S.unchecked.has(p)) return 'none';
  const s = S.sel.get(p);
  if (!s || s.picked.size === s.all.length) return 'all';
  return s.picked.size ? 'partial' : 'none';
}

function setWholeFile(p, on) {
  S.sel.delete(p);
  if (on) S.unchecked.delete(p); else S.unchecked.add(p);
}

// Toggles change lines (indices into the raw diff) for the selected file.
function toggleLines(p, text, allChanges, indices, on) {
  let s = S.sel.get(p);
  if (!s || s.hash !== diffHash(text)) {
    const start = S.unchecked.has(p) ? [] : allChanges;
    s = { hash: diffHash(text), all: allChanges, picked: new Set(start) };
  }
  S.unchecked.delete(p);
  for (const i of indices) if (on) s.picked.add(i); else s.picked.delete(i);
  if (s.picked.size === s.all.length) S.sel.delete(p);
  else if (!s.picked.size) setWholeFile(p, false);
  else S.sel.set(p, s);
}

// ---------- changes list ----------
function renderFiles() {
  const files = S.info.files;
  const known = new Set(files.map((f) => f.path));
  for (const p of S.unchecked) if (!known.has(p) || S.info.merging) S.unchecked.delete(p);
  for (const p of S.sel.keys()) if (!known.has(p) || S.info.merging) S.sel.delete(p);
  if (S.selectedFile && !known.has(S.selectedFile)) {
    S.selectedFile = null;
    if (S.tab === 'changes') showEmptyDiff();
  }

  $('changesCount').textContent = files.length;
  const states = files.map((f) => selState(f.path));
  const all = $('selectAll');
  all.checked = files.length > 0 && states.every((s) => s === 'all');
  all.indeterminate = !all.checked && states.some((s) => s !== 'none');
  all.disabled = files.length === 0 || S.info.merging;
  $('selectAllLabel').textContent = files.length === 1 ? '1 arquivo alterado' : `${files.length} arquivos alterados`;
  $('stashBtn').hidden = !files.length || S.info.merging;

  const list = $('fileList');
  if (!files.length) {
    list.replaceChildren(el('li', { class: 'empty-list', text: 'Nenhuma alteração local.' }));
  } else {
    list.replaceChildren(...files.map((f, idx) => {
      const box = el('input', { type: 'checkbox', title: S.info.merging ? 'Durante a junção tudo entra no commit' : 'Incluir no commit' });
      box.checked = states[idx] === 'all';
      box.indeterminate = states[idx] === 'partial';
      box.disabled = S.info.merging;
      box.addEventListener('click', (e) => e.stopPropagation());
      box.addEventListener('change', () => {
        setWholeFile(f.path, box.checked);
        renderFiles();
        if (S.selectedFile === f.path) selectFile(f, { keepScroll: true });
      });
      return el('li', {
        class: f.path === S.selectedFile ? 'selected' : null,
        title: f.orig ? `${f.orig} → ${f.path}` : f.path,
        onclick: () => selectFile(f),
        oncontextmenu: (e) => { e.preventDefault(); fileMenu(f); },
      },
      box,
      el('span', { class: 'file-path', text: `‎${f.path}` }),
      el('span', { class: `kind ${f.kind}`, title: KIND_LABEL[f.kind], text: KIND_LETTER[f.kind] }));
    }));
  }
  renderStashRow();
  renderUndoRow();
  updateCommitButton();
}

function renderStashRow() {
  const row = $('stashRow');
  const n = S.info?.stashes?.length || 0;
  row.hidden = !n;
  if (!n) return;
  row.replaceChildren(el('button', {
    class: 'link-row',
    onclick: openStashModal,
  }, el('span', { class: 'grow', text: n === 1 ? '1 conjunto de alterações guardado' : `${n} conjuntos de alterações guardados` }), el('span', { text: 'Ver ›' })));
}

// "Desfazer" for the newest commit while it only exists on this computer.
function renderUndoRow() {
  const row = $('undoRow');
  const i = S.info;
  const unpushed = i?.head && (!i.upstream || i.ahead > 0) && !i.merging;
  row.hidden = !unpushed;
  $('amendRow').hidden = !i?.head || i.merging;
  if (!unpushed) return;
  row.replaceChildren(
    el('span', { class: 'grow' }, el('span', { class: 'muted', text: `Último commit ${ago(i.head.date)}` }), el('strong', { text: i.head.subject })),
    el('button', { text: 'Desfazer', onclick: undoCommit }),
  );
}

// During a merge an empty summary falls back to a default message.
function commitSummary() {
  return $('summary').value.trim() || (S.info?.merging ? 'Juntar com o GitHub' : '');
}

function commitFiles() {
  return S.info.files.flatMap((f) => {
    const st = selState(f.path);
    if (st === 'none') return [];
    if (st === 'partial') {
      const s = S.sel.get(f.path);
      return [{ ...f, lines: [...s.picked], hash: s.hash }];
    }
    return [f];
  });
}

function updateCommitButton() {
  const count = S.info ? commitFiles().length : 0;
  const amend = $('amend').checked;
  const btn = $('commitBtn');
  btn.textContent = amend
    ? `Emendar o último commit${count ? ` (+${count})` : ''}`
    : `Commit em ${S.info?.branch || 'HEAD'}${count ? ` (${count})` : ''}`;
  const conflicts = S.info?.files.some((f) => f.kind === 'conflict');
  btn.disabled = (!count && !amend) || !commitSummary() || !S.active || conflicts || S.info?.operation === 'rebase';
  $('summary').placeholder = S.info?.merging ? 'Juntar com o GitHub' : 'Resumo (obrigatório)';
}

// ---------- diff ----------
async function selectFile(f, { keepScroll = false } = {}) {
  S.selectedFile = f.path;
  renderFiles();
  const scroll = $('diff').scrollTop;
  try {
    const d = await call('repo:diff', S.repo, f, S.info.initial);
    if (S.selectedFile !== f.path) return;
    const resolveWith = (side) => async () => {
      await busy('Resolvendo…', () => call('repo:resolve', S.repo, f.path, side));
      await refresh();
      const again = S.info.files.find((x) => x.path === f.path);
      if (again) selectFile(again); else showEmptyDiff();
    };
    const actions = [];
    if (f.kind === 'conflict') {
      actions.push(
        el('button', { text: 'Usar a desta pasta', onclick: resolveWith('ours') }),
        el('button', { text: 'Usar a outra versão', onclick: resolveWith('theirs') }),
      );
    }
    if (d.kind === 'text') actions.push(whitespaceToggle(() => selectFile(f, { keepScroll: true })));
    if (f.kind !== 'conflict' && !S.info.merging) {
      actions.push(el('button', { class: 'danger', text: 'Descartar', title: 'Descartar as alterações deste arquivo', onclick: () => discard([f]) }));
    }
    const header = el('div', { class: 'diff-header' },
      el('span', { class: `kind ${f.kind}`, text: KIND_LETTER[f.kind] }),
      el('span', { class: 'grow', text: f.orig ? `${f.orig} → ${f.path}` : f.path }),
      ...actions);

    let body;
    if (d.kind === 'image') body = renderImageDiff(d);
    else if (d.kind === 'large') body = el('div', { class: 'binary', text: `Diff grande demais para mostrar (${Math.round(d.size / 1024 / 1024)} MB). Abra o arquivo no editor.` });
    else {
      const selectable = !S.settings.hideWhitespace && !S.info.merging && f.kind !== 'conflict';
      body = renderDiff(d.text, selectable ? {
        state: () => {
          if (S.unchecked.has(f.path)) return null;
          const s = S.sel.get(f.path);
          return s && s.hash === diffHash(d.text) ? s.picked : 'all';
        },
        toggle: (indices, on, all) => {
          toggleLines(f.path, d.text, all, indices, on);
          renderFiles();
        },
      } : null, { titles: false });
      if (!selectable && S.settings.hideWhitespace && !S.info.merging) {
        body.prepend(el('div', { class: 'diff-note', text: 'Com os espaços ocultos não dá para escolher linhas. O commit leva o arquivo inteiro.' }));
      }
    }
    $('diff').replaceChildren(header, body);
    $('diff').scrollTop = keepScroll ? scroll : 0;
  } catch (err) {
    toast(err.message, true, err.detail);
  }
}

function whitespaceToggle(rerender) {
  const on = S.settings.hideWhitespace;
  return el('button', {
    class: `toggle-btn${on ? ' on' : ''}`,
    'aria-pressed': on ? 'true' : 'false',
    title: 'Ocultar mudanças só de espaço em branco',
    text: on ? 'Espaços ocultos' : 'Ocultar espaços',
    onclick: async () => {
      S.settings = { ...S.settings, ...(await call('settings:set', { hideWhitespace: !on })) };
      rerender();
    },
  });
}

function renderImageDiff(d) {
  const pane = (label, src) => el('figure', { class: 'img-pane' },
    el('figcaption', { text: label }),
    src ? el('img', { src, alt: label }) : el('div', { class: 'img-empty', text: label === 'Antes' ? 'Arquivo novo' : 'Arquivo removido' }));
  return el('div', { class: 'img-diff' }, pane('Antes', d.before), pane('Depois', d.after));
}

async function fileMenu(f) {
  const ext = f.path.includes('.') ? f.path.slice(f.path.lastIndexOf('.')) : '';
  const picked = await call('menu:popup', [
    { id: 'discard', label: 'Descartar alterações…', enabled: !S.info.merging && f.kind !== 'conflict' },
    { type: 'separator' },
    { id: 'ignore', label: 'Ignorar este arquivo (.gitignore)' },
    { id: 'ignoreExt', label: `Ignorar todos os arquivos ${ext}`, enabled: Boolean(ext) },
    { type: 'separator' },
    { id: 'copy', label: 'Copiar caminho' },
    { id: 'copyFull', label: 'Copiar caminho completo' },
    { id: 'show', label: 'Mostrar no Explorer', enabled: f.kind !== 'deleted' },
  ]);
  const abs = `${S.repo}\\${f.path.replaceAll('/', '\\')}`;
  if (picked === 'discard') discard([f]);
  else if (picked === 'ignore' || picked === 'ignoreExt') {
    await busy('Atualizando .gitignore…', () => call('repo:ignore', S.repo, picked === 'ignore' ? f.path : `*${ext}`));
    await refresh();
  } else if (picked === 'copy') call('clipboard:write', f.path);
  else if (picked === 'copyFull') call('clipboard:write', abs);
  else if (picked === 'show') call('shell:showItem', abs);
}

async function discard(files) {
  const done = await busy('Descartando…', () => call('repo:discard', S.repo, files, S.info.initial));
  if (done) {
    for (const f of files) S.sel.delete(f.path);
    showEmptyDiff();
    await refresh();
  }
}

function showEmptyDiff(text = 'Selecione um arquivo para ver as alterações.') {
  $('diff').replaceChildren(el('div', { class: 'empty-diff', text }));
}

// ---------- diff rendering ----------
const MAX_LINES = 15000;

// sel (optional): { state() -> 'all' | Set | null, toggle(indices, on, allChanges) }
// makes +/- lines pickable: click the gutter for a line, the @@ row for a hunk,
// shift-click for a range.
function renderDiff(text, sel = null, { titles = true } = {}) {
  const out = document.createDocumentFragment();
  const preamble = [];
  let block = null;
  let table = null;
  let inHeader = false;
  let oldN = 0;
  let newN = 0;
  let count = 0;
  const changeRows = [];
  const hunks = [];
  let hunk = null;

  const startBlock = (title) => {
    block = el('div', { class: 'file-block' });
    if (title && titles) block.append(el('div', { class: 'file-title', text: title }));
    out.append(block);
    table = null;
  };
  const row = (cls, a, b, src) => {
    if (!table) {
      if (!block) startBlock(null);
      table = el('table', { class: `code${sel ? ' pickable' : ''}` });
      block.append(table);
    }
    const tr = el('tr', { class: cls },
      el('td', { class: 'ln', text: a }), el('td', { class: 'ln', text: b }), el('td', { class: 'src', text: src.replace(/\r$/, '') }));
    table.append(tr);
    return tr;
  };

  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (++count > MAX_LINES) {
      out.append(el('div', { class: 'binary', text: 'Diff muito grande: mostrando só o começo.' }));
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
      block.append(el('div', { class: 'binary', text: 'Arquivo binário: sem visualização de texto.' }));
      inHeader = false;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldN = Number(m[1]); newN = Number(m[2]); }
      hunk = { tr: row('hunk', '', '', line), rows: [] };
      hunks.push(hunk);
      inHeader = false;
      continue;
    }
    if (inHeader) continue;
    if (!block && !hunk) { preamble.push(line); continue; }
    const c = line[0];
    if (c === '+' || c === '-') {
      const tr = row(c === '+' ? 'add' : 'del', c === '-' ? oldN++ : '', c === '+' ? newN++ : '', line.slice(1));
      tr.dataset.i = i;
      changeRows.push(tr);
      hunk?.rows.push(tr);
    } else if (c === '\\') row('hunk', '', '', line);
    else row('', oldN++, newN++, line.slice(1));
  }

  if (sel && changeRows.length) {
    const all = changeRows.map((tr) => Number(tr.dataset.i));
    const paint = () => {
      const st = sel.state();
      for (const tr of changeRows) {
        const on = st === 'all' || (st instanceof Set && st.has(Number(tr.dataset.i)));
        tr.classList.toggle('picked', on);
        tr.classList.toggle('unpicked', !on);
      }
      for (const h of hunks) {
        const n = h.rows.filter((tr) => tr.classList.contains('picked')).length;
        h.tr.classList.toggle('partial', n > 0 && n < h.rows.length);
        h.tr.classList.toggle('none', h.rows.length > 0 && n === 0);
      }
    };
    let last = null;
    for (const tr of changeRows) {
      for (const td of tr.querySelectorAll('td.ln')) {
        td.title = 'Clique para incluir ou tirar esta linha do commit (Shift para um intervalo)';
        td.addEventListener('click', (e) => {
          const idx = changeRows.indexOf(tr);
          const on = !tr.classList.contains('picked');
          const range = e.shiftKey && last !== null
            ? changeRows.slice(Math.min(last, idx), Math.max(last, idx) + 1)
            : [tr];
          last = idx;
          sel.toggle(range.map((r) => Number(r.dataset.i)), on, all);
          paint();
        });
      }
    }
    for (const h of hunks) {
      if (!h.rows.length) continue;
      h.tr.title = 'Clique para incluir ou tirar este trecho do commit';
      h.tr.classList.add('hunk-pick');
      h.tr.addEventListener('click', () => {
        const on = !h.rows.every((tr) => tr.classList.contains('picked'));
        sel.toggle(h.rows.map((r) => Number(r.dataset.i)), on, all);
        paint();
      });
    }
    paint();
  }

  const message = preamble.join('\n').trim();
  if (message) out.prepend(el('div', { class: 'commit-msg', text: message }));
  if (!out.childNodes.length) out.append(el('div', { class: 'binary', text: 'Sem diferenças de conteúdo (pode ser só mudança de permissão).' }));
  const wrap = el('div', {});
  wrap.append(out);
  return wrap;
}

// ---------- history ----------
async function loadHistory() {
  S.commits = await call('repo:log', S.repo);
  const list = $('commitList');
  if (!S.commits.length) {
    list.replaceChildren(el('li', { class: 'empty-list', text: 'Nenhum commit ainda.' }));
    return;
  }
  list.replaceChildren(...S.commits.map((c, idx) => el('li', {
    class: `commit-item${c.sha === S.selectedCommit ? ' selected' : ''}`,
    'data-sha': c.sha,
    onclick: () => selectCommit(c),
    oncontextmenu: (e) => { e.preventDefault(); commitMenu(c, idx); },
  },
  el('span', { class: 'subject', text: c.subject }),
  el('span', { class: 'muted' },
    isUnpushed(idx) ? el('span', { class: 'ref local', title: 'Ainda não foi enviado ao GitHub', text: '↑ local' }) : null,
    ...(c.refs || '').split(', ').filter(Boolean).map((r) => el('span', { class: 'ref', text: r.replace('HEAD -> ', '') })),
    `${c.author} · ${ago(c.date)} · ${c.short}`))));
}

// Commits at the top of the list that the GitHub branch doesn't have yet.
function isUnpushed(idx) {
  const i = S.info;
  if (!i?.remoteUrl) return false;
  return !i.upstream || idx < i.ahead;
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
        el('span', { class: 'muted', text: `${c.author} <${c.email}> · ${new Date(c.date).toLocaleString('pt-BR')} · ${c.short}` })),
      whitespaceToggle(() => selectCommit(c)));
    $('diff').replaceChildren(header, renderDiff(text));
    $('diff').scrollTop = 0;
  } catch (err) {
    toast(err.message, true, err.detail);
  }
}

async function commitMenu(c, idx) {
  const isHead = idx === 0;
  const unpushed = isUnpushed(idx) || !S.info.remoteUrl;
  const web = githubWebUrl();
  const picked = await call('menu:popup', [
    { id: 'copy', label: 'Copiar SHA' },
    { id: 'copyMsg', label: 'Copiar mensagem' },
    { type: 'separator' },
    { id: 'branch', label: 'Criar branch a partir deste commit…' },
    { id: 'checkout', label: 'Fazer checkout deste commit' },
    { id: 'revert', label: 'Reverter este commit' },
    { type: 'separator' },
    { id: 'undo', label: 'Desfazer este commit', enabled: isHead && unpushed && !S.info.merging },
    { id: 'amend', label: 'Emendar este commit', enabled: isHead && !S.info.merging },
    { type: 'separator' },
    { id: 'web', label: 'Ver no GitHub', enabled: Boolean(web) && !unpushed },
    { type: 'separator' },
    { id: 'tag', label: 'Criar tag neste commit…' },
    ...tagsOf(c).map((t) => ({ id: `deltag:${t}`, label: `Apagar a tag ${t}…` })),
    { id: 'cherry', label: 'Aplicar este commit em outra branch (cherry-pick)…' },
    { id: 'squash', label: idx > 0 ? `Juntar os ${idx + 1} commits mais novos (até este) em um só…` : 'Juntar commits (escolha um mais antigo)', enabled: idx > 0 && unpushedRange(idx) && !S.info.merging },
  ]);
  if (picked === 'copy') { call('clipboard:write', c.sha); toast('SHA copiado.'); }
  else if (picked === 'copyMsg') call('clipboard:write', c.subject);
  else if (picked === 'branch') openNewBranchModal(c);
  else if (picked === 'checkout') {
    await busy(`Indo para ${c.short}…`, () => call('repo:checkoutCommit', S.repo, c.sha));
    toast('Você está num commit fora de branch. Crie uma branch para guardar trabalho novo aqui.');
    await refresh();
  } else if (picked === 'revert') {
    const ok = await busy('Revertendo…', async () => { await call('repo:revert', S.repo, c.sha, c.parents.length); return true; });
    if (ok) toast(`Criado um commit que desfaz "${c.subject}".`);
    await refresh();
  } else if (picked === 'undo') undoCommit();
  else if (picked === 'amend') { setTab('changes'); startAmend(); }
  else if (picked === 'web') call('shell:url', `${web}/commit/${c.sha}`);
  else if (picked === 'tag') openTagModal(c);
  else if (picked?.startsWith('deltag:')) {
    const done = await busy('Apagando a tag…', () => call('repo:deleteTag', S.repo, picked.slice(7)));
    if (done) { toast('Tag apagada.'); await refresh(); }
  } else if (picked === 'cherry') openCherryPickModal(c);
  else if (picked === 'squash') openSquashModal(c, idx);
}

function githubWebUrl() {
  const m = S.info?.remoteUrl?.match(/github\.com[:/](.+?)(\.git)?\/?$/);
  return m ? `https://github.com/${m[1]}` : null;
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

// ---------- undo / amend ----------
async function undoCommit() {
  const message = await busy('Desfazendo o commit…', () => call('repo:undo', S.repo));
  if (message === undefined) return;
  const [summary, ...rest] = message.split('\n');
  $('summary').value = summary;
  $('description').value = rest.join('\n').trim();
  $('amend').checked = false;
  toast('Commit desfeito. As alterações voltaram para a lista.');
  if (S.tab !== 'changes') setTab('changes');
  await refresh();
}

async function startAmend() {
  $('amend').checked = true;
  if (!$('summary').value.trim()) {
    const message = await call('repo:lastMessage', S.repo).catch(() => '');
    const [summary, ...rest] = message.split('\n');
    $('summary').value = summary;
    $('description').value = rest.join('\n').trim();
  }
  const pushed = S.info.upstream && S.info.ahead === 0;
  $('amendHint').hidden = !pushed;
  updateCommitButton();
  $('summary').focus();
}

// ---------- branches ----------
async function openBranchMenu() {
  const menu = $('branchMenu');
  let data;
  try {
    data = await call('repo:branches', S.repo);
  } catch (err) {
    toast(err.message, true, err.detail);
    return;
  }
  const filter = el('input', { placeholder: 'Filtrar branches', autocomplete: 'off' });
  const list = el('div', { class: 'pop-list' });
  const item = (name, isRemote) => el('button', {
    class: `item${name === S.info.branch ? ' current' : ''}`,
    onclick: () => checkout(name, isRemote),
    oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); branchItemMenu(name, isRemote); },
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
      remote.length ? el('div', { class: 'pop-title', text: 'Só no GitHub' }) : null,
      ...remote.map((b) => item(b, true)),
    );
  };
  filter.addEventListener('input', draw);
  draw();
  menu.replaceChildren(
    el('div', { class: 'pop-head' }, filter),
    list,
    el('div', { class: 'pop-foot' },
      el('button', { class: 'primary', text: 'Nova branch…', onclick: () => openNewBranchModal() }),
      el('button', { text: 'Juntar outra branch nesta…', disabled: !S.info.branch, onclick: () => openMergeModal(data) }),
      el('p', { class: 'hint', text: 'Clique com o botão direito numa branch para renomear ou apagar.' })),
  );
  openPopover(menu, $('branchBtn'));
  filter.focus();
}

async function branchItemMenu(name, isRemote) {
  const current = name === S.info.branch;
  const picked = await call('menu:popup', [
    { id: 'checkout', label: 'Trocar para esta branch', enabled: !current },
    { id: 'merge', label: `Juntar em ${S.info.branch || 'HEAD'}`, enabled: !current && Boolean(S.info.branch) },
    { type: 'separator' },
    { id: 'rename', label: 'Renomear…', enabled: !isRemote },
    { id: 'delete', label: 'Apagar…', enabled: !isRemote && !current },
    { type: 'separator' },
    { id: 'copy', label: 'Copiar nome' },
  ]);
  closePopovers();
  if (picked === 'checkout') checkout(name, isRemote);
  else if (picked === 'merge') mergeBranch(name);
  else if (picked === 'rename') openRenameBranchModal(name);
  else if (picked === 'copy') call('clipboard:write', name);
  else if (picked === 'delete') {
    const done = await busy('Apagando a branch…', () => call('repo:deleteBranch', S.repo, name));
    if (done) toast(`Branch ${name} apagada.`);
  }
}

async function checkout(name, isRemote) {
  closePopovers();
  try {
    await busy(`Mudando para ${name}…`, () => call('repo:checkout', S.repo, name, isRemote), { rethrow: true });
  } catch (err) {
    if (err.kind !== 'dirty') { toast(err.message, true, err.detail); return; }
    // Like GitHub Desktop: offer to put the changes aside and switch anyway.
    const pick = await choose('Suas alterações atrapalham a troca',
      `Algumas alterações em ${S.info.branch} seriam sobrescritas por ${name}. Guarde-as (stash) para trazer de volta depois.`,
      [['stash', 'Guardar e trocar', true], ['cancel', 'Cancelar']]);
    if (pick !== 'stash') return;
    const ok = await busy('Guardando e trocando…', async () => {
      await call('repo:stashPush', S.repo, S.info.branch);
      await call('repo:checkout', S.repo, name, isRemote);
      return true;
    });
    if (ok) toast(`Alterações guardadas. Elas estão em "Alterações guardadas" quando você quiser.`);
  }
  S.sel.clear();
  S.unchecked.clear();
  await refresh();
}

function openNewBranchModal(fromCommit = null) {
  closePopovers();
  const name = el('input', { placeholder: 'minha-feature', autocomplete: 'off' });
  openModal('Nova branch',
    [el('label', {}, fromCommit ? `Criada a partir do commit ${fromCommit.short}` : `Criada a partir de ${S.info.branch || 'HEAD'}`, name)],
    'Criar branch',
    async () => {
      const n = name.value.trim().replace(/\s+/g, '-');
      if (!n) throw new Error('Dê um nome para a branch.');
      await call('repo:createBranch', S.repo, n, fromCommit?.sha);
      await refresh();
    });
  name.focus();
}

function openRenameBranchModal(old) {
  const name = el('input', { value: old, autocomplete: 'off' });
  openModal(`Renomear ${old}`, [el('label', {}, 'Novo nome', name)], 'Renomear', async () => {
    const n = name.value.trim().replace(/\s+/g, '-');
    if (!n || n === old) throw new Error('Escolha um nome diferente.');
    await call('repo:renameBranch', S.repo, old, n);
    await refresh();
  });
  name.select();
}

function openMergeModal(data) {
  closePopovers();
  const options = [...data.local.filter((b) => b !== S.info.branch), ...data.remote.map((r) => r)];
  let picked = null;
  const filter = el('input', { placeholder: 'Filtrar branches', autocomplete: 'off' });
  const list = el('div', { class: 'repo-pick' });
  const draw = () => {
    const q = filter.value.toLowerCase();
    list.replaceChildren(...options.filter((b) => b.toLowerCase().includes(q)).map((b) => el('button', {
      type: 'button', class: `item${picked === b ? ' selected' : ''}`,
      onclick: () => { picked = b; draw(); },
    }, el('span', { class: 'grow', text: b }))));
  };
  filter.addEventListener('input', draw);
  draw();
  openModal(`Juntar em ${S.info.branch}`, [
    el('p', { class: 'hint', text: 'Os commits da branch escolhida entram na branch atual. Se houver conflito, você escolhe a versão de cada arquivo.' }),
    filter, list,
  ], 'Juntar', async () => {
    if (!picked) throw new Error('Escolha uma branch.');
    closeModal();
    await mergeBranch(picked);
  });
  filter.focus();
}

async function mergeBranch(name) {
  const result = await busy(`Juntando ${name}…`, () => call('repo:merge', S.repo, name));
  if (result === 'merged') toast(`${name} foi juntada em ${S.info.branch}.`);
  if (result === 'conflicts') toast('Há conflitos. Resolva os arquivos marcados com ! e faça commit.', true);
  await refresh();
}

// ---------- stash ----------
async function stashChanges() {
  const ok = await busy('Guardando alterações…', async () => { await call('repo:stashPush', S.repo, S.info.branch); return true; });
  if (ok) toast('Alterações guardadas. A lista ficou limpa.');
  S.sel.clear();
  S.unchecked.clear();
  showEmptyDiff();
  await refresh();
}

function openStashModal() {
  const rows = (S.info.stashes || []).map((s) => el('div', { class: 'stash-item' },
    el('span', { class: 'grow' }, el('strong', { text: s.message.replace(/^On [^:]+: /, '') }), el('span', { class: 'muted', text: `${ago(s.date)} · ${s.ref}` })),
    el('button', { type: 'button', text: 'Ver', onclick: async () => {
      closeModal();
      const text = await call('repo:stashShow', S.repo, s.ref);
      $('diff').replaceChildren(el('div', { class: 'diff-header' }, el('span', { class: 'grow', text: `Alterações guardadas: ${s.message.replace(/^On [^:]+: /, '')}` })), renderDiff(text));
    } }),
    el('button', { type: 'button', class: 'primary', text: 'Restaurar', onclick: async () => {
      closeModal();
      const ok = await busy('Restaurando…', async () => { await call('repo:stashPop', S.repo, s.ref); return true; });
      if (ok) toast('Alterações restauradas.');
      await refresh();
    } }),
    el('button', { type: 'button', class: 'danger', text: 'Descartar', onclick: async () => {
      const done = await busy('Descartando…', () => call('repo:stashDrop', S.repo, s.ref));
      if (done) { closeModal(); await refresh(); }
    } })));
  openModal('Alterações guardadas', [
    el('p', { class: 'hint', text: 'Alterações que você tirou da frente (stash). Restaurar traz de volta para a lista de alterações.' }),
    ...rows,
  ], 'Fechar', async () => {}, { cancel: false });
}

// ---------- sync ----------
function syncAction() {
  const i = S.info;
  if (!i?.remoteUrl || !i.branch) return null;
  if (!i.upstream) return 'publish';
  if (i.behind > 0 && i.ahead > 0) return 'diverged';
  if (i.behind > 0) return 'pull';
  if (i.ahead > 0) return 'push';
  return 'fetch';
}

async function sync() {
  const action = syncAction();
  if (!action) return;
  const who = S.active;
  let ran = action;
  if (action === 'diverged') {
    ran = await call('menu:popup', [
      { id: 'pull', label: 'Pull: juntar os commits do GitHub com os seus' },
      { id: 'force', label: 'Forçar push: deixar o GitHub igual a esta branch' },
    ]);
    if (!ran) return;
  }
  const steps = {
    publish: ['Publicando', () => call('repo:push', S.repo, false, false)],
    pull: ['Pull', () => call('repo:pull', S.repo)],
    push: ['Push', () => call('repo:push', S.repo, true, false)],
    force: ['Push forçado', () => call('repo:push', S.repo, true, true)],
    fetch: ['Fetch', () => call('repo:fetch', S.repo)],
  };
  const [label, fn] = steps[ran];
  try {
    const result = await busy(`${label} como ${who}…`, fn, { rethrow: true });
    if (result !== false) toast(`${label} concluído como ${who}.`);
  } catch (err) {
    if (err.kind !== 'rejected' || (ran !== 'push' && ran !== 'publish')) toast(err.message, true, err.detail);
    else {
      const pick = await choose('O GitHub tem commits que você não tem',
        'Faça Pull para juntar os commits do GitHub com os seus. Forçar substitui o que está no GitHub por esta branch.',
        [['pull', 'Fazer Pull', true], ['force', 'Forçar push'], ['cancel', 'Cancelar']]);
      if (pick === 'pull') await busy(`Pull como ${who}…`, () => call('repo:pull', S.repo));
      if (pick === 'force') await busy(`Push forçado como ${who}…`, () => call('repo:push', S.repo, true, true));
    }
  }
  S.lastFetch = Date.now();
  await loadRepos();
  await refresh();
}

// ---------- commit ----------
async function commit(e) {
  e.preventDefault();
  const files = commitFiles();
  const amend = $('amend').checked;
  const summary = commitSummary();
  const trailers = coauthorTrailers();
  const description = [$('description').value.trim(), trailers].filter(Boolean).join('\n\n');
  if ((!files.length && !amend) || !summary) return;
  const ok = await busy(amend ? 'Emendando o commit…' : 'Fazendo commit…', async () => {
    await call('repo:commit', S.repo, files, description ? `${summary}\n\n${description}` : summary,
      { initial: S.info.initial, merging: S.info.merging, amend });
    return true;
  });
  if (!ok) return;
  $('summary').value = '';
  $('description').value = '';
  $('coauthors').value = '';
  $('amend').checked = false;
  $('amendHint').hidden = true;
  S.sel.clear();
  S.unchecked.clear();
  toast(amend ? 'Commit emendado.' : `Commit feito como ${activeAccount()?.identity.name}.`);
  await loadRepos();
  showEmptyDiff();
  await refresh();
}

// ---------- folder: move, join, connect ----------
function openFolderMenu() {
  const menu = $('folderMenu');
  const rec = repoRecord();
  const owner = S.accounts.find((a) => a.login === (rec?.account || S.active));
  const parent = S.repo.replace(/[\\/][^\\/]+$/, '');
  const inAccountDir = owner?.folder && parent.toLowerCase() === owner.folder.toLowerCase();
  const entry = (title, sub, onclick) => el('button', { class: 'item', onclick },
    el('span', { class: 'grow' }, el('span', { text: title }), sub ? el('span', { class: 'muted', text: sub }) : null));

  menu.replaceChildren(
    el('div', { class: 'pop-title', text: 'Pasta do repositório' }),
    el('div', { class: 'pop-list' },
      entry('Abrir no Explorer', S.repo, () => { closePopovers(); call('shell:folder', S.repo); }),
      owner?.folder && !inAccountDir
        ? entry(`Mover para a pasta de @${owner.login}`, owner.folder, () => moveRepo(owner.folder))
        : null,
      entry('Mover para outra pasta…', 'Escolha onde o repositório deve ficar', () => moveRepo(null)),
      S.info?.remoteUrl
        ? entry('Juntar com uma pasta que já existe…', 'Liga uma pasta sua a este repositório do GitHub', joinFolder)
        : entry('Conectar ao GitHub…', 'Liga esta pasta a um repositório do GitHub', openConnectModal),
    ),
  );
  openPopover(menu, $('folderBtn'));
}

async function moveRepo(destParent) {
  closePopovers();
  const moved = await busy('Movendo a pasta…', () => call('repo:move', S.repo, destParent));
  if (!moved) return;
  await loadRepos();
  await selectRepo(moved);
  toast(`Repositório agora está em ${moved}`);
}

async function joinFolder() {
  closePopovers();
  const res = await busy('Juntando com o GitHub…', () => call('repo:linkFolder', S.repo));
  if (!res) return;
  await loadRepos();
  await selectRepo(res.path);
  toast(res.message);
}

function openConnectModal() {
  closePopovers();
  const a = activeAccount();
  const picker = remotePicker(() => {});
  openModal(`Conectar ${repoRecord()?.name} ao GitHub como @${a?.login}`,
    [
      el('p', { class: 'hint', text: 'Nada nesta pasta é apagado. Se ela ainda não tem commits, ela passa a seguir o GitHub e as diferenças aparecem em Alterações. Se já tem, os dois históricos são unidos.' }),
      ...picker.nodes,
    ],
    'Conectar',
    async () => {
      const url = picker.url.value.trim();
      if (!url) throw new Error('Escolha um repositório do GitHub.');
      const res = await busy('Conectando…', () => call('repo:connect', S.repo, url));
      if (!res) return false;
      await loadRepos();
      await refresh();
      toast(res.message);
      return true;
    });
  picker.focus();
}

// ---------- open in ----------
async function loadApps() {
  S.apps = await call('apps:list');
  renderOpenButton();
}

function allApps() {
  return S.apps ? [...S.apps.editors, ...S.apps.clis, ...S.apps.custom] : [];
}

function renderOpenButton() {
  const app = allApps().find((a) => a.id === S.apps?.openWith) || allApps()[0];
  $('openLabel').textContent = app ? `Abrir em ${app.name}` : 'Abrir';
  $('openBtn').dataset.app = app?.id || '';
}

async function openIn(id) {
  closePopovers();
  if (!id) { openOpenMenu(); return; }
  try {
    await call('apps:open', id, S.repo);
    S.apps.openWith = id;
    renderOpenButton();
  } catch (err) {
    toast(err.message, true);
  }
}

function openOpenMenu() {
  const menu = $('openMenu');
  const item = (a, removable) => el('button', { class: `item${a.id === S.apps.openWith ? ' current' : ''}`, onclick: () => openIn(a.id) },
    el('span', { class: 'check', text: a.id === S.apps.openWith ? '✓' : '' }),
    el('span', { class: 'grow' }, el('span', { text: a.name }), a.kind === 'terminal' && a.command ? el('span', { class: 'muted', text: `${a.command} no terminal` }) : null),
    removable ? el('span', {
      class: 'remove ghost', title: 'Remover', text: '✕',
      onclick: async (e) => {
        e.stopPropagation();
        await call('apps:removeCustom', a.id);
        await loadApps();
        closePopovers();
        openOpenMenu();
      },
    }) : null);
  const section = (title, list, removable = false) => (list.length
    ? [el('div', { class: 'pop-title', text: title }), ...list.map((a) => item(a, removable))]
    : []);
  menu.replaceChildren(
    el('div', { class: 'pop-list' },
      ...section('Editores', S.apps.editors),
      ...section('IA e terminal', S.apps.clis),
      ...section('Meus apps', S.apps.custom, true)),
    el('div', { class: 'pop-foot' }, el('button', { text: 'Adicionar app…', onclick: openAddAppModal })),
  );
  openPopover(menu, $('openMenuBtn'));
}

function openAddAppModal() {
  closePopovers();
  let kind = 'exe';
  const name = el('input', { placeholder: 'Ex.: Claude, Windsurf, Notepad++' });
  const command = el('input', { placeholder: 'C:\\caminho\\para\\programa.exe' });
  const args = el('input', { value: '"{path}"' });
  const pickBtn = el('button', {
    type: 'button', text: 'Procurar…',
    onclick: async () => {
      const p = await call('apps:pickExe');
      if (!p) return;
      command.value = p;
      if (!name.value) name.value = p.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, '');
    },
  });
  const commandLabel = el('label', {}, 'Programa', el('div', { class: 'path-row' }, command, pickBtn));
  const argsLabel = el('label', {}, 'Argumentos ({path} vira a pasta do repositório)', args);
  const exeBtn = el('button', { type: 'button', class: 'on', text: 'Programa (.exe)' });
  const termBtn = el('button', { type: 'button', text: 'Comando no terminal' });
  const setKind = (k) => {
    kind = k;
    exeBtn.classList.toggle('on', k === 'exe');
    termBtn.classList.toggle('on', k === 'terminal');
    pickBtn.hidden = k !== 'exe';
    argsLabel.hidden = k !== 'exe';
    commandLabel.firstChild.textContent = k === 'exe' ? 'Programa' : 'Comando';
    command.placeholder = k === 'exe' ? 'C:\\caminho\\para\\programa.exe' : 'Ex.: claude, codex, aider, npm run dev';
  };
  exeBtn.addEventListener('click', () => setKind('exe'));
  termBtn.addEventListener('click', () => setKind('terminal'));

  openModal('Adicionar app ao "Abrir em"',
    [
      el('div', { class: 'seg' }, exeBtn, termBtn),
      el('label', {}, 'Nome', name),
      commandLabel,
      argsLabel,
      el('p', { class: 'hint', text: 'Comandos de terminal abrem no Windows Terminal, já dentro da pasta do repositório.' }),
    ],
    'Adicionar',
    async () => {
      if (!name.value.trim() || !command.value.trim()) throw new Error('Preencha o nome e o programa ou comando.');
      const item = await call('apps:addCustom', {
        name: name.value.trim(), kind, command: command.value.trim(), args: kind === 'exe' ? args.value.trim() : undefined,
      });
      await loadApps();
      await openIn(item.id);
    });
  name.focus();
}

// ---------- updates ----------
function updateLine() {
  const u = S.update;
  if (!u) return 'GitSwitch';
  const v = `GitSwitch ${u.version}`;
  if (u.state === 'dev') return `${v} (desenvolvimento)`;
  if (u.state === 'checking') return `${v} · procurando atualização…`;
  if (u.state === 'downloading') return `${v} · baixando ${u.next} (${u.percent || 0}%)`;
  if (u.state === 'ready') return `${v} · ${u.next} pronta para instalar`;
  if (u.state === 'latest') return `${v} · versão mais nova`;
  return v;
}

function onUpdate(u) {
  S.update = u;
  if (S.manualCheck && ['latest', 'error', 'downloading'].includes(u.state)) {
    S.manualCheck = false;
    if (u.state === 'latest') toast('Você já está na versão mais nova.');
    else if (u.state === 'error') toast(`Não consegui procurar atualização: ${u.message}`, true);
    else toast(`Baixando a versão ${u.next}…`);
  }
  const bar = $('updateHint');
  bar.hidden = u.state !== 'ready' && u.state !== 'available';
  if (u.state === 'available') {
    bar.replaceChildren(
      el('span', { class: 'grow', text: `A versão ${u.next} do GitSwitch está disponível.` }),
      el('button', { class: 'primary', text: 'Baixar', onclick: () => call('update:download') }),
      el('button', { class: 'ghost', text: 'Depois', onclick: () => { bar.hidden = true; } }),
    );
    return;
  }
  if (u.state !== 'ready') return;
  bar.replaceChildren(
    el('span', { class: 'grow', text: `A versão ${u.next} do GitSwitch está pronta. Ela também é instalada quando você fechar o app.` }),
    el('button', { class: 'primary', text: 'Reiniciar e atualizar', onclick: () => call('update:install') }),
    el('button', { class: 'ghost', text: 'Depois', onclick: () => { bar.hidden = true; } }),
  );
}

async function checkForUpdate() {
  closePopovers();
  S.manualCheck = true;
  try {
    onUpdate(await call('update:check'));
  } catch (err) {
    S.manualCheck = false;
    toast(`Não consegui procurar atualização: ${err.message}`, true);
  }
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
  menu.hidden = false;
  // Keep menus opened from the right side of the toolbar inside the window.
  const left = Math.min(anchor.getBoundingClientRect().left, window.innerWidth - menu.offsetWidth - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  anchor.classList.add('open');
}

function openModal(title, body, okLabel, onOk, { cancel = true, wide = false } = {}) {
  $('modalBody').classList.toggle('wide', wide);
  const err = el('p', { class: 'error-text' });
  err.hidden = true;
  const ok = el('button', { type: 'submit', class: 'primary', text: okLabel });
  const form = el('form', {},
    el('h2', { text: title }),
    el('div', { class: 'modal-body' }, body, err),
    el('div', { class: 'modal-foot' },
      cancel ? el('button', { type: 'button', text: 'Cancelar', onclick: closeModal }) : null,
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
  const pending = S.onModalClose;
  S.onModalClose = null;
  pending?.();
  $('modal').hidden = true;
  $('modalBody').replaceChildren();
}

// ---------- wiring ----------
function wire() {
  $('accountBtn').addEventListener('click', (e) => { e.stopPropagation(); openAccountMenu(); });
  $('repoBtn').addEventListener('click', (e) => { e.stopPropagation(); openRepoMenu(); });
  $('branchBtn').addEventListener('click', (e) => { e.stopPropagation(); if ($('branchMenu').hidden) openBranchMenu(); else closePopovers(); });
  $('syncBtn').addEventListener('click', sync);
  $('folderBtn').addEventListener('click', (e) => { e.stopPropagation(); openFolderMenu(); });
  $('openBtn').addEventListener('click', (e) => { e.stopPropagation(); openIn($('openBtn').dataset.app); });
  $('openMenuBtn').addEventListener('click', (e) => { e.stopPropagation(); if (S.apps) openOpenMenu(); });
  $('openGithub').addEventListener('click', () => {
    const m = S.info?.remoteUrl?.match(/github\.com[:/](.+?)(\.git)?$/);
    if (m) call('shell:url', `https://github.com/${m[1]}`);
    else toast('Esse repositório não tem um remote no GitHub.', true);
  });

  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => setTab(t.dataset.tab));
  $('selectAll').addEventListener('change', (e) => {
    S.unchecked.clear();
    S.sel.clear();
    if (!e.target.checked) for (const f of S.info.files) S.unchecked.add(f.path);
    renderFiles();
  });
  $('summary').addEventListener('input', updateCommitButton);
  $('stashBtn').addEventListener('click', stashChanges);
  $('amend').addEventListener('change', () => {
    if ($('amend').checked) startAmend();
    else { $('amendHint').hidden = true; updateCommitButton(); }
  });
  $('settingsBtn').addEventListener('click', (e) => { e.stopPropagation(); openSettings(); });
  window.api.onProgress((p) => { if (!$('busy').hidden) $('busyText').textContent = p.text; });
  $('commitForm').addEventListener('submit', commit);

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.popover')) closePopovers();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closePopovers(); closeModal(); return; }
    handleShortcut(e);
  });
  $('prBtn').addEventListener('click', (e) => { e.stopPropagation(); openPrMenu(); });
  $('aiBtn').addEventListener('click', generateMessage);
  $('coauthorToggle').addEventListener('click', () => {
    $('coauthorRow').hidden = !$('coauthorRow').hidden;
    if (!$('coauthorRow').hidden) $('coauthors').focus();
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
    // After "Adicionar conta", reload until the new login shows up, then
    // look for that account's folder and repos.
    if (S.awaitingLogin) {
      await call('accounts:reload');
      await loadAccounts().catch(() => {});
      const fresh = S.accounts.find((a) => !S.knownLogins.includes(a.login));
      if (fresh) {
        S.awaitingLogin = false;
        S.knownLogins = S.accounts.map((a) => a.login);
        toast(`Conta @${fresh.login} adicionada. Procurando os repositórios dela…`);
        runDetect({ openFor: fresh.login });
      }
    }
    await loadAccounts().catch(() => {});
    await loadRepos().catch(() => {});
    if ($('modal').hidden) refresh({ quiet: true });
  });
}

// ---------- tags, cherry-pick, squash ----------
function tagsOf(c) {
  return (c.refs || '').split(', ').filter((r) => r.startsWith('tag: ')).map((r) => r.slice(5));
}

// True when every commit from the newest down to idx is still only local.
function unpushedRange(idx) {
  const i = S.info;
  if (!i?.remoteUrl || !i.upstream) return true;
  return idx < i.ahead;
}

function openTagModal(c) {
  const name = el('input', { placeholder: 'v1.0.0', autocomplete: 'off' });
  const message = el('input', { placeholder: 'Opcional' });
  openModal(`Criar tag em ${c.short}`, [
    el('label', {}, 'Nome', name),
    el('label', {}, 'Mensagem', message),
    el('p', { class: 'hint', text: 'A tag vai para o GitHub no próximo push.' }),
  ], 'Criar tag', async () => {
    const n = name.value.trim().replace(/\s+/g, '-');
    if (!n) throw new Error('Dê um nome para a tag.');
    await call('repo:createTag', S.repo, n, c.sha, message.value.trim());
    toast(`Tag ${n} criada.`);
    await refresh();
  });
  name.focus();
}

async function openCherryPickModal(c) {
  const data = await call('repo:branches', S.repo);
  const options = data.local.filter((b) => b !== S.info.branch);
  if (!options.length) { toast('Não há outra branch local para receber o commit.', true); return; }
  let picked = null;
  const list = el('div', { class: 'repo-pick' });
  const draw = () => list.replaceChildren(...options.map((b) => el('button', {
    type: 'button', class: `item${picked === b ? ' selected' : ''}`, onclick: () => { picked = b; draw(); },
  }, el('span', { class: 'grow', text: b }))));
  draw();
  openModal(`Aplicar "${c.subject}" em…`, [
    el('p', { class: 'hint', text: 'O GitSwitch troca para a branch escolhida e cria nela uma cópia deste commit.' }),
    list,
  ], 'Aplicar', async () => {
    if (!picked) throw new Error('Escolha uma branch.');
    closeModal();
    const result = await busy(`Aplicando em ${picked}…`, () => call('repo:cherryPick', S.repo, c.sha, picked, c.parents.length));
    if (result === 'applied') toast(`Commit aplicado em ${picked}.`);
    if (result === 'conflicts') toast('Há conflitos. Resolva os arquivos marcados com ! e faça commit.', true);
    S.sel.clear();
    S.unchecked.clear();
    await refresh();
  });
}

async function openSquashModal(c, idx) {
  const messages = await call('repo:messagesSince', S.repo, c.sha);
  const summary = el('input', { value: messages[0]?.split('\n')[0] || '' });
  const description = el('textarea', { rows: 6 });
  description.value = messages.join('\n\n');
  openModal(`Juntar ${idx + 1} commits em um só`, [
    el('p', { class: 'hint', text: 'Os commits continuam só neste computador; nenhum arquivo muda. Ajuste a mensagem do commit único.' }),
    el('label', {}, 'Resumo', summary),
    el('label', {}, 'Descrição', description),
  ], 'Juntar commits', async () => {
    if (!summary.value.trim()) throw new Error('Escreva um resumo.');
    const message = [summary.value.trim(), description.value.trim()].filter(Boolean).join('\n\n');
    await call('repo:squash', S.repo, c.sha, message);
    toast(`${idx + 1} commits viraram um.`);
    await refresh();
  });
}

// ---------- co-authors ----------
function coauthorTrailers() {
  const raw = $('coauthors').value.trim();
  if (!raw) return '';
  return raw.split(',').map((s) => s.trim()).filter((s) => /<[^>]+@[^>]+>/.test(s))
    .map((s) => `Co-authored-by: ${s}`).join('\n');
}

function fillCoauthorSuggestions() {
  $('coauthorList').replaceChildren(...S.accounts.filter((a) => a.login !== S.active)
    .map((a) => el('option', { value: `${a.identity.name} <${a.identity.email}>` })));
}

// ---------- AI commit message ----------
async function generateMessage() {
  if (!S.info) return;
  const files = commitFiles();
  if (!files.length) { toast('Selecione alterações para a IA descrever.', true); return; }
  if ($('summary').value.trim() || $('description').value.trim()) {
    const pick = await choose('Substituir a mensagem?', 'A IA vai escrever por cima do que você já digitou.', [['go', 'Substituir', true], ['cancel', 'Cancelar']]);
    if (pick !== 'go') return;
  }
  const btn = $('aiBtn');
  btn.classList.add('working');
  btn.disabled = true;
  try {
    const r = await call('ai:commitMessage', S.repo, files, S.info.initial);
    $('summary').value = r.summary;
    $('description').value = r.description;
    updateCommitButton();
    toast(`Mensagem escrita por ${r.provider === 'claude' ? 'Claude Code' : `Ollama (${r.model})`}. Revise antes do commit.`);
  } catch (err) {
    toast(err.message, true, err.detail);
  } finally {
    btn.classList.remove('working');
    btn.disabled = false;
  }
}

function aiProviderRow() {
  const sel = el('select', {},
    el('option', { value: 'claude', text: 'Claude Code (comando claude)' }),
    el('option', { value: 'ollama', text: 'Ollama (modelo local)' }),
    el('option', { value: 'off', text: 'Desligado' }));
  sel.value = S.settings.ai?.provider || 'claude';
  const state = el('small', { text: 'verificando…' });
  call('ai:providers').then((p) => {
    const bits = [
      `Claude Code: ${p.claude.available ? 'encontrado' : 'não encontrado'}`,
      `Ollama: ${p.ollama.available ? `${p.ollama.models.length} modelo(s)` : 'não está rodando'}`,
    ];
    state.textContent = bits.join(' · ');
  }).catch(() => { state.textContent = ''; });
  sel.addEventListener('change', () => saveSetting({ ai: { ...S.settings.ai, provider: sel.value } }));
  return el('label', { class: 'set-row select' }, el('span', { class: 'grow' }, el('span', { text: 'Provedor' }), state), sel);
}

function aiModelInput() {
  const input = el('input', { value: S.settings.ai?.model || '', placeholder: 'ex.: haiku, sonnet, llama3.2' });
  input.addEventListener('change', () => saveSetting({ ai: { ...S.settings.ai, model: input.value.trim() } }));
  return input;
}

function selectAiLanguage() {
  const sel = el('select', {}, el('option', { value: 'en', text: 'Inglês' }), el('option', { value: 'pt', text: 'Português' }));
  sel.value = S.settings.ai?.language || 'en';
  sel.addEventListener('change', () => saveSetting({ ai: { ...S.settings.ai, language: sel.value } }));
  return el('label', { class: 'set-row select' }, el('span', { class: 'grow', text: 'Idioma das mensagens' }), sel);
}

function toolRow(name, label) {
  const info = S.settings.toolInfo?.[name];
  const sel = el('select', {},
    el('option', { value: 'bundled', text: 'Embutido no GitSwitch', disabled: !info?.bundled }),
    el('option', { value: 'system', text: 'Do sistema (PATH)' }));
  sel.value = S.settings.tools?.[name] || 'bundled';
  sel.addEventListener('change', async () => {
    await saveSetting({ tools: { ...S.settings.tools, [name]: sel.value } });
    toast(`${label}: agora usando a versão ${sel.value === 'bundled' ? 'embutida' : 'do sistema'}.`);
  });
  return el('label', { class: 'set-row select' },
    el('span', { class: 'grow' }, el('span', { text: label }), el('small', { text: S.settings.toolInfo?.versions?.[name] || '' })), sel);
}

// ---------- pull requests ----------
const CHECK_TEXT = { success: 'checks ok', failure: 'checks falharam', pending: 'checks rodando', none: 'sem checks' };

async function loadPr({ force = false } = {}) {
  const gh = githubWebUrl();
  $('prBtn').hidden = !gh || !S.info?.branch;
  if (!gh || !S.info?.branch) { S.pr = null; return; }
  if (!force && S.pr?.repo === S.repo && S.pr.branch === S.info.branch && Date.now() - S.prAt < 60 * 1000) {
    renderPrButton();
    return;
  }
  const data = await call('pr:current', S.repo);
  S.pr = data ? { ...data, repo: S.repo } : null;
  S.prAt = Date.now();
  renderPrButton();
  notifyChecks();
}

function renderPrButton() {
  const d = S.pr;
  if (!d) return;
  const state = d.checks?.state || 'none';
  if (d.pr) {
    $('prLabel').textContent = `#${d.pr.number} ${d.pr.draft ? '(rascunho)' : ''}`.trim();
    $('prHint').replaceChildren(el('span', { class: `check-dot ${state}` }), CHECK_TEXT[state]);
  } else {
    $('prLabel').textContent = d.branch === d.defaultBranch ? 'Ver PRs' : 'Criar PR';
    $('prHint').replaceChildren(d.checks && d.checks.state !== 'none' ? el('span', { class: `check-dot ${state}` }) : '', d.checks && d.checks.state !== 'none' ? CHECK_TEXT[state] : 'Pull request');
  }
}

// Notifies once per state change of the current branch's checks.
function notifyChecks() {
  const d = S.pr;
  if (!d?.checks || d.checks.state === 'none') return;
  const key = `${d.repo}|${d.branch}|${d.pr?.headSha || ''}`;
  const before = S.lastChecks.get(key);
  S.lastChecks.set(key, d.checks.state);
  if (!before || before === d.checks.state || before !== 'pending') return;
  const where = d.pr ? `PR #${d.pr.number}` : d.branch;
  if (d.checks.state === 'failure') {
    const failed = d.checks.items.filter((i) => i.state === 'failure').map((i) => i.name).slice(0, 3).join(', ');
    call('notify', `Checks falharam em ${where}`, failed || 'Abra o GitSwitch para ver.');
  } else if (d.checks.state === 'success') {
    call('notify', `Checks passaram em ${where}`, 'Tudo verde.');
  }
}

async function openPrMenu() {
  const menu = $('prMenu');
  if (!menu.hidden) { closePopovers(); return; }
  await busy('Consultando o GitHub…', () => loadPr({ force: true }));
  const d = S.pr;
  if (!d) return;
  const web = githubWebUrl();
  const parts = [];
  if (d.pr) {
    parts.push(el('div', { class: 'pr-head' },
      el('strong', { text: `#${d.pr.number} ${d.pr.title}` }),
      el('span', { class: 'muted', text: `${d.pr.head} → ${d.pr.base} · por ${d.pr.author}${d.pr.draft ? ' · rascunho' : ''}` })));
  } else {
    parts.push(el('div', { class: 'pr-head' },
      el('strong', { text: d.branch === d.defaultBranch ? `${d.branch} é a branch principal` : `Nenhum PR aberto para ${d.branch}` }),
      el('span', { class: 'muted', text: d.branch === d.defaultBranch ? 'Crie uma branch para abrir um pull request.' : `Abra um PR para juntar em ${d.defaultBranch}.` })));
  }
  if (d.checks?.items.length) {
    parts.push(el('div', { class: 'pop-title', text: `Checks: ${CHECK_TEXT[d.checks.state]}` }));
    parts.push(el('div', { class: 'pop-list' }, d.checks.items.map((c) => el('div', { class: 'check-item' },
      el('span', { class: `check-dot ${c.state}` }),
      c.url ? el('a', { href: '#', text: c.name, onclick: (e) => { e.preventDefault(); call('shell:url', c.url); } }) : el('span', { class: 'grow', text: c.name })))));
  }
  const open = await call('pr:list', S.repo).catch(() => []);
  const others = open.filter((p) => p.number !== d.pr?.number);
  if (others.length) {
    parts.push(el('div', { class: 'pop-title', text: 'Outros PRs abertos (clique para fazer checkout)' }));
    parts.push(el('div', { class: 'pop-list' }, others.slice(0, 20).map((p) => el('button', {
      class: 'item', onclick: () => checkoutPr(p),
    }, el('span', { class: 'grow' }, el('span', { text: `#${p.number} ${p.title}` }), el('span', { class: 'muted', text: `${p.head} · ${p.author}${p.draft ? ' · rascunho' : ''}` }))))));
  }
  parts.push(el('div', { class: 'pop-foot' },
    d.pr
      ? el('button', { class: 'primary', text: 'Abrir no GitHub', onclick: () => { closePopovers(); call('shell:url', d.pr.url); } })
      : el('button', { class: 'primary', text: 'Criar pull request…', disabled: d.branch === d.defaultBranch, onclick: openCreatePrModal }),
    el('button', { text: 'Ver todos no GitHub', onclick: () => { closePopovers(); call('shell:url', `${web}/pulls`); } })));
  menu.replaceChildren(...parts);
  openPopover(menu, $('prBtn'));
}

async function checkoutPr(p) {
  closePopovers();
  const ok = await busy(`Baixando o PR #${p.number}…`, async () => { await call('pr:checkout', S.repo, p); return true; });
  if (ok) toast(`Você está no PR #${p.number} (${p.head}).`);
  S.sel.clear();
  S.unchecked.clear();
  await refresh();
}

async function openCreatePrModal() {
  closePopovers();
  const d = S.pr;
  const last = await call('repo:lastMessage', S.repo).catch(() => '');
  const [first, ...rest] = last.split('\n');
  const title = el('input', { value: first || d.branch });
  const body = el('textarea', { rows: 6 });
  body.value = rest.join('\n').trim();
  const base = el('input', { value: d.defaultBranch });
  const draft = el('input', { type: 'checkbox' });
  openModal(`Pull request de ${d.branch}`, [
    el('label', {}, 'Título', title),
    el('label', {}, 'Descrição', body),
    el('label', {}, 'Juntar em (base)', base),
    el('label', { class: 'inline-check' }, draft, 'Abrir como rascunho'),
    el('p', { class: 'hint', text: `Criado como @${S.active}. Se a branch ainda não está no GitHub, ela é enviada antes.` }),
  ], 'Criar pull request', async () => {
    if (!title.value.trim()) throw new Error('Dê um título ao pull request.');
    const pr = await busy('Criando o pull request…', () => call('pr:create', S.repo, {
      title: title.value.trim(), body: body.value.trim(), base: base.value.trim() || d.defaultBranch, draft: draft.checked,
    }), { rethrow: true });
    toast(`PR #${pr.number} criado.`);
    call('shell:url', pr.url);
    await refresh();
    await loadPr({ force: true });
  });
  title.focus();
}

// ---------- keyboard shortcuts ----------
const SHORTCUTS = [
  ['Ctrl+Enter', 'Fazer commit (com o cursor na mensagem)'],
  ['Ctrl+Shift+P', 'Push, pull ou publicar (o botão de sincronizar)'],
  ['Ctrl+Shift+F', 'Fetch'],
  ['Ctrl+1 / Ctrl+2', 'Alterações / Histórico'],
  ['Ctrl+T', 'Trocar de repositório'],
  ['Ctrl+B', 'Trocar de branch'],
  ['Ctrl+Shift+N', 'Nova branch'],
  ['Ctrl+Shift+A', 'Abrir no app padrão'],
  ['Ctrl+Shift+G', 'Abrir no GitHub'],
  ['Ctrl+Shift+R', 'Pull request da branch'],
  ['Ctrl+Shift+S', 'Guardar alterações (stash)'],
  ['Ctrl+,', 'Configurações'],
  ['Ctrl+= / Ctrl+- / Ctrl+0', 'Aumentar, diminuir e voltar o zoom'],
];

function handleShortcut(e) {
  if (!e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  const target = e.target instanceof Element ? e.target : document.body;
  const inText = target.closest('input, textarea, select');
  const run = (fn) => { e.preventDefault(); fn(); };
  if (k === 'enter' && (target.id === 'summary' || target.id === 'description')) return run(() => $('commitForm').requestSubmit());
  if (k === '=' || k === '+') return run(() => call('window:zoom', 1));
  if (k === '-') return run(() => call('window:zoom', -1));
  if (k === '0') return run(() => call('window:zoom', 0));
  if (k === ',') return run(openSettings);
  if (!$('modal').hidden || (inText && !e.shiftKey)) return;
  if (!e.shiftKey) {
    if (k === '1') return run(() => setTab('changes'));
    if (k === '2') return run(() => setTab('history'));
    if (k === 't') return run(() => { closePopovers(); openRepoMenu(); });
    if (k === 'b' && S.repo) return run(() => { closePopovers(); openBranchMenu(); });
    return;
  }
  if (!S.repo) return;
  if (k === 'p') return run(sync);
  if (k === 'f' && S.info?.remoteUrl) return run(() => busy('Fetch…', () => call('repo:fetch', S.repo)).then(() => refresh()));
  if (k === 'n') return run(() => openNewBranchModal());
  if (k === 'a') return run(() => openIn($('openBtn').dataset.app));
  if (k === 'g') return run(() => $('openGithub').click());
  if (k === 'r' && !$('prBtn').hidden) return run(openPrMenu);
  if (k === 's' && S.info?.files.length) return run(stashChanges);
}

// ---------- settings ----------
function applyAppearance() {
  const { theme, tabSize } = S.settings;
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  document.documentElement.style.setProperty('--tab-size', String(tabSize || 4));
}

async function saveSetting(patch) {
  S.settings = { ...S.settings, ...(await call('settings:set', patch)) };
  applyAppearance();
}

function section(title, ...rows) {
  return el('section', { class: 'settings-section' }, el('h3', { text: title }), ...rows);
}

function checkRow(label, key, hint) {
  const box = el('input', { type: 'checkbox' });
  box.checked = Boolean(S.settings[key]);
  box.addEventListener('change', () => saveSetting({ [key]: box.checked }));
  return el('label', { class: 'set-row' }, box, el('span', { class: 'grow' }, el('span', { text: label }), hint ? el('small', { text: hint }) : null));
}

function selectRow(label, key, options, toValue = (v) => v) {
  const sel = el('select', {}, options.map(([v, t]) => el('option', { value: String(v), text: t })));
  sel.value = String(S.settings[key]);
  sel.addEventListener('change', () => saveSetting({ [key]: toValue(sel.value) }));
  return el('label', { class: 'set-row select' }, el('span', { class: 'grow', text: label }), sel);
}

async function renderCliState() {
  const s = await call('cli:status').catch(() => null);
  const node = $('cliState');
  if (!s || !node) return;
  const skills = s.skill.filter((x) => x.installed).length;
  node.textContent = `Comando: ${s.cli.installed ? 'instalado' : 'não instalado'} · Skill: ${skills ? 'instalada' : 'não instalada'}`;
}

async function openSettings() {
  closePopovers();
  S.settings = await call('settings:get');
  if (!S.apps) await loadApps().catch(() => {});
  const gName = el('input', { value: S.settings.globalIdentity.name || '' });
  const gEmail = el('input', { value: S.settings.globalIdentity.email || '' });
  const appSel = el('select', {}, allApps().map((a) => el('option', { value: a.id, text: a.name })));
  appSel.value = S.apps?.openWith || '';
  appSel.addEventListener('change', async () => {
    S.apps.openWith = appSel.value;
    renderOpenButton();
    await call('apps:setDefault', appSel.value);
  });
  const sync = el('input', { type: 'checkbox' });
  sync.checked = S.syncGlobal;
  sync.addEventListener('change', async () => {
    await busy('Salvando…', () => call('accounts:setSyncGlobal', sync.checked));
    S.syncGlobal = sync.checked;
  });

  openModal('Configurações', [
    section('Contas',
      el('div', { class: 'set-buttons' },
        el('button', { type: 'button', text: 'Pastas das contas…', onclick: () => openFoldersModal() }),
        el('button', { type: 'button', text: 'Nome/e-mail dos commits…', disabled: !S.active, onclick: openIdentityModal }),
        el('button', { type: 'button', text: 'Adicionar conta', onclick: addAccount })),
      el('label', { class: 'set-row' }, sync, el('span', { class: 'grow' },
        el('span', { text: 'Trocar também no terminal' }),
        el('small', { text: 'Ao trocar de conta, roda gh auth switch e muda o nome/e-mail do Git global.' })))),
    section('Git global',
      el('p', { class: 'hint', text: 'Usado por outros programas e pelo terminal. Os commits feitos no GitSwitch usam o nome e o e-mail da conta escolhida.' }),
      el('div', { class: 'set-grid' }, el('label', {}, 'Nome', gName), el('label', {}, 'E-mail', gEmail)),
      el('div', { class: 'set-buttons' }, el('button', {
        type: 'button', text: 'Salvar no Git global',
        onclick: async () => {
          const ok = await busy('Salvando…', async () => { await call('settings:setGlobalIdentity', { name: gName.value.trim(), email: gEmail.value.trim() }); return true; });
          if (ok) toast('Git global atualizado.');
        },
      }))),
    section('Abrir em',
      el('label', { class: 'set-row select' }, el('span', { class: 'grow', text: 'App padrão do botão Abrir' }), appSel),
      el('div', { class: 'set-buttons' }, el('button', { type: 'button', text: 'Adicionar app…', onclick: openAddAppModal }))),
    section('Aparência',
      selectRow('Tema', 'theme', [['system', 'Igual ao Windows'], ['light', 'Claro'], ['dark', 'Escuro']]),
      selectRow('Largura do Tab no diff', 'tabSize', [[2, '2 espaços'], [4, '4 espaços'], [8, '8 espaços']], Number)),
    section('Diff',
      checkRow('Ocultar mudanças só de espaço em branco', 'hideWhitespace', 'Com isso ligado não dá para escolher linhas para o commit.')),
    section('Sincronização',
      selectRow('Buscar alterações do GitHub (fetch) automaticamente', 'autoFetchMinutes',
        [[0, 'Nunca'], [1, 'A cada minuto'], [5, 'A cada 5 minutos'], [15, 'A cada 15 minutos'], [30, 'A cada 30 minutos']], Number)),
    section('Avisos',
      checkRow('Confirmar antes de descartar alterações', 'confirmDiscard'),
      checkRow('Confirmar antes de forçar push', 'confirmForcePush'),
      checkRow('Confirmar antes de tirar um repositório da lista', 'confirmRemoveRepo')),
    section('Atualizações',
      checkRow('Baixar atualizações automaticamente', 'autoUpdate', 'Desligado, o GitSwitch só avisa que existe uma versão nova.'),
      el('div', { class: 'set-buttons' },
        el('span', { class: 'grow muted', text: updateLine() }),
        el('button', { type: 'button', text: 'Procurar atualização', disabled: S.update?.state === 'dev', onclick: checkForUpdate }))),
    section('Terminal e IA',
      el('p', { class: 'hint', text: 'O comando gitswitch faz o Git e o GitHub CLI usarem a conta certa no terminal. A skill ensina agentes de IA (Claude Code e outros) a usá-lo em vez de git e gh direto.' }),
      el('div', { class: 'set-buttons' },
        el('span', { class: 'grow muted', id: 'cliState', text: '…' }),
        el('button', { type: 'button', text: 'Instalar comando', onclick: async () => {
          const r = await busy('Instalando…', () => call('cli:install'));
          if (r) { toast(r.path === 'added' ? 'Comando instalado. Abra um terminal novo e rode: gitswitch help' : 'Comando atualizado.'); renderCliState(); }
        } }),
        el('button', { type: 'button', text: 'Instalar skill para IA', onclick: async () => {
          const r = await busy('Instalando…', () => call('cli:installSkill'));
          if (r) { toast(`Skill instalada em ${r.installed.join(', ')}`); renderCliState(); }
        } }))),
    section('IA',
      el('p', { class: 'hint', text: 'O botão ✨ ao lado do resumo escreve a mensagem do commit a partir das alterações selecionadas, usando uma IA que já está no seu computador.' }),
      aiProviderRow(),
      el('label', { class: 'set-row select' }, el('span', { class: 'grow', text: 'Modelo (opcional)' }), aiModelInput()),
      selectAiLanguage()),
    section('Git e GitHub CLI',
      el('p', { class: 'hint', text: 'O GitSwitch traz o próprio Git e o próprio GitHub CLI, como o GitHub Desktop. Escolha "do sistema" para usar os que estão instalados no Windows.' }),
      toolRow('git', 'Git'),
      toolRow('gh', 'GitHub CLI (gh)')),
    section('Notificações',
      checkRow('Avisar quando os checks do pull request da branch atual falharem ou passarem', 'notifyChecks')),
    section('Atalhos de teclado',
      el('dl', { class: 'shortcut-list' }, SHORTCUTS.flatMap(([keys, what]) => [el('dt', {}, el('kbd', { text: keys })), el('dd', { text: what, style: null })]))),
    section('Avançado',
      el('div', { class: 'set-buttons' },
        el('span', { class: 'grow muted', text: S.settings.dataDir }),
        el('button', { type: 'button', text: 'Abrir pasta de dados', onclick: () => call('shell:folder', S.settings.dataDir) }))),
  ], 'Fechar', async () => {}, { cancel: false, wide: true });
  renderCliState();
}

// Background fetch, like GitHub Desktop, so ahead/behind stays current.
function startAutoFetch() {
  setInterval(async () => {
    const minutes = S.settings.autoFetchMinutes;
    if (!minutes || !S.repo || !S.info?.remoteUrl || !$('busy').hidden) return;
    if (Date.now() - S.lastFetch < minutes * 60 * 1000) return;
    S.lastFetch = Date.now();
    try {
      await call('repo:fetch', S.repo, true);
      if ($('modal').hidden) refresh({ quiet: true });
    } catch { /* offline or no access: try again next round */ }
  }, 30 * 1000);
}

async function start() {
  wire();
  S.settings = await call('settings:get').catch(() => ({}));
  applyAppearance();
  startAutoFetch();
  window.api.onStoreError((message) => toast(message, true));
  window.api.onUpdate(onUpdate);
  call('update:status').then(onUpdate).catch(() => {});
  await busy('Carregando contas…', loadAccounts);
  await loadRepos();
  await refresh();
  loadApps().catch(() => {});
  if (S.accounts.length) runDetect({ quiet: true });
}

start();
