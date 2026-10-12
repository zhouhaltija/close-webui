import { beforeEach, expect, it, vi } from 'vitest';

const work = vi.hoisted(() => ({ renders: 0, failInitialization: false }));
// Instrument real Shiki renders; keep grammar loading, highlighting and HTML intact.
vi.mock('shiki/core', async importOriginal => {
  const core = await importOriginal<typeof import('shiki/core')>();
  return {
    ...core,
    createHighlighterCore: async (...args: Parameters<typeof core.createHighlighterCore>) => {
      if (work.failInitialization) { work.failInitialization = false; throw new Error('grammar loading failed'); }
      const instance = await core.createHighlighterCore(...args);
      const render = instance.codeToHtml.bind(instance);
      instance.codeToHtml = (code, options) => { work.renders++; return render(code, options); };
      return instance;
    },
  };
});
beforeEach(() => { work.renders = 0; work.failInitialization = false; vi.resetModules(); });

async function trackedHighlight() {
  const { highlight } = await import('./highlight');
  return { highlight, renders: () => work.renders };
}

it('reuses both pending and completed highlighting work for identical language and code', async () => {
  const { highlight, renders } = await trackedHighlight();
  const first = highlight('const answer = 42;', 'typescript');
  const concurrent = highlight('const answer = 42;', 'typescript');
  const html = await first;
  const rendered = document.createElement('div');
  rendered.innerHTML = html;
  expect(rendered.textContent).toBe('const answer = 42;');
  expect(rendered.querySelector('span[style]')).not.toBeNull();
  expect(await concurrent).toBe(html);
  expect(await highlight('const answer = 42;', 'typescript')).toBe(html);
  expect(renders()).toBe(1);
});

it('keeps different code and language results separate', async () => {
  const { highlight } = await trackedHighlight();
  const code = 'const answer = 42;';
  const typed = highlight(code, 'typescript');
  const plain = highlight(code, 'text');
  const changed = highlight('const answer = 43;', 'typescript');
  const [typedHtml, plainHtml, changedHtml] = await Promise.all([typed, plain, changed]);
  expect(typedHtml).not.toBe(plainHtml);
  expect(changedHtml).toContain('43');
});

it('allows another attempt after highlighting rejects', async () => {
  const { highlight, renders } = await trackedHighlight();
  const failed = highlight('example', 'unknown-language');
  await expect(failed).rejects.toThrow();
  const retried = highlight('example', 'unknown-language');
  await expect(retried).rejects.toThrow();
  expect(renders()).toBe(2);
  expect(await highlight('example', 'text')).toContain('example');
});

it('recovers after the asynchronous highlighter initialization fails', async () => {
  work.failInitialization = true;
  const { highlight } = await import('./highlight');
  await expect(highlight('recovered', 'text')).rejects.toThrow('grammar loading failed');
  expect(await highlight('recovered', 'text')).toContain('recovered');
});

it('evicts older results when many distinct snippets are visited and retains recently used results', async () => {
  const { highlight, renders } = await trackedHighlight();
  await highlight('oldest', 'text');
  await highlight('recent', 'text');
  for (let index = 0; index < 100; index++) {
    await highlight(`snippet-${index}`, 'text');
    await highlight('recent', 'text');
  }
  expect(renders()).toBe(102);
  await highlight('oldest', 'text');
  expect(renders()).toBe(103);
});

it('bounds retained source and rendered output size even with few large snippets', async () => {
  const { highlight, renders } = await trackedHighlight();
  const code = ' '.repeat(700_000);
  const first = highlight(`${code}a`, 'text');
  await first;
  await highlight(`${code}a`, 'text');
  expect(renders()).toBe(1);
  await highlight(`${code}b`, 'text');
  await highlight(`${code}a`, 'text');
  expect(renders()).toBe(3);
});

it('does not retain a single result larger than the cache budget', async () => {
  const { highlight, renders } = await trackedHighlight();
  const code = ' '.repeat(1_100_000);
  await highlight(code, 'text');
  await highlight(code, 'text');
  expect(renders()).toBe(2);
});

it('preserves and safely escapes a twenty-thousand-character code block when reusing its result', async () => {
  const { highlight, renders } = await trackedHighlight();
  const code = 'const answer = "<script>";\n'.repeat(800);
  expect(code.length).toBeGreaterThanOrEqual(20_000);
  const html = await highlight(code, 'typescript');
  const rendered = document.createElement('div'); rendered.innerHTML = html;
  expect(rendered.textContent).toBe(code);
  expect(rendered.querySelector('script')).toBeNull();
  expect(await highlight(code, 'typescript')).toBe(html);
  expect(renders()).toBe(1);
});
