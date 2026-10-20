// Downloads the tools pinned in vendor.json for one or more targets into
// build/vendor/<platform>-<arch>/<tool>, checking each archive's SHA-256
// before extracting it. Skips a tool already present at the pinned version.
//
//   node build/fetch-vendor.js                         # this machine
//   node build/fetch-vendor.js darwin-x64 darwin-arm64 # explicit targets
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const manifest = require('./vendor.json');
const VENDOR = path.join(__dirname, 'vendor');

// Archives from macOS/Linux releases wrap everything in one top folder.
function flatten(dir) {
  const entries = fs.readdirSync(dir).filter((n) => n !== '.gitswitch-version');
  if (entries.length !== 1) return;
  const only = path.join(dir, entries[0]);
  if (!fs.statSync(only).isDirectory()) return;
  for (const name of fs.readdirSync(only)) fs.renameSync(path.join(only, name), path.join(dir, name));
  fs.rmdirSync(only);
}

function extract(archive, dest) {
  // Windows 10+ ships bsdtar (reads zip); macOS tar is bsdtar too; Linux
  // archives are .tar.gz and Linux zips go through unzip.
  if (process.platform === 'win32') {
    execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', dest], { stdio: 'inherit' });
  } else if (archive.endsWith('.zip') && process.platform === 'linux') {
    execFileSync('unzip', ['-q', archive, '-d', dest], { stdio: 'inherit' });
  } else {
    execFileSync('tar', ['-xf', archive, '-C', dest], { stdio: 'inherit' });
  }
}

async function fetchTool(target, name, { version, url, sha256 }) {
  const dest = path.join(VENDOR, target, name);
  const stamp = path.join(dest, '.gitswitch-version');
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === version) {
    console.log(`${target} ${name} ${version}: already present`);
    return;
  }
  console.log(`${target} ${name} ${version}: downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: download failed with ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = crypto.createHash('sha256').update(buf).digest('hex');
  if (actual !== sha256) throw new Error(`${name}: SHA-256 mismatch (expected ${sha256}, got ${actual})`);

  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const archive = path.join(VENDOR, `${target}-${name}${url.endsWith('.tar.gz') ? '.tar.gz' : '.zip'}`);
  fs.writeFileSync(archive, buf);
  extract(archive, dest);
  fs.rmSync(archive);
  flatten(dest);
  fs.writeFileSync(stamp, `${version}\n`);
  console.log(`${target} ${name} ${version}: verified and extracted`);
}

(async () => {
  const targets = process.argv.slice(2).length ? process.argv.slice(2) : [`${process.platform}-${process.arch}`];
  for (const target of targets) {
    const tools = manifest[target];
    if (!tools) throw new Error(`No tools pinned for ${target} in vendor.json`);
    fs.mkdirSync(path.join(VENDOR, target), { recursive: true });
    for (const [name, entry] of Object.entries(tools)) await fetchTool(target, name, entry);
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
