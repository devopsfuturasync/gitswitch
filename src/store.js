const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  repos: [],            // [{ path, name, account }]
  selectedRepo: null,
  activeAccount: null,
  cloneDir: null,
  identities: {},       // login -> { name, email } overrides for commits
  accountDirs: {},      // login -> folder where that account's repos live
  syncGlobal: false,    // also switch gh + global git when the account changes
  openWith: 'vscode',   // id of the app "Abrir em" uses by default
  customApps: [],       // [{ id, name, kind: 'exe' | 'terminal', command, args }]
};

class Store {
  constructor(dir, onError) {
    this.file = path.join(dir, 'state.json');
    this.onError = onError;
    try {
      this.data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch {
      this.data = { ...DEFAULTS };
    }
  }

  get(key) {
    return this.data[key];
  }

  // Writes to a temp file first so a failed write never leaves half a JSON.
  set(key, value) {
    this.data[key] = value;
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.onError?.(err);
    }
  }
}

module.exports = { Store };
