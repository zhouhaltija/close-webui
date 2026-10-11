import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cachedGo = resolve(root, '.cache/toolchain/go/bin', process.platform === 'win32' ? 'go.exe' : 'go');
const go = existsSync(cachedGo) ? cachedGo : 'go';
const operation = process.argv[2] || 'dev';
const binaryName = process.platform === 'win32' ? 'closewebui-server.exe' : 'closewebui-server';
const commands = { dev: ['run', './cmd/server'], migrate: ['run', './cmd/server', '-migrate', 'up'], rollback: ['run', './cmd/server', '-migrate', 'down'], test: ['test', './...'], vet: ['vet', './...'], build: ['build', '-o', `../.cache/bin/${binaryName}`, './cmd/server'] };
if (!(operation in commands)) throw new Error(`Unknown backend operation: ${operation}`);
if (operation === 'build') await new Promise((accept, reject) => {
  const frontend = spawn(process.execPath, ['scripts/frontend.mjs', 'build'], { cwd: root, stdio: 'inherit', windowsHide: true });
  frontend.once('error', reject);
  frontend.once('exit', code => code === 0 ? accept() : reject(new Error('Real frontend build failed')));
});
const child = spawn(go, ['-C', 'server', ...commands[operation]], { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, GOCACHE: resolve(root, '.cache/go-build'), GOPATH: resolve(root, '.cache/go-path'), GOMODCACHE: resolve(root, '.cache/go-mod') } });
child.on('error', error => { console.error(`Go runtime unavailable: ${error.message}`); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
