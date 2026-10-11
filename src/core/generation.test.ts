import { expect, it } from 'vitest';
import type { ChatApi } from './api';
import type { Conversation, GenerationInput, Message } from './types';
import { GenerationCoordinator, type GenerationDependencies, type SubmissionPreview } from './generation';

function harness() {
  let c: Conversation = { id: 'chat', title: '测试', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', messages: [] };
  let stream!: ReadableStreamDefaultController<Uint8Array>; let creates = 0; const published: Conversation[] = []; const previews: (SubmissionPreview | undefined)[] = []; const errors: string[] = []; const busy: boolean[] = []; const navigated: string[] = []; const accepted: string[] = []; const loads: string[] = [];
  const api: ChatApi = {
    list: async () => [], create: async () => { creates++; return structuredClone(c); }, get: async () => structuredClone(c), rename: async () => c, remove: async () => {},
    generate: async (_id: string, input: GenerationInput) => {
      if (!input.retry) c.messages.push({ id: input.userMessageId, conversationId: c.id, role: 'user', content: input.content, status: 'completed', createdAt: c.createdAt }, { id: input.assistantMessageId, conversationId: c.id, role: 'assistant', content: '', status: 'pending', createdAt: c.createdAt });
      else { c.messages[1].content = ''; c.messages[1].status = 'pending'; }
      return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
    },
  };
  const deps: GenerationDependencies = { api, publish: v => published.push(v), preview: v => previews.push(v), busy: v => busy.push(v), accepted: v => accepted.push(v), error: v => errors.push(v), navigate: v => navigated.push(v), load: id => { loads.push(id); return undefined; } };
  return { deps, api, published, previews, errors, busy, navigated, accepted, loads, creates: () => creates, replace: (value: Conversation) => { c = value; }, event: (e: object) => stream.enqueue(new TextEncoder().encode(`${JSON.stringify(e)}\n`)), close: () => stream.close() };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 40));
const previewMessages = (h: ReturnType<typeof harness>) => h.previews.filter(Boolean).at(-1)!.messages;

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

