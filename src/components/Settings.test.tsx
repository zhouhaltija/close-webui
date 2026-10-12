import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { Settings } from './Settings';
import { invalidateSessionRequests } from '../core/api';

afterEach(() => { vi.unstubAllGlobals(); });

const providerA = { id: 'p1', name: '供应商甲', templateId: 'custom', protocol: 'openai-chat', adapter: 'standard', baseUrl: 'https://a.example.com/v1', enabled: true, hasKey: true };
const providerB = { id: 'p2', name: '供应商乙', templateId: 'custom', protocol: 'openai-chat', adapter: 'standard', baseUrl: 'https://b.example.com/v1', enabled: true, hasKey: false };
const capabilities = { family: 'OpenAI', efforts: ['low', 'high'], supportsToggle: false, mandatory: false, budgetMin: 0, budgetMax: 0, budgetSupported: false, outputMax: 8192, sources: [], known: true };
const entry = (id: string, name: string) => ({ id, name, capabilities, recommendedDefaults: { maxOutputTokens: 4096, defaultReasoning: {} }, verifiedDate: '2026-10-01' });
const modelA = { id: 'm1', providerId: 'p1', modelId: 'gpt-4o', name: '模型甲', enabled: true, maxOutputTokens: 4096, defaultReasoning: {}, capabilities };
const modelB = { id: 'm2', providerId: 'p2', modelId: 'gpt-5', name: '模型乙', enabled: true, maxOutputTokens: 4096, defaultReasoning: {}, capabilities };
const workspace = () => document.querySelector('.provider-workspace');
const providerRow = (name: string | RegExp) => within(screen.getByRole('navigation', { name: '已添加供应商' })).getByRole('button', { name });

type Call = { url: string; method: string; body: unknown };
function mount(path = '/settings/providers') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/settings/providers" element={<Settings />} />
    <Route path="/settings/providers/:providerId" element={<Settings />} />
    <Route path="/settings/models" element={<Settings />} />
    <Route path="/settings/account" element={<Settings />} />
  </Routes></MemoryRouter></QueryClientProvider>);
  return { client, ...ui };
}
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response> | undefined): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body as string) });
    return handler(String(url), init) ?? Response.json([]);
  });
  return calls;
}

it('shows the provider list beside the selected provider detail and its models', async () => {
  stubFetch(url => {
    if (url.endsWith('/providers')) return Response.json([providerA, providerB]);
    if (url.endsWith('/models')) return Response.json([modelA, modelB]);
    return undefined;
  });
  mount('/settings/providers/p1');
  expect(await screen.findByRole('heading', { name: '供应商甲' })).toBeVisible();
  expect(screen.getByRole('button', { name: '添加供应商' })).toBeVisible();
  expect(providerRow(/供应商乙/)).toBeVisible();
  expect(providerRow(/供应商甲/)).toHaveAttribute('aria-current', 'true');
  expect(screen.getByLabelText('名称')).toHaveValue('供应商甲');
  expect(screen.getByLabelText('接口地址')).toHaveValue('https://a.example.com/v1');
  expect(screen.getByLabelText('API 密钥')).toHaveValue('');
  expect(screen.getByRole('checkbox', { name: '启用供应商' })).toBeChecked();
  expect(screen.getByRole('button', { name: '拉取模型' })).toBeVisible();
  expect(await screen.findByRole('heading', { name: '模型甲' })).toBeVisible();
  expect(screen.getByText('gpt-4o')).toBeVisible();
  expect(screen.queryByRole('heading', { name: '模型乙' })).not.toBeInTheDocument();
});

it('selects the first provider as a safe default when the route carries no id', async () => {
  stubFetch(url => url.endsWith('/providers') ? Response.json([providerA, providerB]) : undefined);
  mount('/settings/providers');
  expect(await screen.findByRole('heading', { name: '供应商甲' })).toBeVisible();
  expect(providerRow(/供应商甲/)).toHaveAttribute('aria-current', 'true');
  expect(screen.getByRole('button', { name: '拉取模型' })).toBeVisible();
});

