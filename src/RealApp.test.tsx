import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { useUI } from './core/ui-store';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); useUI.setState({ drafts: {}, busy: false, error: '', realModelId: null, reasoning: {} }); });
function mount(path = '/') {
  vi.stubEnv('VITE_ENABLE_MOCK', 'false');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Routes><Route path="/" element={<App />} /><Route path="/chat/:conversationId" element={<App />} /><Route path="/settings/:section" element={<App />} /></Routes></MemoryRouter></QueryClientProvider>);
  return client;
}
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
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { if (url.endsWith('/auth/me')) return Response.json({ id: 'u1', username: 'demo_user' }); if (init.method === 'PATCH') { saved = JSON.parse(init.body as string); return Response.json(provider); } if (url.endsWith('/providers')) return Response.json([provider]); return Response.json([]); });
  mount('/settings/providers');
  fireEvent.click(await screen.findByRole('button', { name: '编辑测试供应商' }));
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
  mount(); fireEvent.click(await screen.findByRole('button', { name: '选择真实模型' }));
  fireEvent.click(screen.getByRole('button', { name: /可用模型/ }));
  expect(useUI.getState().realModelId).toBe('m2');
  expect(screen.queryByLabelText('思考档位')).not.toBeInTheDocument();
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
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { if (url.endsWith('/auth/me')) return Response.json({ id: 'u1', username: 'demo_user' }); if (url.endsWith('/providers')) return Response.json([provider]); if (url.endsWith('/preferences')) return Response.json({ defaultModelId: null }); if (url.endsWith('/discover')) return Response.json({ error: { code: 'DISCOVERY_FAILED', message: '供应商不支持模型发现，请手动添加。' } }, { status: 502 }); if (url.endsWith('/models') && init.method === 'POST') { saved = JSON.parse(init.body as string); return Response.json({ id: 'm1' }); } return Response.json([]); });
  mount('/settings/models'); fireEvent.change(await screen.findByLabelText('发现模型的供应商'), { target: { value: 'p1' } }); fireEvent.click(screen.getByRole('button', { name: '发现模型' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('供应商不支持模型发现');
  fireEvent.click(screen.getByRole('button', { name: '手动添加' })); fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'custom-model' } }); fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '手动模型' } }); fireEvent.click(screen.getByRole('button', { name: '保存模型' }));
  await waitFor(() => expect(saved).toMatchObject({ providerId: 'p1', modelId: 'custom-model', name: '手动模型', defaultReasoning: {}, maxOutputTokens: 4096 }));
});

it('validates native budgets before sending and never offers a mandatory reasoning off switch', async () => {
  const model = { id: 'm1', providerId: 'p1', modelId: 'verified-model', name: '预算模型', enabled: true, maxOutputTokens: 4096, defaultReasoning: {}, capabilities: { family: 'Claude', budgetWithinOutput: true, efforts: [], supportsToggle: false, mandatory: true, budgetMin: 1024, budgetMax: 8192, budgetSupported: true, outputMax: 8192, sources: [], known: true } };
  vi.stubGlobal('fetch', async (url: string) => Response.json(url.endsWith('/auth/me') ? { id: 'u1', username: 'demo_user' } : url.endsWith('/models') ? [model] : url.endsWith('/providers') ? [{ id: 'p1', enabled: true }] : url.endsWith('/preferences') ? { defaultModelId: 'm1' } : []));
  mount(); fireEvent.click(await screen.findByRole('button', { name: '选择真实模型：预算模型' })); expect(screen.queryByLabelText('思考开关')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/思考预算/), { target: { value: '4096' } }); expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent('小于输出上限'); fireEvent.click(screen.getByRole('button', { name: '完成' })); fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '问题' } });
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled(); expect(screen.getByRole('alert')).toHaveTextContent('小于输出上限');
});

