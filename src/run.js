const { spawn } = require('node:child_process');

// Runs a command without a shell and collects its output.
// Rejects with the command's stderr when the exit code isn't in allowCodes.
// `buffer: true` returns stdout as a Buffer (images, binary blobs);
// `onStderr` sees stderr as it arrives (git progress).
function run(cmd, args, { cwd, env, input, allowCodes = [0], buffer = false, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    const out = [];
    let stderr = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderr += d;
      onStderr?.(d);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const raw = Buffer.concat(out);
      const stdout = buffer ? raw : raw.toString('utf8');
      if (allowCodes.includes(code)) {
        resolve({ stdout, stderr, code });
        return;
      }
      const text = (stderr || raw.toString('utf8')).trim();
      const err = new Error(text || `${cmd} saiu com código ${code}`);
      err.exitCode = code;
      err.output = text;
      reject(err);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
  });
}

module.exports = { run };