it('opens the first provider detail from the list and can reopen it after going back', async () => {
  stubFetch(url => url.endsWith('/providers') ? Response.json([providerA]) : undefined);
  mount('/settings/providers');
  await screen.findByRole('heading', { name: '供应商甲' });
  expect(workspace()).toHaveAttribute('data-view', 'list');
  fireEvent.click(providerRow(/供应商甲/));
  await waitFor(() => expect(workspace()).toHaveAttribute('data-view', 'detail'));
  fireEvent.click(screen.getByRole('button', { name: '返回供应商列表' }));
  await waitFor(() => expect(workspace()).toHaveAttribute('data-view', 'list'));
  fireEvent.click(providerRow(/供应商甲/));
  await waitFor(() => expect(workspace()).toHaveAttribute('data-view', 'detail'));
});

it('shows a newly created provider only once after the provider list refreshes', async () => {
  let created = false;
  stubFetch((url, init) => {
    if (url.endsWith('/providers') && init.method === 'POST') { created = true; return Response.json(providerB); }
    if (url.endsWith('/providers')) return Response.json(created ? [providerA, providerB] : [providerA]);
    if (url.endsWith('/model-candidates')) return Response.json({ source: 'upstream', catalogVersion: 'v1', warning: '', models: [entry('gpt-5', 'GPT-5')] });
    return undefined;
  });
  mount('/settings/providers/p1');
  await screen.findByRole('heading', { name: '供应商甲' });
  fireEvent.click(screen.getByRole('button', { name: '添加供应商' }));
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '供应商乙' } });
  fireEvent.change(screen.getByLabelText('接口地址'), { target: { value: 'https://b.example.com/v1' } });
  fireEvent.click(screen.getByRole('button', { name: '保存供应商' }));
  await screen.findByRole('heading', { name: '供应商乙' });
  expect(within(screen.getByRole('navigation', { name: '已添加供应商' })).getAllByRole('button', { name: /供应商乙/ })).toHaveLength(1);
});

it('reports a provider id that does not belong to the current account', async () => {
  stubFetch(url => url.endsWith('/providers') ? Response.json([providerA]) : undefined);
  mount('/settings/providers/other');
  expect(await screen.findByRole('heading', { name: '供应商不存在' })).toBeVisible();
  expect(screen.getByText('该供应商不存在或不属于当前账号。')).toBeVisible();
});

it('offers an add entry when no provider is configured yet', async () => {
  stubFetch(() => Response.json([]));
  mount('/settings/providers');
  expect(await screen.findByRole('heading', { name: '还没有供应商' })).toBeVisible();
  expect(screen.getByRole('button', { name: '添加供应商' })).toBeVisible();
  expect(screen.getByRole('button', { name: '添加第一个供应商' })).toBeVisible();
});

it('keeps a late discovery response from overwriting the newly selected provider', async () => {
  let resolveA!: (response: Response) => void;
  stubFetch(url => {
    if (url.endsWith('/providers')) return Response.json([providerA, providerB]);
    if (url.endsWith('/model-candidates')) {
      if (url.includes('/p1/')) return new Promise<Response>(resolve => { resolveA = resolve; });
      return Response.json({ source: 'upstream', catalogVersion: 'v1', warning: '', models: [entry('gpt-5', 'GPT-5')] });
    }
    return undefined;
  });
  mount('/settings/providers/p1');
  fireEvent.click(await screen.findByRole('button', { name: '拉取模型' }));
  expect(await screen.findByRole('button', { name: '拉取中…' })).toBeVisible();
  fireEvent.click(providerRow(/供应商乙/));
  expect(await screen.findByRole('heading', { name: '供应商乙' })).toBeVisible();
  expect(screen.getByLabelText('接口地址')).toHaveValue('https://b.example.com/v1');
  fireEvent.click(screen.getByRole('button', { name: '拉取模型' }));
  expect(await screen.findByText('gpt-5')).toBeVisible();
  await act(async () => { resolveA(Response.json({ source: 'upstream', catalogVersion: 'v1', warning: '', models: [entry('late-model', '迟到的模型')] })); });
  expect(screen.getByRole('heading', { name: '供应商乙' })).toBeVisible();
  expect(screen.queryByText('迟到的模型')).not.toBeInTheDocument();
  expect(screen.getByText('gpt-5')).toBeVisible();
  expect(screen.getByLabelText('接口地址')).toHaveValue('https://b.example.com/v1');
});

