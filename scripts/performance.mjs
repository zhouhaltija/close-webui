import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const environmentFile = resolve(root, '.env.backend.local');
if (existsSync(environmentFile)) process.loadEnvFile(environmentFile);
const label = process.argv[2] || 'current';
if (!['current', '29483aa'].includes(label)) throw new Error('Unknown performance revision');
const workspace = label === 'current' ? root : resolve(root, '.cache/performance-baseline');
await mkdir(resolve(root, '.cache'), { recursive: true });
const log = await open(resolve(root, `.cache/performance-${label}.log`), 'w');
const cachedGo = resolve(root, '.cache/toolchain/go/bin', process.platform === 'win32' ? 'go.exe' : 'go');
const child = spawn(existsSync(cachedGo) ? cachedGo : 'go', ['-C', resolve(workspace, 'server'), 'test', './internal/app', '-run', '^TestGenerationStagePerformance$', '-count=1', '-v', '-timeout=30m'], {
  cwd: root, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
  env: { ...process.env, GOCACHE: resolve(root, '.cache/go-build'), GOPATH: resolve(root, '.cache/go-path'), GOMODCACHE: resolve(root, '.cache/go-mod'), RUN_PERFORMANCE: '1', PERF_IMPLEMENTATION: label, PERF_OUTPUT_DIR: process.env.PERF_OUTPUT_DIR || resolve(root, 'test-results/performance-parallel-v2') },
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', async code => { await log.close(); console.log(`Performance ${label} exit ${code}`); process.exitCode = code ?? 1; });
