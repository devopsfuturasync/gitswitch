const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  repos: [],            // [{ path, name, account }]
  selectedRepo: null,
  activeAccount: null,
  cloneDir: null,
  identities: {},       // login -> { name, email } overrides for commits
  syncGlobal: false,    // also switch gh + global git when the account changes
};

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'state.json');
    try {
      this.data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch {
      this.data = { ...DEFAULTS };
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

module.exports = { Store };
