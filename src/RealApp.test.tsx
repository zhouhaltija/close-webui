import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { GenerationCoordinator } from './core/generation';
import { useUI } from './core/ui-store';
import type { Conversation, GenerationInput, MessageStatus } from './core/types';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); useUI.setState({ drafts: {}, busy: false, error: '', realModelId: null, reasoning: {} }); });
function mount(path = '/', staleTime = Infinity) {
  vi.stubEnv('VITE_ENABLE_MOCK', 'false');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Routes><Route path="/" element={<App />} /><Route path="/chat/:conversationId" element={<App />} /><Route path="/settings/:section" element={<App />} /><Route path="/settings/providers/:providerId" element={<App />} /></Routes></MemoryRouter></QueryClientProvider>);
  return client;
}

function submissionFixture() {
  const now = '2026-10-11T00:00:00Z';
  const conversation: Conversation = { id: 'c1', title: '提交测试', createdAt: now, updatedAt: now, messages: [] };
  const model = { id: 'm1', providerId: 'p1', modelId: 'ordinary-model', name: '测试模型', enabled: true, maxOutputTokens: 4096, defaultReasoning: {}, capabilities: { family: '', efforts: [], supportsToggle: false, mandatory: false, budgetMin: 0, budgetMax: 0, budgetSupported: false, outputMax: 4096, sources: [], known: false } };
  const inputs: GenerationInput[] = [];
  let removed = false;
  let user = { id: 'u1', username: 'test_user' }; let signedOut = false;
  let create = async () => structuredClone(conversation);
  let generate = async (input: GenerationInput) => new Response(`${JSON.stringify({ type: 'done', assistantMessageId: input.assistantMessageId })}\n`);
  let read = async () => structuredClone(conversation);
  let stop: (id: string) => Promise<Response> = async () => new Response(null, { status: 204 });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/auth/me')) return signedOut ? Response.json({ error: { code: 'UNAUTHORIZED', message: '请登录。' } }, { status: 401 }) : Response.json(user);
    if (url.endsWith('/auth/logout')) { signedOut = true; return new Response(null, { status: 204 }); }
    if (url.endsWith('/auth/login')) { user = { id: 'u2', username: JSON.parse(init.body as string).username }; signedOut = false; return Response.json(user); }
    if (url.endsWith('/models')) return Response.json([model]);
    if (url.endsWith('/providers')) return Response.json([{ id: 'p1', name: '测试供应商', templateId: 'custom', protocol: 'openai-chat', adapter: 'standard', baseUrl: 'https://example.com/v1', enabled: true, hasKey: true }]);
    if (url.endsWith('/provider-templates')) return Response.json([]);
    if (url.endsWith('/preferences')) return Response.json({ defaultModelId: 'm1' });
    if (url.endsWith('/generations')) { const input = JSON.parse(init.body as string) as GenerationInput; inputs.push(input); return generate(input); }
    if (url.endsWith('/stop')) return stop(url.split('/').at(-2)!);
    if (url.endsWith('/conversations/c1') && init.method === 'DELETE') { removed = true; return new Response(null, { status: 204 }); }
    if (url.endsWith('/conversations/c1')) return removed ? Response.json({ error: { code: 'NOT_FOUND', message: '对话不存在。' } }, { status: 404 }) : Response.json(await read());
    if (url.endsWith('/conversations') && init.method === 'POST') return Response.json(await create());
    if (url.endsWith('/conversations')) return Response.json(removed || user.id !== 'u1' ? [] : [{ id: conversation.id, title: conversation.title, createdAt: now, updatedAt: now }]);
    throw new Error(`Unexpected test request: ${url}`);
  });
  return {
    conversation, inputs,
    create: (handler: typeof create) => { create = handler; },
    generate: (handler: typeof generate) => { generate = handler; },
    read: (handler: typeof read) => { read = handler; },
    stop: (handler: typeof stop) => { stop = handler; },
    saved: (input: GenerationInput, status: MessageStatus, content: string): Conversation => ({ ...conversation, messages: [
      { id: input.userMessageId, conversationId: conversation.id, role: 'user', content: input.content, status: 'completed', createdAt: now },
      { id: input.assistantMessageId, conversationId: conversation.id, role: 'assistant', content, status, createdAt: now, modelId: input.modelId, generationId: input.generationId, reasoning: input.reasoning },
    ] }),
  };
}

it.each([
  ['pending', 'stopped'],
  ['streaming', 'completed'],
] as const)('refreshes a server-owned %s answer until it becomes %s without stopping it', async (initial, terminal) => {
  const fixture = submissionFixture(); let savedStatus: MessageStatus = initial;
  let reads = 0; const stops: string[] = [];
  const input: GenerationInput = { userMessageId: 'u-old', assistantMessageId: 'a-old', generationId: 'g-old', content: '刷新前的问题', modelId: 'm1', retry: false };
  fixture.read(async () => { reads++; return fixture.saved(input, savedStatus, '数据库确认的前缀'); });
  fixture.stop(async id => { stops.push(id); return new Response(null, { status: 204 }); });
  mount('/chat/c1');
  await waitFor(() => expect(screen.getByTestId('message-assistant')).toHaveAttribute('data-status', initial));
  await waitFor(() => expect(reads).toBeGreaterThan(1), { timeout: 3500 });
  expect(screen.getByTestId('message-assistant')).toHaveAttribute('data-status', initial);
  expect(stops).toEqual([]);
  savedStatus = terminal;
  await waitFor(() => expect(screen.getByTestId('message-assistant')).toHaveAttribute('data-status', terminal), { timeout: 3500 });
  expect(screen.getByRole('button', { name: '复制回答' })).toBeVisible();
  expect(screen.getByTestId('message-assistant')).toHaveTextContent('数据库确认的前缀');
  expect(screen.queryByLabelText('正在生成')).not.toBeInTheDocument();
  const terminalReads = reads;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2200)); });
  expect(reads).toBe(terminalReads);
  expect(stops).toEqual([]);
  expect(fixture.inputs).toEqual([]);
}, 10000);

