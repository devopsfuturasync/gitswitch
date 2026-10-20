// Registers the GitSwitch MCP server (`gitswitch mcp`) in the AI apps
// installed on this computer, so their agents get the gitswitch_* tools.
//
// Each config is backed up into GitSwitch's data folder before it changes,
// only our "gitswitch" entry is touched, and a file we can't parse is left
// alone.
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./run');
const platform = require('./platform');

const NAME = 'gitswitch';
const SRC = __dirname.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const CLI = path.join(SRC, 'cli.js');
const home = platform.home;
const appData = platform.isWin
  ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
  : platform.isMac ? path.join(home, 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || path.join(home, '.config');

// How AI apps start the server. From the app (or the installed command) that
// is the GitSwitch executable in Node mode, so no Node.js install is needed;
// from a dev checkout it is the node running this file.
function serverEntry() {
  return {
    command: process.execPath,
    args: [CLI, 'mcp'],
    ...(process.versions.electron ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}),
  };
}

// kind: 'json' (servers under `key`), 'toml' (Codex) or 'claude-code' (its CLI).
const CLIENTS = [
  { id: 'claude-code', name: 'Claude Code', kind: 'claude-code', file: path.join(home, '.claude.json') },
  { id: 'claude-desktop', name: 'Claude Desktop', kind: 'json', key: 'mcpServers', file: path.join(appData, 'Claude', 'claude_desktop_config.json'), closeFirst: true },
  { id: 'codex', name: 'Codex', kind: 'toml', file: path.join(home, '.codex', 'config.toml') },
  { id: 'cursor', name: 'Cursor', kind: 'json', key: 'mcpServers', file: path.join(home, '.cursor', 'mcp.json') },
  { id: 'vscode', name: 'VS Code', kind: 'json', key: 'servers', file: path.join(appData, 'Code', 'User', 'mcp.json'), entry: (e) => ({ type: 'stdio', ...e }) },
  { id: 'windsurf', name: 'Windsurf', kind: 'json', key: 'mcpServers', file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json') },
  { id: 'gemini', name: 'Gemini CLI', kind: 'json', key: 'mcpServers', file: path.join(home, '.gemini', 'settings.json') },
  { id: 'antigravity', name: 'Antigravity', kind: 'json', key: 'mcpServers', file: path.join(home, '.gemini', 'antigravity', 'mcp_config.json') },
];

const readText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

function readJson(file) {
  const text = readText(file);
  if (text === null || !text.trim()) return {};
  return JSON.parse(text); // throws on JSONC comments: then we don't touch it
}

// Codex: the [mcp_servers.gitswitch] table and its sub-tables, up to the next table.
const TOML_BLOCK = /^\[mcp_servers\.gitswitch(?:\.[^\]]+)?\][^\n]*\n(?:(?!\[)[^\n]*\n?)*/gm;

const tomlString = (s) => JSON.stringify(s); // JSON escapes are valid TOML basic strings

function tomlEntry(e) {
  return [
    `[mcp_servers.${NAME}]`,
    `command = ${tomlString(e.command)}`,
    `args = [${e.args.map(tomlString).join(', ')}]`,
    ...(e.env ? [`env = { ${Object.entries(e.env).map(([k, v]) => `${k} = ${tomlString(v)}`).join(', ')} }`] : []),
    '',
  ].join('\n');
}

async function claudeCodeBin() {
  return platform.which('claude');
}

// .cmd/.bat shims can't be spawned without a shell on Windows.
function claudeArgs(bin, args) {
  return platform.isWin && /\.(cmd|bat)$/i.test(bin) ? ['cmd.exe', ['/d', '/c', bin, ...args]] : [bin, args];
}

async function desktopRunning() {
  try {
    if (platform.isWin) {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object { $_.Path -match 'WindowsApps\\\\Claude_|AnthropicClaude' } | Select-Object -First 1 -ExpandProperty Id"]);
      return Boolean(stdout.trim());
    }
    if (platform.isMac) {
      const { code } = await run('pgrep', ['-x', 'Claude'], { allowCodes: [0, 1] });
      return code === 0;
    }
  } catch { /* can't tell: assume not */ }
  return false;
}

function installedIn(client) {
  try {
    if (client.kind === 'toml') return new RegExp(`^\\[mcp_servers\\.${NAME}\\]`, 'm').test(readText(client.file) || '');
    if (client.kind === 'claude-code') return Boolean(readJson(client.file).mcpServers?.[NAME]);
    return Boolean(readJson(client.file)[client.key]?.[NAME]);
  } catch {
    return false;
  }
}

async function detected(client) {
  if (client.kind === 'claude-code') return Boolean(await claudeCodeBin());
  return fs.existsSync(path.dirname(client.file));
}

async function mcpStatus() {
  return Promise.all(CLIENTS.map(async (c) => ({
    id: c.id, name: c.name, file: c.file, detected: await detected(c), installed: installedIn(c),
  })));
}

function backup(client) {
  if (!fs.existsSync(client.file)) return null;
  const dir = path.join(platform.dataDir(), 'mcp-backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `${client.id}-${stamp}${path.extname(client.file)}`);
  fs.copyFileSync(client.file, target);
  return target;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.gitswitch-tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Adds (install) or removes our entry in one client. Returns a result row.
async function apply(client, install) {
  const row = { id: client.id, name: client.name, file: client.file };
  if (client.kind === 'claude-code') {
    const bin = await claudeCodeBin();
    if (!bin) return { ...row, result: 'not-found' };
    const call = (args, allowCodes) => { const [cmd, a] = claudeArgs(bin, args); return run(cmd, a, { allowCodes }); };
    const saved = backup(client);
    // `add-json` refuses to overwrite, so drop the old entry first.
    await call(['mcp', 'remove', NAME, '-s', 'user'], [0, 1]);
    if (install) await call(['mcp', 'add-json', NAME, JSON.stringify({ type: 'stdio', ...serverEntry() }), '-s', 'user'], [0]);
    return { ...row, result: install ? 'installed' : 'removed', backup: saved };
  }
  if (!(await detected(client))) return { ...row, result: 'not-found' };
  // Claude Desktop rewrites its config when it quits, which would undo us.
  if (client.closeFirst && await desktopRunning()) return { ...row, result: 'close-app' };

  let next;
  if (client.kind === 'toml') {
    const text = readText(client.file) || '';
    const stripped = text.replace(TOML_BLOCK, '');
    const without = stripped === text ? text : `${stripped.replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
    next = install ? `${without.trimEnd()}\n\n${tomlEntry(serverEntry())}` : without;
  } else {
    let data;
    try { data = readJson(client.file); } catch { return { ...row, result: 'unreadable' }; }
    const servers = { ...(data[client.key] || {}) };
    if (install) servers[NAME] = (client.entry || ((e) => e))(serverEntry());
    else if (!servers[NAME]) return { ...row, result: 'removed' };
    else delete servers[NAME];
    next = `${JSON.stringify({ ...data, [client.key]: servers }, null, 2)}\n`;
  }
  if (next === readText(client.file)) return { ...row, result: install ? 'installed' : 'removed' };
  const saved = backup(client);
  writeAtomic(client.file, next);
  return { ...row, result: install ? 'installed' : 'removed', backup: saved };
}

// ids: which clients; default every detected one.
async function changeMcp(install, ids) {
  const chosen = ids?.length ? CLIENTS.filter((c) => ids.includes(c.id)) : CLIENTS;
  const results = [];
  for (const c of chosen) {
    try {
      results.push(await apply(c, install));
    } catch (err) {
      results.push({ id: c.id, name: c.name, file: c.file, result: 'failed', error: err.message });
    }
  }
  return ids?.length ? results : results.filter((r) => r.result !== 'not-found');
}

module.exports = {
  mcpStatus,
  installMcp: (ids) => changeMcp(true, ids),
  removeMcp: (ids) => changeMcp(false, ids),
  serverEntry,
  CLIENTS,
};
