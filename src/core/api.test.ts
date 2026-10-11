import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';
import { accountApi, invalidateSessionRequests } from './api';

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

it('authenticates with same-origin cookies and keeps provider key updates private', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { requests.push({ url, init }); return Response.json({ id: 'u1', username: 'demo' }); });
  await accountApi.login('demo', 'test-password');
  await accountApi.saveProvider({ name: '私有供应商', protocol: 'openai-chat', adapter: 'standard', baseUrl: 'https://example.com/v1', enabled: true, templateId: 'custom' }, 'p1');
  expect(requests[0]).toMatchObject({ url: '/api/auth/login', init: { credentials: 'same-origin', method: 'POST', body: '{"username":"demo","password":"test-password"}' } });
  expect(JSON.parse(requests[1].init.body as string)).not.toHaveProperty('apiKey');
});

it('announces unauthorized protected responses so private UI is cleared', async () => {
  let expired = false; const listener = () => { expired = true; };
  window.addEventListener('closewebui:unauthorized', listener);
  vi.stubGlobal('fetch', async () => Response.json({ error: { code: 'UNAUTHORIZED', message: '请重新登录。' } }, { status: 401 }));
  try { await expect(api.list()).rejects.toMatchObject({ status: 401 }); expect(expired).toBe(true); }
  finally { window.removeEventListener('closewebui:unauthorized', listener); }
});

it('does not expire a newer identity when an old request returns a delayed 401', async () => {
  let resolve!: (value: Response) => void; let expired = 0; const listener = () => { expired++; };
  window.addEventListener('closewebui:unauthorized', listener);
  vi.stubGlobal('fetch', () => new Promise<Response>(done => { resolve = done; }));
  const pending = api.list(); invalidateSessionRequests();
  resolve(Response.json({ error: { code: 'UNAUTHORIZED', message: '旧会话失效。' } }, { status: 401 }));
  try { await expect(pending).rejects.toMatchObject({ status: 401 }); expect(expired).toBe(0); }
  finally { window.removeEventListener('closewebui:unauthorized', listener); }
});
