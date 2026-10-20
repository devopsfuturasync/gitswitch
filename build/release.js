// Starts a release of all platforms: tags HEAD as v<version> and pushes the
// tag with the repo owner's account; GitHub Actions (.github/workflows/
// release.yml) then builds Windows, macOS and Linux and publishes them.
// Bump "version" in package.json and push main first.
//
//   npm run release          # tag + push, CI builds everything
//   npm run release:local    # Windows only, built and published from here
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pkg = require('../package.json');
const accounts = require('../src/accounts');
const git = require('../src/git');

const { owner, repo } = pkg.build.publish[0];
const tag = `v${pkg.version}`;
const root = path.join(__dirname, '..');

(async () => {
  const st = await git.status(root);
  if (st.files.length) throw new Error('Commit or stash your changes first.');
  if (!st.upstream || st.ahead) throw new Error('Push main first (the tag must point at a commit GitHub has).');

  const creds = await accounts.credentials(owner, {});
  const exists = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { cwd: root }).status === 0;
  if (!exists) await git.createTag(root, creds, tag, 'HEAD', `GitSwitch ${pkg.version}`);
  const pushed = spawnSync(require('../src/tools').bin('git'), ['push', 'origin', tag], {
    cwd: root, stdio: 'inherit', env: { ...process.env, ...git.accountEnv(creds) },
  });
  if (pushed.status !== 0) throw new Error(`Could not push ${tag}.`);
  console.log(`Pushed ${tag}. Builds run at https://github.com/${owner}/${repo}/actions`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
