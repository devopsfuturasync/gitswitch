// Builds the installer and publishes it as a GitHub release, which is what
// installed copies check for updates. Bump "version" in package.json first.
// The token comes from the GitHub CLI login of the account that owns the repo.
const { execFileSync, spawnSync } = require('node:child_process');
const pkg = require('../package.json');

const { owner } = pkg.build.publish[0];
const token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com', '--user', owner], { encoding: 'utf8' }).trim();

const res = spawnSync('npx', ['electron-builder', '--win', 'nsis', '--publish', 'always'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, GH_TOKEN: token },
});
process.exit(res.status ?? 1);
