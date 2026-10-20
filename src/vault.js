// GitSwitch's own token vault, for computers whose GitHub CLI would otherwise
// keep tokens in plain text (Linux without a Secret Service keyring, or any
// login made with --insecure-storage).
//
// Same model as aws-vault's file backend and GCM's gpg store: the tokens are
// encrypted with a key derived from a master password the user types, so
// nothing on disk can open them by itself. scrypt (N=2^17, r=8, p=1) derives
// the key; AES-256-GCM encrypts the tokens and authenticates the header, so a
// changed login list or KDF setting fails to open instead of being trusted.
//
// The logins are stored in clear (they aren't secrets) so the app can list
// accounts while the vault is locked.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const platform = require('./platform');

const FORMAT = 'gitswitch-vault';
const VERSION = 1;
const KDF = { name: 'scrypt', N: 2 ** 17, r: 8, p: 1, keyLength: 32 };
const MIN_PASSWORD = 8;

const file = () => path.join(platform.dataDir(), 'vault.json');

// Unlocked state lives only in this process's memory.
let unlocked = null; // { key: Buffer, salt: Buffer, tokens: { login: token } }

class VaultError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code; // 'locked' | 'missing' | 'bad-password' | 'corrupt' | 'exists' | 'weak'
  }
}

function readFile() {
  let text;
  try { text = fs.readFileSync(file(), 'utf8'); } catch { return null; }
  const v = JSON.parse(text);
  if (v.format !== FORMAT || v.version !== VERSION) throw new VaultError('Unsupported vault file.', 'corrupt');
  return v;
}

const exists = () => fs.existsSync(file());

// Logins kept in the vault, readable while locked.
function logins() {
  try { return readFile()?.logins || []; } catch { return []; }
}

const aad = (header) => Buffer.from(JSON.stringify([header.format, header.version, header.kdf, header.logins]));

function deriveKey(password, salt, kdf = KDF) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password).normalize('NFKC'), salt, kdf.keyLength, {
      N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024,
    }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function writeVault() {
  const { key, salt, tokens } = unlocked;
  const header = {
    format: FORMAT, version: VERSION,
    kdf: { ...KDF, salt: salt.toString('base64') },
    logins: Object.keys(tokens).sort(),
  };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(header));
  const data = Buffer.concat([cipher.update(JSON.stringify({ tokens }), 'utf8'), cipher.final()]);
  const body = { ...header, cipher: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file());
  if (!platform.isWin) fs.chmodSync(file(), 0o600);
}

function checkPassword(password) {
  if (String(password || '').length < MIN_PASSWORD) throw new VaultError(`The password needs at least ${MIN_PASSWORD} characters.`, 'weak');
}

async function create(password) {
  if (exists()) throw new VaultError('A vault already exists.', 'exists');
  checkPassword(password);
  const salt = crypto.randomBytes(16);
  unlocked = { key: await deriveKey(password, salt), salt, tokens: {} };
  writeVault();
}

async function unlock(password) {
  const v = readFile();
  if (!v) throw new VaultError('There is no vault yet.', 'missing');
  const salt = Buffer.from(v.kdf.salt, 'base64');
  const key = await deriveKey(password, salt, v.kdf);
  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(v.iv, 'base64'));
    decipher.setAAD(aad(v));
    decipher.setAuthTag(Buffer.from(v.tag, 'base64'));
    plain = Buffer.concat([decipher.update(Buffer.from(v.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new VaultError('Wrong password.', 'bad-password');
  }
  unlocked = { key, salt, tokens: JSON.parse(plain).tokens || {} };
}

function lock() {
  if (unlocked) unlocked.key.fill(0);
  unlocked = null;
}

const isUnlocked = () => Boolean(unlocked);

function needUnlocked() {
  if (!exists()) throw new VaultError('There is no vault yet.', 'missing');
  if (!unlocked) throw new VaultError('The vault is locked.', 'locked');
}

function get(login) {
  needUnlocked();
  return unlocked.tokens[login] ?? null;
}

function set(login, token) {
  needUnlocked();
  unlocked.tokens[login] = token;
  writeVault();
}

function remove(login) {
  needUnlocked();
  delete unlocked.tokens[login];
  writeVault();
}

async function changePassword(oldPassword, newPassword) {
  checkPassword(newPassword);
  await unlock(oldPassword);
  const salt = crypto.randomBytes(16);
  unlocked = { key: await deriveKey(newPassword, salt), salt, tokens: unlocked.tokens };
  writeVault();
}

// Only an empty vault can be deleted: tokens are never thrown away silently.
function destroy() {
  if (logins().length) throw new VaultError('Move the accounts out of the vault first.', 'not-empty');
  lock();
  fs.rmSync(file(), { force: true });
}

function status() {
  return { exists: exists(), unlocked: isUnlocked(), logins: logins(), file: file() };
}

module.exports = { create, unlock, lock, isUnlocked, get, set, remove, changePassword, destroy, status, exists, logins, VaultError, MIN_PASSWORD };
