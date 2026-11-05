import { spawn } from 'node:child_process';

// Keep the parent event loop available to the loopback fake Admin server.
export function spawnRunner(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`Runner timed out after ${options.timeout}ms`));
      resolve({ stdout, stderr, status, signal });
    });
  });
}
