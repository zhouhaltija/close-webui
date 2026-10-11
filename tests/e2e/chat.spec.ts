import { expect, test } from '@playwright/test';

async function send(page: import('@playwright/test').Page, text = '帮我规划一个专注的工作日') {
  await page.getByRole('textbox', { name: '输入消息' }).fill(text);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
}

test('home chat, persistence, rename and deletion', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const external: string[] = [];
  page.on('request', request => { const url = new URL(request.url()); if (url.protocol.startsWith('http') && url.hostname !== 'localhost') external.push(url.origin); });
  await page.goto('/'); await expect(page.locator('.welcome h2')).toBeVisible();
  await expect(page.getByText('还没有对话')).toBeVisible(); await send(page, '开始我的一天');
  await expect(page).toHaveURL(/\/chat\//); await expect(page.getByTestId('message-user')).toHaveCount(1);
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'completed');
  await page.reload(); await expect(page.getByTestId('message-user')).toHaveText('开始我的一天');
  await page.getByRole('button', { name: '对话菜单：开始我的一天' }).click(); await page.getByRole('menuitem', { name: '重命名' }).click();
  await page.getByRole('textbox', { name: '对话标题' }).fill('晨间计划'); await page.getByRole('button', { name: '保存标题' }).click();
  await expect(page.getByRole('heading', { name: '晨间计划' })).toBeVisible();
  await page.getByRole('button', { name: '对话菜单：晨间计划' }).click(); await page.getByRole('menuitem', { name: '删除' }).click();
  await page.getByRole('button', { name: '确认删除' }).click(); await expect(page).toHaveURL('/'); await expect(page.getByText('还没有对话')).toBeVisible(); expect(errors).toEqual([]); expect(external).toEqual([]);
});

test('stop prevents storage growth and refresh does not restart', async ({ page }) => {
  await page.goto('/?mockScenario=slow'); await send(page, '慢慢回答');
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'streaming');
  await page.getByRole('button', { name: '停止生成' }).click();
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'stopped');
  const data = await page.evaluate(() => localStorage.getItem('closewebui:data:v1'));
  await page.waitForTimeout(1200); expect(await page.evaluate(() => localStorage.getItem('closewebui:data:v1'))).toBe(data);
  await page.reload(); await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'stopped'); await expect(page.getByTestId('message-user')).toHaveCount(1);
});

test('failure retries without duplicate messages', async ({ page }) => {
  await page.goto('/?mockScenario=failure'); await send(page, '测试失败恢复');
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'failed');
  await page.getByRole('button', { name: '重试回答' }).click(); await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'completed');
  await expect(page.getByTestId('message-user')).toHaveCount(1); await expect(page.getByTestId('message-assistant')).toHaveCount(1);
});

test('corrupted data is protected until confirmed reset', async ({ page }) => {
  await page.goto('/'); await page.evaluate(() => localStorage.setItem('closewebui:data:v1', '{broken')); await page.reload();
  await expect(page.getByRole('heading', { name: '无法恢复本地对话' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('closewebui:data:v1'))).toBe('{broken');
  await page.getByRole('button', { name: '重置本地数据' }).click(); await page.getByRole('button', { name: '确认重置' }).click();
  await expect(page.locator('.welcome h2')).toBeVisible();
});

test('typing preserves an empty history and keyboard focus returns from drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await page.getByRole('textbox', { name: '输入消息' }).fill('帮我把一个想法整理成清晰的文字');
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('帮我把一个想法整理成清晰的文字');
  await expect(page).toHaveURL('/'); expect(await page.evaluate(() => localStorage.getItem('closewebui:data:v1'))).toBeNull();
  await page.getByRole('button', { name: '打开侧栏' }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: '对话导航' })).toBeVisible(); await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: '打开侧栏' })).toBeFocused();
});

