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

for (const width of [1440, 1024, 390]) {
  test.describe(`menus at ${width}px`, () => {
    test.use({ hasTouch: width === 390 });
    test(`the composer model menu is an anchored dropdown with checks and a native thinking submenu at ${width}px`, async ({ page }) => {
      test.setTimeout(150_000);
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
      await register(page); await configure(page);
      const composer = page.getByRole('textbox', { name: '输入消息', exact: true });
      await composer.fill('保留这段草稿');
      const trigger = page.getByRole('button', { name: /选择真实模型/ });
      await expect(trigger).toBeVisible();
      // Radix hides the background from accessible role queries while its modal
      // menu is open; measure its trigger before opening the layer.
      const triggerBox = (await trigger.boundingBox())!;
      if (width === 390) await trigger.tap();
      else await trigger.click();
      const menu = page.locator('.model-menu');
      // Anchored dropdown, not the previous centred dialog.
      await expect(menu).toBeVisible();
      expect(await page.locator('.overlay').count()).toBe(0);
      expect(await page.locator('[role="dialog"]').count()).toBe(0);
      const checked = page.locator('.model-option[aria-checked="true"]');
      await expect(checked).toHaveCount(1);
      await expect(checked).toContainText('gpt-5.1');
      await expect(page.getByRole('link', { name: '管理供应商与模型' })).toBeVisible();
      const box = (await menu.boundingBox())!;
      const side = await menu.getAttribute('data-side');
      expect(['top', 'bottom']).toContain(side);
      const gap = side === 'top' ? triggerBox.y - (box.y + box.height) : box.y - (triggerBox.y + triggerBox.height);
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThan(24);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await mkdir('test-results/screenshots', { recursive: true });
      await page.screenshot({ path: `test-results/screenshots/fix-model-menu-${width}.png` });
      // Cross into the submenu with the pointer, then edit a real native control.
      const thinking = menu.getByRole('menuitem', { name: /思考设置/ });
      if (width === 390) await thinking.tap();
      else await thinking.hover();
      const submenu = page.locator('.effort-menu-native');
      await expect(submenu).toBeVisible();
      if (width !== 390) await submenu.hover();
      await expect(submenu).toBeVisible();
      const submenuBox = (await submenu.boundingBox())!;
      expect(submenuBox.x).toBeGreaterThanOrEqual(0);
      expect(submenuBox.x + submenuBox.width).toBeLessThanOrEqual(width);
      const effort = submenu.getByRole('combobox', { name: '思考档位', exact: true });
      await expect(effort).toBeVisible();
      await effort.selectOption('medium');
      await expect(effort).toHaveValue('medium');
      await page.screenshot({ path: `test-results/screenshots/fix-model-submenu-${width}.png` });
      // ArrowLeft closes only the sublayer; Escape closes the whole menu and
      // restores the composer trigger even when pressed inside the sublayer.
      await effort.focus();
      await page.keyboard.press('ArrowLeft');
      await expect(submenu).toBeHidden();
      await expect(menu).toBeVisible();
      await expect(thinking).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(submenu).toBeVisible();
      await effort.focus();
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="menu"]'))).toBe(true);
      await page.keyboard.press('Escape');
      await expect(submenu).toBeHidden();
      await expect(menu).toBeHidden();
      await expect(trigger).toBeFocused();
      await expect(trigger).toContainText('中等');
      await expect(composer).toHaveValue('保留这段草稿');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.keyboard.press('ArrowDown');
      await expect(menu).toBeVisible();
      await expect(checked).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      expect(errors).toEqual([]);
    });

    test(`the account menu row is clickable across its whole width at ${width}px`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
      const username = await register(page);
      // The same account menu is in the settings header on narrow screens, where
      // the chat's desktop sidebar is intentionally hidden.
      await page.goto('/settings/account');
      const trigger = page.getByRole('button', { name: `账户菜单：${username}`, exact: true });
      const menu = page.locator('.dropdown');
      const settings = page.getByRole('menuitem', { name: '设置' });
      const logout = page.getByRole('menuitem', { name: '退出登录', exact: true });
      const logoutRequests: string[] = [];
      page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/auth/logout')) logoutRequests.push(request.url()); });
      // Measure each fresh open: navigation and responsive placement can move it.
      for (const hit of ['left', 'middle', 'right', 'padding'] as const) {
        if (width === 390) await trigger.tap();
        else await trigger.click();
        await expect(settings).toBeVisible();
        const box = (await settings.boundingBox())!;
        expect(box.width).toBeGreaterThan(120);
        const x = hit === 'left' ? box.x + 2 : hit === 'middle' ? box.x + box.width / 2 : box.x + box.width - (hit === 'right' ? 2 : 8);
        const y = hit === 'padding' ? box.y + 3 : box.y + box.height / 2;
        if (hit === 'left') {
          await mkdir('test-results/screenshots', { recursive: true });
          await page.screenshot({ path: `test-results/screenshots/fix-account-menu-${width}.png` });
        }
        if (width === 390) await page.touchscreen.tap(x, y);
        else await page.mouse.click(x, y);
        await expect(page).toHaveURL(/\/settings\/providers/);
        await expect(trigger).toBeVisible();
        await page.goto('/settings/account');
        await expect(page.getByLabel('确认新密码', { exact: true })).toBeVisible();
      }
      // The separator and the outside of the menu must not trigger a logout.
      if (width === 390) await trigger.tap();
      else await trigger.click();
      await expect(menu).toBeVisible();
      const separator = (await menu.getByRole('separator').boundingBox())!;
      if (width === 390) await page.touchscreen.tap(separator.x + separator.width / 2, separator.y + separator.height / 2);
      else await page.mouse.click(separator.x + separator.width / 2, separator.y + separator.height / 2);
      await expect(logout).toBeVisible();
      await expect(page).toHaveURL(/\/settings\/account/);
      const menuBox = (await menu.boundingBox())!;
      const outsideX = menuBox.x > 16 ? menuBox.x - 8 : menuBox.x + menuBox.width + 8;
      if (width === 390) await page.touchscreen.tap(outsideX, menuBox.y + menuBox.height / 2);
      else await page.mouse.click(outsideX, menuBox.y + menuBox.height / 2);
      await expect(menu).toBeHidden();
      await expect(trigger).toBeVisible();
      await expect(page.getByLabel('确认新密码', { exact: true })).toBeVisible();
      // Arrow keys reach both actions; Tab stays in the menu and Escape restores focus.
      await trigger.focus();
      await page.keyboard.press('ArrowDown');
      await expect(settings).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(logout).toBeFocused();
      await page.keyboard.press('ArrowUp');
      await expect(settings).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(settings).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(trigger).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(settings).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/settings\/providers/);
      expect(logoutRequests).toEqual([]);
      await page.goto('/');
      await expect(page.locator('.welcome h2')).toBeVisible();
    });
  });
}

