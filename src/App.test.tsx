import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { App, ErrorBoundary } from './App';
import { api } from './core/api';
import { useUI } from './core/ui-store';
import type { Conversation } from './core/types';
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); useUI.setState({ busy: false, error: '', drafts: {}, mobileOpen: false, collapsed: false }); });
function renderHome(history: Conversation[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['conversations'], history);
  history.forEach(conversation => client.setQueryData(['conversation', conversation.id], conversation));
  return render(<QueryClientProvider client={client}><MemoryRouter><Routes><Route path="/" element={<App />} /><Route path="/chat/:conversationId" element={<App />} /></Routes></MemoryRouter></QueryClientProvider>);
}
it('searches real local history and opens the chosen conversation', () => {
  const date = '2026-10-10T00:00:00Z';
  const history = ['Qt 学习路线', '工作日计划'].map((title, index) => ({ id: `c${index}`, title, createdAt: date, updatedAt: date, messages: [] }));
  renderHome(history); fireEvent.click(screen.getByRole('button', { name: '搜索对话' }));
  fireEvent.change(screen.getByRole('textbox', { name: '搜索对话标题' }), { target: { value: 'qt' } });
  expect(screen.getByRole('button', { name: 'Qt 学习路线' })).toBeVisible();
  expect(screen.queryByRole('button', { name: '工作日计划' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Qt 学习路线' }));
  expect(screen.getByRole('heading', { name: 'Qt 学习路线' })).toBeVisible();
});
it('keeps the project brand and exposes only implemented navigation', () => {
  renderHome();
  expect(screen.getByRole('link', { name: 'CloseWebUI 首页' })).toBeVisible();
  expect(screen.queryByRole('button', { name: '项目' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '账户菜单' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '临时对话' })).not.toBeInTheDocument();
});
it.each([
  [2, '深夜即兴时刻。'], [9, '早上好，今天想探索什么？'],
  [14, '从一个好问题开始。'], [20, '晚上好，让灵感慢慢展开。'],
])('chooses a greeting appropriate for local hour %i', (hour, greeting) => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 9, 10, hour));
  vi.spyOn(Math, 'random').mockReturnValue(0); renderHome();
  expect(screen.getByRole('heading', { name: greeting })).toBeVisible();
});
it('keeps a greeting stable while typing and draws a new one on a new chat', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 9, 10, 2));
  const random = vi.spyOn(Math, 'random').mockReturnValue(0); renderHome();
  expect(screen.getByRole('heading', { name: '深夜即兴时刻。' })).toBeVisible();
  random.mockReturnValue(0.999999);
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '保留我的思路' } });
  expect(screen.getByRole('heading', { name: '深夜即兴时刻。' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '新对话' }));
  expect(screen.getByRole('heading', { name: '安静的时候，想法更清晰。' })).toBeVisible();
});
function HistoryBack() { const navigate = useNavigate(); return <button onClick={() => navigate(-1)}>浏览器后退</button>; }
it('shows a Chinese recovery action when rendering fails', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const Broken = () => { throw new Error('render failure'); };
  render(<ErrorBoundary><Broken /></ErrorBoundary>);
  expect(screen.getByRole('heading', { name: '页面暂时无法显示' })).toBeVisible();
  expect(screen.getByRole('button', { name: '刷新页面' })).toBeVisible();
});
it('does not steal the route when a delayed create resolves after browser back', async () => {
  const date = '2026-10-10T00:00:00Z'; const existing: Conversation = { id: 'existing', title: '原来的对话', createdAt: date, updatedAt: date, messages: [] };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['conversations'], [existing]); client.setQueryData(['conversation', 'existing'], existing);
  let resolve!: (c: Conversation) => void;
  vi.spyOn(api, 'create').mockImplementation(() => new Promise<Conversation>(done => { resolve = done; }));
  vi.spyOn(api, 'generate').mockRejectedValue(new Error('不应提交生成'));
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/chat/existing', '/']}><HistoryBack /><Routes><Route path="/" element={<App />} /><Route path="/chat/:conversationId" element={<App />} /></Routes></MemoryRouter></QueryClientProvider>);
  fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '新消息' } }); fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  fireEvent.click(screen.getByRole('button', { name: '浏览器后退' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: '原来的对话' })).toBeVisible());
  resolve({ ...existing, id: 'new', title: '新消息' });
  await new Promise(done => setTimeout(done, 30));
  expect(screen.getByRole('heading', { name: '原来的对话' })).toBeVisible(); expect(useUI.getState().busy).toBe(false);
});
