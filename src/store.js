const fs = require('node:fs');
const os = require('node:os');
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

// Where the app keeps state.json; the CLI reads the same file.
function defaultDataDir() {
  if (process.env.GITSWITCH_DATA) return process.env.GITSWITCH_DATA;
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(roaming, 'GitSwitch');
}

class Store {
  constructor(dir = defaultDataDir(), onError) {
    this.file = path.join(dir, 'state.json');
    this.onError = onError;
    this.data = this.read();
  }

  read() {
    try {
      return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  // Picks up what the CLI (or another window) wrote meanwhile.
  reload() {
    this.data = this.read();
  }

  get(key) {
    return this.data[key];
  }

  // Merges into what is on disk now, so the app and the CLI don't undo each
  // other's changes, and writes to a temp file first so a failed write never
  // leaves half a JSON.
  set(key, value) {
    this.data = { ...this.read(), [key]: value };
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

module.exports = { Store, defaultDataDir };