it('never silently drops unsaved provider edits when switching providers', async () => {
  stubFetch(url => url.endsWith('/providers') ? Response.json([providerA, providerB]) : undefined);
  mount('/settings/providers/p1');
  fireEvent.change(await screen.findByLabelText('名称'), { target: { value: '甲的新名称' } });
  fireEvent.click(providerRow(/供应商乙/));
  expect(screen.getByRole('alertdialog')).toBeVisible();
  expect(screen.getByRole('heading', { name: '供应商甲' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '保留草稿并切换' }));
  expect(await screen.findByRole('heading', { name: '供应商乙' })).toBeVisible();
  fireEvent.click(providerRow(/供应商甲/));
  expect(await screen.findByLabelText('名称')).toHaveValue('甲的新名称');
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '另一个名称' } });
  fireEvent.click(providerRow(/供应商乙/));
  fireEvent.click(screen.getByRole('button', { name: '放弃修改' }));
  expect(await screen.findByRole('heading', { name: '供应商乙' })).toBeVisible();
  fireEvent.click(providerRow(/供应商甲/));
  expect(await screen.findByLabelText('名称')).toHaveValue('供应商甲');
});

it('restores a retained new provider draft when adding again', async () => {
  stubFetch(url => url.endsWith('/providers') ? Response.json([providerA]) : undefined);
  mount('/settings/providers/p1');
  await screen.findByRole('heading', { name: '供应商甲' });
  fireEvent.click(screen.getByRole('button', { name: '添加供应商' }));
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '尚未保存的供应商' } });
  fireEvent.change(screen.getByLabelText('接口地址'), { target: { value: 'https://draft.example.com/v1' } });
  fireEvent.click(providerRow(/供应商甲/));
  fireEvent.click(screen.getByRole('button', { name: '保留草稿并切换' }));
  await screen.findByRole('heading', { name: '供应商甲' });
  fireEvent.click(screen.getByRole('button', { name: '添加供应商' }));
  expect(screen.getByLabelText('名称')).toHaveValue('尚未保存的供应商');
  expect(screen.getByLabelText('接口地址')).toHaveValue('https://draft.example.com/v1');
});

it('does not restore old account models when a pending toggle fails after an identity change', async () => {
  let releasePatch!: (response: Response) => void;
  stubFetch((url, init) => {
    if (url.endsWith('/providers')) return Response.json([providerA]);
    if (url.endsWith('/models')) return Response.json([modelA]);
    if (url.endsWith('/models/m1') && init.method === 'PATCH') return new Promise(resolve => { releasePatch = resolve; });
    return undefined;
  });
  const { client, unmount } = mount('/settings/providers/p1');
  fireEvent.click(await screen.findByRole('checkbox', { name: '启用模型甲' }));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: '启用模型甲' })).not.toBeChecked());
  unmount();
  invalidateSessionRequests();
  client.clear();
  client.setQueryData(['models'], [modelB]);
  await act(async () => { releasePatch(Response.json({ error: { code: 'SAVE_FAILED', message: '旧账号保存失败。' } }, { status: 500 })); });
  expect(client.getQueryData(['models'])).toEqual([modelB]);
});

it('does not start a queued model toggle after the account changes', async () => {
  const calls = stubFetch(url => {
    if (url.endsWith('/providers')) return Response.json([providerA]);
    if (url.endsWith('/models')) return Response.json([modelA]);
    return undefined;
  });
  const { client } = mount('/settings/providers/p1');
  const checkbox = await screen.findByRole('checkbox', { name: '启用模型甲' });
  await act(async () => {
    fireEvent.click(checkbox);
    invalidateSessionRequests();
    client.clear();
    client.setQueryData(['models'], [modelB]);
  });
  expect(client.getQueryData(['models'])).toEqual([modelB]);
  expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(0);
});

