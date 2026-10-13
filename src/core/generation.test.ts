import { expect, it, vi } from 'vitest';
import type { ChatApi } from './api';
import type { Conversation, GenerationInput, Message } from './types';
import { GenerationCoordinator, type GenerationDependencies, type SubmissionPreview } from './generation';
import { ApiError } from './errors';

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

it('releases settled read snapshots while other in-flight reads still protect the terminal answer', async () => {
  const h = harness(); const g = new GenerationCoordinator(h.deps); const pending = g.send('读取问题', 'chat'); await flush();
  const assistant = h.published.at(-1)!.messages[1];
  const first = g.captureSnapshot('chat'); const remaining = g.captureSnapshot('chat');
  const saved: Conversation = { ...h.published.at(-1)!, messages: h.published.at(-1)!.messages.map(message => message.role === 'assistant' ? { ...message, content: '保存前缀', status: 'streaming' } : message) };
  h.event({ type: 'delta', assistantMessageId: assistant.id, content: '页面上的完整正文' });
  h.event({ type: 'done', assistantMessageId: assistant.id }); await pending;
  expect(first(saved).messages[1]).toMatchObject({ content: '页面上的完整正文', status: 'completed' });
  g.releaseSnapshot(first);
  expect(first(saved).messages[1]).toMatchObject({ content: '保存前缀', status: 'streaming' });
  expect(remaining(saved).messages[1]).toMatchObject({ content: '页面上的完整正文', status: 'completed' });
  g.releaseSnapshot(remaining);
  expect(remaining(saved).messages[1]).toMatchObject({ content: '保存前缀', status: 'streaming' });
  const fresh = g.captureSnapshot('chat');
  expect(fresh(saved).messages[1]).toMatchObject({ content: '保存前缀', status: 'streaming' });
  g.releaseSnapshot(fresh);
});

it('stops the original generation before recovering a saved prefix that has no durable terminal state', async () => {
  const h = harness(); const g = new GenerationCoordinator(h.deps); const pending = g.send('保存问题', 'chat', undefined, { modelId: 'm1' }); await flush();
  const assistant = h.published.at(-1)!.messages[1];
  h.event({ type: 'delta', assistantMessageId: assistant.id, content: '已保存前缀与实时尾段' });
  h.event({ type: 'error', assistantMessageId: assistant.id, code: 'SAVE_FAILED', message: '保存失败。' }); await pending;
  let saved = { ...h.published.at(-1)!, messages: h.published.at(-1)!.messages.map(message => message.role === 'assistant' ? { ...message, content: '已保存前缀', status: 'streaming' as const, error: undefined } : message) };
  h.api.get = async () => saved;
  h.api.stop = async () => { throw new Error('无法停止原生成。'); };
  expect(await g.recoverSaved('chat')).toBe(false);
  expect(h.published.at(-1)!.messages[1]).toMatchObject({ status: 'failed', content: '已保存前缀与实时尾段' });
  expect(g.hasSaveFailure('chat')).toBe(true);
  h.api.stop = async (id, generationId) => {
    if (id !== 'chat' || generationId !== assistant.generationId) throw new Error('Incorrect original generation');
    saved = { ...saved, messages: saved.messages.map(message => message.role === 'assistant' ? { ...message, status: 'stopped' as const } : message) };
  };
  expect(await g.recoverSaved('chat')).toBe(true);
  expect(h.published.at(-1)!.messages[1]).toMatchObject({ status: 'stopped', content: '已保存前缀' });
  expect(g.hasSaveFailure('chat')).toBe(false);
});

