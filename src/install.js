// Puts the `gitswitch` command on the user's PATH and installs the AI skill
// that teaches coding agents to use it. Used by the CLI and the app.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./run');

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const BIN = path.join(LOCAL, 'GitSwitch', 'bin');
// Packaged, this file is read from app.asar, which a plain `node` can't open:
// the shim points at the unpacked copy (see build.asarUnpack).
const SRC = __dirname.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const CLI = path.join(SRC, 'cli.js');
const SKILL_SOURCE = path.join(SRC, 'ai-skill.md');
// Claude Code reads ~/.claude/skills; other agents read ~/.agents/skills.
const SKILL_HOMES = [path.join(os.homedir(), '.claude', 'skills'), path.join(os.homedir(), '.agents', 'skills')];

function cliStatus() {
  const pathDirs = (process.env.PATH || '').split(';').map((d) => d.toLowerCase().replace(/\\$/, ''));
  return {
    installed: fs.existsSync(path.join(BIN, 'gitswitch.cmd')),
    onPath: pathDirs.includes(BIN.toLowerCase()),
    bin: BIN,
    cli: CLI,
  };
}

// Writes gitswitch.cmd (cmd/PowerShell) and gitswitch (Git Bash) shims and
// adds their folder to the user PATH. New terminals pick it up.
async function installCli() {
  fs.mkdirSync(BIN, { recursive: true });
  fs.writeFileSync(path.join(BIN, 'gitswitch.cmd'), `@echo off\r\nnode "${CLI}" %*\r\n`);
  fs.writeFileSync(path.join(BIN, 'gitswitch'), `#!/bin/sh\nexec node "${CLI.replaceAll('\\', '/')}" "$@"\n`);
  const script = [
    "$d = $env:GITSWITCH_BIN",
    "$p = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($null -eq $p) { $p = '' }",
    "if (($p -split ';') -contains $d) { 'present' } else {",
    "  [Environment]::SetEnvironmentVariable('Path', (($p.TrimEnd(';') + ';' + $d).TrimStart(';')), 'User'); 'added' }",
  ].join('\n');
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { GITSWITCH_BIN: BIN } });
  return { ...cliStatus(), path: stdout.trim() };
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
