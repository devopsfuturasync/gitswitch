const API = 'https://api.github.com';

async function api(token, path) {
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'GitSwitch',
    },
  });
  if (!res.ok) throw new Error(`GitHub respondeu ${res.status} em ${path}`);
  return res.json();
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

module.exports = { api, repos };
