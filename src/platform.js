// What differs between Windows, macOS and Linux, in one place.
const { t: _t } = require('./i18n');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { run } = require('./run');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const home = os.homedir();

// Absolute path of a command on PATH, or null.
async function which(command) {
  try {
    const { stdout } = isWin ? await run('where.exe', [command]) : await run('/bin/sh', ['-c', `command -v "${command}"`]);
    return stdout.split(/\r?\n/).find(Boolean)?.trim() || null;
  } catch {
    return null;
  }
}

// Where the app keeps state.json; matches Electron's userData for "GitSwitch".
function dataDir() {
  if (process.env.GITSWITCH_DATA) return process.env.GITSWITCH_DATA;
  if (isWin) return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'GitSwitch');
  if (isMac) return path.join(home, 'Library', 'Application Support', 'GitSwitch');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'GitSwitch');
}

// Apps started from Finder or a desktop launcher get a minimal PATH, so
// git, gh, claude… installed by Homebrew or a version manager go missing.
// Take PATH from the user's login shell once at startup.
async function adoptShellPath() {
  if (isWin) return;
  const shell = process.env.SHELL || (isMac ? '/bin/zsh' : '/bin/bash');
  try {
    // An interactive shell that can reach a terminal gets stopped by job
    // control (SIGTTIN) and hangs; in its own session it has none.
    const { stdout } = await run(shell, ['-ilc', 'printf "__GS__%s__GS__" "$PATH"'], { env: { TERM: 'dumb' }, detached: true, timeoutMs: 5000 });
    const m = stdout.match(/__GS__(.*)__GS__/s);
    if (!m) return;
    const merged = [...new Set([...m[1].split(':'), ...(process.env.PATH || '').split(':')].filter(Boolean))];
    process.env.PATH = merged.join(':');
  } catch { /* keep the PATH we have */ }
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const LINUX_TERMINALS = [
  // [command, args for "open in dir", args for "run command in dir"]
  ['gnome-terminal', (d) => [`--working-directory=${d}`], (d, c) => [`--working-directory=${d}`, '--', 'sh', '-c', `${c}; exec "$SHELL"`]],
  ['konsole', (d) => ['--workdir', d], (d, c) => ['--workdir', d, '-e', 'sh', '-c', `${c}; exec "$SHELL"`]],
  ['xfce4-terminal', (d) => [`--working-directory=${d}`], (d, c) => [`--working-directory=${d}`, '-x', 'sh', '-c', `${c}; exec "$SHELL"`]],
  ['kitty', (d) => ['--directory', d], (d, c) => ['--directory', d, 'sh', '-c', `${c}; exec "$SHELL"`]],
  ['alacritty', (d) => ['--working-directory', d], (d, c) => ['--working-directory', d, '-e', 'sh', '-c', `${c}; exec "$SHELL"`]],
  ['wezterm', (d) => ['start', '--cwd', d], (d, c) => ['start', '--cwd', d, '--', 'sh', '-c', `${c}; exec "$SHELL"`]],
  // Debian's generic alternative last: its flags depend on the real terminal.
  ['x-terminal-emulator', () => [], (d, c) => ['-e', 'sh', '-c', `cd ${shQuote(d)} && ${c}; exec "$SHELL"`]],
];

const detached = (cmd, args, opts = {}) => spawn(cmd, args, { detached: true, stdio: 'ignore', ...opts }).unref();

// Opens a terminal in dir, optionally running command there.
async function openTerminal(dir, command = null) {
  if (isWin) {
    const wt = await which('wt');
    if (wt) {
      const args = ['-d', dir];
      if (command) args.push('cmd.exe', '/k', command);
      detached(wt, args);
    } else {
      detached('cmd.exe', command ? ['/k', command] : [], { cwd: dir });
    }
    return;
  }
  if (isMac) {
    if (!command) { detached('open', ['-a', 'Terminal', dir]); return; }
    const script = `cd ${shQuote(dir)} && ${command}`;
    detached('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(script)}`, '-e', 'tell application "Terminal" to activate']);
    return;
  }
  for (const [cmd, inDir, runIn] of LINUX_TERMINALS) {
    if (await which(cmd)) {
      detached(cmd, command ? runIn(dir, command) : inDir(dir), { cwd: dir });
      return;
    }
  }
  throw new Error(_t('Nenhum terminal encontrado (instale gnome-terminal, konsole ou outro).'));
}

// "Show in folder" wording per OS.
const fileManager = isWin ? 'Explorer' : isMac ? 'Finder' : 'Arquivos';

module.exports = { isWin, isMac, home, which, dataDir, adoptShellPath, openTerminal, fileManager, shQuote };