it('restores the toggled model and shows its error when saving fails in the current account', async () => {
  stubFetch((url, init) => {
    if (url.endsWith('/providers')) return Response.json([providerA]);
    if (url.endsWith('/models')) return Response.json([modelA]);
    if (url.endsWith('/models/m1') && init.method === 'PATCH') return Response.json({ error: { code: 'SAVE_FAILED', message: '无法保存模型开关。' } }, { status: 500 });
    return undefined;
  });
  mount('/settings/providers/p1');
  fireEvent.click(await screen.findByRole('checkbox', { name: '启用模型甲' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('无法保存模型开关。');
  expect(screen.getByRole('checkbox', { name: '启用模型甲' })).toBeChecked();
});

it('rolls back only the failed toggle after switching providers without losing newer model changes', async () => {
  let releasePatch!: (response: Response) => void;
  stubFetch((url, init) => {
    if (url.endsWith('/providers')) return Response.json([providerA, providerB]);
    if (url.endsWith('/models')) return Response.json([modelA, modelB]);
    if (url.endsWith('/models/m1') && init.method === 'PATCH') return new Promise(resolve => { releasePatch = resolve; });
    return undefined;
  });
  const { client } = mount('/settings/providers/p1');
  fireEvent.click(await screen.findByRole('checkbox', { name: '启用模型甲' }));
  client.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  fireEvent.click(providerRow(/供应商乙/));
  await screen.findByRole('heading', { name: '供应商乙' });
  expect(client.getQueryData<typeof modelA[]>(['models'])?.find(model => model.id === 'm1')?.enabled).toBe(false);
  act(() => client.setQueryData<typeof modelA[]>(['models'], current => current?.map(model => model.id === 'm2' ? { ...model, enabled: false } : model)));
  await act(async () => { releasePatch(Response.json({ error: { code: 'SAVE_FAILED', message: '供应商甲的开关保存失败。' } }, { status: 500 })); });
  expect(client.getQueryData(['models'])).toEqual([modelA, { ...modelB, enabled: false }]);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.click(providerRow(/供应商甲/));
  expect(await screen.findByRole('checkbox', { name: '启用模型甲' })).toBeChecked();
});

it('blocks repeated toggles of a pending model while allowing another model to save', async () => {
  const otherModel = { ...modelB, providerId: 'p1' };
  const patches: { id: string; release: (response: Response) => void }[] = [];
  stubFetch((url, init) => {
    if (url.endsWith('/providers')) return Response.json([providerA]);
    if (url.endsWith('/models')) return Response.json([modelA, otherModel]);
    if (init.method === 'PATCH' && /\/models\/m[12]$/.test(url)) return new Promise(resolve => { patches.push({ id: url.split('/').at(-1)!, release: resolve }); });
    return undefined;
  });
  const { client } = mount('/settings/providers/p1');
  const first = await screen.findByRole('checkbox', { name: '启用模型甲' });
  const second = screen.getByRole('checkbox', { name: '启用模型乙' });
  fireEvent.click(first);
  fireEvent.click(first);
  fireEvent.click(second);
  await waitFor(() => expect(patches.map(patch => patch.id)).toEqual(['m1', 'm2']));
  expect(first).toBeDisabled();
  expect(second).toBeDisabled();
  await act(async () => { patches[1].release(Response.json({ ...otherModel, enabled: false })); });
  await waitFor(() => expect(second).toBeEnabled());
  expect(first).toBeDisabled();
  await act(async () => { patches[0].release(Response.json({ error: { code: 'SAVE_FAILED', message: '开关保存失败。' } }, { status: 500 })); });
  await waitFor(() => expect(first).toBeEnabled());
  expect(first).toBeChecked();
  expect(second).not.toBeChecked();
  expect(client.getQueryData(['models'])).toEqual([modelA, { ...otherModel, enabled: false }]);
});

it('keeps the retained provider key when the key field is left blank', async () => {
  const calls = stubFetch((url, init) => {
    if (url === '/api/providers/p1' && init.method === 'PATCH') return Response.json(providerA);
    if (url.endsWith('/providers')) return Response.json([providerA, providerB]);
    return undefined;
  });
  mount('/settings/providers/p1');
  fireEvent.click(await screen.findByRole('button', { name: '保存供应商' }));
  await waitFor(() => expect(calls.some(call => call.method === 'PATCH')).toBe(true));
  const patch = calls.find(call => call.method === 'PATCH')!;
  expect(patch.url).toBe('/api/providers/p1');
  expect(patch.body).toMatchObject({ name: '供应商甲', baseUrl: 'https://a.example.com/v1', enabled: true });
  expect(patch.body).not.toHaveProperty('apiKey');
});

it('discovers models once right after a provider is first saved', async () => {
  let created = false;
  const calls = stubFetch((url, init) => {
    if (url.endsWith('/providers')) {
      if (init.method === 'POST') { created = true; return Response.json(providerA); }
      return Response.json(created ? [providerA] : []);
    }
    if (url.endsWith('/model-candidates')) return Response.json({ source: 'upstream', catalogVersion: 'v1', warning: '', models: [entry('gpt-4o', 'GPT-4o')] });
    return undefined;
  });
  mount('/settings/providers');
  fireEvent.click(screen.getByRole('button', { name: '添加供应商' }));
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '供应商甲' } });
  fireEvent.change(screen.getByLabelText('接口地址'), { target: { value: 'https://a.example.com/v1' } });
  fireEvent.click(screen.getByRole('button', { name: '保存供应商' }));
  expect(await screen.findByRole('heading', { name: '供应商甲' })).toBeVisible();
  await waitFor(() => expect(calls.filter(call => call.url.endsWith('/model-candidates')).length).toBe(1));
  expect(await screen.findByText('gpt-4o')).toBeVisible();
  const post = calls.find(call => call.method === 'POST' && call.url === '/api/providers')!;
  expect(post.body).toMatchObject({ name: '供应商甲', baseUrl: 'https://a.example.com/v1' });
  expect(post.body).not.toHaveProperty('apiKey');
});

