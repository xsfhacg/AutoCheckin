import { spawn } from 'node:child_process';
import path from 'node:path';

const viteBin = path.join('node_modules', 'vite', 'bin', 'vite.js');
const children = [
  spawn(process.execPath, ['--watch', 'server/index.js'], { stdio: ['ignore', 'inherit', 'inherit'] }),
  spawn(process.execPath, [viteBin, '--host', '0.0.0.0', '--port', '3333', '--strictPort'], {
    stdio: ['ignore', 'inherit', 'inherit']
  })
];

function shutdown(signal) {
  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

for (const child of children) {
  child.on('exit', (code) => {
    if (code && code !== 0) {
      shutdown('SIGTERM');
      process.exit(code);
    }
  });
}