it('does not let a cancelled recovery response replace a newer recovery of the same generation', async () => {
  const h = harness(); const g = new GenerationCoordinator(h.deps); const pending = g.send('保存问题', 'chat', undefined, { modelId: 'm1' }); await flush();
  const assistant = h.published.at(-1)!.messages[1];
  h.event({ type: 'delta', assistantMessageId: assistant.id, content: '实时尾段' });
  h.event({ type: 'error', assistantMessageId: assistant.id, code: 'SAVE_FAILED', message: '保存失败。' }); await pending;
  h.api.stop = async () => {};
  const reads: ((snapshot: Conversation) => void)[] = [];
  h.api.get = () => new Promise(resolve => { reads.push(resolve); });
  const old = g.recoverSaved('chat'); await flush(); g.stop();
  const latest = g.recoverSaved('chat'); await flush();
  const count = h.published.length;
  const saved: Conversation = { ...h.published.at(-1)!, messages: h.published.at(-1)!.messages.map(message => message.role === 'assistant' ? { ...message, content: '保存前缀', status: 'stopped' } : message) };
  reads[0](saved); expect(await old).toBe(false);
  expect(h.published).toHaveLength(count); expect(g.isActive).toBe(true); expect(h.busy.at(-1)).toBe(true);
  reads[1](saved); expect(await latest).toBe(true);
  expect(h.published.at(-1)!.messages[1].content).toBe('保存前缀');
});