it('ignores a delayed stop error belonging to the user who already signed out', async () => {
  let resolveStop!: (response: Response) => void; const now = '2026-10-11T00:00:00Z';
  const model = { id: 'm1', providerId: 'p1', modelId: 'plain', name: '普通模型', enabled: true, maxOutputTokens: 4096, defaultReasoning: {}, capabilities: { family: '', efforts: [], supportsToggle: false, mandatory: false, budgetMin: 0, budgetMax: 0, budgetSupported: false, outputMax: 4096, sources: [], known: false } };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/auth/me')) return Response.json({ id: 'u1', username: 'test_one' });
    if (url.endsWith('/auth/login')) return Response.json({ id: 'u2', username: 'test_two' });
    if (url.endsWith('/models')) return Response.json([model]); if (url.endsWith('/providers')) return Response.json([{ id: 'p1', enabled: true }]); if (url.endsWith('/preferences')) return Response.json({ defaultModelId: 'm1' });
    if (url.endsWith('/stop')) return new Promise<Response>(resolve => { resolveStop = resolve; });
    if (url.endsWith('/generations')) return new Response(new ReadableStream());
    if (url.endsWith('/conversations') && init.method === 'POST') return Response.json({ id: 'c1', title: '问题', createdAt: now, updatedAt: now, messages: [] });
    return Response.json([]);
  });
  mount(); await screen.findByRole('button', { name: '选择真实模型：普通模型' }); fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '问题' } }); fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await screen.findByRole('button', { name: '停止生成' }); await waitFor(() => expect(useUI.getState().drafts.home).toBe(''));
  act(() => window.dispatchEvent(new Event('closewebui:unauthorized'))); await screen.findByRole('heading', { name: '登录 CloseWebUI' });
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

it('restores keyboard focus to the provider editor trigger after Escape', async () => {
  vi.stubGlobal('fetch', async (url: string) => Response.json(url.endsWith('/auth/me') ? { id: 'u1', username: 'test_user' } : []));
  mount('/settings/providers'); const trigger = await screen.findByRole('button', { name: '添加供应商' });
  trigger.focus(); fireEvent.click(trigger); const dialog = screen.getByRole('dialog', { name: '添加供应商' });
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
  mount('/settings/models'); fireEvent.click(await screen.findByRole('button', { name: '编辑模型能力变更模型' }));
  const dialog = within(screen.getByRole('dialog', { name: '编辑模型' }));
  expect(dialog.getByRole('alert')).toHaveTextContent('尚未核实思考能力');
  expect(dialog.getByRole('button', { name: '保存模型' })).toBeDisabled();
  expect(saved).toBeUndefined();
  fireEvent.click(dialog.getByRole('button', { name: '重置为供应商默认' }));
  expect(dialog.queryByRole('alert')).not.toBeInTheDocument();
  expect(dialog.getByRole('button', { name: '保存模型' })).toBeEnabled();
  expect(model.defaultReasoning).toEqual({ enabled: true, effort: 'high', budgetTokens: 2048 });
  expect(saved).toBeUndefined();
  fireEvent.click(dialog.getByRole('button', { name: '保存模型' }));
  await waitFor(() => expect(saved).toMatchObject({ defaultReasoning: {}, maxOutputTokens: 4096 }));
});

it.each([1, 2])('requires explicit model choice with a null saved default and %s available models', async count => {
  const models = Array.from({ length: count }, (_, i) => ({ id: `m${i + 1}`, providerId: 'p1', modelId: `custom-${i + 1}`, name: `可用模型${i + 1}`, enabled: true, maxOutputTokens: 4096, defaultReasoning: {}, capabilities: { family: '', efforts: [], supportsToggle: false, mandatory: false, budgetMin: 0, budgetMax: 0, budgetSupported: false, outputMax: 4096, sources: [], known: false } }));
  vi.stubGlobal('fetch', async (url: string) => Response.json(url.endsWith('/auth/me') ? { id: 'u1', username: 'test_user' } : url.endsWith('/preferences') ? { defaultModelId: null } : url.endsWith('/models') ? models : url.endsWith('/providers') ? [{ id: 'p1', name: '测试供应商', enabled: true }] : []));
  mount(); await screen.findByRole('button', { name: '账户菜单：test_user' });
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '问题' } });
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  fireEvent.click(await screen.findByRole('button', { name: '选择真实模型' }));
  fireEvent.click(screen.getByRole('button', { name: /可用模型1/ }));
  fireEvent.click(screen.getByRole('button', { name: '完成' }));
  expect(screen.getByRole('button', { name: '选择真实模型：可用模型1' })).toBeVisible();
  expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled();
});
