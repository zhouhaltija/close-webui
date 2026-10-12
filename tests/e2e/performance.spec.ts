import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const password = 'Test-password-123';
const identity = () => `test_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
const SAMPLES = 30;
const profileImplementation = process.env.PROFILE_IMPLEMENTATION;

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
  if (profileImplementation) {
    // Keep backend/configuration identical when comparing current and exported
    // original frontends, whose settings workflows intentionally differ.
    const providerResponse = await page.request.post('/api/providers', { data: { name: '性能供应商', templateId: 'custom', protocol: 'openai-chat', adapter: 'standard', baseUrl: upstream.url, apiKey: 'synthetic-key', enabled: true } });
    expect(providerResponse.status()).toBe(201);
    const provider = await providerResponse.json() as { id: string };
    const modelResponse = await page.request.post('/api/models', { data: { providerId: provider.id, modelId: 'gpt-5.1', name: '性能模型', maxOutputTokens: 4096, defaultReasoning: {} } });
    expect(modelResponse.status()).toBe(201);
    const model = await modelResponse.json() as { id: string };
    expect((await page.request.patch('/api/preferences', { data: { defaultModelId: model.id } })).ok()).toBe(true);
    await page.goto('/');
    await expect(page.getByRole('button', { name: /选择真实模型/ })).toBeVisible();
    return;
  }
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

type FragmentTiming = { marker: string; received: number; dom: number; frame: number };
type BrowserTiming = {
  t0: number; preview: number; first: number; submitStart: number; headers: number;
  fragments: FragmentTiming[]; longTasks: number[]; oldMutations: number;
  uiUpdates: number; welcomeOverlap: boolean; hidden: boolean; oldProfileIds: string[]; cleanup: () => void;
};
type ProfileStats = { executions: Record<string, number>; records: { id: string; phase: string; actualDuration: number; status: string; role: string }[] };
declare global { interface Window { __performanceSample?: BrowserTiming; __profileStats?: ProfileStats } }

/** Network receipt -> committed and laid-out text -> next paint opportunity.
 * These are latency bounds, not CPU-only React render durations.
 * The TransformStream adds test instrumentation before forwarding each byte.
 */
async function sample(page: Page) {
  const oldAssistantCount = await page.getByTestId('message-assistant').count();
  await page.evaluate(() => {
    const oldProfileIds = Object.keys(window.__profileStats?.executions ?? {});
    if (window.__profileStats) { window.__profileStats.executions = {}; window.__profileStats.records = []; }
    const m: BrowserTiming = { t0: 0, preview: 0, first: 0, submitStart: 0, headers: 0, fragments: [], longTasks: [], oldMutations: 0, uiUpdates: 0, welcomeOverlap: false, hidden: document.hidden, oldProfileIds, cleanup: () => {} };
    window.__performanceSample = m;
    const oldArticles = new Set(document.querySelectorAll('.assistant-message'));
    const oldUserCount = document.querySelectorAll('[data-testid="message-user"]').length;
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const input = args[0];
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const generation = /\/generations$/.test(url);
      if (generation) m.submitStart = performance.now();
      const response = await originalFetch(...args);
      if (!generation || !response.body || !response.ok) return response;
      m.headers = performance.now();
      const decoder = new TextDecoder(); let pending = '';
      const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          pending += decoder.decode(chunk, { stream: true });
          let newline: number;
          while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            try {
              const event = JSON.parse(line) as { type: string; content?: string };
              if (event.type === 'delta') {
                const at = performance.now();
                for (const marker of event.content?.match(/【P[0-9]{3}】/g) ?? []) m.fragments.push({ marker, received: at, dom: 0, frame: 0 });
              }
            } catch { /* Blank/heartbeat line is not a body delta. */ }
          }
          controller.enqueue(chunk);
        },
      }));
      return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    const frames = new Set<number>();
    const mark = () => {
      const current = Array.from(document.querySelectorAll('.assistant-message')).reverse().find(article => !oldArticles.has(article));
      const markdown = current?.querySelector<HTMLElement>('.markdown');
      if (!markdown || !markdown.getClientRects().length || getComputedStyle(markdown).visibility === 'hidden') return;
      const text = markdown.textContent ?? '';
      const newlyCommitted = m.fragments.filter(f => !f.dom && text.includes(f.marker));
      if (!newlyCommitted.length) return;
      const now = performance.now();
      m.uiUpdates++;
      if (!m.first) m.first = now;
      for (const fragment of newlyCommitted) fragment.dom = now;
      const frame = requestAnimationFrame(at => {
        frames.delete(frame);
        for (const fragment of newlyCommitted) fragment.frame = at;
      });
      frames.add(frame);
    };
    const mutation = new MutationObserver(records => {
      const now = performance.now();
      if (document.querySelectorAll('[data-testid="message-user"]').length > oldUserCount) {
        if (!m.preview) m.preview = now;
        if (document.querySelector('.welcome')) m.welcomeOverlap = true;
      }
      for (const record of records) {
        const element = record.target instanceof Element ? record.target : record.target.parentElement;
        const article = element?.closest('.assistant-message');
        if (article && oldArticles.has(article) && element?.closest('.markdown')) m.oldMutations++;
      }
      mark();
    });
    mutation.observe(document.body, { subtree: true, childList: true, characterData: true });
    const long = new PerformanceObserver(list => { for (const entry of list.getEntries()) m.longTasks.push(entry.duration); });
    long.observe({ entryTypes: ['longtask'] });
    const visibility = () => { if (document.hidden) m.hidden = true; };
    document.addEventListener('visibilitychange', visibility);
    m.cleanup = () => {
      for (const entry of long.takeRecords()) m.longTasks.push(entry.duration);
      mutation.disconnect(); long.disconnect(); window.fetch = originalFetch;
      document.removeEventListener('visibilitychange', visibility);
      for (const frame of frames) cancelAnimationFrame(frame);
    };
    m.t0 = performance.now();
    document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click();
  });
  try {
    await expect(page.getByTestId('message-assistant')).toHaveCount(oldAssistantCount + 1);
    await expect(page.getByTestId('message-assistant').last()).toHaveAttribute('data-status', 'completed', { timeout: 60000 });
    await page.waitForFunction(() => window.__performanceSample?.fragments.length === 42 && window.__performanceSample.fragments.every(f => f.dom > 0 && f.frame > 0));
    return await page.evaluate(() => {
      const m = window.__performanceSample!;
      m.cleanup();
      return {
        clickToPreview: m.preview ? m.preview - m.t0 : -1,
        clickToFirstDelta: m.first ? m.first - m.t0 : -1,
        clickToSubmitRequest: m.submitStart - m.t0, submitToResponseHeaders: m.headers - m.submitStart,
        fragments: m.fragments.map(f => ({ marker: f.marker, receivedMs: f.received - m.t0, domMs: f.dom - m.t0, frameMs: f.frame - m.t0, domEpochMs: performance.timeOrigin + f.dom, receiptToDomMs: f.dom - f.received, receiptToFrameMs: f.frame - f.received })),
        longTasks: m.longTasks, oldMessageMutations: m.oldMutations, uiUpdates: m.uiUpdates,
        welcomeOverlap: m.welcomeOverlap, hidden: m.hidden,
        renderActualMs: window.__profileStats?.records.filter(record => record.role === 'assistant' && record.status === 'streaming' && !m.oldProfileIds.includes(record.id)).map(record => record.actualDuration) ?? [],
        oldMessageExecutions: m.oldProfileIds.reduce((sum, id) => sum + (window.__profileStats?.executions[id] ?? 0), 0),
      };
    });
  } finally { await page.evaluate(() => window.__performanceSample?.cleanup()); }
}

const percentile = (values: number[], p: number) => {
  if (!values.length) return -1;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(p / 100 * sorted.length) - 1] * 100) / 100;
};
const summary = (values: number[]) => ({ p50: percentile(values, 50), p95: percentile(values, 95), max: Math.max(...values) });

test('fixed 50ms simulation measures receipt-to-DOM latency across 30 foreground sends', async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  if (profileImplementation) await page.addInitScript(() => { window.__profileStats = { executions: {}, records: [] }; });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await register(page); await configure(page);
  await mkdir('test-results', { recursive: true });
  const samples: (Awaited<ReturnType<typeof sample>> & { index: number; warmup: boolean; firstTextDelayMs: number; upstreamToDomMs: number[] })[] = [];
  for (let i = 0; i < SAMPLES + 1; i++) {
    await page.getByRole('button', { name: '新对话', exact: true }).click();
    await expect(page.locator('.welcome h2')).toBeVisible();
    // Each measured send has a completed old message. Settle its highlighter
    // first so old-body mutation counts measure the next streaming window.
    await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('虚构历史预热');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByTestId('message-assistant').last()).toHaveAttribute('data-status', 'completed', { timeout: 60000 });
    await expect(page.getByTestId('message-assistant').last().locator('.highlighted')).toBeVisible();
    const delay = [0, 500, 2000][Math.max(0, i - 1) % 3];
    const sampleID = randomUUID();
    await page.getByRole('textbox', { name: '输入消息', exact: true }).fill(`[perf] delay=${delay} ${sampleID}`);
    const result = await sample(page);
    const upstreamResponse = await page.request.get(`/__test/performance?sample=${sampleID}`);
    expect(upstreamResponse.ok()).toBe(true);
    const upstreamTiming = await upstreamResponse.json() as { points: { marker: string; sendEpochMs: number }[] };
    expect(upstreamTiming.points).toHaveLength(42);
    const upstreamToDomMs = result.fragments.map(fragment => {
      const point = upstreamTiming.points.find(point => point.marker === fragment.marker);
      expect(point).toBeDefined();
      return fragment.domEpochMs - point!.sendEpochMs;
    });
    samples.push({ index: i, warmup: i === 0, firstTextDelayMs: delay, upstreamToDomMs, ...result });
    await expect(page.getByTestId('message-assistant').last()).toContainText('性能采样');
  }
  const measured = samples.slice(1), foreground = measured.filter(s => !s.hidden);
  const report = {
    scenario: '50ms native fixture, 42 marked chunks >20k characters, code/table; 0/500/2000ms first-text delay (10 sends each); existing completed message per send',
    implementation: profileImplementation ?? 'current-production',
    semantics: 'receiptToDomMs includes parsing, frame queue, React/Markdown work and DOM/layout; frame is a paint opportunity, not physical display. upstreamToDomMs associates local native send and browser DOM via same-host epoch clocks. In separate profiling bundles only, renderActualMs is React.Profiler actualDuration and oldMessageExecutions counts MessageView function calls; profiling overhead is included. The original frontend comparison uses the same current backend; actual original Go is measured separately.',
    samples: SAMPLES, foregroundSamples: foreground.length, warmupSamples: 1,
    clickToPreview: summary(foreground.map(s => s.clickToPreview)),
    clickToFirstDelta: summary(foreground.map(s => s.clickToFirstDelta)),
    receiptToDomMs: summary(foreground.flatMap(s => s.fragments.map(f => f.receiptToDomMs))),
    receiptToFrameMs: summary(foreground.flatMap(s => s.fragments.map(f => f.receiptToFrameMs))),
    upstreamToDomMs: summary(foreground.flatMap(s => s.upstreamToDomMs)),
    renderActualMs: profileImplementation ? summary(foreground.flatMap(s => s.renderActualMs)) : null,
    oldMessageExecutionsTotal: profileImplementation ? foreground.reduce((sum, s) => sum + s.oldMessageExecutions, 0) : null,
    longTaskCount: foreground.reduce((sum, s) => sum + s.longTasks.length, 0),
    longTaskMaxMs: Math.max(0, ...foreground.flatMap(s => s.longTasks)),
    uiUpdates: foreground.reduce((sum, s) => sum + s.uiUpdates, 0),
    oldMessageMutationsTotal: foreground.reduce((sum, s) => sum + s.oldMessageMutations, 0),
    welcomeOverlapSamples: foreground.filter(s => s.welcomeOverlap).length,
    raw: samples,
  };
  const reportPath = testInfo.outputPath('performance-browser.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await testInfo.attach('performance-browser', { path: reportPath, contentType: 'application/json' });
  await writeFile(`test-results/performance-browser${profileImplementation ? `-${profileImplementation}` : ''}.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`PERF preview p95=${report.clickToPreview.p95} | receiptToDom p95=${report.receiptToDomMs.p95} | receiptToFrame p95=${report.receiptToFrameMs.p95} | oldMutations=${report.oldMessageMutationsTotal}`);
  expect(report.foregroundSamples, 'hidden pages cannot certify foreground latency').toBe(SAMPLES);
  expect(measured.every(s => s.clickToPreview >= 0 && s.fragments.length === 42)).toBe(true);
  if (profileImplementation === '29483aa') {
    // Baseline reports its real failures instead of imposing the new goals.
    expect(foreground.flatMap(s => s.renderActualMs).length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    return;
  }
  expect(report.clickToPreview.p95).toBeLessThanOrEqual(100);
  // Conservative latency bound; failure is not a CPU-only render-cost failure.
  expect(report.receiptToDomMs.p95).toBeLessThanOrEqual(32);
  expect(report.welcomeOverlapSamples).toBe(0);
  expect(report.oldMessageMutationsTotal).toBe(0);
  if (profileImplementation) {
    expect(foreground.flatMap(s => s.renderActualMs).length).toBeGreaterThan(0);
    expect(report.renderActualMs!.p95).toBeLessThanOrEqual(32);
    expect(report.oldMessageExecutionsTotal).toBe(0);
  }
  expect(errors).toEqual([]);
});