test('navigation cancels output and deleted URLs show not-found', async ({ page }) => {
  await page.goto('/?mockScenario=slow'); await send(page, '导航取消');
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'streaming'); const address = page.url();
  await page.getByRole('button', { name: '新对话', exact: true }).click(); await expect(page).toHaveURL('/');
  await page.getByRole('button', { name: '导航取消', exact: true }).click();
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'stopped');
  await page.getByRole('button', { name: '对话菜单：导航取消' }).click(); await page.getByRole('menuitem', { name: '删除' }).click(); await page.getByRole('button', { name: '确认删除' }).click();
  await page.goto(address); await expect(page.getByRole('heading', { name: '对话不存在' })).toBeVisible();
});

test('scroll stays put when reading earlier output, then resumes following', async ({ page }) => {
  await page.goto('/?mockScenario=slow'); await send(page, '滚动行为');
  const scroller = page.locator('.conversation-scroll');
  await expect.poll(() => scroller.evaluate(el => el.scrollHeight - el.clientHeight), { timeout: 35000 }).toBeGreaterThan(200);
  await scroller.hover(); await page.mouse.wheel(0, -600); await expect(page.getByRole('button', { name: '回到底部' })).toBeVisible();
  const top = await scroller.evaluate(el => el.scrollTop); await page.waitForTimeout(900);
  expect(Math.abs(await scroller.evaluate(el => el.scrollTop) - top)).toBeLessThan(3);
  await page.getByRole('button', { name: '回到底部' }).click(); await expect(page.getByRole('button', { name: '回到底部' })).not.toBeVisible();
  await expect.poll(() => scroller.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(80);
  await page.getByRole('button', { name: '停止生成' }).click();
});

test('rename validates input and restores focus after cancel', async ({ page }) => {
  await page.goto('/'); await send(page, '标题校验'); await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'completed');
  const trigger = page.getByRole('button', { name: '对话菜单：标题校验' }); await trigger.click(); await page.getByRole('menuitem', { name: '重命名' }).click();
  await page.getByRole('textbox', { name: '对话标题' }).fill(' '); await page.getByRole('button', { name: '保存标题' }).click(); await expect(page.getByRole('alert')).toHaveText('标题需为 1–80 个字符。');
  await page.getByRole('textbox', { name: '对话标题' }).fill('😀'.repeat(81)); await page.getByRole('button', { name: '保存标题' }).click(); await expect(page.getByRole('alert')).toHaveText('标题需为 1–80 个字符。');
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused(); await expect(page.getByRole('heading', { name: '标题校验' })).toBeVisible();
});

test('renaming during streaming survives subsequent deltas', async ({ page }) => {
  await page.goto('/?mockScenario=slow'); await send(page, '生成中重命名');
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'streaming');
  await page.getByRole('button', { name: '对话菜单：生成中重命名' }).click(); await page.getByRole('menuitem', { name: '重命名' }).click();
  await page.getByRole('textbox', { name: '对话标题' }).fill('新的标题'); await page.getByRole('button', { name: '保存标题' }).click();
  await page.waitForTimeout(1200); await expect(page.getByRole('heading', { name: '新的标题' })).toBeVisible();
  await page.getByRole('button', { name: '停止生成' }).click(); await page.reload(); await expect(page.getByRole('heading', { name: '新的标题' })).toBeVisible();
});

test('mobile rename returns keyboard focus to the visible history menu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await send(page, '移动焦点'); await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'completed');
  await page.getByRole('button', { name: '打开侧栏' }).click();
  const drawer = page.getByRole('dialog', { name: '对话导航' });
  const trigger = drawer.getByRole('button', { name: '对话菜单：移动焦点' });
  await trigger.focus(); await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: '重命名' }).click();
  await expect(page.getByRole('textbox', { name: '对话标题' })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: '打开侧栏' })).toBeFocused();
});

test('deleting a streaming conversation cannot recreate its saved record', async ({ page }) => {
  await page.goto('/?mockScenario=slow'); await send(page, '删除生成中对话');
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'streaming');
  await page.getByRole('button', { name: '对话菜单：删除生成中对话' }).click();
  await page.getByRole('menuitem', { name: '删除' }).click(); await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page).toHaveURL('/'); await expect(page.getByText('还没有对话')).toBeVisible();
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('closewebui:data:v1')!).conversations)).toEqual([]);
});

