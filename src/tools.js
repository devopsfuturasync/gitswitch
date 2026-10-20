// Which git and gh executables to run: the copies shipped with GitSwitch
// (like GitHub Desktop's bundled Git) or the ones on the system PATH.
const fs = require('node:fs');
const path = require('node:path');

// Packaged: <resources>/app.asar[.unpacked]/src -> tools live in <resources>.
// Dev checkout: build/vendor/<platform>-<arch> (filled by `npm run vendor`).
function toolsRoot() {
  const appDir = path.resolve(__dirname, '..');
  if (/app\.asar(\.unpacked)?$/i.test(appDir)) return path.dirname(appDir);
  return path.join(appDir, 'build', 'vendor', `${process.platform}-${process.arch}`);
}

const ROOT = toolsRoot();
const WIN = process.platform === 'win32';
const BUNDLED = {
  git: WIN ? path.join(ROOT, 'git', 'cmd', 'git.exe') : path.join(ROOT, 'git', 'bin', 'git'),
  gh: path.join(ROOT, 'gh', 'bin', WIN ? 'gh.exe' : 'gh'),
};

const preference = { git: 'bundled', gh: 'bundled' };

// prefs: { git?: 'bundled' | 'system', gh?: 'bundled' | 'system' }
function setPreference(prefs = {}) {
  for (const name of Object.keys(preference)) {
    if (prefs[name] === 'bundled' || prefs[name] === 'system') preference[name] = prefs[name];
  }
}

function hasBundled(name) {
  return fs.existsSync(BUNDLED[name]);
}

// The executable to spawn; falls back to PATH when no bundled copy exists.
function bin(name) {
  return preference[name] === 'bundled' && hasBundled(name) ? BUNDLED[name] : name;
}

function describe() {
  return Object.fromEntries(Object.keys(BUNDLED).map((name) => [name, {
    preference: preference[name],
    bundled: hasBundled(name) ? BUNDLED[name] : null,
    using: bin(name),
  }]));
}

module.exports = { bin, setPreference, describe, hasBundled };