it('retains each failed conversation’s live tail when another conversation also fails to save', async () => {
  const h = harness(); const g = new GenerationCoordinator(h.deps);
  h.api.get = async id => ({ id, title: '测试', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', messages: [] });
  for (const id of ['first', 'second']) {
    const pending = g.send('保存问题', id, undefined, { modelId: 'm1' }); await flush();
    const assistant = h.published.at(-1)!.messages[1];
    h.event({ type: 'delta', assistantMessageId: assistant.id, content: `${id}实时尾段` });
    h.event({ type: 'error', assistantMessageId: assistant.id, code: 'SAVE_FAILED', message: '保存失败。' }); await pending;
  }
  const first = await h.api.get('first');
  expect(g.preserveLive(first).messages[1]?.content).toBe('first实时尾段');
  expect(g.hasSaveFailure('first')).toBe(true);
  const second = await h.api.get('second');
  expect(g.preserveLive(second).messages[1].content).toBe('second实时尾段');
  g.conversationRemoved('first');
  expect(g.preserveLive(first).messages).toEqual([]);
  expect(g.hasSaveFailure('second')).toBe(true);
});

it('rolls back a rejected unsaved pair before loading the cache for another send', async () => {
  const h = harness(); let cached: Conversation = { id: 'chat', title: '已保存', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', messages: [] };
  h.deps.load = () => cached; h.deps.publish = c => { cached = c; h.published.push(c); };
  const generate = h.api.generate;
  h.api.generate = async () => { throw new ApiError('MODEL_DISABLED', '模型已停用。', 400); };
  const g = new GenerationCoordinator(h.deps); expect(await g.send('未保存问题', 'chat')).toBe(false);
  expect(cached.messages).toEqual([]); expect(h.previews.at(-1)).toBeUndefined();
  h.api.generate = generate;
  const second = g.send('第二个问题', 'chat'); await flush();
  expect(cached.messages.map(m => m.content)).toEqual(['第二个问题', '']);
  h.event({ type: 'done', assistantMessageId: cached.messages[1].id }); await second;
  expect(cached.messages).toHaveLength(2);
});

it.each(['pending', 'streaming'] as const)('confirms cancellation when uncertain submission reconciliation finds a %s answer', async status => {
  const h = harness(); let submitted!: GenerationInput; let cancelled = false; const stopped: string[][] = [];
  h.api.generate = async (_id, input) => { submitted = input; throw new ApiError('NETWORK_ERROR', '连接断开。', 0); };
  h.api.get = async () => ({ id: 'chat', title: '问题', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', messages: submitted ? [
    { id: submitted.userMessageId, conversationId: 'chat', role: 'user', content: '问题', status: 'completed', createdAt: '2026-10-10T00:00:00Z' },
    { id: submitted.assistantMessageId, conversationId: 'chat', role: 'assistant', content: '已保存', status: cancelled ? 'stopped' : status, generationId: submitted.generationId, createdAt: '2026-10-10T00:00:00Z' },
  ] : [] });
  h.api.stop = async (id, generationId) => { stopped.push([id, generationId]); cancelled = true; };
  const g = new GenerationCoordinator(h.deps); await g.send('问题', 'chat', undefined, { modelId: 'm1' });
  expect(stopped).toEqual([['chat', submitted.generationId]]);
  expect(h.published.at(-1)!.messages[1]).toMatchObject({ status: 'stopped', content: '已保存' });
  expect(g.hasUncertainSubmission).toBe(false);
});

it('blocks ordinary resend until an offline uncertain submission can be reconciled by its original IDs', async () => {
  const h = harness(); let submitted!: GenerationInput;
  h.api.generate = async (_id, input) => { submitted = input; throw new ApiError('NETWORK_ERROR', '连接断开。', 0); };
  h.api.stop = async () => { throw new Error('仍然离线。'); };
  const g = new GenerationCoordinator(h.deps); h.deps.load = () => ({ id: 'chat', title: '问题', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', messages: [] });
  h.api.get = async () => { throw new Error('仍然离线。'); };
  await g.send('问题', 'chat', undefined, { modelId: 'm1' });
  expect(g.hasUncertainSubmission).toBe(true);
  expect(await g.send('问题', 'chat')).toBe(false);
  expect(h.accepted).toEqual([]);
  h.api.get = async () => ({ id: 'chat', title: '问题', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', messages: [
    { id: submitted.userMessageId, conversationId: 'chat', role: 'user', content: '问题', status: 'completed', createdAt: '2026-10-10T00:00:00Z' },
    { id: submitted.assistantMessageId, conversationId: 'chat', role: 'assistant', content: '最终保存', status: 'completed', generationId: submitted.generationId, createdAt: '2026-10-10T00:00:00Z' },
  ] });
  expect(await g.reconcile()).toBe(true);
  expect(g.hasUncertainSubmission).toBe(false);
  expect(h.published.at(-1)!.messages.map(m => m.content)).toEqual(['问题', '最终保存']);
  expect(h.accepted).toEqual(['chat']);
});

it('does not trust a missing pair read before cancellation when the confirming read fails', async () => {
  const h = harness(); let reads = 0;
  h.deps.load = () => ({ id: 'chat', title: '问题', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', messages: [] });
  h.api.generate = async () => { throw new ApiError('NETWORK_ERROR', '连接断开。', 0); };
  h.api.get = async () => { if (++reads > 1) throw new Error('确认读取失败。'); return h.deps.load!('chat')!; };
  h.api.stop = async () => {};
  const g = new GenerationCoordinator(h.deps); await g.send('问题', 'chat', undefined, { modelId: 'm1' });
  expect(g.hasUncertainSubmission).toBe(true);
  expect(await g.send('问题', 'chat')).toBe(false);
  expect(h.accepted).toEqual([]);
});

it('does not accept the previous generation snapshot as confirmation of an uncertain retry', async () => {
  const h = harness(); let submitted!: GenerationInput; const cancelled: string[] = [];
  const previous: Conversation = { id: 'chat', title: '重试', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', messages: [
    { id: 'user', conversationId: 'chat', role: 'user', content: '问题', status: 'completed', createdAt: '2026-10-10T00:00:00Z' },
    { id: 'answer', conversationId: 'chat', role: 'assistant', content: '原失败正文', status: 'failed', generationId: 'previous-generation', modelId: 'm1', createdAt: '2026-10-10T00:00:00Z' },
  ] };
  h.deps.load = () => previous; h.api.get = async () => previous;
  h.api.generate = async (_id, input) => { submitted = input; throw new ApiError('NETWORK_ERROR', '连接断开。', 0); };
  h.api.stop = async (_id, generationId) => { cancelled.push(generationId); };
  const g = new GenerationCoordinator(h.deps);
  await g.send('问题', 'chat', { userMessageId: 'user', assistantMessageId: 'answer', content: '问题', retry: true, modelId: 'm1' });
  expect(cancelled).toEqual([submitted.generationId]);
  expect(h.accepted).toEqual([]);
  expect(h.published.at(-1)!.messages[1]).toMatchObject({ status: 'failed', content: '原失败正文', generationId: 'previous-generation' });
  expect(g.hasUncertainSubmission).toBe(false);
});

it('does not publish a late manual reconciliation after stopping it', async () => {
  const h = harness(); let submitted!: GenerationInput; let resolveRead!: (snapshot: Conversation) => void;
  const saved: Conversation = { id: 'chat', title: '问题', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', messages: [] };
  h.deps.load = () => saved;
  h.api.generate = async (_id, input) => { submitted = input; throw new ApiError('NETWORK_ERROR', '离线。', 0); };
  h.api.get = async () => { throw new Error('离线。'); }; h.api.stop = async () => { throw new Error('离线。'); };
  const g = new GenerationCoordinator(h.deps); await g.send('问题', 'chat', undefined, { modelId: 'm1' });
  h.api.get = () => new Promise(resolve => { resolveRead = resolve; });
  const reconciliation = g.reconcile(); g.stop(); const count = h.published.length;
  resolveRead({ ...saved, messages: [
    { id: submitted.userMessageId, conversationId: 'chat', role: 'user', content: '问题', status: 'completed', createdAt: saved.createdAt },
    { id: submitted.assistantMessageId, conversationId: 'chat', role: 'assistant', content: '迟到终态', status: 'completed', generationId: submitted.generationId, createdAt: saved.createdAt },
  ] });
  await reconciliation;
  expect(h.published).toHaveLength(count);
  expect(g.hasUncertainSubmission).toBe(true);
  expect(await g.send('问题', 'chat')).toBe(false);
});

it('a stopped reconciliation cannot settle or release a newer reconciliation attempt', async () => {
  const h = harness(); let submitted!: GenerationInput; const reads: ((snapshot: Conversation) => void)[] = [];
  const saved: Conversation = { id: 'chat', title: '问题', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', messages: [] };
  h.deps.load = () => saved;
  h.api.generate = async (_id, input) => { submitted = input; throw new ApiError('NETWORK_ERROR', '离线。', 0); };
  h.api.get = async () => { throw new Error('离线。'); }; h.api.stop = async () => { throw new Error('离线。'); };
  const g = new GenerationCoordinator(h.deps); await g.send('问题', 'chat', undefined, { modelId: 'm1' });
  h.api.get = () => new Promise(resolve => { reads.push(resolve); });
  const first = g.reconcile(); g.stop(); const second = g.reconcile(); const count = h.published.length;
  const snapshot: Conversation = { ...saved, messages: [
    { id: submitted.userMessageId, conversationId: 'chat', role: 'user', content: '问题', status: 'completed', createdAt: saved.createdAt },
    { id: submitted.assistantMessageId, conversationId: 'chat', role: 'assistant', content: '权威终态', status: 'completed', generationId: submitted.generationId, createdAt: saved.createdAt },
  ] };
  reads[0](snapshot); await first;
  expect(h.published).toHaveLength(count); expect(g.isActive).toBe(true); expect(h.busy.at(-1)).toBe(true);
  reads[1](snapshot); expect(await second).toBe(true);
  expect(h.published.at(-1)!.messages[1].content).toBe('权威终态'); expect(g.hasUncertainSubmission).toBe(false);
});

it('a cancelled first reconciliation read cannot settle a later manual reconciliation', async () => {
  const h = harness(); let submitted!: GenerationInput; const reads: ((snapshot: Conversation) => void)[] = [];
  const saved: Conversation = { id: 'chat', title: '问题', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', messages: [] };
  h.deps.load = () => saved; h.api.get = () => new Promise(resolve => { reads.push(resolve); });
  h.api.generate = async (_id, input) => { submitted = input; throw new ApiError('NETWORK_ERROR', '离线。', 0); };
  h.api.stop = async () => { throw new Error('离线。'); };
  const g = new GenerationCoordinator(h.deps); const original = g.send('问题', 'chat', undefined, { modelId: 'm1' }); await flush();
  g.stop(); const manual = g.reconcile(); const count = h.published.length;
  const snapshot: Conversation = { ...saved, messages: [
    { id: submitted.userMessageId, conversationId: 'chat', role: 'user', content: '问题', status: 'completed', createdAt: saved.createdAt },
    { id: submitted.assistantMessageId, conversationId: 'chat', role: 'assistant', content: '权威终态', status: 'completed', generationId: submitted.generationId, createdAt: saved.createdAt },
  ] };
  reads[0](snapshot); await original;
  expect(h.published).toHaveLength(count); expect(g.isActive).toBe(true); expect(h.busy.at(-1)).toBe(true);
  reads[1](snapshot); expect(await manual).toBe(true);
  expect(h.published.at(-1)!.messages[1].content).toBe('权威终态');
});

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
  const h = harness(); h.api.generate = async () => { throw new ApiError('REJECTED', '提交失败', 400); }; const g = new GenerationCoordinator(h.deps); await g.send('你好');
  expect(h.accepted).toEqual([]); expect(h.errors.at(-1)).toBe('提交失败'); expect(h.busy.at(-1)).toBe(false);
});

it('removes unsaved message previews when creating the conversation is rejected', async () => {
  const h = harness(); h.api.create = async () => { throw new Error('服务暂时不可用。'); };
  const g = new GenerationCoordinator(h.deps); expect(await g.send('可恢复输入')).toBe(false);
  expect(h.previews.at(-1)).toBeUndefined();
  expect(h.published).toEqual([]);
  expect(h.accepted).toEqual([]);
  expect(h.errors.at(-1)).toBe('服务暂时不可用。');
});

it('ignores a reconciliation snapshot after the generation has stopped', async () => {
  const h = harness(); let resolveGet!: (c: Conversation) => void; let submitted!: GenerationInput;
  h.api.generate = async (_id, input) => { submitted = input; throw new Error('不确定提交'); };
  h.api.get = () => new Promise(done => { resolveGet = done; });
  const g = new GenerationCoordinator(h.deps); const pending = g.send('问题'); await flush();
  g.stop(); const count = h.published.length;
  resolveGet({ id: 'chat', title: '问题', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', messages: [
    { id: submitted.userMessageId, conversationId: 'chat', role: 'user', content: '问题', status: 'completed', createdAt: '2026-10-10T00:00:00Z' },
    { id: submitted.assistantMessageId, conversationId: 'chat', role: 'assistant', content: '迟到回答', status: 'streaming', createdAt: '2026-10-10T00:00:00Z' },
  ] });
  await pending;
  expect(h.accepted).toEqual([]); expect(h.published).toHaveLength(count);
  expect(h.previews.at(-1)).toBeUndefined();
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
  const generate = h.api.generate; let acceptSubmission!: () => void;
  h.api.generate = (id, input, signal) => new Promise(resolve => { acceptSubmission = () => { void generate(id, input, signal).then(resolve); }; });
  const g = new GenerationCoordinator(h.deps); const pending = g.send('你好');
  expect(h.previews.at(-1)).toMatchObject({ conversationId: undefined, phase: 'submitting' });
  expect(previewMessages(h).map(m => [m.role, m.content, m.status, m.phase])).toEqual([['user', '你好', 'completed', undefined], ['assistant', '', 'pending', 'submitting']]);
  expect(h.navigated).toEqual([]);
  resolveCreate({ id: 'new-chat', title: '你好', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', messages: [] });
  await flush();
  expect(h.navigated).toEqual(['new-chat']);
  expect(h.published.at(-1)!.messages.map(m => [m.role, m.id])).toEqual([['user', previewMessages(h)[0].id], ['assistant', previewMessages(h)[1].id]]);
  expect(h.previews.at(-1)).toMatchObject({ conversationId: 'new-chat', phase: 'submitting' });
  expect(h.published.at(-1)!.messages[1]).toMatchObject({ status: 'pending', phase: 'submitting' });
  expect(h.accepted).toEqual([]);
  acceptSubmission(); await flush();
  expect(h.previews.at(-1)).toMatchObject({ conversationId: 'new-chat', phase: 'awaiting' });
  expect(h.published.at(-1)!.messages[1]).toMatchObject({ status: 'pending', phase: 'awaiting' });
  h.close(); await pending;
  expect(h.published.filter(c => c.messages.filter(m => m.role === 'user').length > 1).length).toBe(0);
  expect(h.previews.at(-1)).toBeUndefined();
});

function controlledFrames() {
  let nextId = 0;
  const pending = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++nextId; pending.set(id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { pending.delete(id); });
  return pending;
}

it('publishes a burst of deltas once per frame and flushes completion without another frame', async () => {
  const frames = controlledFrames();
  try {
    const h = harness(); const g = new GenerationCoordinator(h.deps); const pending = g.send('问题'); await flush();
    const before = h.published.at(-1)!; const count = h.published.length; const assistantId = before.messages[1].id;
    for (const content of ['甲', '乙', '丙']) h.event({ type: 'delta', assistantMessageId: assistantId, content });
    await flush();
    expect(h.published).toHaveLength(count);
    expect(frames.size).toBe(1);
    const [handle, paint] = frames.entries().next().value!; frames.delete(handle); paint(16);
    expect(h.published).toHaveLength(count + 1);
    expect(h.published.at(-1)!.messages[1]).toMatchObject({ status: 'streaming', content: '甲乙丙' });
    expect(h.published.at(-1)!.messages[0]).toBe(before.messages[0]);
    h.event({ type: 'delta', assistantMessageId: assistantId, content: '丁' });
    h.event({ type: 'done', assistantMessageId: assistantId }); await pending;
    expect(h.published.at(-1)!.messages[1]).toMatchObject({ status: 'completed', content: '甲乙丙丁' });
    expect(frames.size).toBe(0);
  } finally { vi.unstubAllGlobals(); }
});

it('cancels an unpublished frame on stop and ignores its late callback', async () => {
  const frames = controlledFrames();
  try {
    const h = harness(); const g = new GenerationCoordinator(h.deps); const pending = g.send('问题'); await flush();
    const assistantId = h.published.at(-1)!.messages[1].id;
    h.event({ type: 'delta', assistantMessageId: assistantId, content: '已确认正文' }); await flush();
    expect(frames.size).toBe(1);
    const paint = frames.values().next().value!;
    g.stop(); const count = h.published.length;
    expect(frames.size).toBe(0);
    expect(h.published.at(-1)!.messages[1]).toMatchObject({ status: 'stopped', content: '已确认正文' });
    paint(16); await pending;
    expect(h.published).toHaveLength(count);
    expect(h.previews.at(-1)).toBeUndefined();
    expect(g.isActive).toBe(false);
  } finally { vi.unstubAllGlobals(); }
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

it('keeps a rejected submission out of saved messages and removes its temporary retry placeholder', async () => {
  const h = harness(); h.api.generate = async () => { throw new ApiError('MODEL_DISABLED', '模型已停用', 400); }; const g = new GenerationCoordinator(h.deps); await g.send('你好');
  expect(h.errors.at(-1)).toBe('模型已停用');
  expect(h.previews.at(-1)).toBeUndefined();
  expect(h.published.at(-1)!.messages).toEqual([]);
  expect(h.accepted).toEqual([]);
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
