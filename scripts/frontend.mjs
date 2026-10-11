import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const operation = process.argv[2] || 'dev';
if (!['dev', 'build'].includes(operation)) throw new Error('Frontend operation must be dev or build');
function run(args) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: 'inherit', env: { ...process.env, VITE_ENABLE_MOCK: 'false', VITE_API_BASE_URL: '/api' } });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(new Error(`Frontend command failed (${code})`)));
  });
}
if (operation === 'build') await run(['node_modules/typescript/bin/tsc', '-b']);
await run(['node_modules/vite/bin/vite.js', operation === 'dev' ? '--host' : 'build', ...(operation === 'dev' ? ['localhost'] : [])]);
