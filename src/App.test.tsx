import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { api } from './core/api';
import { useUI } from './core/ui-store';
import type { Conversation } from './core/types';
afterEach(() => { vi.restoreAllMocks(); useUI.setState({ busy: false, error: '', drafts: {}, mobileOpen: false }); });
function HistoryBack() { const navigate = useNavigate(); return <button onClick={() => navigate(-1)}>浏览器后退</button>; }
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