it('adds discovered candidates through one batch call and reports each item without rewriting existing models', async () => {
  const calls = stubFetch((url, init) => {
    if (url.endsWith('/providers')) return Response.json([providerA]);
    if (url.endsWith('/models')) return init.method === 'GET' ? Response.json([modelA]) : undefined;
    if (url.endsWith('/model-candidates')) return Response.json({ source: 'upstream', catalogVersion: 'catalog-2026-10', warning: '', models: [entry('gpt-4o', 'GPT-4o'), entry('gpt-5', 'GPT-5')] });
    if (url.endsWith('/models/batch')) return Response.json({ results: [{ modelId: 'gpt-4o', id: 'm1', status: 'exists' }, { modelId: 'gpt-5', id: 'm9', status: 'added' }] });
    return undefined;
  });
  mount('/settings/providers/p1');
  fireEvent.click(await screen.findByRole('button', { name: '拉取模型' }));
  expect(await screen.findByText('上游返回')).toBeVisible();
  expect(screen.getAllByText(/推荐输出上限 4096 tokens/)).toHaveLength(2);
  fireEvent.click(screen.getByRole('checkbox', { name: /GPT-4o/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /GPT-5/ }));
  fireEvent.click(screen.getByRole('button', { name: '批量添加' }));
  await waitFor(() => expect(calls.some(call => call.url.endsWith('/models/batch'))).toBe(true));
  const batch = calls.find(call => call.url.endsWith('/models/batch'))!;
  expect(batch.method).toBe('POST');
  expect(batch.body).toEqual({ models: [{ modelId: 'gpt-4o', name: 'GPT-4o', maxOutputTokens: 4096, enabled: true }, { modelId: 'gpt-5', name: 'GPT-5', maxOutputTokens: 4096, enabled: true }] });
  expect(await screen.findByText('批量添加完成：已添加 1 项，已存在 1 项，失败 0 项。')).toBeVisible();
  expect(screen.getByText('gpt-5 · 已添加')).toBeVisible();
  expect(screen.getByText('gpt-4o · 已存在（未改写）')).toBeVisible();
  expect(calls.filter(call => /\/api\/models$/.test(call.url) && call.method !== 'GET')).toEqual([]);
});

it('shows the real discovery failure reason and lists built-in catalog candidates', async () => {
  const calls = stubFetch(url => {
    if (url.endsWith('/providers')) return Response.json([providerA]);
    if (url.endsWith('/model-candidates')) return Response.json({ error: { code: 'DISCOVERY_FAILED', message: '供应商不支持模型发现，请手动添加。' } }, { status: 502 });
    if (url.endsWith('/model-catalog')) return Response.json({ catalogVersion: 'builtin-2026-10', adapter: 'standard', protocol: 'openai-chat', models: [entry('gpt-4o', 'GPT-4o')] });
    return undefined;
  });
  mount('/settings/providers/p1');
  fireEvent.click(await screen.findByRole('button', { name: '拉取模型' }));
  expect(await screen.findByText(/上游发现失败：供应商不支持模型发现，请手动添加。/)).toBeVisible();
  expect(screen.getByText('内置目录')).toBeVisible();
  expect(screen.getByText('gpt-4o')).toBeVisible();
  expect(screen.queryByText('上游返回')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '手动添加模型' })).toBeVisible();
  expect(calls.some(call => call.url.endsWith('/model-catalog'))).toBe(true);
});

