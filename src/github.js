const { t: _t } = require('./i18n');
const API = 'https://api.github.com';

async function api(token, path, { method = 'GET', body } = {}) {
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'GitSwitch',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = [j.message, ...(j.errors || []).map((e) => e.message || e.code)].filter(Boolean).join(': ');
    } catch { /* no JSON body */ }
    const err = new Error(detail ? `GitHub: ${detail}` : _t('GitHub respondeu {0} em {1}', res.status, path));
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

// Repos the account can see, most recently pushed first.
async function repos(token) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api(token, `/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out.map((r) => ({
    fullName: r.full_name,
    name: r.name,
    owner: r.owner.login,
    private: r.private,
    description: r.description,
    cloneUrl: r.clone_url,
    pushedAt: r.pushed_at,
  }));
}

// --- pull requests
const pr = (p) => ({
  number: p.number,
  title: p.title,
  state: p.state,
  draft: p.draft,
  author: p.user?.login,
  url: p.html_url,
  head: p.head?.ref,
  headRepo: p.head?.repo?.full_name || null,
  headSha: p.head?.sha,
  base: p.base?.ref,
  updatedAt: p.updated_at,
});

async function repoInfo(token, owner, repo) {
  const r = await api(token, `/repos/${owner}/${repo}`);
  return { defaultBranch: r.default_branch, fullName: r.full_name, canPush: Boolean(r.permissions?.push) };
}

async function openPulls(token, owner, repo) {
  return (await api(token, `/repos/${owner}/${repo}/pulls?state=open&per_page=50&sort=updated&direction=desc`)).map(pr);
}

async function pullForBranch(token, owner, repo, branch) {
  const list = await api(token, `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
  return list[0] ? pr(list[0]) : null;
}

async function createPull(token, owner, repo, { title, body, head, base, draft }) {
  return pr(await api(token, `/repos/${owner}/${repo}/pulls`, { method: 'POST', body: { title, body, head, base, draft } }));
}

// Check runs plus legacy commit statuses, folded into one verdict.
async function checks(token, owner, repo, sha) {
  const [runs, combined] = await Promise.all([
    api(token, `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`).catch(() => ({ check_runs: [] })),
    api(token, `/repos/${owner}/${repo}/commits/${sha}/status`).catch(() => ({ statuses: [] })),
  ]);
  // Re-runs leave older runs with the same name; keep the newest of each.
  const latest = new Map();
  for (const c of runs.check_runs) {
    const prev = latest.get(c.name);
    if (!prev || (c.started_at || '') > (prev.started_at || '')) latest.set(c.name, c);
  }
  const items = [
    ...[...latest.values()].map((c) => ({
      name: c.name,
      state: c.status !== 'completed' ? 'pending'
        : ['success', 'neutral', 'skipped'].includes(c.conclusion) ? 'success' : 'failure',
      url: c.html_url,
    })),
    ...combined.statuses.map((s) => ({
      name: s.context,
      state: s.state === 'success' ? 'success' : s.state === 'pending' ? 'pending' : 'failure',
      url: s.target_url,
    })),
  ];
  const state = !items.length ? 'none'
    : items.some((i) => i.state === 'failure') ? 'failure'
      : items.some((i) => i.state === 'pending') ? 'pending' : 'success';
  return { state, items };
}

module.exports = { api, repos, repoInfo, openPulls, pullForBranch, createPull, checks };
