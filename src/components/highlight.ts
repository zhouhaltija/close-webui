import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
let highlighter: ReturnType<typeof createHighlighterCore> | undefined;
function getHighlighter() {
  if (!highlighter) {
    const pending = createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      themes: [import('shiki/themes/github-light.mjs')],
      langs: [import('shiki/langs/typescript.mjs'), import('shiki/langs/javascript.mjs'), import('shiki/langs/json.mjs'), import('shiki/langs/html.mjs'), import('shiki/langs/css.mjs'), import('shiki/langs/bash.mjs'), import('shiki/langs/markdown.mjs'), import('shiki/langs/go.mjs'), import('shiki/langs/python.mjs'), import('shiki/langs/yaml.mjs')],
    });
    highlighter = pending;
    void pending.catch(() => { if (highlighter === pending) highlighter = undefined; });
  }
  return highlighter;
}

type CachedHighlight = { result: Promise<string>; bytes: number };
const cache = new Map<string, CachedHighlight>();
const maxEntries = 64;
const maxBytes = 4 * 1024 * 1024;
let retainedBytes = 0;
function remove(key: string) {
  const entry = cache.get(key);
  if (entry) { retainedBytes -= entry.bytes; cache.delete(key); }
}
function trim() {
  while (cache.size > maxEntries || retainedBytes > maxBytes) remove(cache.keys().next().value!);
}

export function highlight(code: string, language: string): Promise<string> {
  const key = JSON.stringify([language, code]);
  const cached = cache.get(key);
  if (cached) { cache.delete(key); cache.set(key, cached); return cached.result; }
  // Account for retained UTF-16 source keys and HTML, including pending work.
  const entry: CachedHighlight = { bytes: key.length * 2, result: getHighlighter().then(instance => instance.codeToHtml(code, { lang: language, theme: 'github-light' })) };
  cache.set(key, entry); retainedBytes += entry.bytes; trim();
  void entry.result.then(html => {
    if (cache.get(key) !== entry) return;
    entry.bytes += html.length * 2; retainedBytes += html.length * 2; trim();
  }, () => { if (cache.get(key) === entry) remove(key); });
  return entry.result;
}
