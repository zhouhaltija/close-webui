import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
const highlighter = createHighlighterCore({
  engine: createJavaScriptRegexEngine(),
  themes: [import('shiki/themes/github-light.mjs')],
  langs: [import('shiki/langs/typescript.mjs'), import('shiki/langs/javascript.mjs'), import('shiki/langs/json.mjs'), import('shiki/langs/html.mjs'), import('shiki/langs/css.mjs'), import('shiki/langs/bash.mjs'), import('shiki/langs/markdown.mjs'), import('shiki/langs/go.mjs'), import('shiki/langs/python.mjs'), import('shiki/langs/yaml.mjs')],
});
export async function highlight(code: string, language: string) { return (await highlighter).codeToHtml(code, { lang: language, theme: 'github-light' }); }
