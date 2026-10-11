import { expect, test } from '@playwright/test';
import { referenceHistory } from '../visual/reference-history';

test.use({ timezoneId: 'Asia/Shanghai' });
test('search and title sorting do not rewrite saved history', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('closewebui:data:v1', JSON.stringify({ version: 1, conversations: [
      { id: 'beta', title: 'Beta notes', createdAt: '2026-10-10T01:00:00Z', updatedAt: '2026-10-10T01:00:00Z', messages: [] },
      { id: 'alpha', title: 'Alpha notes', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', messages: [] },
    ] }));
  });
  await page.goto('/');
  const saved = await page.evaluate(() => localStorage.getItem('closewebui:data:v1'));
  const history = page.getByRole('navigation', { name: '历史对话' }).locator('.history-link');
  await expect(history).toHaveText(['Beta notes', 'Alpha notes']);
  await page.getByRole('button', { name: '历史排序' }).click(); await page.getByRole('menuitemradio', { name: '按标题排序' }).click();
  await expect(history).toHaveText(['Alpha notes', 'Beta notes']);
  const search = page.getByRole('button', { name: '搜索对话' }); await search.click();
  await page.getByRole('textbox', { name: '搜索对话标题' }).fill('BETA');
  const dialog = page.getByRole('dialog', { name: '搜索对话' });
  await expect(dialog.getByRole('button', { name: 'Alpha notes' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Beta notes' }).click();
  await expect(page).toHaveURL('/chat/beta'); await expect(page.getByRole('heading', { name: 'Beta notes' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('closewebui:data:v1'))).toBe(saved);
});

test('reference home geometry and populated sidebar at 1878×983', async ({ page }) => {
  await page.setViewportSize({ width: 1878, height: 983 });
  await page.clock.install({ time: new Date('2026-10-09T16:30:00Z') });
  await page.addInitScript(history => { Math.random = () => 0; localStorage.setItem('closewebui:data:v1', JSON.stringify({ version: 1, conversations: history })); }, referenceHistory);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '深夜即兴时刻。' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '历史对话' }).locator('.history-link')).toHaveCount(22);
  await page.screenshot({ path: 'test-results/screenshots/reference-home-1878.png', fullPage: true });
  const sidebar = await page.locator('.desktop-sidebar').boundingBox();
  const composer = await page.locator('.composer-home').boundingBox();
  expect(sidebar?.width).toBe(288);
  expect(composer?.x).toBeCloseTo(762, 0); expect(composer?.y).toBeCloseTo(388, 0);
  expect(composer?.width).toBe(642); expect(composer?.height).toBe(105);
  await expect(page.getByRole('button', { name: '发送消息' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cowork', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'CloseWebUI 首页' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('model and effort menus preserve the draft and omit subscription content', async ({ page }) => {
  await page.goto('/'); const input = page.getByRole('textbox', { name: '输入消息' });
  await input.fill('保留这段草稿');
  const greeting = await page.locator('.welcome h2').innerText();
  const model = page.getByRole('button', { name: '选择模型和努力程度' });
  await model.click(); await page.getByRole('menuitemradio', { name: /Opus 5.5/ }).click();
  await expect(model).toContainText('Opus 5.5'); await expect(model).toBeFocused();
  await model.click(); await page.getByRole('menuitem', { name: /努力程度/ }).hover();
  await page.getByRole('menuitemradio', { name: '高', exact: true }).click();
  await expect(model).toContainText('高'); await expect(input).toHaveValue('保留这段草稿');
  await model.click(); await page.getByRole('menuitem', { name: /努力程度/ }).hover();
  await expect(page.getByRole('menuitemradio', { name: '最高', exact: true })).toBeVisible();
  await expect(page.getByText(/更多模型|Pro|Max|升级|额度|用量达/)).toHaveCount(0);
  await page.screenshot({ path: 'test-results/screenshots/model-effort-menu.png' });
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await expect(model).toBeFocused();
  await expect(input).toHaveValue('保留这段草稿');
  await expect(page.locator('.welcome h2')).toHaveText(greeting);
  await input.press('Enter'); await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'completed');
  await expect(page.getByRole('button', { name: '选择模型和努力程度' })).toContainText('Opus 5.5');
  await expect(page.getByRole('button', { name: '选择模型和努力程度' })).toContainText('高');
});

test('model menu and effort submenu stay within a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await page.getByRole('button', { name: '选择模型和努力程度' }).click();
  await page.getByRole('menuitem', { name: /努力程度/ }).hover();
  await expect(page.getByRole('menuitemradio', { name: '最高', exact: true })).toBeVisible();
  for (const selector of ['.model-menu', '.effort-menu']) {
    const bounds = await page.locator(selector).boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  }
  await page.getByRole('menuitemradio', { name: '最高', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择模型和努力程度' })).toContainText('最高');
});
