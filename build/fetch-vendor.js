// Downloads the Git (MinGit) and GitHub CLI builds pinned in vendor.json into
// build/vendor/<name>, checking each archive's SHA-256 before extracting it.
// Skips a tool whose extracted copy already matches the pinned version.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const manifest = require('./vendor.json');
const VENDOR = path.join(__dirname, 'vendor');

async function fetchTool(name, { version, url, sha256 }) {
  const dest = path.join(VENDOR, name);
  const stamp = path.join(dest, '.gitswitch-version');
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === version) {
    console.log(`${name} ${version}: already present`);
    return;
  }
  console.log(`${name} ${version}: downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: download failed with ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = crypto.createHash('sha256').update(buf).digest('hex');
  if (actual !== sha256) throw new Error(`${name}: SHA-256 mismatch (expected ${sha256}, got ${actual})`);

  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const zip = path.join(VENDOR, `${name}.zip`);
  fs.writeFileSync(zip, buf);
  // Windows 10+ ships bsdtar, which reads zip archives.
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(tar, ['-xf', zip, '-C', dest], { stdio: 'inherit' });
  fs.rmSync(zip);
  fs.writeFileSync(stamp, `${version}\n`);
  console.log(`${name} ${version}: verified and extracted`);
}

(async () => {
  fs.mkdirSync(VENDOR, { recursive: true });
  for (const [name, entry] of Object.entries(manifest)) await fetchTool(name, entry);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
