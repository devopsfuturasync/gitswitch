const { spawn } = require('node:child_process');

// Runs a command without a shell and collects its output.
// Rejects with the command's stderr when the exit code isn't in allowCodes.
function run(cmd, args, { cwd, env, input, allowCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (allowCodes.includes(code)) {
        resolve({ stdout, stderr, code });
        return;
      }
      const err = new Error((stderr || stdout).trim() || `${cmd} saiu com código ${code}`);
      err.exitCode = code;
      reject(err);
    });
    child.stdin.end(input ?? undefined);
  });
}

module.exports = { run };
