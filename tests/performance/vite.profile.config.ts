import { defineConfig } from 'vite';
import ts from 'typescript';
import base from '../../vite.config';

// Test-only production profiling bundle. No instrumentation enters src/ or
// normal Vite builds; the same transform is applied to the exported baseline.
export default defineConfig({
  ...base,
  root: process.env.PROFILE_ROOT || process.cwd(),
  resolve: { ...base.resolve, alias: { 'react-dom/client': 'react-dom/profiling' } },
  plugins: [...(base.plugins || []), {
    name: 'closewebui-test-render-profile', enforce: 'pre',
    transform(source, id) {
      const file = id.replaceAll('\\', '/').split('?')[0];
      if (!file.endsWith('/src/App.tsx') && !file.endsWith('/src/components/Messages.tsx')) return;
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const replacements: { start: number; end: number; text: string }[] = [];
      let wrappers = false;
      const visit = (node: ts.Node) => {
        if (file.endsWith('/src/App.tsx') && ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'MessageView') {
          const attribute = node.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(ast) === 'message');
          if (attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression) {
            const message = attribute.initializer.expression.getText(ast);
            wrappers = true;
            replacements.push({ start: node.getStart(ast), end: node.end, text: `<TestRenderProfiler id={${message}.id} onRender={(id, phase, actualDuration) => { const stats = (window as any).__profileStats; if (stats) stats.records.push({ id, phase, actualDuration, status: ${message}.status, role: ${message}.role }); }}>${node.getText(ast)}</TestRenderProfiler>` });
          }
        }
        if (file.endsWith('/src/components/Messages.tsx') && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name?.text === 'MessageView' && node.body) {
          replacements.push({ start: node.body.getStart(ast) + 1, end: node.body.getStart(ast) + 1, text: `const testStats = (window as any).__profileStats; if (testStats) testStats.executions[message.id] = (testStats.executions[message.id] || 0) + 1;` });
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
      let result = source;
      for (const change of replacements.sort((a, b) => b.start - a.start)) result = result.slice(0, change.start) + change.text + result.slice(change.end);
      if (wrappers) result = `import { Profiler as TestRenderProfiler } from 'react';\n${result}`;
      return { code: result, map: null };
    },
  }],
});