it('shows the submitted message and a submitting placeholder before the conversation exists', async () => {
  const h = harness(); let resolveCreate!: (c: Conversation) => void; h.api.create = () => new Promise<Conversation>(done => { resolveCreate = done; });
  const g = new GenerationCoordinator(h.deps); const pending = g.send('你好');
  expect(h.previews.at(-1)).toMatchObject({ conversationId: undefined, phase: 'submitting' });
  expect(previewMessages(h).map(m => [m.role, m.content, m.status, m.phase])).toEqual([['user', '你好', 'completed', undefined], ['assistant', '', 'pending', 'submitting']]);
  expect(h.navigated).toEqual([]);
  resolveCreate({ id: 'new-chat', title: '你好', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', messages: [] });
  await flush();
  expect(h.navigated).toEqual(['new-chat']);
  expect(h.published.at(-1)!.messages.map(m => [m.role, m.id])).toEqual([['user', previewMessages(h)[0].id], ['assistant', previewMessages(h)[1].id]]);
  expect(h.previews.at(-1)).toMatchObject({ conversationId: 'new-chat', phase: 'awaiting' });
  h.close(); await pending;
  expect(h.published.filter(c => c.messages.filter(m => m.role === 'user').length > 1).length).toBe(0);
  expect(h.previews.at(-1)).toBeUndefined();
});

it('marks the placeholder as awaiting the model once the submission is accepted', async () => {
  const h = harness(); const g = new GenerationCoordinator(h.deps); const pending = g.send('你好'); await flush();
  expect(h.previews.at(-1)).toMatchObject({ conversationId: 'chat', phase: 'awaiting' });
  const assistant = h.published.at(-1)!.messages[1];
  expect(assistant.phase).toBe('awaiting');
  expect(assistant.content).toBe('');
  h.event({ type: 'delta', assistantMessageId: assistant.id, content: '第' }); h.event({ type: 'done', assistantMessageId: assistant.id }); await pending;
  expect(h.published.at(-1)!.messages[1]).toMatchObject({ status: 'completed', content: '第', phase: undefined });
});

it('restores the draft and keeps the placeholder failed when the submission is rejected', async () => {
  const h = harness(); h.api.generate = async () => { throw new Error('模型已停用'); }; const g = new GenerationCoordinator(h.deps); await g.send('你好');
  expect(h.errors.at(-1)).toBe('模型已停用');
  const messages = previewMessages(h);
  expect(messages[1]).toMatchObject({ status: 'failed', error: { message: '模型已停用' } });
  expect(messages[0]).toMatchObject({ role: 'user', content: '你好' });
});

it('reconciles an uncertain submission against the stored conversation instead of duplicating it', async () => {
  const h = harness(); const stored: Message[] = [];
  h.api.generate = async (_id, input) => {
    stored.push({ id: input.userMessageId, conversationId: 'chat', role: 'user', content: input.content, status: 'completed', createdAt: '2026-10-10T00:00:00Z' });
    stored.push({ id: input.assistantMessageId, conversationId: 'chat', role: 'assistant', content: '已保存', status: 'completed', createdAt: '2026-10-10T00:00:00Z' });
    throw new Error('无法连接服务，请稍后重试。');
  };
  h.api.get = async () => ({ id: 'chat', title: '你好', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', messages: structuredClone(stored) });
  const g = new GenerationCoordinator(h.deps); await g.send('你好');
  expect(h.published.at(-1)!.messages.map(m => [m.role, m.content, m.status])).toEqual([['user', '你好', 'completed'], ['assistant', '已保存', 'completed']]);
  expect(h.previews.at(-1)).toBeUndefined();
  expect(h.published.filter(c => c.messages.filter(m => m.role === 'user').length > 1).length).toBe(0);
  expect(h.published.at(-1)!.messages.filter(m => m.role === 'user').length).toBe(1);
});

it('stops before the create returns without navigating or resurrecting the preview', async () => {
  const h = harness(); let resolveCreate!: (c: Conversation) => void; h.api.create = () => new Promise<Conversation>(done => { resolveCreate = done; });
  const g = new GenerationCoordinator(h.deps); const pending = g.send('你好'); g.stop();
  resolveCreate({ id: 'late', title: '你好', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', messages: [] });
  await pending;
  expect(h.navigated).toEqual([]); expect(h.previews.at(-1)).toBeUndefined();
  expect(h.published.length).toBe(0); expect(h.busy.at(-1)).toBe(false);
});

it('reuses an already loaded conversation instead of fetching it again', async () => {
  const h = harness(); const loaded: Conversation = { id: 'chat', title: '已加载', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', messages: [{ id: 'older', conversationId: 'chat', role: 'user', content: '旧', status: 'completed', createdAt: '2026-10-10T00:00:00Z' }] };
  h.deps.load = id => { h.loads.push(id); return structuredClone(loaded); };
  const g = new GenerationCoordinator(h.deps); const pending = g.send('你好', 'chat'); await flush();
  expect(h.loads).toEqual(['chat']);
  expect(h.published.at(-1)!.messages.map(m => m.content)).toEqual(['旧', '你好', '']);
  h.close(); await pending;
});

it('keeps references to unchanged messages while streaming so only the active answer re-renders', async () => {
  const h = harness(); const g = new GenerationCoordinator(h.deps); const pending = g.send('你好'); await flush();
  const before = h.published.at(-1)!;
  const userReference = before.messages[0];
  const assistant = before.messages[1];
  h.event({ type: 'delta', assistantMessageId: assistant.id, content: '甲' });
  await flush();
  const after = h.published.at(-1)!;
  expect(after.messages[0]).toBe(userReference);
  expect(after.messages[1]).not.toBe(assistant);
  expect(after.messages[1].content).toBe('甲');
  h.event({ type: 'done', assistantMessageId: assistant.id }); await pending;
});

it('does not move the conversation to the top of the sidebar on every delta', async () => {
  const h = harness(); const g = new GenerationCoordinator(h.deps); const pending = g.send('你好'); await flush();
  const stamps = new Set(h.published.map(c => c.updatedAt));
  const assistant = h.published.at(-1)!.messages[1];
  for (const piece of ['甲', '乙', '丙']) h.event({ type: 'delta', assistantMessageId: assistant.id, content: piece });
  await flush();
  expect(new Set(h.published.slice(2).map(c => c.updatedAt)).size).toBeLessThanOrEqual(1);
  h.event({ type: 'done', assistantMessageId: assistant.id }); await pending;
  expect(stamps.size).toBeGreaterThan(0);
});
