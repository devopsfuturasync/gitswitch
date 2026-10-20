// Lets the `gitswitch` command and the MCP server use tokens from the vault
// while the app holds it unlocked, the way ssh-agent serves keys: the secret
// stays in one process's memory and others ask for it over a local socket.
//
// The socket is a Unix socket only the user can open (posix) or a named pipe
// (Windows). Every request must also carry a random key that the app writes,
// readable only by the user, into its data folder when the agent starts, so
// nothing that can merely reach the socket gets a token.
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const platform = require('./platform');

const keyFile = () => path.join(platform.dataDir(), 'agent.key');

// One agent per data folder, so a dev copy (GITSWITCH_DATA) and the
// installed app don't fight over the same socket.
function endpoint() {
  const id = crypto.createHash('sha256').update(platform.dataDir()).digest('hex').slice(0, 10);
  if (platform.isWin) {
    const user = (os.userInfo().username || 'user').replace(/[^A-Za-z0-9_.-]/g, '_');
    return `\\\\.\\pipe\\gitswitch-agent-${user}-${id}`;
  }
  // /run/user/<uid> is private to the user and lives in memory; otherwise the
  // data folder. Unix socket paths are limited to ~104 bytes.
  const runtime = process.env.XDG_RUNTIME_DIR;
  return runtime ? path.join(runtime, `gitswitch-agent-${id}.sock`) : path.join(platform.dataDir(), 'agent.sock');
}

// ---------- server (the app) ----------
// handle(request) -> response object; request is { op, login? }.
function serve(handle) {
  const key = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(platform.dataDir(), { recursive: true });
  fs.writeFileSync(keyFile(), key, { mode: 0o600 });
  const where = endpoint();
  if (!platform.isWin) { try { fs.unlinkSync(where); } catch { /* not there */ } }

  const expected = Buffer.from(key);
  const server = net.createServer((socket) => {
    let buf = '';
    socket.setEncoding('utf8');
    socket.setTimeout(150_000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', async (chunk) => {
      buf += chunk;
      if (buf.length > 65_536) { socket.destroy(); return; }
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = '';
      let reply;
      try {
        const req = JSON.parse(line);
        const given = Buffer.from(String(req.key || ''));
        if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) reply = { ok: false, error: 'bad-key' };
        else reply = { ok: true, ...(await handle(req)) };
      } catch (err) {
        reply = { ok: false, error: err.code || 'failed', message: err.message };
      }
      socket.end(`${JSON.stringify(reply)}\n`);
    });
  });
  server.on('error', () => {});
  server.listen(where, () => { if (!platform.isWin) { try { fs.chmodSync(where, 0o600); } catch { /* best effort */ } } });
  return {
    close() {
      server.close();
      try { fs.rmSync(keyFile(), { force: true }); } catch { /* gone */ }
      if (!platform.isWin) { try { fs.unlinkSync(where); } catch { /* gone */ } }
    },
  };
}

// ---------- client (CLI / MCP) ----------
// Resolves the response, or null when no app is listening.
function request(req, timeoutMs = 140_000) {
  let key;
  try { key = fs.readFileSync(keyFile(), 'utf8').trim(); } catch { return Promise.resolve(null); }
  return new Promise((resolve) => {
    const socket = net.connect(endpoint());
    let buf = '';
    let done = false;
    const finish = (value) => { if (!done) { done = true; socket.destroy(); resolve(value); } };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.on('error', () => finish(null));
    socket.on('connect', () => socket.write(`${JSON.stringify({ ...req, key })}\n`));
    socket.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl >= 0) { try { finish(JSON.parse(buf.slice(0, nl))); } catch { finish(null); } }
    });
    socket.on('end', () => finish(null));
  });
}

module.exports = { serve, request, endpoint };
