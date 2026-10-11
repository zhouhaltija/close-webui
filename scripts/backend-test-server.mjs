import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cached = resolve(root, '.cache/toolchain/go/bin', process.platform === 'win32' ? 'go.exe' : 'go');
const go = existsSync(cached) ? cached : 'go';
const env = { ...process.env, GOCACHE: resolve(root, '.cache/go-build'), GOPATH: resolve(root, '.cache/go-path'), GOMODCACHE: resolve(root, '.cache/go-mod') };
function run(command, args, extraEnv = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: root, env: { ...env, ...extraEnv }, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(new Error(`Test service preparation failed (${code})`)));
  });
}
await run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', '.test-dist/backend'], { VITE_ENABLE_MOCK: 'false', VITE_API_BASE_URL: '/api' });
const binary = resolve(root, '.cache/bin', process.platform === 'win32' ? 'closewebui-testserver.exe' : 'closewebui-testserver');
await run(go, ['-C', 'server', 'build', '-o', binary, './cmd/testserver']);
const child = spawn(binary, [], { cwd: resolve(root, 'server'), env, stdio: 'inherit', windowsHide: true });
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  try { await fetch('http://127.0.0.1:4175/__test/shutdown', { method: 'POST', signal: AbortSignal.timeout(5000) }); } catch { child.kill(); }
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