it('keeps the live answer visible when a refetch returns a shorter saved prefix', async () => {
  const fixture = submissionFixture(); let stream!: ReadableStreamDefaultController<Uint8Array>;
  fixture.generate(async () => new Response(new ReadableStream({ start(controller) { stream = controller; } })));
  const client = mount('/chat/c1'); await screen.findByRole('button', { name: '选择真实模型：测试模型' });
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '流式问题' } }); fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(fixture.inputs).toHaveLength(1));
  const submitted = fixture.inputs[0];
  const emit = (event: object) => stream.enqueue(new TextEncoder().encode(`${JSON.stringify({ assistantMessageId: submitted.assistantMessageId, ...event })}\n`));
  act(() => { emit({ type: 'delta', content: '已保存前缀与实时尾段' }); });
  await screen.findByText('已保存前缀与实时尾段');
  fixture.read(async () => fixture.saved(submitted, 'streaming', '已保存前缀'));
  await act(async () => { await client.refetchQueries({ queryKey: ['conversation', 'c1'] }); });
  expect(client.getQueryData<Conversation>(['conversation', 'c1'])!.messages[1].content).toBe('已保存前缀与实时尾段');
  expect(screen.getByTestId('message-assistant')).toHaveTextContent('已保存前缀与实时尾段');
  expect(screen.getByTestId('message-assistant')).toHaveAttribute('data-status', 'streaming');
  expect(screen.getAllByTestId('message-user')).toHaveLength(1);
  act(() => { emit({ type: 'delta', content: '以及后续正文' }); emit({ type: 'done' }); });
  await waitFor(() => expect(screen.getByTestId('message-assistant')).toHaveAttribute('data-status', 'completed'));
  expect(screen.getByTestId('message-assistant')).toHaveTextContent('已保存前缀与实时尾段以及后续正文');
  fixture.read(async () => fixture.saved(submitted, 'completed', '权威完成正文'));
  await act(async () => { await client.refetchQueries({ queryKey: ['conversation', 'c1'] }); });
  await screen.findByText('权威完成正文');
  expect(screen.getByTestId('message-assistant')).not.toHaveTextContent('实时尾段');
});

it('keeps the submitting pair when the new chat’s initial GET returns an empty saved snapshot', async () => {
  const fixture = submissionFixture(); let resolveRead!: (conversation: Conversation) => void; let accept!: () => void;
  fixture.read(() => new Promise(resolve => { resolveRead = resolve; }));
  fixture.generate(input => new Promise(resolve => { accept = () => resolve(new Response(`${JSON.stringify({ type: 'done', assistantMessageId: input.assistantMessageId })}\n`)); }));
  const client = mount('/', 0); await screen.findByRole('button', { name: '选择真实模型：测试模型' });
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '创建后的问题' } }); fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await screen.findByText('正在提交…'); await waitFor(() => expect(resolveRead).toBeDefined());
  await act(async () => { resolveRead(fixture.conversation); });
  expect(client.getQueryData<Conversation>(['conversation', 'c1'])!.messages.map(message => [message.role, message.content, message.phase])).toEqual([['user', '创建后的问题', undefined], ['assistant', '', 'submitting']]);
  expect(screen.getByTestId('message-user')).toHaveTextContent('创建后的问题');
  expect(screen.queryByText('给这个对话一个起点')).not.toBeInTheDocument();
  await act(async () => { accept(); });
  await waitFor(() => expect(screen.getByTestId('message-assistant')).toHaveAttribute('data-status', 'completed'));
});

it.each(['done', 'stop'] as const)('ignores a shorter GET begun during streaming that returns after %s', async terminal => {
  const fixture = submissionFixture(); let stream!: ReadableStreamDefaultController<Uint8Array>;
  fixture.generate(async () => new Response(new ReadableStream({ start(controller) { stream = controller; } })));
  const client = mount('/chat/c1'); await screen.findByRole('button', { name: '选择真实模型：测试模型' });
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '查询竞态问题' } }); fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(fixture.inputs).toHaveLength(1)); const submitted = fixture.inputs[0];
  const emit = (event: object) => stream.enqueue(new TextEncoder().encode(`${JSON.stringify({ assistantMessageId: submitted.assistantMessageId, ...event })}\n`));
  act(() => { emit({ type: 'delta', content: '前缀' }); }); await screen.findByText('前缀');
  let resolveRead!: (snapshot: Conversation) => void;
  fixture.read(() => new Promise(resolve => { resolveRead = resolve; }));
  const refetch = client.refetchQueries({ queryKey: ['conversation', 'c1'] });
  await waitFor(() => expect(resolveRead).toBeDefined());
  act(() => { emit({ type: 'delta', content: '与后来的尾段' }); }); await screen.findByText('前缀与后来的尾段');
  if (terminal === 'done') act(() => { emit({ type: 'done' }); });
  else fireEvent.click(screen.getByRole('button', { name: '停止生成' }));
  await waitFor(() => expect(screen.getByTestId('message-assistant')).toHaveAttribute('data-status', terminal === 'done' ? 'completed' : 'stopped'));
  await act(async () => { resolveRead(fixture.saved(submitted, 'streaming', '前缀')); await refetch; });
  expect(client.getQueryData<Conversation>(['conversation', 'c1'])!.messages[1]).toMatchObject({ content: '前缀与后来的尾段', status: terminal === 'done' ? 'completed' : 'stopped' });
  expect(screen.getByTestId('message-assistant')).toHaveTextContent('前缀与后来的尾段');
  fixture.read(async () => fixture.saved(submitted, terminal === 'done' ? 'completed' : 'stopped', '新读取的权威正文'));
  await act(async () => { await client.refetchQueries({ queryKey: ['conversation', 'c1'] }); });
  await screen.findByText('新读取的权威正文');
});

