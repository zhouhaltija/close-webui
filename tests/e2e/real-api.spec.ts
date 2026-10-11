import { expect, test } from '@playwright/test';

test('disabled Mock uses the configured API and preserves input on service failure', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('closewebui:data:v1', '{untouched'));
  const paths: string[] = [];
  await page.route('**/integration-api/**', async route => {
    paths.push(new URL(route.request().url()).pathname);
    await route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: '服务暂时不可用。' } } });
  });
  await page.goto('/?mockScenario=failure');
  await expect(page.getByText('无法加载历史')).toBeVisible();
  await page.getByRole('textbox', { name: '输入消息' }).fill('保留这条输入');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.getByRole('alert')).toHaveText('服务暂时不可用。');
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('保留这条输入');
  await expect(page.getByTestId('message-assistant')).toHaveCount(0);
  expect(paths).toEqual(['/integration-api/conversations', '/integration-api/conversations']);
  expect(await page.evaluate(() => localStorage.getItem('closewebui:data:v1'))).toBe('{untouched');
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
});

test('disabled Mock presents Chinese feedback for a disconnected service', async ({ page }) => {
  await page.route('**/integration-api/**', route => route.abort('failed'));
  await page.goto('/'); await expect(page.getByText('无法加载历史')).toBeVisible();
  await page.getByRole('textbox', { name: '输入消息' }).fill('重新连接后发送');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.getByRole('alert')).toHaveText('无法连接服务，请稍后重试。');
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('重新连接后发送');
});

test('disabled Mock reads service NDJSON without using the fixed fixture', async ({ page }) => {
  const date = '2026-10-10T00:00:00Z';
  const conversation = { id: 'service-chat', title: '接口对话', createdAt: date, updatedAt: date, messages: [] };
  await page.route('**/integration-api/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (path.endsWith('/generations')) {
      const { assistantMessageId } = request.postDataJSON();
      await route.fulfill({ contentType: 'application/x-ndjson', body: `${JSON.stringify({ type: 'delta', assistantMessageId, content: '来自服务的独立回答' })}\n${JSON.stringify({ type: 'done', assistantMessageId })}\n` });
    } else await route.fulfill({ status: request.method() === 'POST' ? 201 : 200, json: path.endsWith('/conversations') && request.method() === 'GET' ? [] : conversation });
  });
  await page.goto('/?mockScenario=failure');
  await page.getByRole('textbox', { name: '输入消息' }).fill('接口对话');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page).toHaveURL('/chat/service-chat');
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'completed');
  await expect(page.getByTestId('message-assistant')).toContainText('来自服务的独立回答');
  await expect(page.getByTestId('message-user')).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem('closewebui:data:v1'))).toBeNull();
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
});
