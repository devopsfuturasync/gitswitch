// Finds git repositories on disk and works out which account owns them.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const SKIP = new Set([
  'windows', 'program files', 'program files (x86)', 'programdata', '$recycle.bin',
  'system volume information', 'appdata', 'node_modules', 'recovery', 'perflogs',
  'msocache', 'intel', 'amd', 'nvidia', 'onedrivetemp', '$windows.~ws', '$winreagent',
  'windows.old', 'xboxgames', 'steamlibrary',
]);

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function childDirs(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP.has(d.name.toLowerCase()))
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

async function roots() {
  const home = os.homedir();
  const out = [];
  for (const letter of 'CDEFGH') {
    if (await exists(`${letter}:\\`)) out.push(`${letter}:\\`);
  }
  out.push(home);
  for (const sub of ['Documents', 'Desktop', 'source', path.join('source', 'repos'), 'GitHub',
    path.join('Documents', 'GitHub'), 'Projects', 'dev', 'code', 'repos']) {
    out.push(path.join(home, sub));
  }
  return out;
}

// Reads origin straight from .git/config: much faster than running git per repo.
async function originUrl(dir) {
  let gitDir = path.join(dir, '.git');
  try {
    const st = await fs.stat(gitDir);
    if (st.isFile()) {
      const m = (await fs.readFile(gitDir, 'utf8')).match(/gitdir:\s*(.+)/);
      if (!m) return null;
      gitDir = path.resolve(dir, m[1].trim());
    }
    const cfg = await fs.readFile(path.join(gitDir, 'config'), 'utf8');
    const m = cfg.match(/\[remote "origin"\][^[]*?url\s*=\s*(.+)/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function parseGithub(url) {
  const m = url?.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// Every repo up to two folders below each root.
async function findRepos() {
  const found = new Map();
  const visit = async (dir, depth) => {
    const kids = await childDirs(dir);
    await Promise.all(kids.map(async (k) => {
      if (await exists(path.join(k, '.git'))) {
        found.set(path.normalize(k).toLowerCase(), path.normalize(k));
      } else if (depth > 1) {
        await visit(k, depth - 1);
      }
    }));
  };
  for (const r of await roots()) await visit(r, 2);

  return Promise.all([...found.values()].map(async (p) => {
    const url = await originUrl(p);
    return { path: p, name: path.basename(p), url, ...parseGithub(url) };
  }));
}

// accounts: [{ login, orgs: [] }]. Returns login -> { folder, repos }.
async function detect(accounts) {
  const repos = await findRepos();
  const result = {};
  for (const a of accounts) {
    const owners = new Set([a.login, ...(a.orgs || [])].map((o) => o.toLowerCase()));
    const mine = repos.filter((r) => r.owner && owners.has(r.owner.toLowerCase()));
    // The folder holding most of the account's repos; repos the account owns
    // directly weigh more than org repos, which other accounts may share.
    const score = new Map();
    for (const r of mine) {
      const parent = path.dirname(r.path);
      const weight = r.owner.toLowerCase() === a.login.toLowerCase() ? 2 : 1;
      score.set(parent, (score.get(parent) || 0) + weight);
    }
    const folder = [...score.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
    result[a.login] = { folder, repos: mine };
  }
  return result;
}

module.exports = { detect, findRepos, parseGithub, exists };
