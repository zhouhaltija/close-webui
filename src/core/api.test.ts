import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => vi.unstubAllGlobals());

it('reports an unreachable service in Chinese', async () => {
  vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
  await expect(api.list()).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: '无法连接服务，请稍后重试。' });
});

it('reports an HTML fallback as an invalid API response in Chinese', async () => {
  vi.stubGlobal('fetch', async () => new Response('<!doctype html><html></html>', { headers: { 'Content-Type': 'text/html' } }));
  await expect(api.list()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', message: '服务返回的数据格式无效，请重试。' });
});

it('preserves service error feedback', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ error: { code: 'UNAVAILABLE', message: '服务暂时不可用。' } }, { status: 503 }));
  await expect(api.create('标题')).rejects.toMatchObject({ status: 503, code: 'UNAVAILABLE', message: '服务暂时不可用。' });
});

it('keeps cancellation distinct from a network failure', async () => {
  const controller = new AbortController(); controller.abort();
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { init.signal?.throwIfAborted(); });
  await expect(api.create('标题', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
});
