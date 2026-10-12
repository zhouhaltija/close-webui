import { expect, test, type Page, type Route } from '@playwright/test';

const now = '2026-10-11T00:00:00Z';
const model = { id: 'm1', providerId: 'p1', modelId: 'gpt-5.1', name: '测试模型', enabled: true, maxOutputTokens: 4096, defaultReasoning: { effort: 'medium' }, capabilities: { family: 'OpenAI', efforts: ['minimal', 'low', 'medium', 'high'], supportsToggle: false, mandatory: true, budgetMin: 0, budgetMax: 0, budgetSupported: false, outputMax: 4096, sources: [], known: true } };
const conversation = { id: 'c1', title: '问题', createdAt: now, updatedAt: now, messages: [] as unknown[] };

/** Identity, model and preference endpoints plus a controllable conversation lifecycle. */
async function stub(page: Page, options: { createDelay?: number; generateDelay?: number; generateStatus?: number; stopStatus?: number } = {}) {
  await page.route('**/integration-api/**', async (route: Route) => {
    const url = new URL(route.request().url()); const path = url.pathname; const method = route.request().method();
    if (path.endsWith('/auth/me')) return void await route.fulfill({ json: { id: 'u1', username: 'test_user' } });
    if (path.endsWith('/models')) return void await route.fulfill({ json: [model] });
    if (path.endsWith('/providers')) return void await route.fulfill({ json: [{ id: 'p1', name: '测试供应商', protocol: 'openai-chat', adapter: 'standard', baseUrl: 'https://example.com/v1', templateId: 'custom', enabled: true, hasKey: true }] });
    if (path.endsWith('/preferences')) return void await route.fulfill({ json: { defaultModelId: 'm1' } });
    if (path === '/integration-api/conversations' && method === 'POST') { if (options.createDelay) await new Promise(resolve => setTimeout(resolve, options.createDelay)); return void await route.fulfill({ json: conversation }); }
    if (path === '/integration-api/conversations' && method === 'GET') return void await route.fulfill({ json: [] });
    if (path === '/integration-api/conversations/c1') return void await route.fulfill({ json: conversation });
    if (/\/generations\/[^/]+\/stop$/.test(path)) return void await route.fulfill(options.stopStatus && options.stopStatus >= 400 ? { status: options.stopStatus, json: { error: { code: 'STOP_FAILED', message: '尚未确认停止。' } } } : { status: 204 });
    if (path.endsWith('/generations')) {
      if (options.generateDelay) await new Promise(resolve => setTimeout(resolve, options.generateDelay));
      if (options.generateStatus && options.generateStatus >= 400) return void await route.fulfill({ status: options.generateStatus, json: { error: { code: 'UPSTREAM_FAILED', message: '上游拒绝了这次生成。' } } });
      const { assistantMessageId } = route.request().postDataJSON() as { assistantMessageId: string };
      const body = `${JSON.stringify({ type: 'delta', assistantMessageId, content: '第一段' })}\n${JSON.stringify({ type: 'done', assistantMessageId })}\n`;
      return void await route.fulfill({ status: 200, contentType: 'application/x-ndjson; charset=utf-8', body });
    }
    return void await route.fulfill({ json: [] });
  });
}

test('a slow create and a slow submit still show the message within 100ms', async ({ page }) => {
  await stub(page, { createDelay: 2000, generateDelay: 2000 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '选择真实模型：测试模型' })).toBeVisible();
  await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('这是一个很长的提交内容');
  await page.evaluate(() => {
    const w = window as unknown as { __t0: number; __preview: number; __welcome: number; __awaiting: number };
    w.__t0 = performance.now(); w.__preview = 0; w.__welcome = 0; w.__awaiting = 0;
    new MutationObserver(() => {
      if (!w.__preview && document.querySelector('[data-testid="message-user"]')) w.__preview = performance.now();
      if (document.querySelector('.welcome') && document.querySelector('[data-testid="message-user"]')) w.__welcome = performance.now();
      if (!w.__awaiting && document.querySelector('.assistant-message .markdown[data-phase="awaiting"]')) w.__awaiting = 1;
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-phase'] });
    document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click();
  });
  await expect(page.getByTestId('message-user')).toBeVisible();
  const measured = await page.evaluate(() => {
    const w = window as unknown as { __t0: number; __preview: number; __welcome: number; __awaiting: number };
    return { preview: w.__preview - w.__t0, welcome: w.__welcome ? w.__welcome - w.__t0 : -1, awaiting: w.__awaiting };
  });
  expect(measured.preview).toBeGreaterThan(0);
  expect(measured.preview).toBeLessThanOrEqual(100);
  // The empty welcome page must never be shown together with the preview.
  expect(measured.welcome).toBe(-1);
  await expect(page.locator('.assistant-message .markdown')).toHaveAttribute('data-phase', 'submitting');
  await expect(page.getByText('正在提交…')).toBeVisible();
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'completed', { timeout: 15000 });
  await expect(page.getByTestId('message-assistant')).toContainText('第一段');
  // One user message and one assistant message: the preview was merged by ID.
  await expect(page.getByTestId('message-user')).toHaveCount(1);
  await expect(page.getByTestId('message-assistant')).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toHaveValue('');
});

test('a rejected submission removes unsaved messages and the next send does not duplicate them', async ({ page }) => {
  const options = { createDelay: 200, generateStatus: 400 };
  await stub(page, options);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '选择真实模型：测试模型' })).toBeVisible();
  await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('这条消息会被拒绝');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('上游拒绝了这次生成', { timeout: 10000 });
  await expect(page.getByTestId('message-user')).toHaveCount(0);
  await expect(page.getByTestId('message-assistant')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toHaveValue('这条消息会被拒绝');
  options.generateStatus = 200;
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'completed');
  await expect(page.getByTestId('message-user')).toHaveCount(1);
  await expect(page.getByTestId('message-assistant')).toHaveCount(1);
});

test('an unknown submission blocks resend until its original generation is cancelled and reconciled', async ({ page }) => {
  const options = { generateStatus: 500, stopStatus: 503 };
  await stub(page, options);
  let submissions = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/generations')) submissions++; });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '选择真实模型：测试模型' })).toBeVisible();
  await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('未确认的原消息');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('提交结果尚未确认');
  await expect(page.getByRole('button', { name: '核对提交状态', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: '输入消息', exact: true }).press('Enter');
  expect(submissions).toBe(1);
  options.stopStatus = 204;
  await page.getByRole('button', { name: '核对提交状态', exact: true }).click();
  await expect(page.getByRole('button', { name: '核对提交状态', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toHaveValue('未确认的原消息');
  options.generateStatus = 200;
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'completed');
  await expect(page.getByTestId('message-user')).toHaveCount(1);
  expect(submissions).toBe(2);
});

test('stopping before the server conversation exists neither navigates nor resurrects the preview', async ({ page }) => {
  await stub(page, { createDelay: 4000 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '选择真实模型：测试模型' })).toBeVisible();
  await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('在创建前停止');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('正在提交…')).toBeVisible();
  // A direct click on the stop button (no Playwright hit-test round trip) must not
  // also submit the composer, and the late create must not resurrect the preview.
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[aria-label="停止生成"]')!.click());
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible();
  await page.waitForTimeout(4500);
  await expect(page.getByTestId('message-user')).toHaveCount(0);
  await expect(page.locator('.welcome h2')).toBeVisible();
  await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toHaveValue('在创建前停止');
});
