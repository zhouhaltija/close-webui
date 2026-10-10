import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MessageView } from './Messages';
import type { Message } from '../core/types';
const message: Message = { id: 'a', conversationId: 'c', role: 'assistant', content: '你好\n\n```typescript\nconst greeting = "你好";\n```', status: 'completed', createdAt: '2026-10-10T00:00:00Z' };
it('copies the raw code instead of rendered markup', async () => {
  let clipboard = '';
  vi.stubGlobal('navigator', { clipboard: { writeText: async (text: string) => { clipboard = text; } } });
  render(<MessageView message={message} canRetry={false} onRetry={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '复制代码' }));
  await waitFor(() => expect(clipboard).toBe('const greeting = "你好";'));
  expect(screen.getByText('已复制')).toBeVisible(); vi.unstubAllGlobals();
});
it('shows clipboard failure and keeps incomplete Markdown readable', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('unavailable'); } } });
  render(<MessageView message={{ ...message, content: '```typescript\nconst greeting = "你好";' }} canRetry={false} onRetry={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '复制代码' }));
  expect(await screen.findByText('复制失败，请手动选择文本')).toBeVisible(); expect(screen.getByText('const greeting = "你好";')).toBeVisible(); vi.unstubAllGlobals();
});
