// Builds the installer and publishes it as a GitHub release, which is what
// installed copies check for updates. Bump "version" in package.json first.
// The token comes from the GitHub CLI login of the account that owns the repo.
//
// The release is created as a draft up front: when electron-builder creates
// it itself, its parallel uploads race to create it and one fails (422 "must
// have a valid tag"), leaving the release without latest.yml.
const { execFileSync, spawnSync } = require('node:child_process');
const pkg = require('../package.json');

const { owner, repo } = pkg.build.publish[0];
const tag = `v${pkg.version}`;
const token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com', '--user', owner], { encoding: 'utf8' }).trim();
const env = { ...process.env, GH_TOKEN: token };
const gh = (...args) => spawnSync('gh', ['--repo', `${owner}/${repo}`, ...args], { stdio: 'inherit', env });

if (gh('release', 'view', tag).status !== 0) {
  const made = gh('release', 'create', tag, '--draft', '--target', 'main', '--title', `GitSwitch ${pkg.version}`, '--notes', `GitSwitch ${pkg.version}`);
  if (made.status !== 0) process.exit(made.status ?? 1);
}

if (spawnSync('node', [require('node:path').join(__dirname, 'fetch-vendor.js')], { stdio: 'inherit' }).status !== 0) process.exit(1);

const built = spawnSync('npx', ['electron-builder', '--win', 'nsis', '--publish', 'always'], { stdio: 'inherit', shell: true, env });
if (built.status !== 0) process.exit(built.status ?? 1);

process.exit(gh('release', 'edit', tag, '--draft=false', '--latest').status ?? 1);
