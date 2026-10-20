// Puts the `gitswitch` command on the user's PATH and installs the AI skill
// that teaches coding agents to use it. Used by the CLI and the app.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./run');
const platform = require('./platform');

// Windows: a folder of our own added to the user PATH.
// macOS/Linux: ~/.local/bin, the usual per-user bin directory.
const BIN = platform.isWin
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'GitSwitch', 'bin')
  : path.join(os.homedir(), '.local', 'bin');
// Packaged, this file is read from app.asar, which a plain `node` can't open:
// the shim points at the unpacked copy (see build.asarUnpack).
const SRC = __dirname.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const CLI = path.join(SRC, 'cli.js');
const SKILL_SOURCE = path.join(SRC, 'ai-skill.md');
// Claude Code reads ~/.claude/skills; other agents read ~/.agents/skills.
const SKILL_HOMES = [path.join(os.homedir(), '.claude', 'skills'), path.join(os.homedir(), '.agents', 'skills')];
const PROFILE_MARK = '# Added by GitSwitch: gitswitch command';

function onPath() {
  const sep = platform.isWin ? ';' : ':';
  const norm = (d) => path.normalize(d).toLowerCase().replace(/[\\/]$/, '');
  return (process.env.PATH || '').split(sep).filter(Boolean).map(norm).includes(norm(BIN));
}

function cliStatus() {
  return {
    installed: fs.existsSync(path.join(BIN, platform.isWin ? 'gitswitch.cmd' : 'gitswitch')),
    onPath: onPath(),
    bin: BIN,
    cli: CLI,
  };
}

// From the installed app, run through the GitSwitch executable in Node mode
// so no Node.js install is needed (GitHub Desktop's github.bat does the
// same). A dev checkout falls back to the `node` on PATH.
function posixShim(exe) {
  return exe
    ? `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${exe.replaceAll('\\', '/')}" "${CLI.replaceAll('\\', '/')}" "$@"\n`
    : `#!/bin/sh\nexec node "${CLI.replaceAll('\\', '/')}" "$@"\n`;
}

async function addToWindowsPath() {
  const script = [
    "$d = $env:GITSWITCH_BIN",
    "$p = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($null -eq $p) { $p = '' }",
    "if (($p -split ';') -contains $d) { 'present' } else {",
    "  [Environment]::SetEnvironmentVariable('Path', (($p.TrimEnd(';') + ';' + $d).TrimStart(';')), 'User'); 'added' }",
  ].join('\n');
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { GITSWITCH_BIN: BIN } });
  return stdout.trim();
}

// ~/.local/bin is on PATH on most Linux desktops but not on macOS: add it to
// the login shell's profile once, marked so it is easy to find and remove.
function addToPosixPath() {
  if (onPath()) return 'present';
  const shell = path.basename(process.env.SHELL || '');
  const profile = path.join(os.homedir(), shell === 'zsh' || (platform.isMac && !shell) ? '.zprofile' : shell === 'bash' ? (platform.isMac ? '.bash_profile' : '.profile') : '.profile');
  const current = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf8') : '';
  if (current.includes(PROFILE_MARK)) return 'present';
  fs.appendFileSync(profile, `\n${PROFILE_MARK}\nexport PATH="$HOME/.local/bin:$PATH"\n`);
  return `added (${profile})`;
}

async function installCli() {
  fs.mkdirSync(BIN, { recursive: true });
  const exe = process.versions.electron ? process.execPath : null;
  if (platform.isWin) {
    fs.writeFileSync(path.join(BIN, 'gitswitch.cmd'), exe
      ? `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exe}" "${CLI}" %*\r\nexit /b %ERRORLEVEL%\r\n`
      : `@echo off\r\nnode "${CLI}" %*\r\n`);
    fs.writeFileSync(path.join(BIN, 'gitswitch'), posixShim(exe)); // Git Bash
    return { ...cliStatus(), path: await addToWindowsPath() };
  }
  const shim = path.join(BIN, 'gitswitch');
  fs.writeFileSync(shim, posixShim(exe));
  fs.chmodSync(shim, 0o755);
  return { ...cliStatus(), path: addToPosixPath() };
}

function skillStatus() {
  return SKILL_HOMES.map((home) => ({ dir: path.join(home, 'gitswitch'), installed: fs.existsSync(path.join(home, 'gitswitch', 'SKILL.md')) }));
}

// Installs into every agent skills folder that already exists (always Claude's).
function installSkill() {
  const text = fs.readFileSync(SKILL_SOURCE, 'utf8');
  const done = [];
  SKILL_HOMES.forEach((home, i) => {
    if (i > 0 && !fs.existsSync(home)) return;
    const dir = path.join(home, 'gitswitch');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
    done.push(dir);
  });
  return { installed: done };
}

module.exports = { cliStatus, installCli, skillStatus, installSkill, BIN };
