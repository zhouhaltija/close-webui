// @vitest-environment node
import { setupServer } from 'msw/node';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Repository } from './repository';
import { createHandlers } from './handlers';
import { readEvents } from '../core/stream';
const data = new Map<string, string>();
const repo = new Repository({ getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } });
const server = setupServer(...createHandlers(repo));
beforeAll(() => server.listen({ onUnhandledRequest: 'error' })); afterAll(() => server.close());
it('serves CRUD with validation and missing-record errors', async () => {
  expect(await (await fetch('http://localhost/api/conversations')).json()).toEqual([]);
  const response = await fetch('http://localhost/api/conversations', { method: 'POST', body: JSON.stringify({ title: '标题' }) }); expect(response.status).toBe(201); const c = await response.json();
  expect((await fetch(`http://localhost/api/conversations/${c.id}`)).status).toBe(200);
  expect((await fetch(`http://localhost/api/conversations/${c.id}`, { method: 'PATCH', body: JSON.stringify({ title: ' ' }) })).status).toBe(400);
  expect((await fetch(`http://localhost/api/conversations/${c.id}`, { method: 'DELETE' })).status).toBe(204);
  expect((await fetch(`http://localhost/api/conversations/${c.id}`)).status).toBe(404);
});
it('streams a normal answer and saves its terminal state', async () => {
  const c = repo.create('流式测试');
  const response = await fetch(`http://localhost/api/conversations/${c.id}/generations`, { method: 'POST', body: JSON.stringify({ userMessageId: 'u', assistantMessageId: 'a', content: '你好', retry: false }) });
  const events = []; for await (const e of readEvents(response.body!, 'a')) events.push(e);
  expect(events[0].type).toBe('delta'); expect(events.at(-1)!.type).toBe('done'); expect(repo.get(c.id).messages[1].status).toBe('completed');
}, 15000);
