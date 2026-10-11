import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const password = 'Test-password-123';
const identity = () => `test_${randomUUID().replaceAll('-', '').slice(0, 18)}`;

async function register(page: Page, username = identity()) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '登录 CloseWebUI' })).toBeVisible();
  await page.getByRole('button', { name: '没有账号？注册' }).click();
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '注册并登录' }).click();
  await expect(page.locator('.welcome h2')).toBeVisible();
  return username;
}

async function configure(page: Page) {
  const response = await page.request.get('/__test/upstream');
  expect(response.ok()).toBe(true);
  const upstream = await response.json() as { url: string };
  await page.goto('/settings/providers');
  await page.getByRole('button', { name: '添加供应商' }).click();
  const providerDialog = page.getByRole('dialog', { name: '添加供应商' });
  await expect(providerDialog).toBeVisible({ timeout: 5000 });
  await providerDialog.getByRole('combobox', { name: '模板', exact: true }).selectOption('custom', { timeout: 5000 });
  await providerDialog.getByLabel('名称', { exact: true }).fill('本地测试供应商');
  await providerDialog.getByRole('combobox', { name: '接口协议', exact: true }).selectOption('openai-chat');
  await providerDialog.getByLabel('接口地址', { exact: true }).fill(upstream.url);
  await providerDialog.getByLabel('API 密钥', { exact: true }).fill('synthetic-key');
  await providerDialog.getByRole('button', { name: '保存供应商' }).click();
  await expect(providerDialog).not.toBeVisible();
  await expect(page.getByText('密钥已配置', { exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('link', { name: '模型', exact: true }).click();
  await page.getByLabel('发现模型的供应商', { exact: true }).selectOption({ label: '本地测试供应商' });
  await page.getByRole('button', { name: '发现模型', exact: true }).click();
  await page.locator('.candidate').filter({ hasText: 'gpt-5.1' }).click();
  const modelDialog = page.getByRole('dialog', { name: '添加模型' });
  await expect(modelDialog.getByLabel('模型 ID', { exact: true })).toHaveValue('gpt-5.1');
  await modelDialog.getByLabel('显示名称', { exact: true }).fill('GPT 5.1 测试');
  await modelDialog.getByRole('button', { name: '保存模型' }).click();
  await expect(modelDialog).not.toBeVisible();
  await page.getByRole('button', { name: '编辑模型GPT 5.1 测试', exact: true }).click();
  const editDialog = page.getByRole('dialog', { name: '编辑模型' });
  await editDialog.getByRole('combobox', { name: '思考档位', exact: true }).selectOption('medium');
  await editDialog.getByRole('button', { name: '保存模型' }).click();
  await expect(editDialog).not.toBeVisible();
  await page.getByRole('button', { name: '设为默认', exact: true }).click();
  await expect(page.getByText('默认模型', { exact: true })).toBeVisible();
}

async function send(page: Page, content: string) {
  await page.getByRole('textbox', { name: '输入消息', exact: true }).fill(content);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+$/);
}

test('real Go registers, configures native reasoning, persists chat, retries, stops and isolates users', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const first = await register(page);
  await expect(page.getByRole('link', { name: '配置模型', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('没有模型时暂不发送');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await configure(page);
  await page.getByRole('link', { name: '返回聊天', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择真实模型：GPT 5.1 测试', exact: true })).toBeVisible();
  const content = `保存我的测试对话 ${randomUUID().slice(0, 8)}`;
  await send(page, content);
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'completed');
  const address = page.url(); const conversationId = address.split('/').at(-1)!;
  await page.reload();
  await expect(page.getByTestId('message-user')).toHaveText(content);
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'completed');
  const stored = await page.request.get(`/api/conversations/${conversationId}`);
  expect(stored.ok()).toBe(true);
  const conversation = await stored.json() as { messages: { role: string; modelId?: string; generationId?: string; reasoning?: { effort: string } }[] };
  expect(conversation.messages.find(message => message.role === 'assistant')).toMatchObject({ modelId: expect.any(String), generationId: expect.any(String), reasoning: { effort: 'medium' } });

  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await send(page, `[failure] ${randomUUID()}`);
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'failed');
  await page.getByRole('button', { name: '重试回答', exact: true }).click();
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'completed');
  await expect(page.getByTestId('message-user')).toHaveCount(1);
  await expect(page.getByTestId('message-assistant')).toHaveCount(1);

  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await send(page, `[slow] ${randomUUID()}`);
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'streaming');
  const stopResponse = page.waitForResponse(response => response.url().endsWith('/stop') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  expect((await stopResponse).status()).toBe(204);
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'stopped');
  await page.reload();
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'stopped');
  await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('属于第一位用户的私有草稿');
  await page.getByRole('button', { name: `账户菜单：${first}`, exact: true }).click();
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录 CloseWebUI' })).toBeVisible();
  const second = await register(page);
  await expect(page.getByRole('button', { name: `账户菜单：${second}`, exact: true })).toBeVisible();
  await expect(page.getByText('还没有对话', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toHaveValue('');
  await expect(page.getByRole('link', { name: '配置模型', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('closewebui:data:v1'))).toBeNull();
  expect(errors).toEqual([]);
});

for (const width of [1440, 1024, 390]) {
  test(`settings ${width}px support keyboard dialogs and have no horizontal overflow`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    await register(page); await configure(page);
    await mkdir('test-results/screenshots', { recursive: true });
    for (const section of ['providers', 'models', 'account']) {
      await page.goto(`/settings/${section}`);
      await expect(page.getByRole('navigation', { name: '设置分类' })).toBeVisible();
      const main = page.getByRole('main'); await expect(main.getByRole('heading', { level: 1 })).toBeVisible();
      if (section === 'providers') await expect(main.getByRole('heading', { name: '本地测试供应商', exact: true })).toBeVisible();
      if (section === 'models') await expect(main.getByRole('heading', { name: 'GPT 5.1 测试', exact: true })).toBeVisible();
      if (section === 'account') await expect(main.getByLabel('确认新密码', { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/screenshots/backend-settings-${section}-${width}.png`, fullPage: true });
      if (section === 'providers') {
        const trigger = page.getByRole('button', { name: '添加供应商', exact: true });
        await trigger.focus(); await page.keyboard.press('Enter');
        await expect(page.getByRole('dialog', { name: '添加供应商' })).toBeVisible();
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
      }
    }
  });
}
