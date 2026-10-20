// Apps a repository can be opened in: editors, AI coding CLIs and the user's own.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { run } = require('./run');
const platform = require('./platform');

const LOCAL = process.env.LOCALAPPDATA || '';
const PF = process.env.ProgramFiles || 'C:\\Program Files';

// win: Start menu shortcut name + install paths; mac: .app bundle names;
// linux: commands on PATH.
const EDITORS = [
  { id: 'vscode', name: 'VS Code', shortcut: /^visual studio code$/i, paths: [`${LOCAL}\\Programs\\Microsoft VS Code\\Code.exe`, `${PF}\\Microsoft VS Code\\Code.exe`], mac: ['Visual Studio Code'], linux: ['code'] },
  { id: 'cursor', name: 'Cursor', shortcut: /^cursor$/i, paths: [`${LOCAL}\\Programs\\cursor\\Cursor.exe`], mac: ['Cursor'], linux: ['cursor'] },
  { id: 'windsurf', name: 'Windsurf', shortcut: /^windsurf$/i, paths: [`${LOCAL}\\Programs\\Windsurf\\Windsurf.exe`], mac: ['Windsurf'], linux: ['windsurf'] },
  { id: 'antigravity', name: 'Antigravity', shortcut: /^antigravity$/i, paths: [`${LOCAL}\\Programs\\Antigravity\\Antigravity.exe`], mac: ['Antigravity'], linux: ['antigravity'] },
  { id: 'antigravity-ide', name: 'Antigravity IDE', shortcut: /^antigravity ide$/i, paths: [`${LOCAL}\\Programs\\Antigravity IDE\\Antigravity IDE.exe`], mac: ['Antigravity IDE'], linux: [] },
  { id: 'kiro', name: 'Kiro', shortcut: /^kiro$/i, paths: [`${LOCAL}\\Programs\\Kiro\\Kiro.exe`], mac: ['Kiro'], linux: ['kiro'] },
  { id: 'trae', name: 'Trae', shortcut: /^trae$/i, paths: [`${LOCAL}\\Programs\\Trae\\Trae.exe`], mac: ['Trae'], linux: ['trae'] },
  { id: 'zed', name: 'Zed', shortcut: /^zed$/i, paths: [`${LOCAL}\\Programs\\Zed\\zed.exe`], mac: ['Zed'], linux: ['zed', 'zeditor'] },
  { id: 'sublime', name: 'Sublime Text', shortcut: /^sublime text/i, paths: [`${PF}\\Sublime Text\\sublime_text.exe`], mac: ['Sublime Text'], linux: ['subl'] },
  { id: 'xcode', name: 'Xcode', shortcut: null, paths: [], mac: ['Xcode'], linux: [] },
  { id: 'jetbrains', name: null, shortcut: /^(intellij idea|webstorm|pycharm|rider|goland|phpstorm|clion|rubymine)/i, paths: [], mac: [], linux: [] },
];

const JETBRAINS_MAC = /^(IntelliJ IDEA|WebStorm|PyCharm|Rider|GoLand|PhpStorm|CLion|RubyMine)/;

const CLIS = [
  { id: 'claude', name: 'Claude Code', command: 'claude' },
  { id: 'codex', name: 'Codex CLI', command: 'codex' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini' },
  { id: 'opencode', name: 'OpenCode', command: 'opencode' },
  { id: 'aider', name: 'Aider', command: 'aider' },
];

// Start menu shortcuts -> { name, target }, read with one PowerShell call.
async function startMenuShortcuts() {
  const script = `
$sh = New-Object -ComObject WScript.Shell
$dirs = "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs", "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs"
Get-ChildItem $dirs -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ name = $_.BaseName; target = $sh.CreateShortcut($_.FullName).TargetPath }
} | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const list = JSON.parse(stdout || '[]');
    return Array.isArray(list) ? list : [list];
  } catch {
    return [];
  }
}

async function detectWindows() {
  const shortcuts = await startMenuShortcuts();
  const editors = [];
  for (const e of EDITORS) {
    if (!e.shortcut) continue;
    if (e.id === 'jetbrains') {
      for (const s of shortcuts.filter((x) => e.shortcut.test(x.name) && x.target?.endsWith('.exe'))) {
        editors.push({ id: `jb-${s.name.toLowerCase().replace(/\W+/g, '-')}`, name: s.name, kind: 'exe', command: s.target });
      }
      continue;
    }
    const hit = shortcuts.find((s) => e.shortcut.test(s.name) && s.target?.toLowerCase().endsWith('.exe') && fs.existsSync(s.target));
    const exe = hit?.target || e.paths.find((p) => fs.existsSync(p));
    if (exe) editors.push({ id: e.id, name: e.name, kind: 'exe', command: exe });
  }
  return editors;
}

// macOS: .app bundles in /Applications or ~/Applications, opened with `open -a`.
function detectMac() {
  const dirs = ['/Applications', path.join(platform.home, 'Applications')];
  const bundles = dirs.flatMap((d) => {
    try { return fs.readdirSync(d).filter((n) => n.endsWith('.app')).map((n) => path.join(d, n)); } catch { return []; }
  });
  const find = (name) => bundles.find((b) => path.basename(b, '.app') === name);
  const editors = [];
  for (const e of EDITORS) {
    if (e.id === 'jetbrains') {
      for (const b of bundles.filter((x) => JETBRAINS_MAC.test(path.basename(x, '.app')))) {
        const name = path.basename(b, '.app');
        editors.push({ id: `jb-${name.toLowerCase().replace(/\W+/g, '-')}`, name, kind: 'mac-app', command: b });
      }
      continue;
    }
    const bundle = e.mac.map(find).find(Boolean);
    if (bundle) editors.push({ id: e.id, name: e.name, kind: 'mac-app', command: bundle });
  }
  return editors;
}

// Linux: editor commands on PATH (installed by .deb, snap, flatpak export…).
async function detectLinux() {
  const editors = [];
  for (const e of EDITORS) {
    for (const cmd of e.linux) {
      const exe = await platform.which(cmd);
      if (exe) { editors.push({ id: e.id, name: e.name, kind: 'exe', command: exe }); break; }
    }
  }
  return editors;
}

let cached = null;

async function detect() {
  if (cached) return cached;
  const editors = platform.isWin ? await detectWindows() : platform.isMac ? detectMac() : await detectLinux();
  const clis = [];
  for (const c of CLIS) {
    if (await platform.which(c.command)) clis.push({ id: c.id, name: c.name, kind: 'terminal', command: c.command });
  }
  clis.push({ id: 'terminal', name: 'Terminal', kind: 'terminal', command: null });
  cached = { editors, clis };
  return cached;
}

// Splits an argument template, keeping "quoted parts" together.
function splitArgs(template, dir) {
  const parts = template.match(/"[^"]*"|\S+/g) || [];
  return parts.map((p) => p.replace(/^"(.*)"$/, '$1').replaceAll('{path}', dir));
}

async function launch(app, dir) {
  if (app.kind === 'mac-app') {
    spawn('open', ['-a', app.command, dir], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (app.kind === 'exe') {
    const args = splitArgs(app.args || '"{path}"', dir);
    spawn(app.command, args, { detached: true, stdio: 'ignore', cwd: dir }).unref();
    return;
  }
  await platform.openTerminal(dir, app.command);
}

module.exports = { detect, launch };
