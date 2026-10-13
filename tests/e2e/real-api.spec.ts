import { expect, test, type Route } from '@playwright/test';

for (const width of [1440, 1024, 390]) {
  test(`login and registration keep a readable centered form at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.route(/\/(?:api|integration-api)\/auth\/me$/, route => route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED', message: '请先登录。' } } }));
    await page.goto('/');
    for (const registration of [false, true]) {
      if (registration) await page.getByRole('button', { name: '没有账号？注册' }).click();
      await expect(page.getByRole('heading', { name: registration ? '创建 CloseWebUI 账号' : '登录 CloseWebUI' })).toBeVisible();
      const form = page.locator('.auth-card');
      const box = (await form.boundingBox())!;
      expect(box.width).toBeLessThanOrEqual(420);
      expect(box.width).toBeGreaterThanOrEqual(300);
      expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThanOrEqual(1);
      for (const name of ['用户名', '密码']) {
        const input = page.getByLabel(name, { exact: true });
        await expect(input).toBeVisible();
        const inputBox = (await input.boundingBox())!;
        expect(inputBox.height).toBeGreaterThanOrEqual(40);
        expect(inputBox.width).toBeGreaterThanOrEqual(300);
        expect(await input.evaluate(el => getComputedStyle(el).borderTopWidth)).toBe('1px');
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  });
}

async function identityAndModels(route: Route) {
  const path = new URL(route.request().url()).pathname;
  if (path.endsWith('/auth/me')) { await route.fulfill({ json: { id: 'synthetic-user', username: 'synthetic_user' } }); return true; }
  if (path.endsWith('/providers')) { await route.fulfill({ json: [{ id: 'synthetic-provider', name: '接口测试供应商', templateId: 'custom', protocol: 'openai-chat', adapter: 'standard', baseUrl: 'https://example.invalid/v1', enabled: true, hasKey: true }] }); return true; }
  if (path.endsWith('/models')) { await route.fulfill({ json: [{ id: 'service-model', providerId: 'synthetic-provider', modelId: 'custom-text', name: '服务测试模型', enabled: true, maxOutputTokens: 4096, defaultReasoning: {}, capabilities: { family: '', efforts: [], supportsToggle: false, mandatory: false, budgetMin: 0, budgetMax: 0, budgetSupported: false, outputMax: 4096, sources: [], known: false } }] }); return true; }
  if (path.endsWith('/preferences')) { await route.fulfill({ json: { defaultModelId: 'service-model' } }); return true; }
  return false;
}

test('a refreshed page observes the saved terminal state without stopping a server-owned answer', async ({ page }) => {
  const date = '2026-10-13T00:00:00Z';
  const stops: string[] = []; let terminal = false;
  const conversation = { id: 'service-chat', title: '刷新恢复对话', createdAt: date, updatedAt: date };
  await page.route('**/integration-api/**', async route => {
    if (await identityAndModels(route)) return;
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/stop')) { stops.push(path); await route.fulfill({ status: 204 }); return; }
    if (path.endsWith('/conversations')) { await route.fulfill({ json: [conversation] }); return; }
    if (path.endsWith('/conversations/service-chat')) {
      await route.fulfill({ json: { ...conversation, messages: [
        { id: 'saved-user', conversationId: 'service-chat', role: 'user', content: '刷新前的问题', status: 'completed', createdAt: date },
        { id: 'saved-assistant', conversationId: 'service-chat', role: 'assistant', content: '数据库确认的前缀', status: terminal ? 'stopped' : 'streaming', generationId: 'old-generation', modelId: 'service-model', createdAt: date },
      ] } }); return;
    }
    throw new Error(`Unexpected recovery request: ${path}`);
  });
  await page.goto('/chat/service-chat');
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'streaming');
  await page.reload();
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'streaming');
  terminal = true;
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'stopped');
  await expect(page.getByRole('button', { name: '复制回答' })).toBeVisible();
  await expect(page.getByTestId('message-assistant')).toContainText('数据库确认的前缀');
  await expect(page.getByLabel('正在生成')).toHaveCount(0);
  expect(stops).toEqual([]);
});

test('disabled Mock uses the configured API and preserves input on service failure', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('closewebui:data:v1', '{untouched'));
  const paths: string[] = [];
  await page.route('**/integration-api/**', async route => {
    if (await identityAndModels(route)) return;
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
  await page.route('**/integration-api/**', async route => { if (await identityAndModels(route)) return; await route.abort('failed'); });
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
    if (await identityAndModels(route)) return;
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
