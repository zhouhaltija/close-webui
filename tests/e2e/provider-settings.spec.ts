import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { Model, ModelCapabilities, Provider } from '../../src/core/types';

const baseCapability: ModelCapabilities = { family: '', efforts: [], supportsToggle: false, mandatory: false, budgetMin: 0, budgetMax: 0, budgetSupported: false, outputMax: 4096, known: false, sources: [] };

async function settingsFixture(page: Page) {
  const providers: Provider[] = [
    { id: 'provider-openai', name: 'OpenAI', templateId: 'openai', protocol: 'openai-chat', adapter: 'standard', baseUrl: 'https://api.example.invalid/v1', enabled: true, hasKey: true, updatedAt: '2026-10-12T00:00:00Z' },
    { id: 'provider-claude', name: 'Anthropic', templateId: 'anthropic', protocol: 'anthropic', adapter: 'standard', baseUrl: 'https://claude.example.invalid/v1', enabled: true, hasKey: true, updatedAt: '2026-10-12T00:00:00Z' },
  ];
  let models: Model[] = [
    { id: 'model-openai', providerId: providers[0].id, modelId: 'gpt-5.1', name: 'GPT-5.1', enabled: true, maxOutputTokens: 4096, defaultReasoning: { effort: 'medium' }, capabilities: { ...baseCapability, family: 'openai', known: true, reasoningSupported: true, efforts: ['none', 'low', 'medium', 'high'], supportsToggle: true, outputMax: 128000, outputSource: 'catalog' } },
    { id: 'model-plain', providerId: providers[0].id, modelId: 'plain-text-v1', name: '文本模型', enabled: true, maxOutputTokens: 4096, defaultReasoning: {}, capabilities: { ...baseCapability, reasoningSupported: false, outputMax: 16384, outputSource: 'upstream', contextWindow: 131072 } },
    { id: 'model-claude', providerId: providers[1].id, modelId: 'claude-native-new', name: 'Claude 推理模型', enabled: true, maxOutputTokens: 8192, defaultReasoning: { effort: 'high' }, capabilities: { ...baseCapability, family: 'claude', known: true, reasoningSupported: true, efforts: ['low', 'medium', 'high'], supportsToggle: true, outputMax: 32768, outputSource: 'upstream', contextWindow: 200000, effortWhileDisabled: true } },
  ];
  const patches: Record<string, unknown>[] = [];
  await page.route(/\/(?:api|integration-api)\//, async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/(?:api|integration-api)/, '');
    const method = route.request().method();
    if (path === '/auth/me') return void await route.fulfill({ json: { id: 'interface-user', username: 'interface_demo' } });
    if (path === '/providers') return void await route.fulfill({ json: providers });
    if (path === '/provider-templates') return void await route.fulfill({ json: providers.map(provider => ({ id: provider.templateId, name: provider.name, protocol: provider.protocol, adapter: provider.adapter, baseUrl: provider.baseUrl })) });
    if (path === '/models' && method === 'GET') return void await route.fulfill({ json: models });
    if (path.startsWith('/models/') && method === 'PATCH') {
      const id = path.split('/').at(-1);
      const input = route.request().postDataJSON() as Record<string, unknown>;
      patches.push(input);
      models = models.map(model => model.id === id ? { ...model, ...input } as Model : model);
      return void await route.fulfill({ json: models.find(model => model.id === id) });
    }
    if (path === '/preferences') return void await route.fulfill({ json: { defaultModelId: models[0].id } });
    if (path === '/conversations') return void await route.fulfill({ json: [] });
    return void await route.fulfill({ status: 404, json: { error: { code: 'TEST_ENDPOINT', message: '此测试没有配置该请求。' } } });
  });
  return { patches };
}

for (const width of [1440, 1024, 390]) {
  test(`provider and model settings expose output and reasoning at ${width}px`, async ({ page }) => {
    const { patches } = await settingsFixture(page);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto('/settings/providers');
    const provider = page.locator('.provider-row').filter({ hasText: 'OpenAI' });
    await expect(provider).toBeVisible();
    if (width === 390) await provider.click();
    await expect(page.getByRole('heading', { name: 'OpenAI', exact: true })).toBeVisible();
    const row = page.locator('.model-row').filter({ hasText: 'gpt-5.1' });
    await expect(row).toContainText(/4,096|4096/);
    await expect(row).toContainText(/128,000|128000/);
    await expect(row.getByRole('button', { name: 'GPT-5.1的模型设置', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await mkdir('test-results/screenshots', { recursive: true });
    await page.screenshot({ path: `test-results/screenshots/provider-settings-${width}.png`, fullPage: true });

    await page.goto('/settings/models');
    const globalRow = page.getByRole('article').filter({ hasText: 'gpt-5.1' });
    await expect(globalRow).toContainText(/128,000|128000/);
    await globalRow.getByRole('link', { name: 'GPT-5.1的模型设置', exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/providers\/provider-openai\?model=model-openai$/);
    const editor = page.getByRole('region', { name: 'GPT-5.1的模型设置', exact: true });
    await expect(editor).toBeVisible();
    const output = editor.getByRole('spinbutton', { name: /输出上限|回复上限/ });
    await expect(output).toHaveAttribute('max', '128000');
    await output.fill('8192');
    await editor.getByRole('combobox', { name: '思考档位', exact: true }).selectOption('high');
    await editor.getByRole('button', { name: /保存参数|保存设置/ }).click();
    await expect(editor).toBeHidden();
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ maxOutputTokens: 8192, defaultReasoning: { effort: 'high' } });
    expect(patches[0]).not.toHaveProperty('capabilities');
    await row.getByRole('button', { name: 'GPT-5.1的模型设置', exact: true }).click();
    await expect(output).toHaveValue('8192');
    await expect(editor.getByRole('combobox', { name: '思考档位', exact: true })).toHaveValue('high');
    await page.screenshot({ path: `test-results/screenshots/model-settings-${width}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('an explicit upstream output limit stays visible when reasoning is unsupported', async ({ page }) => {
  await settingsFixture(page);
  await page.goto('/settings/models');
  const row = page.getByRole('article').filter({ hasText: 'plain-text-v1' });
  await expect(row).toContainText(/16,384|16384/);
  await expect(row).toContainText(/4,096|4096/);
  await row.getByRole('link', { name: '文本模型的模型设置', exact: true }).click();
  const editor = page.getByRole('region', { name: '文本模型的模型设置', exact: true });
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('spinbutton', { name: /输出上限|回复上限/ })).toHaveAttribute('max', '16384');
  await expect(editor.getByRole('combobox', { name: '思考档位' })).toHaveCount(0);
  await expect(editor.getByRole('combobox', { name: '思考开关' })).toHaveCount(0);
});
