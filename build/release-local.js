// Windows-only release built and published from this machine (the full
// multi-platform release runs in GitHub Actions: see release.js).
// The release is created as a draft first so electron-builder's parallel
// uploads don't race to create it, then published as latest.
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

if (spawnSync('node', [require('node:path').join(__dirname, 'fetch-vendor.js'), 'win32-x64'], { stdio: 'inherit' }).status !== 0) process.exit(1);

const built = spawnSync('npx', ['electron-builder', '--win', 'nsis', '--publish', 'always'], { stdio: 'inherit', shell: true, env });
if (built.status !== 0) process.exit(built.status ?? 1);

process.exit(gh('release', 'edit', tag, '--draft=false', '--latest').status ?? 1);