for (const width of [1440, 1024, 390]) {
  test(`the provider workspace keeps its panes reachable at ${width}px`, async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    await register(page); await configure(page);
    await page.goto('/settings/providers');
    await expect(page.getByRole('navigation', { name: '设置分类' })).toBeVisible();
    await expect(page.getByRole('button', { name: '添加供应商', exact: true })).toBeVisible();
    const provider = page.locator('.provider-row').filter({ hasText: '本地测试供应商' });
    await expect(provider).toHaveCount(1);
    if (width === 390) {
      await expect(page.locator('.provider-workspace')).toHaveAttribute('data-view', 'list');
      await expect(page.getByRole('heading', { name: '本地测试供应商', exact: true })).toBeHidden();
      await provider.click();
      await expect(page.locator('.provider-workspace')).toHaveAttribute('data-view', 'detail');
    }
    await expect(page.getByRole('heading', { name: '本地测试供应商', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '拉取模型', exact: true })).toBeVisible();
    await expect(page.locator('.model-row').filter({ hasText: 'gpt-5.1' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await mkdir('test-results/screenshots', { recursive: true });
    await page.screenshot({ path: `test-results/screenshots/fix-provider-workspace-${width}.png`, fullPage: true });
    if (width === 390) {
      // Narrow screens switch between list and detail instead of squeezing three columns.
      await page.getByRole('button', { name: '返回供应商列表' }).click();
      await expect(page.locator('.provider-workspace')).toHaveAttribute('data-view', 'list');
      await expect(page.getByRole('button', { name: '添加供应商', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: '本地测试供应商', exact: true })).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/screenshots/fix-provider-list-${width}.png`, fullPage: true });
      // Returning to the list must not make the already selected first row inert.
      await provider.click();
      await expect(page.getByRole('heading', { name: '本地测试供应商', exact: true })).toBeVisible();
    }
  });
}
