import { expect, it } from 'vitest';
import type { ChatApi } from './api';
import type { Conversation, GenerationInput } from './types';
import { GenerationCoordinator, type GenerationDependencies } from './generation';

function harness() {
  let c: Conversation = { id: 'chat', title: '测试', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', messages: [] };
  let stream!: ReadableStreamDefaultController<Uint8Array>; let creates = 0; const published: Conversation[] = []; const errors: string[] = []; const busy: boolean[] = []; const navigated: string[] = []; const accepted: string[] = [];
  const api: ChatApi = {
    list: async () => [], create: async () => { creates++; return structuredClone(c); }, get: async () => structuredClone(c), rename: async () => c, remove: async () => {},
    generate: async (_id: string, input: GenerationInput) => {
      if (!input.retry) c.messages.push({ id: input.userMessageId, conversationId: c.id, role: 'user', content: input.content, status: 'completed', createdAt: c.createdAt }, { id: input.assistantMessageId, conversationId: c.id, role: 'assistant', content: '', status: 'pending', createdAt: c.createdAt });
      else { c.messages[1].content = ''; c.messages[1].status = 'pending'; }
      return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
    },
  };
  const deps: GenerationDependencies = { api, publish: v => published.push(structuredClone(v)), busy: v => busy.push(v), accepted: v => accepted.push(v), error: v => errors.push(v), navigate: v => navigated.push(v) };
  return { deps, api, published, errors, busy, navigated, accepted, creates: () => creates, replace: (value: Conversation) => { c = value; }, event: (e: object) => stream.enqueue(new TextEncoder().encode(`${JSON.stringify(e)}\n`)), close: () => stream.close() };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
it('locks before creating, publishes one user message and completes streamed output', async () => {
  const h = harness(); const g = new GenerationCoordinator(h.deps); const pending = g.send('你好'); expect(await g.send('重复')).toBe(false); await flush();
  expect(h.creates()).toBe(1); expect(h.navigated).toEqual(['chat']); expect(h.accepted).toEqual(['chat']);
  const id = h.published.at(-1)!.messages[1].id;
  h.event({ type: 'delta', assistantMessageId: id, content: '回答' }); h.event({ type: 'done', assistantMessageId: id }); await pending;
  expect(h.published.at(-1)!.messages.map(m => m.content)).toEqual(['你好', '回答']); expect(h.published.at(-1)!.messages[1].status).toBe('completed'); expect(h.busy).toEqual([true, false]);
});
it('stops before the first delta, retains the answer and releases the slot', async () => {
  const h = harness(); const g = new GenerationCoordinator(h.deps); const pending = g.send('你好'); await flush(); g.stop(); await pending;
  expect(h.published.at(-1)!.messages[1]).toMatchObject({ status: 'stopped', content: '' }); expect(h.busy.at(-1)).toBe(false);
});
it('keeps pre-acceptance errors separate from submitted messages', async () => {
  const h = harness(); h.api.generate = async () => { throw new Error('提交失败'); }; const g = new GenerationCoordinator(h.deps); await g.send('你好');
  expect(h.accepted).toEqual([]); expect(h.errors.at(-1)).toBe('提交失败'); expect(h.busy.at(-1)).toBe(false);
});

it('a cancelled old create cannot navigate or release a newer generation slot', async () => {
  const h = harness(); const create = h.api.create; let resolve!: (c: Conversation) => void;
  h.api.create = () => new Promise<Conversation>(done => { resolve = done; });
  const g = new GenerationCoordinator(h.deps); const old = g.send('旧请求'); g.stop(); h.api.create = create;
  const latest = g.send('新请求'); await flush(); resolve({ id: 'old', title: '旧请求', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', messages: [] }); await old;
  expect(h.navigated).toEqual(['chat']); expect(h.busy.at(-1)).toBe(true);
  const id = h.published.at(-1)!.messages[1].id; h.event({ type: 'done', assistantMessageId: id }); await latest;
  expect(h.busy.at(-1)).toBe(false);
});

it('snapshots the model and reasoning and assigns a fresh generation ID when retrying', async () => {
  const h = harness(); const inputs: GenerationInput[] = []; const original = h.api.generate;
  h.api.generate = async (id, input, signal) => { inputs.push(structuredClone(input)); return original(id, input, signal); };
  const g = new GenerationCoordinator(h.deps);
  const pending = g.send('问题', 'chat', undefined, { modelId: 'model-a', reasoning: { effort: 'high' } }); await flush();
  const answer = h.published.at(-1)!.messages[1];
  h.event({ type: 'error', assistantMessageId: answer.id, code: 'UPSTREAM', message: '失败' }); await pending;
  expect(answer).toMatchObject({ modelId: 'model-a', reasoning: { effort: 'high' }, generationId: expect.any(String) });
  h.replace(h.published.at(-1)!);
  const retry = g.send('问题', 'chat', { ...inputs[0], retry: true }, { modelId: 'model-b', reasoning: { effort: 'low' } }); await flush();
  h.event({ type: 'done', assistantMessageId: answer.id }); await retry;
  expect(inputs[1]).toMatchObject({ modelId: 'model-a', reasoning: { effort: 'high' }, retry: true });
  expect(inputs[1].generationId).not.toBe(inputs[0].generationId);
});

it('sends an explicit stop before the generation response is accepted', async () => {
  const h = harness(); let stopped: string[] = [];
  h.api.generate = (_id, _input, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  h.api.stop = async (id, generationId) => { stopped = [id, generationId]; };
  const g = new GenerationCoordinator(h.deps); const pending = g.send('问题', 'chat', undefined, { modelId: 'model-a' }); await flush();
  g.stop(); await pending;
  expect(stopped[0]).toBe('chat'); expect(stopped[1]).toMatch(/^[0-9a-f-]{36}$/);
  expect(h.accepted).toEqual([]);
});