it('keeps manual model creation available after discovery fails', async () => {
  let saved: unknown;
  stubFetch((url, init) => {
    if (url.endsWith('/providers')) return Response.json([providerA]);
    if (url.endsWith('/model-candidates')) return Response.json({ error: { code: 'DISCOVERY_FAILED', message: '供应商不支持模型发现，请手动添加。' } }, { status: 502 });
    if (url.endsWith('/models') && init.method === 'POST') { saved = JSON.parse(init.body as string); return Response.json({ id: 'm1' }); }
    if (url.endsWith('/models')) return Response.json([]);
    return undefined;
  });
  mount('/settings/providers/p1');
  fireEvent.click(await screen.findByRole('button', { name: '拉取模型' }));
  expect(await screen.findByText(/供应商不支持模型发现/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '手动添加模型' }));
  const dialog = within(screen.getByRole('dialog', { name: '手动添加模型' }));
  fireEvent.change(dialog.getByLabelText('模型 ID'), { target: { value: 'custom-model' } });
  fireEvent.change(dialog.getByLabelText('显示名称'), { target: { value: '手动模型' } });
  fireEvent.click(dialog.getByRole('button', { name: '添加模型' }));
  await waitFor(() => expect(saved).toMatchObject({ providerId: 'p1', modelId: 'custom-model', name: '手动模型', defaultReasoning: {}, maxOutputTokens: 4096 }));
});

it('allows explicitly resetting stale native defaults before saving an unknown model', async () => {
  let saved: unknown;
  const stale = { id: 'm1', providerId: 'p1', modelId: 'custom-model', name: '能力变更模型', enabled: true, maxOutputTokens: 4096, defaultReasoning: { enabled: true, effort: 'high', budgetTokens: 2048 }, capabilities: { family: '', efforts: [], supportsToggle: false, mandatory: false, budgetMin: 0, budgetMax: 0, budgetSupported: false, outputMax: 4096, sources: [], known: false } };
  stubFetch((url, init) => {
    if (url.endsWith('/providers')) return Response.json([providerA]);
    if (url.endsWith('/preferences')) return Response.json({ defaultModelId: 'm1' });
    if (url.endsWith('/models/m1') && init.method === 'PATCH') { saved = JSON.parse(init.body as string); return Response.json({ ...stale, ...saved as object }); }
    if (url.endsWith('/models')) return Response.json([stale]);
    return undefined;
  });
  mount('/settings/providers/p1');
  fireEvent.click(await screen.findByRole('button', { name: '编辑能力变更模型的思考参数' }));
  expect(screen.getByRole('alert')).toHaveTextContent('尚未核实思考能力');
  expect(screen.getByRole('button', { name: '保存参数' })).toBeDisabled();
  expect(saved).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: '重置为供应商默认' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '保存参数' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '保存参数' }));
  await waitFor(() => expect(saved).toMatchObject({ defaultReasoning: {}, maxOutputTokens: 4096 }));
});

it('restores keyboard focus to the manual model editor trigger after Escape', async () => {
  stubFetch(url => url.endsWith('/providers') ? Response.json([providerA]) : undefined);
  mount('/settings/providers');
  const trigger = await screen.findByRole('button', { name: '手动添加模型' });
  trigger.focus(); fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: '手动添加模型' });
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => expect(trigger).toHaveFocus());
});

it('disabling a provider leaves its models own switches untouched', async () => {
  let disabled = false;
  const calls = stubFetch((url, init) => {
    if (url === '/api/providers/p1' && init.method === 'PATCH') { disabled = true; return Response.json({ ...providerA, enabled: false }); }
    if (url.endsWith('/providers')) return Response.json([disabled ? { ...providerA, enabled: false } : providerA]);
    if (url.endsWith('/models')) return Response.json([modelA]);
    return undefined;
  });
  mount('/settings/providers/p1');
  expect(await screen.findByRole('checkbox', { name: '启用供应商' })).toBeChecked();
  fireEvent.click(screen.getByRole('checkbox', { name: '启用供应商' }));
  fireEvent.click(screen.getByRole('button', { name: '保存供应商' }));
  await waitFor(() => expect(calls.some(call => call.method === 'PATCH' && call.url === '/api/providers/p1')).toBe(true));
  expect(calls.find(call => call.method === 'PATCH')!.body).toMatchObject({ enabled: false });
  expect(calls.find(call => call.method === 'PATCH')!.body).not.toHaveProperty('apiKey');
  expect(calls.filter(call => call.url.endsWith('/models') && call.method !== 'GET')).toEqual([]);
  expect(screen.getByRole('checkbox', { name: '启用模型甲' })).toBeChecked();
  await waitFor(() => expect(screen.getByRole('button', { name: '将模型甲设为默认' })).toBeDisabled());
});

