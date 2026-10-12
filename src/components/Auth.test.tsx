import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthBoundary, UserMenu } from './Auth';

afterEach(() => vi.unstubAllGlobals());

async function openAccountMenu() {
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.endsWith('/auth/me')) return Response.json({ id: 'user-test', username: 'test_account' });
    if (url.endsWith('/auth/logout')) return new Response(null, { status: 204 });
    throw new Error(`Unexpected account request: ${url}`);
  });
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><MemoryRouter><AuthBoundary><p>会话仍有效</p><UserMenu /></AuthBoundary></MemoryRouter></QueryClientProvider>);
  fireEvent.pointerDown(await screen.findByRole('button', { name: '账户菜单：test_account' }), { button: 0, ctrlKey: false });
  vi.spyOn(screen.getByRole('menu'), 'getBoundingClientRect').mockReturnValue(new DOMRect(217, 132, 140, 80));
  return screen.getByRole('menuitem', { name: '退出登录' });
}

function startTouch(target: Element, x = 281) {
  const point: Touch = { identifier: 1, target, clientX: x, clientY: 170, pageX: x, pageY: 170, screenX: x, screenY: 170, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1 };
  return new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [point], targetTouches: [point], changedTouches: [point] });
}

it('keeps the session when a separator touch would otherwise synthesize a neighboring logout click', async () => {
  const logout = await openAccountMenu();
  const separator = screen.getByRole('separator');
  vi.spyOn(separator, 'getBoundingClientRect').mockReturnValue(new DOMRect(200, 169.5, 162, 1));
  const touch = startTouch(logout);
  await act(async () => {
    // Chromium's physical-tap trace retargeted this thin, noninteractive
    // separator's default compatibility click to the adjacent logout item.
    // jsdom has no touch adjustment, so replay only that observed default action.
    if (logout.dispatchEvent(touch)) fireEvent.click(logout);
  });
  expect(screen.getByText('会话仍有效')).toBeVisible();
  expect(screen.getByRole('menuitem', { name: '退出登录' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: '登录 CloseWebUI' })).not.toBeInTheDocument();
});

it('dismisses an outside touch retargeted to a menu action without logging out', async () => {
  const logout = await openAccountMenu();
  await act(async () => { if (logout.dispatchEvent(startTouch(logout, 209))) fireEvent.click(logout); });
  expect(screen.getByText('会话仍有效')).toBeVisible();
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '账户菜单：test_account' })).toBeVisible();
});

it.each(['touch', 'keyboard'] as const)('still logs out when the logout item is deliberately selected by %s', async input => {
  const logout = await openAccountMenu();
  await act(async () => {
    if (input === 'touch') {
      const touch = startTouch(logout);
      if (logout.dispatchEvent(touch)) fireEvent.click(logout);
    } else fireEvent.keyDown(logout, { key: 'Enter' });
  });
  expect(await screen.findByRole('heading', { name: '登录 CloseWebUI' })).toBeVisible();
  expect(screen.queryByText('会话仍有效')).not.toBeInTheDocument();
});