test('deleting another conversation keeps the current page and history order', async ({ page }) => {
  await page.goto('/'); await send(page, '第一段对话'); await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'completed');
  const first = page.url();
  await page.getByRole('button', { name: '新对话', exact: true }).click(); await send(page, '第二段对话');
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'completed'); const second = page.url();
  const history = page.getByRole('navigation', { name: '历史对话' }).locator('.history-link');
  await expect(history).toHaveText(['第二段对话', '第一段对话']);
  await page.getByRole('button', { name: '第一段对话', exact: true }).click(); await expect(page).toHaveURL(first);
  await expect(history).toHaveText(['第二段对话', '第一段对话']);
  await send(page, '更新第一段对话'); await expect(page.getByTestId('message-assistant').last()).toHaveAttribute('data-status', 'completed');
  await expect(history).toHaveText(['第一段对话', '第二段对话']);
  await page.getByRole('button', { name: '对话菜单：第二段对话' }).click(); await page.getByRole('menuitem', { name: '删除' }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click(); await expect(history).toHaveCount(2);
  await page.getByRole('button', { name: '对话菜单：第二段对话' }).click(); await page.getByRole('menuitem', { name: '删除' }).click();
  await page.getByRole('button', { name: '确认删除' }).click(); await expect(page).toHaveURL(first);
  await expect(history).toHaveText(['第一段对话']); await page.goto(second);
  await expect(page.getByRole('heading', { name: '对话不存在' })).toBeVisible();
});

test('refresh during output restores partial content without restarting or restoring a draft', async ({ page }) => {
  let generations = 0;
  page.on('request', request => { if (request.url().endsWith('/generations')) generations++; });
  await page.goto('/?mockScenario=slow'); await send(page, '刷新中断回答');
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'streaming');
  await page.getByRole('textbox', { name: '输入消息' }).fill('不应保存的草稿');
  await page.reload(); await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'stopped');
  await expect(page.getByTestId('message-assistant')).toContainText('让一天');
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('');
  await page.waitForTimeout(1700); expect(generations).toBe(1);
});

test('an older failed answer has no retry after a new message is sent', async ({ page }) => {
  await page.goto('/?mockScenario=failure'); await send(page, '第一次失败');
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'failed');
  await expect(page.getByTestId('message-assistant')).toContainText('让一天');
  await send(page, '新的上下文'); await expect(page.getByTestId('message-assistant')).toHaveCount(2);
  await expect(page.getByTestId('message-assistant').last()).toHaveAttribute('data-status', 'failed');
  await expect(page.getByTestId('message-assistant').first().getByRole('button', { name: '重试回答' })).toHaveCount(0);
  await expect(page.getByTestId('message-assistant').last().getByRole('button', { name: '重试回答' })).toBeVisible();
  await expect(page.getByTestId('message-user')).toHaveCount(2);
});

test('storage quota failures remain visible while chatting in memory', async ({ page }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'closewebui:data:v1') throw new DOMException('quota', 'QuotaExceededError');
      setItem.call(this, key, value);
    };
  });
  await page.goto('/'); await send(page, '内存会话');
  await expect(page.getByRole('alert')).toContainText('无法保存到本地存储');
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'completed');
  expect(await page.evaluate(() => localStorage.getItem('closewebui:data:v1'))).toBeNull();
  await page.reload(); await expect(page.getByRole('heading', { name: '对话不存在' })).toBeVisible();
});

for (const width of [1878, 1440, 1024, 390]) {
  test(`layout and screenshots at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1878 ? 983 : 900 }); await page.goto('/');
    await expect(page.locator('.welcome h2')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/screenshots/home-${width}.png`, fullPage: true });
    if (width === 390) { await page.getByRole('button', { name: '打开侧栏' }).click(); await expect(page.getByRole('dialog', { name: '对话导航' })).toBeVisible(); await page.keyboard.press('Escape'); }
    await send(page); await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'completed');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 390) {
      for (const selector of ['.code-block pre', '.table-scroll']) {
        const container = page.locator(selector);
        expect(await container.evaluate(el => el.scrollWidth > el.clientWidth && getComputedStyle(el).overflowX === 'auto')).toBe(true);
      }
    }
    await page.screenshot({ path: `test-results/screenshots/chat-${width}.png`, fullPage: true });
  });
}