it('deletes a provider and returns to the list without losing other providers', async () => {
  const calls = stubFetch((url, init) => {
    if (url.endsWith('/providers/p1') && init.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.endsWith('/providers')) return Response.json([providerA, providerB]);
    return undefined;
  });
  mount('/settings/providers/p1');
  fireEvent.click(await screen.findByRole('button', { name: '删除供应商甲' }));
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(calls.some(call => call.method === 'DELETE' && call.url === '/api/providers/p1')).toBe(true));
  expect(await screen.findByRole('heading', { name: '供应商乙' })).toBeVisible();
});

it('keeps a way back to the provider list on narrow viewports', async () => {
  stubFetch(url => url.endsWith('/providers') ? Response.json([providerA, providerB]) : undefined);
  mount('/settings/providers/p1');
  expect(await screen.findByRole('button', { name: '返回供应商列表' })).toBeVisible();
  expect(workspace()).toHaveAttribute('data-view', 'detail');
  fireEvent.click(screen.getByRole('button', { name: '返回供应商列表' }));
  await waitFor(() => expect(workspace()).toHaveAttribute('data-view', 'list'));
  expect(screen.getByRole('button', { name: '添加供应商' })).toBeVisible();
  expect(providerRow(/供应商甲/)).toBeVisible();
  expect(screen.getByRole('navigation', { name: '设置分类' })).toBeVisible();
});

it('summarizes models across providers and filters without a second provider choice', async () => {
  stubFetch(url => {
    if (url.endsWith('/providers')) return Response.json([providerA, providerB]);
    if (url.endsWith('/models')) return Response.json([modelA, modelB]);
    if (url.endsWith('/preferences')) return Response.json({ defaultModelId: 'm1' });
    return undefined;
  });
  mount('/settings/models');
  expect(await screen.findByRole('heading', { name: '模型' })).toBeVisible();
  expect(screen.queryByLabelText('发现模型的供应商')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '发现模型' })).not.toBeInTheDocument();
  expect(await screen.findByRole('heading', { name: '模型甲' })).toBeVisible();
  expect(screen.getByRole('heading', { name: '模型乙' })).toBeVisible();
  expect(screen.getByText(/供应商乙/)).toBeVisible();
  expect(screen.getByText('默认模型')).toBeVisible();
  fireEvent.change(screen.getByLabelText('搜索模型'), { target: { value: '模型甲' } });
  expect(screen.queryByRole('heading', { name: '模型乙' })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '模型甲' })).toBeVisible();
});

it('warns about a disabled default model instead of silently replacing it', async () => {
  stubFetch(url => {
    if (url.endsWith('/providers')) return Response.json([providerA]);
    if (url.endsWith('/models')) return Response.json([{ ...modelA, enabled: false }]);
    if (url.endsWith('/preferences')) return Response.json({ defaultModelId: 'm1' });
    return undefined;
  });
  mount('/settings/models');
  expect(await screen.findByText('默认模型或其供应商已停用，请在聊天输入框明确选择其他模型，不会自动替换。')).toBeVisible();
  expect(screen.getByRole('button', { name: '设为默认' })).toBeDisabled();
});

it('warns when the saved default model was deleted', async () => {
  stubFetch(url => {
    if (url.endsWith('/providers')) return Response.json([providerA]);
    if (url.endsWith('/models')) return Response.json([modelA]);
    if (url.endsWith('/preferences')) return Response.json({ defaultModelId: 'gone' });
    return undefined;
  });
  mount('/settings/models');
  expect(await screen.findByText(/默认模型已被删除/)).toBeVisible();
});
