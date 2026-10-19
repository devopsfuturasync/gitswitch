// Apps a repository can be opened in: editors, AI coding CLIs and the user's own.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { run } = require('./run');

const LOCAL = process.env.LOCALAPPDATA || '';
const PF = process.env.ProgramFiles || 'C:\\Program Files';

const EDITORS = [
  { id: 'vscode', name: 'VS Code', shortcut: /^visual studio code$/i, paths: [`${LOCAL}\\Programs\\Microsoft VS Code\\Code.exe`, `${PF}\\Microsoft VS Code\\Code.exe`] },
  { id: 'cursor', name: 'Cursor', shortcut: /^cursor$/i, paths: [`${LOCAL}\\Programs\\cursor\\Cursor.exe`] },
  { id: 'windsurf', name: 'Windsurf', shortcut: /^windsurf$/i, paths: [`${LOCAL}\\Programs\\Windsurf\\Windsurf.exe`] },
  { id: 'antigravity', name: 'Antigravity', shortcut: /^antigravity$/i, paths: [`${LOCAL}\\Programs\\Antigravity\\Antigravity.exe`] },
  { id: 'antigravity-ide', name: 'Antigravity IDE', shortcut: /^antigravity ide$/i, paths: [`${LOCAL}\\Programs\\Antigravity IDE\\Antigravity IDE.exe`] },
  { id: 'kiro', name: 'Kiro', shortcut: /^kiro$/i, paths: [`${LOCAL}\\Programs\\Kiro\\Kiro.exe`] },
  { id: 'trae', name: 'Trae', shortcut: /^trae$/i, paths: [`${LOCAL}\\Programs\\Trae\\Trae.exe`] },
  { id: 'zed', name: 'Zed', shortcut: /^zed$/i, paths: [`${LOCAL}\\Programs\\Zed\\zed.exe`] },
  { id: 'sublime', name: 'Sublime Text', shortcut: /^sublime text/i, paths: [`${PF}\\Sublime Text\\sublime_text.exe`] },
  { id: 'jetbrains', name: null, shortcut: /^(intellij idea|webstorm|pycharm|rider|goland|phpstorm|clion|rubymine)/i, paths: [] },
];

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

async function onPath(command) {
  try {
    const { stdout } = await run('where.exe', [command]);
    return stdout.split(/\r?\n/).find(Boolean) || null;
  } catch {
    return null;
  }
}

let cached = null;

async function detect() {
  if (cached) return cached;
  const shortcuts = await startMenuShortcuts();
  const editors = [];
  for (const e of EDITORS) {
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
  const clis = [];
  for (const c of CLIS) {
    if (await onPath(c.command)) clis.push({ id: c.id, name: c.name, kind: 'terminal', command: c.command });
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

let wtPath;

async function launch(app, dir) {
  if (app.kind === 'exe') {
    const args = splitArgs(app.args || '"{path}"', dir);
    spawn(app.command, args, { detached: true, stdio: 'ignore', cwd: dir }).unref();
    return;
  }
  // Terminal apps run in Windows Terminal when available, else in a console.
  if (wtPath === undefined) wtPath = await onPath('wt');
  const cmd = app.command;
  if (wtPath) {
    const args = ['-d', dir];
    if (cmd) args.push('cmd.exe', '/k', cmd);
    spawn(wtPath, args, { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('cmd.exe', cmd ? ['/k', cmd] : [], { cwd: dir, detached: true, stdio: 'ignore' }).unref();
  }
}

module.exports = { detect, launch };
