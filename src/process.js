import { spawn } from 'node:child_process';

// Windows packaged tools can fork worker processes. Killing only the launcher
// leaves an orphan downloading after the UI says "cancelled".
export function spawnManaged(command, args, options = {}) {
  const { signal, ...rest } = options;
  signal?.throwIfAborted();
  const child = spawn(command, args, rest);
  const abort = () => {
    if (!child.pid || child.exitCode !== null) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child.kill());
    } else child.kill('SIGTERM');
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  child.once('close', () => signal?.removeEventListener('abort', abort));
  child.once('error', () => signal?.removeEventListener('abort', abort));
  return child;
}
