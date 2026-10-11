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

/** Adds a provider through the inline workspace form, then batch-adds and defaults a discovered model. */
async function configure(page: Page) {
  const response = await page.request.get('/__test/upstream');
  expect(response.ok()).toBe(true);
  const upstream = await response.json() as { url: string };
  await page.goto('/settings/providers');
  await page.getByRole('button', { name: '添加供应商', exact: true }).click();
  const detail = page.locator('.provider-detail');
  await expect(detail.getByRole('heading', { name: '添加供应商' })).toBeVisible();
  await detail.getByLabel('名称', { exact: true }).fill('本地测试供应商');
  await detail.getByLabel('接口地址', { exact: true }).fill(upstream.url);
  await detail.getByLabel('API 密钥', { exact: true }).fill('synthetic-key');
  await detail.getByRole('button', { name: '保存供应商' }).click();
  // Saving a provider for the first time pulls its models once.
  await expect(page.getByText('上游返回', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.getByText('synthetic-key', { exact: true })).toHaveCount(0);
  const candidate = page.locator('.candidate').filter({ hasText: 'gpt-5.1' });
  await expect(candidate).toBeVisible({ timeout: 20000 });
  await candidate.locator('input[type="checkbox"]').check();
  await page.getByRole('button', { name: '批量添加', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '批量添加完成' })).toBeVisible({ timeout: 20000 });
  const row = page.locator('.model-row').filter({ hasText: 'gpt-5.1' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /设为默认/ }).click();
  await expect(row.getByText('默认模型', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '返回聊天', exact: true }).click();
  await expect(page.getByRole('button', { name: /选择真实模型/ })).toBeVisible();
}

test('the composer model menu is an anchored dropdown with checks and a native thinking submenu', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await register(page); await configure(page);
  const trigger = page.getByRole('button', { name: /选择真实模型/ });
  await expect(trigger).toBeVisible();
  await trigger.click();
  // Anchored dropdown, not the previous centred dialog.
  await expect(page.getByRole('menu')).toBeVisible();
  expect(await page.locator('.overlay').count()).toBe(0);
  expect(await page.locator('[role="dialog"]').count()).toBe(0);
  const checked = page.locator('.model-option[aria-checked="true"]');
  await expect(checked).toHaveCount(1);
  await expect(checked).toContainText('gpt-5.1');
  await expect(page.getByRole('link', { name: '管理供应商与模型' })).toBeVisible();
  const box = (await page.locator('.model-menu').boundingBox())!;
  const triggerBox = (await trigger.boundingBox())!;
  expect(Math.abs(box.y + box.height - (triggerBox.y + triggerBox.height))).toBeLessThan(24);
  // Native thinking controls live in the submenu, and the draft survives the switch.
  await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('保留这段草稿');
  await page.getByText('思考设置', { exact: true }).click();
  await expect(page.getByLabel('思考档位')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toHaveValue('保留这段草稿');
  await mkdir('test-results/screenshots', { recursive: true });
  await page.screenshot({ path: 'test-results/screenshots/fix-model-menu-1440.png' });
  expect(errors).toEqual([]);
});

test('the account menu row is clickable across its whole width', async ({ page }) => {
  test.setTimeout(120_000);
  const username = await register(page);
  await page.getByRole('button', { name: `账户菜单：${username}`, exact: true }).click();
  const settings = page.getByRole('menuitem', { name: '设置' });
  await expect(settings).toBeVisible();
  const box = (await settings.boundingBox())!;
  expect(box.width).toBeGreaterThan(120);
  // Left edge, middle, right edge and the inner padding: every hit navigates.
  for (const [x, y] of [[box.x + 2, box.y + box.height / 2], [box.x + box.width / 2, box.y + box.height / 2], [box.x + box.width - 2, box.y + box.height / 2], [box.x + box.width - 8, box.y + 3]] as const) {
    await page.getByRole('button', { name: `账户菜单：${username}`, exact: true }).click();
    await expect(settings).toBeVisible();
    await page.mouse.click(x, y);
    await expect(page).toHaveURL(/\/settings\/providers/);
    await page.goto('/');
    await expect(page.locator('.welcome h2')).toBeVisible();
  }
  // The separator and the outside of the menu must not trigger a logout.
  await page.getByRole('button', { name: `账户菜单：${username}`, exact: true }).click();
  const menu = (await page.locator('.dropdown').last().boundingBox())!;
  await page.mouse.click(menu.x + menu.width / 2, menu.y - 12);
  await expect(page.getByRole('menuitem', { name: '退出登录' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.welcome h2')).toBeVisible();
});

for (const width of [1440, 1024, 390]) {
  test(`the provider workspace keeps its panes reachable at ${width}px`, async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    await register(page); await configure(page);
    await page.goto('/settings/providers');
    await expect(page.getByRole('navigation', { name: '设置分类' })).toBeVisible();
    await expect(page.getByRole('button', { name: '添加供应商', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '本地测试供应商', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '拉取模型', exact: true })).toBeVisible();
    await expect(page.locator('.model-row').filter({ hasText: 'gpt-5.1' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await mkdir('test-results/screenshots', { recursive: true });
    await page.screenshot({ path: `test-results/screenshots/fix-provider-workspace-${width}.png`, fullPage: true });
    if (width === 390) {
      // Narrow screens switch between list and detail instead of squeezing three columns.
      await page.getByRole('button', { name: '返回供应商列表' }).click();
      await expect(page.getByRole('button', { name: '添加供应商', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  });
}
