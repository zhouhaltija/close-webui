import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const password = 'Test-password-123';
const identity = () => `test_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
const SAMPLES = 30;

async function register(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '登录 CloseWebUI' })).toBeVisible();
  await page.getByRole('button', { name: '没有账号？注册' }).click();
  await page.getByLabel('用户名', { exact: true }).fill(identity());
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '注册并登录' }).click();
  await expect(page.locator('.welcome h2')).toBeVisible();
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
  await detail.getByLabel('名称', { exact: true }).fill('性能供应商');
  await detail.getByLabel('接口地址', { exact: true }).fill(upstream.url);
  await detail.getByLabel('API 密钥', { exact: true }).fill('synthetic-key');
  await detail.getByRole('button', { name: '保存供应商' }).click();
  // Saving a provider for the first time pulls its models once.
  await expect(page.getByText('上游返回', { exact: true })).toBeVisible({ timeout: 20000 });
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

/** Collects one measured send against the fixed 50ms `[perf]` fixture. */
async function sample(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __m: { t0: number; preview: number; first: number; done: number; intervals: number[]; long: number[]; old: number; welcome: number } };
    w.__m = { t0: 0, preview: 0, first: 0, done: 0, intervals: [], long: [], old: 0, welcome: 0 };
    const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) w.__m.long.push(Math.round(entry.duration * 100) / 100); });
    observer.observe({ entryTypes: ['longtask'] });
    let last = 0;
    new MutationObserver(records => {
      if (!w.__m.preview && document.querySelector('[data-testid="message-user"]')) w.__m.preview = performance.now();
      if (!w.__m.welcome && document.querySelector('.welcome') && document.querySelector('[data-testid="message-user"]')) w.__m.welcome = performance.now();
      for (const record of records) {
        const article = (record.target as Element).closest?.('.assistant-message') as Element | null;
        if (!article) continue;
        const articles = Array.from(document.querySelectorAll('.assistant-message'));
        if (article !== articles.at(-1)) { w.__m.old++; continue; }
        // Only the streaming window is the render cadence; the terminal status change,
        // the copy button and the footnote are not incremental renders.
        const status = article.getAttribute('data-status');
        if (status !== 'pending' && status !== 'streaming') { last = 0; continue; }
        const now = performance.now();
        if (last) w.__m.intervals.push(Math.round((now - last) * 100) / 100);
        last = now;
        if (!w.__m.first) w.__m.first = now;
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-status'] });
  });
  await page.evaluate(() => { (window as unknown as { __m: { t0: number } }).__m.t0 = performance.now(); document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click(); });
  await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'completed', { timeout: 60000 });
  return page.evaluate(() => {
    const m = (window as unknown as { __m: { t0: number; preview: number; first: number; done: number; intervals: number[]; long: number[]; old: number; welcome: number } }).__m;
    return { clickToPreview: m.preview ? m.preview - m.t0 : -1, clickToFirstDelta: m.first ? m.first - m.t0 : -1, intervals: m.intervals, longTasks: m.long, oldMessageMutations: m.old, welcomeOverlap: m.welcome ? m.welcome - m.t0 : -1 };
  });
}

const percentile = (values: number[], p: number) => {
  if (!values.length) return -1;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round((sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] * 100) / 100);
};

test('fixed 50ms simulation delivers measurable responsiveness across 30 samples', async ({ page }) => {
  test.setTimeout(600_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await register(page); await configure(page);
  await mkdir('test-results', { recursive: true });
  const samples: unknown[] = [];
  for (let i = 0; i < SAMPLES + 1; i++) {
    await page.getByRole('button', { name: '新对话', exact: true }).click();
    await expect(page.locator('.welcome h2')).toBeVisible();
    await page.getByRole('textbox', { name: '输入消息', exact: true }).fill(`[perf] ${randomUUID()}`);
    const result = await sample(page);
    samples.push({ index: i, warmup: i === 0, ...result });
    await expect(page.getByTestId('message-assistant')).toContainText('性能采样');
  }
  const measured = samples.slice(1) as { clickToPreview: number; clickToFirstDelta: number; intervals: number[]; longTasks: number[]; oldMessageMutations: number; welcomeOverlap: number }[];
  const report = {
    scenario: '[perf] 50ms fixed cadence, 20k characters, code fence and table',
    samples: SAMPLES,
    warmupSamples: 1,
    clickToPreview: { p50: percentile(measured.map(s => s.clickToPreview), 50), p95: percentile(measured.map(s => s.clickToPreview), 95), max: Math.max(...measured.map(s => s.clickToPreview)) },
    clickToFirstDelta: { p50: percentile(measured.map(s => s.clickToFirstDelta), 50), p95: percentile(measured.map(s => s.clickToFirstDelta), 95), max: Math.max(...measured.map(s => s.clickToFirstDelta)) },
    deltaInterval: { p50: percentile(measured.flatMap(s => s.intervals), 50), p95: percentile(measured.flatMap(s => s.intervals), 95), max: Math.max(...measured.flatMap(s => s.intervals)) },
    longTaskCount: measured.reduce((sum, s) => sum + s.longTasks.length, 0),
    longTaskMaxMs: Math.max(0, ...measured.flatMap(s => s.longTasks)),
    oldMessageMutationsTotal: measured.reduce((sum, s) => sum + s.oldMessageMutations, 0),
    welcomeOverlapSamples: measured.filter(s => s.welcomeOverlap >= 0).length,
    raw: samples,
  };
  await writeFile('test-results/performance-browser.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(`PERF clickToPreview p50=${report.clickToPreview.p50} p95=${report.clickToPreview.p95} | clickToFirstDelta p50=${report.clickToFirstDelta.p50} p95=${report.clickToFirstDelta.p95} | deltaInterval p50=${report.deltaInterval.p50} p95=${report.deltaInterval.p95} | longTasks=${report.longTaskCount} max=${report.longTaskMaxMs} | oldMutations=${report.oldMessageMutationsTotal} | welcomeOverlap=${report.welcomeOverlapSamples}`);
  expect(report.clickToPreview.p95).toBeLessThanOrEqual(100);
  expect(report.welcomeOverlapSamples).toBe(0);
  expect(report.oldMessageMutationsTotal).toBe(0);
  expect(errors).toEqual([]);
});