it.each(['failure', 'cancel'] as const)('releases the snapshot guard after query %s while preserving later streamed completion', async outcome => {
  const reads: ((snapshot: Conversation) => Conversation)[] = [];
  const capture = GenerationCoordinator.prototype.captureSnapshot;
  const captureSpy = vi.spyOn(GenerationCoordinator.prototype, 'captureSnapshot').mockImplementation(function(this: GenerationCoordinator, id) {
    const read = capture.call(this, id); reads.push(read); return read;
  });
  try {
    const fixture = submissionFixture(); let stream!: ReadableStreamDefaultController<Uint8Array>;
    fixture.generate(async () => new Response(new ReadableStream({ start(controller) { stream = controller; } })));
    const client = mount('/chat/c1'); await screen.findByRole('button', { name: '选择真实模型：测试模型' });
    fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '查询释放问题' } }); fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
    await waitFor(() => expect(fixture.inputs).toHaveLength(1)); const submitted = fixture.inputs[0];
    let resolveRead!: (snapshot: Conversation) => void; let rejectRead!: (error: Error) => void;
    fixture.read(() => new Promise((resolve, reject) => { resolveRead = resolve; rejectRead = reject; }));
    const refetch = client.refetchQueries({ queryKey: ['conversation', 'c1'] });
    await waitFor(() => expect(resolveRead).toBeDefined()); const read = reads.at(-1)!;
    await act(async () => {
      if (outcome === 'failure') rejectRead(new TypeError('offline'));
      else await client.cancelQueries({ queryKey: ['conversation', 'c1'] });
      await refetch;
    });
    act(() => {
      stream.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: 'delta', assistantMessageId: submitted.assistantMessageId, content: '查询结束后的完整正文' })}\n${JSON.stringify({ type: 'done', assistantMessageId: submitted.assistantMessageId })}\n`));
    });
    await waitFor(() => expect(screen.getByTestId('message-assistant')).toHaveAttribute('data-status', 'completed'));
    expect(screen.getByTestId('message-assistant')).toHaveTextContent('查询结束后的完整正文');
    const saved = fixture.saved(submitted, 'stopped', '数据库的保存前缀');
    expect(read(saved).messages[1]).toMatchObject({ content: '数据库的保存前缀', status: 'stopped' });
    if (outcome === 'cancel') await act(async () => { resolveRead(saved); });
    expect(client.getQueryData<Conversation>(['conversation', 'c1'])!.messages[1]).toMatchObject({ content: '查询结束后的完整正文', status: 'completed' });
  } finally { captureSpy.mockRestore(); }
});

it('explains saving failure and keeps the live tail until explicit saved-content recovery', async () => {
  const fixture = submissionFixture(); let stream!: ReadableStreamDefaultController<Uint8Array>;
  fixture.generate(async () => new Response(new ReadableStream({ start(controller) { stream = controller; } })));
  const client = mount('/chat/c1'); await screen.findByRole('button', { name: '选择真实模型：测试模型' });
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '保存故障问题' } }); fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(fixture.inputs).toHaveLength(1));
  const submitted = fixture.inputs[0];
  act(() => {
    stream.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: 'delta', assistantMessageId: submitted.assistantMessageId, content: '已保存前缀与尚未保存尾段' })}\n`));
    stream.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: 'error', assistantMessageId: submitted.assistantMessageId, code: 'SAVE_FAILED', message: '保存失败。' })}\n`));
  });
  await waitFor(() => expect(screen.getByTestId('message-assistant')).toHaveAttribute('data-status', 'failed'));
  expect(screen.getByRole('alert')).toHaveTextContent(/保存失败/);
  expect(screen.getByRole('alert')).toHaveTextContent(/刷新.*已保存/);
  expect(screen.queryByRole('button', { name: '重试回答' })).not.toBeInTheDocument();
  fixture.read(async () => fixture.saved(submitted, 'failed', '已保存前缀'));
  await act(async () => { await client.refetchQueries({ queryKey: ['conversation', 'c1'] }); });
  expect(screen.getByTestId('message-assistant')).toHaveTextContent('已保存前缀与尚未保存尾段');
  fixture.read(async () => { throw new TypeError('offline'); });
  fireEvent.click(screen.getByRole('button', { name: '恢复已保存内容' }));
  await screen.findByText(/无法恢复已保存内容/);
  expect(screen.getByTestId('message-assistant')).toHaveTextContent('已保存前缀与尚未保存尾段');
  fixture.read(async () => fixture.saved(submitted, 'failed', '已保存前缀'));
  fireEvent.click(screen.getByRole('button', { name: '恢复已保存内容' }));
  await waitFor(() => expect(screen.getByTestId('message-assistant')).not.toHaveTextContent('尚未保存尾段'));
  expect(screen.getByTestId('message-assistant')).toHaveTextContent('已保存前缀');
  expect(client.getQueryData<Conversation>(['conversation', 'c1'])!.messages[1].content).toBe('已保存前缀');
  expect(fixture.inputs).toHaveLength(1);
});

it('cancels saved-content recovery without leaving the chat or accepting its delayed snapshot', async () => {
  const fixture = submissionFixture();
  fixture.generate(async input => new Response(`${JSON.stringify({ type: 'delta', assistantMessageId: input.assistantMessageId, content: '仍在页面的实时正文' })}\n${JSON.stringify({ type: 'error', assistantMessageId: input.assistantMessageId, code: 'SAVE_FAILED', message: '保存失败。' })}\n`));
  const client = mount('/chat/c1'); await screen.findByRole('button', { name: '选择真实模型：测试模型' });
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '保存问题' } }); fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await screen.findByRole('button', { name: '恢复已保存内容' });
  let resolveRead!: (conversation: Conversation) => void;
  fixture.read(() => new Promise(resolve => { resolveRead = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: '恢复已保存内容' }));
  fireEvent.click(await screen.findByRole('button', { name: '停止生成' }));
  await act(async () => { resolveRead(fixture.saved(fixture.inputs[0], 'failed', '迟到的保存前缀')); });
  expect(screen.getByRole('heading', { name: '提交测试' })).toBeVisible();
  expect(screen.getByTestId('message-assistant')).toHaveTextContent('仍在页面的实时正文');
  expect(client.getQueryData<Conversation>(['conversation', 'c1'])!.messages[1].content).toBe('仍在页面的实时正文');
  expect(fixture.inputs).toHaveLength(1);
});

it('keeps failed-save text, copying and recovery visible when the saved snapshot cannot be refetched', async () => {
  const fixture = submissionFixture();
  fixture.generate(async input => new Response(`${JSON.stringify({ type: 'delta', assistantMessageId: input.assistantMessageId, content: '故障时仍可复制的正文' })}\n${JSON.stringify({ type: 'error', assistantMessageId: input.assistantMessageId, code: 'SAVE_FAILED', message: '保存失败。' })}\n`));
  const client = mount('/chat/c1'); await screen.findByRole('button', { name: '选择真实模型：测试模型' });
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '数据库故障问题' } }); fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await screen.findByRole('button', { name: '恢复已保存内容' });
  fixture.read(async () => { throw new TypeError('offline'); });
  await act(async () => { await client.refetchQueries({ queryKey: ['conversation', 'c1'] }); });
  expect(client.getQueryState(['conversation', 'c1'])!.status).toBe('error');
  await screen.findByText(/无法加载最新已保存内容/);
  expect(screen.getByTestId('message-assistant')).toHaveTextContent('故障时仍可复制的正文');
  expect(screen.getByRole('button', { name: '复制回答' })).toBeVisible();
  expect(screen.getByRole('button', { name: '恢复已保存内容' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: '无法加载对话' })).not.toBeInTheDocument();
  expect(fixture.inputs).toHaveLength(1);
});

it('removes a rejected submission from the visible history and cache before a second send while keeping a newer draft', async () => {
  const fixture = submissionFixture(); let rejectSubmission!: (response: Response) => void;
  fixture.generate(() => new Promise(resolve => { rejectSubmission = resolve; }));
  const client = mount('/chat/c1'); await screen.findByRole('button', { name: '选择真实模型：测试模型' });
  const input = screen.getByRole('textbox', { name: '输入消息' });
  fireEvent.change(input, { target: { value: '被拒绝的问题' } }); fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await screen.findByText('正在提交…'); fireEvent.change(input, { target: { value: '后来输入的新草稿' } });
  await act(async () => { rejectSubmission(Response.json({ error: { code: 'MODEL_DISABLED', message: '模型已停用。' } }, { status: 400 })); });
  expect(await screen.findByRole('alert')).toHaveTextContent('模型已停用');
  expect(screen.queryByText('正在提交…')).not.toBeInTheDocument();
  expect(screen.queryByTestId('message-user')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '重试回答' })).not.toBeInTheDocument();
  expect(input).toHaveValue('后来输入的新草稿');
  expect(client.getQueryData<Conversation>(['conversation', 'c1'])!.messages).toEqual([]);
  fixture.generate(async input => new Response(`${JSON.stringify({ type: 'done', assistantMessageId: input.assistantMessageId })}\n`));
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(fixture.inputs).toHaveLength(2)); await waitFor(() => expect(useUI.getState().busy).toBe(false));
  expect(screen.getAllByTestId('message-user')).toHaveLength(1);
  expect(screen.getByTestId('message-user')).toHaveTextContent('后来输入的新草稿');
  expect(client.getQueryData<Conversation>(['conversation', 'c1'])!.messages).toHaveLength(2);
});

it('does not clear a newer draft when a delayed submission is accepted', async () => {
  const fixture = submissionFixture(); let accept!: () => void;
  fixture.generate(input => new Promise(resolve => { accept = () => resolve(new Response(`${JSON.stringify({ type: 'done', assistantMessageId: input.assistantMessageId })}\n`)); }));
  mount('/chat/c1'); await screen.findByRole('button', { name: '选择真实模型：测试模型' });
  const input = screen.getByRole('textbox', { name: '输入消息' });
  fireEvent.change(input, { target: { value: '已经发送的问题' } }); fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await screen.findByText('正在提交…'); fireEvent.change(input, { target: { value: '下一条草稿' } });
  await act(async () => { accept(); }); await waitFor(() => expect(useUI.getState().busy).toBe(false));
  expect(input).toHaveValue('下一条草稿');
});

it('keeps the newer pending-route draft when a slow create resolves and the submission is accepted', async () => {
  const fixture = submissionFixture(); let resolveCreate!: (conversation: Conversation) => void;
  fixture.create(() => new Promise(resolve => { resolveCreate = resolve; }));
  mount(); await screen.findByRole('button', { name: '选择真实模型：测试模型' });
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '已发送的首页问题' } }); fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await screen.findByText('正在提交…');
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '等待创建时的新草稿' } });
  await act(async () => { resolveCreate(fixture.conversation); });
  await waitFor(() => expect(fixture.inputs).toHaveLength(1)); await waitFor(() => expect(useUI.getState().busy).toBe(false));
  expect(fixture.inputs[0].content).toBe('已发送的首页问题');
  expect(screen.getByRole('textbox', { name: '输入消息' })).toHaveValue('等待创建时的新草稿');
  expect(useUI.getState().drafts.c1).toBe('等待创建时的新草稿');
});

it('offers reconciliation instead of ordinary resend while an uncertain submission is offline', async () => {
  const fixture = submissionFixture();
  fixture.generate(async () => { fixture.read(async () => { throw new TypeError('offline'); }); throw new TypeError('offline'); });
  fixture.stop(async () => { throw new TypeError('offline'); });
  const client = mount('/chat/c1'); await screen.findByRole('button', { name: '选择真实模型：测试模型' });
  const input = screen.getByRole('textbox', { name: '输入消息' });
  fireEvent.change(input, { target: { value: '结果未知的问题' } }); fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  const check = await screen.findByRole('button', { name: '核对提交状态' });
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: '重试回答' })).not.toBeInTheDocument();
  expect(input).toHaveValue('结果未知的问题');
  expect(fixture.inputs).toHaveLength(1);
  fixture.read(async () => fixture.saved(fixture.inputs[0], 'completed', '对账恢复的回答'));
  fireEvent.click(check); await screen.findByText('对账恢复的回答');
  expect(screen.queryByRole('button', { name: '核对提交状态' })).not.toBeInTheDocument();
  expect(fixture.inputs).toHaveLength(1);
  expect(client.getQueryData<Conversation>(['conversation', 'c1'])!.messages).toHaveLength(2);
});

it('retains the uncertain submission barrier across settings and reconciles the original generation on return', async () => {
  const fixture = submissionFixture(); const stopped: string[] = [];
  fixture.generate(async () => { fixture.read(async () => { throw new TypeError('offline'); }); throw new TypeError('offline'); });
  fixture.stop(async id => { stopped.push(id); throw new TypeError('offline'); });
  const client = mount('/chat/c1'); await screen.findByRole('button', { name: '选择真实模型：测试模型' });
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '尚未核对的问题' } }); fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await screen.findByRole('button', { name: '核对提交状态' });
  fireEvent.keyDown(screen.getByRole('button', { name: '账户菜单：test_user' }), { key: 'Enter' }); fireEvent.click(await screen.findByRole('menuitem', { name: '设置' }));
  fireEvent.click(await screen.findByRole('link', { name: '返回聊天' })); await screen.findByRole('button', { name: '选择真实模型：测试模型' });
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '尚未核对的问题' } });
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  const original = fixture.inputs[0]; let cancelled = false;
  fixture.read(async () => fixture.saved(original, cancelled ? 'stopped' : 'pending', '已保存的原回答'));
  fixture.stop(async id => { stopped.push(id); cancelled = true; return new Response(null, { status: 204 }); });
  fireEvent.click(screen.getByRole('button', { name: '核对提交状态' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '核对提交状态' })).not.toBeInTheDocument());
  expect(stopped.at(-1)).toBe(original.generationId);
  expect(fixture.inputs).toHaveLength(1);
  expect(client.getQueryData<Conversation>(['conversation', 'c1'])!.messages[1]).toMatchObject({ generationId: original.generationId, status: 'stopped', content: '已保存的原回答' });
  fireEvent.click(screen.getByRole('button', { name: '提交测试' })); await screen.findByText('已保存的原回答');
  fireEvent.click(screen.getByRole('button', { name: '新对话' }));
  fixture.create(async () => ({ ...fixture.conversation, id: 'c2' }));
  fixture.generate(async input => new Response(`${JSON.stringify({ type: 'done', assistantMessageId: input.assistantMessageId })}\n`));
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '核对后的新问题' } }); fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(client.getQueryData<Conversation>(['conversation', 'c2'])?.messages[1].status).toBe('completed'));
  expect(await screen.findByTestId('message-user')).toHaveTextContent('核对后的新问题');
});

it('retains the original IDs when leaving chat during the first uncertain reconciliation read', async () => {
  const fixture = submissionFixture(); let resolveRead!: (conversation: Conversation) => void;
  fixture.generate(async () => { fixture.read(() => new Promise(resolve => { resolveRead = resolve; })); throw new TypeError('offline'); });
  fixture.stop(async () => { throw new TypeError('offline'); });
  mount('/chat/c1'); await screen.findByRole('button', { name: '选择真实模型：测试模型' });
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '尚在核对的问题' } }); fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(resolveRead).toBeDefined());
  fireEvent.keyDown(screen.getByRole('button', { name: '账户菜单：test_user' }), { key: 'Enter' }); fireEvent.click(await screen.findByRole('menuitem', { name: '设置' }));
  fireEvent.click(await screen.findByRole('link', { name: '返回聊天' })); await screen.findByRole('button', { name: '选择真实模型：测试模型' });
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '尚在核对的问题' } });
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '核对提交状态' })).toBeVisible();
  await act(async () => { resolveRead(fixture.saved(fixture.inputs[0], 'completed', '被取消读取的迟到结果')); });
  expect(screen.getByRole('button', { name: '核对提交状态' })).toBeVisible();
  expect(fixture.inputs).toHaveLength(1);
});

it('clears the previous user’s uncertain submission when signing out from settings', async () => {
  const fixture = submissionFixture();
  fixture.generate(async () => { fixture.read(async () => { throw new TypeError('offline'); }); throw new TypeError('offline'); });
  fixture.stop(async () => { throw new TypeError('offline'); });
  const client = mount('/chat/c1'); await screen.findByRole('button', { name: '选择真实模型：测试模型' });
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '原账号未决问题' } }); fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await screen.findByRole('button', { name: '核对提交状态' });
  fireEvent.keyDown(screen.getByRole('button', { name: '账户菜单：test_user' }), { key: 'Enter' }); fireEvent.click(await screen.findByRole('menuitem', { name: '设置' }));
  await screen.findByRole('link', { name: '返回聊天' });
  fireEvent.keyDown(screen.getByRole('button', { name: '账户菜单：test_user' }), { key: 'Enter' }); fireEvent.click(await screen.findByRole('menuitem', { name: '退出登录' }));
  await screen.findByRole('heading', { name: '登录 CloseWebUI' });
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'test_other' } }); fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'synthetic-password' } }); fireEvent.click(screen.getByRole('button', { name: '登录' }));
  await screen.findByRole('button', { name: '账户菜单：test_other' }); await screen.findByRole('button', { name: '选择真实模型：测试模型' });
  expect(client.getQueryData(['conversation', 'c1'])).toBeUndefined();
  expect(screen.queryByRole('button', { name: '核对提交状态' })).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '输入消息' })).toHaveValue('');
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '新账号草稿' } });
  expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled();
});

it('ignores a delayed manual reconciliation after the session has expired', async () => {
  const fixture = submissionFixture(); let resolveRead!: (conversation: Conversation) => void;
  fixture.generate(async () => { fixture.read(async () => { throw new TypeError('offline'); }); throw new TypeError('offline'); });
  fixture.stop(async () => { throw new TypeError('offline'); });
  const client = mount('/chat/c1'); await screen.findByRole('button', { name: '选择真实模型：测试模型' });
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '原账号问题' } }); fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  const check = await screen.findByRole('button', { name: '核对提交状态' });
  fixture.read(() => new Promise(resolve => { resolveRead = resolve; })); fireEvent.click(check);
  act(() => { window.dispatchEvent(new Event('closewebui:unauthorized')); }); await screen.findByRole('heading', { name: '登录 CloseWebUI' });
  await act(async () => { resolveRead(fixture.saved(fixture.inputs[0], 'completed', '原账号迟到回答')); });
  expect(client.getQueryData(['conversation', 'c1'])).toBeUndefined();
  expect(useUI.getState()).toMatchObject({ drafts: {}, preview: null, busy: false, error: '' });
  expect(screen.queryByText('原账号迟到回答')).not.toBeInTheDocument();
});

it('deletes an uncertain conversation without letting its late reconciliation restore history or block a new chat', async () => {
  const fixture = submissionFixture(); let resolveRead!: (conversation: Conversation) => void;
  fixture.generate(async () => { fixture.read(async () => { throw new TypeError('offline'); }); throw new TypeError('offline'); });
  fixture.stop(async () => { throw new TypeError('offline'); });
  const client = mount('/chat/c1'); await screen.findByRole('button', { name: '选择真实模型：测试模型' });
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '未决问题' } }); fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  const check = await screen.findByRole('button', { name: '核对提交状态' });
  fixture.read(() => new Promise(resolve => { resolveRead = resolve; })); fireEvent.click(check);
  fireEvent.keyDown(screen.getByRole('button', { name: '对话菜单：提交测试' }), { key: 'Enter' });
  fireEvent.click(await screen.findByRole('menuitem', { name: '删除' })); fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '对话菜单：提交测试' })).not.toBeInTheDocument());
  await act(async () => { resolveRead(fixture.saved(fixture.inputs[0], 'completed', '删除后的迟到回答')); });
  expect(client.getQueryData(['conversation', 'c1'])).toBeUndefined();
  expect(screen.queryByText('删除后的迟到回答')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '核对提交状态' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '新对话草稿' } });
  expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled();
});
it('requires login before querying private history and clears drafts on expiration', async () => {
  let signedIn = false; const paths: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => { paths.push(url); if (url.endsWith('/auth/me')) return Response.json({ error: { code: 'UNAUTHORIZED', message: '请登录。' } }, { status: 401 }); if (url.endsWith('/auth/login')) { signedIn = true; return Response.json({ id: 'u1', username: 'demo_user' }); } if (url.endsWith('/preferences')) return Response.json({ defaultModelId: null }); return Response.json([]); });
  const client = mount();
  expect(await screen.findByRole('heading', { name: '登录 CloseWebUI' })).toBeVisible();
  expect(paths).not.toContain('/api/conversations');
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'demo_user' } }); fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'synthetic-password' } });
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
  expect(await screen.findByRole('button', { name: '账户菜单：demo_user' })).toBeVisible(); expect(signedIn).toBe(true);
  act(() => { useUI.getState().draft('home', '私有草稿'); client.setQueryData(['private'], '私有配置'); window.dispatchEvent(new Event('closewebui:unauthorized')); });
  expect(await screen.findByRole('heading', { name: '登录 CloseWebUI' })).toBeVisible();
  expect(useUI.getState().drafts).toEqual({}); expect(client.getQueryData(['private'])).toBeUndefined();
});
it('disables sending without a real model and provides settings navigation', async () => {
  vi.stubGlobal('fetch', async (url: string) => Response.json(url.endsWith('/auth/me') ? { id: 'u1', username: 'demo_user' } : url.endsWith('/preferences') ? { defaultModelId: null } : []));
  mount(); expect(await screen.findByRole('link', { name: '配置模型' })).toBeVisible();
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '测试' } });
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  expect(screen.queryByText('Sonnet 5.5')).not.toBeInTheDocument();
});
it('saves a provider without replacing its retained key when the key field is blank', async () => {
  let saved: unknown;
  const provider = { id: 'p1', name: '测试供应商', templateId: 'custom', protocol: 'openai-chat', adapter: 'standard', baseUrl: 'https://example.com/v1', enabled: true, hasKey: true };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { if (url.endsWith('/auth/me')) return Response.json({ id: 'u1', username: 'demo_user' }); if (url === '/api/providers/p1' && init.method === 'PATCH') { saved = JSON.parse(init.body as string); return Response.json(provider); } if (url.endsWith('/providers')) return Response.json([provider]); return Response.json([]); });
  mount('/settings/providers/p1');
  expect(await screen.findByRole('heading', { name: '测试供应商' })).toBeVisible();
  expect(screen.getByLabelText('API 密钥')).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: '保存供应商' }));
  await waitFor(() => expect(saved).toMatchObject({ name: '测试供应商', baseUrl: 'https://example.com/v1' }));
  expect(saved).not.toHaveProperty('apiKey');
});

it('uses the default real model and its native reasoning snapshot when sending', async () => {
  let generated: unknown; const now = '2026-10-11T00:00:00Z';
  const model = { id: 'm1', providerId: 'p1', modelId: 'gpt-known', name: '我的模型', enabled: true, maxOutputTokens: 4096, defaultReasoning: { effort: 'high' }, capabilities: { family: 'OpenAI', efforts: ['low', 'high'], supportsToggle: false, mandatory: true, budgetMin: 0, budgetMax: 0, budgetSupported: false, outputMax: 4096, sources: [], known: true } };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/auth/me')) return Response.json({ id: 'u1', username: 'demo_user' });
    if (url.endsWith('/models')) return Response.json([model]);
    if (url.endsWith('/providers')) return Response.json([{ id: 'p1', name: '测试', enabled: true }]);
    if (url.endsWith('/preferences')) return Response.json({ defaultModelId: 'm1' });
    if (url.endsWith('/generations')) { generated = JSON.parse(init.body as string); const input = generated as { assistantMessageId: string }; return new Response(`${JSON.stringify({ type: 'done', assistantMessageId: input.assistantMessageId })}\n`); }
    if (init.method === 'POST' && url.endsWith('/conversations')) return Response.json({ id: 'c1', title: '问题', createdAt: now, updatedAt: now, messages: [] });
    return Response.json([]);
  });
  mount(); expect(await screen.findByRole('button', { name: '选择真实模型：我的模型' })).toBeVisible();
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '问题' } }); fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(generated).toMatchObject({ modelId: 'm1', generationId: expect.any(String), reasoning: { effort: 'high' } }));
});

it('retries a saved failed response with its original model even if another model is selected', async () => {
  let generated: unknown; const now = '2026-10-11T00:00:00Z';
  const conversation = { id: 'c1', title: '失败测试', createdAt: now, updatedAt: now, messages: [{ id: 'user1', conversationId: 'c1', role: 'user', content: '问题', status: 'completed', createdAt: now }, { id: 'answer1', conversationId: 'c1', role: 'assistant', content: '部分', status: 'failed', createdAt: now, error: { code: 'UPSTREAM', message: '上游失败' }, modelId: 'original-model', generationId: 'old-generation', reasoning: { effort: 'high' } }] };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/auth/me')) return Response.json({ id: 'u1', username: 'demo_user' });
    if (url.endsWith('/preferences')) return Response.json({ defaultModelId: null });
    if (url.endsWith('/conversations/c1')) return Response.json(conversation);
    if (url.endsWith('/conversations')) return Response.json([{ id: 'c1', title: conversation.title, createdAt: now, updatedAt: now }]);
    if (url.endsWith('/generations')) { generated = JSON.parse(init.body as string); return new Response(`${JSON.stringify({ type: 'done', assistantMessageId: 'answer1' })}\n`); }
    return Response.json([]);
  });
  mount('/chat/c1'); fireEvent.click(await screen.findByRole('button', { name: '重试回答' }));
  await waitFor(() => expect(generated).toMatchObject({ retry: true, modelId: 'original-model', reasoning: { effort: 'high' }, generationId: expect.any(String) }));
  expect((generated as { generationId: string }).generationId).not.toBe('old-generation');
});

it('allows an explicit replacement when the saved default model is unavailable', async () => {
  const model = { id: 'm2', providerId: 'p1', modelId: 'unknown-model', name: '可用模型', enabled: true, maxOutputTokens: 4096, defaultReasoning: {}, capabilities: { family: '', efforts: [], supportsToggle: false, mandatory: false, budgetMin: 0, budgetMax: 0, budgetSupported: false, outputMax: 4096, sources: [], known: false } };
  vi.stubGlobal('fetch', async (url: string) => Response.json(url.endsWith('/auth/me') ? { id: 'u1', username: 'demo_user' } : url.endsWith('/preferences') ? { defaultModelId: 'deleted-model' } : url.endsWith('/models') ? [model] : url.endsWith('/providers') ? [{ id: 'p1', name: '测试供应商', enabled: true }] : []));
  mount();
  const trigger = await screen.findByRole('button', { name: '选择真实模型' });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(screen.getByRole('menuitemradio', { name: /可用模型/ }));
  expect(useUI.getState().realModelId).toBe('m2');
  expect(screen.queryByLabelText('思考档位')).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('logs out and keeps the next user free of the previous user’s drafts, queries and model choices', async () => {
  let user = { id: 'u1', username: 'test_one' };
  vi.stubGlobal('fetch', async (url: string) => { if (url.endsWith('/auth/me')) return Response.json(user); if (url.endsWith('/auth/logout')) return new Response(null, { status: 204 }); if (url.endsWith('/auth/login')) { user = { id: 'u2', username: 'test_two' }; return Response.json(user); } return Response.json(url.endsWith('/preferences') ? { defaultModelId: null } : []); });
  const client = mount(); const menu = await screen.findByRole('button', { name: '账户菜单：test_one' });
  act(() => { useUI.setState({ realModelId: 'private-model', reasoning: { effort: 'high' }, drafts: { home: '私有草稿' } }); client.setQueryData(['private-setting'], 'private'); });
  fireEvent.keyDown(menu, { key: 'Enter' }); fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }));
  expect(await screen.findByRole('heading', { name: '登录 CloseWebUI' })).toBeVisible();
  expect(client.getQueryData(['private-setting'])).toBeUndefined(); expect(useUI.getState()).toMatchObject({ realModelId: null, reasoning: {}, drafts: {} });
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'test_two' } }); fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'synthetic-password' } }); fireEvent.click(screen.getByRole('button', { name: '登录' }));
  expect(await screen.findByRole('button', { name: '账户菜单：test_two' })).toBeVisible(); expect(screen.getByRole('textbox', { name: '输入消息' })).toHaveValue('');
});

it('keeps manual model creation available after discovery fails', async () => {
  let saved: unknown;
  const provider = { id: 'p1', name: '测试供应商', templateId: 'custom', protocol: 'openai-chat', adapter: 'standard', baseUrl: 'https://example.com/v1', enabled: true, hasKey: true };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { if (url.endsWith('/auth/me')) return Response.json({ id: 'u1', username: 'demo_user' }); if (url.endsWith('/providers')) return Response.json([provider]); if (url.endsWith('/preferences')) return Response.json({ defaultModelId: null }); if (url.endsWith('/model-candidates')) return Response.json({ error: { code: 'DISCOVERY_FAILED', message: '供应商不支持模型发现，请手动添加。' } }, { status: 502 }); if (url.endsWith('/models') && init.method === 'POST') { saved = JSON.parse(init.body as string); return Response.json({ id: 'm1' }); } return Response.json([]); });
  mount('/settings/providers/p1'); fireEvent.click(await screen.findByRole('button', { name: '拉取模型' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('供应商不支持模型发现');
  fireEvent.click(screen.getByRole('button', { name: '手动添加模型' })); fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'custom-model' } }); fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '手动模型' } }); fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
  await waitFor(() => expect(saved).toMatchObject({ providerId: 'p1', modelId: 'custom-model', name: '手动模型', defaultReasoning: {}, maxOutputTokens: 4096 }));
});

it('validates native budgets before sending and never offers a mandatory reasoning off switch', async () => {
  const model = { id: 'm1', providerId: 'p1', modelId: 'verified-model', name: '预算模型', enabled: true, maxOutputTokens: 4096, defaultReasoning: {}, capabilities: { family: 'Claude', budgetWithinOutput: true, efforts: [], supportsToggle: false, mandatory: true, budgetMin: 1024, budgetMax: 8192, budgetSupported: true, outputMax: 8192, sources: [], known: true } };
  vi.stubGlobal('fetch', async (url: string) => Response.json(url.endsWith('/auth/me') ? { id: 'u1', username: 'demo_user' } : url.endsWith('/models') ? [model] : url.endsWith('/providers') ? [{ id: 'p1', enabled: true }] : url.endsWith('/preferences') ? { defaultModelId: 'm1' } : []));
  mount();
  const trigger = await screen.findByRole('button', { name: '选择真实模型：预算模型' });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  expect(screen.queryByLabelText('思考开关')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('思考设置'));
  fireEvent.change(screen.getByLabelText(/思考预算/), { target: { value: '4096' } });
  expect(screen.getByRole('alert')).toHaveTextContent('小于输出上限');
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '问题' } });
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled(); expect(screen.getByRole('alert')).toHaveTextContent('小于输出上限');
});

it('ignores a delayed stop error belonging to the user who already signed out', async () => {
  let resolveStop!: (response: Response) => void; let signedOut = false; const now = '2026-10-11T00:00:00Z';
  const model = { id: 'm1', providerId: 'p1', modelId: 'plain', name: '普通模型', enabled: true, maxOutputTokens: 4096, defaultReasoning: {}, capabilities: { family: '', efforts: [], supportsToggle: false, mandatory: false, budgetMin: 0, budgetMax: 0, budgetSupported: false, outputMax: 4096, sources: [], known: false } };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/auth/me')) return signedOut ? Response.json({ error: { code: 'UNAUTHORIZED', message: '请登录。' } }, { status: 401 }) : Response.json({ id: 'u1', username: 'test_one' });
    if (url.endsWith('/auth/login')) return Response.json({ id: 'u2', username: 'test_two' });
    if (url.endsWith('/models')) return Response.json([model]); if (url.endsWith('/providers')) return Response.json([{ id: 'p1', enabled: true }]); if (url.endsWith('/preferences')) return Response.json({ defaultModelId: 'm1' });
    if (url.endsWith('/stop')) return new Promise<Response>(resolve => { resolveStop = resolve; });
    if (url.endsWith('/generations')) return new Response(new ReadableStream());
    if (url.endsWith('/conversations') && init.method === 'POST') return Response.json({ id: 'c1', title: '问题', createdAt: now, updatedAt: now, messages: [] });
    return Response.json([]);
  });
  mount(); await screen.findByRole('button', { name: '选择真实模型：普通模型' }); fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '问题' } }); fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await screen.findByRole('button', { name: '停止生成' }); await waitFor(() => expect(useUI.getState().drafts.home).toBe(''));
  act(() => { signedOut = true; window.dispatchEvent(new Event('closewebui:unauthorized')); }); await screen.findByRole('heading', { name: '登录 CloseWebUI' });
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'test_two' } }); fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'synthetic-password' } }); fireEvent.click(screen.getByRole('button', { name: '登录' })); await screen.findByRole('button', { name: '账户菜单：test_two' });
  await act(async () => { resolveStop(Response.json({ error: { code: 'STOP_FAILED', message: '旧账号的停止失败。' } }, { status: 500 })); });
  expect(useUI.getState().error).toBe('');
});

it('rejects a password shorter than twelve characters before submitting authentication', async () => {
  let submitted = false;
  vi.stubGlobal('fetch', async (url: string) => { if (url.endsWith('/auth/me')) return Response.json({ error: { code: 'UNAUTHORIZED', message: '请登录。' } }, { status: 401 }); if (url.endsWith('/auth/login')) { submitted = true; return Response.json({ id: 'u1', username: 'test_user' }); } return Response.json(url.endsWith('/preferences') ? { defaultModelId: null } : []); });
  mount(); await screen.findByRole('heading', { name: '登录 CloseWebUI' });
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'test_user' } }); fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'short-pass' } });
  fireEvent.submit(screen.getByRole('button', { name: '登录' }).closest('form')!);
  expect(await screen.findByRole('alert')).toHaveTextContent('至少 12 个字符'); expect(submitted).toBe(false);
});

it('rejects a short new password before changing the account', async () => {
  let submitted = false;
  vi.stubGlobal('fetch', async (url: string) => { if (url.endsWith('/auth/me')) return Response.json({ id: 'u1', username: 'test_user' }); if (url.endsWith('/auth/password')) { submitted = true; return new Response(null, { status: 204 }); } return Response.json(url.endsWith('/preferences') ? { defaultModelId: null } : []); });
  mount('/settings/account'); await screen.findByRole('heading', { name: '修改密码' });
  fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'Test-password-123' } }); fireEvent.change(screen.getByLabelText('新密码', { exact: true }), { target: { value: 'short-pass' } }); fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'short-pass' } });
  fireEvent.submit(screen.getByRole('button', { name: '修改密码' }).closest('form')!);
  expect(await screen.findByRole('alert')).toHaveTextContent('至少 12 个字符'); expect(submitted).toBe(false);
});

it('returns to login after a newly registered account signs out', async () => {
  vi.stubGlobal('fetch', async (url: string) => { if (url.endsWith('/auth/me')) return Response.json({ error: { code: 'UNAUTHORIZED', message: '请登录。' } }, { status: 401 }); if (url.endsWith('/auth/register')) return Response.json({ id: 'u1', username: 'test_new' }); if (url.endsWith('/auth/logout')) return new Response(null, { status: 204 }); return Response.json(url.endsWith('/preferences') ? { defaultModelId: null } : []); });
  mount(); await screen.findByRole('heading', { name: '登录 CloseWebUI' }); fireEvent.click(screen.getByRole('button', { name: '没有账号？注册' })); fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'test_new' } }); fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'Test-password-123' } }); fireEvent.click(screen.getByRole('button', { name: '注册并登录' }));
  fireEvent.keyDown(await screen.findByRole('button', { name: '账户菜单：test_new' }), { key: 'Enter' }); fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }));
  expect(await screen.findByRole('heading', { name: '登录 CloseWebUI' })).toBeVisible();
});

it('restores keyboard focus to the model editor trigger after Escape', async () => {
  const provider = { id: 'p1', name: '测试供应商', templateId: 'custom', protocol: 'openai-chat', adapter: 'standard', baseUrl: 'https://example.com/v1', enabled: true, hasKey: true };
  vi.stubGlobal('fetch', async (url: string) => Response.json(url.endsWith('/auth/me') ? { id: 'u1', username: 'test_user' } : url.endsWith('/providers') ? [provider] : []));
  mount('/settings/providers'); const trigger = await screen.findByRole('button', { name: '手动添加模型' });
  trigger.focus(); fireEvent.click(trigger); const dialog = screen.getByRole('dialog', { name: '手动添加模型' });
  fireEvent.keyDown(dialog, { key: 'Escape' }); await waitFor(() => expect(trigger).toHaveFocus());
});

it('allows explicitly resetting stale native defaults before saving an unknown model', async () => {
  let saved: unknown;
  const model = { id: 'm1', providerId: 'p1', modelId: 'custom-model', name: '能力变更模型', enabled: true, maxOutputTokens: 4096, defaultReasoning: { enabled: true, effort: 'high', budgetTokens: 2048 }, capabilities: { family: '', efforts: [], supportsToggle: false, mandatory: false, budgetMin: 0, budgetMax: 0, budgetSupported: false, outputMax: 4096, sources: [], known: false } };
  const provider = { id: 'p1', name: '测试供应商', templateId: 'custom', protocol: 'openai-responses', adapter: 'standard', baseUrl: 'https://example.com/v1', enabled: true, hasKey: true };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/auth/me')) return Response.json({ id: 'u1', username: 'test_user' });
    if (url.endsWith('/providers')) return Response.json([provider]);
    if (url.endsWith('/preferences')) return Response.json({ defaultModelId: 'm1' });
    if (url.endsWith('/models/m1') && init.method === 'PATCH') { saved = JSON.parse(init.body as string); return Response.json({ ...model, ...saved as object }); }
    if (url.endsWith('/models')) return Response.json([model]);
    return Response.json([]);
  });
  mount('/settings/providers/p1'); fireEvent.click(await screen.findByRole('button', { name: '能力变更模型的模型设置' }));
  expect(screen.getByRole('alert')).toHaveTextContent('尚未核实思考能力');
  expect(screen.getByRole('button', { name: '保存参数' })).toBeDisabled();
  expect(saved).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: '重置为供应商默认' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '保存参数' })).toBeEnabled();
  expect(model.defaultReasoning).toEqual({ enabled: true, effort: 'high', budgetTokens: 2048 });
  expect(saved).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: '保存参数' }));
  await waitFor(() => expect(saved).toMatchObject({ defaultReasoning: {}, maxOutputTokens: 4096 }));
});

it.each([1, 2])('requires explicit model choice with a null saved default and %s available models', async count => {
  const models = Array.from({ length: count }, (_, i) => ({ id: `m${i + 1}`, providerId: 'p1', modelId: `custom-${i + 1}`, name: `可用模型${i + 1}`, enabled: true, maxOutputTokens: 4096, defaultReasoning: {}, capabilities: { family: '', efforts: [], supportsToggle: false, mandatory: false, budgetMin: 0, budgetMax: 0, budgetSupported: false, outputMax: 4096, sources: [], known: false } }));
  vi.stubGlobal('fetch', async (url: string) => Response.json(url.endsWith('/auth/me') ? { id: 'u1', username: 'test_user' } : url.endsWith('/preferences') ? { defaultModelId: null } : url.endsWith('/models') ? models : url.endsWith('/providers') ? [{ id: 'p1', name: '测试供应商', enabled: true }] : []));
  mount(); await screen.findByRole('button', { name: '账户菜单：test_user' });
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '问题' } });
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  const trigger = screen.getByRole('button', { name: '选择真实模型' });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(screen.getByRole('menuitemradio', { name: /可用模型1/ }));
  expect(screen.getByRole('button', { name: '选择真实模型：可用模型1' })).toBeVisible();
  expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled();
  expect(useUI.getState().drafts.home).toBe('问题');
});
